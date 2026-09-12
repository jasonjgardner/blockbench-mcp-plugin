import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { getAllToolDefinitions } from "@/lib/factories";
import { getMeshInfoParameters, registerMeshInspectionTools, type MeshInspectionResult } from "./mesh-inspection";

type Vector3 = [number, number, number];
type TestFace = {
  vertices: string[];
  texture?: string | false | null;
  uv: Record<string, [number, number]>;
  getSortedVertices?: () => string[];
  getNormal?: (normalize: boolean) => Vector3;
};
type TestMesh = {
  uuid: string;
  name: string;
  origin: Vector3;
  rotation: Vector3;
  parent: "root" | { uuid: string; name: string; children?: TestMesh[] };
  vertices: Record<string, Vector3>;
  faces: Record<string, TestFace>;
};
type Selection = { vertices: string[]; faces: string[]; edges: unknown[] };

let meshes: TestMesh[];
let selected: TestMesh[];
let project: { textures: Array<{ uuid: string; name: string }>; mesh_selection: Record<string, Selection> };
const forbiddenMutation = mock(() => { throw new Error("Inspection attempted a host mutation"); });
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
  ["Project", "Mesh", "Undo", "Canvas", "Texture"].forEach((name) => originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)));
  registerMeshInspectionTools();
});

beforeEach(() => {
  meshes = [];
  selected = [];
  project = { textures: [{ uuid: "texture-1", name: "White" }], mesh_selection: {} };
  forbiddenMutation.mockClear();
  Object.assign(globalThis, {
    Project: project,
    Mesh: { all: meshes, selected },
    Undo: { initEdit: forbiddenMutation, finishEdit: forbiddenMutation },
    Canvas: { updateView: forbiddenMutation, updateAll: forbiddenMutation },
    Texture: { getDefault: forbiddenMutation },
  });
});

afterAll(() => {
  originalGlobals.forEach((descriptor, name) => {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
      return;
    }
    Reflect.deleteProperty(globalThis, name);
  });
});

function addMesh(): TestMesh {
  const mesh: TestMesh = {
    uuid: "mesh-1", name: "Mark", origin: [3, 4, 5], rotation: [0, 90, 0], parent: "root",
    // Insertion and numeric enumeration differ; pagination must be deterministic
    // and preserve the actual runtime key rather than reconstructing an index.
    vertices: { "20": [0, 2, 0], "3": [2, 0, 0], "100": [0, 0, 0], "2": [4, 5, -1] },
    faces: {
      "9": { vertices: ["100", "3", "20"], texture: "texture-1", uv: { "100": [0, 0], "3": [16, 0], "20": [0, 16] } },
      "11": { vertices: ["20", "3", "100"], texture: false, uv: {} },
    },
  };
  meshes.push(mesh);
  return mesh;
}

async function inspect(args: Record<string, unknown> = {}): Promise<MeshInspectionResult> {
  const result = await getAllToolDefinitions().get_mesh_info.execute(getMeshInfoParameters.parse(args));
  if (typeof result === "string" || !result.structuredContent) throw new Error("Expected structured mesh info");
  const first = result.content[0];
  if (first.type !== "text") throw new Error("Expected JSON text alongside structured output");
  expect(JSON.parse(first.text)).toEqual(result.structuredContent);
  return result.structuredContent as MeshInspectionResult;
}

describe("mesh inspection", () => {
  test("paginates independent lexicographic key lists and keeps bounds over all vertices", async () => {
    addMesh();
    const first = await inspect({ mesh_id: "mesh-1", limit: 2, face_offset: 1 });
    expect(first.vertices).toMatchObject({ total: 4, offset: 0, limit: 2, next_offset: 2, truncated: true });
    expect(first.vertices?.items.map((item) => item.key)).toEqual(["100", "2"]);
    expect(first.vertices?.items[1].position).toEqual([4, 5, -1]);
    expect(first.faces).toMatchObject({ total: 2, offset: 1, limit: 2, next_offset: null, truncated: false });
    expect(first.faces?.items.map((item) => item.key)).toEqual(["9"]);
    expect(first.bounds.local).toEqual({ min: [0, 0, -1], max: [4, 5, 0] });
    const last = await inspect({ mesh_id: "Mark", limit: 2, vertex_offset: first.vertices?.next_offset });
    expect(last.vertices?.items.map((item) => item.key)).toEqual(["20", "3"]);
    expect(last.vertices?.next_offset).toBeNull();
    expect(last.vertices?.truncated).toBe(false);
    const beyond = await inspect({ mesh_id: "Mark", vertex_offset: 999, face_offset: 999 });
    expect(beyond.vertices).toMatchObject({ offset: 999, next_offset: null, truncated: false, items: [] });
    expect(beyond.faces?.items).toEqual([]);
  });

  test("uses host perimeter ordering and local normals without exposing mutable arrays", async () => {
    const mesh = addMesh();
    const perimeter = ["3", "20", "100"];
    const normal: Vector3 = [0, 0, 1];
    const getSortedVertices = mock(() => perimeter);
    const getNormal = mock((normalize: boolean): Vector3 => {
      expect(normalize).toBe(true);
      return normal;
    });
    Object.assign(mesh.faces["9"], { getSortedVertices, getNormal });
    const result = await inspect({ mesh_id: "Mark", include_uv: true });
    const face = result.faces?.items.find((item) => item.key === "9");
    expect(face).toMatchObject({ vertices: perimeter, normal: [0, 0, 1], texture: { reference: "texture-1", status: "resolved", uuid: "texture-1", name: "White" }, uv: { "3": [16, 0] } });
    expect(getSortedVertices).toHaveBeenCalledTimes(1);
    expect(getNormal).toHaveBeenCalledTimes(1);
    if (!face?.uv || !result.vertices) throw new Error("Expected geometry and UVs");
    face.vertices.reverse();
    face.normal[0] = 9;
    face.uv["3"][0] = 99;
    result.vertices.items[0].position[0] = 99;
    result.origin[0] = 99;
    expect(perimeter).toEqual(["3", "20", "100"]);
    expect(normal).toEqual([0, 0, 1]);
    expect(mesh.faces["9"].uv["3"]).toEqual([16, 0]);
    expect(mesh.vertices["100"]).toEqual([0, 0, 0]);
    expect(mesh.origin).toEqual([3, 4, 5]);
  });

  test("returns normalized fallback normals, zero for edges, and explicit texture reference states", async () => {
    const mesh = addMesh();
    mesh.faces["missing"] = { vertices: ["100", "3", "20"], texture: "deleted-texture", uv: {} };
    mesh.faces["disabled"] = { vertices: ["100", "3", "20"], texture: null, uv: {} };
    mesh.faces["unset"] = { vertices: ["100", "3"], uv: {} };
    const result = await inspect({ mesh_id: "Mark" });
    const faces = Object.fromEntries(result.faces?.items.map((face) => [face.key, face]) ?? []);
    expect(faces["9"].normal).toEqual([0, 0, 1]);
    expect(faces["11"].normal).toEqual([0, 0, -1]);
    expect(faces.unset.normal).toEqual([0, 0, 0]);
    expect(faces.missing.texture).toEqual({ reference: "deleted-texture", status: "missing" });
    expect(faces.disabled.texture).toEqual({ reference: null, status: "disabled" });
    expect(faces.unset.texture).toEqual({ reference: null, status: "unset" });
    expect(faces["11"].texture).toEqual({ reference: false, status: "unassigned" });
    expect(faces["9"].uv).toBeUndefined();
  });

  test("reports actual component selection while keeping state, undo, and scene unchanged", async () => {
    const mesh = addMesh();
    selected.push(mesh);
    Object.assign(mesh, { getSelectedVertices: forbiddenMutation, getSelectedFaces: forbiddenMutation, getSelectedEdges: forbiddenMutation, select: forbiddenMutation });
    project.mesh_selection[mesh.uuid] = { vertices: ["3", "3", "missing"], faces: ["9", "9", "missing"], edges: [["100", "3"], ["3", "100"], ["missing", "3"], ["3", "3"]] };
    const before = JSON.stringify({ project, mesh, selected });
    Object.freeze(project.mesh_selection);
    const result = await inspect();
    expect(result.uuid).toBe(mesh.uuid);
    expect(result.selection).toEqual({ object: true, vertices: 1, faces: 1, edges: 1 });
    expect(result.vertices?.items.filter((vertex) => vertex.selected).map((vertex) => vertex.key)).toEqual(["3"]);
    expect(result.faces?.items.filter((face) => face.selected).map((face) => face.key)).toEqual(["9"]);
    expect(JSON.stringify({ project, mesh, selected })).toBe(before);
    expect(forbiddenMutation).not.toHaveBeenCalled();
  });

  test("does not create absent selection entries and produces compact summaries with circular parents", async () => {
    const mesh = addMesh();
    mesh.parent = { uuid: "group-1", name: "Symbol", children: [mesh] };
    Object.freeze(project.mesh_selection);
    const info = await inspect({ mesh_id: "Mark", include_vertices: false, include_faces: false, include_uv: true });
    expect(info.parent).toEqual({ uuid: "group-1", name: "Symbol" });
    expect(info.origin).toEqual([3, 4, 5]);
    expect(info.rotation).toEqual([0, 90, 0]);
    expect(info.totals).toEqual({ vertices: 4, faces: 2 });
    expect(info.selection).toEqual({ object: false, vertices: 0, faces: 0, edges: 0 });
    expect(info.vertices).toBeUndefined();
    expect(info.faces).toBeUndefined();
    expect(project.mesh_selection).toEqual({});
  });

  test("describes empty meshes and rejects missing or unselected mesh requests", async () => {
    const mesh = addMesh();
    mesh.vertices = {};
    mesh.faces = {};
    const info = await inspect({ mesh_id: "Mark" });
    expect(info.bounds.local).toBeNull();
    expect(info.parent).toBeNull();
    expect(info.totals).toEqual({ vertices: 0, faces: 0 });
    expect(info.vertices).toMatchObject({ total: 0, next_offset: null, truncated: false, items: [] });
    expect(info.faces?.items).toEqual([]);
    await expect(inspect({ mesh_id: "missing" })).rejects.toThrow('Mesh "missing" not found');
    await expect(inspect()).rejects.toThrow("No mesh selected");
    Object.assign(globalThis, { Project: undefined });
    await expect(inspect({ mesh_id: "Mark" })).rejects.toThrow("No project is open");
  });

  test("validates page sizes and offsets and exposes default read-only metadata", () => {
    [{ limit: 0 }, { limit: 501 }, { limit: 1.5 }, { vertex_offset: -1 }, { face_offset: 0.5 }, { mesh_id: "" }].forEach((args) => expect(getMeshInfoParameters.safeParse(args).success).toBe(false));
    expect(getMeshInfoParameters.parse({})).toEqual({ include_vertices: true, include_faces: true, include_uv: false, vertex_offset: 0, face_offset: 0, limit: 100 });
    expect(getAllToolDefinitions().get_mesh_info.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  });
});
