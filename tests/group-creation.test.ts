import { beforeAll, beforeEach, expect, test } from "bun:test";
import { required } from "@/tests/helpers/assertions";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
import { createUndoHost } from "@/tests/helpers/undo-host";

/** Group properties native Undo saves for each tracked group. */
interface IGroupData {
  uuid: string;
  name: string;
  origin: number[];
  rotation: number[];
}

/** A group in the saved outliner: its UUID and the hierarchy beneath it. */
interface IOutlineGroup {
  uuid: string;
  children: Outline[];
}

/** Saved outliner node: an element UUID or a group with children. */
type Outline = string | IOutlineGroup;

/** Undo snapshot: tracked group properties plus the UUID-only outliner hierarchy. */
interface ISave {
  groups: IGroupData[];
  outliner: Outline[];
}

/** Undo aspects `createGroupWithUndo` passes to `Undo.initEdit`. */
interface IEdit {
  groups?: HostGroup[];
  outliner: boolean;
}

/** Parent of an outliner node: a group, or Blockbench's top outliner level. */
type HostParent = HostGroup | "root";

/** Message for a new group whose children include its parent or one of the parent's ancestors. */
const CYCLE_MESSAGE = "A new group's children cannot include its parent or an ancestor of its parent.";

let tools: IToolFixture;
let roots: HostNode[] = [];
let elements: HostNode[] = [];
let failRefresh = false;
let failReparent = false;

class HostNode {
  uuid: string = crypto.randomUUID();
  parent: HostParent = "root";
  constructor(public name: string) {}
  addTo(parent: HostParent): this {
    const previous = this.parent === "root" ? roots : this.parent.children;
    const index = previous.indexOf(this);
    if (index >= 0) previous.splice(index, 1);
    this.parent = parent;
    (parent === "root" ? roots : parent.children).push(this);
    if (failReparent && !(this instanceof HostGroup)) throw new Error("Reparent failed");
    return this;
  }
  isChildOf(node: HostNode): boolean {
    return this.parent !== "root" && (this.parent === node || this.parent.isChildOf(node));
  }
}
class HostGroup extends HostNode {
  static all: HostGroup[] = [];
  children: HostNode[] = [];
  origin: number[] = [0, 0, 0];
  rotation: number[] = [0, 0, 0];
  constructor(options: Partial<IGroupData>) {
    super(options.name ?? "group");
    Object.assign(this, options);
  }
  init(): this {
    HostGroup.all.push(this);
    this.addTo("root");
    return this;
  }
}
function outline(nodes = roots): Outline[] {
  return nodes.map(node => node instanceof HostGroup ? { uuid: node.uuid, children: outline(node.children) } : node.uuid);
}
function groupData(group: HostGroup): IGroupData {
  return { uuid: group.uuid, name: group.name, origin: [...group.origin], rotation: [...group.rotation] };
}
function save(edit: IEdit): ISave {
  return { groups: (edit.groups ?? []).map(groupData), outliner: outline() };
}
// Match native Undo: group properties own creation/deletion; the outline owns only UUIDs and hierarchy.
function load(saved: ISave, reference: ISave): void {
  const removed = reference.groups.filter(group => !saved.groups.some(item => item.uuid === group.uuid));
  HostGroup.all = HostGroup.all.filter(group => !removed.some(item => item.uuid === group.uuid));
  saved.groups.forEach(data => {
    const group = HostGroup.all.find(item => item.uuid === data.uuid);
    if (group) {
      Object.assign(group, structuredClone(data));
      return;
    }
    new HostGroup(structuredClone(data)).init();
  });
  roots = [];
  HostGroup.all.forEach(group => {
    group.children = [];
  });
  const handled = new Set<string>();
  const visit = (nodes: Outline[], parent: HostParent): void => {
    nodes.forEach(item => {
      const uuid = typeof item === "string" ? item : item.uuid;
      const node = [...HostGroup.all, ...elements].find(candidate => candidate.uuid === uuid);
      if (!node) return;
      handled.add(uuid);
      node.parent = parent;
      (parent === "root" ? roots : parent.children).push(node);
      if (typeof item !== "string" && node instanceof HostGroup) visit(item.children, node);
    });
  };
  visit(saved.outliner, "root");
  [...HostGroup.all, ...elements].filter(node => !handled.has(node.uuid)).forEach(node => {
    node.parent = "root";
    roots.push(node);
  });
}
const undo = createUndoHost({ restore: load, snapshot: save });
function model(): ISave {
  return { groups: HostGroup.all.map(groupData), outliner: outline() };
}
/** Adds an element double under `parent` and registers it in `Outliner.elements`. */
function addElement(name: string, parent: HostGroup): HostNode {
  const element = new HostNode(name).addTo(parent);
  elements.push(element);
  return element;
}

beforeAll(async () => {
  tools = await loadToolDefinitions({
    entries: ["server/tools/animation.ts", "server/tools/element.ts"],
    register: ["registerAnimationTools", "registerElementTools"],
  });
});
beforeEach(() => {
  roots = [];
  elements = [];
  HostGroup.all = [];
  failRefresh = false;
  failReparent = false;
  undo.reset();
});
// Registered after the reset above so each test's globals see freshly reset state.
useGlobals(() => ({
  Canvas: {
    updateAll() {
      if (failRefresh) throw new Error("Preview failed");
    },
  },
  Group: HostGroup,
  Outliner: {
    get root() {
      return roots;
    },
    get elements() {
      return elements;
    },
  },
  Project: {},
  Undo: undo,
}));

test.each(["add_group", "bone_rigging"])("%s creation undo removes group properties and redo restores its UUID and pivot", async name => {
  const input = { name: "Orbit", origin: [1, 2, 3], rotation: [0, 0, 90] };
  await tools.call(name, name === "add_group" ? input : { action: "create", bone_data: input });
  const created = model();
  expect(undo.lastEdit?.before.groups).toEqual([]);
  expect(undo.lastEdit?.after.groups).toHaveLength(1);
  undo.undo();
  expect(model()).toEqual({ groups: [], outliner: [] });
  undo.redo();
  expect(model()).toEqual(created);
});
test("bone creation reparents child UUIDs with complete hierarchy undo and redo", async () => {
  const previous = new HostGroup({ name: "Previous" }).init();
  const child = addElement("Lower link", previous);
  const nested = new HostGroup({ name: "Nested" }).init().addTo(previous);
  const before = model();
  await tools.call("bone_rigging", { action: "create", bone_data: { name: "Carrier", parent: previous.uuid, children: [child.uuid, nested.uuid], origin: [0, 2, 0] } });
  const created = model();
  expect(child.parent).toBe(required(HostGroup.all.find(group => group.name === "Carrier"), "Carrier group"));
  undo.undo();
  expect(model()).toEqual(before);
  expect(child.parent).toBe(previous);
  undo.redo();
  expect(model()).toEqual(created);
});
test.each(["add_group", "bone_rigging"])("%s accepts parent UUID and rejects missing parent before Undo", async name => {
  const parent = new HostGroup({ name: "Parent" }).init();
  const data = { name: "Child", parent: parent.uuid };
  await tools.call(name, name === "add_group" ? data : { action: "create", bone_data: data });
  expect(HostGroup.all.find(group => group.name === "Child")?.parent).toBe(parent);
  const before = model();
  const starts = undo.starts;
  const bad = { name: "Bad", parent: "missing" };
  await expect(tools.call(name, name === "add_group" ? bad : { action: "create", bone_data: bad })).rejects.toThrow('Parent group "missing" not found.');
  expect(model()).toEqual(before);
  expect(undo.starts).toBe(starts);
});
test("missing children and parent/ancestor cycles fail before Undo", async () => {
  const ancestor = new HostGroup({ name: "Ancestor" }).init();
  const parent = new HostGroup({ name: "Parent" }).init().addTo(ancestor);
  const before = model();
  await expect(tools.call("bone_rigging", { action: "create", bone_data: { name: "Bad", children: ["missing"] } })).rejects.toThrow('Child "missing" not found.');
  await expect(tools.call("bone_rigging", { action: "create", bone_data: { name: "Bad", parent: parent.uuid, children: [ancestor.uuid] } })).rejects.toThrow(CYCLE_MESSAGE);
  await expect(tools.call("bone_rigging", { action: "create", bone_data: { name: "Bad", parent: parent.uuid, children: [parent.uuid] } })).rejects.toThrow(CYCLE_MESSAGE);
  expect(model()).toEqual(before);
  expect(undo.starts).toBe(0);
});
test.each([
  { failure: "preview", message: "Preview failed" },
  { failure: "reparent", message: "Reparent failed" },
])("$failure failure rolls back the new group and restores child hierarchy", async ({ failure, message }) => {
  const previous = new HostGroup({ name: "Previous" }).init();
  const child = addElement("Lower link", previous);
  const before = model();
  failRefresh = failure === "preview";
  failReparent = failure === "reparent";
  await expect(tools.call("bone_rigging", { action: "create", bone_data: { name: "Bad", children: [child.uuid] } })).rejects.toThrow(message);
  expect(model()).toEqual(before);
  expect(child.parent).toBe(previous);
  expect(undo.pending).toBeUndefined();
  expect(undo.lastEdit).toBeUndefined();
});
test("add_group preview failure leaves no group or active transaction", async () => {
  failRefresh = true;
  await expect(tools.call("add_group", { name: "Bad" })).rejects.toThrow("Preview failed");
  expect(model()).toEqual({ groups: [], outliner: [] });
  expect(undo.pending).toBeUndefined();
  expect(undo.lastEdit).toBeUndefined();
});
