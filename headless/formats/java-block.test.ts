import { describe, expect, test } from "bun:test";
import { applyOperations, operationSchema } from "../edit/operations";
import { type IBBModel, isCube } from "../document/schema";
import { emptyModel } from "../tools/edit";
import { compileJavaBlockModel, importJavaBlockModel } from "./java-block";

/** A stairs-like block model as Blockbench 1.21.6 would write it. */
const STAIRS = {
  format_version: "1.21.6",
  credit: "Made with Blockbench",
  parent: "block/block",
  textures: {
    bottom: "block/oak_planks",
    top: "block/oak_planks_top",
    side: "block/oak_planks_side",
    particle: "block/oak_planks_side",
  },
  elements: [
    {
      from: [0, 0, 0],
      to: [16, 8, 16],
      faces: {
        north: { uv: [0, 8, 16, 16], texture: "#side", cullface: "north" },
        east: { uv: [0, 8, 16, 16], texture: "#side", cullface: "east" },
        south: { uv: [0, 8, 16, 16], texture: "#side", cullface: "south" },
        west: { uv: [0, 8, 16, 16], texture: "#side", cullface: "west" },
        up: { uv: [0, 0, 16, 16], texture: "#top", tintindex: 0 },
        down: { uv: [0, 0, 16, 16], texture: "#bottom", cullface: "down" },
      },
    },
    {
      name: "step",
      from: [8, 8, 0],
      to: [16, 16, 16],
      rotation: { angle: 22.5, axis: "y", origin: [8, 8, 8], rescale: true },
      faces: {
        north: { uv: [0, 0, 8, 8], texture: "#side", cullface: "north" },
        east: { uv: [0, 0, 16, 8], texture: "#side", rotation: 90 },
        south: { uv: [8, 0, 16, 8], texture: "#side", cullface: "south" },
        up: { uv: [8, 0, 16, 16], texture: "#top", cullface: "up", tintindex: 0 },
      },
    },
  ],
  display: {
    thirdperson_righthand: { rotation: [75, -135, 0], translation: [0, 2.5, 0], scale: [0.375, 0.375, 0.375] },
    gui: { rotation: [30, 135, 0], scale: [0.625, 0.625, 0.625] },
    head: { rotation: [0, -90, 0] },
  },
  groups: [
    { name: "stairs", origin: [8, 8, 8], scope: 0, color: 0, children: [0, { name: "upper", origin: [8, 8, 8], scope: 0, color: 1, children: [1] }] },
  ],
};

const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** Minimal PNG header (signature + IHDR size) that `pngSize` can read. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("importJavaBlockModel (port of the java_block codec's parse)", () => {
  test("builds a 5.0 java_block document with cubes, textures, groups and display", () => {
    const { doc } = importJavaBlockModel(STAIRS);
    expect(doc.meta.model_format).toBe("java_block");
    expect((doc as Record<string, unknown>).java_block_version).toBe("1.21.6");
    expect((doc as Record<string, unknown>).parent).toBe("block/block");
    expect(doc.textures.map((texture) => [texture.id, texture.name, texture.folder, texture.particle])).toEqual([
      ["bottom", "oak_planks.png", "block", false],
      ["top", "oak_planks_top.png", "block", false],
      ["side", "oak_planks_side.png", "block", true],
    ]);
    const cubes = doc.elements.filter(isCube);
    expect(cubes.map((cube) => cube.name)).toEqual(["cube", "step"]);
    const step = cubes[1];
    expect(step?.rotation).toEqual([0, 22.5, 0]);
    expect(step?.origin).toEqual([8, 8, 8]);
    expect((step as Record<string, unknown>).rescale).toBe(true);
    expect(step?.faces.west).toEqual({ uv: [0, 0, 0, 0], texture: null });
    expect(step?.faces.up).toMatchObject({ texture: 1, tint: 0, cullface: "up" });
    expect(doc.groups.map((group) => group.name)).toEqual(["stairs", "upper"]);
    expect(doc.outliner).toEqual([{ uuid: doc.groups[0]?.uuid, isOpen: false, children: [cubes[0]?.uuid, { uuid: doc.groups[1]?.uuid, isOpen: false, children: [step?.uuid] }] }]);
  });

  test("scales face UVs to texture_size and wraps display rotations like DisplaySlot.extend", () => {
    const { doc } = importJavaBlockModel({
      texture_size: [32, 64],
      textures: { all: "custom:block/lamp" },
      elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { north: { uv: [0, 0, 8, 8], texture: "#all" } } }],
      display: { gui: { rotation: [30, 225, 0], scale: [-1, 1, 1] } },
    });
    expect(doc.resolution).toEqual({ width: 32, height: 64 });
    expect(doc.elements.filter(isCube)[0]?.faces.north?.uv).toEqual([0, 0, 16, 32]);
    expect(doc.textures[0]).toMatchObject({ namespace: "custom", folder: "block", name: "lamp.png", path: "assets/custom/textures/block/lamp.png" });
    expect((doc as Record<string, unknown>).display).toEqual({ gui: { rotation: [30, -135, 0], scale: [-1, 1, 1] } });
  });

  test("embeds PNG pixels found by resolveTexture, relative to the resource pack", () => {
    const seen: string[] = [];
    const { doc, notes } = importJavaBlockModel(
      { textures: { all: "block/stone" }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { uv: [0, 0, 16, 16], texture: "#all" } } }] },
      {
        modelPath: "C:/packs/demo/assets/minecraft/models/block/stone.json",
        resolveTexture: (path) => {
          seen.push(path);
          return pngHeader(16, 32);
        },
      },
    );
    expect(seen).toEqual(["C:/packs/demo/assets/minecraft/textures/block/stone.png"]);
    expect(doc.name).toBe("stone");
    expect(doc.textures[0]).toMatchObject({ width: 16, height: 32, internal: true });
    expect(doc.textures[0]?.source?.startsWith("data:image/png;base64,")).toBe(true);
    expect(notes.some((note) => note.includes("path-linked"))).toBe(false);
  });

  test("resolves element-less child models through their parents and auto-maps missing UVs", () => {
    const parents: Record<string, unknown> = {
      "assets/minecraft/models/block/cube_all.json": { parent: "block/cube", textures: { particle: "#all", north: "#all" } },
      "assets/minecraft/models/block/cube.json": JSON.stringify({ elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { north: { texture: "#north" } } }] }),
    };
    const { doc, notes } = importJavaBlockModel({ parent: "block/cube_all", textures: { all: "block/stone" } }, { resolveParent: (path) => parents[path] });
    expect(notes[0]).toContain("Merged 2 parent model(s)");
    expect((doc as Record<string, unknown>).parent).toBe("block/cube_all");
    const cube = doc.elements.filter(isCube)[0];
    expect((cube as Record<string, unknown>).autouv).toBe(2);
    expect(cube?.faces.north?.uv).toEqual([0, 0, 16, 16]);
    expect(doc.textures.map((texture) => texture.id)).toEqual(["all"]);
    expect(doc.textures[0]?.particle).toBe(true);
    expect(cube?.faces.north?.texture).toBe(0);
  });

  test("rejects JSON that is not a block model", () => {
    expect(() => importJavaBlockModel({ format_version: "1.12.0" })).toThrow("Not a Java block/item model");
  });

  test("x/y/z rotations raise the Java block version to 1.21.11", () => {
    const { doc, notes } = importJavaBlockModel({
      format_version: "1.21.6",
      elements: [{ from: [0, 0, 0], to: [4, 4, 4], rotation: { x: 10, y: 60, origin: [2, 2, 2] }, faces: { up: { uv: [0, 0, 4, 4] } } }],
    });
    expect((doc as Record<string, unknown>).java_block_version).toBe("1.21.11");
    expect(doc.elements.filter(isCube)[0]?.rotation).toEqual([10, 60, 0]);
    expect(notes.some((note) => note.includes("1.21.11"))).toBe(true);
  });
});

describe("compileJavaBlockModel (port of the java_block codec's compile)", () => {
  test("round trip: compile(import(json)) reproduces the model", () => {
    const { model, notes } = compileJavaBlockModel(importJavaBlockModel(STAIRS).doc);
    expect(notes).toEqual([]);
    expect(asJson(model)).toEqual(STAIRS);
  });

  test("round trip: import(compile(doc)) keeps geometry, pivots and UVs", () => {
    const doc = applyOperations(emptyModel("java_block", "lamp", false, { width: 16, height: 16 }), operationSchema.array().parse([
      { op: "add_group", name: "post", origin: [8, 0, 8] },
      { op: "add_cube", name: "base", from: [4, 0, 4], to: [12, 2, 12], parent: "post" },
      { op: "add_cube", name: "pole", from: [7, 2, 7], to: [9, 14, 9], origin: [8, 2, 8], rotation: [0, 0, 22.5], parent: "post" },
      { op: "add_cube", name: "loose", from: [0, 0, 0], to: [1, 1, 1] },
    ])).doc;
    const back = importJavaBlockModel(compileJavaBlockModel(doc).model).doc;
    const shape = (model: IBBModel): unknown[] => model.elements.filter(isCube).map((cube) => ({
      name: cube.name, from: cube.from, to: cube.to, origin: cube.origin, rotation: cube.rotation ?? [0, 0, 0],
      uv: Object.fromEntries(Object.entries(cube.faces).map(([key, face]) => [key, face.uv])),
    }));
    expect(shape(back)).toEqual(shape(doc));
    expect(back.groups.map((group) => [group.name, group.origin])).toEqual([["post", [8, 0, 8]]]);
  });

  test("rotation style follows java_block_version", () => {
    const base = emptyModel("java_block", "rot", false, { width: 16, height: 16 });
    const withCube = (version: string, rotation: [number, number, number]): IBBModel => applyOperations(
      { ...base, java_block_version: version } as IBBModel,
      operationSchema.array().parse([{ op: "add_cube", name: "c", from: [0, 0, 0], to: [4, 4, 4], origin: [2, 2, 2], rotation }]),
    ).doc;
    const rotationOf = (doc: IBBModel): unknown => (compileJavaBlockModel(doc).model.elements as Record<string, unknown>[])[0]?.rotation;
    expect(rotationOf(withCube("26.3", [10, 60, 0]))).toEqual({ x: 10, y: 60, z: 0, origin: [2, 2, 2] });
    expect(rotationOf(withCube("26.3", [0, 30, 0]))).toEqual({ angle: 30, axis: "y", origin: [2, 2, 2] });
    expect(rotationOf(withCube("1.9.0", [0, 30, 0]))).toEqual({ angle: 22.5, axis: "y", origin: [2, 2, 2] });
    const limited = compileJavaBlockModel(withCube("1.21.6", [10, 20, 0]));
    const element = (limited.model.elements as Record<string, unknown>[])[0];
    expect(element?.rotation).toEqual({ angle: 10, axis: "x", origin: [2, 2, 2] });
    expect(element?.rotated).toEqual([10, 20, 0]);
    expect(limited.notes.some((note) => note.includes("rotates on 2 axes"))).toBe(true);
  });

  test("bakes inflate, drops disabled faces, marks untextured faces #missing, skips meshes", () => {
    const doc = applyOperations(emptyModel("java_block", "misc", false, { width: 32, height: 32 }), operationSchema.array().parse([
      { op: "add_cube", name: "puffy", from: [0, 0, 0], to: [4, 4, 4], origin: [0, 0, 0], inflate: 1 },
    ])).doc;
    const cube = doc.elements.filter(isCube)[0];
    const withFaces: IBBModel = {
      ...doc,
      elements: [
        { ...cube, faces: { ...cube?.faces, down: { uv: [0, 0, 8, 8], texture: null } } } as IBBModel["elements"][number],
        { uuid: "mesh-1", name: "blob", type: "mesh", origin: [0, 0, 0], vertices: { a: [0, 0, 0] }, faces: {} } as IBBModel["elements"][number],
      ],
      outliner: [cube?.uuid ?? "", "mesh-1"],
    };
    const { model, notes } = compileJavaBlockModel(withFaces);
    const [element] = model.elements as Record<string, unknown>[];
    expect(model.texture_size).toEqual([32, 32]);
    expect(element?.from).toEqual([-1, -1, -1]);
    expect(element?.to).toEqual([5, 5, 5]);
    expect(Object.keys(element?.faces ?? {})).toEqual(["north", "east", "south", "west", "up"]);
    expect((element?.faces as Record<string, Record<string, unknown>>).north?.texture).toBe("#missing");
    expect(notes.some((note) => note.includes("blob (mesh)"))).toBe(true);
    expect(notes.some((note) => note.includes("inflate 1 was baked"))).toBe(true);
  });
});
