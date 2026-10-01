import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { isRecord } from "@/tests/helpers/assertions";
import { useGlobals } from "@/tests/helpers/globals";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";

/** Options accepted by the host bone constructor, as `new ArmatureBone({...})` receives them. */
interface IBoneOptions {
  name?: string;
  origin?: number[];
  rotation?: number[];
  length?: number;
  width?: number;
  connected?: boolean;
  color?: number;
}

type BoneParent = HostArmature | HostBone;

let tools: IToolFixture;
let nextId = 0;
let editsStarted = 0;
let editsFinished = 0;

/** UUIDs share a prefix on purpose: prefix matching used to resolve "" or "shared-" to the first node. */
const uuid = (): string => `shared-${String(++nextId).padStart(4, "0")}`;

class HostArmature {
  static all: HostArmature[] = [];
  readonly type = "armature";
  uuid = uuid();
  visibility = true;
  locked = false;
  export = true;
  isOpen = true;
  origin = [0, 0, 0];
  children: HostBone[] = [];
  constructor(public name: string, id?: string) {
    if (id) this.uuid = id;
    HostArmature.all.push(this);
  }
  getAllBones(): HostBone[] {
    const collect = (bones: HostBone[]): HostBone[] => bones.flatMap((bone) => [bone, ...collect(bone.children)]);
    return collect(this.children);
  }
}

class HostBone {
  static all: HostBone[] = [];
  readonly type = "armature_bone";
  uuid = uuid();
  name = "bone";
  origin = [0, 0, 0];
  rotation = [0, 0, 0];
  length = 8;
  width = 2;
  connected = true;
  color = 0;
  visibility = true;
  locked = false;
  export = true;
  isOpen = false;
  children: HostBone[] = [];
  parent: BoneParent | undefined;
  vertex_weights: Record<string, number> = {};
  constructor(options: IBoneOptions = {}) {
    Object.assign(this, options);
  }
  addTo(parent: BoneParent): this {
    this.parent = parent;
    parent.children.push(this);
    return this;
  }
  init(): this {
    HostBone.all.push(this);
    return this;
  }
  createUniqueName(): void {}
  getArmature(): HostArmature | undefined {
    let parent = this.parent;
    while (parent instanceof HostBone) parent = parent.parent;
    return parent;
  }
  getVertexWeight(mesh: HostMesh, vkey: string): number {
    return this.vertex_weights[`${mesh.uuid.slice(0, 6)}:${vkey}`] ?? 0;
  }
}

class HostMesh {
  static all: HostMesh[] = [];
  static selected: HostMesh[] = [];
  uuid = uuid();
  vertices: Record<string, number[]> = { a: [0, 0, 0] };
  constructor(public name: string, readonly armature: HostArmature) {
    HostMesh.all.push(this);
  }
  getArmature(): HostArmature {
    return this.armature;
  }
}

/** Adds an initialized bone below `parent`. */
function bone(name: string, parent: BoneParent): HostBone {
  return new HostBone({ name }).addTo(parent).init();
}

/** Parses a JSON tool answer. */
async function callJson(name: string, input: unknown): Promise<Record<string, unknown>> {
  const result = await tools.call(name, input);
  if (typeof result !== "string") throw new TypeError(`${name} returned ${typeof result}, not JSON text.`);
  const parsed: unknown = JSON.parse(result);
  if (!isRecord(parsed)) throw new TypeError(`${name} returned JSON that is not an object.`);
  return parsed;
}

beforeAll(async () => {
  tools = await loadToolDefinitions({ entries: ["server/tools/armature.ts"], register: ["registerArmatureTools"] });
});

beforeEach(() => {
  nextId = 0;
  editsStarted = 0;
  editsFinished = 0;
  HostArmature.all = [];
  HostBone.all = [];
  HostMesh.all = [];
  HostMesh.selected = [];
});

useGlobals(() => ({
  Armature: HostArmature,
  ArmatureBone: HostBone,
  Mesh: HostMesh,
  Format: { bone_rig: false },
  Canvas: { updateAll() {} },
  Undo: {
    initEdit() { editsStarted++; },
    finishEdit() { editsFinished++; },
  },
}));

describe("armature lookups match UUIDs exactly", () => {
  test("an empty id or a UUID prefix no longer picks the first armature", async () => {
    new HostArmature("rig");
    await expect(tools.call("get_armature", { id: "" })).rejects.toThrow("Armature not found: ");
    await expect(tools.call("get_armature", { id: "shared-" })).rejects.toThrow("Armature not found: shared-");
  });

  test("resolves an exact UUID first, then a unique name", async () => {
    // Listed first, and named like the other armature's UUID: a first-match lookup would pick it.
    const shadow = new HostArmature("rig-uuid");
    const rig = new HostArmature("rig", "rig-uuid");
    expect((await callJson("get_armature", { id: "rig-uuid", include_bones: false })).uuid).toBe(rig.uuid);
    expect((await callJson("get_armature", { id: "rig", include_bones: false })).uuid).toBe(rig.uuid);
    expect((await callJson("get_armature", { id: shadow.uuid, include_bones: false })).uuid).toBe(shadow.uuid);
  });

  test("a name shared by two armatures is ambiguous and lists their UUIDs", async () => {
    const left = new HostArmature("rig");
    const right = new HostArmature("rig");
    await expect(tools.call("get_armature", { id: "rig" })).rejects.toThrow(`Armature name "rig" matches 2 nodes (${left.uuid}, ${right.uuid})`);
  });

  test("bones and meshes use the same exact matching", async () => {
    const rig = new HostArmature("rig");
    const arm = bone("arm", rig);
    const mesh = new HostMesh("body", rig);
    await expect(tools.call("get_armature_bone", { id: "shared" })).rejects.toThrow("Armature bone not found: shared");
    expect((await callJson("get_armature_bone", { id: arm.uuid })).name).toBe("arm");
    await expect(tools.call("get_vertex_weights", { mesh_id: "shared" })).rejects.toThrow("No mesh found");
    expect(await callJson("get_vertex_weights", { mesh_id: mesh.uuid })).toMatchObject({ mesh: { uuid: mesh.uuid }, armature: { uuid: rig.uuid } });
  });

  test("add_armature_bone resolves its parent across armatures and bones before editing", async () => {
    const rig = new HostArmature("limb");
    const upper = bone("upper", rig);
    bone("limb", upper);
    await expect(tools.call("add_armature_bone", { parent_id: "limb" })).rejects.toThrow('Parent name "limb" matches 2 nodes');
    await expect(tools.call("add_armature_bone", { parent_id: "" })).rejects.toThrow("Parent not found");
    expect(editsStarted).toBe(0);
    const created = await callJson("add_armature_bone", { parent_id: upper.uuid, name: "lower" });
    expect(created.bone).toMatchObject({ name: "lower", parentBone: { uuid: upper.uuid }, armature: { uuid: rig.uuid } });
    expect(editsFinished).toBe(1);
  });
});
