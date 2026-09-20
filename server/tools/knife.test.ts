import { beforeAll, beforeEach, expect, test } from "bun:test";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
import { useGlobals } from "@/tests/helpers/globals";
import { createUndoHost } from "@/tests/helpers/undo-host";
import { isRecord } from "@/tests/helpers/assertions";
import type { Vector3Tuple } from "@/tests/helpers/shapes";

const directions = ["north", "east", "south", "west", "up", "down"] as const;
type Direction = typeof directions[number];
type UV = [number, number, number, number];

interface IFace { uv: UV; rotation: number }
interface ICubeData { uuid: string; name: string; from: Vector3Tuple; to: Vector3Tuple; parent: string; faces: Record<Direction, IFace> }
interface ISnapshot { cubes: ICubeData[]; groups: string[]; selected: string[] }
interface IAspects { elements: HostCube[]; groups?: HostGroup[]; outliner?: boolean; selection?: boolean }

let tools: IToolFixture;
let nextId = 0;
let canvasViews = 0;
let canvasAll = 0;
let knifeContext: { first_point_set?: boolean; points?: unknown[]; cancelled: boolean; cancel(): void } | null;
/** Blockbench's live selection array, shared by `Cube.selected` and `Outliner.selected`. */
const selection: HostCube[] = [];
const format = { id: "bedrock_block", optional_box_uv: true };

class HostGroup {
  static all: HostGroup[] = [];
  readonly uuid = `group-${++nextId}`;
  name: string;
  origin: Vector3Tuple;
  rotation: Vector3Tuple = [0, 0, 0];
  parent: HostGroup | "root" = "root";
  constructor(options: { name: string; origin?: Vector3Tuple }) {
    this.name = options.name;
    this.origin = options.origin ?? [0, 0, 0];
  }
  init(): this { HostGroup.all.push(this); return this; }
  addTo(parent: HostGroup | "root"): this { this.parent = parent; return this; }
}

class HostCube {
  static all: HostCube[] = [];
  static get selected(): HostCube[] { return selection; }
  readonly uuid = `cube-${++nextId}`;
  name: string;
  from: Vector3Tuple;
  to: Vector3Tuple;
  origin: Vector3Tuple = [0, 0, 0];
  rotation: Vector3Tuple = [0, 0, 0];
  inflate = 0;
  box_uv = false;
  parent: HostGroup | "root" = "root";
  faces: Record<Direction, IFace>;
  constructor(name: string, from: Vector3Tuple, to: Vector3Tuple) {
    this.name = name;
    this.from = [...from];
    this.to = [...to];
    this.faces = Object.fromEntries(directions.map(direction => [direction, { uv: [0, 0, 16, 16] as UV, rotation: 0 }])) as Record<Direction, IFace>;
  }
  init(): this { HostCube.all.push(this); return this; }
  addTo(parent: HostGroup | "root"): this { this.parent = parent; return this; }
  /** Mirrors OutlinerElement.duplicate(): copy next to the source, and the copy replaces a selected source in the selection. */
  duplicate(): HostCube {
    const copy = new HostCube(this.name, this.from, this.to);
    copy.rotation = [...this.rotation];
    copy.inflate = this.inflate;
    copy.box_uv = this.box_uv;
    copy.parent = this.parent;
    directions.forEach(direction => Object.assign(copy.faces[direction], structuredClone(this.faces[direction])));
    HostCube.all.splice(HostCube.all.indexOf(this) + 1, 0, copy);
    const index = selection.indexOf(this);
    if (index >= 0) selection[index] = copy;
    if (index < 0) selection.push(copy);
    return copy;
  }
  getWorldCenter(): { x: number; y: number; z: number } {
    return { x: (this.from[0] + this.to[0]) / 2, y: (this.from[1] + this.to[1]) / 2, z: (this.from[2] + this.to[2]) / 2 };
  }
}

function data(cube: HostCube): ICubeData {
  return {
    uuid: cube.uuid, name: cube.name, from: [...cube.from], to: [...cube.to],
    parent: cube.parent === "root" ? "root" : cube.parent.uuid,
    faces: structuredClone(cube.faces),
  };
}

const undo = createUndoHost<ISnapshot, IAspects>({
  snapshot: () => ({ cubes: HostCube.all.map(data), groups: HostGroup.all.map(group => group.uuid), selected: selection.map(cube => cube.uuid) }),
  restore: (target) => {
    HostCube.all = target.cubes.map(item => {
      const existing = HostCube.all.find(cube => cube.uuid === item.uuid) ?? new HostCube(item.name, item.from, item.to);
      Object.assign(existing, { name: item.name, from: [...item.from], to: [...item.to], faces: structuredClone(item.faces) });
      existing.parent = item.parent === "root" ? "root" : HostGroup.all.find(group => group.uuid === item.parent) ?? "root";
      return existing;
    });
    HostGroup.all = HostGroup.all.filter(group => target.groups.includes(group.uuid));
    selection.splice(0, selection.length, ...HostCube.all.filter(cube => target.selected.includes(cube.uuid)));
  },
});

beforeAll(async () => {
  tools = await loadToolDefinitions({ entries: ["server/tools/knife.ts"], register: ["registerKnifeTools"] });
});

beforeEach(() => {
  HostCube.all = [];
  HostGroup.all = [];
  selection.length = 0;
  format.optional_box_uv = true;
  canvasViews = 0;
  canvasAll = 0;
  knifeContext = null;
  undo.reset();
});

useGlobals(() => ({
  Project: { uuid: "project" },
  Modes: { id: "edit" },
  Format: format,
  Cube: HostCube,
  Group: HostGroup,
  Outliner: { selected: selection },
  Undo: {
    initEdit: undo.initEdit.bind(undo),
    finishEdit: undo.finishEdit.bind(undo),
    cancelEdit: undo.cancelEdit.bind(undo),
  },
  Canvas: { updateView: () => { canvasViews++; }, updateAll: () => { canvasAll++; } },
  KnifeToolContext: { get current() { return knifeContext; } },
}));

function structured(result: unknown): Record<string, unknown> {
  if (!isRecord(result) || !isRecord(result.structuredContent) || !Array.isArray(result.content)) throw new Error("Expected structured result");
  const text = result.content[0];
  if (!isRecord(text) || typeof text.text !== "string") throw new Error("Missing JSON mirror");
  expect(JSON.parse(text.text)).toEqual(result.structuredContent);
  return result.structuredContent;
}

/** The example gym goal's pole and base: 58 units tall, 29.6 wide, both far outside one block. */
function buildGoal(): { pole: HostCube; base: HostCube } {
  const pole = new HostCube("pole", [-2.8, 6, 27.2], [2.8, 64, 32.8]).init();
  const base = new HostCube("base", [-14.8, 0, 18], [14.8, 7.4, 42]).init();
  return { pole, base };
}

test("knife_cut_cube splits at each interior position in one undo entry, names pieces uniquely, and keeps the selection", async () => {
  const { pole, base } = buildGoal();
  new HostCube("pole_2", [0, 0, 0], [1, 1, 1]).init();
  selection.push(pole, base);
  const result = structured(await tools.call("knife_cut_cube", { cubes: ["pole"], axis: "y", positions: [32, 16, 6, 48, 70] }));

  expect(result.created_count).toBe(3);
  expect(result.box_uv_locked).toEqual([]);
  const [report] = result.cubes as Array<Record<string, unknown>>;
  expect(report.skipped_positions).toEqual([6, 70]);
  const pieces = report.pieces as Array<{ name: string; from: Vector3Tuple; to: Vector3Tuple; group: unknown }>;
  expect(pieces.map(piece => piece.name)).toEqual(["pole", "pole_3", "pole_4", "pole_5"]);
  expect(pieces.map(piece => [piece.from[1], piece.to[1]])).toEqual([[6, 16], [16, 32], [32, 48], [48, 64]]);
  expect(pieces.every(piece => piece.group === null)).toBe(true);
  expect(pole.to[1]).toBe(16);
  expect(HostCube.all).toHaveLength(6);
  expect(selection).toEqual([pole, base]);
  expect(undo.starts).toBe(1);
  expect(undo.finishes).toBe(1);
  expect(undo.lastEdit?.message).toBe("Knife cut cubes");
  expect(undo.lastEdit?.after.cubes).toHaveLength(6);
  expect(undo.pending).toBeUndefined();
  expect(canvasViews).toBe(1);

  undo.undo();
  expect(HostCube.all).toHaveLength(3);
  expect(pole.to[1]).toBe(64);
  expect(selection).toEqual([pole, base]);
});

test("knife_cut_cube uses the selection by default, rejects ambiguous names before editing, and reports locked box UV", async () => {
  const { base } = buildGoal();
  new HostCube("base", [0, 0, 0], [1, 1, 1]).init();
  selection.push(base);
  await expect(tools.call("knife_cut_cube", { cubes: ["base"], axis: "x", positions: [0] })).rejects.toThrow(/matches 2 cubes/);
  await expect(tools.call("knife_cut_cube", { cubes: ["missing"], axis: "x", positions: [0] })).rejects.toThrow(/not found/);
  expect(undo.starts).toBe(0);

  base.box_uv = true;
  format.optional_box_uv = false;
  const result = structured(await tools.call("knife_cut_cube", { axis: "x", positions: [0] }));
  expect(result.created_count).toBe(1);
  expect(base.to[0]).toBe(0);
  expect(base.box_uv).toBe(true);
  expect((result.box_uv_locked as Array<{ uuid: string }>).map(cube => cube.uuid)).toEqual([base.uuid]);
  selection.length = 0;
  await expect(tools.call("knife_cut_cube", { axis: "x", positions: [0] })).rejects.toThrow(/No selected cubes/);
});

test("an unfinished interactive knife cut blocks headless cuts; an idle hover context is cancelled", async () => {
  buildGoal();
  knifeContext = { first_point_set: true, cancelled: false, cancel() { this.cancelled = true; } };
  await expect(tools.call("knife_cut_cube", { cubes: ["pole"], axis: "y", positions: [32] })).rejects.toThrow(/unfinished cut/);
  expect(undo.starts).toBe(0);

  knifeContext = { first_point_set: false, cancelled: false, cancel() { this.cancelled = true; } };
  await tools.call("knife_cut_cube", { cubes: ["pole"], axis: "y", positions: [32] });
  expect(knifeContext.cancelled).toBe(true);
  expect(undo.finishes).toBe(1);
});

test("slice_cubes_to_block_grid cuts on every block boundary and regroups pieces per block cell", async () => {
  const { pole, base } = buildGoal();
  const arm = new HostCube("arm", [-3, 51.4, -8.8], [3, 63.8, 31.5]).init();
  arm.rotation = [15, 0, 0];
  const bone = new HostGroup({ name: "pole_bone", origin: [0, 0, 30] }).init();
  pole.addTo(bone);
  const result = structured(await tools.call("slice_cubes_to_block_grid", { group_prefix: "goal_" }));

  // Pole: y cuts at 16, 32, 48 → 4 pieces (z span 27.2–32.8 has no boundary at 24 or 40).
  // Base: x cuts at -8, 8 and z cuts at 24, 40 → 9 pieces.
  // Arm: rotated about x, so cut only along x (none needed) → stays 1 piece.
  expect(result.created_count).toBe(3 + 8);
  expect(HostCube.all).toHaveLength(14);
  expect(pole.to[1]).toBe(16);
  expect(base.to).toEqual([-8, 7.4, 24]);
  expect((result.skipped_rotated as Array<{ name: string }>).map(cube => cube.name)).toEqual(["arm"]);
  const sources = result.sources as Array<{ name: string; group: { uuid: string; name: string } | null }>;
  expect(sources.find(source => source.name === "pole")?.group).toEqual({ uuid: bone.uuid, name: "pole_bone" });

  const groups = result.groups as Array<{ name: string; cell: Vector3Tuple; origin: Vector3Tuple; cube_count: number }>;
  const byName = Object.fromEntries(groups.map(group => [group.name, group]));
  expect(byName.goal_bottom_front2).toMatchObject({ cell: [0, 0, 2], origin: [0, 0, 32], cube_count: 2 });
  expect(byName.goal_top3_front2).toMatchObject({ cell: [0, 3, 2], origin: [0, 48, 32], cube_count: 1 });
  expect(byName.goal_left_bottom_front).toMatchObject({ cell: [-1, 0, 1], origin: [-16, 0, 16], cube_count: 1 });
  expect(HostCube.all.every(cube => cube.parent !== "root" && cube.parent !== bone)).toBe(true);
  expect(HostGroup.all).toHaveLength(groups.length + 1);

  expect(undo.starts).toBe(1);
  expect(undo.lastEdit?.message).toBe("Slice cubes to block grid");
  expect(canvasAll).toBe(1);
  undo.undo();
  expect(HostCube.all).toHaveLength(3);
  expect(HostGroup.all).toEqual([bone]);
  expect(pole.parent).toBe(bone);
});

test("slice_cubes_to_block_grid honors axis and parent options and reuses only matching cell groups", async () => {
  const { pole } = buildGoal();
  const rig = new HostGroup({ name: "rig" }).init();
  const matching = new HostGroup({ name: "top_front2", origin: [0, 16, 32] }).init().addTo(rig);
  const misplaced = new HostGroup({ name: "top2_front2", origin: [0, 0, 0] }).init().addTo(rig);
  const result = structured(await tools.call("slice_cubes_to_block_grid", { cubes: [pole.uuid], axes: ["y", "y"], parent: "rig" }));

  expect(result.axes).toEqual(["y"]);
  expect(result.created_count).toBe(3);
  const groups = result.groups as Array<{ uuid: string; name: string; origin: Vector3Tuple }>;
  expect(groups.find(group => group.name === "top_front2")?.uuid).toBe(matching.uuid);
  expect(groups.find(group => group.name === "top2_front2_2")).toMatchObject({ origin: [0, 32, 32] });
  expect(groups.some(group => group.uuid === misplaced.uuid)).toBe(false);
  expect(HostGroup.all.filter(group => group.parent === rig)).toHaveLength(5);
  await expect(tools.call("slice_cubes_to_block_grid", { parent: "nope" })).rejects.toThrow(/Parent group "nope" not found/);
});

test("slice_cubes_to_block_grid refuses a rotated parent before editing", async () => {
  buildGoal();
  const tilted = new HostGroup({ name: "tilted" }).init();
  tilted.rotation = [0, 45, 0];
  const nested = new HostGroup({ name: "nested" }).init().addTo(tilted);
  await expect(tools.call("slice_cubes_to_block_grid", { parent: "tilted" })).rejects.toThrow(/is rotated/);
  await expect(tools.call("slice_cubes_to_block_grid", { parent: nested.uuid })).rejects.toThrow(/is rotated/);
  expect(undo.starts).toBe(0);
});

test("slice_cubes_to_block_grid keeps inflated cubes valid and can leave the hierarchy alone", async () => {
  const puffy = new HostCube("puffy", [0, 0, 0], [8, 20, 8]).init();
  puffy.inflate = 1;
  const result = structured(await tools.call("slice_cubes_to_block_grid", { regroup: false }));
  expect(result.groups).toEqual([]);
  expect(result.created_count).toBe(1);
  expect(puffy.to[1]).toBe(15);
  expect((result.pieces as Array<{ from: Vector3Tuple }>)[1].from[1]).toBe(17);
  expect(HostGroup.all).toHaveLength(0);
  expect(puffy.parent).toBe("root");
  expect(canvasAll).toBe(0);
  expect(canvasViews).toBe(1);
});

test("inspect_block_bounds reports limits, cells, and grid cuts without editing", async () => {
  const { pole, base } = buildGoal();
  const bone = new HostGroup({ name: "pole_bone", origin: [0, 0, 30] }).init();
  pole.addTo(bone);
  bone.rotation = [0, 0, 10];
  const result = structured(await tools.call("inspect_block_bounds", {}));

  expect(result.limits).toEqual({ max_size: 30, max_center_offset: 7, cell_size: 16, rotation_ignored: true });
  expect(result.fits_single_block).toBe(false);
  expect(result.model).toMatchObject({ min: [-14.8, 0, 18], max: [14.8, 64, 42], within_size_limit: false, within_center_offset: false, valid: false });
  const cubes = result.cubes as Array<Record<string, unknown>>;
  const poleReport = cubes.find(cube => cube.name === "pole");
  expect(poleReport).toMatchObject({ cell: [0, 2, 2], rotated: true, crosses_block_boundary: true, group: { uuid: bone.uuid, name: "pole_bone" } });
  expect(poleReport?.grid_cuts).toEqual({
    x: { aligned: false, positions: [] },
    y: { aligned: false, positions: [16, 32, 48] },
    z: { aligned: true, positions: [] },
  });
  expect(cubes.find(cube => cube.name === "base")).toMatchObject({ rotated: false, crosses_block_boundary: true });
  expect(cubes.find(cube => cube.name === "base")?.grid_cuts).toMatchObject({ x: { positions: [-8, 8] }, z: { positions: [24, 40] } });
  expect(result.groups).toEqual([{
    uuid: bone.uuid, name: "pole_bone", origin: [0, 0, 30], cube_count: 1,
    bounds: expect.objectContaining({ within_size_limit: false, valid: false }),
  }]);
  expect((result.cells as unknown[]).length).toBe(2);
  expect(undo.starts).toBe(0);
  expect(canvasViews).toBe(0);
  expect(base.to[1]).toBe(7.4);
});
