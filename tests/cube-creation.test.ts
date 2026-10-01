import { beforeAll, beforeEach, expect, test } from "bun:test";
import { required } from "@/tests/helpers/assertions";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
import { createUndoHost } from "@/tests/helpers/undo-host";

/** Native cube sides in the same order used by the host's texture application. */
const SIDES = ["north", "east", "south", "west", "up", "down"] as const;
type Side = typeof SIDES[number];
type Parent = HostGroup | "root";
interface IFaceData {
  uv: number[];
  texture: string | false;
}
interface ICubeData {
  uuid: string;
  name: string;
  from: number[];
  to: number[];
  origin: number[];
  rotation: number[];
  autouv: number;
  box_uv: boolean;
  inflate: number;
  uv_offset: number[];
  mirror_uv: boolean;
  faces: Record<Side, IFaceData>;
}
/** Property snapshots own creation/deletion, while the outline only owns parenting. */
interface ISave {
  elements: ICubeData[];
  outline: { uuid: string; parent: string }[];
}
interface IEdit {
  elements: HostCube[];
  outliner: boolean;
}

let tools: IToolFixture;
let roots: HostCube[] = [];
let failInitName: string | undefined;
let failRefresh = false;
let failAutoUv = false;
let refuseParent = false;
let textureCalls: { cube: string; sides: Side[] | true | undefined }[] = [];
let autoUvCalls: string[] = [];
let autoUvInputs: Record<Side, number[]>[] = [];
/** Geometry a size limiter test may override, as Blockbench's `cube_size_limiter.test(cube, values)` takes it. */
interface ILimitValues {
  from?: number[];
  to?: number[];
  inflate?: number;
}
/** The part of Blockbench's `Format.cube_size_limiter` the tools use. */
interface ISizeLimiter {
  coordinate_limits?: [number, number];
  box_marker_size?: number[];
  test(cube: HostCube, values?: ILimitValues): boolean;
}
/** Blockbench's Java block limiter test (js/formats/java/java_block.ts): from/to ± inflate within -16…32. */
const javaBlockLimiter: ISizeLimiter = {
  coordinate_limits: [-16, 32],
  test(cube, values = {}) {
    const from = values.from ?? cube.from;
    const to = values.to ?? cube.to;
    const inflate = values.inflate ?? cube.inflate;
    return from.some((start, axis) => {
      const end = to[axis] ?? start;
      return end + inflate > 32 || end + inflate < -16 || start - inflate > 32 || start - inflate < -16;
    });
  },
};
const format: { id: string; box_uv: boolean; optional_box_uv: boolean; cube_size_limiter?: ISizeLimiter } = { id: "free", box_uv: false, optional_box_uv: false };
const project = { box_uv: false, get textures(): HostTexture[] { return HostTexture.all; } };
const settings = { deactivate_size_limit: { value: false } };

class HostTexture {
  static all: HostTexture[] = [];
  uuid = crypto.randomUUID();
  id = "0";
  constructor(public name: string) {}
  static getDefault(): HostTexture | undefined { return this.all[0]; }
}

class HostGroup {
  static all: HostGroup[] = [];
  uuid = crypto.randomUUID();
  children: HostCube[] = [];
  constructor(public name: string) { HostGroup.all.push(this); }
}

class HostFace implements IFaceData {
  uv = [0, 0, 1, 1];
  texture: string | false = false;
  extend(data: Partial<IFaceData>): this {
    Object.assign(this, structuredClone(data));
    return this;
  }
}

class HostCube {
  static all: HostCube[] = [];
  static selected: HostCube[] = [];
  uuid: string = crypto.randomUUID();
  name = "cube";
  parent: Parent = "root";
  from = [0, 0, 0];
  to = [1, 1, 1];
  origin = [0, 0, 0];
  rotation = [0, 0, 0];
  autouv = 0;
  box_uv = project.box_uv;
  inflate = 0;
  uv_offset = [0, 0];
  mirror_uv = false;
  faces: Record<Side, HostFace> = {
    north: new HostFace(), east: new HostFace(), south: new HostFace(),
    west: new HostFace(), up: new HostFace(), down: new HostFace(),
  };
  constructor(data: Partial<ICubeData>) {
    this.extend(data);
  }
  extend(data: Partial<ICubeData>): this {
    const { faces, ...properties } = data;
    Object.assign(this, structuredClone(properties));
    if (faces) SIDES.forEach(side => this.faces[side].extend(faces[side]));
    return this;
  }
  init(): this {
    HostCube.all.push(this);
    this.addTo("root");
    if (this.name === failInitName) throw new Error("Cube initialization failed");
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
  // Reproduce the native selection fallback and box-UV all-face override so the
  // tests fail when the tool accidentally delegates targeting to the UI.
  applyTexture(texture: HostTexture, sides: Side[] | true | undefined): void {
    textureCalls.push({ cube: this.uuid, sides });
    const targets = sides === true || this.box_uv ? SIDES : sides ?? ["south"];
    targets.forEach(side => { this.faces[side].texture = texture.uuid; });
  }
  mapAutoUV(): void {
    if (failAutoUv) throw new Error("Auto UV failed");
    autoUvCalls.push(this.uuid);
    autoUvInputs.push(Object.fromEntries(SIDES.map(side => [side, [...this.faces[side].uv]])) as Record<Side, number[]>);
    if (!format.id.startsWith("hytale_") || this.box_uv || this.autouv !== 1) return;
    // Native Auto UV 1 keeps the rectangle origin and mirror direction while
    // resizing each side to the cube dimensions. Hytale's finish_edit uses it
    // when it finds a cube whose Auto UV was disabled.
    const [x, y, z] = this.to.map((value, axis) => Math.abs(value - this.from[axis]));
    const sizes: Record<Side, [number, number]> = {
      north: [x, y], south: [x, y], east: [z, y], west: [z, y], up: [x, z], down: [x, z],
    };
    SIDES.forEach(side => {
      const [u, v, endU, endV] = this.faces[side].uv;
      const [width, height] = sizes[side];
      this.faces[side].uv = [u, v, u + (endU < u ? -width : width), v + (endV < v ? -height : height)];
    });
  }
}

function cubeData(cube: HostCube): ICubeData {
  return {
    uuid: cube.uuid, name: cube.name, from: [...cube.from], to: [...cube.to],
    origin: [...cube.origin], rotation: [...cube.rotation], autouv: cube.autouv,
    box_uv: cube.box_uv, inflate: cube.inflate, uv_offset: [...cube.uv_offset], mirror_uv: cube.mirror_uv,
    faces: Object.fromEntries(SIDES.map(side => [side, {
      uv: [...cube.faces[side].uv], texture: cube.faces[side].texture,
    }])) as Record<Side, IFaceData>,
  };
}
function outline(): ISave["outline"] {
  return HostCube.all.map(cube => ({ uuid: cube.uuid, parent: cube.parent === "root" ? "root" : cube.parent.uuid }));
}
function snapshot(edit: IEdit): ISave {
  return { elements: edit.elements.map(cubeData), outline: edit.outliner ? outline() : [] };
}
function restore(saved: ISave, reference: ISave): void {
  const removed = reference.elements.filter(cube => !saved.elements.some(item => item.uuid === cube.uuid));
  HostCube.all = HostCube.all.filter(cube => !removed.some(item => item.uuid === cube.uuid));
  saved.elements.forEach(data => {
    const cube = HostCube.all.find(item => item.uuid === data.uuid);
    if (cube) {
      const { faces, ...properties } = data;
      Object.assign(cube, structuredClone(properties));
      SIDES.forEach(side => cube.faces[side].extend(faces[side]));
      return;
    }
    HostCube.all.push(new HostCube(data));
  });
  roots = [];
  HostGroup.all.forEach(group => { group.children = []; });
  HostCube.all.forEach(cube => {
    const parentId = saved.outline.find(item => item.uuid === cube.uuid)?.parent;
    const parent = HostGroup.all.find(group => group.uuid === parentId) ?? "root";
    cube.parent = parent;
    (parent === "root" ? roots : parent.children).push(cube);
  });
}
const undo = createUndoHost({ restore, snapshot });
/** Hytale normalizes disabled Auto UV in finish_edit, before the post-edit snapshot. */
const nativeUndo = {
  initEdit(edit: IEdit): ISave { return undo.initEdit(edit); },
  finishEdit(message?: string): void {
    if (format.id.startsWith("hytale_")) undo.pending?.aspects.elements.forEach(cube => {
      if (cube.autouv) return;
      cube.autouv = 1;
      cube.mapAutoUV();
    });
    undo.finishEdit(message);
  },
  cancelEdit(revert?: boolean): void { undo.cancelEdit(revert); },
};
function model(): ISave { return { elements: HostCube.all.map(cubeData), outline: outline() }; }
function addTexture(): HostTexture {
  const texture = new HostTexture("palette");
  HostTexture.all.push(texture);
  return texture;
}

beforeAll(async () => {
  tools = await loadToolDefinitions({ entries: ["server/tools/cubes.ts"], register: ["registerCubesTools"] });
});
beforeEach(() => {
  HostCube.all = [];
  HostCube.selected = [];
  HostGroup.all = [];
  HostTexture.all = [];
  roots = [];
  failInitName = undefined;
  failRefresh = false;
  failAutoUv = false;
  refuseParent = false;
  textureCalls = [];
  autoUvCalls = [];
  autoUvInputs = [];
  format.id = "free";
  format.box_uv = false;
  format.optional_box_uv = false;
  format.cube_size_limiter = undefined;
  settings.deactivate_size_limit.value = false;
  project.box_uv = false;
  undo.reset();
});
useGlobals(() => ({
  Canvas: { updateAll() { if (failRefresh) throw new Error("Preview failed"); } },
  Cube: HostCube, Group: HostGroup, Texture: HostTexture, Format: format,
  Project: project, Undo: nativeUndo, settings,
}));

test("untextured batch blockout undo removes new cubes and redo restores UUIDs, geometry and parents", async () => {
  const parent = new HostGroup("Body");
  new HostCube({ name: "Existing" }).init().addTo(parent);
  const before = model();
  await tools.call("place_cube", {
    group: parent.uuid,
    elements: [{ name: "Arm", from: [1, 2, 3], to: [3, 8, 5], origin: [2, 8, 4] }, { name: "Leg" }],
  });
  const created = model();
  expect(undo.starts).toBe(1);
  expect(undo.finishes).toBe(1);
  expect(undo.lastEdit?.before.elements).toEqual([]);
  expect(undo.lastEdit?.after.elements).toHaveLength(2);
  expect(HostCube.all).toHaveLength(3);
  expect(parent.children).toHaveLength(3);
  expect(textureCalls).toEqual([]);
  expect(HostCube.all.slice(1).every(cube => SIDES.every(side => cube.faces[side].texture === false))).toBe(true);
  undo.undo();
  expect(model()).toEqual(before);
  undo.redo();
  expect(model()).toEqual(created);
});

test("omitted texture uses the default when present and assigns every face explicitly", async () => {
  const texture = addTexture();
  await tools.call("place_cube", { elements: [{ name: "Textured" }] });
  const cube = required(HostCube.all[0], "created cube");
  expect(SIDES.map(side => cube.faces[side].texture)).toEqual(SIDES.map(() => texture.uuid));
  expect(textureCalls).toEqual([{ cube: cube.uuid, sides: true }]);
  expect(cube.autouv).toBe(1);
  expect(autoUvCalls).toEqual([cube.uuid]);
});

test.each([{ faces: false }, { faces: [] }])("faces=$faces creates untextured cubes without reading the selected UV face", async ({ faces }) => {
  const texture = addTexture();
  await tools.call("place_cube", { elements: [{ name: "Blockout" }], texture: texture.uuid, faces });
  const cube = required(HostCube.all[0], "created cube");
  expect(SIDES.every(side => cube.faces[side].texture === false)).toBe(true);
  expect(cube.autouv).toBe(0);
  expect(textureCalls).toEqual([]);
  expect(autoUvCalls).toEqual([]);
});

test("custom UV faces receive the requested texture and preserve UV rectangles through undo/redo", async () => {
  const texture = addTexture();
  project.box_uv = true;
  format.box_uv = true;
  format.optional_box_uv = true;
  await tools.call("place_cube", {
    elements: [{ name: "Mapped" }], texture: texture.uuid,
    faces: [{ face: "north", uv: [8, 1, 2, 7] }, { face: "up", uv: [0, 0, 4, 6] }],
  });
  const cube = required(HostCube.all[0], "created cube");
  expect(cube.box_uv).toBe(false);
  expect(project.box_uv).toBe(true);
  expect(cube.autouv).toBe(0);
  expect(cube.faces.north).toMatchObject({ texture: texture.uuid, uv: [8, 1, 2, 7] });
  expect(cube.faces.up).toMatchObject({ texture: texture.uuid, uv: [0, 0, 4, 6] });
  expect(cube.faces.south.texture).toBe(false);
  expect(autoUvCalls).toEqual([]);
  const created = model();
  undo.undo();
  expect(HostCube.all).toEqual([]);
  undo.redo();
  expect(model()).toEqual(created);
});

test("named face subsets switch optional box UV off and only texture requested faces", async () => {
  const texture = addTexture();
  project.box_uv = true;
  format.box_uv = true;
  format.optional_box_uv = true;
  await tools.call("place_cube", { elements: [{ name: "Top" }], faces: ["up"] });
  const cube = required(HostCube.all[0], "created cube");
  expect(cube.box_uv).toBe(false);
  expect(cube.faces.up.texture).toBe(texture.uuid);
  expect(SIDES.filter(side => side !== "up").every(side => cube.faces[side].texture === false)).toBe(true);
  expect(cube.autouv).toBe(1);
});

test.each(["hytale_character", "hytale_prop"])("%s custom face rectangles retain mirrored offsets and native Auto UV through finish_edit and Undo/Redo", async id => {
  format.id = id;
  format.box_uv = true;
  format.optional_box_uv = true;
  project.box_uv = true;
  const rectangles = [
    { face: "north", uv: [12, 9, 6, 5] }, { face: "south", uv: [3, 2, 9, 6] },
    { face: "east", uv: [8, 7, 6, 3] }, { face: "west", uv: [1, 2, 3, 6] },
    { face: "up", uv: [9, 4, 3, 2] }, { face: "down", uv: [2, 3, 8, 5] },
  ];
  await tools.call("place_cube", {
    elements: [{ name: "Mapped", from: [8, 7, 6], to: [2, 3, 4] }], faces: rectangles,
  });
  const cube = required(HostCube.all[0], "created cube");
  expect(cube.autouv).toBe(1);
  expect(cube.box_uv).toBe(false);
  expect(autoUvCalls).toEqual([cube.uuid]);
  expect(autoUvInputs[0]?.north).toEqual([0, 0, 1, 1]);
  rectangles.forEach(({ face, uv }) => expect(cube.faces[face as Side].uv).toEqual(uv));
  const created = model();
  undo.undo();
  expect(HostCube.all).toEqual([]);
  undo.redo();
  expect(model()).toEqual(created);
});

test.each([...SIDES])("Hytale %s rectangles with incompatible extents reject the whole batch before Undo", async face => {
  format.id = "hytale_prop";
  await expect(tools.call("place_cube", {
    elements: [{ name: "First", from: [0, 0, 0], to: [1, 1, 1] }, { name: "Second", from: [0, 0, 0], to: [6, 4, 2] }],
    faces: [{ face, uv: [3, 5, 4, 6] }],
  })).rejects.toThrow(`Hytale cube "Second" face "${face}" requires UV extents`);
  expect(undo.starts).toBe(0);
  expect(HostCube.all).toEqual([]);
});

test.each([{ faces: false }, { faces: [] }])("Hytale faces=$faces skips texture assignment while retaining native Auto UV 1", async ({ faces }) => {
  format.id = "hytale_character";
  const texture = addTexture();
  await tools.call("place_cube", { elements: [{ name: "Blockout", from: [0, 0, 0], to: [6, 4, 2] }], texture: texture.uuid, faces });
  const cube = required(HostCube.all[0], "created cube");
  expect(cube.autouv).toBe(1);
  expect(textureCalls).toEqual([]);
  expect(autoUvCalls).toEqual([cube.uuid]);
  expect(cube.faces.north.uv).toEqual([0, 0, 6, 4]);
});

test("Hytale rejects overflowing cube dimensions before Undo", async () => {
  format.id = "hytale_prop";
  await expect(tools.call("place_cube", {
    elements: [{ name: "Overflow", from: [-Number.MAX_VALUE, 0, 0], to: [Number.MAX_VALUE, 1, 1] }],
  })).rejects.toThrow("Hytale cube dimensions must be finite");
  expect(undo.starts).toBe(0);
  expect(HostCube.all).toEqual([]);
});

test.each([{ faces: ["north"] }, { faces: [{ face: "north", uv: [0, 0, 4, 4] }] }])("fixed box UV rejects partial/custom faces before Undo", async ({ faces }) => {
  project.box_uv = true;
  format.box_uv = true;
  await expect(tools.call("place_cube", { elements: [{ name: "Bad" }], faces })).rejects.toThrow("only supports box UV");
  expect(undo.starts).toBe(0);
  expect(HostCube.all).toEqual([]);
});

test("fixed box UV still permits all-six face assignment", async () => {
  const texture = addTexture();
  project.box_uv = true;
  format.box_uv = true;
  await tools.call("place_cube", { elements: [{ name: "Box" }], faces: [...SIDES] });
  const cube = required(HostCube.all[0], "created cube");
  expect(cube.box_uv).toBe(true);
  expect(SIDES.every(side => cube.faces[side].texture === texture.uuid)).toBe(true);
});

test("missing texture and missing or ambiguous groups reject before Undo", async () => {
  new HostGroup("duplicate");
  new HostGroup("duplicate");
  await expect(tools.call("place_cube", { elements: [{ name: "Bad" }], texture: "missing" })).rejects.toThrow('No texture found for "missing".');
  await expect(tools.call("place_cube", { elements: [{ name: "Bad" }], group: "missing" })).rejects.toThrow('Parent group "missing" not found.');
  await expect(tools.call("place_cube", { elements: [{ name: "Bad" }], group: "duplicate" })).rejects.toThrow('Parent group name "duplicate" is ambiguous.');
  expect(undo.starts).toBe(0);
  expect(HostCube.all).toEqual([]);
});

test("group UUID takes precedence over a different group's matching name", async () => {
  const parent = new HostGroup("target");
  const shadow = new HostGroup(parent.uuid);
  await tools.call("place_cube", { elements: [{ name: "Child" }], group: parent.uuid });
  expect(HostCube.all[0]?.parent).toBe(parent);
  expect(shadow.children).toEqual([]);
});

test.each(["from", "to", "origin", "rotation"])("non-finite %s rejects before Undo", async property => {
  await expect(tools.call("place_cube", { elements: [{ name: "Bad", [property]: [0, Infinity, 0] }] })).rejects.toThrow("finite numbers");
  expect(undo.starts).toBe(0);
  expect(HostCube.all).toEqual([]);
});

test("non-finite UVs and duplicate face targets reject before Undo", async () => {
  await expect(tools.call("place_cube", { elements: [{ name: "Bad" }], faces: [{ face: "north", uv: [0, 0, Infinity, 1] }] })).rejects.toThrow();
  await expect(tools.call("place_cube", { elements: [{ name: "Bad" }], faces: ["up", "up"] })).rejects.toThrow("only be specified once");
  expect(undo.starts).toBe(0);
});

test.each(["initialization", "preview", "parent"])("%s failure rolls back the whole cube batch", async failure => {
  const parent = new HostGroup("Parent");
  new HostCube({ name: "Existing" }).init().addTo(parent);
  const before = model();
  failInitName = failure === "initialization" ? "Second" : undefined;
  failRefresh = failure === "preview";
  refuseParent = failure === "parent";
  await expect(tools.call("place_cube", {
    elements: [{ name: "First" }, { name: "Second" }], group: parent.uuid,
  })).rejects.toThrow();
  expect(model()).toEqual(before);
  expect(undo.pending).toBeUndefined();
  expect(undo.lastEdit).toBeUndefined();
  expect(undo.cancels).toBe(1);
});

test("modify_cube records one undo entry and re-maps auto UV after a resize", async () => {
  const cube = new HostCube({ name: "Box", autouv: 1 }).init();
  const before = model();
  await tools.call("modify_cube", { id: cube.uuid, to: [6, 4, 2] });
  const modified = model();
  expect(cube.to).toEqual([6, 4, 2]);
  expect(autoUvCalls).toEqual([cube.uuid]);
  expect(undo.starts).toBe(1);
  expect(undo.finishes).toBe(1);
  undo.undo();
  expect(model()).toEqual(before);
  undo.redo();
  expect(model()).toEqual(modified);
});

test.each(["auto UV", "preview"])("modify_cube %s failure reverts every cube and closes the edit", async failure => {
  const first = new HostCube({ name: "First", autouv: 1 }).init();
  const second = new HostCube({ name: "Second", autouv: 1 }).init();
  HostCube.selected = [first, second];
  const before = model();
  failAutoUv = failure === "auto UV";
  failRefresh = failure === "preview";
  await expect(tools.call("modify_cube", { from: [1, 1, 1], to: [5, 5, 5] })).rejects.toThrow(failure === "preview" ? "Preview failed" : "Auto UV failed");
  expect(model()).toEqual(before);
  expect(undo.pending).toBeUndefined();
  expect(undo.lastEdit).toBeUndefined();
  expect(undo.cancels).toBe(1);
});

test("inflate, uv_offset and mirror_uv reach box UV cubes and survive undo/redo", async () => {
  project.box_uv = true;
  format.box_uv = true;
  format.optional_box_uv = true;
  await tools.call("place_cube", { elements: [{ name: "Hat", from: [0, 0, 0], to: [8, 8, 8], inflate: 0.5, uv_offset: [32, 0], mirror_uv: true }] });
  const cube = required(HostCube.all[0], "created cube");
  expect(cube).toMatchObject({ box_uv: true, inflate: 0.5, uv_offset: [32, 0], mirror_uv: true });
  const created = model();
  undo.undo();
  expect(HostCube.all).toEqual([]);
  undo.redo();
  expect(model()).toEqual(created);
});

test("inflate applies to per-face cubes too", async () => {
  await tools.call("place_cube", { elements: [{ name: "Shell", inflate: 0.25 }] });
  expect(required(HostCube.all[0], "created cube").inflate).toBe(0.25);
});

test.each([
  { label: "a per-face project", setup: () => {}, faces: undefined },
  { label: "partial faces in a box UV project", setup: () => { project.box_uv = true; format.box_uv = true; format.optional_box_uv = true; }, faces: ["up"] },
])("uv_offset and mirror_uv are refused before Undo for $label", async ({ setup, faces }) => {
  setup();
  await expect(tools.call("place_cube", { elements: [{ name: "Arm", uv_offset: [16, 0] }], ...(faces && { faces }) })).rejects.toThrow('Cube "Arm": uv_offset and mirror_uv place the box UV net');
  await expect(tools.call("place_cube", { elements: [{ name: "Arm", mirror_uv: true }], ...(faces && { faces }) })).rejects.toThrow("per-face UV");
  expect(undo.starts).toBe(0);
  expect(HostCube.all).toEqual([]);
});

test("no-op uv_offset and mirror_uv values are accepted on per-face cubes", async () => {
  await tools.call("place_cube", { elements: [{ name: "Plain", uv_offset: [0, 0], mirror_uv: false }] });
  expect(required(HostCube.all[0], "created cube")).toMatchObject({ box_uv: false, uv_offset: [0, 0], mirror_uv: false });
});

test("unknown element fields are rejected instead of silently dropped", async () => {
  await expect(tools.call("place_cube", { elements: [{ name: "Typo", inflat: 0.5 }] })).rejects.toThrow("Unrecognized key");
  await expect(tools.call("place_cube", { elements: [{ name: "Unsupported", box_uv: false }] })).rejects.toThrow("Unrecognized key");
  expect(undo.starts).toBe(0);
  expect(HostCube.all).toEqual([]);
});

test("place_cube refuses cubes the format's size limiter rejects and reverts the whole batch", async () => {
  format.id = "java_block";
  format.cube_size_limiter = javaBlockLimiter;
  const before = model();
  await expect(tools.call("place_cube", {
    elements: [{ name: "near", to: [2, 2, 2] }, { name: "far", from: [40, 0, 0], to: [41, 1, 1] }],
  })).rejects.toThrow('The java_block format\'s size limit refuses "far": every coordinate, including inflate, must stay within -16…32.');
  expect(model()).toEqual(before);
  expect(undo.pending).toBeUndefined();
  expect(undo.lastEdit).toBeUndefined();
  expect(undo.cancels).toBe(1);
});

test("place_cube accepts cubes inside the size limit and counts inflate", async () => {
  format.id = "java_block";
  format.cube_size_limiter = javaBlockLimiter;
  await tools.call("place_cube", { elements: [{ name: "edge", from: [30, 0, 0], to: [32, 2, 2] }] });
  await expect(tools.call("place_cube", { elements: [{ name: "puffy", from: [30, 0, 0], to: [32, 2, 2], inflate: 0.5 }] })).rejects.toThrow('refuses "puffy"');
  expect(HostCube.all.map(cube => cube.name)).toEqual(["edge"]);
});

test("modify_cube refuses a new size the limiter rejects before Undo, and leaves other edits alone", async () => {
  format.id = "java_block";
  format.cube_size_limiter = javaBlockLimiter;
  const inside = new HostCube({ name: "inside", from: [0, 0, 0], to: [4, 4, 4] }).init();
  const outside = new HostCube({ name: "outside", from: [40, 0, 0], to: [41, 1, 1] }).init();
  await expect(tools.call("modify_cube", { id: inside.uuid, to: [4, 40, 4] })).rejects.toThrow('refuses "inside"');
  await expect(tools.call("modify_cube", { id: inside.uuid, inflate: 20 })).rejects.toThrow('refuses "inside"');
  expect(undo.starts).toBe(0);
  expect(inside.to).toEqual([4, 4, 4]);
  // Renaming or rotating a cube that is already out of bounds is not a new size.
  await tools.call("modify_cube", { id: outside.uuid, name: "renamed", rotation: [0, 45, 0] });
  expect(outside).toMatchObject({ name: "renamed", rotation: [0, 45, 0] });
});

test("the Deactivate Size Limit setting lets geometry past the limit through", async () => {
  format.id = "java_block";
  format.cube_size_limiter = javaBlockLimiter;
  settings.deactivate_size_limit.value = true;
  await tools.call("place_cube", { elements: [{ name: "far", from: [40, 0, 0], to: [41, 1, 1] }] });
  const far = required(HostCube.all[0], "created cube");
  await tools.call("modify_cube", { id: far.uuid, to: [60, 1, 1] });
  expect(far.to).toEqual([60, 1, 1]);
});

test("formats without a size limiter are unaffected", async () => {
  await tools.call("place_cube", { elements: [{ name: "far", from: [400, 0, 0], to: [401, 1, 1] }] });
  await tools.call("modify_cube", { id: required(HostCube.all[0], "created cube").uuid, to: [600, 1, 1] });
  expect(HostCube.all[0]?.to).toEqual([600, 1, 1]);
});

test("a limiter without coordinate limits is described by its box size", async () => {
  format.id = "bedrock_block";
  format.cube_size_limiter = { box_marker_size: [30, 30, 30], test: () => true };
  const cube = new HostCube({ name: "tower" }).init();
  await expect(tools.call("modify_cube", { id: cube.uuid, to: [1, 40, 1] })).rejects.toThrow('The bedrock_block format\'s size limit refuses "tower": the model must fit in a 30×30×30 box.');
});
