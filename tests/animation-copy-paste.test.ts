import { beforeEach, describe, expect, test } from "bun:test";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
import { createUndoHost } from "@/tests/helpers/undo-host";

type Vector = [number, number, number];
interface IFrameData {
  channel: string;
  time: number;
  data_points: Record<string, unknown>[];
  interpolation?: string;
  uniform?: boolean;
  bezier_left_value?: Vector;
  bezier_right_value?: Vector;
  bezier_left_time?: Vector;
  bezier_right_time?: Vector;
  bezier_linked?: boolean;
  color?: number;
}
interface ISnapshot { length: number; animators: Record<string, IFrameData[]> }
let fixture: IToolFixture;
let animation: TestAnimation;
let failCreation: boolean;
let failPreview: boolean;
let flipped: number[];
const sourceBone = { uuid: "source-id", name: "source" };
const targetBone = { uuid: "target-id", name: "target" };

class TestPoint {
  constructor(readonly values: Record<string, unknown>) {}
  getUndoCopy(): Record<string, unknown> { return structuredClone(this.values); }
}
class TestFrame {
  time: number;
  channel: string;
  data_points: TestPoint[];
  interpolation: string;
  uniform: boolean;
  bezier_left_value: Vector;
  bezier_right_value: Vector;
  bezier_left_time: Vector;
  bezier_right_time: Vector;
  bezier_linked: boolean;
  color: number;
  constructor(readonly animator: TestAnimator, data: IFrameData) {
    this.time = data.time;
    this.channel = data.channel;
    this.interpolation = data.interpolation ?? "linear";
    this.data_points = data.data_points.map(point => new TestPoint(structuredClone(point)));
    this.uniform = data.uniform ?? false;
    this.bezier_left_value = [...data.bezier_left_value ?? [0, 0, 0]];
    this.bezier_right_value = [...data.bezier_right_value ?? [0, 0, 0]];
    this.bezier_left_time = [...data.bezier_left_time ?? [-0.1, -0.1, -0.1]];
    this.bezier_right_time = [...data.bezier_right_time ?? [0.1, 0.1, 0.1]];
    this.bezier_linked = data.bezier_linked ?? false;
    this.color = data.color ?? 0;
  }
  remove(): void { this.animator.keyframes.splice(this.animator.keyframes.indexOf(this), 1); }
  flip(axis: number): this {
    flipped.push(axis);
    if (this.channel === "scale") return this;
    const indices = this.channel === "position" ? [axis] : [0, 1, 2].filter(index => index !== axis);
    indices.forEach(index => {
      const component = ["x", "y", "z"][index];
      this.data_points.forEach(point => { point.values[component] = -Number(point.values[component]); });
      this.bezier_left_value[index] *= -1;
      this.bezier_right_value[index] *= -1;
    });
    return this;
  }
  save(): IFrameData {
    return { time: this.time, channel: this.channel, data_points: this.data_points.map(point => point.getUndoCopy()),
      interpolation: this.interpolation, uniform: this.uniform, color: this.color, bezier_linked: this.bezier_linked,
      bezier_left_time: [...this.bezier_left_time], bezier_right_time: [...this.bezier_right_time],
      bezier_left_value: [...this.bezier_left_value], bezier_right_value: [...this.bezier_right_value] };
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
}
class TestAnimation {
  readonly uuid = "animation-id";
  readonly name = "motion";
  length = 1;
  animators: Record<string, TestAnimator> = { [sourceBone.uuid]: new TestAnimator() };
  getBoneAnimator(bone: { uuid: string }): TestAnimator { return this.animators[bone.uuid] ??= new TestAnimator(); }
  setLength(): void { this.length = Math.max(this.length, ...Object.values(this.animators).flatMap(animator => animator.keyframes.map(frame => frame.time))); }
}
function snapshot(): ISnapshot {
  return { length: animation.length, animators: Object.fromEntries(Object.entries(animation.animators).map(([id, animator]) => [id, animator.keyframes.map(frame => frame.save())])) };
}
const undo = createUndoHost({
  snapshot: (_aspects: { animations: TestAnimation[] }) => snapshot(),
  restore: (state: ISnapshot) => {
    animation.length = state.length;
    animation.animators = Object.fromEntries(Object.entries(state.animators).map(([id, frames]) => {
      const animator = new TestAnimator();
      animator.keyframes.push(...frames.map(frame => new TestFrame(animator, frame)));
      return [id, animator];
    }));
  },
});
function add(channel = "rotation", time = 0.137): TestFrame {
  return animation.animators[sourceBone.uuid].addKeyframe({ channel, time, data_points: [{ x: 10, y: 20, z: 30 }],
    interpolation: "bezier", bezier_left_value: [1, 2, 3], bezier_right_value: [4, 5, 6] });
}
function copy(extra: Record<string, unknown> = {}): Promise<unknown> {
  return fixture.call("animation_copy_paste", { action: "copy", source: { bone: sourceBone.name, ...extra } });
}
function paste(action = "paste", extra: Record<string, unknown> = {}): Promise<unknown> {
  return fixture.call("animation_copy_paste", { action, target: { bone: targetBone.name, ...extra } });
}

beforeEach(async () => {
  fixture = await loadToolDefinitions({ entries: ["server/tools/animation/copy-paste.ts"], register: ["registerAnimationCopyPasteTool"] });
  animation = new TestAnimation();
  failCreation = false;
  failPreview = false;
  flipped = [];
  undo.reset();
});
useGlobals(() => ({
  Animation: { all: [animation], selected: animation },
  Group: { all: [sourceBone, targetBone] },
  Animator: { preview() { if (failPreview) throw new Error("Preview failed"); } },
  Undo: undo,
}));

describe("native animation clipboard", () => {
  test("paste before copy fails before target animator creation or Undo", async () => {
    await expect(paste()).rejects.toThrow("Copy first");
    expect(animation.animators[targetBone.uuid]).toBeUndefined();
    expect(undo.starts).toBe(0);
  });
  test("copy preserves native values, expressions, pre/post points and detached bezier data", async () => {
    const frame = add();
    frame.data_points[0].values.x = "math.sin(q.anim_time)";
    frame.data_points.push(new TestPoint({ x: 40, y: 50, z: 60 }));
    const original = frame.save();
    await copy();
    expect(undo.starts).toBe(0);
    frame.data_points[0].values.x = 999;
    frame.bezier_left_value[0] = 999;
    await paste();
    const pasted = animation.animators[targetBone.uuid].keyframes[0];
    expect(pasted.save()).toEqual(original);
    expect(pasted.time).toBe(0.137);
    pasted.bezier_right_value[0] = 777;
    await paste("paste", { time_offset: 1 });
    expect(animation.animators[targetBone.uuid].keyframes[1].bezier_right_value[0]).toBe(4);
  });
  test("native mirror uses complementary rotation axes and reflected position, preserving scale", async () => {
    add("rotation"); add("position"); add("scale");
    await copy();
    await paste("mirror_paste", { mirror_axis: "x" });
    const frames = animation.animators[targetBone.uuid].keyframes;
    expect(frames[0].data_points[0].values).toEqual({ x: 10, y: -20, z: -30 });
    expect(frames[0].bezier_left_value).toEqual([1, -2, -3]);
    expect(frames[1].data_points[0].values).toEqual({ x: -10, y: 20, z: 30 });
    expect(frames[2].data_points[0].values).toEqual({ x: 10, y: 20, z: 30 });
    expect(flipped).toEqual([0, 0, 0]);
  });
  test("paste replacement, new animator and length are reversible", async () => {
    add();
    await copy();
    const target = animation.getBoneAnimator(targetBone);
    target.addKeyframe({ time: 1.137, channel: "rotation", data_points: [{ x: 99, y: 99, z: 99 }] });
    const before = snapshot();
    await paste("paste", { time_offset: 1 });
    expect(target.keyframes).toHaveLength(1);
    expect(target.keyframes[0].data_points[0].values.x).toBe(10);
    const after = snapshot();
    expect(animation.length).toBe(1.137);
    undo.undo(); expect(snapshot()).toEqual(before);
    undo.redo(); expect(snapshot()).toEqual(after);
  });
  test.each(["creation", "preview"])("%s failure rolls back the target animator and frames", async failure => {
    add();
    await copy();
    const before = snapshot();
    failCreation = failure === "creation";
    failPreview = failure === "preview";
    await expect(paste()).rejects.toThrow();
    expect(snapshot()).toEqual(before);
    expect(animation.animators[targetBone.uuid]).toBeUndefined();
    expect(undo.cancels).toBe(1);
  });
  test.each([-1, Number.POSITIVE_INFINITY])("invalid offset %s fails before mutation", async time_offset => {
    add(); await copy();
    const before = snapshot();
    await expect(paste("paste", { time_offset })).rejects.toThrow();
    expect(snapshot()).toEqual(before);
    expect(undo.starts).toBe(0);
  });
  test("invalid ranges and empty channel selection do not replace a valid clipboard", async () => {
    add(); await copy();
    await expect(copy({ time_range: { start: 2, end: 1 } })).rejects.toThrow("Copy range");
    await expect(copy({ channels: ["scale"] })).rejects.toThrow("No keyframes");
    await paste();
    expect(animation.animators[targetBone.uuid].keyframes).toHaveLength(1);
  });
});
