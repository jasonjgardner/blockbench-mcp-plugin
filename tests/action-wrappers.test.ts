import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Object3D, OrthographicCamera, Vector3 } from "three";
import { deleteMeshSelection, extrudeMeshFaces, subdivideMeshFaces } from "@/lib/mesh-editing";
import { getAllToolDefinitions } from "@/lib/factories";
import { registerUVTools, autoUvMeshParametersSchema, rotateMeshUvParametersSchema, setMeshUvParametersSchema } from "@/server/tools/uv";
import { registerUITools, triggerActionParametersSchema } from "@/server/tools/ui";

type Vector = [number, number, number];
type UV = [number, number];
type Selection = { vertices: string[]; edges: string[][]; faces: string[] };
type FaceData = { vertices: string[]; uv?: Record<string, UV>; texture?: string | false };
type Snapshot = { vertices: Record<string, Vector>; faces: Record<string, FaceData>; selected: Selection | undefined };
let project: { mesh_selection: Record<string, Selection>; texture_width: number; texture_height: number };
let nextKey = 0;
let refreshFailure = false;

class HostFace {
  vertices: string[] = [];
  uv: Record<string, UV> = {};
  texture: string | false = false;
  constructor(readonly mesh: HostMesh, data: FaceData) { this.extend(data); }
  extend(data: Partial<FaceData>): this {
    if (data.vertices) this.vertices = [...data.vertices];
    if (data.uv) this.uv = structuredClone(data.uv);
    if (data.texture !== undefined) this.texture = data.texture;
    this.vertices.forEach(key => { this.uv[key] ??= [0, 0]; });
    return this;
  }
  getSortedVertices(): string[] { return [...this.vertices]; }
  getNormal(): Vector {
    const [a, b, c] = this.vertices.map(key => new Vector3(...this.mesh.vertices[key]));
    return b.sub(a).cross(c.sub(a)).normalize().toArray() as Vector;
  }
}

class HostMesh {
  static all: HostMesh[] = [];
  static selected: HostMesh[] = [];
  uuid = `mesh-${++nextKey}`;
  name = this.uuid;
  vertices: Record<string, Vector> = {};
  faces: Record<string, HostFace> = {};
  mesh = new Object3D();
  constructor(points: Vector[], polygons: number[][]) {
    const keys = this.addVertices(...points);
    polygons.forEach(indices => this.addFaces(new HostFace(this, { vertices: indices.map(index => keys[index]), texture: "material" })));
    HostMesh.all.push(this);
  }
  addVertices(...points: Vector[]): string[] {
    return points.map(point => { const key = `v${++nextKey}`; this.vertices[key] = [...point]; return key; });
  }
  addFaces(face: HostFace): string[] { const key = `f${++nextKey}`; this.faces[key] = face; return [key]; }
  getSelectedFaces(): string[] { return project.mesh_selection[this.uuid]?.faces ?? []; }
  getWorldCenter(): Vector3 { return new Vector3(); }
}

const quad = (): HostMesh => new HostMesh([[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]], [[0, 1, 2, 3]]);
const asMesh = (mesh: HostMesh): Mesh => mesh as unknown as Mesh;
const select = (mesh: HostMesh): void => { project.mesh_selection[mesh.uuid] = { vertices: Object.keys(mesh.vertices), edges: [], faces: Object.keys(mesh.faces) }; };
function snapshot(mesh: HostMesh): Snapshot {
  return { vertices: structuredClone(mesh.vertices), faces: Object.fromEntries(Object.entries(mesh.faces).map(([key, face]) => [key, { vertices: [...face.vertices], uv: structuredClone(face.uv), texture: face.texture }])), selected: structuredClone(project.mesh_selection[mesh.uuid]) };
}
function restore(mesh: HostMesh, value: Snapshot): void {
  mesh.vertices = structuredClone(value.vertices);
  mesh.faces = Object.fromEntries(Object.entries(value.faces).map(([key, data]) => [key, new HostFace(mesh, data)]));
  if (value.selected) project.mesh_selection[mesh.uuid] = structuredClone(value.selected);
  if (!value.selected) delete project.mesh_selection[mesh.uuid];
}
const undo = {
  starts: 0,
  finishes: 0,
  mesh: undefined as HostMesh | undefined,
  before: undefined as Snapshot | undefined,
  after: undefined as Snapshot | undefined,
  initEdit(aspects: { elements: HostMesh[] }): void {
    if (this.mesh) throw new Error("Nested Undo transaction");
    this.starts++;
    this.mesh = aspects.elements[0];
    if (this.mesh) this.before = snapshot(this.mesh);
  },
  finishEdit(): void { this.finishes++; if (this.mesh) this.after = snapshot(this.mesh); this.mesh = undefined; },
  cancelEdit(revert: boolean): void { if (revert && this.mesh && this.before) restore(this.mesh, this.before); this.mesh = undefined; },
};
class HostAction {
  constructor(readonly invoke: (event: MouseEvent) => boolean) {}
  trigger(event: MouseEvent): boolean { return this.invoke(event); }
}
class HostMouseEvent extends Event {
  shiftKey: boolean;
  constructor(type: string, options: MouseEventInit = {}) { super(type); this.shiftKey = !!options.shiftKey; }
}
const original = new Map<string, PropertyDescriptor | undefined>();
const globalKeys = ["Project", "Mesh", "MeshFace", "Undo", "Canvas", "UVEditor", "THREE", "BarItems", "Action", "MouseEvent", "Dialog", "Blockbench", "Preview", "window"];
beforeAll(() => {
  globalKeys.forEach(key => original.set(key, Object.getOwnPropertyDescriptor(globalThis, key)));
  registerUVTools();
  registerUITools();
});
beforeEach(() => {
  project = { mesh_selection: {}, texture_width: 16, texture_height: 16 };
  nextKey = 0;
  refreshFailure = false;
  HostMesh.all = [];
  HostMesh.selected = [];
  Object.assign(undo, { starts: 0, finishes: 0, mesh: undefined, before: undefined, after: undefined });
  Object.assign(globalThis, {
    Project: project, Mesh: HostMesh, MeshFace: HostFace, Undo: undo, THREE: { Vector3 },
    Canvas: { updateView() { if (refreshFailure) throw new Error("Preview failure"); } },
    UVEditor: { loadData() {} }, BarItems: {}, Action: HostAction, MouseEvent: HostMouseEvent,
    Dialog: { stack: [], open: undefined }, Blockbench: { isWeb: true },
  });
});
afterAll(() => original.forEach((descriptor, key) => {
  if (descriptor) { Object.defineProperty(globalThis, key, descriptor); return; }
  Reflect.deleteProperty(globalThis, key);
}));

describe("headless mesh operations", () => {
  test.each([2.5, -3])("face extrusion honors signed distance %s and one undo snapshot", distance => {
    const mesh = quad();
    select(mesh);
    const before = snapshot(mesh);
    const other = quad();
    HostMesh.selected = [other];
    const untouched = snapshot(other);
    const result = extrudeMeshFaces(asMesh(mesh), distance);
    expect(result.vertex_keys.map(key => mesh.vertices[key][2])).toEqual([distance, distance, distance, distance]);
    expect(Object.keys(mesh.vertices)).toHaveLength(8);
    expect(Object.keys(mesh.faces)).toHaveLength(5);
    expect(Object.values(mesh.faces).every(face => face.texture === "material")).toBe(true);
    expect(snapshot(other)).toEqual(untouched);
    expect(undo.starts).toBe(1);
    const after = snapshot(mesh);
    restore(mesh, undo.before!);
    expect(snapshot(mesh)).toEqual(before);
    restore(mesh, undo.after!);
    expect(snapshot(mesh)).toEqual(after);
  });
  test("adjacent face extrusion has boundary walls without an internal wall", () => {
    const mesh = new HostMesh([[0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 1, 0], [1, 1, 0], [2, 1, 0]], [[0, 1, 4, 3], [1, 2, 5, 4]]);
    select(mesh);
    extrudeMeshFaces(asMesh(mesh), 2);
    expect(Object.keys(mesh.vertices)).toHaveLength(12);
    expect(Object.keys(mesh.faces)).toHaveLength(8);
  });
  test.each([1, 2, 4])("quad subdivision honors %s cuts and interpolates UV/material", cuts => {
    const mesh = quad();
    const face = Object.values(mesh.faces)[0];
    face.vertices.forEach(key => { face.uv[key] = [mesh.vertices[key][0] * 4, mesh.vertices[key][1] * 4]; });
    select(mesh);
    const result = subdivideMeshFaces(asMesh(mesh), cuts);
    expect(result.face_keys).toHaveLength((cuts + 1) ** 2);
    expect(Object.keys(mesh.vertices)).toHaveLength((cuts + 2) ** 2);
    Object.values(mesh.faces).forEach(child => {
      expect(child.getNormal()[2]).toBeCloseTo(1);
      expect(child.texture).toBe("material");
      child.vertices.forEach(key => { expect(child.uv[key][0]).toBeCloseTo(mesh.vertices[key][0] * 4); });
    });
    const after = snapshot(mesh);
    restore(mesh, undo.before!);
    expect(Object.keys(mesh.faces)).toHaveLength(1);
    restore(mesh, undo.after!);
    expect(snapshot(mesh)).toEqual(after);
  });
  test("triangle subdivision preserves winding and produces cuts+1 squared triangles", () => {
    const mesh = new HostMesh([[0, 0, 0], [2, 0, 0], [0, 2, 0]], [[0, 1, 2]]);
    select(mesh);
    subdivideMeshFaces(asMesh(mesh), 2);
    expect(Object.keys(mesh.faces)).toHaveLength(9);
    expect(Object.keys(mesh.vertices)).toHaveLength(10);
    expect(Object.values(mesh.faces).every(face => face.vertices.length === 3 && face.getNormal()[2] === 1)).toBe(true);
  });
  test("neighboring subdivided faces share new boundary vertices", () => {
    const mesh = new HostMesh([[0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 1, 0], [1, 1, 0], [2, 1, 0]], [[0, 1, 4, 3], [1, 2, 5, 4]]);
    select(mesh);
    subdivideMeshFaces(asMesh(mesh), 2);
    expect(Object.keys(mesh.vertices)).toHaveLength(28);
    expect(Object.keys(mesh.faces)).toHaveLength(18);
  });
  test.each([true, false])("face deletion respects keep_vertices=%s and leaves unrelated loose vertices", keep => {
    const mesh = quad();
    select(mesh);
    const [loose] = mesh.addVertices([9, 9, 9]);
    const result = deleteMeshSelection(asMesh(mesh), "faces", keep);
    expect(result).toEqual({ deleted_faces: 1, deleted_vertices: keep ? 0 : 4 });
    expect(mesh.vertices[loose]).toEqual([9, 9, 9]);
    restore(mesh, undo.before!);
    expect(Object.keys(mesh.faces)).toHaveLength(1);
  });
  test.each(["edges", "vertices"] as const)("%s deletion removes incident faces without dangling references", mode => {
    const mesh = quad();
    const keys = Object.keys(mesh.vertices);
    project.mesh_selection[mesh.uuid] = { faces: [], edges: [[keys[0], keys[1]]], vertices: [keys[0]] };
    deleteMeshSelection(asMesh(mesh), mode, true);
    expect(Object.keys(mesh.faces)).toHaveLength(0);
    expect(Object.keys(mesh.vertices)).toHaveLength(mode === "vertices" ? 3 : 4);
  });
  test("invalid/empty selections fail before Undo and preview failures roll back geometry", () => {
    const mesh = quad();
    expect(() => extrudeMeshFaces(asMesh(mesh), 1)).toThrow("No faces selected");
    expect(() => deleteMeshSelection(asMesh(mesh), "faces", false)).toThrow("No faces selected");
    expect(project.mesh_selection[mesh.uuid]).toBeUndefined();
    expect(undo.starts).toBe(0);
    select(mesh);
    const before = snapshot(mesh);
    refreshFailure = true;
    expect(() => subdivideMeshFaces(asMesh(mesh), 1)).toThrow("Preview failure");
    expect(snapshot(mesh)).toEqual(before);
    expect(undo.finishes).toBe(0);
    expect(undo.mesh).toBeUndefined();
  });
});

describe("targeted UV and native action boundaries", () => {
  test("project UV keeps adjacent face tuples independent during native in-place undo restoration", async () => {
    const mesh = new HostMesh([[0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 1, 0], [1, 1, 0], [2, 1, 0]], [[0, 1, 4, 3], [1, 2, 5, 4]]);
    const faces = Object.values(mesh.faces);
    faces.forEach((face, index) => face.vertices.forEach(key => { face.uv[key] = [index * 8, index * 4]; }));
    const before = snapshot(mesh);
    const camera = new OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
    camera.position.z = 10;
    camera.updateMatrixWorld(true);
    Object.assign(globalThis, { Preview: { selected: { camera, canvas: { width: 100, height: 100 }, calculateControlScale: () => 14 } }, window: { devicePixelRatio: 1 } });
    await getAllToolDefinitions().auto_uv_mesh.execute(autoUvMeshParametersSchema.parse({ mesh_id: mesh.uuid, faces: Object.keys(mesh.faces), mode: "project" }));
    const shared = faces[0].vertices.filter(key => faces[1].vertices.includes(key));
    shared.forEach(key => expect(faces[0].uv[key]).not.toBe(faces[1].uv[key]));
    // Blockbench's MeshFace.extend mutates each existing UV array via .replace,
    // rather than replacing the per-face dictionary or each array reference.
    Object.entries(undo.before!.faces).forEach(([key, face]) => {
      Object.entries(face.uv ?? {}).forEach(([vertex, uv]) => { mesh.faces[key].uv[vertex].splice(0, 2, ...uv); });
    });
    expect(snapshot(mesh)).toEqual(before);
  });
  test("unwrap and rotate honor explicit unselected target faces and retain another mesh", async () => {
    const mesh = quad();
    const other = quad();
    select(other);
    HostMesh.selected = [other];
    const untouched = snapshot(other);
    const face = Object.keys(mesh.faces)[0];
    await getAllToolDefinitions().auto_uv_mesh.execute(autoUvMeshParametersSchema.parse({ mesh_id: mesh.uuid, faces: [face], mode: "unwrap" }));
    expect(new Set(Object.values(mesh.faces[face].uv).map(uv => uv.join(","))).size).toBe(4);
    const beforeRotate = snapshot(mesh);
    await getAllToolDefinitions().rotate_mesh_uv.execute(rotateMeshUvParametersSchema.parse({ mesh_id: mesh.uuid, faces: [face], angle: "90" }));
    expect(snapshot(mesh).faces).not.toEqual(beforeRotate.faces);
    expect(snapshot(other)).toEqual(untouched);
    expect(HostMesh.selected).toEqual([other]);
    expect(project.mesh_selection[mesh.uuid]).toBeUndefined();
    restore(mesh, undo.before!);
    expect(snapshot(mesh)).toEqual(beforeRotate);
  });
  test("bad UV keys and sphere mapping at local origin fail before Undo", async () => {
    const mesh = quad();
    const face = Object.keys(mesh.faces)[0];
    await expect(getAllToolDefinitions().set_mesh_uv.execute(setMeshUvParametersSchema.parse({ mesh_id: mesh.uuid, face_key: face, uv_mapping: { missing: [1, 2] } }))).rejects.toThrow("existing vertex keys");
    await expect(getAllToolDefinitions().auto_uv_mesh.execute(autoUvMeshParametersSchema.parse({ mesh_id: mesh.uuid, faces: [face], mode: "sphere" }))).rejects.toThrow("local origin");
    expect(undo.starts).toBe(0);
  });
  test("native action owns its edit and cannot auto-confirm a preexisting dialog", async () => {
    const mesh = quad();
    let confirms = 0;
    const existing = { confirm() { confirms++; } };
    Object.assign(globalThis, { Dialog: { stack: [existing], open: existing }, BarItems: {
      native: new HostAction(event => { expect(event.shiftKey).toBe(true); undo.initEdit({ elements: [mesh] }); mesh.name = "native"; undo.finishEdit(); return true; }),
    } });
    await getAllToolDefinitions().trigger_action.execute(triggerActionParametersSchema.parse({ action: "native", confirmEvent: '{"shiftKey":true}' }));
    expect(undo.starts).toBe(1);
    expect(undo.finishes).toBe(1);
    expect(confirms).toBe(0);
  });
  test("action errors reject invalid JSON/non-Actions/unavailable conditions without edits", async () => {
    Object.assign(globalThis, { BarItems: { nonaction: {}, unavailable: new HostAction(() => false) } });
    for (const input of [{ action: "missing" }, { action: "nonaction" }, { action: "unavailable" }, { action: "unavailable", confirmEvent: "null" }]) {
      await expect(getAllToolDefinitions().trigger_action.execute(triggerActionParametersSchema.parse(input))).rejects.toThrow();
    }
    expect(undo.starts).toBe(0);
  });
  test("read-only eval leaves history unchanged and thrown code returns an error", async () => {
    expect(await getAllToolDefinitions().risky_eval.execute({ code: "({answer: 42})" })).toBe('{"answer":42}');
    await expect(getAllToolDefinitions().risky_eval.execute({ code: "throw new Error('bad code')" })).rejects.toThrow("bad code");
    expect(undo.starts).toBe(0);
    expect(undo.finishes).toBe(0);
  });
});
