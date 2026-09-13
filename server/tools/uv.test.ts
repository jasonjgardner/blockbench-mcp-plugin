import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
import { createUndoHost } from "@/tests/helpers/undo-host";

type UV = [number, number];
type Vector = [number, number, number];
type UvState = Record<string, Record<string, UV>>;

/** Only the native texture properties needed to distinguish UV size from bitmap size. */
interface ITestTexture {
  width: number;
  height: number;
  getUVWidth(): number;
  getUVHeight(): number;
}

class TestFace {
  readonly vertices = ["a", "b", "c"];
  uv: Record<string, UV> = { a: [1, 2], b: [3, 4], c: [5, 6] };
  constructor(public texture?: ITestTexture) {}
  getSortedVertices(): string[] { return [...this.vertices]; }
  getTexture(): ITestTexture | undefined { return this.texture; }
}

class TestMesh {
  readonly uuid = "mesh-uv";
  readonly name = "Multi material mesh";
  readonly vertices: Record<string, Vector> = { a: [1, 0, 0], b: [0, 8, 1], c: [0, -8, 1] };
  readonly faces: Record<string, TestFace> = {
    first: new TestFace(makeTexture(64, 32)),
    second: new TestFace(makeTexture(128, 96)),
    untouched: new TestFace(makeTexture(256, 256)),
  };
  getSelectedFaces(): string[] { return ["first", "second"]; }
}

/** Deliberately keeps bitmap resolution different from logical UV size. */
function makeTexture(width: number, height: number): ITestTexture {
  return { width: 1024, height: 1024, getUVWidth: () => width, getUVHeight: () => height };
}

let fixture: IToolFixture;
let mesh: TestMesh;
let format: { per_texture_uv_size: boolean };
let project: { texture_width: number; texture_height: number };
let refreshFailure: boolean;

function snapshot(): UvState {
  return structuredClone(Object.fromEntries(Object.entries(mesh.faces).map(([key, face]) => [key, face.uv])));
}

const undo = createUndoHost({
  snapshot: (_aspects: { elements: TestMesh[] }) => snapshot(),
  restore: (state: UvState) => {
    Object.entries(state).forEach(([key, uv]) => { mesh.faces[key].uv = structuredClone(uv); });
  },
});

beforeAll(async () => {
  fixture = await loadToolDefinitions({ entries: ["server/tools/uv.ts"], register: ["registerUVTools"] });
});

beforeEach(() => {
  mesh = new TestMesh();
  format = { per_texture_uv_size: true };
  project = { texture_width: 16, texture_height: 16 };
  refreshFailure = false;
  undo.reset();
});

useGlobals(() => ({
  Project: project,
  Format: format,
  Mesh: { all: [mesh], selected: [] },
  Undo: undo,
  Canvas: { updateView() { if (refreshFailure) throw new Error("Preview failed"); } },
  UVEditor: { loadData() {} },
}));

const modes: ("cylinder" | "sphere")[] = ["cylinder", "sphere"];

describe("automatic UV logical texture dimensions", () => {
  test.each(modes)("%s respects different face textures and preserves unrelated faces through undo/redo", async mode => {
    const before = snapshot();
    const vertices = structuredClone(mesh.vertices);
    await fixture.call("auto_uv_mesh", { mesh_id: mesh.uuid, faces: ["first", "second"], mode });
    const after = snapshot();

    // The point on +X is three quarters around U and halfway along V in both modes.
    expect(mesh.faces.first.uv.a).toEqual([48, 16]);
    expect(mesh.faces.second.uv.a).toEqual([96, 48]);
    expect(mesh.faces.first.uv.a).not.toBe(mesh.faces.second.uv.a);
    expect(after.untouched).toEqual(before.untouched);
    expect(mesh.vertices).toEqual(vertices);
    expect(undo.starts).toBe(1);
    expect(undo.finishes).toBe(1);
    undo.undo();
    expect(snapshot()).toEqual(before);
    undo.redo();
    expect(snapshot()).toEqual(after);
  });

  test.each(modes)("%s falls back to project UV size for an untextured face", async mode => {
    mesh.faces.first.texture = undefined;
    project.texture_width = 40;
    project.texture_height = 20;
    await fixture.call("auto_uv_mesh", { mesh_id: mesh.uuid, faces: ["first"], mode });
    expect(mesh.faces.first.uv.a).toEqual([30, 10]);
  });

  test.each(modes)("%s uses project dimensions when the format shares a single UV size", async mode => {
    format.per_texture_uv_size = false;
    project.texture_width = 32;
    project.texture_height = 24;
    await fixture.call("auto_uv_mesh", { mesh_id: mesh.uuid, faces: ["first", "second"], mode });
    expect(mesh.faces.first.uv.a).toEqual([24, 12]);
    expect(mesh.faces.second.uv.a).toEqual([24, 12]);
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid texture UV dimension %s before opening undo or mutating earlier faces", async dimension => {
    mesh.faces.second.texture = makeTexture(64, dimension);
    const before = snapshot();
    await expect(fixture.call("auto_uv_mesh", {
      mesh_id: mesh.uuid, faces: ["first", "second"], mode: "cylinder",
    })).rejects.toThrow("finite positive logical UV dimensions");
    expect(snapshot()).toEqual(before);
    expect(undo.starts).toBe(0);
  });

  test("rejects invalid project UV dimensions before mapping untextured faces", async () => {
    mesh.faces.second.texture = undefined;
    project.texture_width = 0;
    const before = snapshot();
    await expect(fixture.call("auto_uv_mesh", {
      mesh_id: mesh.uuid, faces: ["first", "second"], mode: "sphere",
    })).rejects.toThrow("finite positive logical UV dimensions");
    expect(snapshot()).toEqual(before);
    expect(undo.starts).toBe(0);
  });

  test("reverts all mapped faces when the preview refresh fails", async () => {
    refreshFailure = true;
    const before = snapshot();
    await expect(fixture.call("auto_uv_mesh", {
      mesh_id: mesh.uuid, faces: ["first", "second"], mode: "cylinder",
    })).rejects.toThrow("Preview failed");
    expect(snapshot()).toEqual(before);
    expect(undo.history).toHaveLength(0);
    expect(undo.cancels).toBe(1);
  });
});
