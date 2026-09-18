import { beforeEach, expect, test } from "bun:test";
import { required } from "@/tests/helpers/assertions";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
import { createUndoHost } from "@/tests/helpers/undo-host";

type Handler = (event: unknown) => void;
interface IFrameData { uuid?: string; channel: string; time: number; data_points: { visible: boolean }[] }
interface IAnimationState { length: number; loop: string; animators?: Record<string, IFrameData[]> }
interface ISave { animations: Record<string, IAnimationState>; mcp_full_animation_restore?: boolean }
interface IAspects { animations: HostAnimation[]; mcp_full_animation_restore?: boolean }
const handlers = new Map<string, Set<Handler>>();
const bone = { uuid: "bone-uuid", name: "Bone" };
let fixture: IToolFixture;
let animation: HostAnimation;
let failure: "none" | "missing_frame" | "creation" | "refresh" = "none";
let createdAnimatorDuringUndo = false;

class HostFrame {
  readonly uuid: string;
  readonly channel: string;
  readonly time: number;
  readonly data_points: { visible: boolean }[];
  constructor(readonly animator: HostAnimator, data: IFrameData) {
    this.uuid = data.uuid ?? crypto.randomUUID();
    this.channel = data.channel;
    this.time = data.time;
    this.data_points = structuredClone(data.data_points);
  }
  save(): IFrameData { return { uuid: this.uuid, channel: this.channel, time: this.time, data_points: structuredClone(this.data_points) }; }
  remove(): void { this.animator.keyframes.splice(this.animator.keyframes.indexOf(this), 1); }
}
class HostAnimator {
  keyframes: HostFrame[] = [];
  addKeyframe(data: IFrameData): HostFrame | undefined {
    if (failure === "missing_frame") return undefined;
    const frame = new HostFrame(this, data);
    this.keyframes.push(frame);
    if (failure === "creation") throw new Error("Native keyframe creation failed");
    return frame;
  }
}
class HostAnimation {
  static all: HostAnimation[] = [];
  static selected: HostAnimation | null = null;
  readonly uuid = crypto.randomUUID();
  readonly name = "motion";
  length = 1;
  loop = "once";
  animators: Record<string, HostAnimator> = {};
  getBoneAnimator(group: { uuid: string }): HostAnimator {
    const existing = this.animators[group.uuid];
    if (existing) return existing;
    createdAnimatorDuringUndo = Boolean(undo.pending);
    return this.animators[group.uuid] = new HostAnimator();
  }
  removeAnimator(id: string): void { delete this.animators[id]; }
  save(): IAnimationState {
    const animators = Object.fromEntries(Object.entries(this.animators).map(([id, animator]) => [id, animator.keyframes.map(frame => frame.save())]));
    return { length: this.length, loop: this.loop, ...(Object.keys(animators).length ? { animators } : {}) };
  }
  extend(state: IAnimationState): void {
    // Native Animation.extend clamps length against OLD keys, then merges saved
    // animators without removing those absent from the full snapshot.
    this.length = Math.max(state.length, ...Object.values(this.animators).flatMap(animator => animator.keyframes.map(frame => frame.time)));
    this.loop = state.loop;
    Object.entries(state.animators ?? {}).forEach(([id, frames]) => {
      const animator = this.animators[id] ??= new HostAnimator();
      animator.keyframes = frames.map(frame => new HostFrame(animator, frame));
    });
  }
}
function emit(name: string, event: unknown): void { handlers.get(name)?.forEach(handler => handler(event)); }
const undo = createUndoHost({
  snapshot(aspects: IAspects): ISave {
    const save: ISave = { animations: Object.fromEntries(aspects.animations.map(target => [target.uuid, target.save()])) };
    emit("create_undo_save", { save, aspects });
    return save;
  },
  restore(save: ISave, reference: ISave): void {
    Object.entries(save.animations).forEach(([id, state]) => HostAnimation.all.find(target => target.uuid === id)?.extend(state));
    emit("load_undo_save", { save, reference });
  },
});

beforeEach(() => {
  handlers.clear();
  animation = new HostAnimation();
  HostAnimation.all = [animation];
  HostAnimation.selected = animation;
  failure = "none";
  createdAnimatorDuringUndo = false;
  undo.reset();
});
useGlobals(() => ({
  Blockbench: {
    on(name: string, handler: Handler) { handlers.set(name, new Set([...(handlers.get(name) ?? []), handler])); },
    removeListener(name: string, handler: Handler) { handlers.get(name)?.delete(handler); },
  },
  Animation: HostAnimation, Group: { all: [bone] }, Format: { id: "hytale_character" },
  Timeline: { vue: { _data: { animation_length: 1 } } }, BarItems: {}, Undo: undo,
  updateKeyframeSelection() { if (failure === "refresh") throw new Error("Native selection refresh failed"); },
}));
beforeEach(async () => {
  // Load the actual lifecycle listener into the same private bundle as the tools.
  fixture = await loadToolDefinitions({
    entries: ["server/tools/hytale.ts", "lib/animation-undo.ts"],
    register: ["registerHytaleTools", "setupAnimationUndoRestore"],
  });
});

test("visibility creation starts Undo before creating an animator, preserves native datapoints and restores exact state", async () => {
  const before = animation.save();
  await fixture.call("hytale_create_visibility_keyframe", { bone_name: bone.name, time: 1.123, visible: false });
  const frame = required(animation.animators[bone.uuid]?.keyframes[0], "created visibility frame");
  expect(createdAnimatorDuringUndo).toBe(true);
  expect(frame).toMatchObject({ channel: "visibility", time: 1.123, data_points: [{ visible: false }] });
  expect(undo.finishes).toBe(1);
  expect(undo.lastEdit?.before.mcp_full_animation_restore).toBe(true);
  expect(undo.lastEdit?.after.mcp_full_animation_restore).toBe(true);
  const after = animation.save();
  undo.undo();
  expect(animation.save()).toEqual(before);
  undo.redo();
  expect(animation.save()).toEqual(after);
});

test.each([0, 10000])("visibility accepts the native time boundary %s without snapping", async time => {
  await fixture.call("hytale_create_visibility_keyframe", { animation_id: animation.uuid, bone_name: bone.name, time, visible: true });
  expect(animation.animators[bone.uuid]?.keyframes[0]?.time).toBe(time);
});

test.each([-1, Infinity, NaN, 10000.001])("invalid visibility time %s rejects before Undo and animator creation", async time => {
  await expect(fixture.call("hytale_create_visibility_keyframe", { bone_name: bone.name, time, visible: false })).rejects.toThrow();
  expect(undo.starts).toBe(0);
  expect(Object.keys(animation.animators)).toEqual([]);
});

const failures: ("missing_frame" | "creation" | "refresh")[] = ["missing_frame", "creation", "refresh"];
test.each(failures)("%s failure rolls back a new visibility animator and records no success edit", async fail => {
  failure = fail;
  const before = animation.save();
  await expect(fixture.call("hytale_create_visibility_keyframe", { bone_name: bone.name, time: 2, visible: false })).rejects.toThrow();
  expect(animation.save()).toEqual(before);
  expect(undo.finishes).toBe(0);
  expect(undo.pending).toBeUndefined();
  expect(undo.cancels).toBe(1);
});

test("visibility and loop resolution failures reject before Undo", async () => {
  await expect(fixture.call("hytale_create_visibility_keyframe", { animation_id: "missing", bone_name: bone.name, time: 0, visible: true })).rejects.toThrow("not found");
  await expect(fixture.call("hytale_create_visibility_keyframe", { bone_name: "missing", time: 0, visible: true })).rejects.toThrow("not found");
  await expect(fixture.call("hytale_set_animation_loop", { animation_id: "missing", loop_mode: "hold" })).rejects.toThrow("not found");
  HostAnimation.selected = null;
  await expect(fixture.call("hytale_set_animation_loop", { loop_mode: "hold" })).rejects.toThrow("No animation selected");
  expect(undo.starts).toBe(0);
});

test("loop edits use marked snapshots so native old-frame length clamping cannot alter Undo/Redo", async () => {
  animation.getBoneAnimator(bone).addKeyframe({ channel: "visibility", time: 3, data_points: [{ visible: false }] });
  const before = animation.save();
  await fixture.call("hytale_set_animation_loop", { animation_id: animation.uuid, loop_mode: "hold" });
  expect(animation.loop).toBe("hold");
  expect(undo.lastEdit?.before.mcp_full_animation_restore).toBe(true);
  const after = animation.save();
  undo.undo();
  expect(animation.save()).toEqual(before);
  undo.redo();
  expect(animation.save()).toEqual(after);
});
