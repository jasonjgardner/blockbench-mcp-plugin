import { describe, expect, test } from "bun:test";
import { Euler, Matrix4 } from "three";
import { creatureModel } from "../test-fixtures";
import { applyOperations, operationSchema } from "../edit/operations";
import { isCube, type IKeyframe, type Vec3 } from "../document/schema";
import { indexModel } from "../document/tree";
import { boxUvSize, computeBoxUv } from "./box-uv";
import { elementBoxes } from "./bounds";
import { eulerZYX, mulVec } from "./math";
import { emptySamplingNotes, sampleChannel, samplePose } from "./pose";

const DEG = Math.PI / 180;

describe("eulerZYX", () => {
  test.each([
    [[30, 0, 0]],
    [[0, 45, 0]],
    [[0, 0, -60]],
    [[22.5, -40, 75]],
  ] as [Vec3][])("matches three.js Euler order ZYX for %p", (angles) => {
    const three = new Matrix4().makeRotationFromEuler(new Euler(angles[0] * DEG, angles[1] * DEG, angles[2] * DEG, "ZYX"));
    const point: Vec3 = [1.5, -2, 3];
    const ours = mulVec(eulerZYX(angles), point);
    const e = three.elements;
    const expected = [e[0] * 1.5 + e[4] * -2 + e[8] * 3, e[1] * 1.5 + e[5] * -2 + e[9] * 3, e[2] * 1.5 + e[6] * -2 + e[10] * 3];
    ours.forEach((value, i) => expect(value).toBeCloseTo(expected[i] ?? NaN, 10));
  });
});

describe("box UV (port of Cube.preview_controller.updateUV)", () => {
  test("lays out a 4×8×2 cube like Blockbench", () => {
    const uv = computeBoxUv(boxUvSize([0, 0, 0], [4, 8, 2]), [0, 0]);
    expect(uv.east).toEqual([0, 2, 2, 10]);
    expect(uv.north).toEqual([2, 2, 6, 10]);
    expect(uv.west).toEqual([6, 2, 8, 10]);
    expect(uv.south).toEqual([8, 2, 12, 10]);
    expect(uv.up).toEqual([6, 2, 2, 0]);
    expect(uv.down).toEqual([10, 0, 6, 2]);
  });

  test("mirroring flips faces and swaps east/west; offset shifts everything", () => {
    const uv = computeBoxUv(boxUvSize([0, 0, 0], [4, 8, 2]), [16, 32], true);
    expect(uv.east).toEqual([24, 34, 22, 42]);
    expect(uv.west).toEqual([18, 34, 16, 42]);
    expect(uv.north).toEqual([22, 34, 18, 42]);
  });

  test("sizes are floored unless the format allows float sizes", () => {
    expect(boxUvSize([0, 0, 0], [1.5, 2.9999999, 3])).toEqual([1, 3, 3]);
    expect(boxUvSize([0, 0, 0], [1.5, 2, 3], true)).toEqual([1.5, 2, 3]);
  });
});

describe("world bounds", () => {
  test("group rotation moves child cubes about the group origin", () => {
    const base = creatureModel();
    const ops = operationSchema.array().parse([{ op: "update_node", target: "head", rotation: [0, 90, 0] }]);
    const doc = applyOperations(base, ops).doc;
    const index = indexModel(doc);
    const skull = doc.elements.find((element) => element.name === "skull");
    const box = skull ? elementBoxes(doc, index).get(skull.uuid) : undefined;
    // skull spans x -3..3, z -11..-6 about pivot (0, 10, -6); +90° about Y maps (x, z) offsets to (z, -x).
    expect(box?.min.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([-5, 8, -9]);
    expect(box?.max.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 13, -3]);
  });

  test("cube rotation and inflate enlarge the box", () => {
    const doc = applyOperations(creatureModel(), operationSchema.array().parse([
      { op: "add_cube", name: "tilted", from: [-1, 20, -1], to: [1, 22, 1], rotation: [0, 45, 0], inflate: 0.5 },
    ])).doc;
    const tilted = doc.elements.find((element) => element.name === "tilted");
    const box = tilted ? elementBoxes(doc, indexModel(doc)).get(tilted.uuid) : undefined;
    expect(box?.max[0]).toBeCloseTo(1.5 * Math.SQRT2, 10);
    expect(box?.min[1]).toBeCloseTo(19.5, 10);
  });

  test("new box-UV cubes get Blockbench's layout", () => {
    const doc = applyOperations(creatureModel(), operationSchema.array().parse([
      { op: "add_cube", name: "boxed", from: [0, 0, 0], to: [4, 8, 2], box_uv: true, uv_offset: [0, 0] },
    ])).doc;
    const boxed = doc.elements.find((element) => element.name === "boxed");
    expect(boxed && isCube(boxed) ? boxed.faces.north?.uv : undefined).toEqual([2, 2, 6, 10]);
  });
});

describe("pose sampling", () => {
  const key = (time: number, x: number, interpolation = "linear"): IKeyframe => ({
    uuid: crypto.randomUUID(),
    channel: "rotation",
    time,
    data_points: [{ x: String(x), y: "0", z: "0" }],
    interpolation,
  });

  test("linear, step and clamping", () => {
    const keys = [key(0, 0), key(1, 10)];
    expect(sampleChannel(keys, "rotation", 0.25)?.[0]).toBeCloseTo(2.5);
    expect(sampleChannel(keys, "rotation", 2)?.[0]).toBe(10);
    expect(sampleChannel([key(0, 0, "step"), key(1, 10)], "rotation", 0.9)?.[0]).toBe(0);
  });

  test("catmull-rom passes through its keys", () => {
    const keys = [key(0, 0, "catmullrom"), key(1, 10, "catmullrom"), key(2, 0, "catmullrom")];
    expect(sampleChannel(keys, "rotation", 1)?.[0]).toBeCloseTo(10);
    expect(sampleChannel(keys, "rotation", 0.5)?.[0]).toBeGreaterThan(5);
  });

  test("Molang expressions make a channel unsampleable and are reported", () => {
    const doc = creatureModel(true);
    const animation = doc.animations?.[0];
    if (!animation) throw new Error("fixture has no animation");
    const [boneId, animator] = Object.entries(animation.animators)[0] ?? [];
    if (!boneId || !animator) throw new Error("fixture has no animator");
    const withMolang = { ...animation, animators: { ...animation.animators, [boneId]: { ...animator, keyframes: [{ ...key(0, 0), data_points: [{ x: "math.sin(q.anim_time)", y: "0", z: "0" }] }] } } };
    const notes = emptySamplingNotes();
    samplePose(withMolang, 0.5, notes);
    expect(notes.skippedChannels).toHaveLength(1);
  });
});
