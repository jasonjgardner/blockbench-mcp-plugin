/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type IToolSpec } from "@/lib/factories";
import type { IToolCondition } from "@/server/tool-conditions";
import { axisEnum } from "@/lib/zodObjects";
import { SCRATCHPAD_MODE_ID, STATUS_EXPERIMENTAL } from "@/lib/constants";
import { runUndoableEdit } from "@/lib/undo";
import {
  ALL_AXES,
  AXIS_INDEX,
  AXIS_LETTERS,
  BLOCK_CELL_SIZE,
  OVERSIZED_BLOCK_MAX_CENTER_OFFSET,
  OVERSIZED_BLOCK_MAX_SIZE,
  blockCellKey,
  blockCellName,
  blockCellOf,
  blockCellOrigin,
  checkBlockBounds,
  cubeExtents,
  planGridCuts,
  unionExtents,
  type AxisIndex,
  type IBoxExtents,
  type IOversizedBlockLimits,
} from "@/lib/block-grid";
import { ancestorsOf, cutCubeAtPositions, cutRange, isCubeAlignedForAxis, type ICubeCutResult } from "@/lib/cube-knife";

// ============================================================================
// Parameter Schemas
// ============================================================================

const cubeReferencesSchema = z
  .array(z.string())
  .min(1)
  .optional()
  .describe("Cube UUIDs or unique cube names.");

/** Explicit knife cuts: one axis, any number of cut planes, applied to each target cube. */
export const knifeCutCubeParameters = z.object({
  cubes: cubeReferencesSchema.describe("Cube UUIDs or unique names to cut. Defaults to the selected cubes."),
  axis: axisEnum.describe("Axis the cut plane is perpendicular to."),
  positions: z
    .array(z.number().finite())
    .min(1)
    .describe("Cut-plane coordinates along the axis, in the cube's from/to space (model space for unrotated cubes). Positions closer than the cube's inflate to its from/to edges, or outside it, are skipped for that cube and reported sorted and deduplicated."),
});

/** Grid slicing: cut every target cube where it crosses a Bedrock block boundary and optionally regroup by block. */
export const sliceCubesToBlockGridParameters = z.object({
  cubes: cubeReferencesSchema.describe("Cube UUIDs or unique names to slice. Defaults to every cube in the project."),
  axes: z
    .array(axisEnum)
    .min(1)
    .default(["x", "y", "z"])
    .describe("Axes to slice along. Cubes rotated (or inside groups rotated) about the other two axes are skipped on that axis, as Blockbench's own slicer does."),
  cell_size: z.number().positive().default(BLOCK_CELL_SIZE).describe("Block size in model units; 16 for Bedrock. Horizontal boundaries sit at ±half a cell, vertical ones at multiples."),
  regroup: z
    .boolean()
    .default(true)
    .describe("Move every resulting cube into a group named after its block cell (bottom, top, right_top_front, top2, …) pivoted at that block's origin, so each group is one exportable block section. Pieces leave their previous bone; the report lists each source cube's former group."),
  parent: z.string().optional().describe("Parent group UUID or name for the cell groups; must not be rotated. Defaults to the project root."),
  group_prefix: z.string().default("").describe("Prefix for cell group names, e.g. `goal_` yields `goal_top`. Existing groups are reused only when their name and block-origin pivot match; otherwise a numbered name is chosen."),
});

/** Read-only report of cube and group extents against the oversized custom block limits. */
export const inspectBlockBoundsParameters = z.object({
  cubes: cubeReferencesSchema.describe("Cube UUIDs or unique names to inspect. Defaults to every cube in the project."),
  cell_size: z.number().positive().default(BLOCK_CELL_SIZE).describe("Block size in model units; 16 for Bedrock."),
  max_size: z.number().positive().default(OVERSIZED_BLOCK_MAX_SIZE).describe("Maximum geometry size per axis for one block (Bedrock: 30)."),
  max_center_offset: z.number().min(0).default(OVERSIZED_BLOCK_MAX_CENTER_OFFSET).describe("How far the limit box may shift from the block center per axis (Bedrock: 7, giving x/z within ±22 and y within -14…30)."),
});

// ============================================================================
// Tool Docs
// ============================================================================

const EDIT_CONDITION: Readonly<IToolCondition> = Object.freeze({ project: true, modes: ["edit", SCRATCHPAD_MODE_ID] });

/**
 * Static specs for the cube knife tools, shared by {@link registerKnifeTools}
 * and the docs generator. Order is part of the contract: knife_cut_cube,
 * slice_cubes_to_block_grid, inspect_block_bounds.
 */
export const knifeToolDocs: IToolSpec[] = [
  {
    name: "knife_cut_cube",
    condition: EDIT_CONDITION,
    description:
      "Headless Blockbench Knife tool for cubes: splits each target cube with planes perpendicular to one axis at the given positions, keeping each piece's share of the face UVs. The original cube keeps the lowest piece; new pieces get unique names. One undo entry covers every cut and the selection is left unchanged.",
    annotations: { title: "Knife Cut Cube", destructiveHint: true },
    parameters: knifeCutCubeParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "slice_cubes_to_block_grid",
    condition: EDIT_CONDITION,
    description:
      "Cuts cubes wherever they cross a Bedrock block boundary (16-unit grid, x/z centered) and, by default, regroups the pieces into one group per block cell pivoted at that block's origin. Use it to divide an oversized custom block model into per-block sections that each fit Bedrock's 30×30×30 limit. Rotated cubes are left uncut on the affected axes and reported.",
    annotations: { title: "Slice Cubes To Block Grid", destructiveHint: true },
    parameters: sliceCubesToBlockGridParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "inspect_block_bounds",
    condition: { project: true },
    description:
      "Reports cube, group, and whole-model extents against Blockbench's Bedrock block limit (a 30×30×30 box whose center may sit up to 7 units from the block center), the block cell each cube occupies, and the grid cut positions slice_cubes_to_block_grid would use. Read-only. Extents ignore rotation; rotated cubes are flagged.",
    annotations: { title: "Inspect Block Bounds", readOnlyHint: true },
    parameters: inspectBlockBoundsParameters,
    status: STATUS_EXPERIMENTAL,
  },
];

// ============================================================================
// Lookup helpers
// ============================================================================

interface INodeSummary {
  uuid: string;
  name: string;
}

interface ICubeSummary extends INodeSummary {
  from: ArrayVector3;
  to: ArrayVector3;
  /** Direct parent group, or null at the project root. */
  group: INodeSummary | null;
}

interface IKnifeCutReport {
  source: ICubeSummary;
  pieces: ICubeSummary[];
  skipped_positions: number[];
}

interface ICellGroupReport extends INodeSummary {
  cell: ArrayVector3;
  origin: ArrayVector3;
  cube_count: number;
}

/** A cube's parent node when it is not the project root. */
type ParentNode = Exclude<Cube["parent"], "root" | undefined>;

const summarizeNode = (node: ParentNode | Group): INodeSummary => ({ uuid: node.uuid, name: node.name });

const summarizeParent = (parent: Cube["parent"]): INodeSummary | null =>
  parent && parent !== "root" ? summarizeNode(parent) : null;

const summarizeCube = (cube: Cube): ICubeSummary => ({
  uuid: cube.uuid,
  name: cube.name,
  from: [...cube.from] as ArrayVector3,
  to: [...cube.to] as ArrayVector3,
  group: summarizeParent(cube.parent),
});

const sameVector = (left: ArrayVector3, right: ArrayVector3): boolean => left.every((value, index) => value === right[index]);

const isRotated = (node: OutlinerNode): boolean =>
  [node, ...ancestorsOf(node)].some(candidate => ((candidate as { rotation?: ArrayVector3 }).rotation ?? []).some(value => value !== 0));

function findCube(reference: string): Cube {
  const byUuid = Cube.all.find(cube => cube.uuid === reference);
  if (byUuid) return byUuid;
  const byName = Cube.all.filter(cube => cube.name === reference);
  if (byName.length === 1) return byName[0];
  if (byName.length === 0) throw new Error(`Cube "${reference}" not found. Use list_outline to see available cubes.`);
  throw new Error(`Cube name "${reference}" matches ${byName.length} cubes. Use a UUID from list_outline instead.`);
}

/**
 * Resolves explicit references, or copies the fallback set when none are given.
 * The copy keeps the target list stable while `duplicate()` rewrites the host selection.
 */
function resolveCubes(references: string[] | undefined, fallback: () => Cube[], fallbackLabel: string): Cube[] {
  if (references) return [...new Set(references.map(findCube))];
  const cubes = [...fallback()];
  if (cubes.length === 0) throw new Error(`No ${fallbackLabel} cubes. Provide cube UUIDs or names.`);
  return cubes;
}

function resolveParentGroup(reference: string | undefined): Group | "root" {
  if (reference === undefined) return "root";
  const group = Group.all.find(candidate => candidate.uuid === reference) ?? Group.all.find(candidate => candidate.name === reference);
  if (!group) throw new Error(`Parent group "${reference}" not found. Use list_outline to inspect group UUIDs and names.`);
  if (isRotated(group)) {
    throw new Error(`Parent group "${group.name}" is rotated (or sits under a rotated group). Block cell groups need an unrotated parent so their pivots stay on the block grid.`);
  }
  return group;
}

/** Hands out names that are unique among the names it was seeded with and the ones it has issued. */
interface INameClaimer {
  /** Returns `base` when free, otherwise `base_2`, `base_3`, … using the lowest free suffix. */
  claim(base: string): string;
}

function createNameClaimer(existing: Iterable<string>): INameClaimer {
  const taken = new Set(existing);
  return {
    claim(base) {
      const suffixes = Array.from({ length: taken.size + 2 }, (_, index) => index + 2);
      const suffix = suffixes.find(candidate => !taken.has(`${base}_${candidate}`)) ?? taken.size + 2;
      const name = taken.has(base) ? `${base}_${suffix}` : base;
      taken.add(name);
      return name;
    },
  };
}

// ============================================================================
// Host interaction helpers
// ============================================================================

/**
 * Refuses to cut while the interactive Knife tool holds an unfinished cut, and
 * discards an idle hover context so the two never fight over the same cube.
 */
function releaseInteractiveKnife(): void {
  if (typeof KnifeToolContext === "undefined") return;
  const current: unknown = KnifeToolContext.current;
  if (!current || typeof current !== "object") return;
  const context = current as { first_point_set?: boolean; points?: unknown[]; cancel?: () => void };
  const pending = context.first_point_set === true || (Array.isArray(context.points) && context.points.length > 0);
  if (pending) {
    throw new Error("Blockbench's interactive Knife tool has an unfinished cut. Confirm it (Enter) or cancel it (Escape) before using headless knife tools.");
  }
  context.cancel?.();
}

/**
 * `Cube.duplicate()` swaps or pushes each copy into Blockbench's live selection.
 * Restore the caller's selection once every cut is done so a headless edit does
 * not change what the user has selected.
 */
function withPreservedSelection<T>(edit: () => T): T {
  const selected = [...Outliner.selected];
  const result = edit();
  Outliner.selected.splice(0, Outliner.selected.length, ...selected);
  return result;
}

function refreshCanvas(elements: Cube[], hierarchyChanged: boolean): void {
  Canvas.updateView({ elements, element_aspects: { geometry: true, uv: true, transform: true }, selection: true });
  if (hierarchyChanged) Canvas.updateAll();
}

/** `addTo` silently refuses parents the format forbids; surface that as an error inside the transaction. */
function attach(child: Cube | Group, parent: Group | "root", label: string): void {
  child.addTo(parent);
  if (child.parent !== parent) throw new Error(`The current format does not allow ${label}.`);
}

/** Cubes whose box UV cannot be converted, so both halves keep the full box texture after a cut. */
const lockedBoxUvCubes = (cubes: Cube[]): ICubeSummary[] =>
  Format.optional_box_uv ? [] : cubes.filter(cube => cube.box_uv).map(summarizeCube);

const worldCenterOf = (cube: Cube): ArrayVector3 => {
  const center = cube.getWorldCenter();
  return [center.x, center.y, center.z];
};

// ============================================================================
// Slicing
// ============================================================================

function cutReport(source: ICubeSummary, result: ICubeCutResult): IKnifeCutReport {
  return { source, pieces: result.pieces.map(summarizeCube), skipped_positions: result.skipped };
}

/** Slices one cube along one axis at every grid boundary inside its cuttable range; returns all resulting pieces. */
function sliceCubeOnAxis(cube: Cube, axis: AxisIndex, cellSize: number, namer: INameClaimer, created: Cube[]): Cube[] {
  const [start, end] = cutRange(cube, axis);
  const cuts = planGridCuts(start, end, axis, cellSize);
  return cutCubeAtPositions(cube, axis, cuts, source => namer.claim(source.name), created).pieces;
}

interface ISliceOutcome {
  pieces: Cube[];
  skippedRotated: Cube[];
}

/** Applies grid slicing axis by axis; pieces produced on one axis are sliced again on the next. */
function sliceCubesOnAxes(cubes: Cube[], axes: AxisIndex[], cellSize: number, namer: INameClaimer, created: Cube[]): ISliceOutcome {
  const skipped = new Set<Cube>();
  const pieces = axes.reduce<Cube[]>((current, axis) => current.flatMap(cube => {
    if (isCubeAlignedForAxis(cube, axis)) return sliceCubeOnAxis(cube, axis, cellSize, namer, created);
    skipped.add(cube);
    return [cube];
  }), cubes);
  return { pieces, skippedRotated: [...skipped] };
}

// ============================================================================
// Regrouping
// ============================================================================

interface ICellGroupEntry {
  group: Group;
  cell: ArrayVector3;
  cubes: Cube[];
}

function resolveCellGroup(name: string, cell: ArrayVector3, cellSize: number, parent: Group | "root", namer: INameClaimer, groups: Group[]): Group {
  const origin = blockCellOrigin(cell, cellSize);
  const existing = Group.all.find(group => group.name === name && group.parent === parent && sameVector(group.origin, origin));
  if (existing) return existing;
  const group = new Group({ name: namer.claim(name), origin }).init();
  // Track before attaching so a rejected parent still reverts the new group.
  groups.push(group);
  attach(group, parent, `group "${group.name}" under the requested parent`);
  return group;
}

/** Moves every piece into the group of the block cell containing its world center. */
function regroupByCell(pieces: Cube[], cellSize: number, prefix: string, parent: Group | "root", groups: Group[]): ICellGroupReport[] {
  const namer = createNameClaimer(Group.all.map(group => group.name));
  const entries = new Map<string, ICellGroupEntry>();
  pieces.forEach(cube => {
    const cell = blockCellOf(worldCenterOf(cube), cellSize);
    const key = blockCellKey(cell);
    const entry = entries.get(key) ?? {
      group: resolveCellGroup(`${prefix}${blockCellName(cell)}`, cell, cellSize, parent, namer, groups),
      cell,
      cubes: [],
    };
    attach(cube, entry.group, `"${cube.name}" inside group "${entry.group.name}"`);
    entries.set(key, { ...entry, cubes: [...entry.cubes, cube] });
  });
  return [...entries.values()].map(({ group, cell, cubes }) => ({
    ...summarizeNode(group),
    cell,
    origin: [...group.origin] as ArrayVector3,
    cube_count: cubes.length,
  }));
}

// ============================================================================
// Inspection
// ============================================================================

function describeBox(box: IBoxExtents, limits: IOversizedBlockLimits) {
  return { min: box.min, max: box.max, ...checkBlockBounds(box, limits) };
}

function describeCube(cube: Cube, limits: IOversizedBlockLimits) {
  const box = cubeExtents(cube.from, cube.to, cube.inflate);
  const gridCuts = Object.fromEntries(ALL_AXES.map(axis => {
    const [start, end] = cutRange(cube, axis);
    return [AXIS_LETTERS[axis], { aligned: isCubeAlignedForAxis(cube, axis), positions: planGridCuts(start, end, axis, limits.cellSize) }];
  }));
  return {
    ...summarizeCube(cube),
    inflate: cube.inflate,
    rotated: isRotated(cube),
    bounds: describeBox(box, limits),
    cell: blockCellOf(worldCenterOf(cube), limits.cellSize),
    crosses_block_boundary: Object.values(gridCuts).some(entry => entry.positions.length > 0),
    grid_cuts: gridCuts,
  };
}

function describeGroups(cubes: Cube[], limits: IOversizedBlockLimits) {
  const byGroup = cubes.reduce<Map<ParentNode, Cube[]>>((map, cube) => {
    const parent = cube.parent;
    if (!parent || parent === "root") return map;
    return map.set(parent, [...(map.get(parent) ?? []), cube]);
  }, new Map());
  return [...byGroup.entries()].map(([group, members]) => {
    const box = unionExtents(members.map(cube => cubeExtents(cube.from, cube.to, cube.inflate)));
    return {
      ...summarizeNode(group),
      origin: group instanceof Group ? [...group.origin] as ArrayVector3 : null,
      cube_count: members.length,
      bounds: box ? describeBox(box, limits) : null,
    };
  });
}

// ============================================================================
// Registration
// ============================================================================

/** Registers the cube knife tools with the MCP server. */
export function registerKnifeTools(): void {
  createTool(knifeToolDocs[0].name, {
    ...knifeToolDocs[0],
    parameters: knifeCutCubeParameters,
    async execute({ cubes, axis, positions }) {
      const targets = resolveCubes(cubes, () => Cube.selected, "selected");
      const axisIndex = AXIS_INDEX[axis];
      releaseInteractiveKnife();
      const elements: Cube[] = [...targets];
      const namer = createNameClaimer(Cube.all.map(cube => cube.name));
      const reports = runUndoableEdit({ elements, outliner: true, selection: true }, "Knife cut cubes", () => withPreservedSelection(() => {
        const results = targets.map(cube =>
          cutReport(summarizeCube(cube), cutCubeAtPositions(cube, axisIndex, positions, source => namer.claim(source.name), elements)));
        refreshCanvas(elements, false);
        return results;
      }));
      const result = {
        axis,
        cubes: reports,
        created_count: elements.length - targets.length,
        box_uv_locked: lockedBoxUvCubes(targets),
      };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    },
  }, knifeToolDocs[0].status);

  createTool(knifeToolDocs[1].name, {
    ...knifeToolDocs[1],
    parameters: sliceCubesToBlockGridParameters,
    async execute({ cubes, axes, cell_size, regroup, parent, group_prefix }) {
      const targets = resolveCubes(cubes, () => Cube.all, "project");
      const parentGroup = resolveParentGroup(parent);
      const axisIndices = [...new Set(axes.map(letter => AXIS_INDEX[letter]))].toSorted((left, right) => left - right);
      releaseInteractiveKnife();
      const elements: Cube[] = [...targets];
      const groups: Group[] = [];
      const namer = createNameClaimer(Cube.all.map(cube => cube.name));
      const sources = targets.map(summarizeCube);
      const boxUvLocked = lockedBoxUvCubes(targets);
      const result = runUndoableEdit({ elements, groups, outliner: true, selection: true }, "Slice cubes to block grid", () => withPreservedSelection(() => {
        const { pieces, skippedRotated } = sliceCubesOnAxes(targets, axisIndices, cell_size, namer, elements);
        const cellGroups = regroup ? regroupByCell(pieces, cell_size, group_prefix, parentGroup, groups) : [];
        refreshCanvas(elements, regroup);
        return {
          axes: axisIndices.map(axis => AXIS_LETTERS[axis]),
          cell_size,
          sources,
          pieces: pieces.map(summarizeCube),
          created_count: elements.length - targets.length,
          skipped_rotated: skippedRotated.map(summarizeCube),
          box_uv_locked: boxUvLocked,
          groups: cellGroups,
        };
      }));
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    },
  }, knifeToolDocs[1].status);

  createTool(knifeToolDocs[2].name, {
    ...knifeToolDocs[2],
    parameters: inspectBlockBoundsParameters,
    async execute({ cubes, cell_size, max_size, max_center_offset }) {
      const targets = resolveCubes(cubes, () => Cube.all, "project");
      const limits: IOversizedBlockLimits = { maxSize: max_size, maxCenterOffset: max_center_offset, cellSize: cell_size };
      const cubeReports = targets.map(cube => describeCube(cube, limits));
      const model = unionExtents(targets.map(cube => cubeExtents(cube.from, cube.to, cube.inflate)));
      const cellKeys = [...new Set(cubeReports.map(report => blockCellKey(report.cell)))];
      const result = {
        limits: { max_size, max_center_offset, cell_size, rotation_ignored: true },
        model: model ? describeBox(model, limits) : null,
        fits_single_block: model ? checkBlockBounds(model, limits).valid : true,
        cubes: cubeReports,
        groups: describeGroups(targets, limits),
        cells: cellKeys.map(key => {
          const members = cubeReports.filter(report => blockCellKey(report.cell) === key);
          return { cell: members[0].cell, name: blockCellName(members[0].cell), cube_count: members.length };
        }),
      };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    },
  }, knifeToolDocs[2].status);
}
