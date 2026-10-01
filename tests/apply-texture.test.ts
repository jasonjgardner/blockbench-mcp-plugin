import { beforeAll, beforeEach, expect, test } from "bun:test";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
import { createUndoHost } from "@/tests/helpers/undo-host";

type FaceKey = "north" | "east" | "south" | "west" | "up" | "down";

/** A face's texture as Blockbench stores it: a texture UUID, `false` for none, or `null` for a disabled face. */
type FaceTexture = string | false | null;

/** Face texture assignments of every cube, keyed by cube name. */
type Snapshot = Record<string, Record<FaceKey, FaceTexture>>;

const FACES: readonly FaceKey[] = ["north", "east", "south", "west", "up", "down"];

let tools: IToolFixture;
let cubes: TestCube[];
let textures: TestTexture[];
let selectedTexture: TestTexture | undefined;

/** Mirrors Blockbench's CubeFace texture fields (`js/outliner/abstract/face.ts`) in a format without a single default texture. */
class TestFace {
  constructor(public texture: FaceTexture = false) {}
  getTexture(): TestTexture | undefined {
    return typeof this.texture === "string" ? textures.find(texture => texture.uuid === this.texture) : undefined;
  }
}
class TestCube {
  static get all(): TestCube[] { return cubes; }
  static get selected(): TestCube[] { return cubes.filter(cube => cube.selected); }
  readonly uuid = crypto.randomUUID();
  readonly type = "cube";
  selected = false;
  readonly faces = Object.fromEntries(FACES.map(face => [face, new TestFace()])) as Record<FaceKey, TestFace>;
  /** Faces picked in the UV editor, which Blockbench's apply-to-selected-faces uses. */
  uvSelection: FaceKey[] = [];
  constructor(readonly name: string, readonly box_uv: boolean) {}
  select(): void { this.selected = true; }
  unselect(): void { this.selected = false; }
}
class TestMesh {
  static all: TestMesh[] = [];
  static selected: TestMesh[] = [];
}
class TestGroup {
  static all: TestGroup[] = [];
  static multi_selected: TestGroup[] = [];
}
/** Texture double with Blockbench's `apply(all)` face rules and the bookkeeping `updateChangesAfterEdit` performs. */
class TestTexture {
  saved = true;
  internal = false;
  constructor(readonly name: string, readonly uuid: string) {}
  get id(): string { return this.name; }
  select(): void { selectedTexture = this; }
  /** Port of `Texture.apply` (`js/texturing/textures.js`): blank mode skips disabled faces and faces that already have a texture. */
  apply(all: boolean | "blank"): void {
    TestCube.selected.forEach(cube => FACES.forEach(key => {
      if (!(all || cube.box_uv || cube.uvSelection.includes(key))) return;
      const face = cube.faces[key];
      if (all !== "blank" || (face.texture !== null && !face.getTexture())) face.texture = this.uuid;
    }));
  }
  updateChangesAfterEdit(): void {
    this.internal = true;
    this.saved = false;
  }
}

function snapshot(): Snapshot {
  return Object.fromEntries(cubes.map(cube => [cube.name, Object.fromEntries(FACES.map(face => [face, cube.faces[face].texture])) as Record<FaceKey, FaceTexture>]));
}
const undo = createUndoHost({
  snapshot: (_aspects: unknown) => snapshot(),
  restore: (saved: Snapshot) => cubes.forEach(cube => FACES.forEach(face => { cube.faces[face].texture = saved[cube.name][face]; })),
});

beforeAll(async () => {
  tools = await loadToolDefinitions({ entries: ["server/tools/texture.ts"], register: ["registerTextureTools"] });
});
beforeEach(() => {
  cubes = [new TestCube("box", true), new TestCube("faces", false)];
  textures = [new TestTexture("skin", "skin-uuid"), new TestTexture("other", "other-uuid")];
  selectedTexture = undefined;
  undo.reset();
});
useGlobals(() => ({
  Canvas: { updateView() {}, updateAll() {} },
  Cube: TestCube,
  Group: TestGroup,
  Mesh: TestMesh,
  Outliner: { get elements() { return cubes; } },
  Project: { get textures() { return textures; } },
  Texture: {
    get all() { return textures; },
    get selected() { return selectedTexture; },
    getDefault: () => textures[0],
  },
  Undo: undo,
  updateSelection() {},
}));

test("applying a texture changes face assignments only and leaves the texture file unmodified", async () => {
  await tools.call("apply_texture", { id: "faces", texture: "skin", applyTo: "all" });
  expect(Object.values(snapshot().faces)).toEqual(FACES.map(() => "skin-uuid"));
  // Marking the texture would make Ctrl+S re-encode and rewrite its PNG.
  expect(textures[0]).toMatchObject({ saved: true, internal: false });
  expect(undo.history).toHaveLength(1);
});

test("the default blank mode fills only faces without a texture and leaves the texture file unmodified", async () => {
  const { faces } = cubes[1];
  faces.up.texture = "other-uuid";
  // null is a disabled face, which Blockbench never fills in blank mode.
  faces.down.texture = null;
  await tools.call("apply_texture", { id: "faces", texture: "skin" });
  expect(snapshot().faces).toEqual({ north: "skin-uuid", east: "skin-uuid", south: "skin-uuid", west: "skin-uuid", up: "other-uuid", down: null });
  expect(textures[0]).toMatchObject({ saved: true, internal: false });
});
