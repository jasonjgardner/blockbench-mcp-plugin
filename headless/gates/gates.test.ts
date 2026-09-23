import { describe, expect, test } from "bun:test";
import { creatureModel } from "../test-fixtures";
import { applyOperations, operationSchema } from "../edit/operations";
import type { IBBModel } from "../document/schema";
import { runAnimationGates } from "./animation";
import { GEOMETRY_GATE_IDS, mirrorName, runGeometryGates, sideOf } from "./geometry";
import { selfTestGeometryGates } from "./inject";

const edit = (doc: IBBModel, operations: unknown[]): IBBModel => applyOperations(doc, operationSchema.array().parse(operations)).doc;
const violations = (doc: IBBModel, gate: (typeof GEOMETRY_GATE_IDS)[number], options = {}) => runGeometryGates(doc, options, [gate])[0]?.violations ?? [];

describe("side names", () => {
  test.each([
    ["leg_l", "left", "leg_r"],
    ["Left Wing", "left", "Right Wing"],
    ["arm.R", "right", "arm.L"],
    ["LEFT_EAR", "left", "RIGHT_EAR"],
    ["torso", undefined, "torso"],
    ["lid", undefined, "lid"],
  ])("%s", (name, side, mate) => {
    expect(sideOf(name)).toBe(side as "left" | "right" | undefined);
    expect(mirrorName(name)).toBe(mate);
  });
});

describe("geometry gates on a clean model", () => {
  test("report nothing", () => {
    const results = runGeometryGates(creatureModel(), { blockLimits: "none" });
    const found = results.flatMap((result) => result.violations.map((violation) => `${result.id}: ${violation.message}`));
    expect(found).toEqual([]);
    expect(results.find((result) => result.id === "mirror")?.ran).toBe(true);
  });
});

describe("geometry gates catch planted defects", () => {
  test("floating part", () => {
    const doc = edit(creatureModel(), [{ op: "update_node", target: "skull", from: [-3, 8, -12.5], to: [3, 13, -7.5] }]);
    expect(violations(doc, "floating").map((v) => v.targets)).toEqual([["skull"]]);
    expect(violations(doc, "floating", { freeElements: ["skull"] })).toEqual([]);
  });

  test("interpenetration across groups, not within one", () => {
    const doc = edit(creatureModel(), [{ op: "update_node", target: "skull", from: [-3, 8, -8], to: [3, 13, -3] }]);
    expect(violations(doc, "interpenetration")[0]?.targets.toSorted()).toEqual(["skull", "torso"]);
    const sameGroup = edit(creatureModel(), [{ op: "add_cube", name: "belly", from: [-3, 5, -3], to: [3, 8, 3], parent: "body" }]);
    expect(violations(sameGroup, "interpenetration")).toEqual([]);
  });

  test("broken mirror", () => {
    const doc = edit(creatureModel(), [{ op: "update_node", target: "leg_front_l_cube", from: [2.5, 0, -5], to: [4.5, 6, -3] }]);
    expect(violations(doc, "mirror")[0]?.targets).toEqual(["leg_front_l_cube", "leg_front_r_cube"]);
  });

  test("missing mirror counterpart", () => {
    const doc = edit(creatureModel(), [{ op: "remove_node", target: "leg_back_r" }]);
    expect(violations(doc, "mirror")[0]?.message).toContain("no mirror counterpart");
  });

  test("slivers, but not intentional planes", () => {
    const sliver = edit(creatureModel(), [{ op: "add_cube", name: "whisker", from: [0, 10, -11], to: [0.05, 11, -12], parent: "head" }]);
    expect(violations(sliver, "degenerate").some((v) => v.targets.includes("whisker"))).toBe(true);
    const plane = edit(creatureModel(), [{ op: "add_cube", name: "decal", from: [-1, 9, -11], to: [1, 11, -11], parent: "head" }]);
    expect(violations(plane, "degenerate")).toEqual([]);
    expect(violations(plane, "degenerate", { allowPlanes: false })).toHaveLength(1);
  });

  test("block limits", () => {
    const doc = edit(creatureModel(), [{ op: "add_cube", name: "antenna", from: [0, 12, 0], to: [1, 40, 1], parent: "body" }]);
    expect(violations(doc, "block_limits", { blockLimits: "java_block" }).map((v) => v.targets)).toEqual([["antenna"]]);
    expect(runGeometryGates(doc, {}, ["block_limits"])[0]?.ran).toBe(false);
  });

  test("a cyclic outliner is reported instead of overflowing the stack", () => {
    const base = creatureModel();
    const body = base.outliner[0];
    if (typeof body === "string" || !body) throw new Error("fixture root is not a group");
    const cyclic: IBBModel = { ...base, outliner: [{ ...body, children: [...body.children, { uuid: body.uuid, children: [] }] }] };
    const found = violations(cyclic, "outliner");
    expect(found.map((violation) => violation.targets)).toEqual([["body"]]);
    expect(runAnimationGates(cyclic).results.length).toBeGreaterThan(0);
  });

  test("outliner problems", () => {
    const base = creatureModel();
    const dangling: IBBModel = { ...base, outliner: [...base.outliner, "ghost"] };
    expect(violations(dangling, "outliner")).toHaveLength(1);
    const unlisted: IBBModel = { ...base, outliner: base.outliner.filter((node) => typeof node !== "string") };
    const withLoose = edit(base, [{ op: "add_cube", name: "loose", from: [0, 0, 0], to: [1, 1, 1] }]);
    expect(violations({ ...withLoose, outliner: unlisted.outliner }, "unlisted_nodes")[0]?.targets).toEqual(["loose"]);
  });
});

describe("differential self-test", () => {
  test("every gate discriminates on the creature, or says why it cannot", () => {
    const results = selfTestGeometryGates(creatureModel(), { blockLimits: "bedrock_block" }, GEOMETRY_GATE_IDS);
    const summary = Object.fromEntries(results.map((result) => [result.gate, result.discriminates]));
    expect(summary).toEqual({
      outliner: true,
      unlisted_nodes: true,
      degenerate: true,
      block_limits: true,
      floating: true,
      interpenetration: true,
      mirror: true,
    });
  });

  test("reports impossible injections instead of a false pass", () => {
    const lonely = edit(creatureModel(), [{ op: "remove_node", target: "body" }, { op: "add_cube", name: "only", from: [0, 0, 0], to: [4, 4, 4] }]);
    const [interpenetration] = selfTestGeometryGates(lonely, {}, ["interpenetration"]);
    expect(interpenetration?.discriminates).toBeNull();
    expect(interpenetration?.impossible).toContain("different groups");
  });
});

describe("animation gates", () => {
  test("a clean walk passes", () => {
    const report = runAnimationGates(creatureModel(true));
    expect(report.checked).toEqual(["animation.creature.walk"]);
    expect(report.results.flatMap((result) => result.violations)).toEqual([]);
    expect(report.results.find((result) => result.id === "detachment")?.ran).toBe(true);
  });

  test("ground sink and detachment are caught with the offending time", () => {
    const doc = edit(creatureModel(true), [
      { op: "set_keyframe", animation: "animation.creature.walk", bone: "body", channel: "position", time: 0, value: [0, 0, 0] },
      { op: "set_keyframe", animation: "animation.creature.walk", bone: "body", channel: "position", time: 0.5, value: [0, -3, 0] },
      { op: "set_keyframe", animation: "animation.creature.walk", bone: "body", channel: "position", time: 1, value: [0, 0, 0] },
      { op: "set_keyframe", animation: "animation.creature.walk", bone: "leg_back_l", channel: "position", time: 0.25, value: [0, -4, 0] },
    ]);
    const report = runAnimationGates(doc);
    const byId = Object.fromEntries(report.results.map((result) => [result.id, result.violations]));
    expect(byId.ground_sink?.[0]?.message).toContain("at 0.5s");
    expect(byId.detachment?.some((violation) => violation.targets[0] === "leg_back_l")).toBe(true);
  });

  test("keyframes for missing bones and outside the clip are reported", () => {
    const doc = creatureModel(true);
    const [animation] = doc.animations ?? [];
    if (!animation) throw new Error("fixture has no animation");
    const broken: IBBModel = {
      ...doc,
      animations: [{ ...animation, length: 0.75, animators: { ...animation.animators, ghost: { name: "ghost", type: "bone", keyframes: [] } } }],
    };
    const byId = Object.fromEntries(runAnimationGates(broken).results.map((result) => [result.id, result.violations.length]));
    expect(byId.animated_bones_exist).toBe(1);
    expect(byId.keyframe_timing).toBe(4);
  });
});
