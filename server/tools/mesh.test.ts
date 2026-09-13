import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Vector3 } from "three";
import { createCylinderParameters, createSphereParameters, placeMeshParameters, registerMeshTools } from "@/server/tools/mesh";
import { useGlobals } from "@/tests/helpers/globals";
import { evaluateHostCondition } from "@/tests/helpers/condition-host";
import type { ITextureReference, MeshSelectionMap, Vector3Tuple } from "@/tests/helpers/shapes";
import { executeText } from "@/tests/helpers/tool-execution";
import { createUndoHost } from "@/tests/helpers/undo-host";

interface IMeshData {
  name: string;
  vertices: Record<string, Vector3Tuple>;
  origin?: Vector3Tuple;
  rotation?: Vector3Tuple;
}

interface ISnapshot {
  mesh: TestMesh;
  vertices: Record<string, Vector3Tuple>;
  faces: Record<string, TestFace>;
}

interface IEditAspects {
  elements: TestMesh[];
}

interface ITestParent {
  uuid: string;
  name: string;
}

interface ITestProject {
  textures: ITextureReference[];
  mesh_selection: MeshSelectionMap;
}

/** A creation tool name paired with the raw arguments it is called with. */
type CreationCase = [name: string, args: Record<string, unknown>];

let project: ITestProject;
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
  readonly origin: Vector3Tuple;
  readonly rotation: Vector3Tuple;
  vertices: Record<string, Vector3Tuple> = {};
  faces: Record<string, TestFace> = {};
  parent: "root" | ITestParent = "root";
  texture: unknown;
  readonly preview_controller = { updateGeometry() {} };
  constructor(data: IMeshData) {
    this.name = data.name;
    this.origin = data.origin ?? [0, 0, 0];
    this.rotation = data.rotation ?? [0, 0, 0];
  }
  addVertices(...vertices: Vector3Tuple[]): string[] {
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

function snapshot(elements: TestMesh[]): ISnapshot[] {
  return elements.map((mesh) => ({ mesh, vertices: structuredClone(mesh.vertices), faces: { ...mesh.faces } }));
}

function loadSnapshot(target: ISnapshot[], reference: ISnapshot[]): void {
  const removed = new Set(reference.filter((entry) => !target.some((other) => other.mesh.uuid === entry.mesh.uuid)).map((entry) => entry.mesh.uuid));
  TestMesh.all = TestMesh.all.filter((mesh) => !removed.has(mesh.uuid));
  target.forEach((entry) => {
    entry.mesh.vertices = structuredClone(entry.vertices);
    entry.mesh.faces = { ...entry.faces };
    if (!TestMesh.all.includes(entry.mesh)) TestMesh.all.push(entry.mesh);
  });
}

const undoHost = createUndoHost({
  snapshot: (aspects: IEditAspects) => snapshot(aspects.elements),
  restore: loadSnapshot,
});

beforeAll(() => {
  registerMeshTools();
});

beforeEach(() => {
  project = { textures: [], mesh_selection: {} };
  TestMesh.all = [];
  TestMesh.selected = [];
  nextId = 0;
  initializationFailure = false;
  undoHost.reset();
});

// Registered after the reset above so the factory installs this test's fresh project.
useGlobals(() => ({
  Condition: evaluateHostCondition,
  Project: project,
  Format: { id: "free", meshes: true },
  Mesh: TestMesh,
  MeshFace: TestFace,
  Texture: { getDefault: () => project.textures[0] },
  Group: { all: [{ uuid: "group-1", name: "mark" }] },
  Undo: undoHost,
  Canvas: { updateAll() {}, updateView() {} },
  BarItems: { selection_mode: { set() {} } },
}));

const triangle = { name: "triangle", vertices: [[0, 0, 0], [2, 0, 0], [0, 2, 0]], faces: [[0, 1, 2]] };

const creationCases: CreationCase[] = [
  ["place_mesh", { elements: [triangle] }],
  ["create_sphere", { elements: [{ name: "sphere", position: [0, 0, 0] }] }],
  ["create_cylinder", { elements: [{ name: "cylinder", position: [0, 0, 0] }] }],
];

const texturedCreationCases: CreationCase[] = [
  ["place_mesh", { elements: [{ ...triangle, faces: [[0, 1, 2], [2, 1, 0]] }], texture: "Porcelain" }],
  ["create_sphere", { elements: [{ name: "sphere", position: [0, 0, 0] }], texture: "Porcelain" }],
  ["create_cylinder", { elements: [{ name: "cylinder", position: [0, 0, 0] }], texture: "Porcelain" }],
];

describe("mesh creation", () => {
  test("places indexed faces, applies transforms and scale, and returns stable index-to-key mappings", async () => {
    const response: unknown = JSON.parse(await executeText("place_mesh", {
      elements: [{
        ...triangle,
        vertices: [...triangle.vertices, [2, 2, 0]],
        position: [4, 5, 6],
        rotation: [0, 0, 90],
        scale: [2, 3, 4],
        faces: [[0, 1, 3, 2], [2, 1, 0]],
      }],
      group: "mark",
    }));
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
    await executeText("place_mesh", { elements: [{ name: "points", vertices: [[1, 2, 3]] }] });
    expect(TestMesh.all).toHaveLength(1);
    expect(Object.keys(TestMesh.all[0].faces)).toHaveLength(0);
  });

  test.each([
    { label: "a two-vertex face", face: [0, 1] },
    { label: "a five-vertex face", face: [0, 1, 2, 3, 4] },
    { label: "a negative vertex index", face: [0, -1, 2] },
    { label: "a fractional vertex index", face: [0, 1.5, 2] },
  ])("place_mesh schema rejects $label", ({ face }) => {
    expect(placeMeshParameters.safeParse({ elements: [{ ...triangle, faces: [face] }] }).success).toBe(false);
  });

  test("primitive schemas reject fractional side counts", () => {
    const primitive = { name: "fractional", position: [0, 0, 0], sides: 3.5 };
    expect(createCylinderParameters.safeParse({ elements: [primitive] }).success).toBe(false);
    expect(createSphereParameters.safeParse({ elements: [primitive] }).success).toBe(false);
  });

  test("rejects invalid references across an entire batch before starting an edit", async () => {
    await expect(executeText("place_mesh", { elements: [triangle, { ...triangle, name: "invalid", faces: [[0, 1, 7]] }] })).rejects.toThrow("existing vertex indices");
    await expect(executeText("place_mesh", { elements: [{ ...triangle, faces: [[0, 1, 1]] }] })).rejects.toThrow("distinct");
    expect(undoHost.starts).toBe(0);
    expect(TestMesh.all).toHaveLength(0);
  });

  test("rejects invalid texture, group and format before creating an undo transaction", async () => {
    await expect(executeText("place_mesh", { elements: [triangle], texture: "missing" })).rejects.toThrow('Texture "missing" not found');
    await expect(executeText("place_mesh", { elements: [triangle], group: "missing" })).rejects.toThrow('Group "missing" not found');
    Object.assign(globalThis, { Format: { id: "java_block", meshes: false } });
    await expect(executeText("place_mesh", { elements: [triangle] })).rejects.toThrow('Tool "place_mesh" is unavailable');
    expect(undoHost.starts).toBe(0);
  });

  test.each(creationCases)("%s snapshots newly created geometry for undo and redo", async (name, args) => {
    await executeText(name, args);
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
    await expect(executeText("place_mesh", { elements: [triangle] })).rejects.toThrow("Preview initialization failed");
    expect(TestMesh.all).toHaveLength(0);
    expect(undoHost.pending).toBeUndefined();
    expect(undoHost.history).toHaveLength(0);
  });

  test.each(texturedCreationCases)("%s textures every new face without selection and retains materials through undo/redo", async (name, args) => {
    project.textures = [{ name: "Porcelain", uuid: "porcelain-texture" }];
    await executeText(name, args);
    const materials = Object.values(TestMesh.all[0].faces).map((face) => face.texture);
    expect(materials.length).toBeGreaterThan(0);
    expect(materials.every((texture) => texture === "porcelain-texture")).toBe(true);
    undoHost.undo();
    expect(TestMesh.all).toHaveLength(0);
    undoHost.redo();
    expect(Object.values(TestMesh.all[0].faces).map((face) => face.texture)).toEqual(materials);
  });

  test("cylinder side and cap normals face outward", async () => {
    const sides = 8;
    await executeText("create_cylinder", { elements: [{ name: "cylinder", position: [0, 0, 0], diameter: 8, height: 12, sides }] });
    const mesh = TestMesh.all[0];
    // Each segment adds one side quad plus one top and one bottom cap triangle.
    expect(Object.keys(mesh.faces)).toHaveLength(sides * 3);
    Object.values(mesh.faces).forEach((face) => {
      const vertices = face.vertices.map((key) => new Vector3(...mesh.vertices[key]));
      const [a, b, c] = vertices;
      const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
      const center = vertices.reduce((sum, vertex) => sum.add(vertex), new Vector3()).divideScalar(vertices.length);
      expect(normal.dot(center)).toBeGreaterThan(0);
    });
  });

  test("uncapped cylinders have no unused cap-center vertices", async () => {
    const sides = 8;
    await executeText("create_cylinder", { elements: [{ name: "tube", position: [0, 0, 0], sides, capped: false }] });
    const mesh = TestMesh.all[0];
    // Only the top and bottom rings remain, joined by one side quad per segment.
    expect(Object.keys(mesh.vertices)).toHaveLength(sides * 2);
    expect(Object.keys(mesh.faces)).toHaveLength(sides);
  });

  test("persists a new mesh vertex selection for later operations", async () => {
    await executeText("place_mesh", { elements: [triangle] });
    const mesh = TestMesh.all[0];
    await executeText("select_mesh_elements", { mesh_id: mesh.uuid, mode: "vertex", elements: ["9999", "9998"] });
    expect(mesh.getSelectedVertices()).toEqual(["9999", "9998"]);
    expect(project.mesh_selection[mesh.uuid].vertices).toEqual(["9999", "9998"]);
    await executeText("move_mesh_vertices", { mesh_id: mesh.uuid, offset: [0, 1, 0] });
    expect(mesh.vertices["9999"]).toEqual([0, 1, 0]);
    expect(mesh.vertices["9998"]).toEqual([2, 1, 0]);
    expect(mesh.vertices["9997"]).toEqual([0, 2, 0]);
  });

  test("preserves component selections when adding after the object-selection lifecycle", async () => {
    await executeText("place_mesh", { elements: [triangle] });
    const mesh = TestMesh.all[0];
    await executeText("select_mesh_elements", { mesh_id: mesh.uuid, mode: "vertex", elements: ["9999"] });
    await executeText("select_mesh_elements", { mesh_id: mesh.uuid, mode: "vertex", action: "add", elements: ["9998"] });
    expect(mesh.getSelectedVertices()).toEqual(["9999", "9998"]);
  });
});
