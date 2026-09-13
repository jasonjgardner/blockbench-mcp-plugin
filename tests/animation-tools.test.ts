import { beforeAll, beforeEach, expect, test } from "bun:test";
import { required } from "@/tests/helpers/assertions";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
import { createUndoHost } from "@/tests/helpers/undo-host";

/** Keyframe arrays an animator double stores: bone transform channels plus the effect animator's particles. */
type Channel = "position" | "rotation" | "scale" | "particle";

/** Keyframe data as tools pass it to `addKeyframe`, and as snapshots record it. */
interface IFrameData {
  time: number;
  channel: Channel;
  interpolation?: string;
  data_points: Record<string, unknown>[];
}

/** Immutable copy of one animation's settings and keyframes, keyed by animator id. */
interface ISnapshot {
  uuid: string;
  length: number;
  loop: string;
  snapping: number;
  animators: Record<string, IFrameData[]>;
}

/** Undo aspects the animation tools pass to `Undo.initEdit`. */
interface IAnimationAspects {
  animations: TestAnimation[];
}

/** The parts of Blockbench's `Timeline` global the timeline and selection tools drive. */
interface ITimeline {
  selected: TestFrame[];
  time: number;
  playing: boolean;
  start(): void;
  pause(): void;
  setTime(time: number): void;
}

let tools: IToolFixture;
let selectionEdits = 0;
let failFrameCreation = false;
let activeMode = "edit";
const group = { name: "logo", uuid: "logo-group" };
const timeline: ITimeline = {
  selected: [],
  time: 0,
  playing: false,
  start() {
    this.playing = true;
  },
  pause() {
    this.playing = false;
  },
  setTime(time) {
    this.time = time;
  },
};

class TestFrame {
  time: number;
  channel: Channel;
  interpolation: string;
  data_points: Record<string, unknown>[];
  uniform = true;
  selected = false;
  values = [0, 0, 0];
  constructor(data: IFrameData, readonly animator: TestAnimator) {
    this.time = data.time;
    this.channel = data.channel;
    this.interpolation = data.interpolation ?? "step";
    this.data_points = data.data_points;
    if (this.channel === "scale") this.values = [1, 1, 1];
  }
  set(axis: "x" | "y" | "z", value: number) {
    const index = { x: 0, y: 1, z: 2 }[axis];
    if (this.uniform && this.channel === "scale") {
      this.values.fill(value);
      return;
    }
    this.values[index] = value;
  }
  remove() {
    const frames = this.animator[this.channel];
    frames.splice(frames.indexOf(this), 1);
  }
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
  get keyframes() {
    return [...this.position, ...this.rotation, ...this.scale, ...this.particle];
  }
  addKeyframe(data: IFrameData) {
    if (failFrameCreation) throw new Error("Frame creation failed");
    const frame = new TestFrame(data, this);
    this[data.channel].push(frame);
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
  constructor(data: Partial<TestAnimation> = {}) {
    Object.assign(this, data);
  }
  add() {
    TestAnimation.all.push(this);
    return this;
  }
  select() {
    TestAnimation.selected = this;
    return this;
  }
  setLength(length = this.length) {
    const frameTimes = Object.values(this.animators).flatMap((animator) => animator.keyframes.map(({ time }) => time));
    this.length = Math.max(length, ...frameTimes);
  }
  setLoop(loop: string) {
    this.loop = loop;
  }
  getBoneAnimator(target: { uuid: string }) {
    return this.animators[target.uuid] ??= new TestAnimator();
  }
}
function snapshot(animations: TestAnimation[]): ISnapshot[] {
  return animations.map((animation) => ({
    uuid: animation.uuid, length: animation.length, loop: animation.loop, snapping: animation.snapping,
    animators: Object.fromEntries(Object.entries(animation.animators).map(([id, animator]) => [id, animator.keyframes.map((frame) => ({
      time: frame.time, channel: frame.channel, interpolation: frame.interpolation,
      data_points: [{ x: frame.values[0], y: frame.values[1], z: frame.values[2] }],
    }))])),
  }));
}
/**
 * Reverts animation creation, the only edit these tests cancel: animations recorded in the replaced
 * state (`reference`) but absent from `target` were created inside the transaction and are removed.
 */
function removeCreatedAnimations(target: ISnapshot[], reference: ISnapshot[]): void {
  const kept = new Set(target.map(({ uuid }) => uuid));
  const created = new Set(reference.map(({ uuid }) => uuid).filter((uuid) => !kept.has(uuid)));
  TestAnimation.all = TestAnimation.all.filter((animation) => !created.has(animation.uuid));
}
const undo = createUndoHost(
  { restore: removeCreatedAnimations, snapshot: ({ animations }: IAnimationAspects) => snapshot(animations) },
  {
    initSelection() {},
    finishSelection() {
      selectionEdits++;
    },
  },
);

beforeAll(async () => {
  tools = await loadToolDefinitions({ entries: ["server/tools/animation.ts"], register: ["registerAnimationTools"] });
});
beforeEach(() => {
  TestAnimation.all = [];
  TestAnimation.selected = null;
  undo.reset();
  selectionEdits = 0;
  failFrameCreation = false;
  activeMode = "edit";
  timeline.selected = [];
  timeline.time = 0;
  timeline.playing = false;
});
// Registered after the reset above so each test's globals see freshly reset state.
useGlobals(() => ({
  Animation: TestAnimation,
  Animator: { preview() {} },
  EffectAnimator: TestAnimator,
  Format: { animation_mode: true },
  Group: { all: [group] },
  Modes: {
    options: {
      animate: {
        select() {
          activeMode = "animate";
        },
      },
    },
  },
  Project: {},
  Timeline: timeline,
  Undo: undo,
  updateKeyframeSelection() {},
}));

test("creation uses native signs and linear interpolation and records the complete new animation", async () => {
  const result = await tools.call("create_animation", { name: "spin", loop: true, animation_length: 4, bones: { logo: [{ time: 0, rotation: [0, 0, 0] }, { time: 4, rotation: [0, 360, 0] }] } });
  expect(JSON.parse(String(result))).toMatchObject({ uuid: TestAnimation.all[0]?.uuid, name: "animation.spin", length: 4, loop: "loop", bones: 1 });
  const edit = required(undo.lastEdit, "create_animation undo entry");
  expect(edit.before).toEqual([]);
  expect(edit.after[0]?.animators[group.uuid]?.[1]).toMatchObject({ interpolation: "linear", data_points: [{ x: 0, y: 360, z: 0 }] });
  expect(TestAnimation.selected).toBe(TestAnimation.all[0]);
});
test("creation preserves zero and nonuniform scales and native position coordinates", async () => {
  await tools.call("create_animation", { name: "scales", bones: { logo: [{ time: 0, scale: 0, position: [1, 2, 3] }, { time: 1, scale: [1, 2, 3] }] } });
  const animator = TestAnimation.all[0]?.animators[group.uuid];
  expect(animator?.scale.map((frame) => frame.values)).toEqual([[0, 0, 0], [1, 2, 3]]);
  expect(animator?.position[0]?.values).toEqual([1, 2, 3]);
});
test("particle strings become effect data points", async () => {
  await tools.call("create_animation", { name: "effects", bones: {}, particle_effects: { "0": "sparkle" } });
  expect(TestAnimation.all[0]?.animators.effects?.particle[0]?.data_points).toEqual([{ effect: "sparkle" }]);
});
test.each([
  {
    label: "missing bone",
    input: { bones: { missing: [{ time: 0, rotation: [0, 0, 0] }] } },
    message: 'Bone/group "missing" not found.',
  },
  {
    label: "non-numeric particle timestamp",
    input: { bones: {}, particle_effects: { invalid: "sparkle" } },
    message: 'Invalid particle timestamp "invalid"; use nonnegative seconds.',
  },
  {
    label: "length shorter than the last keyframe",
    input: { bones: { logo: [{ time: 4, rotation: [0, 90, 0] }] }, animation_length: 2 },
    message: "animation_length must include the last keyframe at 4 seconds.",
  },
])("invalid creation leaves animations and Undo untouched: $label", async ({ input, message }) => {
  await expect(tools.call("create_animation", { name: "invalid", ...input })).rejects.toThrow(message);
  expect(TestAnimation.all).toEqual([]);
  expect(undo.starts).toBe(0);
});
test("failed creation rolls back the new animation", async () => {
  failFrameCreation = true;
  await expect(tools.call("create_animation", { name: "invalid", bones: { logo: [{ time: 0, rotation: [0, 0, 0] }] } })).rejects.toThrow("Frame creation failed");
  expect(TestAnimation.all).toEqual([]);
  expect(undo.pending).toBeUndefined();
  expect(undo.history).toEqual([]);
});
test("duplicate channel timestamps in creation are rejected before Undo", async () => {
  await expect(tools.call("create_animation", { name: "duplicate", bones: { logo: [{ time: 0, rotation: [0, 0, 0] }, { time: 0, rotation: [0, 90, 0] }] } })).rejects.toThrow('Duplicate rotation keyframe at 0 seconds for "logo".');
  expect(TestAnimation.all).toEqual([]);
  expect(undo.starts).toBe(0);
});
test("distinct channels at the same timestamp remain valid", async () => {
  await tools.call("create_animation", { name: "channels", bones: { logo: [{ time: 0, rotation: [0, 90, 0] }, { time: 0, position: [1, 2, 3] }] } });
  const animator = TestAnimation.all[0]?.animators[group.uuid];
  expect(animator?.rotation).toHaveLength(1);
  expect(animator?.position).toHaveLength(1);
});
test("manage snapshots before creating an animator and writes requested times without timeline snapping", async () => {
  const animation = new TestAnimation().add().select();
  await tools.call("manage_keyframes", { action: "create", bone_name: "logo", channel: "rotation", keyframes: [{ time: 0.013, values: [0, 90, 0] }] });
  const edit = required(undo.lastEdit, "manage_keyframes undo entry");
  expect(edit.before[0]?.animators).toEqual({});
  expect(edit.after[0]?.animators[group.uuid]?.[0]).toMatchObject({ time: 0.013, data_points: [{ x: 0, y: 90, z: 0 }] });
  expect(animation.animators[group.uuid]?.rotation).toHaveLength(1);
});
test.each(["edit", "delete", "select"])("missing frames for %s do not create animators or edit Undo", async (action) => {
  const animation = new TestAnimation().add().select();
  await expect(tools.call("manage_keyframes", { action, bone_name: "logo", channel: "rotation", keyframes: [{ time: 0 }] })).rejects.toThrow("No keyframe exists at one or more requested times; no keyframes changed.");
  expect(animation.animators).toEqual({});
  expect(undo.starts).toBe(0);
  expect(undo.pending).toBeUndefined();
});
test.each(["create", "edit", "delete", "select"])("duplicate requested times for %s fail before Undo or selection", async (action) => {
  const animation = new TestAnimation().add().select();
  animation.getBoneAnimator(group).addKeyframe({ time: 0, channel: "rotation", data_points: [{}] });
  const original = snapshot([animation]);
  await expect(tools.call("manage_keyframes", { action, bone_name: "logo", channel: "rotation", keyframes: [{ time: 0 }, { time: 0 }] })).rejects.toThrow("Duplicate requested keyframe times");
  expect(snapshot([animation])).toEqual(original);
  expect(undo.starts).toBe(0);
  expect(selectionEdits).toBe(0);
});
test("selecting several frames preserves the complete selection without a model edit", async () => {
  await tools.call("create_animation", { name: "select", bones: { logo: [{ time: 0, rotation: [0, 0, 0] }, { time: 1, rotation: [0, 90, 0] }] } });
  await tools.call("manage_keyframes", { action: "select", bone_name: "logo", channel: "rotation", keyframes: [{ time: 0 }, { time: 1 }] });
  expect(timeline.selected).toHaveLength(2);
  expect(selectionEdits).toBe(1);
  // Only the creation entry exists: selecting committed no model edit.
  expect(undo.history).toHaveLength(1);
});
test.each([
  { action: "set_length", length: 8, field: "length", value: 8 },
  { action: "set_fps", fps: 60, field: "snapping", value: 60 },
  { action: "loop", loop_mode: "loop", field: "loop", value: "loop" },
])("timeline $action records the explicit target, preserving another selected animation", async ({ field, value, ...input }) => {
  const target = new TestAnimation().add();
  const selected = new TestAnimation().add().select();
  await tools.call("animation_timeline", { animation_id: target.uuid, ...input });
  const edit = required(undo.lastEdit, "animation_timeline undo entry");
  expect(edit.before[0]?.uuid).toBe(target.uuid);
  expect(edit.after[0]).toHaveProperty(field, value);
  expect(TestAnimation.selected).toBe(selected);
});
test("timeline play targets the requested animation and stop returns to time zero", async () => {
  const animation = new TestAnimation().add();
  await tools.call("animation_timeline", { animation_id: animation.uuid, action: "play" });
  expect(TestAnimation.selected).toBe(animation);
  expect(timeline.playing).toBe(true);
  timeline.time = 2;
  await tools.call("animation_timeline", { action: "stop" });
  expect(timeline.playing).toBe(false);
  expect(timeline.time).toBe(0);
  expect(undo.history).toEqual([]);
});
test("timeline scrubbing enters animation mode for the explicit target without starting playback", async () => {
  const animation = new TestAnimation().add();
  new TestAnimation().add().select();
  await tools.call("animation_timeline", { animation_id: animation.uuid, action: "set_time", time: 1 });
  expect(TestAnimation.selected).toBe(animation);
  expect(activeMode).toBe("animate");
  expect(timeline.time).toBe(1);
  expect(timeline.playing).toBe(false);
  expect(undo.history).toEqual([]);
});
test("invalid timeline requests leave selection and model unchanged", async () => {
  const target = new TestAnimation().add();
  target.getBoneAnimator(group).addKeyframe({ time: 4, channel: "rotation", data_points: [{}] });
  const selected = new TestAnimation().add().select();
  await expect(tools.call("animation_timeline", { animation_id: target.uuid, action: "set_length", length: 2 })).rejects.toThrow("Length must include the last keyframe at 4 seconds.");
  // Rejected by the schema's minimum FPS; the bundle's ZodError message is its JSON issue list.
  await expect(tools.call("animation_timeline", { animation_id: target.uuid, action: "set_fps", fps: 1 })).rejects.toThrow(/"message": "Number must be greater than or equal to 10",\s*"path": \[\s*"fps"\s*\]/);
  await expect(tools.call("animation_timeline", { animation_id: target.uuid, action: "loop" })).rejects.toThrow("loop_mode parameter required for loop action.");
  expect(TestAnimation.selected).toBe(selected);
  expect(undo.starts).toBe(0);
});
