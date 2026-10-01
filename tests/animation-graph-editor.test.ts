import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
import { createUndoHost } from "@/tests/helpers/undo-host";

type Vector = [number, number, number];
type Channel = "rotation" | "position" | "scale";

/** Curve state of one key, as the animation Undo aspect restores it. */
interface IFrameState {
  time: number;
  interpolation: string;
  easing?: string;
  easingArgs?: number[];
  bezier_linked: boolean;
  bezier_left_time: Vector;
  bezier_left_value: Vector;
  bezier_right_time: Vector;
  bezier_right_value: Vector;
}

let fixture: IToolFixture;
let animation: TestAnimation;
let format: Record<string, unknown>;
let failPreview: boolean;
let refreshes: number;
const bone = { uuid: "head-id", name: "head" };

class TestFrame {
  interpolation = "linear";
  /** GeckoLib plugin field, present only on keys that carry an easing. */
  easing?: string;
  easingArgs?: number[];
  bezier_linked = true;
  bezier_left_time: Vector = [-0.1, -0.1, -0.1];
  bezier_left_value: Vector = [0, 0, 0];
  bezier_right_time: Vector = [0.1, 0.1, 0.1];
  bezier_right_value: Vector = [0, 0, 0];
  readonly data_points: Record<string, number | string>[];
  constructor(readonly channel: Channel, public time: number, values: (number | string)[]) {
    this.data_points = [{ x: values[0], y: values[1], z: values[2] }];
  }
  get(axis: "x" | "y" | "z"): number | string {
    return this.data_points[0][axis] ?? 0;
  }
  state(): IFrameState {
    return {
      time: this.time, interpolation: this.interpolation, easing: this.easing, easingArgs: this.easingArgs && [...this.easingArgs],
      bezier_linked: this.bezier_linked,
      bezier_left_time: [...this.bezier_left_time], bezier_left_value: [...this.bezier_left_value],
      bezier_right_time: [...this.bezier_right_time], bezier_right_value: [...this.bezier_right_value],
    };
  }
  load(state: IFrameState): void {
    this.time = state.time;
    this.interpolation = state.interpolation;
    this.easing = state.easing;
    this.easingArgs = state.easingArgs && [...state.easingArgs];
    this.bezier_linked = state.bezier_linked;
    this.bezier_left_time = [...state.bezier_left_time];
    this.bezier_left_value = [...state.bezier_left_value];
    this.bezier_right_time = [...state.bezier_right_time];
    this.bezier_right_value = [...state.bezier_right_value];
  }
}
class TestAnimator {
  rotation: TestFrame[] = [];
  position: TestFrame[] = [];
  scale: TestFrame[] = [];
  quaternion_interpolation = false;
  add(channel: Channel, time: number, values: (number | string)[]): TestFrame {
    const frame = new TestFrame(channel, time, values);
    this[channel].push(frame);
    return frame;
  }
}
class TestAnimation {
  readonly uuid = "animation-id";
  readonly name = "look";
  readonly animators: Record<string, TestAnimator> = { [bone.uuid]: new TestAnimator() };
}

function frames(): TestFrame[] {
  return Object.values(animation.animators).flatMap(animator => [...animator.rotation, ...animator.position, ...animator.scale]);
}
function snapshot(): IFrameState[] {
  return frames().map(frame => frame.state());
}
const undo = createUndoHost({
  snapshot: (_aspects: { animations: TestAnimation[] }) => snapshot(),
  restore: (states: IFrameState[]) => frames().forEach((frame, index) => frame.load(states[index])),
});
function call(input: Record<string, unknown>): Promise<unknown> {
  return fixture.call("animation_graph_editor", { bone_name: bone.name, channel: "rotation", ...input });
}
/** Three keys stored out of chronological order, so segment math must sort them first. */
function addKeys(): TestFrame[] {
  const animator = animation.animators[bone.uuid];
  const last = animator.add("rotation", 1.5, [30, 60, -90]);
  const first = animator.add("rotation", 0, [0, 0, 0]);
  const middle = animator.add("rotation", 0.5, [10, 20, 30]);
  return [first, middle, last];
}
function expectClose(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 10));
}

beforeAll(async () => {
  fixture = await loadToolDefinitions({ entries: ["server/tools/animation/curves.ts"], register: ["registerAnimationGraphEditorTool"] });
});
beforeEach(() => {
  animation = new TestAnimation();
  format = { id: "bedrock", quaternion_interpolation: false };
  failPreview = false;
  refreshes = 0;
  undo.reset();
});
useGlobals(() => ({
  Animation: { all: [animation], selected: animation },
  Animator: { preview() { if (failPreview) throw new Error("Preview failed"); } },
  Format: format,
  Group: { all: [bone] },
  Undo: undo,
  updateKeyframeSelection() { refreshes++; },
}));

describe("Bezier easing", () => {
  test("ease_in_out writes per-axis handles from chronological segment durations in one reversible edit", async () => {
    const [first, middle, last] = addKeys();
    const before = snapshot();
    await call({ action: "ease_in_out" });
    expect([first, middle, last].map(frame => frame.interpolation)).toEqual(["bezier", "bezier", "bezier"]);
    // Segment 0 -> 0.5 s, then 0.5 -> 1.5 s: handle times scale with each segment's own duration.
    expectClose(first.bezier_right_time, [0.21, 0.21, 0.21]);
    expectClose(middle.bezier_left_time, [-0.21, -0.21, -0.21]);
    expectClose(middle.bezier_right_time, [0.42, 0.42, 0.42]);
    expectClose(last.bezier_left_time, [-0.42, -0.42, -0.42]);
    expectClose(middle.bezier_right_value, [0, 0, 0]);
    // Keys outside the selection keep the handles of segments this edit does not own.
    expect(first.bezier_left_time).toEqual([-0.1, -0.1, -0.1]);
    expect(last.bezier_right_time).toEqual([0.1, 0.1, 0.1]);
    expect(undo.history).toHaveLength(1);
    expect(undo.lastEdit?.message).toBe("Graph editor: ease_in_out");
    expect(refreshes).toBe(1);
    const after = snapshot();
    undo.undo();
    expect(snapshot()).toEqual(before);
    undo.redo();
    expect(snapshot()).toEqual(after);
  });

  test("custom curves on one axis convert value fractions per segment and preserve the other axes", async () => {
    const [first, middle, last] = addKeys();
    [first, middle, last].forEach(frame => { frame.interpolation = "bezier"; });
    const untouched = [first, middle, last].map(frame => frame.state());
    await call({ action: "custom", axis: "y", custom_curve: { control_point_1: [0.25, -0.5], control_point_2: [0.75, 1.5] } });
    // y deltas are 20 (0 -> 20) and 40 (20 -> 60); gaps are 0.5 s and 1 s.
    expectClose([first.bezier_right_time[1], first.bezier_right_value[1]], [0.125, -10]);
    expectClose([middle.bezier_left_time[1], middle.bezier_left_value[1]], [-0.125, 10]);
    expectClose([middle.bezier_right_time[1], middle.bezier_right_value[1]], [0.25, -20]);
    expectClose([last.bezier_left_time[1], last.bezier_left_value[1]], [-0.25, 20]);
    [first, middle, last].forEach((frame, index) => {
      [0, 2].forEach(slot => {
        expect(frame.bezier_left_time[slot]).toBe(untouched[index].bezier_left_time[slot]);
        expect(frame.bezier_right_value[slot]).toBe(untouched[index].bezier_right_value[slot]);
      });
    });
    // Asymmetric handles are unlinked so the native graph editor does not re-mirror them.
    expect(middle.bezier_linked).toBe(false);
  });

  test("a range limits the edit to the keys it contains", async () => {
    const [first, middle, last] = addKeys();
    await call({ action: "ease_in", keyframe_range: { start: 0.5, end: 1.5 } });
    expect([first.interpolation, middle.interpolation, last.interpolation]).toEqual(["linear", "bezier", "bezier"]);
    expectClose(middle.bezier_right_time, [0.42, 0.42, 0.42]);
    expectClose(last.bezier_left_time, [0, 0, 0]);
  });
});

describe("validation happens before Undo", () => {
  test.each([
    ["partial-axis easing on non-Bezier keys", { action: "ease_in", axis: "x" }, "already use Bezier interpolation"],
    ["partial-axis key-wide interpolation", { action: "linear", axis: "z" }, 'use axis "all"'],
    ["custom without control points", { action: "custom" }, "custom_curve is required"],
    ["time fractions outside 0..1", { action: "custom", custom_curve: { control_point_1: [1.5, 0], control_point_2: [0.5, 1] } }, "between 0 and 1"],
    ["an unordered range", { action: "linear", keyframe_range: { start: 1, end: 0 } }, "0 <= start <= end"],
    ["a range without keys", { action: "linear", keyframe_range: { start: 2, end: 3 } }, "No head.rotation keyframes"],
    ["a single key", { action: "ease_out", keyframe_range: { start: 0, end: 0.2 } }, "at least two keyframes"],
  ])("rejects %s", async (_label, input, message) => {
    addKeys();
    const before = snapshot();
    await expect(call(input)).rejects.toThrow(message);
    expect(snapshot()).toEqual(before);
    expect(undo.starts).toBe(0);
  });

  test("Molang values and pre/post keys cannot be eased numerically", async () => {
    const [first, middle] = addKeys();
    middle.data_points[0].y = "math.sin(q.anim_time)";
    await expect(call({ action: "ease_in_out" })).rejects.toThrow("non-numeric y value");
    middle.data_points[0].y = 20;
    first.data_points.push({ x: 1, y: 1, z: 1 });
    await expect(call({ action: "ease_in_out" })).rejects.toThrow("pre/post");
    expect(undo.starts).toBe(0);
  });

  test("a missing channel is reported", async () => {
    await expect(call({ action: "linear", channel: "scale" })).rejects.toThrow("No keyframes found for head.scale");
  });

  test("a failing preview reverts every staged key", async () => {
    addKeys();
    const before = snapshot();
    failPreview = true;
    await expect(call({ action: "smooth" })).rejects.toThrow("Preview failed");
    expect(snapshot()).toEqual(before);
    expect(undo.cancels).toBe(1);
    expect(undo.history).toHaveLength(0);
  });
});

describe("curves the preview or export would drop", () => {
  test("quaternion rotation rejects smooth and Bezier curves but keeps linear and stepped", async () => {
    const keys = addKeys();
    format.quaternion_interpolation = true;
    await expect(call({ action: "smooth" })).rejects.toThrow("quaternion interpolation");
    await expect(call({ action: "ease_in" })).rejects.toThrow("quaternion interpolation");
    await call({ action: "stepped" });
    expect(keys.map(frame => frame.interpolation)).toEqual(["step", "step", "step"]);
  });

  test("per-animator quaternion rotation is read from the animator", async () => {
    addKeys();
    format.per_animator_rotation_interpolation = true;
    format.quaternion_interpolation = false;
    animation.animators[bone.uuid].quaternion_interpolation = true;
    await expect(call({ action: "smooth" })).rejects.toThrow("quaternion interpolation");
  });

  test("GeckoLib models reject step and Bezier curves and accept smooth", async () => {
    const keys = addKeys();
    format.id = "geckolib_model";
    await expect(call({ action: "stepped" })).rejects.toThrow('easing "step"');
    await expect(call({ action: "ease_in_out" })).rejects.toThrow("geckolib_set_keyframe_easing");
    await expect(call({ action: "custom", custom_curve: { control_point_1: [0.2, 0], control_point_2: [0.8, 1] } })).rejects.toThrow("Bezier");
    expect(undo.starts).toBe(0);
    await call({ action: "smooth" });
    expect(keys.map(frame => frame.interpolation)).toEqual(["catmullrom", "catmullrom", "catmullrom"]);
  });

  test("smoothing GeckoLib keys clears their easings in the same undoable edit and says so", async () => {
    const keys = addKeys();
    format.id = "geckolib_model";
    keys[1].easing = "easeInQuad";
    keys[2].easing = "easeOutBack";
    keys[2].easingArgs = [2];
    const before = snapshot();
    const result = String(await call({ action: "smooth" }));
    expect(keys.map(frame => [frame.easing, frame.easingArgs])).toEqual([[undefined, undefined], [undefined, undefined], [undefined, undefined]]);
    expect(result).toContain("Cleared the GeckoLib easing of 2 keyframe(s)");
    undo.undo();
    expect(snapshot()).toEqual(before);
    // Linear keys keep their easing: GeckoLib applies easings to linear segments.
    format.id = "geckolib_model";
    await call({ action: "linear" });
    expect(keys[1].easing).toBe("easeInQuad");
  });
});
