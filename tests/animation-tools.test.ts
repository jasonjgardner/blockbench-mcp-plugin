import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { z } from "zod";

type Tool = { parameters: z.ZodType<unknown>; execute(input: unknown): Promise<unknown> };
type FrameData = { time: number; channel: string; interpolation?: string; data_points: Record<string, unknown>[] };
type Snapshot = { uuid: string; length: number; loop: string; snapping: number; animators: Record<string, FrameData[]> };
const globals = new Map<string, PropertyDescriptor | undefined>();
let definitions: Map<string, Tool>;
let before: Snapshot[];
let after: Snapshot[];
let transaction: { animations: TestAnimation[] } | undefined;
let selectionEdits = 0;
let failFrameCreation = false;
let activeMode = "edit";
const group = { name: "logo", uuid: "logo-group" };
const timeline = { selected: [] as TestFrame[], time: 0, playing: false,
  start() { this.playing = true; }, pause() { this.playing = false; },
  setTime(time: number) { this.time = time; },
};

class TestFrame {
  time: number;
  channel: string;
  interpolation: string;
  data_points: Record<string, unknown>[];
  uniform = true;
  selected = false;
  values = [0, 0, 0];
  constructor(data: FrameData, readonly animator: TestAnimator) {
    this.time = data.time;
    this.channel = data.channel;
    this.interpolation = data.interpolation ?? "step";
    this.data_points = data.data_points;
    if (this.channel === "scale") this.values = [1, 1, 1];
  }
  set(axis: "x" | "y" | "z", value: number) {
    const index = { x: 0, y: 1, z: 2 }[axis];
    if (this.uniform && this.channel === "scale") { this.values.fill(value); return; }
    this.values[index] = value;
  }
  remove() { this.animator[this.channel as "rotation"].splice(this.animator[this.channel as "rotation"].indexOf(this), 1); }
  select(event?: { ctrlOrCmd?: boolean }) {
    if (!event?.ctrlOrCmd) timeline.selected.splice(0);
    timeline.selected.push(this);
    this.selected = true;
  }
}
class TestAnimator {
  position: TestFrame[] = [];
  rotation: TestFrame[] = [];
  scale: TestFrame[] = [];
  particle: TestFrame[] = [];
  get keyframes() { return [...this.position, ...this.rotation, ...this.scale, ...this.particle]; }
  addKeyframe(data: FrameData) {
    if (failFrameCreation) throw new Error("Frame creation failed");
    const frame = new TestFrame(data, this);
    this[data.channel as "rotation"].push(frame);
    return frame;
  }
}
class TestAnimation {
  static all: TestAnimation[] = [];
  static selected: TestAnimation | null = null;
  uuid = crypto.randomUUID();
  name = "";
  length = 0;
  loop = "once";
  snapping = 24;
  animators: Record<string, TestAnimator> = {};
  constructor(data: Partial<TestAnimation> = {}) { Object.assign(this, data); }
  add() { TestAnimation.all.push(this); return this; }
  select() { TestAnimation.selected = this; return this; }
  setLength(length = this.length) { this.length = Math.max(length, ...Object.values(this.animators).flatMap((animator) => animator.keyframes.map(({ time }) => time))); }
  setLoop(loop: string) { this.loop = loop; }
  getBoneAnimator(target: { uuid: string }) { return this.animators[target.uuid] ??= new TestAnimator(); }
}
function snapshot(animations: TestAnimation[]): Snapshot[] {
  return animations.map((animation) => ({
    uuid: animation.uuid, length: animation.length, loop: animation.loop, snapping: animation.snapping,
    animators: Object.fromEntries(Object.entries(animation.animators).map(([id, animator]) => [id, animator.keyframes.map((frame) => ({
      time: frame.time, channel: frame.channel, interpolation: frame.interpolation,
      data_points: [{ x: frame.values[0], y: frame.values[1], z: frame.values[2] }],
    }))])),
  }));
}
async function call(name: string, input: unknown): Promise<unknown> {
  const tool = definitions.get(name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.execute(tool.parameters.parse(input));
}

beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [`${import.meta.dir}/../server/tools/animation.ts`], target: "bun", format: "cjs",
    plugins: [{ name: "capture-animation-tools", setup(build) {
      build.onLoad({ filter: /[/\\]lib[/\\]factories\.ts$/ }, () => ({
        contents: "export const definitions = new Map(); export function createTool(name, tool) { definitions.set(name, tool); }", loader: "js",
      }));
      build.onLoad({ filter: /[/\\]server[/\\]tools[/\\]animation\.ts$/ }, async ({ path }) => ({
        contents: `${await Bun.file(path).text()}\nexport { definitions } from '@/lib/factories';`, loader: "ts",
      }));
    } }],
  });
  if (!result.success) throw new AggregateError(result.logs, "Animation fixture build failed");
  const path = `${import.meta.dir}/.animation-tools-${crypto.randomUUID()}.cjs`;
  await Bun.write(path, result.outputs[0]);
  const fixture = await import(path).finally(() => Bun.file(path).delete()) as {
    registerAnimationTools(): void; definitions: Map<string, Tool>;
  };
  fixture.registerAnimationTools();
  definitions = fixture.definitions;
});
beforeEach(() => {
  TestAnimation.all = [];
  TestAnimation.selected = null;
  before = [];
  after = [];
  transaction = undefined;
  selectionEdits = 0;
  failFrameCreation = false;
  activeMode = "edit";
  timeline.selected = [];
  timeline.time = 0;
  timeline.playing = false;
  const values = {
    Project: {}, Format: { animation_mode: true }, Group: { all: [group] }, Animation: TestAnimation,
    EffectAnimator: TestAnimator, Animator: { preview() {} }, Timeline: timeline,
    Modes: { options: { animate: { select() { activeMode = "animate"; } } } }, updateKeyframeSelection() {},
    Undo: {
      initEdit(value: { animations: TestAnimation[] }) { transaction = value; before = snapshot(value.animations); },
      finishEdit() { after = snapshot(transaction?.animations ?? []); transaction = undefined; },
      cancelEdit(revert: boolean) {
        if (revert && before.length === 0) TestAnimation.all = TestAnimation.all.filter((animation) => !transaction?.animations.includes(animation));
        transaction = undefined;
      },
      initSelection() {}, finishSelection() { selectionEdits++; },
    },
  };
  Object.entries(values).forEach(([key, value]) => {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  });
});
afterEach(() => {
  globals.forEach((descriptor, key) => {
    if (descriptor) { Object.defineProperty(globalThis, key, descriptor); return; }
    Reflect.deleteProperty(globalThis, key);
  });
  globals.clear();
});

test("creation uses native signs and linear interpolation and records the complete new animation", async () => {
  const result = await call("create_animation", { name: "spin", loop: true, animation_length: 4, bones: { logo: [{ time: 0, rotation: [0, 0, 0] }, { time: 4, rotation: [0, 360, 0] }] } });
  expect(JSON.parse(String(result))).toMatchObject({ uuid: TestAnimation.all[0]?.uuid, name: "animation.spin", length: 4, loop: "loop", bones: 1 });
  expect(before).toEqual([]);
  expect(after[0]?.animators[group.uuid]?.[1]).toMatchObject({ interpolation: "linear", data_points: [{ x: 0, y: 360, z: 0 }] });
  expect(TestAnimation.selected).toBe(TestAnimation.all[0]);
});
test("creation preserves zero and nonuniform scales and native position coordinates", async () => {
  await call("create_animation", { name: "scales", bones: { logo: [{ time: 0, scale: 0, position: [1, 2, 3] }, { time: 1, scale: [1, 2, 3] }] } });
  const animator = TestAnimation.all[0]?.animators[group.uuid];
  expect(animator?.scale.map((frame) => frame.values)).toEqual([[0, 0, 0], [1, 2, 3]]);
  expect(animator?.position[0]?.values).toEqual([1, 2, 3]);
});
test("particle strings become effect data points", async () => {
  await call("create_animation", { name: "effects", bones: {}, particle_effects: { "0": "sparkle" } });
  expect(TestAnimation.all[0]?.animators.effects?.particle[0]?.data_points).toEqual([{ effect: "sparkle" }]);
});
test.each([
  { bones: { missing: [{ time: 0, rotation: [0, 0, 0] }] } },
  { bones: {}, particle_effects: { invalid: "sparkle" } },
  { bones: { logo: [{ time: 4, rotation: [0, 90, 0] }] }, animation_length: 2 },
])("invalid creation leaves animations and Undo untouched: %j", async (input) => {
  await expect(call("create_animation", { name: "invalid", ...input })).rejects.toThrow();
  expect(TestAnimation.all).toEqual([]);
  expect(transaction).toBeUndefined();
});
test("failed creation rolls back the new animation", async () => {
  failFrameCreation = true;
  await expect(call("create_animation", { name: "invalid", bones: { logo: [{ time: 0, rotation: [0, 0, 0] }] } })).rejects.toThrow("Frame creation failed");
  expect(TestAnimation.all).toEqual([]);
  expect(transaction).toBeUndefined();
});
test("duplicate channel timestamps in creation are rejected before Undo", async () => {
  await expect(call("create_animation", { name: "duplicate", bones: { logo: [{ time: 0, rotation: [0, 0, 0] }, { time: 0, rotation: [0, 90, 0] }] } })).rejects.toThrow("Duplicate rotation keyframe");
  expect(TestAnimation.all).toEqual([]);
  expect(transaction).toBeUndefined();
});
test("distinct channels at the same timestamp remain valid", async () => {
  await call("create_animation", { name: "channels", bones: { logo: [{ time: 0, rotation: [0, 90, 0] }, { time: 0, position: [1, 2, 3] }] } });
  const animator = TestAnimation.all[0]?.animators[group.uuid];
  expect(animator?.rotation).toHaveLength(1);
  expect(animator?.position).toHaveLength(1);
});
test("manage snapshots before creating an animator and writes requested times without timeline snapping", async () => {
  const animation = new TestAnimation().add().select();
  await call("manage_keyframes", { action: "create", bone_name: "logo", channel: "rotation", keyframes: [{ time: 0.013, values: [0, 90, 0] }] });
  expect(before[0]?.animators).toEqual({});
  expect(after[0]?.animators[group.uuid]?.[0]).toMatchObject({ time: 0.013, data_points: [{ x: 0, y: 90, z: 0 }] });
  expect(animation.animators[group.uuid]?.rotation).toHaveLength(1);
});
test.each(["edit", "delete", "select"])("missing frames for %s do not create animators or edit Undo", async (action) => {
  const animation = new TestAnimation().add().select();
  await expect(call("manage_keyframes", { action, bone_name: "logo", channel: "rotation", keyframes: [{ time: 0 }] })).rejects.toThrow("No keyframe exists");
  expect(animation.animators).toEqual({});
  expect(before).toEqual([]);
  expect(transaction).toBeUndefined();
});
test.each(["create", "edit", "delete", "select"])("duplicate requested times for %s fail before Undo or selection", async (action) => {
  const animation = new TestAnimation().add().select();
  animation.getBoneAnimator(group).addKeyframe({ time: 0, channel: "rotation", data_points: [{}] });
  const original = snapshot([animation]);
  await expect(call("manage_keyframes", { action, bone_name: "logo", channel: "rotation", keyframes: [{ time: 0 }, { time: 0 }] })).rejects.toThrow("Duplicate requested keyframe times");
  expect(snapshot([animation])).toEqual(original);
  expect(transaction).toBeUndefined();
  expect(selectionEdits).toBe(0);
});
test("selecting several frames preserves the complete selection without a model edit", async () => {
  await call("create_animation", { name: "select", bones: { logo: [{ time: 0, rotation: [0, 0, 0] }, { time: 1, rotation: [0, 90, 0] }] } });
  before = []; after = [];
  await call("manage_keyframes", { action: "select", bone_name: "logo", channel: "rotation", keyframes: [{ time: 0 }, { time: 1 }] });
  expect(timeline.selected).toHaveLength(2);
  expect(selectionEdits).toBe(1);
  expect(after).toEqual([]);
});
test.each([
  { action: "set_length", length: 8, field: "length", value: 8 },
  { action: "set_fps", fps: 60, field: "snapping", value: 60 },
  { action: "loop", loop_mode: "loop", field: "loop", value: "loop" },
])("timeline $action records the explicit target, preserving another selected animation", async ({ field, value, ...input }) => {
  const target = new TestAnimation().add();
  const selected = new TestAnimation().add().select();
  await call("animation_timeline", { animation_id: target.uuid, ...input });
  expect(before[0]?.uuid).toBe(target.uuid);
  expect(after[0]).toHaveProperty(field, value);
  expect(TestAnimation.selected).toBe(selected);
});
test("timeline play targets the requested animation and stop returns to time zero", async () => {
  const animation = new TestAnimation().add();
  await call("animation_timeline", { animation_id: animation.uuid, action: "play" });
  expect(TestAnimation.selected).toBe(animation);
  expect(timeline.playing).toBe(true);
  timeline.time = 2;
  await call("animation_timeline", { action: "stop" });
  expect(timeline.playing).toBe(false);
  expect(timeline.time).toBe(0);
  expect(after).toEqual([]);
});
test("timeline scrubbing enters animation mode for the explicit target without starting playback", async () => {
  const animation = new TestAnimation().add();
  new TestAnimation().add().select();
  await call("animation_timeline", { animation_id: animation.uuid, action: "set_time", time: 1 });
  expect(TestAnimation.selected).toBe(animation);
  expect(activeMode).toBe("animate");
  expect(timeline.time).toBe(1);
  expect(timeline.playing).toBe(false);
  expect(after).toEqual([]);
});
test("invalid timeline requests leave selection and model unchanged", async () => {
  const target = new TestAnimation().add();
  target.getBoneAnimator(group).addKeyframe({ time: 4, channel: "rotation", data_points: [{}] });
  const selected = new TestAnimation().add().select();
  await expect(call("animation_timeline", { animation_id: target.uuid, action: "set_length", length: 2 })).rejects.toThrow("last keyframe");
  await expect(call("animation_timeline", { animation_id: target.uuid, action: "set_fps", fps: 1 })).rejects.toThrow();
  await expect(call("animation_timeline", { animation_id: target.uuid, action: "loop" })).rejects.toThrow("loop_mode");
  expect(TestAnimation.selected).toBe(selected);
  expect(before).toEqual([]);
});
