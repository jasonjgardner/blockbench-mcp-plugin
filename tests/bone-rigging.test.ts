import { beforeAll, beforeEach, expect, test } from "bun:test";
import { required } from "@/tests/helpers/assertions";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
import { createUndoHost } from "@/tests/helpers/undo-host";

type Vector = [number, number, number];
type HostParent = HostGroup | "root";

/** Saved outliner node: an element UUID or a group with the hierarchy beneath it. */
type Outline = string | { uuid: string; children: Outline[] };

interface IGroupData {
  uuid: string;
  name: string;
  origin: Vector;
  rotation: Vector;
}
interface ICubeData extends IGroupData {
  from: Vector;
  to: Vector;
}
/** Undo aspects the bone_rigging tool passes to `Undo.initEdit`/`finishEdit`. */
interface IAspects {
  elements?: HostElement[];
  groups?: HostGroup[];
  outliner?: boolean;
  animations?: HostAnimation[];
  /** Set by runUndoableAnimationEdit so the plugin's listener restores the exact animator set. */
  mcp_full_animation_restore?: boolean;
}
interface ISave {
  elements?: ICubeData[];
  groups?: IGroupData[];
  outliner?: Outline[];
  /** Keyframe times per animator UUID, per animation UUID. */
  animations?: Record<string, Record<string, number[]>>;
  marked?: boolean;
}

let tools: IToolFixture;
let roots: HostNode[] = [];
let elements: HostElement[] = [];
let animations: HostAnimation[] = [];

/** An animation reduced to its animators: keyframe times keyed by the animated node's UUID. */
class HostAnimation {
  readonly uuid = crypto.randomUUID();
  animators: Record<string, number[]> = {};
}

class HostNode {
  uuid: string = crypto.randomUUID();
  parent: HostParent = "root";
  temp_data: Record<string, unknown> = {};
  constructor(public name: string) {}
  addTo(parent: HostParent): this {
    const previous = this.parent === "root" ? roots : this.parent.children;
    const index = previous.indexOf(this);
    if (index >= 0) previous.splice(index, 1);
    this.parent = parent;
    (parent === "root" ? roots : parent.children).push(this);
    return this;
  }
  isChildOf(node: HostNode): boolean {
    return this.parent !== "root" && (this.parent === node || this.parent.isChildOf(node));
  }
  detach(): void {
    const siblings = this.parent === "root" ? roots : this.parent.children;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
  }
}
/** Stands in for Blockbench's OutlinerElement base class, which the tool checks with instanceof. */
class HostElement extends HostNode {}
/** A cube with Blockbench's flip math (`Cube.flip`) and duplicate placement. */
class HostCube extends HostElement {
  from: Vector;
  to: Vector;
  origin: Vector;
  rotation: Vector;
  constructor(data: Omit<ICubeData, "uuid"> & { uuid?: string }) {
    super(data.name);
    this.uuid = data.uuid ?? this.uuid;
    this.from = [...data.from];
    this.to = [...data.to];
    this.origin = [...data.origin];
    this.rotation = [...data.rotation];
    elements.push(this);
  }
  flip(axis: number, center: number): void {
    this.rotation[(axis + 1) % 3] *= -1;
    this.rotation[(axis + 2) % 3] *= -1;
    const from = this.from[axis];
    this.from[axis] = center - (this.to[axis] - center);
    this.to[axis] = center - (from - center);
    this.origin[axis] = center - (this.origin[axis] - center);
    flipName(this, axis);
  }
  duplicate(): HostCube {
    return new HostCube({ ...this.save(), uuid: undefined }).addTo(this.parent);
  }
  remove(): void {
    this.detach();
    elements = elements.filter(element => element !== this);
  }
  save(): ICubeData {
    return { uuid: this.uuid, name: this.name, from: [...this.from], to: [...this.to], origin: [...this.origin], rotation: [...this.rotation] };
  }
}
/** A marker element type without `flip`, like one the mirror action cannot handle. */
class HostMarker extends HostElement {}
class HostGroup extends HostNode {
  static all: HostGroup[] = [];
  children: HostNode[] = [];
  origin: Vector;
  rotation: Vector;
  constructor(data: Partial<IGroupData> & { name: string }) {
    super(data.name);
    this.uuid = data.uuid ?? this.uuid;
    this.origin = [...data.origin ?? [0, 0, 0]];
    this.rotation = [...data.rotation ?? [0, 0, 0]];
  }
  init(): this {
    HostGroup.all.push(this);
    return this.addTo("root");
  }
  forEachChild(callback: (node: HostNode) => void): void {
    this.children.forEach(child => {
      callback(child);
      if (child instanceof HostGroup) child.forEachChild(callback);
    });
  }
  /** Blockbench's Group.duplicate: a uniquely named copy after the original, with duplicated children. */
  duplicate(): HostGroup {
    const copy = new HostGroup({ name: this.name, origin: this.origin, rotation: this.rotation }).init().addTo(this.parent);
    copy.temp_data.old_name = this.name;
    copy.createUniqueName();
    [...this.children].forEach(child => {
      if (child instanceof HostGroup || child instanceof HostCube) child.duplicate().addTo(copy);
    });
    return copy;
  }
  createUniqueName(): void {
    let index = 2;
    const base = this.name;
    while (HostGroup.all.some(group => group !== this && group.name === this.name)) this.name = `${base}${index++}`;
  }
  /** Blockbench's Group.remove: children go first, and every animation drops this bone's animator. */
  remove(): void {
    [...this.children].forEach(child => {
      if (child instanceof HostGroup || child instanceof HostCube) child.remove();
    });
    this.detach();
    HostGroup.all = HostGroup.all.filter(group => group !== this);
    animations.forEach(animation => { delete animation.animators[this.uuid]; });
  }
  save(): IGroupData {
    return { uuid: this.uuid, name: this.name, origin: [...this.origin], rotation: [...this.rotation] };
  }
}

/** Left/right half of Blockbench's flipNameOnAxis, including its uniqueness check and original-name source. */
function flipName(node: HostNode, axis: number, check?: (name: string) => boolean, original?: unknown): string {
  const name = typeof original === "string" ? original : node.name;
  if (axis !== 0) return node.name;
  const swapped = name.includes("left") ? name.replace("left", "right") : name.replace("right", "left");
  if (swapped !== name && (!check || check(swapped))) node.name = swapped;
  return node.name;
}

function outline(nodes = roots): Outline[] {
  return nodes.map(node => node instanceof HostGroup ? { uuid: node.uuid, children: outline(node.children) } : node.uuid);
}
function save(aspects: IAspects): ISave {
  return {
    ...(aspects.elements && { elements: aspects.elements.filter(element => element instanceof HostCube).map(element => element.save()) }),
    ...(aspects.groups && { groups: aspects.groups.map(group => group.save()) }),
    ...(aspects.outliner && { outliner: outline() }),
    ...(aspects.animations && { animations: Object.fromEntries(aspects.animations.map(animation => [animation.uuid, structuredClone(animation.animators)])) }),
    ...(aspects.mcp_full_animation_restore && { marked: true }),
  };
}
/**
 * Native loadSave: listed nodes are updated or recreated, nodes only in the replaced state are removed, then the
 * outline is reapplied. Animations come back with exactly their saved animators, as native loading plus the
 * plugin's listener for marked saves achieve.
 */
function load(target: ISave, reference: ISave): void {
  Object.entries(target.animations ?? {}).forEach(([uuid, animators]) => {
    const animation = animations.find(candidate => candidate.uuid === uuid);
    if (animation) animation.animators = structuredClone(animators);
  });
  if (target.elements) {
    target.elements.forEach(data => {
      const existing = elements.find(element => element.uuid === data.uuid);
      if (existing instanceof HostCube) Object.assign(existing, structuredClone(data));
      else new HostCube(structuredClone(data));
    });
    (reference.elements ?? []).filter(data => !target.elements?.some(item => item.uuid === data.uuid))
      .forEach(data => elements.find(element => element.uuid === data.uuid)?.detach());
    elements = elements.filter(element => !(reference.elements ?? []).some(data => data.uuid === element.uuid && !target.elements?.some(item => item.uuid === data.uuid)));
  }
  if (target.groups) {
    target.groups.forEach(data => {
      const existing = HostGroup.all.find(group => group.uuid === data.uuid);
      if (existing) Object.assign(existing, structuredClone(data));
      else new HostGroup(structuredClone(data)).init();
    });
    const removed = (reference.groups ?? []).filter(data => !target.groups?.some(item => item.uuid === data.uuid));
    HostGroup.all = HostGroup.all.filter(group => !removed.some(data => data.uuid === group.uuid));
  }
  if (!target.outliner) return;
  roots = [];
  HostGroup.all.forEach(group => { group.children = []; });
  const visit = (nodes: Outline[], parent: HostParent): void => nodes.forEach(item => {
    const uuid = typeof item === "string" ? item : item.uuid;
    const node = [...HostGroup.all, ...elements].find(candidate => candidate.uuid === uuid);
    if (!node) return;
    node.parent = parent;
    (parent === "root" ? roots : parent.children).push(node);
    if (typeof item !== "string" && node instanceof HostGroup) visit(item.children, node);
  });
  visit(target.outliner, "root");
}
const undo = createUndoHost<ISave, IAspects>({ restore: load, snapshot: save });

/** Full model state: every group and cube with its parent, for before/after comparisons. */
function model(): { groups: (IGroupData & { parent: string })[]; cubes: (ICubeData & { parent: string })[] } {
  const parentOf = (node: HostNode): string => node.parent === "root" ? "root" : node.parent.uuid;
  return {
    groups: HostGroup.all.map(group => ({ ...group.save(), parent: parentOf(group) })).toSorted((a, b) => a.uuid.localeCompare(b.uuid)),
    cubes: elements.filter(element => element instanceof HostCube).map(cube => ({ ...cube.save(), parent: parentOf(cube) }))
      .toSorted((a, b) => a.uuid.localeCompare(b.uuid)),
  };
}
function group(name: string, parent: HostParent = "root", origin: Vector = [0, 0, 0], rotation: Vector = [0, 0, 0]): HostGroup {
  return new HostGroup({ name, origin, rotation }).init().addTo(parent);
}
function cube(name: string, parent: HostGroup, from: Vector, to: Vector, origin: Vector, rotation: Vector = [0, 0, 0]): HostCube {
  return new HostCube({ name, from, to, origin, rotation }).addTo(parent);
}
function rig(action: string, bone_data: Record<string, unknown>): Promise<unknown> {
  return tools.call("bone_rigging", { action, bone_data });
}
/** A left arm with a rotated cube and a hand bone holding another cube. */
function leftArm(): { arm: HostGroup; hand: HostGroup; upper: HostCube; palm: HostCube } {
  const arm = group("left_arm", "root", [4, 20, 0], [10, 20, 30]);
  const upper = cube("left_arm_upper", arm, [4, 12, -2], [8, 24, 2], [4, 20, 0], [0, 5, 15]);
  const hand = group("left_hand", arm, [6, 12, 0], [0, 45, 5]);
  const palm = cube("left_palm", hand, [5, 10, -1], [7, 12, 1], [6, 12, 0]);
  return { arm, hand, upper, palm };
}

beforeAll(async () => {
  tools = await loadToolDefinitions({ entries: ["server/tools/animation/rigging.ts"], register: ["registerBoneRiggingTool"] });
});
beforeEach(() => {
  roots = [];
  elements = [];
  animations = [];
  HostGroup.all = [];
  undo.reset();
});
useGlobals(() => ({
  Animation: { get all() { return animations; } },
  Canvas: { updateAll() {} },
  Format: { bone_rig: true, centered_grid: true },
  Group: HostGroup,
  Outliner: { get root() { return roots; }, get elements() { return elements; } },
  OutlinerElement: HostElement,
  Project: {},
  Undo: undo,
  flipNameOnAxis: flipName,
}));

test("a missing parent is an error instead of a silent move to the root", async () => {
  const bone = group("antenna", group("head"));
  const before = model();
  await expect(rig("parent", { name: "antenna", parent: "no_such_bone" })).rejects.toThrow('Parent bone "no_such_bone" not found');
  expect(model()).toEqual(before);
  expect(bone.parent).not.toBe("root");
  expect(undo.starts).toBe(0);
});

test("parents resolve by UUID, refuse cycles and ambiguous names, and root means the project root", async () => {
  const body = group("body");
  const head = group("head", body);
  const antenna = group("antenna");
  await rig("parent", { name: "antenna", parent: head.uuid });
  expect(antenna.parent).toBe(head);
  await expect(rig("parent", { name: "body", parent: "antenna" })).rejects.toThrow("inside itself or its own descendants");
  group("twin");
  group("twin");
  await expect(rig("parent", { name: "antenna", parent: "twin" })).rejects.toThrow("ambiguous");
  await rig("parent", { name: "antenna", parent: "root" });
  expect(antenna.parent).toBe("root");
  // GeckoLib rigs often have a bone named root; it wins over the project root, as before.
  const rootBone = group("root");
  await rig("parent", { name: "antenna", parent: "root" });
  expect(antenna.parent).toBe(rootBone);
  expect(undo.history).toHaveLength(3);
});

test("mirror duplicates the bone and flips the copy like Blockbench's Flip action, with complete undo and redo", async () => {
  const { arm, upper } = leftArm();
  const before = model();
  const result = String(await rig("mirror", { name: "left_arm", mirror_axis: "x" }));
  const copy = required(HostGroup.all.find(candidate => candidate.name === "right_arm"), "mirrored arm");
  const copiedHand = required(HostGroup.all.find(candidate => candidate.name === "right_hand"), "mirrored hand");
  const copiedUpper = required(elements.find(element => element instanceof HostCube && element.name === "right_arm_upper"), "mirrored cube");
  expect(result).toContain(`as "right_arm" (${copy.uuid})`);
  expect(copy.save()).toMatchObject({ origin: [-4, 20, 0], rotation: [10, -20, -30] });
  expect(copiedHand.save()).toMatchObject({ origin: [-6, 12, 0], rotation: [0, -45, -5] });
  expect(copiedHand.parent).toBe(copy);
  expect(copiedUpper instanceof HostCube && copiedUpper.save()).toMatchObject({ from: [-8, 12, -2], to: [-4, 24, 2], origin: [-4, 20, 0], rotation: [0, -5, -15] });
  // The original bone is untouched.
  expect(arm.save()).toMatchObject({ name: "left_arm", origin: [4, 20, 0], rotation: [10, 20, 30] });
  expect(upper.save()).toMatchObject({ from: [4, 12, -2], to: [8, 24, 2] });
  const after = model();
  undo.undo();
  expect(model()).toEqual(before);
  undo.redo();
  expect(model()).toEqual(after);
});

test("a mirrored copy keeps its unique duplicate name when the flipped name is taken", async () => {
  leftArm();
  group("right_arm");
  await rig("mirror", { name: "left_arm" });
  expect(HostGroup.all.map(candidate => candidate.name)).toContain("left_arm2");
});

test("mirror refuses elements that cannot flip before Undo starts", async () => {
  const { arm } = leftArm();
  elements.push(new HostMarker("marker").addTo(arm));
  const before = model();
  await expect(rig("mirror", { name: "left_arm" })).rejects.toThrow('"marker" cannot be mirrored');
  expect(model()).toEqual(before);
  expect(undo.starts).toBe(0);
});

test("delete keeps child bones and cubes in Undo", async () => {
  const { arm } = leftArm();
  const before = model();
  await rig("delete", { name: "left_arm" });
  expect(HostGroup.all).toEqual([]);
  expect(elements).toEqual([]);
  undo.undo();
  expect(model()).toEqual(before);
  expect(roots.map(node => node.uuid)).toEqual([arm.uuid]);
  undo.redo();
  expect(model()).toEqual({ groups: [], cubes: [] });
});

test("delete keeps the keyframes of the bone and its child bones in Undo, and Redo removes them again", async () => {
  const { arm, hand } = leftArm();
  const walk = new HostAnimation();
  walk.animators = { [arm.uuid]: [0, 1], other: [0.5] };
  // Only the child bone is animated here, which Blockbench's own Group.remove(true) does not snapshot.
  const wave = new HostAnimation();
  wave.animators = { [hand.uuid]: [0, 0.25] };
  const idle = new HostAnimation();
  idle.animators = { other: [2] };
  animations.push(walk, wave, idle);
  await rig("delete", { name: "left_arm" });
  expect([walk.animators, wave.animators]).toEqual([{ other: [0.5] }, {}]);
  const edit = required(undo.lastEdit, "delete undo entry");
  // Only animations that animate the deleted subtree are snapshotted, in marked saves.
  expect(Object.keys(edit.before.animations ?? {})).toEqual([walk.uuid, wave.uuid]);
  expect([edit.before.marked, edit.after.marked]).toEqual([true, true]);
  undo.undo();
  expect([walk.animators, wave.animators, idle.animators]).toEqual([{ [arm.uuid]: [0, 1], other: [0.5] }, { [hand.uuid]: [0, 0.25] }, { other: [2] }]);
  undo.redo();
  expect([walk.animators, wave.animators]).toEqual([{ other: [0.5] }, {}]);
});

test("create refuses a parent name several bones share, as the parent action does", async () => {
  group("twin");
  group("twin");
  await expect(rig("create", { name: "antenna", parent: "twin" })).rejects.toThrow('Parent bone name "twin" is ambiguous');
  expect(undo.starts).toBe(0);
});

test("rename and set_pivot are undone through the group properties", async () => {
  const { arm } = leftArm();
  const before = model();
  await rig("rename", { name: "left_arm", children: ["port_arm"] });
  await rig("set_pivot", { name: "port_arm", origin: [1, 2, 3] });
  expect(arm.save()).toMatchObject({ name: "port_arm", origin: [1, 2, 3] });
  undo.undo();
  undo.undo();
  expect(model()).toEqual(before);
});
