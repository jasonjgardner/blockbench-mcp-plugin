import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";

/** Minimal keyframe double: time, channel, owning animator and selection flag. */
class TestFrame {
  selected = false;
  readonly uuid = crypto.randomUUID();
  constructor(readonly time: number, readonly channel: string, readonly animator: TestBoneAnimator) {}
  select() {
    timeline.selected.push(this);
    this.selected = true;
  }
}

/** Bone animator double; `instanceof BoneAnimator` is how the tool excludes effect animators. */
class TestBoneAnimator {
  keyframes: TestFrame[] = [];
  constructor(readonly name: string) {}
  add(time: number, channel = "rotation") {
    const frame = new TestFrame(time, channel, this);
    this.keyframes.push(frame);
    return frame;
  }
}

/** Effect animator double that must never be selected by the playhead actions. */
class TestEffectAnimator {
  readonly name = "effects";
  keyframes = [{ time: 0, channel: "particle", uuid: "effect-frame", selected: false }];
}

class TestAnimation {
  static all: TestAnimation[] = [];
  static selected: TestAnimation | null = null;
  readonly uuid = crypto.randomUUID();
  name = "walk";
  animators: Record<string, TestBoneAnimator | TestEffectAnimator> = {};
  select() {
    TestAnimation.selected = this;
  }
  getBoneAnimator() {
    return null;
  }
}

const timeline = {
  time: 1,
  selected: [] as TestFrame[],
  animators: [] as TestBoneAnimator[],
  vue: { channels: { rotation: true, position: false, scale: true } as Record<string, boolean> },
};

/** Variable Placeholders panel double: assigning text runs the watcher like Vue would. */
class TestPanel {
  buttons: { type: string; id: string; value: number }[] = [];
  #text = "";
  get text() {
    return this.#text;
  }
  set text(value: string) {
    this.#text = value;
    project.variable_placeholders = value;
    this.buttons = [...value.matchAll(/(slider|toggle|impulse)\('([^']+)'/g)].map(([, type = "", id = ""]) => ({ type, id, value: 0 }));
  }
}

let tools: IToolFixture;
let panel = new TestPanel();
let previews = 0;
let canceled = 0;
const project = { variable_placeholders: "" };
const parserVariables: Record<string, unknown> = {};
const globalVariables = Object.defineProperties({ true: 1, false: 0, "query.camera_rotation"(axis: number) { return axis; } }, {
  "query.anim_time": { enumerable: true, get: () => 1.234567 },
  "query.broken": { enumerable: true, get: () => { throw new Error("no preview"); } },
});

beforeAll(async () => {
  tools = await loadToolDefinitions({ entries: ["server/tools/animation.ts"], register: ["registerAnimationTools"] });
});
beforeEach(() => {
  TestAnimation.all = [];
  TestAnimation.selected = null;
  timeline.time = 1;
  timeline.selected = [];
  timeline.animators = [];
  panel = new TestPanel();
  project.variable_placeholders = "";
  previews = 0;
  canceled = 0;
  Object.keys(parserVariables).forEach((key) => Reflect.deleteProperty(parserVariables, key));
});
useGlobals(() => ({
  Animation: TestAnimation,
  Animator: { preview() { previews++; }, MolangParser: { global_variables: globalVariables, variables: parserVariables } },
  BoneAnimator: TestBoneAnimator,
  Format: { animation_mode: true, molang: true },
  Group: { all: [{ name: "leg", uuid: "leg-uuid" }] },
  Interface: { Panels: { variable_placeholders: { inside_vue: panel } } },
  Modes: { animate: true },
  Project: project,
  Timeline: timeline,
  Undo: {
    initEdit() {},
    finishEdit() {},
    cancelEdit() { canceled++; },
    initSelection() {},
    finishSelection() {},
  },
  updateKeyframeSelection() {},
}));

/** Builds a selected animation with two bone animators and an effect animator. */
function setupAnimation() {
  const animation = new TestAnimation();
  const leg = new TestBoneAnimator("leg");
  const arm = new TestBoneAnimator("arm");
  animation.animators = { leg, arm, effects: new TestEffectAnimator() };
  TestAnimation.all = [animation];
  TestAnimation.selected = animation;
  return { animation, leg, arm };
}

describe("animation_timeline playhead selection", () => {
  test("selects bone keyframes at or before the playhead across all animators by default", async () => {
    const { leg, arm } = setupAnimation();
    const expected = [leg.add(0), leg.add(1), arm.add(0.5, "position")];
    leg.add(2);
    const result = JSON.parse(String(await tools.call("animation_timeline", { action: "select_before_playhead" })));
    expect(result).toMatchObject({ time: 1, scope: "animation", count: 3 });
    expect(result.keyframes.map(({ uuid }: { uuid: string }) => uuid)).toEqual(expected.map(({ uuid }) => uuid));
    expect(timeline.selected).toEqual(expected);
  });

  test("uses an explicit reference time and honors timeline scope filters", async () => {
    const { leg, arm } = setupAnimation();
    timeline.animators = [leg];
    const kept = leg.add(3);
    leg.add(3, "position");
    arm.add(4);
    leg.add(1);
    const result = JSON.parse(String(await tools.call("animation_timeline", { action: "select_after_playhead", time: 2, scope: "timeline" })));
    expect(result.keyframes).toEqual([{ uuid: kept.uuid, bone: "leg", channel: "rotation", time: 3 }]);
  });

  test("timeline scope rejects an animation that is not selected", async () => {
    const { animation } = setupAnimation();
    TestAnimation.selected = null;
    await expect(tools.call("animation_timeline", { animation_id: animation.uuid, action: "select_after_playhead", scope: "timeline" }))
      .rejects.toThrow('scope "timeline" requires "walk" to be the selected animation');
  });
});

test("keyframe creation reports animators Blockbench refuses instead of dereferencing null", async () => {
  setupAnimation();
  await expect(tools.call("manage_keyframes", { action: "create", bone_name: "leg", channel: "rotation", keyframes: [{ time: 0, values: [0, 1, 0] }] }))
    .rejects.toThrow('"leg" cannot be animated by "walk"');
  expect(canceled).toBe(1);
});

describe("variable_placeholders", () => {
  test("add upserts a slider line, syncs through the panel, seeds the control and refreshes the preview", async () => {
    project.variable_placeholders = "v.bend = 1\nvariable.speed = 2";
    parserVariables["variable.bend"] = 1;
    const result = JSON.parse(String(await tools.call("variable_placeholders", {
      action: "add",
      entry: { type: "slider", variable: "variable.bend", name: "bend", step: 0.1, range: [0, 1], initial_value: 0.5 },
    })));
    expect(result.text).toBe("variable.bend = slider('bend', 0.1, 0, 1)\nvariable.speed = 2");
    expect(panel.text).toBe(result.text);
    expect(result.controls).toEqual([{ type: "slider", id: "bend", value: 0.5 }]);
    expect(parserVariables).toEqual({});
    expect(previews).toBe(1);
  });

  test("set replaces the text and remove deletes a variable", async () => {
    await tools.call("variable_placeholders", { action: "set", text: "v.a = toggle('A')\nv.b = 3" });
    const result = JSON.parse(String(await tools.call("variable_placeholders", { action: "remove", variable: "variable.a" })));
    expect(result.text).toBe("v.b = 3");
    expect(result.lines).toEqual([{ variable: "variable.b", expression: "3" }]);
    await expect(tools.call("variable_placeholders", { action: "remove", variable: "v.a" })).rejects.toThrow('No placeholder line assigns "v.a".');
  });

  test("formats without Molang are rejected", async () => {
    Object.assign(globalThis, { Format: { animation_mode: true, molang: false } });
    await expect(tools.call("variable_placeholders", { action: "get" })).rejects.toThrow("supports animation and Molang");
  });

  test("list_molang_variables describes constants, live queries and functions without failing on throwing getters", async () => {
    const result = JSON.parse(String(await tools.call("list_molang_variables", {})));
    expect(result.variables).toEqual([
      { name: "query.anim_time", kind: "dynamic", value: 1.23457 },
      { name: "query.broken", kind: "dynamic", value: null },
      { name: "query.camera_rotation", kind: "function", value: null, arguments: 1 },
    ]);
    const filtered = JSON.parse(String(await tools.call("list_molang_variables", { filter: "CAMERA" })));
    expect(filtered.count).toBe(1);
  });
});
