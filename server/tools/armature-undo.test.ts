import { beforeAll, beforeEach, expect, test } from "bun:test";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
import { createUndoHost } from "@/tests/helpers/undo-host";

interface INodeSave {
  uuid: string;
  name: string;
  type: string;
  data: Record<string, unknown>;
}
interface IEdit {
  elements: HostNode[];
  outliner: boolean;
}
interface ISave {
  elements: INodeSave[];
  outline: { uuid: string; parent: string }[];
}

let nodes: HostNode[] = [];
let tools: IToolFixture;
let failRemove = false;

class HostNode {
  uuid = crypto.randomUUID();
  children: HostNode[] = [];
  parent: HostNode | "root" = "root";
  data: Record<string, unknown> = {};
  constructor(readonly type: string, public name: string) { nodes.push(this); }
  addTo(parent: HostNode | "root"): this {
    if (this.parent !== "root") this.parent.children = this.parent.children.filter(node => node !== this);
    this.parent = parent;
    if (parent !== "root") parent.children.push(this);
    return this;
  }
  forEachChild(callback: (child: HostNode) => void): void {
    this.children.forEach(child => { callback(child); child.forEachChild(callback); });
  }
  remove(): void {
    if (failRemove) throw new Error("Native removal failed");
    const removed = new Set<HostNode>([this]);
    this.forEachChild(child => removed.add(child));
    nodes = nodes.filter(node => !removed.has(node));
    if (this.parent !== "root") this.parent.children = this.parent.children.filter(node => node !== this);
  }
}
class HostArmature extends HostNode {
  static get all(): HostArmature[] { return nodes.filter(node => node instanceof HostArmature); }
  constructor(name: string) { super("armature", name); }
}
class HostBone extends HostNode {
  static get all(): HostBone[] { return nodes.filter(node => node instanceof HostBone); }
  constructor(name: string) { super("armature_bone", name); }
}

function snapshot(edit: IEdit): ISave {
  return {
    elements: edit.elements.map(node => structuredClone({ uuid: node.uuid, name: node.name, type: node.type, data: node.data })),
    outline: nodes.map(node => ({ uuid: node.uuid, parent: node.parent === "root" ? "root" : node.parent.uuid })),
  };
}
function restore(save: ISave, reference: ISave): void {
  const retained = new Set(save.elements.map(node => node.uuid));
  const removed = new Set(reference.elements.filter(node => !retained.has(node.uuid)).map(node => node.uuid));
  nodes = nodes.filter(node => !removed.has(node.uuid));
  save.elements.forEach(saved => {
    let node = nodes.find(node => node.uuid === saved.uuid);
    if (!node) node = saved.type === "armature" ? new HostArmature(saved.name)
      : saved.type === "armature_bone" ? new HostBone(saved.name)
      : new HostNode(saved.type, saved.name);
    Object.assign(node, structuredClone(saved));
  });
  nodes.forEach(node => { node.children = []; node.parent = "root"; });
  save.outline.forEach(entry => {
    const node = nodes.find(node => node.uuid === entry.uuid);
    if (node) node.addTo(nodes.find(parent => parent.uuid === entry.parent) ?? "root");
  });
}
const undo = createUndoHost({ snapshot, restore });
function scene(): ISave { return snapshot({ elements: nodes, outliner: true }); }

beforeAll(async () => {
  tools = await loadToolDefinitions({ entries: ["server/tools/armature.ts"], register: ["registerArmatureTools"] });
});
beforeEach(() => { nodes = []; failRemove = false; undo.reset(); });
useGlobals(() => ({
  Armature: HostArmature, ArmatureBone: HostBone, Undo: undo,
  Canvas: { updateAll() {} },
}));

function rig(): { armature: HostArmature; upper: HostBone; lower: HostBone } {
  const armature = new HostArmature("rig");
  const upper = new HostBone("upper").addTo(armature);
  upper.data = { origin: [1, 2, 3], vertex_weights: { "mesh-a:a": 0.75 } };
  const lower = new HostBone("lower").addTo(upper);
  lower.data = { origin: [0, 8, 0], rotation: [0, 45, 0] };
  new HostNode("mesh", "body").addTo(armature).data = { vertices: { a: [0, 1, 2] } };
  new HostNode("null_object", "controller").addTo(armature).data = { ik_target: lower.uuid };
  return { armature, upper, lower };
}

test("deleting an armature preserves its full subtree and properties through undo/redo", async () => {
  const { armature } = rig();
  const before = scene();
  await tools.call("remove_armature", { id: armature.uuid });
  expect(nodes).toEqual([]);
  expect(undo.history).toHaveLength(1);
  expect(undo.history[0]?.before.elements).toEqual(before.elements);
  expect(undo.history[0]?.after.elements).toEqual([]);
  undo.undo();
  expect(scene()).toEqual(before);
  undo.redo();
  expect(nodes).toEqual([]);
});

test.each([true, false])("deleting a bone with remove_children=%p is reversible", async removeChildren => {
  const { armature, upper, lower } = rig();
  const before = scene();
  await tools.call("remove_armature_bone", { id: upper.uuid, remove_children: removeChildren });
  expect(nodes.some(node => node.uuid === upper.uuid)).toBe(false);
  expect(nodes.some(node => node.uuid === lower.uuid)).toBe(!removeChildren);
  if (!removeChildren) expect(lower.parent).toBe(armature);
  const after = scene();
  expect(undo.history).toHaveLength(1);
  expect(undo.history[0]?.after.elements.map(node => node.uuid)).toEqual(removeChildren ? [] : [lower.uuid]);
  undo.undo();
  expect(scene().elements.toSorted((a, b) => a.uuid.localeCompare(b.uuid))).toEqual(before.elements.toSorted((a, b) => a.uuid.localeCompare(b.uuid)));
  expect(scene().outline).toEqual(expect.arrayContaining(before.outline));
  undo.redo();
  expect(scene().elements.toSorted((a, b) => a.uuid.localeCompare(b.uuid))).toEqual(after.elements.toSorted((a, b) => a.uuid.localeCompare(b.uuid)));
  expect(scene().outline).toEqual(expect.arrayContaining(after.outline));
});

test("a removal failure cancels the transaction and restores reparented children", async () => {
  const { upper } = rig();
  const before = scene();
  failRemove = true;
  await expect(tools.call("remove_armature_bone", { id: upper.uuid, remove_children: false })).rejects.toThrow("Native removal failed");
  expect(scene()).toEqual(before);
  expect(undo.pending).toBeUndefined();
  expect(undo.cancels).toBe(1);
  expect(undo.history).toEqual([]);
});
