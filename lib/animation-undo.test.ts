import { afterEach, beforeEach, expect, test } from "bun:test";
import { runUndoableAnimationEdit, setupAnimationUndoRestore, teardownAnimationUndoRestore } from "./animation-undo";
import { runUndoableEdit } from "./undo";
import { useGlobals } from "@/tests/helpers/globals";
import { createUndoHost } from "@/tests/helpers/undo-host";

type Handler = (event: unknown) => void;
interface IAnimatorSnapshot { keyframes?: number[] }
interface IAnimationSnapshot { length: number; animators?: Record<string, IAnimatorSnapshot> }
interface ISave { animations: Record<string, IAnimationSnapshot>; mcp_full_animation_restore?: boolean }
interface IAspects { animations: TestAnimation[]; mcp_full_animation_restore?: boolean }
const handlers = new Map<string, Set<Handler>>();
let animations: TestAnimation[];
let selectedAnimation: TestAnimation;
let sliderUpdates: number;
const timeline = { animators: [] as TestAnimator[], selected: [] as TestFrame[], selected_animator: null as TestAnimator | null, vue: { _data: { animation_length: 1 } } };

class TestFrame {
  constructor(readonly animator: TestAnimator, readonly time: number) {}
  remove(): void {
    this.animator.keyframes.splice(this.animator.keyframes.indexOf(this), 1);
    const selectedIndex = timeline.selected.indexOf(this);
    if (selectedIndex >= 0) timeline.selected.splice(selectedIndex, 1);
  }
}
class TestAnimator {
  keyframes: TestFrame[] = [];
  constructor(readonly animation: TestAnimation) {}
  add(time: number): TestFrame {
    const frame = new TestFrame(this, time);
    this.keyframes.push(frame);
    return frame;
  }
}
class TestAnimation {
  length = 1;
  animators: Record<string, TestAnimator> = {};
  constructor(readonly uuid: string) {}
  animator(id: string): TestAnimator { return this.animators[id] ??= new TestAnimator(this); }
  setLength(length = this.length): void {
    this.length = Math.max(length, 0, ...Object.values(this.animators).flatMap(animator => animator.keyframes.map(frame => frame.time)));
  }
  removeAnimator(id: string): void {
    const animator = this.animators[id];
    const index = timeline.animators.indexOf(animator);
    if (index >= 0) timeline.animators.splice(index, 1);
    if (timeline.selected_animator === animator) timeline.selected_animator = null;
    delete this.animators[id];
  }
  save(): IAnimationSnapshot {
    const animators = Object.fromEntries(Object.entries(this.animators).map(([id, animator]) => [id, { keyframes: animator.keyframes.map(frame => frame.time) }]));
    return { length: this.length, ...Object.keys(animators).length ? { animators } : {} };
  }
  extend(saved: IAnimationSnapshot): void {
    // Actual Blockbench ordering: length clamps against OLD frames first.
    this.setLength(saved.length);
    // Actual merge contract: animators absent from the blueprint are retained.
    Object.entries(saved.animators ?? {}).forEach(([id, snapshot]) => {
      const animator = this.animator(id);
      animator.keyframes = (snapshot.keyframes ?? []).map(time => new TestFrame(animator, time));
    });
  }
}

function emit(name: string, event: unknown): void { handlers.get(name)?.forEach(handler => handler(event)); }
function load(save: ISave, reference: ISave): void {
  Object.entries(save.animations).forEach(([id, snapshot]) => {
    let animation = animations.find(candidate => candidate.uuid === id);
    if (!animation) {
      animation = new TestAnimation(id);
      animations.push(animation);
    }
    animation.extend(snapshot);
  });
  animations = animations.filter(animation => !(animation.uuid in reference.animations) || animation.uuid in save.animations);
  emit("load_undo_save", { save, reference });
}
const undo = createUndoHost({
  snapshot(aspects: IAspects): ISave {
    const save: ISave = { animations: Object.fromEntries(aspects.animations.map(animation => [animation.uuid, animation.save()])) };
    emit("create_undo_save", { save, aspects });
    return save;
  },
  restore: load,
});
function edit(mutate: () => void): void {
  runUndoableAnimationEdit({ animations: [selectedAnimation as unknown as BBAnimation] }, "MCP animation edit", mutate);
}

beforeEach(() => {
  handlers.clear();
  selectedAnimation = new TestAnimation("main");
  animations = [selectedAnimation];
  sliderUpdates = 0;
  timeline.animators = [];
  timeline.selected = [];
  timeline.selected_animator = null;
  timeline.vue._data.animation_length = 1;
  undo.reset();
});
afterEach(teardownAnimationUndoRestore);
useGlobals(() => ({
  Blockbench: {
    on(name: string, handler: Handler) { handlers.set(name, new Set([...(handlers.get(name) ?? []), handler])); },
    removeListener(name: string, handler: Handler) { handlers.get(name)?.delete(handler); },
  },
  Animation: { get all() { return animations; }, get selected() { return selectedAnimation; } },
  Timeline: timeline,
  BarItems: { slider_animation_length: { update() { sliderUpdates++; } } },
  Undo: undo,
}));

test("restores exact length after native replacement of later keyframes, with redo", () => {
  setupAnimationUndoRestore();
  selectedAnimation.animator("bone").add(1);
  const before = selectedAnimation.save();
  edit(() => { selectedAnimation.animators.bone.add(1.123); selectedAnimation.setLength(); });
  const after = selectedAnimation.save();
  expect(after.length).toBe(1.123);
  undo.undo();
  expect(selectedAnimation.save()).toEqual(before);
  expect(timeline.vue._data.animation_length).toBe(1);
  undo.redo();
  expect(selectedAnimation.save()).toEqual(after);
  expect(timeline.vue._data.animation_length).toBe(1.123);
  expect(sliderUpdates).toBe(2);
});

test("removes new animator and its selected frames/timeline references without clearing unrelated selection", () => {
  setupAnimationUndoRestore();
  selectedAnimation.animator("bone").add(1);
  const unrelated = new TestAnimation("other");
  const unrelatedAnimator = unrelated.animator("other-bone");
  const unrelatedFrame = unrelatedAnimator.add(4);
  animations.push(unrelated);
  timeline.selected.push(unrelatedFrame);
  timeline.animators.push(unrelatedAnimator);
  const before = selectedAnimation.save();
  edit(() => {
    const animator = selectedAnimation.animator("new-bone");
    timeline.animators.push(animator);
    timeline.selected.push(animator.add(1.123));
    timeline.selected_animator = animator;
    selectedAnimation.setLength();
  });
  const after = selectedAnimation.save();
  undo.undo();
  expect(selectedAnimation.save()).toEqual(before);
  expect(timeline.animators).toEqual([unrelatedAnimator]);
  expect(timeline.selected).toEqual([unrelatedFrame]);
  expect(timeline.selected_animator).toBeNull();
  expect(unrelated.animators["other-bone"].keyframes).toEqual([unrelatedFrame]);
  undo.redo();
  expect(selectedAnimation.save()).toEqual(after);
});

test("missing animators means empty and zero-length snapshots restore exactly", () => {
  setupAnimationUndoRestore();
  selectedAnimation.length = 0;
  const before = selectedAnimation.save();
  edit(() => { selectedAnimation.animator("created").add(2); selectedAnimation.setLength(); });
  undo.undo();
  expect(selectedAnimation.save()).toEqual(before);
  expect(timeline.vue._data.animation_length).toBe(0);
  expect(Object.keys(selectedAnimation.animators)).toHaveLength(0);
});

test("cancellation restores native-merge failures including new animator and length", () => {
  setupAnimationUndoRestore();
  selectedAnimation.animator("bone").add(1);
  const before = selectedAnimation.save();
  expect(() => edit(() => {
    selectedAnimation.animators.bone.add(3);
    selectedAnimation.animator("created").add(4);
    selectedAnimation.setLength();
    throw new Error("Preview failed");
  })).toThrow("Preview failed");
  expect(selectedAnimation.save()).toEqual(before);
  expect(undo.history).toHaveLength(0);
  expect(undo.pending).toBeUndefined();
  expect(undo.cancels).toBe(1);
});

test("unmarked native edits retain native restoration behavior", () => {
  setupAnimationUndoRestore();
  selectedAnimation.animator("bone").add(1);
  runUndoableEdit({ animations: [selectedAnimation as unknown as BBAnimation] }, "Native edit", () => {
    selectedAnimation.animators.bone.add(1.123);
    selectedAnimation.setLength();
  });
  undo.undo();
  expect(selectedAnimation.length).toBe(1.123);
  expect(sliderUpdates).toBe(0);
  expect(undo.history[0].before.mcp_full_animation_restore).toBeUndefined();
});

test("serialized history remains marked after teardown/reload and listeners are idempotent", () => {
  setupAnimationUndoRestore();
  setupAnimationUndoRestore();
  expect(handlers.get("create_undo_save")?.size).toBe(1);
  expect(handlers.get("load_undo_save")?.size).toBe(1);
  selectedAnimation.animator("bone").add(1);
  edit(() => { selectedAnimation.animator("created").add(2); selectedAnimation.setLength(); });
  const entry = JSON.parse(JSON.stringify(undo.history[0])) as { before: ISave; after: ISave };
  expect(entry.before.mcp_full_animation_restore).toBe(true);
  expect(entry.after.mcp_full_animation_restore).toBe(true);
  teardownAnimationUndoRestore();
  teardownAnimationUndoRestore();
  expect(handlers.get("create_undo_save")?.size).toBe(0);
  expect(handlers.get("load_undo_save")?.size).toBe(0);
  setupAnimationUndoRestore();
  load(entry.before, entry.after);
  expect(selectedAnimation.save()).toEqual(entry.before.animations.main);
});

test("empty creation snapshots leave native animation removal/recreation intact", () => {
  setupAnimationUndoRestore();
  const targets: BBAnimation[] = [];
  runUndoableAnimationEdit({ animations: targets }, "Create animation", () => {
    const created = new TestAnimation("created");
    created.animator("bone").add(2);
    created.setLength();
    targets.push(created as unknown as BBAnimation);
    animations.push(created);
  });
  undo.undo();
  expect(animations.map(animation => animation.uuid)).toEqual(["main"]);
  undo.redo();
  expect(animations.find(animation => animation.uuid === "created")?.length).toBe(2);
});

test("malformed and unrelated save payloads do not mutate animation state", () => {
  setupAnimationUndoRestore();
  const before = selectedAnimation.save();
  [null, [], {}, { save: { animations: {} } }, { save: { mcp_full_animation_restore: true, animations: { missing: null } } }].forEach(event => {
    expect(() => emit("load_undo_save", event)).not.toThrow();
  });
  expect(selectedAnimation.save()).toEqual(before);
  expect(sliderUpdates).toBe(0);
});
