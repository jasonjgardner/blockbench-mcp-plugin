/// <reference types="blockbench-types" />

/**
 * Pure geometry helpers for the Bedrock block grid: which 16-unit block cell a
 * point belongs to, where a cube crosses cell boundaries, and whether a box
 * respects the oversized custom block limits. The rule mirrors Blockbench's own
 * Bedrock block size limiter (`cube_size_limiter` in js/formats/bedrock/bedrock.js):
 * the geometry must fit a 30×30×30 box whose center may sit at most 7 units from
 * the block center. Microsoft's page phrases the same limit more loosely:
 * https://learn.microsoft.com/minecraft/creator/documents/customblockoversized
 *
 * Nothing here touches Blockbench globals, so the docs generator and unit tests
 * can import it freely.
 *
 * @module
 */

/** Index into a Blockbench `[x, y, z]` triple. */
export type AxisIndex = 0 | 1 | 2;

/** Axis letters accepted by tool parameters. */
export type AxisLetter = "x" | "y" | "z";

/** Maps axis letters to their vector index. */
export const AXIS_INDEX: Readonly<Record<AxisLetter, AxisIndex>> = { x: 0, y: 1, z: 2 };

/** Axis letter for each vector index. */
export const AXIS_LETTERS: readonly AxisLetter[] = ["x", "y", "z"];

/** Every axis index, in x/y/z order (the order Blockbench's own multiblock slicer uses). */
export const ALL_AXES: readonly AxisIndex[] = [0, 1, 2];

/** Size of one Bedrock block in model units (16 pixels). */
export const BLOCK_CELL_SIZE = 16;

/** Documented maximum size of one custom block's geometry along each axis. */
export const OVERSIZED_BLOCK_MAX_SIZE = 30;

/** How far the 30-unit limit box may be shifted from the block center on each axis. */
export const OVERSIZED_BLOCK_MAX_CENTER_OFFSET = 7;

/**
 * Distance under which Blockbench treats a grid line as touching a cube edge
 * and skips the cut (mirrors `slice_bedrock_multiblock`).
 */
export const GRID_EDGE_TOLERANCE = 0.6;

/** Axis-aligned box in model units. */
export interface IBoxExtents {
  min: ArrayVector3;
  max: ArrayVector3;
}

/** Limits used when validating a box against the oversized block rules. */
export interface IOversizedBlockLimits {
  /** Maximum size along each axis. */
  maxSize: number;
  /** Maximum shift of the limit box's center from the block center on each axis. */
  maxCenterOffset: number;
  /** Size of the base block; the block center sits half a cell above the origin. */
  cellSize: number;
}

/** Outcome of {@link checkBlockBounds}; every flag must hold for a valid single-block geometry. */
export interface IBlockBoundsCheck {
  size: ArrayVector3;
  /** Each axis size is at most `maxSize`. */
  within_size_limit: boolean;
  /** Every corner lies inside the region a shifted limit box can reach. */
  within_center_offset: boolean;
  valid: boolean;
}

/**
 * Grid offset Blockbench uses per axis: blocks sit on integer multiples of the cell
 * size vertically, but are centered horizontally (x/z boundaries at ±8, ±24, …).
 */
export function gridOffsetForAxis(axis: AxisIndex, cellSize = BLOCK_CELL_SIZE): number {
  return axis === 1 ? 0 : cellSize / 2;
}

/**
 * Cell-boundary positions strictly inside the `[from, to]` span along one axis.
 * Boundaries within `tolerance` of either end are skipped, as Blockbench does,
 * because such a cut would create a sliver.
 */
export function planGridCuts(
  from: number,
  to: number,
  axis: AxisIndex,
  cellSize = BLOCK_CELL_SIZE,
  tolerance = GRID_EDGE_TOLERANCE,
): number[] {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const offset = gridOffsetForAxis(axis, cellSize);
  const first = Math.ceil((start + offset) / cellSize) * cellSize - offset;
  const count = Math.max(0, Math.ceil((end - first) / cellSize));
  return Array.from({ length: count }, (_, index) => first + index * cellSize)
    .filter(position => position < end && Math.abs(position - start) > tolerance && Math.abs(position - end) > tolerance);
}

/**
 * Block cell containing a world-space point. Horizontal axes round because
 * blocks are centered on the grid; y floors because blocks sit on it.
 */
export function blockCellOf(point: ArrayVector3, cellSize = BLOCK_CELL_SIZE): ArrayVector3 {
  const normalize = (value: number): number => (Object.is(value, -0) ? 0 : value);
  return [
    normalize(Math.round(point[0] / cellSize)),
    normalize(Math.floor(point[1] / cellSize)),
    normalize(Math.round(point[2] / cellSize)),
  ];
}

/** Stable map key for a cell. */
export function blockCellKey(cell: ArrayVector3): string {
  return cell.join(",");
}

/** World-space origin (bottom center) of a block cell; a natural pivot for that block's bone. */
export function blockCellOrigin(cell: ArrayVector3, cellSize = BLOCK_CELL_SIZE): ArrayVector3 {
  return [cell[0] * cellSize, cell[1] * cellSize, cell[2] * cellSize];
}

function offsetName(offset: number, center: string, positive: string, negative: string): string {
  if (offset === 0) return center;
  const magnitude = Math.abs(offset);
  return `${offset > 0 ? positive : negative}${magnitude >= 2 ? magnitude : ""}`;
}

/**
 * Human-readable cell name using Blockbench's multiblock scheme: the base cell is
 * `bottom`; `[1, 1, -1]` is `right_top_back`; `[0, 2, 0]` is `top2`.
 */
export function blockCellName(cell: ArrayVector3): string {
  return [
    offsetName(cell[0], "", "right", "left"),
    offsetName(cell[1], "bottom", "top", "below"),
    offsetName(cell[2], "", "front", "back"),
  ].filter(part => part.length > 0).join("_");
}

/** Extents of a cube including its inflate, tolerant of inverted `from`/`to`. */
export function cubeExtents(from: ArrayVector3, to: ArrayVector3, inflate = 0): IBoxExtents {
  return {
    min: [Math.min(from[0], to[0]) - inflate, Math.min(from[1], to[1]) - inflate, Math.min(from[2], to[2]) - inflate],
    max: [Math.max(from[0], to[0]) + inflate, Math.max(from[1], to[1]) + inflate, Math.max(from[2], to[2]) + inflate],
  };
}

/** Smallest box containing every input box; `undefined` for an empty list. */
export function unionExtents(boxes: readonly IBoxExtents[]): IBoxExtents | undefined {
  if (boxes.length === 0) return undefined;
  return boxes.reduce((union, box) => ({
    min: [Math.min(union.min[0], box.min[0]), Math.min(union.min[1], box.min[1]), Math.min(union.min[2], box.min[2])],
    max: [Math.max(union.max[0], box.max[0]), Math.max(union.max[1], box.max[1]), Math.max(union.max[2], box.max[2])],
  }));
}

/** Per-axis size of a box. */
export function extentsSize(box: IBoxExtents): ArrayVector3 {
  return [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
}

/** Center point of a box. */
export function extentsCenter(box: IBoxExtents): ArrayVector3 {
  return [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
}

const SIZE_EPSILON = 1e-6;

/** Center of the base block: half a cell above the origin. */
export function blockCenter(cellSize = BLOCK_CELL_SIZE): ArrayVector3 {
  return [0, cellSize / 2, 0];
}

/**
 * Validates a box the way Blockbench's Bedrock block limiter does: it must fit
 * inside a `maxSize` cube whose center lies within `maxCenterOffset` of the
 * block center. With the defaults that means x/z within ±22, y within -14…30,
 * and no axis longer than 30.
 */
export function checkBlockBounds(box: IBoxExtents, limits: IOversizedBlockLimits): IBlockBoundsCheck {
  const size = extentsSize(box);
  const center = blockCenter(limits.cellSize);
  const reach = limits.maxCenterOffset + limits.maxSize / 2;
  const withinSize = size.every(value => value <= limits.maxSize + SIZE_EPSILON);
  const withinCenterOffset = ALL_AXES.every(axis =>
    box.min[axis] >= center[axis] - reach - SIZE_EPSILON && box.max[axis] <= center[axis] + reach + SIZE_EPSILON);
  return {
    size,
    within_size_limit: withinSize,
    within_center_offset: withinCenterOffset,
    valid: withinSize && withinCenterOffset,
  };
}
