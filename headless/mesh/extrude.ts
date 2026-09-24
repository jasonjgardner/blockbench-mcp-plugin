/**
 * Port of Blockbench's `extrude_mesh_selection` action (js/modeling/mesh_editing.js)
 * for a face selection, the way the action runs in face selection mode.
 *
 * Every vertex of the selected faces is duplicated and pushed along a
 * direction; the selected faces move onto the duplicates (their UVs
 * re-projected onto the old face plane), and a side quad is built for every
 * perimeter edge not shared with another selected face, UV-mapped by folding
 * the extrusion back into the old face's plane. Original vertices no face uses
 * any more are deleted; any other leftover pair becomes a 2-vertex edge face,
 * exactly as Blockbench does.
 *
 * @module
 */

import { makeFace, MeshDraft } from "./draft";
import { faceNormal, localToUv, sortedVertices, type VertexLookup } from "./face";
import { faceAt, type IMeshGeometry, type MeshFaceData, uvOf, type Vec2, type Vec3 } from "./types";
import { add, angleBetween, cross, dot, interpolateUv, normalize, scale, sub } from "./vector";
import { requireFaces } from "./editing";

/** Extrusion direction choices from the action's amend dialog. */
export const EXTRUDE_DIRECTIONS = ["outwards", "average", "x+", "x-", "y+", "y-", "z+", "z-"] as const;

/** One extrusion direction. */
export type ExtrudeDirection = (typeof EXTRUDE_DIRECTIONS)[number];

const AXIS_DIRECTIONS: Readonly<Record<string, Vec3>> = {
  "x+": [1, 0, 0],
  "x-": [-1, 0, 0],
  "y+": [0, 1, 0],
  "y-": [0, -1, 0],
  "z+": [0, 0, 1],
  "z-": [0, 0, -1],
};

/** Extrusion settings (the amend dialog: `extend`, `direction_mode`, `even_extend`). */
export interface IExtrudeOptions {
  /** Distance to move along the direction (Blockbench `extend`). */
  distance: number;
  direction?: ExtrudeDirection;
  /** Divide by cos(angle between the first two face normals) at shared corners, keeping wall thickness even. */
  evenExtend?: boolean;
}

/** Result keys of an extrusion. */
export interface IExtrudeResult {
  geometry: IMeshGeometry;
  /** Duplicated vertices, in original-vertex order. */
  vertices: string[];
  /** Side quads created (the moved faces keep their keys). */
  sideFaces: string[];
}

interface ISideQuad {
  a: string;
  b: string;
  origA: string;
  origB: string;
  uvA: Vec2;
  uvB: Vec2;
}

/** Per-vertex direction for the default "outwards" mode: summed normals of the selected faces holding it. */
function outwardDirection(lookup: VertexLookup, faces: readonly MeshFaceData[], key: string, evenExtend: boolean): Vec3 {
  const normals = faces.filter((face) => face.vertices.includes(key)).map((face) => faceNormal(lookup, face, true));
  const [first, second] = normals;
  if (!first) return [0, 1, 0];
  const sum = normals.slice(1).reduce<Vec3>((total, normal) => add(total, normal), first);
  if (normals.length < 2 || !second) return sum;
  const unit = normalize(sum);
  return evenExtend ? scale(unit, 1 / Math.cos((angleBetween(first, second) * Math.PI) / 180)) : unit;
}

/** Side quad UVs for one face, precomputed from the unmodified face like Blockbench does. */
function sideQuads(lookup: VertexLookup, face: MeshFaceData, others: readonly MeshFaceData[], newKeyOf: (key: string) => string): ISideQuad[] {
  const sorted = sortedVertices(lookup, face);
  if (sorted.length < 2) return [];
  const [t0, t1, t2] = face.vertices as [string, string, string];
  const [ova, ovb, ovc] = [lookup(t0), lookup(t1), lookup(t2)];
  const [ouva, ouvb, ouvc] = [uvOf(face, t0), uvOf(face, t1), uvOf(face, t2)];
  const planeNormal = normalize(cross(sub(ovb, ova), sub(ovc, ova)));
  const foldedUv = (orig: Vec3, moved: Vec3, inPlane: Vec3): Vec2 => {
    const extension = sub(moved, orig);
    const along = dot(extension, planeNormal);
    const folded = add(add(add(orig, extension), scale(planeNormal, -along)), scale(inPlane, along));
    return interpolateUv(folded, ova, ovb, ovc, ouva, ouvb, ouvc);
  };
  return sorted.flatMap((origA, index): ISideQuad[] => {
    const origB = sorted[index + 1] ?? (sorted[0] as string);
    if (sorted.length === 2 && index > 0) return [];
    if (others.some((other) => other.vertices.includes(origA) && other.vertices.includes(origB))) return [];
    const a = newKeyOf(origA);
    const b = newKeyOf(origB);
    const edgeDirection = normalize(sub(lookup(origB), lookup(origA)));
    const inPlane = cross(edgeDirection, planeNormal);
    return [{ a, b, origA, origB, uvA: foldedUv(lookup(origA), lookup(a), inPlane), uvB: foldedUv(lookup(origB), lookup(b), inPlane) }];
  });
}

/**
 * Extrudes faces.
 *
 * @throws Error for unknown faces, faces with fewer than 3 vertices, or a non-finite distance.
 */
export function extrudeFaces(geometry: IMeshGeometry, faceKeys: readonly string[], options: IExtrudeOptions): IExtrudeResult {
  requireFaces(geometry, faceKeys);
  if (!Number.isFinite(options.distance)) throw new Error("Extrude distance must be a finite number.");
  const keys = [...new Set(faceKeys)];
  const selected = keys.map((key) => faceAt(geometry, key));
  if (selected.some((face) => face.vertices.length < 3)) throw new Error("Only faces with 3 or 4 vertices can be extruded.");
  const draft = MeshDraft.from(geometry);
  const lookup: VertexLookup = (key) => draft.vertex(key);
  const originals = [...new Set(selected.flatMap((face) => face.vertices))];
  const mode = options.direction ?? "outwards";
  const average = selected.reduce<Vec3>((sum, face) => add(sum, faceNormal(lookup, face, true)), [0, 0, 0]).map((value) => value / selected.length) as unknown as Vec3;
  const directionOf = (key: string): Vec3 => {
    if (mode === "average") return average;
    return AXIS_DIRECTIONS[mode] ?? outwardDirection(lookup, selected, key, options.evenExtend === true);
  };
  const created = draft.addVertices(...originals.map((key) => add(draft.vertex(key), scale(directionOf(key), options.distance))));
  const newKeyOf = (key: string): string => created[originals.indexOf(key)] ?? key;

  // Precompute every UV before any face changes, as Blockbench does.
  const capUvs = selected.map((face) => Object.fromEntries(face.vertices.map((key) => [newKeyOf(key), localToUv(lookup, face, draft.vertex(newKeyOf(key)))])));
  const quads = selected.map((face) => sideQuads(lookup, face, selected.filter((other) => other !== face), newKeyOf));

  keys.forEach((key, index) => {
    const face = selected[index] as MeshFaceData;
    draft.faces.set(key, { ...face, vertices: face.vertices.map(newKeyOf), uv: capUvs[index] ?? {} });
  });
  const sideFaces = keys.flatMap((key, index) => {
    const { vertices: _vertices, uv: _uv, ...props } = draft.faces.get(key) as MeshFaceData;
    const oldUv = (vertex: string): Vec2 => uvOf(selected[index] as MeshFaceData, vertex);
    return (quads[index] ?? []).flatMap((q) => draft.addFaces(makeFace([q.b, q.a, q.origA, q.origB], { [q.a]: q.uvA, [q.b]: q.uvB, [q.origA]: oldUv(q.origA), [q.origB]: oldUv(q.origB) }, props)));
  });

  const used = new Set(quads.flat().flatMap((q) => [q.a, q.b]));
  created.filter((key) => !used.has(key)).forEach((a) => {
    const b = originals[created.indexOf(a)] as string;
    const bInFace = [...draft.faces.values()].some((face) => face.vertices.includes(b));
    const aInSelected = keys.some((key) => draft.faces.get(key)?.vertices.includes(a) === true);
    if (aInSelected && !bInFace) {
      draft.vertices.delete(b);
      return;
    }
    draft.addFaces(makeFace([b, a]));
  });
  return { geometry: draft.toGeometry(), vertices: created, sideFaces };
}
