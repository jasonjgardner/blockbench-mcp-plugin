/**
 * Key generation and a scoped mutable builder for mesh algorithms.
 *
 * Blockbench's mesh edits (extrude, loop cut, merge) are written as in-place
 * edits of a live mesh, and faithful ports read most naturally the same way.
 * {@link MeshDraft} gives those ports a private working copy: it is created
 * from an immutable {@link IMeshGeometry}, edited inside one function, and
 * frozen back into a new geometry. The caller's data is never touched.
 *
 * @module
 */

import type { IMeshGeometry, MeshFaceData, Vec2, Vec3 } from "./types";

const KEY_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALL_DIGITS = /^\d+$/;

/** Blockbench vertex keys are 4 characters (`Mesh.addVertices`), face keys 8 (`Mesh.addFaces`). */
export const VERTEX_KEY_LENGTH = 4;

/** Face key length used by `Mesh.addFaces`. */
export const FACE_KEY_LENGTH = 8;

/** Port of Blockbench `bbuid(length)` (util/math_util.js): random base-62 characters. */
export function bbuid(length: number): string {
  return Array.from({ length }, () => KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)] ?? "a").join("");
}

/**
 * A key not in `taken`. All-digit keys are skipped because JavaScript orders
 * integer-like object keys first, which would reorder faces relative to
 * Blockbench's insertion order.
 */
export function uniqueKey(length: number, taken: ReadonlySet<string>): string {
  const key = bbuid(length);
  return taken.has(key) || ALL_DIGITS.test(key) ? uniqueKey(length, taken) : key;
}

/** Deep-copies a face so a draft can edit it without touching the source. */
export const cloneFace = (face: MeshFaceData): MeshFaceData => ({
  ...face,
  vertices: [...face.vertices],
  uv: Object.fromEntries(Object.entries(face.uv).map(([key, uv]) => [key, [uv[0], uv[1]] as Vec2])),
});

/**
 * Builds a face the way `new MeshFace(mesh, data)` does: keeps only string
 * vertex keys, and gives every vertex a UV (`[0, 0]` unless `uv` has one).
 */
export function makeFace(vertices: readonly string[], uv: Readonly<Record<string, Vec2>> = {}, extra: Partial<MeshFaceData> = {}): MeshFaceData {
  const keys = vertices.filter((key) => typeof key === "string" && key.length > 0);
  const faceUv = Object.fromEntries(keys.map((key) => {
    const value = uv[key];
    return [key, value ? ([value[0], value[1]] as Vec2) : ([0, 0] as Vec2)];
  }));
  return { ...extra, vertices: keys, uv: faceUv };
}

/**
 * Private working copy of a mesh for one algorithm run. Maps keep insertion
 * order, matching how Blockbench iterates `mesh.vertices` / `mesh.faces`.
 */
export class MeshDraft {
  readonly vertices: Map<string, Vec3>;
  readonly faces: Map<string, MeshFaceData>;

  private constructor(vertices: Map<string, Vec3>, faces: Map<string, MeshFaceData>) {
    this.vertices = vertices;
    this.faces = faces;
  }

  /** Starts a draft from a geometry (deep copies every vertex and face). */
  static from(geometry: IMeshGeometry): MeshDraft {
    const vertices = new Map(Object.entries(geometry.vertices).map(([key, v]) => [key, [v[0], v[1], v[2]] as Vec3]));
    const faces = new Map(Object.entries(geometry.faces).map(([key, face]) => [key, cloneFace(face)]));
    return new MeshDraft(vertices, faces);
  }

  /** Port of `Mesh.addVertices`: fresh 4-character keys, missing components become 0. */
  addVertices(...positions: readonly Vec3[]): string[] {
    return positions.map((position) => {
      const key = uniqueKey(VERTEX_KEY_LENGTH, new Set(this.vertices.keys()));
      this.vertices.set(key, [position[0] || 0, position[1] || 0, position[2] || 0]);
      return key;
    });
  }

  /** Port of `Mesh.addFaces`: fresh 8-character keys. */
  addFaces(...faces: readonly MeshFaceData[]): string[] {
    return faces.map((face) => {
      const key = uniqueKey(FACE_KEY_LENGTH, new Set(this.faces.keys()));
      this.faces.set(key, face);
      return key;
    });
  }

  /** Position of a vertex; throws for unknown keys. */
  vertex(key: string): Vec3 {
    const position = this.vertices.get(key);
    if (!position) throw new Error(`Vertex ${key} does not exist in this mesh.`);
    return position;
  }

  /** Freezes the draft into a new geometry. */
  toGeometry(): IMeshGeometry {
    return { vertices: Object.fromEntries(this.vertices), faces: Object.fromEntries(this.faces) };
  }
}
