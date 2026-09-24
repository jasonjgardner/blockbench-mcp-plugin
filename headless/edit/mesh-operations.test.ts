import { describe, expect, test } from "bun:test";
import { bbmodelSchema, type IBBModel, type IMesh, isMesh } from "../document/schema";
import { emptyModel } from "../tools/edit";
import { assignMeshTexture, MESH_HANDLERS, MESH_OPERATION_SCHEMAS } from "./mesh-operations";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

/** Parses and applies mesh ops in order, like applyOperations will once they are registered. */
function run(doc: IBBModel, ops: unknown[]): { doc: IBBModel; details: string[] } {
  const union = MESH_OPERATION_SCHEMAS.map((schema) => schema as unknown as { safeParse: (v: unknown) => { success: boolean; data?: unknown } });
  return ops.reduce<{ doc: IBBModel; details: string[] }>((state, raw) => {
    const parsed = union.map((schema) => schema.safeParse(raw)).find((result) => result.success);
    if (!parsed) throw new Error(`Invalid op ${JSON.stringify(raw)}`);
    const op = parsed.data as { op: keyof typeof MESH_HANDLERS };
    const handler = MESH_HANDLERS[op.op] as (d: IBBModel, o: unknown) => [IBBModel, { detail?: string }];
    const [next, result] = handler(state.doc, op);
    return { doc: next, details: [...state.details, result.detail ?? ""] };
  }, { doc, details: [] });
}

const base = (): IBBModel => {
  const doc = emptyModel("free", "meshes", false, { width: 32, height: 32 });
  return { ...doc, textures: [{ uuid: crypto.randomUUID(), name: "skin", source: PNG, width: 32, height: 32, uv_width: 32, uv_height: 32 }] };
};

const meshNamed = (doc: IBBModel, name: string): IMesh => {
  const found = doc.elements.find((element) => element.name === name);
  if (!found || !isMesh(found)) throw new Error(`no mesh ${name}`);
  return found;
};

describe("add_mesh", () => {
  test("array vertices get generated keys, index faces resolve, missing UVs get Auto UV", () => {
    const { doc } = run(base(), [{
      op: "add_mesh",
      name: "quad",
      vertices: [[0, 0, 0], [4, 0, 0], [4, 0, 4], [0, 0, 4]],
      faces: [{ vertices: [0, 3, 2, 1] }],
      texture: "skin",
    }]);
    const mesh = meshNamed(doc, "quad");
    expect(Object.keys(mesh.vertices).every((key) => key.length === 4)).toBe(true);
    const [face] = Object.values(mesh.faces);
    expect(face?.texture).toBe(0);
    expect(Object.keys(face?.uv ?? {}).sort()).toEqual([...(face?.vertices ?? [])].sort());
    expect(mesh).toMatchObject({ type: "mesh", origin: [0, 0, 0], rotation: [0, 0, 0], export: true, visibility: true, render_order: "default", allow_mirror_modeling: true });
    expect(() => bbmodelSchema.parse(JSON.parse(JSON.stringify(doc)))).not.toThrow();
  });

  test("keyed vertices keep their keys; explicit UVs are kept", () => {
    const { doc } = run(base(), [{
      op: "add_mesh",
      name: "tri",
      vertices: { a: [0, 0, 0], b: [1, 0, 0], c: [0, 1, 0] },
      faces: [{ vertices: ["a", "b", "c"], uv: [[0, 0], [8, 0], [0, 8]] }],
    }]);
    const [face] = Object.values(meshNamed(doc, "tri").faces);
    expect(face?.uv).toEqual({ a: [0, 0], b: [8, 0], c: [0, 8] });
    expect(face && "texture" in face).toBe(false);
  });

  test.each([
    [{ vertices: ["a", "b", "z"] }, "Unknown vertex"],
    [{ vertices: ["a", "a", "b"] }, "repeats a vertex"],
    [{ vertices: [0, 1, 9] }, "only 3 vertices"],
    [{ vertices: ["a", "b", "c"], uv: [[0, 0]] }, "1 UVs for 3"],
  ])("bad face %j is refused", (face, message) => {
    expect(() => run(base(), [{ op: "add_mesh", name: "bad", vertices: { a: [0, 0, 0], b: [1, 0, 0], c: [0, 1, 0] }, faces: [face] }])).toThrow(message);
  });

  test("n-gons are refused by the schema", () => {
    expect(() => run(base(), [{ op: "add_mesh", name: "ngon", vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 2, 0]], faces: [{ vertices: [0, 1, 2, 3, 4] }] }])).toThrow("Invalid op");
  });
});

describe("add_mesh_primitive", () => {
  test("defaults match the dialog and the parent origin is inherited", () => {
    const withGroup: IBBModel = { ...base(), groups: [{ uuid: "g1", name: "bone", origin: [2, 3, 4], rotation: [0, 0, 0] }], outliner: [{ uuid: "g1", isOpen: true, children: [] }] };
    const { doc, details } = run(withGroup, [{ op: "add_mesh_primitive", shape: "cylinder", parent: "bone", texture: 0 }]);
    const mesh = meshNamed(doc, "cylinder");
    expect(details[0]).toBe("cylinder: 26 vertices, 36 faces");
    expect(mesh.origin).toEqual([2, 3, 4]);
    expect(Object.values(mesh.faces).every((face) => face.texture === 0)).toBe(true);
    expect(doc.outliner).toEqual([{ uuid: "g1", isOpen: true, children: [mesh.uuid] }]);
  });
});

describe("edit_mesh", () => {
  test("actions apply in order and report counts", () => {
    const start = run(base(), [{ op: "add_mesh_primitive", shape: "cuboid", name: "box" }]).doc;
    const mesh = meshNamed(start, "box");
    const top = Object.entries(mesh.faces).find(([, face]) => face.vertices.every((key) => mesh.vertices[key]?.[1] === 8));
    const { doc, details } = run(start, [{
      op: "edit_mesh",
      target: "box",
      actions: [
        { action: "extrude_faces", faces: [top?.[0]], distance: 4 },
        { action: "subdivide", faces: [top?.[0]], cuts: 1 },
        { action: "move_vertices", offset: [0, 1, 0] },
      ],
    }]);
    expect(details[0]).toBe("vertices 8 -> 17, faces 6 -> 13");
    expect(Math.max(...Object.values(meshNamed(doc, "box").vertices).map((v) => v[1]))).toBe(13);
  });

  test("a failing action rejects the whole edit and names the action", () => {
    const start = run(base(), [{ op: "add_mesh_primitive", shape: "plane", name: "p" }]).doc;
    expect(() => run(start, [{ op: "edit_mesh", target: "p", actions: [{ action: "move_vertices", offset: [1, 0, 0] }, { action: "delete_faces", faces: ["nope"] }] }])).toThrow("Action 2 (delete_faces) failed");
  });

  test("non-mesh targets are refused", () => {
    const withGroup: IBBModel = { ...base(), elements: [{ uuid: "c1", name: "cube", type: "cube", from: [0, 0, 0], to: [1, 1, 1], origin: [0, 0, 0], faces: {} }], outliner: ["c1"] };
    expect(() => run(withGroup, [{ op: "edit_mesh", target: "cube", actions: [{ action: "flip_faces" }] }])).toThrow("not a mesh");
  });
});

describe("map_mesh_uv and texture assignment", () => {
  test("explicit, projection and auto modes", () => {
    const start = run(base(), [{ op: "add_mesh", name: "q", vertices: { a: [0, 0, 0], b: [2, 0, 0], c: [2, 0, 2], d: [0, 0, 2] }, faces: [{ vertices: ["a", "d", "c", "b"] }] }]).doc;
    const faceKey = Object.keys(meshNamed(start, "q").faces)[0] as string;
    const explicit = run(start, [{ op: "map_mesh_uv", target: "q", mode: "explicit", uv: { [faceKey]: { a: [0, 0], b: [4, 0], c: [4, 4], d: [0, 4] } } }]).doc;
    expect(meshNamed(explicit, "q").faces[faceKey]?.uv).toEqual({ a: [0, 0], d: [0, 4], c: [4, 4], b: [4, 0] });
    const projected = run(start, [{ op: "map_mesh_uv", target: "q", mode: "project_y", scale: 2, texture: "skin" }]).doc;
    const face = meshNamed(projected, "q").faces[faceKey];
    expect(face?.uv).toEqual({ a: [0, 0], d: [0, 4], c: [4, 4], b: [4, 0] });
    expect(face?.texture).toBe(0);
    expect(() => run(start, [{ op: "map_mesh_uv", target: "q", mode: "auto", scale: 2 }])).toThrow("scale applies");
  });

  test("assignMeshTexture sets all or listed faces and rejects unknown keys", () => {
    const start = run(base(), [{ op: "add_mesh_primitive", shape: "pyramid", name: "py" }]).doc;
    const mesh = meshNamed(start, "py");
    const [first] = Object.keys(mesh.faces);
    const some = assignMeshTexture(mesh, 0, [first as string]);
    expect(Object.values(some.faces).filter((face) => face.texture === 0).length).toBe(1);
    expect(Object.values(assignMeshTexture(mesh, null).faces).every((face) => face.texture === null)).toBe(true);
    expect(() => assignMeshTexture(mesh, 0, ["missing"])).toThrow("no face");
  });
});
