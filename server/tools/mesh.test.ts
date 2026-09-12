import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Vector3 } from "three";
import { getAllToolDefinitions } from "@/lib/factories";
import {
  createCylinderParameters,
  createSphereParameters,
  moveMeshVerticesParameters,
  placeMeshParameters,
  registerMeshTools,
  selectMeshElementsParameters,
} from "./mesh";

type Vector = [number, number, number];
type Selection = { vertices: string[]; edges: string[][]; faces: string[] };
type MeshData = { name: string; vertices: Record<string, Vector>; origin?: Vector; rotation?: Vector };
type Snapshot = { mesh: TestMesh; vertices: Record<string, Vector>; faces: Record<string, TestFace> };
type EditAspects = { elements: TestMesh[] };
type Edit = { before: Snapshot[]; after: Snapshot[] };

let project: { textures: Array<{ uuid: string; name: string }>; mesh_selection: Record<string, Selection> };
let nextId = 0;
let initializationFailure = false;

// Small host doubles exercise tool behavior while retaining Blockbench's local
// vertices, face winding, selection map, and before/after undo snapshot contract.
class TestFace {
  vertices: string[];
  texture: string | false = false;
  constructor(readonly mesh: TestMesh, data: { vertices: string[] }) {
    this.vertices = data.vertices;
  }
}

class TestMesh {
  static all: TestMesh[] = [];
  static selected: TestMesh[] = [];
  readonly uuid = `mesh-${++nextId}`;
  readonly name: string;
  readonly origin: Vector;
  readonly rotation: Vector;
  vertices: Record<string, Vector> = {};
  faces: Record<string, TestFace> = {};
  parent: "root" | { uuid: string; name: string } = "root";
  texture: unknown;
  readonly preview_controller = { updateGeometry() {} };
  constructor(data: MeshData) {
    this.name = data.name;
    this.origin = data.origin ?? [0, 0, 0];
    this.rotation = data.rotation ?? [0, 0, 0];
  }
  addVertices(...vertices: Vector[]): string[] {
    return vertices.map((vertex) => {
      // Descending numeric keys deliberately enumerate differently from input
      // order, exposing any incorrect Object.keys-based index mapping.
      const key = String(9999 - Object.keys(this.vertices).length);
      this.vertices[key] = vertex;
      return key;
    });
  }
  addFaces(face: TestFace): string[] {
    const key = String(99999999 - Object.keys(this.faces).length);
    this.faces[key] = face;
    return [key];
  }
  addTo(parent: TestMesh["parent"]): this {
    this.parent = parent;
    return this;
  }
  init(): this {
    TestMesh.all.push(this);
    if (initializationFailure) throw new Error("Preview initialization failed");
    return this;
  }
  applyTexture(texture: { uuid: string }, faces?: true | string[]): void {
    this.texture = texture;
    const faceKeys = faces === true ? Object.keys(this.faces) : faces ?? project.mesh_selection[this.uuid]?.faces ?? [];
    faceKeys.forEach((key) => {
      this.faces[key].texture = texture.uuid;
    });
  }
  select(): this {
    // Older Blockbench object-selection lifecycles clear mesh component state
    // while deselecting other objects. Components must be installed afterward.
    project.mesh_selection = {};
    TestMesh.selected = [this];
    return this;
  }
  getSelectedVertices(): string[] {
    return project.mesh_selection[this.uuid]?.vertices ?? [];
  }
}

function snapshot(elements: TestMesh[]): Snapshot[] {
  return elements.map((mesh) => ({ mesh, vertices: structuredClone(mesh.vertices), faces: { ...mesh.faces } }));
}

function loadSnapshot(target: Snapshot[], reference: Snapshot[]): void {
  const removed = new Set(reference.filter((entry) => !target.some((other) => other.mesh.uuid === entry.mesh.uuid)).map((entry) => entry.mesh.uuid));
  TestMesh.all = TestMesh.all.filter((mesh) => !removed.has(mesh.uuid));
  target.forEach((entry) => {
    entry.mesh.vertices = structuredClone(entry.vertices);
    entry.mesh.faces = { ...entry.faces };
    if (!TestMesh.all.includes(entry.mesh)) TestMesh.all.push(entry.mesh);
  });
}

const undoHost = {
  pending: undefined as { aspects: EditAspects; before: Snapshot[] } | undefined,
  history: [] as Edit[],
  index: 0,
  starts: 0,
  initEdit(aspects: EditAspects): void {
    this.starts++;
    this.pending = { aspects, before: snapshot(aspects.elements) };
  },
  finishEdit(): void {
    if (!this.pending) throw new Error("No pending edit");
    this.history.push({ before: this.pending.before, after: snapshot(this.pending.aspects.elements) });
    this.pending = undefined;
    this.index = this.history.length;
  },
  cancelEdit(revert: boolean): void {
    if (revert && this.pending) loadSnapshot(this.pending.before, snapshot(this.pending.aspects.elements));
    this.pending = undefined;
  },
  undo(): void {
    const entry = this.history[--this.index];
    loadSnapshot(entry.before, entry.after);
  },
  redo(): void {
    const entry = this.history[this.index++];
    loadSnapshot(entry.after, entry.before);
  },
};

const globals = ["Project", "Format", "Mesh", "MeshFace", "Texture", "Group", "Undo", "Canvas", "BarItems"];
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
  globals.forEach((name) => originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)));
  registerMeshTools();
});

beforeEach(() => {
  project = { textures: [], mesh_selection: {} };
  TestMesh.all = [];
  TestMesh.selected = [];
  nextId = 0;
  initializationFailure = false;
  undoHost.pending = undefined;
  undoHost.history = [];
  undoHost.index = 0;
  undoHost.starts = 0;
  Object.assign(globalThis, {
    Project: project,
    Format: { id: "free", meshes: true },
    Mesh: TestMesh,
    MeshFace: TestFace,
    Texture: { getDefault: () => project.textures[0] },
    Group: { all: [{ uuid: "group-1", name: "mark" }] },
    Undo: undoHost,
    Canvas: { updateAll() {}, updateView() {} },
    BarItems: { selection_mode: { set() {} } },
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

async function execute(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await getAllToolDefinitions()[name].execute(args);
  if (typeof result !== "string") throw new Error("Expected text response");
  return result;
}

const triangle = { name: "triangle", vertices: [[0, 0, 0], [2, 0, 0], [0, 2, 0]], faces: [[0, 1, 2]] };

describe("mesh creation", () => {
  test("places indexed faces, applies transforms and scale, and returns stable index-to-key mappings", async () => {
    const args = placeMeshParameters.parse({
      elements: [{ ...triangle, vertices: [...triangle.vertices, [2, 2, 0]], position: [4, 5, 6], rotation: [0, 0, 90], scale: [2, 3, 4], faces: [[0, 1, 3, 2], [2, 1, 0]] }],
      group: "mark",
    });
    const response: unknown = JSON.parse(await execute("place_mesh", args));
    const mesh = TestMesh.all[0];
    expect(mesh.origin).toEqual([4, 5, 6]);
    expect(mesh.rotation).toEqual([0, 0, 90]);
    expect(mesh.vertices["9998"]).toEqual([4, 0, 0]);
    expect(mesh.vertices["9997"]).toEqual([0, 6, 0]);
    expect(mesh.parent).toEqual({ uuid: "group-1", name: "mark" });
    expect(mesh.faces["99999999"].vertices).toEqual(["9999", "9998", "9996", "9997"]);
    expect(response).toEqual({ meshes: [{ name: "triangle", uuid: mesh.uuid, vertex_keys: ["9999", "9998", "9997", "9996"], face_keys: ["99999999", "99999998"] }] });
    expect(mesh.texture).toBeUndefined();
  });

  test("keeps vertex-only creation backward compatible", async () => {
    await execute("place_mesh", placeMeshParameters.parse({ elements: [{ name: "points", vertices: [[1, 2, 3]] }] }));
    expect(TestMesh.all).toHaveLength(1);
    expect(Object.keys(TestMesh.all[0].faces)).toHaveLength(0);
  });

  test("schemas reject unsupported polygons and fractional geometry indices", () => {
    [[0, 1], [0, 1, 2, 3, 4], [0, -1, 2], [0, 1.5, 2]].forEach((face) => {
      expect(placeMeshParameters.safeParse({ elements: [{ ...triangle, faces: [face] }] }).success).toBe(false);
    });
    const primitive = { name: "fractional", position: [0, 0, 0], sides: 3.5 };
    expect(createCylinderParameters.safeParse({ elements: [primitive] }).success).toBe(false);
    expect(createSphereParameters.safeParse({ elements: [primitive] }).success).toBe(false);
  });

  test("rejects invalid references across an entire batch before starting an edit", async () => {
    const args = placeMeshParameters.parse({ elements: [triangle, { ...triangle, name: "invalid", faces: [[0, 1, 7]] }] });
    await expect(execute("place_mesh", args)).rejects.toThrow("existing vertex indices");
    await expect(execute("place_mesh", placeMeshParameters.parse({ elements: [{ ...triangle, faces: [[0, 1, 1]] }] }))).rejects.toThrow("distinct");
    expect(undoHost.starts).toBe(0);
    expect(TestMesh.all).toHaveLength(0);
  });

  test("rejects invalid texture, group and format before creating an undo transaction", async () => {
    await expect(execute("place_mesh", placeMeshParameters.parse({ elements: [triangle], texture: "missing" }))).rejects.toThrow('Texture "missing" not found');
    await expect(execute("place_mesh", placeMeshParameters.parse({ elements: [triangle], group: "missing" }))).rejects.toThrow('Group "missing" not found');
    Object.assign(globalThis, { Format: { id: "java_block", meshes: false } });
    await expect(execute("place_mesh", placeMeshParameters.parse({ elements: [triangle] }))).rejects.toThrow("does not support meshes");
    expect(undoHost.starts).toBe(0);
  });

  test.each(["place_mesh", "create_sphere", "create_cylinder"])("%s snapshots newly created geometry for undo and redo", async (name) => {
    const parameters = {
      place_mesh: placeMeshParameters.parse({ elements: [triangle] }),
      create_sphere: createSphereParameters.parse({ elements: [{ name: "sphere", position: [0, 0, 0] }] }),
      create_cylinder: createCylinderParameters.parse({ elements: [{ name: "cylinder", position: [0, 0, 0] }] }),
    };
    await execute(name, parameters[name as keyof typeof parameters]);
    const mesh = TestMesh.all[0];
    const geometry = structuredClone(mesh.vertices);
    const faces = Object.keys(mesh.faces);
    expect(undoHost.history[0].before).toHaveLength(0);
    expect(undoHost.history[0].after).toHaveLength(1);
    undoHost.undo();
    expect(TestMesh.all).toHaveLength(0);
    undoHost.redo();
    expect(TestMesh.all[0].uuid).toBe(mesh.uuid);
    expect(TestMesh.all[0].vertices).toEqual(geometry);
    expect(Object.keys(TestMesh.all[0].faces)).toEqual(faces);
  });

  test("rolls back initialized geometry when creation fails", async () => {
    initializationFailure = true;
    await expect(execute("place_mesh", placeMeshParameters.parse({ elements: [triangle] }))).rejects.toThrow("Preview initialization failed");
    expect(TestMesh.all).toHaveLength(0);
    expect(undoHost.pending).toBeUndefined();
    expect(undoHost.history).toHaveLength(0);
  });

  test.each(["place_mesh", "create_sphere", "create_cylinder"])("%s textures every new face without selection and retains materials through undo/redo", async (name) => {
    project.textures = [{ name: "Porcelain", uuid: "porcelain-texture" }];
    const parameters = {
      place_mesh: placeMeshParameters.parse({ elements: [{ ...triangle, faces: [[0, 1, 2], [2, 1, 0]] }], texture: "Porcelain" }),
      create_sphere: createSphereParameters.parse({ elements: [{ name: "sphere", position: [0, 0, 0] }], texture: "Porcelain" }),
      create_cylinder: createCylinderParameters.parse({ elements: [{ name: "cylinder", position: [0, 0, 0] }], texture: "Porcelain" }),
    };
    await execute(name, parameters[name as keyof typeof parameters]);
    const materials = Object.values(TestMesh.all[0].faces).map((face) => face.texture);
    expect(materials.length).toBeGreaterThan(0);
    expect(materials.every((texture) => texture === "porcelain-texture")).toBe(true);
    undoHost.undo();
    expect(TestMesh.all).toHaveLength(0);
    undoHost.redo();
    expect(Object.values(TestMesh.all[0].faces).map((face) => face.texture)).toEqual(materials);
  });

  test("cylinder side and cap normals face outward", async () => {
    await execute("create_cylinder", createCylinderParameters.parse({ elements: [{ name: "cylinder", position: [0, 0, 0], diameter: 8, height: 12, sides: 8 }] }));
    const mesh = TestMesh.all[0];
    expect(Object.keys(mesh.faces)).toHaveLength(24);
    Object.values(mesh.faces).forEach((face) => {
      const vertices = face.vertices.map((key) => new Vector3(...mesh.vertices[key]));
      const [a, b, c] = vertices;
      const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
      const center = vertices.reduce((sum, vertex) => sum.add(vertex), new Vector3()).divideScalar(vertices.length);
      expect(normal.dot(center)).toBeGreaterThan(0);
    });
  });

  test("uncapped cylinders have no unused cap-center vertices", async () => {
    await execute("create_cylinder", createCylinderParameters.parse({ elements: [{ name: "tube", position: [0, 0, 0], sides: 8, capped: false }] }));
    const mesh = TestMesh.all[0];
    expect(Object.keys(mesh.vertices)).toHaveLength(16);
    expect(Object.keys(mesh.faces)).toHaveLength(8);
  });

  test("persists a new mesh vertex selection for later operations", async () => {
    await execute("place_mesh", placeMeshParameters.parse({ elements: [triangle] }));
    const mesh = TestMesh.all[0];
    await execute("select_mesh_elements", selectMeshElementsParameters.parse({ mesh_id: mesh.uuid, mode: "vertex", elements: ["9999", "9998"] }));
    expect(mesh.getSelectedVertices()).toEqual(["9999", "9998"]);
    expect(project.mesh_selection[mesh.uuid].vertices).toEqual(["9999", "9998"]);
    await execute("move_mesh_vertices", moveMeshVerticesParameters.parse({ mesh_id: mesh.uuid, offset: [0, 1, 0] }));
    expect(mesh.vertices["9999"]).toEqual([0, 1, 0]);
    expect(mesh.vertices["9998"]).toEqual([2, 1, 0]);
    expect(mesh.vertices["9997"]).toEqual([0, 2, 0]);
  });

  test("preserves component selections when adding after the object-selection lifecycle", async () => {
    await execute("place_mesh", placeMeshParameters.parse({ elements: [triangle] }));
    const mesh = TestMesh.all[0];
    await execute("select_mesh_elements", selectMeshElementsParameters.parse({ mesh_id: mesh.uuid, mode: "vertex", elements: ["9999"] }));
    await execute("select_mesh_elements", selectMeshElementsParameters.parse({ mesh_id: mesh.uuid, mode: "vertex", action: "add", elements: ["9998"] }));
    expect(mesh.getSelectedVertices()).toEqual(["9999", "9998"]);
  });
});
