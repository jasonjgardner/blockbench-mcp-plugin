import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
import { createUndoHost } from "@/tests/helpers/undo-host";

type Vector = [number, number, number];
interface IFrameData {
  channel: string;
  time: number;
  interpolation?: string;
  data_points: Record<string, unknown>[];
  values?: (number | string)[];
  uniform?: boolean;
}
interface ISnapshot {
  length: number;
  frames: Record<string, IFrameData[]>;
}

let fixture: IToolFixture;
let animation: TestAnimation;
let failPreview: boolean;
let failCreation: boolean;
let failSample: boolean;
let sampleCounts: number[];
const timeline = { time: 0.7, selected: [] as TestFrame[], keyframes: [] as TestFrame[] };

class TestFrame {
  readonly data_points: Record<string, unknown>[];
  values: (number | string)[];
  time: number;
  channel: string;
  interpolation: string;
  uniform: boolean;
  constructor(readonly animator: TestAnimator, data: IFrameData) {
    this.time = data.time;
    this.channel = data.channel;
    this.interpolation = data.interpolation ?? "linear";
    this.data_points = structuredClone(data.data_points);
    this.values = [...data.values ?? [0, 0, 0]];
    this.uniform = data.uniform ?? false;
  }
  getArray(): (number | string)[] { return [...this.values]; }
  set(axis: "x" | "y" | "z", value: number): void {
    if (this.uniform) { this.values.fill(value); return; }
    const index = { x: 0, y: 1, z: 2 }[axis];
    // Native set('values', ...) does not update an axis; this double catches that regression.
    if (index === undefined) return;
    this.values[index] = value;
  }
}
class TestAnimator {
  readonly keyframes: TestFrame[] = [];
  addKeyframe(data: IFrameData): TestFrame {
    if (failCreation) throw new Error("Creation failed");
    const frame = new TestFrame(this, data);
    this.keyframes.push(frame);
    return frame;
  }
  interpolate(_channel: string, allowExpression: boolean): Vector {
    expect(allowExpression).toBe(false);
    sampleCounts.push(this.keyframes.length);
    if (failSample) throw new Error("Sampling failed");
    return [timeline.time ** 2, timeline.time * 2, timeline.time * 3];
  }
}
class TestAnimation {
  readonly animators: Record<string, TestAnimator> = { visible: new TestAnimator(), hidden: new TestAnimator() };
  snapping = 20;
  length = 4;
  setLength(): void {
    this.length = Math.max(this.length, ...Object.values(this.animators).flatMap(animator => animator.keyframes.map(frame => frame.time)));
  }
}

function snapshot(): ISnapshot {
  return {
    length: animation.length,
    frames: Object.fromEntries(Object.entries(animation.animators).map(([name, animator]) => [name, animator.keyframes.map(frame => ({
      time: frame.time, channel: frame.channel, values: [...frame.values], interpolation: frame.interpolation,
      uniform: frame.uniform, data_points: structuredClone(frame.data_points),
    }))])),
  };
}
const undo = createUndoHost({
  snapshot: (_aspects: { animations: TestAnimation[] }) => snapshot(),
  restore: (state: ISnapshot) => {
    animation.length = state.length;
    Object.entries(state.frames).forEach(([name, frames]) => {
      const animator = animation.animators[name];
      animator.keyframes.splice(0, animator.keyframes.length, ...frames.map(data => new TestFrame(animator, data)));
    });
  },
});

function add(time: number, values: (number | string)[] = [1, 2, 3], channel = "rotation", animator = animation.animators.visible): TestFrame {
  return animator.addKeyframe({ time, values, channel, interpolation: "linear", data_points: [{}] });
}
function call(operation: string, parameters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<unknown> {
  return fixture.call("batch_keyframe_operations", { operation, parameters, ...extra });
}

beforeAll(async () => {
  fixture = await loadToolDefinitions({ entries: ["server/tools/animation/batch.ts"], register: ["registerBatchKeyframeOperationsTool"] });
});
beforeEach(() => {
  animation = new TestAnimation();
  timeline.time = 0.7;
  timeline.selected = [];
  timeline.keyframes = [];
  failPreview = false;
  failCreation = false;
  failSample = false;
  sampleCounts = [];
  undo.reset();
});
useGlobals(() => ({
  Animation: { all: [animation], selected: animation },
  Animator: { preview() { if (failPreview) throw new Error("Preview failed"); } },
  Timeline: timeline,
  Undo: undo,
}));

describe("batch keyframe values and transactions", () => {
  test("offset writes native axes, handles numeric strings and preserves nonuniform scale with undo/redo", async () => {
    const frame = add(1, ["1", "1", "1"], "scale");
    frame.uniform = true;
    timeline.selected = [frame];
    const before = snapshot();
    await call("offset", { offset_values: [2, 3, 4], offset_time: 1 });
    expect(frame.values).toEqual([3, 4, 5]);
    expect(frame.time).toBe(2);
    expect(frame.uniform).toBe(false);
    const after = snapshot();
    expect(undo.finishes).toBe(1);
    undo.undo();
    expect(snapshot()).toEqual(before);
    undo.redo();
    expect(snapshot()).toEqual(after);
  });
  test("mirror negates the requested numeric component through the native setter", async () => {
    const frame = add(1);
    timeline.selected = [frame];
    await call("mirror", { mirror_axis: "y" });
    expect(frame.values).toEqual([1, -2, 3]);
  });
  test("all includes hidden animators absent from the visible Timeline", async () => {
    const visible = add(1);
    const hidden = add(2, [4, 5, 6], "position", animation.animators.hidden);
    timeline.keyframes = [visible];
    await call("offset", { offset_time: 2 }, { selection: "all" });
    expect([visible.time, hidden.time]).toEqual([3, 4]);
  });
  test("zero scale is honored for a single frame", async () => {
    const frame = add(2);
    timeline.selected = [frame];
    await call("scale", { scale_factor: 0, scale_pivot: 1 });
    expect(frame.time).toBe(1);
  });
  test.each([
    ["mirror", {}, {}], ["scale", {}, {}], ["offset", {}, {}],
    ["offset", { offset_time: -2 }, {}],
    ["offset", { offset_time: 1 }, { selection: "range", range: { start: 2, end: 1 } }],
    ["offset", { offset_time: 1 }, { selection: "pattern", pattern: { interval: 0 } }],
    ["bake", { bake_interval: 0 }, {}], ["bake", { bake_interval: -1 }, {}],
  ])("invalid %s arguments fail before undo", async (operation, parameters, extra) => {
    timeline.selected = [add(1)];
    const before = snapshot();
    await expect(call(String(operation), parameters as Record<string, unknown>, extra as Record<string, unknown>)).rejects.toThrow();
    expect(snapshot()).toEqual(before);
    expect(undo.starts).toBe(0);
  });
  test("expression and channel collision validation leave every frame untouched", async () => {
    const first = add(1);
    add(2);
    timeline.selected = [first];
    await expect(call("offset", { offset_time: 1 })).rejects.toThrow("same time");
    const expression = add(3, ["math.sin(q.anim_time)", 0, 0]);
    timeline.selected = [first, expression];
    const before = snapshot();
    await expect(call("offset", { offset_time: 1, offset_values: [1, 1, 1] })).rejects.toThrow();
    expect(snapshot()).toEqual(before);
    expect(undo.starts).toBe(0);
  });
  test("a preview failure rolls back timing and value edits", async () => {
    timeline.selected = [add(1)];
    const before = snapshot();
    failPreview = true;
    await expect(call("offset", { offset_time: 1, offset_values: [2, 2, 2] })).rejects.toThrow("Preview failed");
    expect(snapshot()).toEqual(before);
    expect(undo.history).toHaveLength(0);
    expect(undo.cancels).toBe(1);
  });
});

describe("bounded native numeric baking", () => {
  test("samples original selected channels only, writes real values, restores playhead and supports undo/redo", async () => {
    const first = add(0, [0, 0, 0]);
    const last = add(1, [1, 2, 3]);
    const outside = add(3, [7, 8, 9]);
    const other = add(0, [10, 11, 12], "position");
    timeline.selected = [first, last];
    const before = snapshot();
    await call("bake", { bake_interval: 0.5 });
    const frames = animation.animators.visible.keyframes;
    expect(frames.find(frame => frame.channel === "rotation" && frame.time === 0.5)?.values).toEqual([0.25, 1, 1.5]);
    expect(new Set(sampleCounts)).toEqual(new Set([4]));
    expect(outside.values).toEqual([7, 8, 9]);
    expect(other.values).toEqual([10, 11, 12]);
    expect(frames.filter(frame => frame.channel === "position")).toHaveLength(1);
    expect(timeline.time).toBe(0.7);
    const after = snapshot();
    undo.undo();
    expect(snapshot()).toEqual(before);
    undo.redo();
    expect(snapshot()).toEqual(after);
  });
  test("sampling failure restores time and never starts undo", async () => {
    timeline.selected = [add(0), add(1)];
    const before = snapshot();
    failSample = true;
    await expect(call("bake", { bake_interval: 0.5 })).rejects.toThrow("Sampling failed");
    expect(timeline.time).toBe(0.7);
    expect(snapshot()).toEqual(before);
    expect(undo.starts).toBe(0);
  });
  test("creation failure rolls back already rewritten frames", async () => {
    timeline.selected = [add(0), add(1)];
    const before = snapshot();
    failCreation = true;
    await expect(call("bake", { bake_interval: 0.5 })).rejects.toThrow("Creation failed");
    expect(snapshot()).toEqual(before);
    expect(undo.cancels).toBe(1);
    expect(timeline.time).toBe(0.7);
  });
  test("oversized bakes reject before sampling or undo", async () => {
    timeline.selected = [add(0), add(100)];
    await expect(call("bake", { bake_interval: 0.001 })).rejects.toThrow("keyframe limit");
    expect(sampleCounts).toEqual([]);
    expect(undo.starts).toBe(0);
  });
  test.each(["expression", "step", "pre/post", "effect"])("unsupported %s baking rejects without edits", async kind => {
    const first = add(0);
    const second = add(1);
    if (kind === "expression") second.values[0] = "q.anim_time";
    if (kind === "step") second.interpolation = "step";
    if (kind === "pre/post") second.data_points.push({});
    if (kind === "effect") { first.channel = "particle"; second.channel = "particle"; }
    timeline.selected = [first, second];
    const before = snapshot();
    await expect(call("bake", { bake_interval: 0.5 })).rejects.toThrow();
    expect(snapshot()).toEqual(before);
    expect(undo.starts).toBe(0);
  });
});
