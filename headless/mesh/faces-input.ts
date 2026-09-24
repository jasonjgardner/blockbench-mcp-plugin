/**
 * Input schemas and resolution for caller-described mesh faces, shared by
 * `add_mesh` and the `add_faces` edit action.
 *
 * Callers may name vertices by key or by index, give UVs per vertex key or as
 * an array aligned with the face's vertex list, and leave UVs out entirely, in
 * which case the face gets Blockbench's Auto UV like a new primitive.
 *
 * @module
 */

import { z } from "zod";
import { vec2Schema } from "../document/schema";
import { autoUvFaces } from "./auto-uv";
import { makeFace } from "./draft";
import type { IMeshGeometry, MeshFaceData, UvSize, Vec2 } from "./types";

/** Texture reference: UUID, name, or index in `textures[]`. */
export const meshTextureRef = z.union([z.string().min(1), z.number().int().min(0)]).describe("Texture UUID, name, or index in textures[].");

/** A face described by a caller. */
export const meshFaceInputSchema = z.object({
  vertices: z
    .array(z.union([z.string().min(1), z.number().int().min(0)]))
    .min(3)
    .max(4)
    .describe("3 or 4 distinct vertices, by key or by index (index into the vertex list/array; for edit_mesh, into the mesh's current vertex keys in saved order). Blockbench meshes do not support n-gons."),
  uv: z
    .union([z.record(z.string(), vec2Schema), z.array(vec2Schema)])
    .optional()
    .describe("Per-vertex [u, v] in project-resolution units: an object by vertex key, or an array aligned with vertices. Omit for Blockbench Auto UV."),
  texture: meshTextureRef.nullable().optional().describe("Texture for this face; null disables it; omitted uses the element-wide texture."),
});

/** A parsed face input. */
export type MeshFaceInput = z.infer<typeof meshFaceInputSchema>;

/** Resolves texture references to saved indices. */
export type TextureResolver = (ref: string | number) => number;

/**
 * Turns face inputs into saved faces. Vertex existence is checked later by
 * `validateFace` when the faces are added.
 *
 * @param keyOrder - Vertex keys that numeric references index into.
 * @param resolveTexture - Maps texture references to indices.
 * @param fallbackTexture - Texture index for faces that do not name one.
 * @returns Saved faces in input order, and which of them need Auto UV (no UVs given).
 * @throws Error for bad indices or UVs that do not match the vertices.
 */
export function resolveFaceInputs(
  inputs: readonly MeshFaceInput[],
  keyOrder: readonly string[],
  resolveTexture: TextureResolver,
  fallbackTexture: number | undefined,
): { faces: MeshFaceData[]; needsUv: boolean[] } {
  const resolved = inputs.map((input, index) => {
    const label = `Face ${index + 1}`;
    const vertices = input.vertices.map((ref) => {
      if (typeof ref === "string") return ref;
      const key = keyOrder[ref];
      if (key === undefined) throw new Error(`${label} uses vertex index ${ref}, but there are only ${keyOrder.length} vertices.`);
      return key;
    });
    const uv = (() => {
      if (input.uv === undefined) return undefined;
      if (Array.isArray(input.uv)) {
        if (input.uv.length !== vertices.length) throw new Error(`${label} has ${input.uv.length} UVs for ${vertices.length} vertices.`);
        const list: Vec2[] = input.uv;
        return Object.fromEntries(vertices.map((key, n) => [key, list[n] as Vec2]));
      }
      const byKey: Record<string, Vec2> = input.uv;
      const missing = vertices.filter((key) => byKey[key] === undefined);
      if (missing.length) throw new Error(`${label} has no UV for vertex ${missing.join(", ")}.`);
      return byKey;
    })();
    const texture = input.texture === null ? null : input.texture === undefined ? fallbackTexture : resolveTexture(input.texture);
    const face = makeFace(vertices, uv ?? {}, texture === undefined ? {} : { texture });
    return { face, needsUv: uv === undefined };
  });
  return { faces: resolved.map((entry) => entry.face), needsUv: resolved.map((entry) => entry.needsUv) };
}

/** Runs Auto UV on the listed faces of a geometry (the step Blockbench runs after creating geometry). */
export const autoUvNewFaces = (geometry: IMeshGeometry, faceKeys: readonly string[], uvSizeOf: (face: MeshFaceData) => UvSize): IMeshGeometry =>
  faceKeys.length ? autoUvFaces(geometry, faceKeys, uvSizeOf) : geometry;
