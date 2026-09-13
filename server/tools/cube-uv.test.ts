import { beforeAll, beforeEach, expect, test } from "bun:test";
import { getCubeUvParameters, setCubeUvParameters } from "./cube-uv";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
import { useGlobals } from "@/tests/helpers/globals";
import { createUndoHost } from "@/tests/helpers/undo-host";
import { isRecord } from "@/tests/helpers/assertions";

const directions = ["north", "east", "south", "west", "up", "down"] as const;
type Direction = typeof directions[number];
type UV = [number, number, number, number];
interface IFaceData { uv: UV; rotation: number; texture: string | false | null }
interface ICubeData { uuid: string; name: string; box_uv: boolean; uv_offset: number[]; mirror_uv: boolean; autouv: number; faces: Record<Direction, IFaceData> }
interface ITextureData { uuid: string; id: string; name: string; width: number; height: number; display_height: number; getUVWidth(): number; getUVHeight(): number }

let tools: IToolFixture;
let cubes: HostCube[];
let textures: ITextureData[];
let failRefresh: boolean;
let refreshes: number;
let declineUVMode: boolean;
let hytaleRemaps: number;
const selected: string[] = ["unrelated-cube"];
const format = { id: "free", optional_box_uv: true, uv_rotation: true, single_texture: false, per_group_texture: false };

class HostFace implements IFaceData {
  uv: UV = [0, 0, 8, 8];
  rotation = 0;
  texture: string | false | null = "texture-1";
  getTexture(): ITextureData | undefined | false | null {
    if (this.texture === null) return null;
    if (format.single_texture || format.per_group_texture || format.id.startsWith("hytale_")) return textures[0];
    return typeof this.texture === "string" ? textures.find(texture => texture.uuid === this.texture) : this.texture;
  }
}

class HostCube {
  uuid = "cube-1";
  name = "Head";
  box_uv = false;
  uv_offset = [0, 0];
  mirror_uv = false;
  autouv = 1;
  dimensions = [8, 12, 4];
  faces = Object.fromEntries(directions.map(direction => [direction, new HostFace()])) as Record<Direction, HostFace>;
  size(): number[] { return [...this.dimensions]; }
  setUVMode(box: boolean): void {
    if (declineUVMode) {
      this.autouv = 2;
      return;
    }
    this.box_uv = box;
  }
}

function data(cube: HostCube): ICubeData {
  return {
    uuid: cube.uuid, name: cube.name, box_uv: cube.box_uv,
    uv_offset: [...cube.uv_offset], mirror_uv: cube.mirror_uv, autouv: cube.autouv,
    faces: Object.fromEntries(directions.map(direction => {
      const face = cube.faces[direction];
      return [direction, { uv: [...face.uv], rotation: face.rotation, texture: face.texture }];
    })) as Record<Direction, IFaceData>,
  };
}

const undo = createUndoHost({
  snapshot: ({ elements, uv_only }: { elements: HostCube[]; uv_only: boolean }) => {
    expect(uv_only).toBe(true);
    return elements.map(data);
  },
  restore: (saved: ICubeData[]) => {
    saved.forEach(item => {
      const cube = cubes.find(candidate => candidate.uuid === item.uuid);
      if (!cube) throw new Error("Fixture cube missing");
      const { faces, ...properties } = structuredClone(item);
      Object.assign(cube, properties);
      directions.forEach(direction => Object.assign(cube.faces[direction], faces[direction]));
    });
  },
});

beforeAll(async () => {
  tools = await loadToolDefinitions({ entries: ["server/tools/cube-uv.ts"], register: ["registerCubeUvTools"] });
});

beforeEach(() => {
  cubes = [new HostCube()];
  textures = [{ uuid: "texture-1", id: "0", name: "skin", width: 256, height: 128, display_height: 64, getUVWidth: () => 64, getUVHeight: () => 32 }];
  Object.assign(format, { id: "free", optional_box_uv: true, uv_rotation: true, single_texture: false, per_group_texture: false });
  undo.reset();
  failRefresh = false;
  refreshes = 0;
  declineUVMode = false;
  hytaleRemaps = 0;
});

useGlobals(() => ({
  Project: { textures, texture_width: 16, texture_height: 16 },
  Format: format,
  Cube: { all: cubes, selected },
  Undo: {
    initEdit: undo.initEdit.bind(undo),
    cancelEdit: undo.cancelEdit.bind(undo),
    finishEdit: (label: string) => {
      // Hytale's native finish_edit hook rewrites all faces when Auto UV was disabled.
      // Dispatch happens before Undo captures the resulting state, as in Blockbench.
      if (format.id.startsWith("hytale_")) undo.pending?.aspects.elements.forEach(cube => {
        if (cube.autouv) return;
        hytaleRemaps++;
        cube.autouv = 1;
        directions.forEach(direction => { cube.faces[direction].uv = [99, 99, 100, 100]; });
      });
      return undo.finishEdit(label);
    },
  },
  Canvas: { updateView: () => { refreshes++; if (failRefresh) throw new Error("Preview failure"); } },
  UVEditor: { loadData: () => {} },
}));

async function inspect(id = "cube-1"): Promise<Record<string, unknown>> {
  const result = await tools.call("get_cube_uv", { id });
  if (!isRecord(result) || !isRecord(result.structuredContent) || !Array.isArray(result.content)) throw new Error("Invalid inspection result");
  const text = result.content[0];
  if (!isRecord(text) || typeof text.text !== "string") throw new Error("Missing JSON mirror");
  expect(JSON.parse(text.text)).toEqual(result.structuredContent);
  return result.structuredContent;
}

test("inspection distinguishes logical UV and bitmap dimensions without mutation", async () => {
  const before = cubes.map(data);
  const info = await inspect();
  if (!isRecord(info.faces) || !isRecord(info.faces.north)) throw new Error("Missing face");
  expect(info.faces.north).toMatchObject({ texture: "texture-1", texture_status: "resolved", uv_size: [64, 32], bitmap_size: [256, 128], frame_size: [256, 64] });
  expect(undo.starts).toBe(0);
  expect(refreshes).toBe(0);
  expect(cubes.map(data)).toEqual(before);
  const uv = info.faces.north.uv;
  if (!Array.isArray(uv)) throw new Error("Missing UV");
  uv[0] = 100;
  expect(cubes[0].faces.north.uv[0]).toBe(0);
});

test("explicit face patch preserves untargeted faces, accepts mirrors, and round-trips Undo/Redo", async () => {
  const before = data(cubes[0]);
  await tools.call("set_cube_uv", { id: "Head", faces: { north: { uv: [32, -2, 0, 14], rotation: 90, texture: "skin" } } });
  expect(cubes[0].faces.north).toMatchObject({ uv: [32, -2, 0, 14], rotation: 90, texture: "texture-1" });
  expect(cubes[0].autouv).toBe(0);
  expect(cubes[0].faces.south.uv).toEqual(before.faces.south.uv);
  expect(selected).toEqual(["unrelated-cube"]);
  expect(undo.history).toHaveLength(1);
  const after = data(cubes[0]);
  undo.undo();
  expect(data(cubes[0])).toEqual(before);
  undo.redo();
  expect(data(cubes[0])).toEqual(after);
});

test("box UV updates use explicit mode and round-trip offset/mirroring", async () => {
  await tools.call("set_cube_uv", { id: "cube-1", box_uv: true, uv_offset: [8, 12], mirror_uv: true });
  expect(cubes[0]).toMatchObject({ box_uv: true, uv_offset: [8, 12], mirror_uv: true });
  undo.undo();
  expect(cubes[0]).toMatchObject({ box_uv: false, uv_offset: [0, 0], mirror_uv: false });
  undo.redo();
  await tools.call("set_cube_uv", { id: "cube-1", box_uv: false, faces: { north: { uv: [1, 2, 3, 4] } } });
  expect(cubes[0].box_uv).toBe(false);
  expect(cubes[0].faces.north.uv).toEqual([1, 2, 3, 4]);
});

test.each([
  { input: { faces: { north: { uv: [0, 0, 4, 4] }, south: { texture: "missing" } } }, message: "not found" },
  { input: { uv_offset: [4, 4] }, message: "require box UV" },
  { input: { box_uv: true, faces: { north: { rotation: 90 } } }, message: "require per-face" },
  { input: { faces: { north: {} } }, message: "at least one" },
])("invalid mixed patch fails before Undo: $message", async ({ input, message }) => {
  const before = data(cubes[0]);
  await expect(tools.call("set_cube_uv", { id: "cube-1", ...input })).rejects.toThrow(message);
  expect(undo.starts).toBe(0);
  expect(data(cubes[0])).toEqual(before);
});

test("rejects unsupported mode changes, rotations and implicit texture overrides", async () => {
  format.optional_box_uv = false;
  format.uv_rotation = false;
  format.single_texture = true;
  await expect(tools.call("set_cube_uv", { id: "cube-1", box_uv: true })).rejects.toThrow("does not support changing");
  await expect(tools.call("set_cube_uv", { id: "cube-1", faces: { north: { rotation: 90 } } })).rejects.toThrow("does not support UV rotation");
  await expect(tools.call("set_cube_uv", { id: "cube-1", faces: { north: { texture: "skin" } } })).rejects.toThrow("project/group level");
  expect(undo.starts).toBe(0);
  await tools.call("set_cube_uv", { id: "cube-1", faces: { north: { texture: null } } });
  expect(cubes[0].faces.north.texture).toBeNull();
});

test("distinguishes disabled, unassigned, missing and effective format texture states", async () => {
  cubes[0].faces.north.texture = null;
  cubes[0].faces.south.texture = false;
  cubes[0].faces.east.texture = "missing";
  const info = await inspect();
  expect(info.faces).toMatchObject({ north: { texture_status: "disabled" }, south: { texture_status: "unassigned" }, east: { texture_status: "missing" } });
  format.single_texture = true;
  const effective = await inspect();
  expect(effective.faces).toMatchObject({ north: { texture_status: "disabled" }, south: { texture: false, texture_status: "resolved", effective_texture: { uuid: "texture-1" } } });
});

test("requires unambiguous identities, while exact UUID wins over a matching name", async () => {
  const other = new HostCube();
  other.uuid = "cube-2";
  cubes.push(other);
  await expect(inspect("Head")).rejects.toThrow("ambiguous");
  other.name = "cube-1";
  expect((await inspect()).uuid).toBe("cube-1");
  textures.push({ ...textures[0], uuid: "texture-2" });
  await expect(tools.call("set_cube_uv", { id: "cube-1", faces: { north: { texture: "skin" } } })).rejects.toThrow("ambiguous");
  expect(undo.starts).toBe(0);
});

test("host failure cancels and restores the complete UV patch", async () => {
  const before = data(cubes[0]);
  failRefresh = true;
  await expect(tools.call("set_cube_uv", { id: "cube-1", faces: { north: { uv: [1, 2, 3, 4], texture: false } } })).rejects.toThrow("Preview failure");
  expect(data(cubes[0])).toEqual(before);
  expect(undo.cancels).toBe(1);
  expect(undo.history).toHaveLength(0);
  expect(undo.pending).toBeUndefined();
});

test.each(["hytale_character", "hytale_prop"])("%s face offsets/mirrors retain native Auto UV without remapping other faces", async id => {
  format.id = id;
  const before = data(cubes[0]);
  await tools.call("set_cube_uv", { id: "cube-1", faces: { north: { uv: [32, -2, 24, 10] } } });
  expect(cubes[0].faces.north.uv).toEqual([32, -2, 24, 10]);
  expect(cubes[0].autouv).toBe(1);
  expect(hytaleRemaps).toBe(0);
  directions.filter(direction => direction !== "north").forEach(direction => {
    expect(cubes[0].faces[direction]).toMatchObject(before.faces[direction]);
  });
  expect(selected).toEqual(["unrelated-cube"]);
  expect(undo.history).toHaveLength(1);
  const after = data(cubes[0]);
  undo.undo();
  expect(data(cubes[0])).toEqual(before);
  undo.redo();
  expect(data(cubes[0])).toEqual(after);
});

test.each([
  { direction: "north", rotation: 0, uv: [2, 3, 10, 15] },
  { direction: "south", rotation: 90, uv: [2, 3, 14, 11] },
  { direction: "east", rotation: 180, uv: [2, 3, 6, 15] },
  { direction: "west", rotation: 270, uv: [2, 3, 14, 7] },
  { direction: "up", rotation: 90, uv: [2, 3, 6, 11] },
  { direction: "down", rotation: 0, uv: [10, 7, 2, 3] },
])("Hytale $direction uses absolute face dimensions at rotation $rotation", async ({ direction, rotation, uv }) => {
  format.id = "hytale_prop";
  cubes[0].dimensions = [-8, 12, -4];
  await tools.call("set_cube_uv", { id: "cube-1", faces: { [direction]: { uv, rotation } } });
  expect(cubes[0].faces[direction as Direction]).toMatchObject({ uv, rotation });
  expect(hytaleRemaps).toBe(0);
});

test.each([
  { patch: { uv: [0, 0, 8, 8] }, expected: "8x12" },
  { patch: { rotation: 90 }, expected: "12x8" },
  { patch: { rotation: 270, uv: [0, 0, 8, 12] }, expected: "12x8" },
])("Hytale rejects incompatible rectangles/rotation before Undo ($expected)", async ({ patch, expected }) => {
  format.id = "hytale_character";
  cubes[0].faces.north.uv = [0, 0, 8, 12];
  const before = data(cubes[0]);
  await expect(tools.call("set_cube_uv", { id: "cube-1", faces: { north: patch } })).rejects.toThrow(`UV extents ${expected}`);
  expect(undo.starts).toBe(0);
  expect(data(cubes[0])).toEqual(before);
});

test("Hytale permits a rotation-only patch when extents already match", async () => {
  format.id = "hytale_prop";
  cubes[0].faces.north.uv = [0, 0, 8, 12];
  await tools.call("set_cube_uv", { id: "cube-1", faces: { north: { rotation: 180 } } });
  expect(cubes[0].faces.north).toMatchObject({ uv: [0, 0, 8, 12], rotation: 180 });
  expect(hytaleRemaps).toBe(0);
});

test("Hytale rejects per-face texture overrides even when attachment collections disable single_texture", async () => {
  format.id = "hytale_character";
  format.single_texture = false;
  const before = data(cubes[0]);
  await expect(tools.call("set_cube_uv", { id: "cube-1", faces: { north: { texture: "skin" } } })).rejects.toThrow("Hytale attachment collections");
  await expect(tools.call("set_cube_uv", { id: "cube-1", faces: { north: { texture: false } } })).rejects.toThrow("Hytale attachment collections");
  expect(undo.starts).toBe(0);
  expect(data(cubes[0])).toEqual(before);
  await tools.call("set_cube_uv", { id: "cube-1", faces: { north: { texture: null } } });
  expect(cubes[0].faces.north.texture).toBeNull();
  undo.undo();
  expect(data(cubes[0])).toEqual(before);
});

test("Hytale quads reject box UV before Undo but accept a matching rotated face rectangle", async () => {
  format.id = "hytale_prop";
  cubes[0].dimensions = [8, 12, 0];
  directions.filter(direction => direction !== "north").forEach(direction => { cubes[0].faces[direction].texture = null; });
  const before = data(cubes[0]);
  await expect(tools.call("set_cube_uv", { id: "cube-1", box_uv: true })).rejects.toThrow("quads cannot use box UV");
  expect(undo.starts).toBe(0);
  expect(data(cubes[0])).toEqual(before);
  await tools.call("set_cube_uv", { id: "cube-1", faces: { north: { uv: [4, 5, 16, 13], rotation: 90 } } });
  expect(cubes[0].faces.north).toMatchObject({ uv: [4, 5, 16, 13], rotation: 90 });
  expect(cubes[0].box_uv).toBe(false);
  expect(hytaleRemaps).toBe(0);
});

test("Hytale rejects non-finite cube dimensions before Undo", async () => {
  format.id = "hytale_prop";
  cubes[0].dimensions[1] = Infinity;
  await expect(tools.call("set_cube_uv", { id: "cube-1", faces: { north: { uv: [0, 0, 8, 12] } } })).rejects.toThrow("finite cube dimensions");
  expect(undo.starts).toBe(0);
});

test("a native UV mode refusal rolls back its partial changes and reports failure", async () => {
  declineUVMode = true;
  const before = data(cubes[0]);
  await expect(tools.call("set_cube_uv", { id: "cube-1", box_uv: true, uv_offset: [4, 8] })).rejects.toThrow("native format declined");
  expect(data(cubes[0])).toEqual(before);
  expect(undo.cancels).toBe(1);
  expect(undo.history).toHaveLength(0);
  expect(undo.pending).toBeUndefined();
  expect(refreshes).toBe(0);
});

test("schemas reject malformed faces, non-finite coordinates and invalid rotations", () => {
  expect(getCubeUvParameters.safeParse({ id: "" }).success).toBe(false);
  [{ faces: { nort: { uv: [0, 0, 1, 1] } } }, { uv_offset: [Infinity, 0] }, { faces: { north: { rotation: 45 } } }, { faces: { north: { uv: [0, 0, 1] } } }].forEach(input => {
    expect(setCubeUvParameters.safeParse({ id: "cube-1", ...input }).success).toBe(false);
  });
});
