import { beforeAll, beforeEach, expect, test } from "bun:test";
import { required } from "@/tests/helpers/assertions";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
import { createUndoHost } from "@/tests/helpers/undo-host";

const sides = ["north", "south", "east", "west", "up", "down"] as const;
type Side = typeof sides[number];
type Parent = HostGroup | "root";
interface IFace {
  texture: string | false | null;
  uv: number[];
}
interface ICubeState {
  uuid: string;
  name: string;
  from: number[];
  to: number[];
  autouv: number;
  box_uv: boolean;
  double_sided: boolean;
  shading_mode: string;
  faces: Record<Side, IFace>;
}
interface IEdit {
  elements: HostCube[];
  outliner: boolean;
}
interface ISnapshot {
  elements: ICubeState[];
  outline: { uuid: string; parent: string }[];
}

let tools: IToolFixture;
let failInit = false;
let failRefresh = false;
let refuseParent = false;
let roots: HostCube[] = [];
let autoMapSnapshots: ICubeState[] = [];
const format = { id: "hytale_prop", single_texture: true };
const project = { box_uv: true };

class HostTexture {
  static all: HostTexture[] = [];
  uuid = crypto.randomUUID();
  static getDefault(): HostTexture | undefined { return this.all[0]; }
}
class HostGroup {
  static all: HostGroup[] = [];
  uuid: string = crypto.randomUUID();
  children: HostCube[] = [];
  constructor(public name: string) { HostGroup.all.push(this); }
}
class HostCube {
  static all: HostCube[] = [];
  uuid: string = crypto.randomUUID();
  name = "cube";
  from = [0, 0, 0];
  to = [1, 1, 1];
  autouv = 0;
  box_uv = project.box_uv;
  double_sided = false;
  shading_mode = "flat";
  parent: Parent = "root";
  faces = Object.fromEntries(sides.map(side => [side, { texture: false, uv: [0, 0, 1, 1] }])) as Record<Side, IFace>;
  constructor(input: Partial<ICubeState>) { Object.assign(this, structuredClone(input)); }
  init(): this {
    HostCube.all.push(this);
    this.addTo("root");
    if (failInit) throw new Error("Native initialization failed");
    return this;
  }
  addTo(parent: Parent): this {
    if (refuseParent && parent !== "root") return this;
    const previous = this.parent === "root" ? roots : this.parent.children;
    const index = previous.indexOf(this);
    if (index >= 0) previous.splice(index, 1);
    this.parent = parent;
    (parent === "root" ? roots : parent.children).push(this);
    return this;
  }
  mapAutoUV(): void {
    autoMapSnapshots.push(cubeState(this));
    if (this.box_uv || this.autouv !== 1) return;
    const [x, y, z] = this.to.map((value, axis) => value - this.from[axis]);
    const dimensions: Record<Side, number[]> = {
      north: [x, y], south: [x, y], east: [z, y], west: [z, y], up: [x, z], down: [x, z],
    };
    sides.forEach(side => { this.faces[side].uv = [0, 0, ...dimensions[side]]; });
  }
  setUVMode(box: boolean): void {
    // Hytale's native setUVMode override refuses box UV for a quad.
    const zeroDepth = this.from.some((value, axis) => value === this.to[axis]);
    if (box && zeroDepth && sides.filter(side => this.faces[side].texture !== null).length <= 1) return;
    this.box_uv = box;
  }
}

function cubeState(cube: HostCube): ICubeState {
  return structuredClone({
    uuid: cube.uuid, name: cube.name, from: cube.from, to: cube.to,
    autouv: cube.autouv, box_uv: cube.box_uv, double_sided: cube.double_sided,
    shading_mode: cube.shading_mode, faces: cube.faces,
  });
}
function snapshot(edit: IEdit): ISnapshot {
  return {
    elements: edit.elements.map(cubeState),
    outline: edit.outliner ? HostCube.all.map(cube => ({ uuid: cube.uuid, parent: cube.parent === "root" ? "root" : cube.parent.uuid })) : [],
  };
}
function restore(saved: ISnapshot, reference: ISnapshot): void {
  const affected = new Set([...saved.elements, ...reference.elements].map(cube => cube.uuid));
  HostCube.all = HostCube.all.filter(cube => !affected.has(cube.uuid));
  saved.elements.forEach(cube => HostCube.all.push(new HostCube(cube)));
  roots = [];
  HostGroup.all.forEach(group => { group.children = []; });
  HostCube.all.forEach(cube => {
    const parentId = saved.outline.find(entry => entry.uuid === cube.uuid)?.parent;
    const parent = HostGroup.all.find(group => group.uuid === parentId) ?? "root";
    cube.parent = parent;
    (parent === "root" ? roots : parent.children).push(cube);
  });
}
const undo = createUndoHost({ snapshot, restore });
function model(): ISnapshot { return snapshot({ elements: HostCube.all, outliner: true }); }

beforeAll(async () => {
  tools = await loadToolDefinitions({ entries: ["server/tools/hytale.ts"], register: ["registerHytaleTools"] });
});
beforeEach(() => {
  HostCube.all = [];
  HostGroup.all = [];
  HostTexture.all = [];
  roots = [];
  autoMapSnapshots = [];
  failInit = false;
  failRefresh = false;
  refuseParent = false;
  format.id = "hytale_prop";
  format.single_texture = true;
  project.box_uv = true;
  undo.reset();
});
useGlobals(() => ({
  Canvas: { updateAll() { if (failRefresh) throw new Error("Native preview failed"); } },
  Cube: HostCube, Group: HostGroup, Texture: HostTexture, Format: format, Project: project, Undo: undo,
}));

test.each([
  { normal: "+X", face: "east", to: [1, 7, 6] }, { normal: "-X", face: "west", to: [1, 7, 6] },
  { normal: "+Y", face: "up", to: [4, 2, 8] }, { normal: "-Y", face: "down", to: [4, 2, 8] },
  { normal: "+Z", face: "south", to: [4, 7, 3] }, { normal: "-Z", face: "north", to: [4, 7, 3] },
])("$normal creates a native single-face quad with correct polarity, size and UVs", async ({ normal, face, to }) => {
  await tools.call("hytale_create_quad", { name: "Panel", position: [1, 2, 3], size: [3, 5], normal, double_sided: false });
  const cube = required(HostCube.all[0], "created quad");
  expect(sides.filter(side => cube.faces[side].texture !== null)).toEqual([face]);
  expect(cube).toMatchObject({ from: [1, 2, 3], to, box_uv: false, autouv: 1, double_sided: false, shading_mode: "standard" });
  expect(cube.faces[face as Side].uv).toEqual([0, 0, 3, 5]);
  expect(autoMapSnapshots).toHaveLength(1);
  expect(autoMapSnapshots[0]).toMatchObject({ from: [1, 2, 3], to, box_uv: false, autouv: 1 });
  expect(Object.values(required(autoMapSnapshots[0], "Auto UV input").faces).filter(data => data.texture !== null)).toHaveLength(1);
  expect(project.box_uv).toBe(true);
  cube.setUVMode(true);
  expect(cube.box_uv).toBe(false);
  expect(undo.finishes).toBe(1);
});

test("defaults preserve +Y orientation, 16x16 size, double-sided standard shading and native default texture", async () => {
  const texture = new HostTexture();
  HostTexture.all.push(texture);
  await tools.call("hytale_create_quad", { name: "Default" });
  const cube = required(HostCube.all[0], "created quad");
  expect(cube).toMatchObject({ from: [0, 0, 0], to: [16, 0, 16], double_sided: true, shading_mode: "standard", parent: "root" });
  expect(cube.faces.up).toEqual({ texture: texture.uuid, uv: [0, 0, 16, 16] });
  expect(sides.filter(side => side !== "up").every(side => cube.faces[side].texture === null)).toBe(true);
});

test("Undo removes the created element and Redo restores UUID, parent, disabled faces and UVs", async () => {
  const parent = new HostGroup("Bone");
  new HostCube({ name: "Existing" }).init().addTo(parent);
  const before = model();
  await tools.call("hytale_create_quad", { name: "Panel", group: parent.uuid, normal: "-Z" });
  const created = model();
  expect(undo.lastEdit?.before.elements).toEqual([]);
  expect(undo.lastEdit?.after.elements).toHaveLength(1);
  expect(parent.children).toHaveLength(2);
  undo.undo();
  expect(model()).toEqual(before);
  undo.redo();
  expect(model()).toEqual(created);
});

test("explicit parent UUID takes precedence over a different group's matching name", async () => {
  const parent = new HostGroup("Bone");
  const shadow = new HostGroup(parent.uuid);
  await tools.call("hytale_create_quad", { name: "Panel", group: parent.uuid });
  expect(HostCube.all[0]?.parent).toBe(parent);
  expect(shadow.children).toEqual([]);
});

test("missing or ambiguous parent references reject before Undo", async () => {
  new HostGroup("duplicate");
  new HostGroup("duplicate");
  await expect(tools.call("hytale_create_quad", { name: "Panel", group: "missing" })).rejects.toThrow("not found");
  await expect(tools.call("hytale_create_quad", { name: "Panel", group: "duplicate" })).rejects.toThrow("ambiguous");
  expect(undo.starts).toBe(0);
  expect(HostCube.all).toEqual([]);
});

test.each([
  { size: [0, 2] }, { size: [-1, 2] }, { size: [2, Infinity] }, { size: [NaN, 2] },
  { position: [0, Infinity, 0] }, { position: [0, 0, NaN] },
  { position: [Number.MAX_VALUE, 0, 0], size: [Number.MAX_VALUE, 1] },
])("invalid or overflowing quad geometry rejects before Undo: %j", async input => {
  await expect(tools.call("hytale_create_quad", { name: "Bad", ...input })).rejects.toThrow();
  expect(undo.starts).toBe(0);
  expect(HostCube.all).toEqual([]);
});

test("non-Hytale projects reject before Undo", async () => {
  format.id = "free";
  await expect(tools.call("hytale_create_quad", { name: "Bad" })).rejects.toThrow("Hytale format project");
  expect(undo.starts).toBe(0);
});

test.each(["initialization", "preview", "parent"])("%s failure rolls back the new quad and preserves the existing model", async failure => {
  const parent = new HostGroup("Bone");
  new HostCube({ name: "Existing" }).init().addTo(parent);
  const before = model();
  failInit = failure === "initialization";
  failRefresh = failure === "preview";
  refuseParent = failure === "parent";
  await expect(tools.call("hytale_create_quad", { name: "Failed", group: parent.uuid })).rejects.toThrow();
  expect(model()).toEqual(before);
  expect(undo.pending).toBeUndefined();
  expect(undo.lastEdit).toBeUndefined();
  expect(undo.cancels).toBe(1);
});
