/**
 * The `edit_mesh` action list: Zod schemas and a dispatcher that applies each
 * action to a geometry in order. Kept apart from the operation module so the
 * mesh library owns the action vocabulary and the operation module stays thin.
 *
 * @module
 */

import { z } from "zod";
import { vec3Schema } from "../document/schema";
import { deleteFaces, deleteVertices, addFaces, flipFaces, moveVertices, setVertices, transformVertices } from "./editing";
import { EXTRUDE_DIRECTIONS, extrudeFaces } from "./extrude";
import { autoUvNewFaces, meshFaceInputSchema, resolveFaceInputs, type TextureResolver } from "./faces-input";
import { LOOP_CUT_SPACINGS, loopCut } from "./loop-cut";
import { DEFAULT_MERGE_DISTANCE, mergeByDistance } from "./merge";
import { MAX_SUBDIVIDE_CUTS, subdivideFaces } from "./subdivide";
import type { IMeshGeometry, MeshFaceData, UvSize } from "./types";

const vertexKeys = z.array(z.string().min(1));
const faceKeys = z.array(z.string().min(1));

/** Every `edit_mesh` action. */
export const meshActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("set_vertices"),
    vertices: z.record(z.string().min(1), vec3Schema).describe("Vertex key → [x, y, z] relative to the mesh origin; existing keys move, new keys are added."),
  }),
  z.object({
    action: z.literal("move_vertices"),
    keys: vertexKeys.optional().describe("Vertices to move; omit for all."),
    offset: vec3Schema,
  }),
  z.object({
    action: z.literal("delete_vertices"),
    keys: vertexKeys.min(1).describe("Quads losing a vertex become triangles; faces left with fewer than 3 vertices are removed."),
  }),
  z.object({
    action: z.literal("transform"),
    keys: vertexKeys.optional().describe("Vertices to transform; omit for all."),
    translate: vec3Schema.optional(),
    rotate: vec3Schema.optional().describe("Degrees, Blockbench Euler order ZYX, about pivot."),
    scale: vec3Schema.optional().describe("Per-axis factors about pivot."),
    pivot: vec3Schema.optional().describe("Local pivot; defaults to [0, 0, 0], the mesh origin."),
  }),
  z.object({
    action: z.literal("add_faces"),
    faces: z.array(meshFaceInputSchema).min(1).describe("Faces over existing vertices; faces without uv get Blockbench Auto UV."),
  }),
  z.object({ action: z.literal("delete_faces"), faces: faceKeys.min(1).describe("Face keys; vertices no remaining face uses are deleted too.") }),
  z.object({ action: z.literal("flip_faces"), faces: faceKeys.optional().describe("Face keys to invert (Blockbench invert_face); omit for all.") }),
  z.object({
    action: z.literal("merge_vertices"),
    distance: z.number().positive().default(DEFAULT_MERGE_DISTANCE).describe("Merge vertices closer than this (Blockbench setting vertex_merge_distance, default 0.1)."),
    keys: vertexKeys.optional().describe("Candidate vertices; omit for all."),
    in_center: z.boolean().default(false).describe("Move each merged vertex to its group's center and average UVs."),
  }),
  z.object({
    action: z.literal("extrude_faces"),
    faces: faceKeys.min(1),
    distance: z.number().describe("Extrusion length in model units (Blockbench extend)."),
    direction: z.enum(EXTRUDE_DIRECTIONS).default("outwards").describe("outwards follows face normals; average uses the mean normal; axis values push along that axis."),
    even_extend: z.boolean().default(false).describe("Keep wall thickness even at corners shared by two faces."),
  }),
  z.object({
    action: z.literal("subdivide"),
    faces: faceKeys.optional().describe("Faces to split; omit for all."),
    cuts: z.number().int().min(1).max(MAX_SUBDIVIDE_CUTS).default(1).describe("Cuts per edge; each face becomes (cuts + 1)² faces."),
  }),
  z.object({
    action: z.literal("loop_cut"),
    face: z.string().min(1).describe("Start face key; the cut runs around the face loop through it."),
    direction: z.number().int().min(0).default(0).describe("Which edge of the start face is crossed (sorted corner direction → direction + 1)."),
    cuts: z.number().int().min(1).max(16).default(1),
    offset: z.number().min(0).optional().describe("Cut position along the start edge in model units; default the middle."),
    spacing: z.enum(LOOP_CUT_SPACINGS).default("proportional"),
  }),
]);

/** One parsed `edit_mesh` action. */
export type MeshAction = z.infer<typeof meshActionSchema>;

/** Context an action needs from the document. */
export interface IMeshActionContext {
  resolveTexture: TextureResolver;
  uvSizeOf: (face: MeshFaceData) => UvSize;
}

type ActionHandler<K extends MeshAction["action"]> = (geometry: IMeshGeometry, action: Extract<MeshAction, { action: K }>, context: IMeshActionContext) => IMeshGeometry;

const ACTION_HANDLERS: { [K in MeshAction["action"]]: ActionHandler<K> } = {
  set_vertices: (geometry, action) => setVertices(geometry, action.vertices),
  move_vertices: (geometry, action) => moveVertices(geometry, action.offset, action.keys),
  delete_vertices: (geometry, action) => deleteVertices(geometry, action.keys),
  transform: (geometry, action) => transformVertices(geometry, action, action.keys),
  add_faces: (geometry, action, context) => {
    const { faces, needsUv } = resolveFaceInputs(action.faces, Object.keys(geometry.vertices), context.resolveTexture, undefined);
    const added = addFaces(geometry, faces);
    return autoUvNewFaces(added.geometry, added.keys.filter((_, index) => needsUv[index]), context.uvSizeOf);
  },
  delete_faces: (geometry, action) => deleteFaces(geometry, action.faces),
  flip_faces: (geometry, action) => flipFaces(geometry, action.faces),
  merge_vertices: (geometry, action) => mergeByDistance(geometry, action.distance, action.keys, action.in_center).geometry,
  extrude_faces: (geometry, action) => extrudeFaces(geometry, action.faces, { distance: action.distance, direction: action.direction, evenExtend: action.even_extend }).geometry,
  subdivide: (geometry, action) => subdivideFaces(geometry, action.cuts, action.faces).geometry,
  loop_cut: (geometry, action) => loopCut(geometry, action.face, { direction: action.direction, cuts: action.cuts, spacing: action.spacing, ...(action.offset === undefined ? {} : { offset: action.offset }) }).geometry,
};

/**
 * Applies actions in order. The first failing action aborts the whole list.
 *
 * @throws Error naming the failing action's position and reason.
 */
export function applyMeshActions(geometry: IMeshGeometry, actions: readonly MeshAction[], context: IMeshActionContext): IMeshGeometry {
  return actions.reduce((current, action, position) => {
    try {
      const handler = ACTION_HANDLERS[action.action] as ActionHandler<typeof action.action>;
      return handler(current, action, context);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Action ${position + 1} (${action.action}) failed: ${reason}`);
    }
  }, geometry);
}
