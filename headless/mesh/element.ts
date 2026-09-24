/**
 * Converts between saved mesh elements and the geometry the library edits,
 * and builds new mesh elements in the shape Blockbench saves.
 *
 * `Mesh.getSaveCopy` (js/outliner/types/mesh.js) copies every registered
 * property in registration order (`name`, `color`, `origin`, `rotation`,
 * `shading`, `export`, `visibility`, `locked`, `render_order`, then
 * `allow_mirror_modeling` from js/modeling/mirror_modeling.ts), then
 * `vertices`, `faces`, `type` and `uuid`. Faces save `{uv, texture, vertices}`
 * with the texture as an index into `textures[]` and omitted when unset.
 *
 * @module
 */

import type { IMesh, Vec3 } from "../document/schema";
import type { IMeshGeometry, MeshFaceData } from "./types";

/** Number of marker colors Blockbench picks from (js/marker_colors.ts). */
export const MARKER_COLOR_COUNT = 10;

/** Fields for a new mesh element. */
export interface IMeshElementInit {
  name: string;
  uuid: string;
  origin: Vec3;
  rotation: Vec3;
  geometry: IMeshGeometry;
  /** Marker color index; Blockbench picks one at random when a primitive is added. */
  color?: number;
}

/** Orders a face's fields like `MeshFace.getSaveCopy` and drops an unset texture. */
function saveFace(face: MeshFaceData): MeshFaceData {
  const { uv, texture, vertices, ...rest } = face;
  return { uv, ...(texture === undefined ? {} : { texture }), vertices, ...rest };
}

/** Saved faces in Blockbench's field order. */
const saveFaces = (faces: IMeshGeometry["faces"]): IMesh["faces"] => Object.fromEntries(Object.entries(faces).map(([key, face]) => [key, saveFace(face)]));

/** Builds a mesh element the way Blockbench 5 saves one. */
export function buildMeshElement(init: IMeshElementInit): IMesh {
  return {
    name: init.name,
    color: init.color ?? Math.floor(Math.random() * MARKER_COLOR_COUNT),
    origin: init.origin,
    rotation: init.rotation,
    shading: "flat",
    export: true,
    visibility: true,
    locked: false,
    render_order: "default",
    allow_mirror_modeling: true,
    vertices: { ...init.geometry.vertices },
    faces: saveFaces(init.geometry.faces),
    type: "mesh",
    uuid: init.uuid,
  };
}

/** The editable geometry of a saved mesh. */
export const geometryOf = (mesh: IMesh): IMeshGeometry => ({ vertices: mesh.vertices, faces: mesh.faces });

/** A copy of `mesh` with new geometry; every other field is kept. */
export const withGeometry = (mesh: IMesh, geometry: IMeshGeometry): IMesh => ({ ...mesh, vertices: { ...geometry.vertices }, faces: saveFaces(geometry.faces) });

/**
 * Sets the texture of mesh faces, like `Mesh.applyTexture` but with the saved
 * index form. `null` disables the faces (saved as `texture: null`), matching
 * how the cube `assign_texture` operation treats null.
 *
 * @param textureIndex - Index into `textures[]`, or `null` to disable the faces.
 * @param faceKeys - Faces to change; all faces when omitted.
 * @throws Error when a face key does not exist.
 */
export function assignMeshTexture(mesh: IMesh, textureIndex: number | null, faceKeys?: readonly string[]): IMesh {
  const missing = (faceKeys ?? []).filter((key) => mesh.faces[key] === undefined);
  if (missing.length) throw new Error(`Mesh ${mesh.name} has no face(s) ${missing.join(", ")}.`);
  const targets = new Set(faceKeys ?? Object.keys(mesh.faces));
  const faces = Object.fromEntries(Object.entries(mesh.faces).map(([key, face]) => [key, targets.has(key) ? saveFace({ ...face, texture: textureIndex }) : face]));
  return { ...mesh, faces };
}
