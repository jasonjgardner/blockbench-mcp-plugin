import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { isRecord } from "@/tests/helpers/assertions";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
import { createUndoHost } from "@/tests/helpers/undo-host";

/** Parent of an outliner node: a group, or Blockbench's top outliner level. */
type HostParent = HostGroup | "root";

/** Saved properties of one node, as native Undo keeps them per UUID. */
interface INodeData {
  uuid: string;
  name: string;
  type: string;
  [key: string]: unknown;
}

/** One node's place in the saved outliner, in depth-first order. */
interface IOutlineEntry {
  uuid: string;
  parent: string;
}

/** Undo snapshot: tracked element and group properties, plus the hierarchy when `outliner` is set. */
interface ISave {
  elements: INodeData[];
  groups: INodeData[];
  outline: IOutlineEntry[] | undefined;
}

/** Undo aspects the element tools pass to `Undo.initEdit`. */
interface IEdit {
  elements?: HostElement[];
  groups?: HostGroup[];
  outliner?: boolean;
}

let tools: IToolFixture;
let nextId = 0;
let roots: HostNode[] = [];
let elements: HostElement[] = [];
let groups: HostGroup[] = [];
let selectedElements: HostElement[] = [];
let multiSelected: HostGroup[] = [];
let project: { mesh_selection: Record<string, unknown> } = { mesh_selection: {} };

function siblingsOf(parent: HostParent): HostNode[] {
  return parent === "root" ? roots : parent.children;
}

/** Common outliner node: identity, hierarchy and the property snapshot native Undo keeps. */
class HostNode {
  uuid = `node-${++nextId}`;
  parent: HostParent = "root";
  selected = false;
  locked = false;
  readonly type: string = "node";
  constructor(public name: string) {}
  markAsSelected(): this {
    this.selected = true;
    return this;
  }
  /** Property names saved by Undo besides uuid, name and type. */
  dataKeys(): readonly string[] {
    return [];
  }
  data(): INodeData {
    const saved: INodeData = { uuid: this.uuid, name: this.name, type: this.type };
    this.dataKeys().forEach((key) => { saved[key] = structuredClone(Reflect.get(this, key)); });
    return saved;
  }
  load(saved: INodeData): this {
    this.uuid = saved.uuid;
    this.name = saved.name;
    this.dataKeys().forEach((key) => { Reflect.set(this, key, structuredClone(saved[key])); });
    return this;
  }
  addTo(parent: HostParent = "root", index?: number): this {
    const previous = siblingsOf(this.parent);
    if (previous.includes(this)) previous.splice(previous.indexOf(this), 1);
    this.parent = parent;
    const next = siblingsOf(parent);
    next.splice(index ?? next.length, 0, this);
    return this;
  }
  isChildOf(node: HostNode): boolean {
    return this.parent !== "root" && (this.parent === node || this.parent.isChildOf(node));
  }
}

/** Blockbench's OutlinerElement: Shift-select toggles, markAsSelected only adds (and ignores `locked`). */
class HostElement extends HostNode {
  init(): this {
    if (!elements.includes(this)) elements.push(this);
    if (!siblingsOf(this.parent).includes(this)) this.addTo(this.parent);
    return this;
  }
  override markAsSelected(): this {
    if (!selectedElements.includes(this)) selectedElements.push(this);
    this.selected = true;
    return this;
  }
  select(event?: { shiftKey?: boolean }): this {
    if (event?.shiftKey && this.selected) return this.unselect();
    return this.markAsSelected();
  }
  unselect(): this {
    selectedElements = selectedElements.filter((element) => element !== this);
    this.selected = false;
    return this;
  }
  /** Like native `duplicate()`: a new UUID, inserted right after the original, initialized. */
  duplicate(): HostElement {
    const copy = createNode({ ...this.data(), uuid: `node-${++nextId}` });
    if (!(copy instanceof HostElement)) throw new TypeError("Element copies must be elements.");
    copy.addTo(this.parent, siblingsOf(this.parent).indexOf(this) + 1);
    return copy.init();
  }
}

class HostCube extends HostElement {
  override readonly type: string = "cube";
  from = [0, 0, 0];
  to = [1, 1, 1];
  origin = [0, 0, 0];
  rotation = [0, 0, 0];
  inflate = 0;
  box_uv = false;
  static get all(): HostCube[] {
    return elements.filter((element): element is HostCube => element instanceof HostCube);
  }
  static get selected(): HostCube[] {
    return selectedElements.filter((element): element is HostCube => element instanceof HostCube);
  }
  override dataKeys(): readonly string[] {
    return ["from", "to", "origin", "rotation", "inflate", "box_uv"];
  }
}

class HostMesh extends HostElement {
  override readonly type: string = "mesh";
  vertices: Record<string, number[]> = {};
  static get all(): HostMesh[] {
    return elements.filter((element): element is HostMesh => element instanceof HostMesh);
  }
  static get selected(): HostMesh[] {
    return selectedElements.filter((element): element is HostMesh => element instanceof HostMesh);
  }
  override dataKeys(): readonly string[] {
    return ["vertices"];
  }
}

/** Native IK controller: references are UUIDs (`ik_pole` since Blockbench 5.2). */
class HostNullObject extends HostElement {
  override readonly type: string = "null_object";
  position = [0, 0, 0];
  ik_target = "";
  ik_source = "";
  ik_pole = "";
  override dataKeys(): readonly string[] {
    return ["position", "ik_target", "ik_source", "ik_pole"];
  }
}

class HostArmatureBone extends HostElement {
  override readonly type: string = "armature_bone";
  static all: HostArmatureBone[] = [];
  getVertexWeight(): number {
    return 0;
  }
  setVertexWeight(): void {}
}

class HostGroup extends HostNode {
  override readonly type: string = "group";
  children: HostNode[] = [];
  origin = [0, 0, 0];
  rotation = [0, 0, 0];
  constructor(name: string, options: { origin?: number[]; rotation?: number[] } = {}) {
    super(name);
    Object.assign(this, options);
  }
  static get all(): HostGroup[] {
    return groups;
  }
  static get multi_selected(): HostGroup[] {
    return multiSelected;
  }
  override dataKeys(): readonly string[] {
    return ["origin", "rotation"];
  }
  init(): this {
    if (!groups.includes(this)) groups.push(this);
    if (!siblingsOf(this.parent).includes(this)) this.addTo(this.parent);
    return this;
  }
  /** Like Blockbench's Group#multiSelect: skips a locked group, registers it and selects its contents. */
  multiSelect(): this {
    if (this.locked) return this;
    this.selected = true;
    if (!multiSelected.includes(this)) multiSelected.push(this);
    this.children.forEach((child) => child.markAsSelected());
    return this;
  }
  /** Like Blockbench's Group#markAsSelected: flags the group and its contents without registering it. */
  override markAsSelected(): this {
    this.selected = true;
    this.children.forEach((child) => child.markAsSelected());
    return this;
  }
  createUniqueName(): void {}
  forEachChild(callback: (node: HostNode) => void): void {
    this.children.forEach((child) => {
      callback(child);
      if (child instanceof HostGroup) child.forEachChild(callback);
    });
  }
  duplicate(): HostGroup {
    const copy = new HostGroup(this.name, { origin: [...this.origin], rotation: [...this.rotation] });
    copy.addTo(this.parent, siblingsOf(this.parent).indexOf(this) + 1).init();
    this.children.forEach((child) => {
      if (child instanceof HostGroup || child instanceof HostElement) child.duplicate().addTo(copy);
    });
    return copy;
  }
}

/** Recreates a node from saved properties, as Undo does for deleted nodes. */
function createNode(saved: INodeData): HostNode {
  const types: Record<string, (name: string) => HostNode> = {
    cube: (name) => new HostCube(name),
    mesh: (name) => new HostMesh(name),
    null_object: (name) => new HostNullObject(name),
    armature_bone: (name) => new HostArmatureBone(name),
    group: (name) => new HostGroup(name),
  };
  const create = types[saved.type];
  if (!create) throw new Error(`No host class for node type "${saved.type}".`);
  return create(saved.name).load(saved);
}

function outline(nodes: HostNode[] = roots, parent = "root"): IOutlineEntry[] {
  return nodes.flatMap((node) => [
    { uuid: node.uuid, parent },
    ...(node instanceof HostGroup ? outline(node.children, node.uuid) : []),
  ]);
}

function snapshot(edit: IEdit): ISave {
  return {
    elements: (edit.elements ?? []).map((element) => element.data()),
    groups: (edit.groups ?? []).map((group) => group.data()),
    outline: edit.outliner ? outline() : undefined,
  };
}

/** Mirrors native `loadSave`: saved properties own creation/deletion, the outline owns the hierarchy. */
function restore(saved: ISave, reference: ISave): void {
  const keep = (list: INodeData[], uuid: string): boolean => list.some((entry) => entry.uuid === uuid);
  const removed = new Set([
    ...reference.elements.filter((entry) => !keep(saved.elements, entry.uuid)),
    ...reference.groups.filter((entry) => !keep(saved.groups, entry.uuid)),
  ].map((entry) => entry.uuid));
  elements = elements.filter((element) => !removed.has(element.uuid));
  groups = groups.filter((group) => !removed.has(group.uuid));
  [...saved.elements, ...saved.groups].forEach((entry) => {
    const existing = [...elements, ...groups].find((node) => node.uuid === entry.uuid);
    if (existing) {
      existing.load(entry);
      return;
    }
    const created = createNode(entry);
    if (created instanceof HostElement) elements.push(created);
    if (created instanceof HostGroup) groups.push(created);
  });
  const nodes: HostNode[] = [...elements, ...groups];
  if (saved.outline) {
    roots = [];
    groups.forEach((group) => { group.children = []; });
    saved.outline.forEach(({ uuid, parent }) => {
      const node = nodes.find((candidate) => candidate.uuid === uuid);
      const owner = groups.find((group) => group.uuid === parent) ?? "root";
      if (!node) return;
      node.parent = owner;
      siblingsOf(owner).push(node);
    });
    return;
  }
  roots = roots.filter((node) => !removed.has(node.uuid));
  groups.forEach((group) => { group.children = group.children.filter((node) => !removed.has(node.uuid)); });
}

const undo = createUndoHost({ snapshot, restore });

/** Parses a JSON tool answer into an object. */
async function callJson(name: string, input: unknown): Promise<Record<string, unknown>> {
  const result = await tools.call(name, input);
  if (typeof result !== "string") throw new TypeError(`${name} returned ${typeof result}, not JSON text.`);
  const parsed: unknown = JSON.parse(result);
  if (!isRecord(parsed)) throw new TypeError(`${name} returned JSON that is not an object.`);
  return parsed;
}

beforeAll(async () => {
  tools = await loadToolDefinitions({ entries: ["server/tools/element.ts"], register: ["registerElementTools"] });
});

beforeEach(() => {
  nextId = 0;
  roots = [];
  elements = [];
  groups = [];
  selectedElements = [];
  multiSelected = [];
  project = { mesh_selection: {} };
  HostArmatureBone.all = [];
  undo.reset();
});

// Registered after the reset above so each test's globals see freshly reset state.
useGlobals(() => ({
  Outliner: {
    get root() { return roots; },
    get elements() { return elements; },
    get selected() { return selectedElements; },
  },
  OutlinerElement: HostElement,
  Cube: HostCube,
  Mesh: HostMesh,
  Group: HostGroup,
  NullObject: HostNullObject,
  ArmatureBone: HostArmatureBone,
  Project: project,
  Undo: undo,
  Canvas: { updateAll() {} },
  // Like Blockbench's (misc.js): exceptions stay selected and keep their mesh component selection.
  unselectAllElements(exceptions: HostNode[] = []) {
    selectedElements.filter((element) => !exceptions.includes(element)).forEach((element) => element.unselect());
    groups.forEach((group) => { group.selected = false; });
    multiSelected = [];
    Object.keys(project.mesh_selection).forEach((key) => {
      if (!exceptions.some((node) => node.uuid === key)) delete project.mesh_selection[key];
    });
  },
  updateSelection() {},
}));

describe("find_elements_by_criteria", () => {
  test("rejects a pattern it cannot run instead of returning every element", async () => {
    new HostCube("arm_left").init();
    new HostCube("leg").init();
    await expect(tools.call("find_elements_by_criteria", { name_pattern: "arm_[" })).rejects.toThrow("is not a valid regular expression");
    await expect(tools.call("find_elements_by_criteria", { name_pattern: "a".repeat(513) })).rejects.toThrow("the limit is 512");
  });

  test.each(["(a+)+", "(a*)*", "(.*)+", "^(\\w+\\s?)*$", "^((a|b)+)+$", "^(?:x+){2,}$"])("refuses %p, which repeats a quantified group", async pattern => {
    new HostCube("leg").init();
    await expect(tools.call("find_elements_by_criteria", { name_pattern: pattern })).rejects.toThrow("catastrophic backtracking");
  });

  test.each([
    { pattern: "^(?:left|right)?_arm$", matches: ["left_arm", "right_arm", "_arm"] },
    { pattern: "^(?:arm|leg)+$", matches: ["leg", "armleg"] },
    { pattern: "^bone_(\\d+)?$", matches: ["bone_12", "bone_"] },
    { pattern: "^zzz(_.*)?$", matches: ["zzz_tail"] },
    { pattern: "^a\\+(b)+$", matches: ["a+bb"] },
    { pattern: "^[(+*]+$", matches: ["(+*"] },
  ])("accepts $pattern and filters with it", async ({ pattern, matches }) => {
    ["left_arm", "right_arm", "_arm", "leg", "armleg", "bone_12", "bone_", "zzz_tail", "a+bb", "(+*", "other"].forEach(name => new HostCube(name).init());
    const found = await callJson("find_elements_by_criteria", { name_pattern: pattern });
    const names: unknown[] = Array.isArray(found.matches) ? found.matches.map((match: unknown) => (isRecord(match) ? match.name : undefined)) : [];
    expect(found.count).toBe(matches.length);
    expect(names).toEqual([...matches]);
  });
});

describe("select_all_of_type", () => {
  /** UUIDs of every selected node: elements from the selection list, groups by their flag. */
  const selection = (): string[] => [...selectedElements, ...groups.filter((group) => group.selected)].map((node) => node.uuid).toSorted();

  test("replacing the selection selects exactly the elements of that type", async () => {
    const first = new HostCube("first").init();
    const second = new HostCube("second").init();
    const controller = new HostNullObject("controller").init();
    const folder = new HostGroup("folder").init();
    first.markAsSelected();
    controller.markAsSelected();
    folder.multiSelect();
    expect(await callJson("select_all_of_type", { type: "cube" })).toMatchObject({ type: "cube", selected: 2 });
    expect(selection()).toEqual([first.uuid, second.uuid].toSorted());
  });

  test("adding to the selection keeps targets that were already selected", async () => {
    const first = new HostCube("first").init();
    const second = new HostCube("second").init();
    const mesh = new HostMesh("mesh").init();
    first.markAsSelected();
    mesh.markAsSelected();
    await callJson("select_all_of_type", { type: "cube", add_to_selection: true });
    expect(selection()).toEqual([first.uuid, second.uuid, mesh.uuid].toSorted());
  });

  test("groups are selected through the native group selection, with their contents, scoped to a parent", async () => {
    const body = new HostGroup("body").init();
    const arm = new HostGroup("arm").init().addTo(body);
    const hand = new HostCube("hand").init().addTo(arm);
    const outside = new HostGroup("outside").init();
    const cube = new HostCube("cube").init();
    cube.markAsSelected();
    outside.multiSelect();
    expect(await callJson("select_all_of_type", { type: "group", parent_group: body.uuid })).toMatchObject({ selected: 1, parent_group: "body" });
    expect(HostGroup.multi_selected).toEqual([arm]);
    expect(selection()).toEqual([arm.uuid, hand.uuid].toSorted());
    expect(outside.selected).toBe(false);
  });

  test("locked nodes are skipped, as in Blockbench's own Select All", async () => {
    const open = new HostCube("open").init();
    const locked = new HostCube("locked").init();
    locked.locked = true;
    expect(await callJson("select_all_of_type", { type: "cube" })).toMatchObject({ selected: 1, skipped_locked: 1 });
    expect(selection()).toEqual([open.uuid]);
  });

  test("replacing the selection clears vertex/face selections only of meshes that end up deselected", async () => {
    const mesh = new HostMesh("mesh").init();
    new HostCube("cube").init();
    mesh.markAsSelected();
    project.mesh_selection[mesh.uuid] = { vertices: ["a"], edges: [], faces: [] };
    await callJson("select_all_of_type", { type: "mesh" });
    expect(project.mesh_selection[mesh.uuid]).toEqual({ vertices: ["a"], edges: [], faces: [] });
    await callJson("select_all_of_type", { type: "cube" });
    expect(project.mesh_selection[mesh.uuid]).toBeUndefined();
  });
});
