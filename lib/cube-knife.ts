/// <reference types="blockbench-types" />
import { GEOMETRY_EPSILON } from "@/lib/constants";
import type { AxisIndex } from "@/lib/block-grid";

/**
 * Headless cube knife.
 *
 * Blockbench's Knife tool splits cubes through `KnifeToolCubeContext.apply()`,
 * which calls the module-private `splitCube()` in `js/modeling/mesh/knife_tool.js`.
 * That context opens its own undo entry per cut and owns 3D preview gizmos, so it
 * cannot be composed into one reversible multi-cut edit. This module ports the
 * split itself; callers own the undo transaction and canvas refresh.
 *
 * One deliberate divergence: the UV fraction is measured over the inflated
 * (visual) span on every axis. Blockbench's `splitCube` applies the inflate
 * only to the x component of `from`/`to` (a scalar `V3_subtract`), so its
 * fraction is off for inflated cubes cut on y or z.
 *
 * Cube objects are Blockbench host state and are mutated in place by design.
 *
 * @module
 */

/** Which UV corner index moves on each face when a cube is split along an axis. */
interface IUvEdgeShift {
  /** Faces of the piece that keeps the original `from`; corner index that moves toward the cut. */
  kept: Readonly<Partial<Record<CubeFaceDirection, number>>>;
  /** Faces of the new piece that starts at the cut; corner index that moves toward the cut. */
  created: Readonly<Partial<Record<CubeFaceDirection, number>>>;
}

/** Corner indices from Blockbench's `splitCube`; faces perpendicular to the axis are untouched. */
const UV_EDGE_SHIFTS: Readonly<Record<AxisIndex, IUvEdgeShift>> = {
  0: {
    kept: { north: 0, south: 2, up: 2, down: 2 },
    created: { north: 2, south: 0, up: 0, down: 0 },
  },
  1: {
    kept: { north: 1, south: 1, east: 1, west: 1 },
    created: { north: 3, south: 3, east: 3, west: 3 },
  },
  2: {
    kept: { east: 0, west: 2, up: 3, down: 1 },
    created: { east: 2, west: 0, up: 1, down: 3 },
  },
};

const lerp = (start: number, end: number, amount: number): number => start + (end - start) * amount;

const inverseLerp = (start: number, end: number, value: number): number =>
  Math.abs(end - start) < GEOMETRY_EPSILON ? 0 : (value - start) / (end - start);

/** Cuts closer than this to the edge of the cuttable range are treated as touching it. */
export const CUT_EDGE_TOLERANCE = 1e-3;

/** Visual span of a cube along one axis, including inflate. */
function visualSpan(cube: Cube, axis: AxisIndex): [number, number] {
  return [cube.from[axis] - cube.inflate, cube.to[axis] + cube.inflate];
}

/**
 * Range of cut positions that leave both pieces with valid geometry. The kept
 * piece ends at `position - inflate` and the new piece starts at
 * `position + inflate`, so the plane must stay `inflate` away from `from`/`to`.
 */
export function cutRange(cube: Cube, axis: AxisIndex): [number, number] {
  return [cube.from[axis] + cube.inflate, cube.to[axis] - cube.inflate];
}

/**
 * Whether a cut plane at `position` (in the cube's `from`/`to` coordinate space)
 * lies strictly inside {@link cutRange}, so neither resulting piece is inverted.
 */
export function isCutInsideCube(cube: Cube, axis: AxisIndex, position: number, tolerance = CUT_EDGE_TOLERANCE): boolean {
  const [start, end] = cutRange(cube, axis);
  return position > start + tolerance && position < end - tolerance;
}

/**
 * Moves one UV corner of a face to the cut, honoring the face's UV rotation as
 * Blockbench does. `inverted` selects the piece that starts at the cut.
 */
function shiftUvCorner(face: CubeFace | undefined, index: number, amount: number, inverted: boolean): void {
  if (!face) return;
  const rotation = typeof face.rotation === "number" ? face.rotation : 0;
  const corner = (((index - rotation / 90) % 4) + 4) % 4;
  const opposite = (corner + 2) % 4;
  const own = face.uv[corner];
  const other = face.uv[opposite];
  face.uv[corner] = inverted ? lerp(own, other, amount) : lerp(other, own, amount);
}

/** Blockbench declares `duplicate()` only on Group, but every OutlinerElement implements it. */
function duplicateCube(cube: Cube): Cube {
  return (cube as unknown as { duplicate(): Cube }).duplicate();
}

/**
 * Splits `cube` with a plane perpendicular to `axis` at `position`, exactly as
 * Blockbench's Knife tool does on cubes: the original keeps everything below the
 * cut, a duplicate takes everything above it, and both keep their share of the
 * original face UVs. Box UV is switched to per-face UV first when the format
 * allows it, so the two pieces can show different texture regions.
 *
 * `position` is in the cube's `from`/`to` coordinate space (model space for
 * unrotated cubes). The cube must have `from <= to` on the cut axis.
 *
 * @param cube - Cube to split; mutated in place.
 * @param axis - Vector index of the cut axis.
 * @param position - Coordinate of the cut plane along `axis`.
 * @param name - Optional name for the new piece; Blockbench's duplicate naming applies otherwise.
 * @returns The newly created cube (already initialized and parented next to the original).
 * @throws When the cut does not pass through the cube's interior, or the cube is inverted on `axis`.
 */
export function splitCubeAtPosition(cube: Cube, axis: AxisIndex, position: number, name?: string): Cube {
  if (cube.from[axis] > cube.to[axis]) {
    throw new Error(`Cube "${cube.name}" has inverted extents on axis ${axis}; resize it before cutting.`);
  }
  if (!isCutInsideCube(cube, axis, position)) {
    const [start, end] = cutRange(cube, axis);
    throw new Error(`Cut at ${position} does not pass through cube "${cube.name}" (cuttable from ${start} to ${end} on axis ${axis}).`);
  }
  if (cube.box_uv && Format.optional_box_uv) cube.box_uv = false;

  const created = duplicateCube(cube);
  const [start, end] = visualSpan(cube, axis);
  const amount = inverseLerp(start, end, position);
  const { inflate } = cube;

  cube.to[axis] = position - inflate;
  created.from[axis] = position + inflate;

  const shifts = UV_EDGE_SHIFTS[axis];
  Object.entries(shifts.kept).forEach(([direction, index]) =>
    shiftUvCorner(cube.faces[direction as CubeFaceDirection], index, amount, false));
  Object.entries(shifts.created).forEach(([direction, index]) =>
    shiftUvCorner(created.faces[direction as CubeFaceDirection], index, amount, true));

  if (name !== undefined) created.name = name;
  return created;
}

/** Result of cutting one cube at several positions. */
export interface ICubeCutResult {
  /** Every piece in ascending order along the axis; the first is the original cube. */
  pieces: Cube[];
  /** Requested positions that missed this cube's interior and were ignored. */
  skipped: number[];
}

/**
 * Cuts one cube at every position that passes through it, in ascending order.
 * Each new piece is named by `nameFor` and appended to `created`, which callers
 * pass to Undo so the new elements are tracked.
 *
 * @param cube - Cube to cut; becomes the lowest piece.
 * @param axis - Vector index of the cut axis.
 * @param positions - Cut coordinates in `from`/`to` space; duplicates and misses are skipped.
 * @param nameFor - Produces a unique name for each new piece; receives the original `cube`.
 * @param created - Accumulator that receives every new piece.
 */
export function cutCubeAtPositions(
  cube: Cube,
  axis: AxisIndex,
  positions: readonly number[],
  nameFor: (source: Cube) => string,
  created: Cube[],
): ICubeCutResult {
  const ordered = [...new Set(positions)].toSorted((left, right) => left - right);
  return ordered.reduce<ICubeCutResult>((state, position) => {
    const target = state.pieces[state.pieces.length - 1];
    if (!target || !isCutInsideCube(target, axis, position)) {
      return { ...state, skipped: [...state.skipped, position] };
    }
    const piece = splitCubeAtPosition(target, axis, position, nameFor(cube));
    created.push(piece);
    return { ...state, pieces: [...state.pieces, piece] };
  }, { pieces: [cube], skipped: [] });
}

/** Parent chain of an outliner node, nearest first; stops at the project root or a cycle. */
export function ancestorsOf(node: OutlinerNode): OutlinerNode[] {
  const chain: OutlinerNode[] = [];
  const seen = new Set<OutlinerNode>([node]);
  const visit = (candidate: OutlinerNode["parent"]): OutlinerNode[] => {
    if (!candidate || candidate === "root" || seen.has(candidate)) return chain;
    seen.add(candidate);
    chain.push(candidate);
    return visit(candidate.parent);
  };
  return visit(node.parent);
}

/**
 * Whether a plane perpendicular to `axis` stays planar in world space for this
 * cube: neither the cube nor any ancestor rotates about the other two axes.
 * Rotation about the cut axis itself is harmless, matching Blockbench's slicer.
 */
export function isCubeAlignedForAxis(cube: Cube, axis: AxisIndex): boolean {
  const offAxes = ([0, 1, 2] as const).filter(candidate => candidate !== axis);
  return [cube, ...ancestorsOf(cube)].every(node => {
    const rotation = (node as { rotation?: ArrayVector3 }).rotation;
    return !rotation || offAxes.every(offAxis => rotation[offAxis] === 0);
  });
}
