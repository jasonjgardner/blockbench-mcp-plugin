import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { z } from "zod";

type Tool = { parameters: z.ZodType<unknown>; execute(input: unknown): Promise<unknown> };
type GroupData = { uuid: string; name: string; origin: number[]; rotation: number[] };
type Outline = string | { uuid: string; children: Outline[] };
type Save = { groups: GroupData[]; outliner: Outline[] };
type Edit = { groups?: HostGroup[]; outliner: boolean };
let definitions: Map<string, Tool>;
const originals = new Map<string, PropertyDescriptor | undefined>();
let roots: HostNode[] = [];
let elements: HostNode[] = [];
let failRefresh = false;
let failReparent = false;

class HostNode {
  uuid: string = crypto.randomUUID();
  parent: HostGroup | "root" = "root";
  constructor(public name: string) {}
  addTo(parent: HostGroup | "root"): this {
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
  constructor(options: Partial<GroupData>) { super(options.name ?? "group"); Object.assign(this, options); }
  init(): this { HostGroup.all.push(this); this.addTo("root"); return this; }
}
function outline(nodes = roots): Outline[] {
  return nodes.map(node => node instanceof HostGroup ? { uuid: node.uuid, children: outline(node.children) } : node.uuid);
}
function groupData(group: HostGroup): GroupData {
  return { uuid: group.uuid, name: group.name, origin: [...group.origin], rotation: [...group.rotation] };
}
function save(edit: Edit): Save {
  return { groups: (edit.groups ?? []).map(groupData), outliner: outline() };
}
// Match native Undo: group properties own creation/deletion; the outline owns only UUIDs and hierarchy.
function load(saved: Save, reference: Save): void {
  const removed = reference.groups.filter(group => !saved.groups.some(item => item.uuid === group.uuid));
  HostGroup.all = HostGroup.all.filter(group => !removed.some(item => item.uuid === group.uuid));
  saved.groups.forEach(data => {
    const group = HostGroup.all.find(item => item.uuid === data.uuid);
    if (group) { Object.assign(group, structuredClone(data)); return; }
    new HostGroup(structuredClone(data)).init();
  });
  roots = [];
  HostGroup.all.forEach(group => { group.children = []; });
  const handled = new Set<string>();
  const visit = (nodes: Outline[], parent: HostGroup | "root"): void => {
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
const undo = {
  starts: 0,
  current: undefined as { edit: Edit; before: Save } | undefined,
  entry: undefined as { before: Save; after: Save } | undefined,
  initEdit(edit: Edit) { this.starts++; this.current = { edit, before: save(edit) }; },
  finishEdit() {
    if (!this.current) throw new Error("Missing transaction");
    this.entry = { before: this.current.before, after: save(this.current.edit) };
    this.current = undefined;
  },
  cancelEdit(revert: boolean) {
    if (revert && this.current) load(this.current.before, save(this.current.edit));
    this.current = undefined;
  },
  undo() { if (this.entry) load(this.entry.before, this.entry.after); },
  redo() { if (this.entry) load(this.entry.after, this.entry.before); },
};
function model() { return { groups: HostGroup.all.map(groupData), outliner: outline() }; }
async function call(name: string, input: unknown): Promise<unknown> {
  const tool = definitions.get(name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.execute(tool.parameters.parse(input));
}
beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [`${import.meta.dir}/../server/tools/animation.ts`], target: "bun", format: "cjs",
    plugins: [{ name: "capture-group-tools", setup(build) {
      build.onLoad({ filter: /[/\\]lib[/\\]factories\.ts$/ }, () => ({
        contents: "export const definitions = new Map(); export function createTool(name, tool) { definitions.set(name, tool); }", loader: "js",
      }));
      build.onLoad({ filter: /[/\\]server[/\\]tools[/\\]animation\.ts$/ }, async ({ path }) => ({
        contents: `${await Bun.file(path).text()}\nexport { definitions } from '@/lib/factories';\nexport { registerElementTools } from '@/server/tools/element';`, loader: "ts",
      }));
    } }],
  });
  if (!result.success) throw new AggregateError(result.logs, "Group fixture build failed");
  const path = `${import.meta.dir}/.group-tools-${crypto.randomUUID()}.cjs`;
  await Bun.write(path, result.outputs[0]);
  const fixture = await import(path).finally(() => Bun.file(path).delete()) as {
    registerAnimationTools(): void; registerElementTools(): void; definitions: Map<string, Tool>;
  };
  fixture.registerAnimationTools(); fixture.registerElementTools(); definitions = fixture.definitions;
});
beforeEach(() => {
  roots = []; elements = []; HostGroup.all = []; failRefresh = false; failReparent = false;
  undo.starts = 0; undo.current = undefined; undo.entry = undefined;
  const values = {
    Project: {}, Group: HostGroup, Outliner: { get root() { return roots; }, get elements() { return elements; } }, Undo: undo,
    Canvas: { updateAll() { if (failRefresh) throw new Error("Preview failed"); } },
  };
  Object.entries(values).forEach(([key, value]) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  });
});
afterEach(() => {
  originals.forEach((descriptor, key) => {
    if (descriptor) { Object.defineProperty(globalThis, key, descriptor); return; }
    Reflect.deleteProperty(globalThis, key);
  });
  originals.clear();
});

test.each(["add_group", "bone_rigging"])("%s creation undo removes group properties and redo restores its UUID and pivot", async name => {
  const input = { name: "Orbit", origin: [1, 2, 3], rotation: [0, 0, 90] };
  await call(name, name === "add_group" ? input : { action: "create", bone_data: input });
  const created = model();
  expect(undo.entry?.before.groups).toEqual([]);
  expect(undo.entry?.after.groups).toHaveLength(1);
  undo.undo();
  expect(model()).toEqual({ groups: [], outliner: [] });
  undo.redo();
  expect(model()).toEqual(created);
});
test("bone creation reparents child UUIDs with complete hierarchy undo and redo", async () => {
  const previous = new HostGroup({ name: "Previous" }).init();
  const child = new HostNode("Lower link").addTo(previous); elements.push(child);
  const nested = new HostGroup({ name: "Nested" }).init().addTo(previous);
  const before = model();
  await call("bone_rigging", { action: "create", bone_data: { name: "Carrier", parent: previous.uuid, children: [child.uuid, nested.uuid], origin: [0, 2, 0] } });
  const created = model();
  expect(child.parent).toBe(HostGroup.all.find(group => group.name === "Carrier")!);
  undo.undo(); expect(model()).toEqual(before); expect(child.parent).toBe(previous);
  undo.redo(); expect(model()).toEqual(created);
});
test.each(["add_group", "bone_rigging"])("%s accepts parent UUID and rejects missing parent before Undo", async name => {
  const parent = new HostGroup({ name: "Parent" }).init();
  const data = { name: "Child", parent: parent.uuid };
  await call(name, name === "add_group" ? data : { action: "create", bone_data: data });
  expect(HostGroup.all.find(group => group.name === "Child")?.parent).toBe(parent);
  const before = model(); const starts = undo.starts;
  const bad = { name: "Bad", parent: "missing" };
  await expect(call(name, name === "add_group" ? bad : { action: "create", bone_data: bad })).rejects.toThrow("Parent group");
  expect(model()).toEqual(before); expect(undo.starts).toBe(starts);
});
test("missing children and parent/ancestor cycles fail before Undo", async () => {
  const ancestor = new HostGroup({ name: "Ancestor" }).init();
  const parent = new HostGroup({ name: "Parent" }).init().addTo(ancestor);
  const before = model();
  await expect(call("bone_rigging", { action: "create", bone_data: { name: "Bad", children: ["missing"] } })).rejects.toThrow("Child");
  await expect(call("bone_rigging", { action: "create", bone_data: { name: "Bad", parent: parent.uuid, children: [ancestor.uuid] } })).rejects.toThrow("ancestor");
  await expect(call("bone_rigging", { action: "create", bone_data: { name: "Bad", parent: parent.uuid, children: [parent.uuid] } })).rejects.toThrow("parent");
  expect(model()).toEqual(before); expect(undo.starts).toBe(0);
});
test.each(["preview", "reparent"])("%s failure rolls back the new group and restores child hierarchy", async failure => {
  const previous = new HostGroup({ name: "Previous" }).init();
  const child = new HostNode("Lower link").addTo(previous); elements.push(child);
  const before = model();
  failRefresh = failure === "preview"; failReparent = failure === "reparent";
  await expect(call("bone_rigging", { action: "create", bone_data: { name: "Bad", children: [child.uuid] } })).rejects.toThrow();
  expect(model()).toEqual(before); expect(child.parent).toBe(previous); expect(undo.current).toBeUndefined(); expect(undo.entry).toBeUndefined();
});
test("add_group preview failure leaves no group or active transaction", async () => {
  failRefresh = true;
  await expect(call("add_group", { name: "Bad" })).rejects.toThrow("Preview failed");
  expect(model()).toEqual({ groups: [], outliner: [] }); expect(undo.current).toBeUndefined(); expect(undo.entry).toBeUndefined();
});
