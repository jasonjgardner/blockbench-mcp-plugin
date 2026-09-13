import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Object3D, OrthographicCamera, Vector3 } from "three";
import { deleteMeshSelection, extrudeMeshFaces, subdivideMeshFaces } from "@/lib/mesh-editing";
import { registerUVTools } from "@/server/tools/uv";
import { registerUITools } from "@/server/tools/ui";
import { required } from "@/tests/helpers/assertions";
import { useGlobals } from "@/tests/helpers/globals";
import type { IMeshSelection, MeshSelectionMap, UvTuple, Vector3Tuple } from "@/tests/helpers/shapes";
import { executeTool } from "@/tests/helpers/tool-execution";
import { createUndoHost } from "@/tests/helpers/undo-host";

interface IFaceData {
  vertices: string[];
  uv?: Record<string, UvTuple>;
  texture?: string | false;
}

interface ISnapshot {
  vertices: Record<string, Vector3Tuple>;
  faces: Record<string, IFaceData>;
  selected: IMeshSelection | undefined;
}

interface IHostProject {
  mesh_selection: MeshSelectionMap;
  texture_width: number;
  texture_height: number;
}

/** Undo aspects the wrappers pass to `Undo.initEdit`; only the first element is snapshotted. */
interface IHostEditAspects {
  elements: readonly HostMesh[];
}

/** Undo snapshot of the edited mesh, or `undefined` when an edit names no elements. */
interface IMeshEditState {
  mesh: HostMesh;
  state: ISnapshot;
}

/**
 * uv.ts divides `Preview#calculateControlScale` by Blockbench's Project-from-View
 * scale divisor (14); returning the divisor keeps the projected UV scale at exactly 1.
 */
const UNIT_PROJECTION_CONTROL_SCALE = 14;

let project: IHostProject;
let nextKey = 0;
let refreshFailure = false;

class HostFace {
  vertices: string[] = [];
  uv: Record<string, UvTuple> = {};
  texture: string | false = false;
  constructor(readonly mesh: HostMesh, data: IFaceData) {
    this.extend(data);
  }
  extend(data: Partial<IFaceData>): this {
    if (data.vertices) this.vertices = [...data.vertices];
    if (data.uv) this.uv = structuredClone(data.uv);
    if (data.texture !== undefined) this.texture = data.texture;
    this.vertices.forEach(key => { this.uv[key] ??= [0, 0]; });
    return this;
  }
  getSortedVertices(): string[] {
    return [...this.vertices];
  }
  getNormal(): Vector3Tuple {
    const [a, b, c] = this.vertices.map(key => new Vector3(...this.mesh.vertices[key]));
    const { x, y, z } = b.sub(a).cross(c.sub(a)).normalize();
    return [x, y, z];
  }
}

class HostMesh {
  static all: HostMesh[] = [];
  static selected: HostMesh[] = [];
  uuid = `mesh-${++nextKey}`;
  name = this.uuid;
  vertices: Record<string, Vector3Tuple> = {};
  faces: Record<string, HostFace> = {};
  mesh = new Object3D();
  constructor(points: Vector3Tuple[], polygons: number[][]) {
    const keys = this.addVertices(...points);
    polygons.forEach(indices => this.addFaces(new HostFace(this, { vertices: indices.map(index => keys[index]), texture: "material" })));
    HostMesh.all.push(this);
  }
  addVertices(...points: Vector3Tuple[]): string[] {
    return points.map(point => {
      const key = `v${++nextKey}`;
      this.vertices[key] = [...point];
      return key;
    });
  }
  addFaces(face: HostFace): string[] {
    const key = `f${++nextKey}`;
    this.faces[key] = face;
    return [key];
  }
  getSelectedFaces(): string[] {
    return project.mesh_selection[this.uuid]?.faces ?? [];
  }
  getWorldCenter(): Vector3 {
    return new Vector3();
  }
}

const quad = (): HostMesh => new HostMesh([[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]], [[0, 1, 2, 3]]);
/** Two quads sharing the edge x = 1, forming a 2 x 1 strip. */
const adjacentQuads = (): HostMesh => new HostMesh([[0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 1, 0], [1, 1, 0], [2, 1, 0]], [[0, 1, 4, 3], [1, 2, 5, 4]]);
const asMesh = (mesh: HostMesh): Mesh => mesh as unknown as Mesh;
const select = (mesh: HostMesh): void => {
  project.mesh_selection[mesh.uuid] = { vertices: Object.keys(mesh.vertices), edges: [], faces: Object.keys(mesh.faces) };
};

function copyFaceData(face: HostFace): IFaceData {
  return { vertices: [...face.vertices], uv: structuredClone(face.uv), texture: face.texture };
}

function snapshot(mesh: HostMesh): ISnapshot {
  const faces = Object.fromEntries(Object.entries(mesh.faces).map(([key, face]) => [key, copyFaceData(face)]));
  return { vertices: structuredClone(mesh.vertices), faces, selected: structuredClone(project.mesh_selection[mesh.uuid]) };
}

function restore(mesh: HostMesh, value: ISnapshot): void {
  mesh.vertices = structuredClone(value.vertices);
  mesh.faces = Object.fromEntries(Object.entries(value.faces).map(([key, data]) => [key, new HostFace(mesh, data)]));
  if (!value.selected) {
    delete project.mesh_selection[mesh.uuid];
    return;
  }
  project.mesh_selection[mesh.uuid] = structuredClone(value.selected);
}

function captureEdit(aspects: IHostEditAspects): IMeshEditState | undefined {
  const mesh = aspects.elements.at(0);
  if (!mesh) return undefined;
  return { mesh, state: snapshot(mesh) };
}

function restoreEdit(target: IMeshEditState | undefined): void {
  if (!target) return;
  restore(target.mesh, target.state);
}

const undo = createUndoHost({ snapshot: captureEdit, restore: restoreEdit });

/** Mesh state recorded on one side of the most recently committed undo entry. */
function committedState(side: "before" | "after"): ISnapshot {
  return required(undo.lastEdit?.[side], `last undo entry ${side} snapshot`).state;
}

class HostAction {
  constructor(readonly invoke: (event: MouseEvent) => boolean) {}
  trigger(event: MouseEvent): boolean {
    return this.invoke(event);
  }
}

class HostMouseEvent extends Event {
  shiftKey: boolean;
  constructor(type: string, options: MouseEventInit = {}) {
    super(type);
    this.shiftKey = !!options.shiftKey;
  }
}

beforeAll(() => {
  registerUVTools();
  registerUITools();
});

beforeEach(() => {
  project = { mesh_selection: {}, texture_width: 16, texture_height: 16 };
  nextKey = 0;
  refreshFailure = false;
  HostMesh.all = [];
  HostMesh.selected = [];
  undo.reset();
});

// Registered after the reset above so the factory installs this test's fresh project;
// Preview and window are assigned by individual tests and restored with the rest.
useGlobals(() => ({
  Project: project,
  Mesh: HostMesh,
  MeshFace: HostFace,
  Undo: undo,
  THREE: { Vector3 },
  Canvas: { updateView() { if (refreshFailure) throw new Error("Preview failure"); } },
  UVEditor: { loadData() {} },
  BarItems: {},
  Action: HostAction,
  MouseEvent: HostMouseEvent,
  Dialog: { stack: [], open: undefined },
  Blockbench: { isWeb: true },
}), ["Preview", "window"]);

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
    restore(mesh, committedState("before"));
    expect(snapshot(mesh)).toEqual(before);
    restore(mesh, committedState("after"));
    expect(snapshot(mesh)).toEqual(after);
  });
  test("adjacent face extrusion has boundary walls without an internal wall", () => {
    const mesh = adjacentQuads();
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
    restore(mesh, committedState("before"));
    expect(Object.keys(mesh.faces)).toHaveLength(1);
    restore(mesh, committedState("after"));
    expect(snapshot(mesh)).toEqual(after);
  });
  test("triangle subdivision preserves winding and produces cuts+1 squared triangles", () => {
    const cuts = 2;
    const segments = cuts + 1;
    const mesh = new HostMesh([[0, 0, 0], [2, 0, 0], [0, 2, 0]], [[0, 1, 2]]);
    select(mesh);
    subdivideMeshFaces(asMesh(mesh), cuts);
    expect(Object.keys(mesh.faces)).toHaveLength(segments ** 2);
    // A triangular lattice with n segments per edge has (n + 1)(n + 2) / 2 points.
    expect(Object.keys(mesh.vertices)).toHaveLength(((segments + 1) * (segments + 2)) / 2);
    expect(Object.values(mesh.faces).every(face => face.vertices.length === 3 && face.getNormal()[2] === 1)).toBe(true);
  });
  test("neighboring subdivided faces share new boundary vertices", () => {
    const cuts = 2;
    const segments = cuts + 1;
    const sourceFaces = 2;
    const mesh = adjacentQuads();
    select(mesh);
    subdivideMeshFaces(asMesh(mesh), cuts);
    // Sharing the middle edge leaves one (2n + 1) x (n + 1) lattice instead of two separate (n + 1)² grids.
    expect(Object.keys(mesh.vertices)).toHaveLength((sourceFaces * segments + 1) * (segments + 1));
    expect(Object.keys(mesh.faces)).toHaveLength(sourceFaces * segments ** 2);
  });
  test.each([true, false])("face deletion respects keep_vertices=%s and leaves unrelated loose vertices", keep => {
    const mesh = quad();
    select(mesh);
    const [loose] = mesh.addVertices([9, 9, 9]);
    const result = deleteMeshSelection(asMesh(mesh), "faces", keep);
    expect(result).toEqual({ deleted_faces: 1, deleted_vertices: keep ? 0 : 4 });
    expect(mesh.vertices[loose]).toEqual([9, 9, 9]);
    restore(mesh, committedState("before"));
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
    expect(undo.pending).toBeUndefined();
  });
});

describe("targeted UV and native action boundaries", () => {
  test("project UV keeps adjacent face tuples independent during native in-place undo restoration", async () => {
    const mesh = adjacentQuads();
    const faces = Object.values(mesh.faces);
    faces.forEach((face, index) => face.vertices.forEach(key => { face.uv[key] = [index * 8, index * 4]; }));
    const before = snapshot(mesh);
    const camera = new OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
    camera.position.z = 10;
    camera.updateMatrixWorld(true);
    Object.assign(globalThis, {
      Preview: { selected: { camera, canvas: { width: 100, height: 100 }, calculateControlScale: () => UNIT_PROJECTION_CONTROL_SCALE } },
      window: { devicePixelRatio: 1 },
    });
    await executeTool("auto_uv_mesh", { mesh_id: mesh.uuid, faces: Object.keys(mesh.faces), mode: "project" });
    const shared = faces[0].vertices.filter(key => faces[1].vertices.includes(key));
    shared.forEach(key => expect(faces[0].uv[key]).not.toBe(faces[1].uv[key]));
    // Blockbench's MeshFace.extend mutates each existing UV array via .replace,
    // rather than replacing the per-face dictionary or each array reference.
    Object.entries(committedState("before").faces).forEach(([key, face]) => {
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
    await executeTool("auto_uv_mesh", { mesh_id: mesh.uuid, faces: [face], mode: "unwrap" });
    expect(new Set(Object.values(mesh.faces[face].uv).map(uv => uv.join(","))).size).toBe(4);
    const beforeRotate = snapshot(mesh);
    await executeTool("rotate_mesh_uv", { mesh_id: mesh.uuid, faces: [face], angle: "90" });
    expect(snapshot(mesh).faces).not.toEqual(beforeRotate.faces);
    expect(snapshot(other)).toEqual(untouched);
    expect(HostMesh.selected).toEqual([other]);
    expect(project.mesh_selection[mesh.uuid]).toBeUndefined();
    restore(mesh, committedState("before"));
    expect(snapshot(mesh)).toEqual(beforeRotate);
  });
  test("bad UV keys and sphere mapping at local origin fail before Undo", async () => {
    const mesh = quad();
    const face = Object.keys(mesh.faces)[0];
    await expect(executeTool("set_mesh_uv", { mesh_id: mesh.uuid, face_key: face, uv_mapping: { missing: [1, 2] } })).rejects.toThrow("existing vertex keys");
    await expect(executeTool("auto_uv_mesh", { mesh_id: mesh.uuid, faces: [face], mode: "sphere" })).rejects.toThrow("local origin");
    expect(undo.starts).toBe(0);
  });
  test("native action owns its edit and cannot auto-confirm a preexisting dialog", async () => {
    const mesh = quad();
    let confirms = 0;
    const existing = { confirm() { confirms++; } };
    const native = new HostAction(event => {
      expect(event.shiftKey).toBe(true);
      undo.initEdit({ elements: [mesh] });
      mesh.name = "native";
      undo.finishEdit();
      return true;
    });
    Object.assign(globalThis, { Dialog: { stack: [existing], open: existing }, BarItems: { native } });
    await executeTool("trigger_action", { action: "native", confirmEvent: '{"shiftKey":true}' });
    expect(undo.starts).toBe(1);
    expect(undo.finishes).toBe(1);
    expect(confirms).toBe(0);
  });
  test.each([
    { label: "a missing action", input: { action: "missing" }, message: 'Action "missing" not found.' },
    { label: "a bar item that is not an Action", input: { action: "nonaction" }, message: 'Bar item "nonaction" is not a triggerable Action.' },
    { label: "an unavailable action", input: { action: "unavailable" }, message: 'Action "unavailable" is unavailable in the current mode, format, or selection.' },
    { label: "confirmEvent JSON that is not an object", input: { action: "unavailable", confirmEvent: "null" }, message: "confirmEvent must be a JSON object." },
  ])("trigger_action rejects $label without edits", async ({ input, message }) => {
    Object.assign(globalThis, { BarItems: { nonaction: {}, unavailable: new HostAction(() => false) } });
    await expect(executeTool("trigger_action", input)).rejects.toThrow(message);
    expect(undo.starts).toBe(0);
  });
  test("read-only eval leaves history unchanged and thrown code returns an error", async () => {
    expect(await executeTool("risky_eval", { code: "({answer: 42})" })).toBe('{"answer":42}');
    await expect(executeTool("risky_eval", { code: "throw new Error('bad code')" })).rejects.toThrow("bad code");
    expect(undo.starts).toBe(0);
    expect(undo.finishes).toBe(0);
  });
});
