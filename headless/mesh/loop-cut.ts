/**
 * Port of Blockbench's `loop_cut` action (js/modeling/mesh/loop_cut.ts),
 * started from one selected face the way face selection mode starts it.
 *
 * The cut enters the start face across the edge picked by `direction` (edge
 * `direction` and `direction + 1` of the sorted corners), splits it, then walks
 * the face loop in both directions through neighboring quads (and triangles),
 * splitting each one and sharing the new edge vertices. `cuts` inserts several
 * parallel cuts, spaced like Blockbench. UVs of new vertices are interpolated
 * along the cut edges; new faces copy the texture of the face they split.
 *
 * Differences from the app: the start face must have 3 or 4 vertices (the app
 * can also start on a 2-vertex edge face), and the `unit: percent` dialog
 * option is covered by passing `offset` in model units.
 *
 * @module
 */

import { makeFace, MeshDraft } from "./draft";
import { angleToNormal, faceEdges, faceNormal, invertFace, sortedVertices, type VertexLookup } from "./face";
import { clamp, faceAt, type IMeshGeometry, lerp, type MeshFaceData, uvOf, type Vec2 } from "./types";
import { distance, lerp3 } from "./vector";

/** Cut spacing options from the amend dialog. */
export const LOOP_CUT_SPACINGS = ["proportional", "even_start", "even_end"] as const;

/** One spacing option. */
export type LoopCutSpacing = (typeof LOOP_CUT_SPACINGS)[number];

/** Loop cut settings (the amend dialog fields). */
export interface ILoopCutOptions {
  /** Which edge of the start face the cut crosses; values above 2 on triangles cut edge-to-edge. Default 0. */
  direction?: number;
  /** Parallel cuts, 1 to 16. Default 1. */
  cuts?: number;
  /** Distance of the cut from the edge start in model units; default half the start edge. */
  offset?: number;
  spacing?: LoopCutSpacing;
}

/** Loop cut output. */
export interface ILoopCutResult {
  geometry: IMeshGeometry;
  /** Vertices created on cut edges. */
  vertices: string[];
}

type Edge = [string, string];

/** Mutable state of one loop cut run, mirroring the closure variables of `runEdit`. */
interface ICutState {
  draft: MeshDraft;
  lookup: VertexLookup;
  processed: string[];
  centers: Map<string, string>;
  direction: number;
  cuts: number;
  offset: number;
  length: number;
  spacing: LoopCutSpacing;
}

function centerVertex(state: ICutState, edge: Edge, ratio: number): string {
  const edgeKey = [...edge].sort().join(".");
  const existing = state.centers.get(edgeKey);
  if (existing) return existing;
  const [key] = state.draft.addVertices(lerp3(state.lookup(edge[0]), state.lookup(edge[1]), ratio));
  state.centers.set(edgeKey, key as string);
  return key as string;
}

function ratioOf(state: ICutState, edge: Edge, cutNo: number): number {
  const base = (() => {
    if (state.spacing === "proportional") return state.offset / state.length;
    const even = clamp(state.offset / distance(state.lookup(edge[0]), state.lookup(edge[1])), 0, 1);
    return state.spacing === "even_end" ? 1 - even : even;
  })();
  return state.cuts > 1 ? 1 - (1 / (state.cuts + 1 - cutNo)) * base * 2 : base;
}

const uvLerp = (face: MeshFaceData, edge: Edge, ratio: number): Vec2 => {
  const a = uvOf(face, edge[0]);
  const b = uvOf(face, edge[1]);
  return [lerp(a[0], b[0], ratio), lerp(a[1], b[1], ratio)];
};

/** Orients an edge against the face's sorted order, like the `side_index_diff` / `opposite_index_diff` checks. */
function orient(sorted: readonly string[], edge: Edge, reverseWhen: (diff: number) => boolean): Edge {
  const diff = sorted.indexOf(edge[0]) - sorted.indexOf(edge[1]);
  return reverseWhen(diff) ? [edge[1], edge[0]] : edge;
}

/** Faces still eligible for the walk: 3+ vertices, not yet processed, in draft order. */
const candidates = (state: ICutState): [string, MeshFaceData][] =>
  [...state.draft.faces.entries()].filter(([key, face]) => face.vertices.length >= 3 && !state.processed.includes(key));

const sharesTwo = (face: MeshFaceData, edge: readonly string[]): boolean => face.vertices.filter((key) => edge.includes(key)).length >= 2;

/** Continues the loop into the neighbor across `opposite` (the "Find next face" step). */
function walkForward(state: ICutState, opposite: Edge): void {
  const next = candidates(state).find(([, face]) => sharesTwo(face, opposite));
  if (next) splitFace(state, next[0], [...opposite], next[1].vertices.length === 4, 0);
}

function splitQuad(state: ICutState, faceKey: string, face: MeshFaceData, sideIn: Edge, doubleSide: boolean, cutNo: number): void {
  const sorted = sortedVertices(state.lookup, face);
  const side = orient(sorted, sideIn, (diff) => diff === -1 || diff > 2);
  const opposite = orient(sorted, sorted.filter((key) => !side.includes(key)) as Edge, (diff) => diff === 1 || diff < -2);
  const r1 = ratioOf(state, side, cutNo);
  const r2 = ratioOf(state, opposite, cutNo);
  const c = [centerVertex(state, side, r1), centerVertex(state, opposite, r2)] as Edge;
  const uv1 = uvLerp(face, side, r1);
  const uv2 = uvLerp(face, opposite, r2);
  const { vertices: _v, uv: _u, ...props } = face;
  const created = makeFace([side[1], c[0], c[1], opposite[1]], { [side[1]]: uvOf(face, side[1]), [c[0]]: uv1, [c[1]]: uv2, [opposite[1]]: uvOf(face, opposite[1]) }, props);
  state.draft.faces.set(faceKey, makeFace([opposite[0], c[0], c[1], side[0]], { [opposite[0]]: uvOf(face, opposite[0]), [c[0]]: uv1, [c[1]]: uv2, [side[0]]: uvOf(face, side[0]) }, props));
  state.draft.addFaces(created);
  if (cutNo + 1 < state.cuts) splitFace(state, faceKey, [c[0], side[0]], doubleSide, cutNo + 1);
  if (cutNo !== 0) return;
  walkForward(state, opposite);
  if (!doubleSide) return;
  const back = candidates(state).find(([, ref]) => sharesTwo(ref, side));
  if (!back) return;
  const refOpposite = sortedVertices(state.lookup, back[1]).filter((key) => !side.includes(key));
  if (refOpposite.length === 2) splitFace(state, back[0], refOpposite as Edge, back[1].vertices.length === 4, 0);
  if (refOpposite.length === 1) splitFace(state, back[0], [...side], false, 0);
}

function splitTriangleAcross(state: ICutState, faceKey: string, face: MeshFaceData, sorted: string[], side: Edge, doubleSide: boolean, cutNo: number): void {
  const opposed = sorted.find((key) => !side.includes(key)) as string;
  const opposite = orient(sorted, [side[state.direction % side.length] as string, opposed], (diff) => diff === 1 || diff < -2);
  const r1 = ratioOf(state, side, cutNo);
  const r2 = ratioOf(state, opposite, cutNo);
  const c = [centerVertex(state, side, r1), centerVertex(state, opposite, r2)] as Edge;
  const uv1 = uvLerp(face, side, r1);
  const uv2 = uvLerp(face, opposite, r2);
  const otherQuad = side.find((key) => !opposite.includes(key)) as string;
  const otherTri = side.find((key) => opposite.includes(key)) as string;
  const { vertices: _v, uv: _u, ...props } = face;
  const triangle = makeFace([otherTri, c[0], c[1]], { [otherTri]: uvOf(face, otherTri), [c[0]]: uv1, [c[1]]: uv2 }, props);
  const tri = angleToNormal(state.lookup, triangle, faceNormal(state.lookup, face, false)) > 90 ? invertFace(triangle) : triangle;
  const quad = makeFace([opposed, c[0], c[1], otherQuad], { [opposed]: uvOf(face, opposed), [c[0]]: uv1, [c[1]]: uv2, [otherQuad]: uvOf(face, otherQuad) }, props);
  state.draft.faces.set(faceKey, angleToNormal(state.lookup, quad, faceNormal(state.lookup, tri, false)) > 90 ? invertFace(quad) : quad);
  state.draft.addFaces(tri);
  if (cutNo + 1 < state.cuts) splitFace(state, faceKey, [c[0], otherQuad], doubleSide, cutNo + 1);
  if (cutNo !== 0) return;
  walkForward(state, opposite);
  if (!doubleSide) return;
  // Unlike the quad branch, Blockbench keeps searching past neighbors that are triangles here.
  const oppositeOf = (ref: MeshFaceData): string[] => sortedVertices(state.lookup, ref).filter((key) => !side.includes(key));
  const back = candidates(state).find(([, ref]) => sharesTwo(ref, side) && oppositeOf(ref).length === 2);
  if (back) splitFace(state, back[0], oppositeOf(back[1]) as Edge, back[1].vertices.length === 4, 0);
}

function splitTriangle(state: ICutState, faceKey: string, face: MeshFaceData, sorted: string[], side: Edge, doubleSide: boolean, cutNo: number): void {
  if (state.direction > 2) {
    splitTriangleAcross(state, faceKey, face, sorted, side, doubleSide, cutNo);
    return;
  }
  const opposite = sorted.find((key) => !side.includes(key)) as string;
  const ratio = ratioOf(state, side, cutNo);
  const center = centerVertex(state, side, ratio);
  const uv = uvLerp(face, side, ratio);
  const { vertices: _v, uv: _u, ...props } = face;
  const flip = state.direction % 3 === 2 ? invertFace : (f: MeshFaceData): MeshFaceData => f;
  const created = flip(makeFace([side[1], center, opposite], { [side[1]]: uvOf(face, side[1]), [center]: uv, [opposite]: uvOf(face, opposite) }, props));
  state.draft.faces.set(faceKey, flip(makeFace([opposite, center, side[0]], { [opposite]: uvOf(face, opposite), [center]: uv, [side[0]]: uvOf(face, side[0]) }, props)));
  state.draft.addFaces(created);
}

/** Port of the recursive `splitFace(face, side_vertices, double_side, cut_no)`. */
function splitFace(state: ICutState, faceKey: string, sideIn: Edge, doubleSide: boolean, cutNo: number): void {
  const face = state.draft.faces.get(faceKey);
  if (!face) return;
  state.processed.push(faceKey);
  if (face.vertices.length === 4) {
    splitQuad(state, faceKey, face, sideIn, doubleSide, cutNo);
    return;
  }
  if (face.vertices.length !== 3) return;
  const sorted = sortedVertices(state.lookup, face);
  const side = orient(sorted, sideIn, (diff) => diff === -1 || diff > 2);
  splitTriangle(state, faceKey, face, sorted, side, doubleSide, cutNo);
}

/**
 * Runs a loop cut starting at `faceKey`.
 *
 * @throws Error when the face is missing, has fewer than 3 vertices, or the settings are out of range.
 */
export function loopCut(geometry: IMeshGeometry, faceKey: string, options: ILoopCutOptions = {}): ILoopCutResult {
  const start = faceAt(geometry, faceKey);
  if (start.vertices.length < 3) throw new Error(`Face ${faceKey} has ${start.vertices.length} vertices; loop cuts start on a triangle or quad.`);
  const direction = options.direction ?? 0;
  const cuts = options.cuts ?? 1;
  if (!Number.isInteger(direction) || direction < 0) throw new Error("direction must be a non-negative integer.");
  if (!Number.isInteger(cuts) || cuts < 1 || cuts > 16) throw new Error("cuts must be an integer from 1 to 16.");
  const draft = MeshDraft.from(geometry);
  const lookup: VertexLookup = (key) => draft.vertex(key);
  const sorted = sortedVertices(lookup, start);
  const edgeStart = sorted[direction % sorted.length] as string;
  const edgeEnd = sorted[(direction + 1) % sorted.length] as string;
  const length = distance(lookup(edgeStart), lookup(edgeEnd));
  if (length === 0) throw new Error("The start edge has zero length.");
  const offset = clamp(options.offset ?? length / 2, 0, length);
  const state: ICutState = { draft, lookup, processed: [faceKey], centers: new Map(), direction, cuts, offset, length, spacing: options.spacing ?? "proportional" };
  // Face mode selects exactly the start face's vertices, so it is its own start face and no aligned edge exists.
  splitFace(state, faceKey, [edgeStart, edgeEnd], start.vertices.length === 4 || direction > 2, 0);
  return { geometry: draft.toGeometry(), vertices: [...state.centers.values()] };
}

/** Perimeter edges of a face, exposed so callers can describe which edge a `direction` value picks. */
export const startEdges = (geometry: IMeshGeometry, faceKey: string): [string, string][] => faceEdges((key) => {
  const position = geometry.vertices[key];
  if (!position) throw new Error(`Vertex ${key} does not exist in this mesh.`);
  return position;
}, faceAt(geometry, faceKey));
