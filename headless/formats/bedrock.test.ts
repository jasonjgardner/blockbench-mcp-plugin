import { describe, expect, test } from "bun:test";
import { creatureModel } from "../test-fixtures";
import { applyOperations, operationSchema } from "../edit/operations";
import { bedrockFormatVersion, compileBedrockGeometry } from "./bedrock";

/** JSON round trip, so -0 from X negation compares as 0 the way it is written to disk. */
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("compileBedrockGeometry (port of Blockbench's bedrock codec)", () => {
  test("mirrors X, keeps hierarchy, and flips up/down UVs", () => {
    const { geometry, skipped } = compileBedrockGeometry(creatureModel(), { identifier: "creature" });
    const [model] = asJson(geometry["minecraft:geometry"]) as { description: Record<string, unknown>; bones: Record<string, unknown>[] }[];
    expect(skipped).toEqual([]);
    expect(model?.description.identifier).toBe("geometry.creature");
    expect(model?.bones.map((bone) => [bone.name, bone.parent ?? null])).toEqual([
      ["body", null],
      ["head", "body"],
      ["leg_front_l", "body"],
      ["leg_front_r", "body"],
      ["leg_back_l", "body"],
      ["leg_back_r", "body"],
    ]);
    const legFrontL = model?.bones.find((bone) => bone.name === "leg_front_l") as { pivot: number[]; cubes: { origin: number[]; size: number[]; uv: Record<string, { uv: number[]; uv_size: number[] }> }[] };
    expect(legFrontL.pivot).toEqual([-3, 6, -4]);
    expect(legFrontL.cubes[0]?.origin).toEqual([-4, 0, -5]);
    expect(legFrontL.cubes[0]?.size).toEqual([2, 6, 2]);
    expect(legFrontL.cubes[0]?.uv.up).toEqual({ uv: [2, 2], uv_size: [-2, -2] });
    expect(legFrontL.cubes[0]?.uv.north).toEqual({ uv: [0, 0], uv_size: [2, 6] });
  });

  test("rotated cubes get a mirrored pivot and negated X/Y rotation; root cubes go to bb_main", () => {
    const doc = applyOperations(creatureModel(), operationSchema.array().parse([
      { op: "add_cube", name: "fin", from: [1, 12, 0], to: [2, 15, 3], origin: [1.5, 12, 1.5], rotation: [10, 20, 30] },
    ])).doc;
    const [model] = asJson(compileBedrockGeometry(doc).geometry["minecraft:geometry"]) as { bones: { name: string; cubes?: Record<string, unknown>[] }[] }[];
    const main = model?.bones[0];
    expect(main?.name).toBe("bb_main");
    expect(main?.cubes?.[0]).toMatchObject({ origin: [-2, 12, 0], pivot: [-1.5, 12, 1.5], rotation: [-10, -20, 30] });
  });

  test("box-UV cubes export uv_offset and picks the Blockbench format version", () => {
    const doc = applyOperations({ ...creatureModel(), meta: { format_version: "5.0", model_format: "bedrock", box_uv: true } }, operationSchema.array().parse([
      { op: "add_cube", name: "tail", from: [-1, 8, 6], to: [1, 10, 10], parent: "body", uv_offset: [32, 0] },
    ])).doc;
    const [model] = asJson(compileBedrockGeometry(doc).geometry["minecraft:geometry"]) as { bones: { name: string; cubes?: { uv: unknown }[] }[] }[];
    expect(model?.bones.find((bone) => bone.name === "body")?.cubes?.[1]?.uv).toEqual([32, 0]);
    expect(bedrockFormatVersion(doc)).toBe("1.12.0");
  });
});
