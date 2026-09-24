import { describe, expect, test } from "bun:test";
import { applyOperations, operationSchema } from "../edit/operations";
import type { IBBModel } from "../document/schema";
import { emptyModel } from "../tools/edit";
import { checkElements, formatCapabilities } from "./rules";

const MESH = { uuid: "mesh-1", name: "blob", type: "mesh", origin: [0, 0, 0], vertices: { a: [0, 0, 0], b: [1, 0, 0], c: [0, 1, 0] }, faces: {} } as IBBModel["elements"][number];

/** A document in `format` holding the given cubes plus a mesh. */
function modelWith(format: string, cubes: Record<string, unknown>[], extra: Record<string, unknown> = {}): IBBModel {
  const doc = applyOperations({ ...emptyModel(format, "test", false, { width: 16, height: 16 }), ...extra } as IBBModel, operationSchema.array().parse(cubes)).doc;
  return { ...doc, elements: [...doc.elements, MESH], outliner: [...doc.outliner, "mesh-1"] };
}

const rulesOf = (doc: IBBModel): [string, string][] => checkElements(doc).map((violation) => [violation.name, violation.rule]);

describe("formatCapabilities", () => {
  test("java_block rotation rules follow java_block_version", () => {
    expect(formatCapabilities("java_block")).toMatchObject({ rotation_limit: false, rotation_snap: false, cube_size_limiter: "java_block", meshes: false, bone_rig: false });
    const old = emptyModel("java_block", "", false, { width: 16, height: 16 });
    expect(formatCapabilities("java_block", { ...old, java_block_version: "1.21.6" } as IBBModel)).toMatchObject({ rotation_limit: true, rotation_snap: false });
    expect(formatCapabilities("java_block", { ...old, java_block_version: "1.9.0" } as IBBModel)).toMatchObject({ rotation_limit: true, rotation_snap: true });
  });

  test("box UV modes and unknown formats", () => {
    expect(formatCapabilities("skin")?.box_uv_mode).toBe("forced_box");
    expect(formatCapabilities("modded_entity")?.box_uv_mode).toBe("forced_box");
    expect(formatCapabilities("bedrock")?.box_uv_mode).toBe("optional");
    expect(formatCapabilities("some_plugin_format")).toBeUndefined();
  });
});

describe("checkElements", () => {
  const javaCubes = [
    { op: "add_cube", name: "ok", from: [0, 0, 0], to: [16, 8, 16] },
    { op: "add_cube", name: "tilted", from: [4, 4, 4], to: [8, 8, 8], rotation: [0, 30, 0] },
    { op: "add_cube", name: "two_axes", from: [4, 4, 4], to: [8, 8, 8], rotation: [22.5, 22.5, 0] },
    { op: "add_cube", name: "steep", from: [4, 4, 4], to: [8, 8, 8], rotation: [0, 0, 60] },
    { op: "add_cube", name: "huge", from: [-20, 0, 0], to: [8, 8, 8] },
    { op: "add_cube", name: "puffy", from: [30, 0, 0], to: [32, 2, 2], inflate: 0.5 },
  ];

  test("java_block 1.9.0: snap, single axis, ±45°, -16…32 bounds, inflate and meshes", () => {
    const doc = modelWith("java_block", javaCubes, { java_block_version: "1.9.0" });
    expect(rulesOf(doc)).toEqual([
      ["tilted", "rotation_snap"],
      ["two_axes", "rotation_axes"],
      ["steep", "rotation_angle"],
      ["steep", "rotation_snap"],
      ["huge", "cube_bounds"],
      ["puffy", "cube_bounds"],
      ["puffy", "inflate"],
      ["blob", "element_type"],
    ]);
    const twoAxes = checkElements(doc).find((violation) => violation.rule === "rotation_axes");
    expect(twoAxes?.message).toContain("1.21.11");
  });

  test("java_block 1.21.6 allows any angle within ±45° on one axis", () => {
    expect(rulesOf(modelWith("java_block", javaCubes, { java_block_version: "1.21.6" })).filter(([, rule]) => rule.startsWith("rotation"))).toEqual([
      ["two_axes", "rotation_axes"],
      ["steep", "rotation_angle"],
    ]);
  });

  test("java_block 26.3 (the default) allows free rotation but keeps bounds and element types", () => {
    expect(rulesOf(modelWith("java_block", javaCubes))).toEqual([
      ["huge", "cube_bounds"],
      ["puffy", "cube_bounds"],
      ["puffy", "inflate"],
      ["blob", "element_type"],
    ]);
  });

  test("only the requested elements are checked; java groups cannot rotate", () => {
    const doc = applyOperations(emptyModel("java_block", "g", false, { width: 16, height: 16 }), operationSchema.array().parse([
      { op: "add_group", name: "folder", origin: [8, 8, 8], rotation: [0, 45, 0] },
      { op: "add_cube", name: "huge", from: [-20, 0, 0], to: [8, 8, 8], parent: "folder" },
    ])).doc;
    const group = doc.groups[0];
    expect(checkElements(doc, [group?.uuid ?? ""]).map((violation) => violation.rule)).toEqual(["group_rotation"]);
    expect(checkElements(doc).map((violation) => violation.rule)).toEqual(["cube_bounds", "group_rotation"]);
  });

  test("bedrock refuses meshes but allows rotation on any axis", () => {
    const doc = modelWith("bedrock", [{ op: "add_cube", name: "spin", from: [0, 0, 0], to: [4, 4, 4], rotation: [10, 70, 5] }]);
    expect(rulesOf(doc)).toEqual([["blob", "element_type"]]);
    expect(checkElements(doc)[0]?.message).toContain("Rebuild it from cubes");
  });

  test("free allows meshes and anything else", () => {
    expect(checkElements(modelWith("free", javaCubes))).toEqual([]);
  });

  test("forced box UV, integer sizes and unrotatable skin cubes", () => {
    const doc = applyOperations(emptyModel("skin", "s", true, { width: 64, height: 64 }), operationSchema.array().parse([
      { op: "add_cube", name: "arm", from: [0, 0, 0], to: [4, 12.5, 4], rotation: [0, 0, 10] },
      { op: "add_cube", name: "flat", from: [0, 0, 0], to: [4, 4, 4], box_uv: false },
    ])).doc;
    expect(rulesOf(doc)).toEqual([["arm", "cube_rotation"], ["arm", "integer_size"], ["flat", "box_uv"]]);
  });

  test("bedrock_block flags geometry outside the 30-unit block box", () => {
    const doc = modelWith("bedrock_block", [{ op: "add_cube", name: "tower", from: [-4, 0, -4], to: [4, 40, 4] }]);
    expect(rulesOf(doc)).toEqual([["blob", "element_type"], ["tower", "block_bounds"]]);
  });

  test("unknown formats report nothing", () => {
    expect(checkElements(modelWith("some_plugin_format", javaCubes))).toEqual([]);
  });
});
