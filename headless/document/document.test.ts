import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { creatureModel } from "../test-fixtures";
import { applyOperations, operationSchema } from "../edit/operations";
import { downgradeToV410, upgradeToV5 } from "./legacy";
import { invertMolang } from "./molang";
import { pngDataUrl, pngSize } from "./png";
import { bbmodelSchema } from "./schema";
import { ModelStore, parseModel, RevisionConflictError, serializeModel } from "./store";

describe("invertMolang (port of Blockbench js/util/molang.ts)", () => {
  test.each([
    [5, -5],
    ["5", "-5"],
    ["-2.5", "2.5"],
    ["0", "0"],
    ["", ""],
    ["math.sin(q.anim_time * 90) * 10", "-math.sin(q.anim_time * 90) * 10"],
    ["-q.anim_time", "q.anim_time"],
    ["a + b", "-a - b"],
    ["a - b", "-a + b"],
    ["v.x = 1; v.x * 2", "v.x = 1; -v.x * 2"],
    ["q.x ? 1 : 2", "-q.x ? -1 : -2"],
  ])("%p → %p", (input, expected) => {
    expect(invertMolang(input)).toBe(expected);
  });

  test("inverting twice restores numeric strings", () => {
    expect(invertMolang(invertMolang("12.5"))).toBe("12.5");
  });
});

describe("legacy layout conversion", () => {
  test("downgrade inlines groups and negates X/Y rotation keys; upgrade restores the 5.0 document", () => {
    const doc = creatureModel(true);
    const legacy = downgradeToV410(doc as unknown as Record<string, unknown>).doc;
    expect(legacy.groups).toBeUndefined();
    expect((legacy.meta as { format_version: string }).format_version).toBe("4.10");
    const firstRoot = (legacy.outliner as { name?: string; children: unknown[] }[])[0];
    expect(firstRoot?.name).toBe("body");
    const legacyKeys = (legacy.animations as { animators: Record<string, { keyframes: { data_points: { x: string }[] }[] }> }[])[0]?.animators;
    const originalKeys = doc.animations?.[0]?.animators;
    const boneId = Object.keys(originalKeys ?? {})[0] ?? "";
    expect(legacyKeys?.[boneId]?.keyframes[0]?.data_points[0]?.x).toBe(String(-Number(originalKeys?.[boneId]?.keyframes[0]?.data_points[0]?.x)));

    const { doc: upgraded, notes } = upgradeToV5(legacy);
    expect(notes[0]).toContain("4.10");
    const reparsed = bbmodelSchema.parse(upgraded);
    expect(reparsed.groups.map((g) => g.name).toSorted()).toEqual(doc.groups.map((g) => g.name).toSorted());
    expect(reparsed.outliner).toEqual(doc.outliner);
    expect(reparsed.animations?.[0]?.animators[boneId]?.keyframes.map((k) => k.data_points[0])).toEqual(
      originalKeys?.[boneId]?.keyframes.map((k) => k.data_points[0]),
    );
  });

  test("the pre-4.5 shade fix-up applies to box-UV projects only and keeps shade (bbmodel.js processCompatibility)", () => {
    const cube = { uuid: "c", name: "c", type: "cube", from: [0, 0, 0], to: [1, 1, 1], shade: false };
    const perFace = upgradeToV5({ meta: { format_version: "4.0", model_format: "java_block", box_uv: false }, elements: [cube], outliner: ["c"] }).doc;
    expect((perFace.elements as Record<string, unknown>[])[0]).toEqual(cube);
    const boxUv = upgradeToV5({ meta: { format_version: "4.0", model_format: "modded_entity", box_uv: true }, elements: [cube], outliner: ["c"] }).doc;
    expect((boxUv.elements as Record<string, unknown>[])[0]).toEqual({ ...cube, mirror_uv: true });
  });

  test("5.0 documents pass through unchanged", () => {
    const doc = creatureModel() as unknown as Record<string, unknown>;
    expect(upgradeToV5(doc)).toEqual({ doc, notes: [] });
  });
});

describe("schema round trip", () => {
  test("unknown fields survive parse and serialize", () => {
    const doc = { ...creatureModel(), plugin_field: { keep: true } };
    const { doc: parsed } = parseModel(serializeModel(bbmodelSchema.parse(doc)));
    expect(parsed.plugin_field).toEqual({ keep: true });
  });

  test("particle keyframes with boolean fields parse and round-trip (keyframe.js bind_to_actor)", () => {
    const doc = creatureModel(true);
    const [animation] = doc.animations ?? [];
    if (!animation) throw new Error("fixture has no animation");
    const effects = { name: "Effects", type: "effect", keyframes: [{ uuid: "p", channel: "particle", time: 0, interpolation: "linear", data_points: [{ effect: "smoke", locator: "", script: "", file: "", bind_to_actor: true }] }] };
    const text = JSON.stringify({ ...doc, animations: [{ ...animation, animators: { ...animation.animators, effects } }] });
    const { doc: parsed } = parseModel(text);
    expect(parsed.animations?.[0]?.animators.effects?.keyframes[0]?.data_points[0]).toMatchObject({ bind_to_actor: true, effect: "smoke" });
  });

  test("elements without a type are read as cubes", () => {
    const { doc } = parseModel(JSON.stringify({ meta: { format_version: "5.0" }, elements: [{ uuid: "a", name: "old", from: [0, 0, 0], to: [1, 1, 1] }], outliner: ["a"] }));
    expect(doc.elements[0]?.type).toBe("cube");
  });
});

describe("PNG helpers", () => {
  const onePixel = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

  test("reads the IHDR size and builds a data URL", () => {
    expect(pngSize(onePixel)).toEqual({ width: 1, height: 1 });
    expect(pngDataUrl(onePixel).startsWith("data:image/png;base64,")).toBe(true);
  });

  test("rejects non-PNG bytes", () => {
    expect(() => pngSize(new Uint8Array(32))).toThrow("not a PNG");
  });
});

describe("ModelStore", () => {
  let root = "";
  let store: ModelStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bb-headless-"));
    store = new ModelStore({ roots: [root] });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("refuses paths outside the workspace and non-.bbmodel files", () => {
    expect(() => store.resolveModelPath("../escape.bbmodel")).toThrow("outside the workspace");
    expect(() => store.resolveModelPath("model.json")).toThrow(".bbmodel");
    expect(store.resolveModelPath("..dotted.bbmodel")).toBe(join(root, "..dotted.bbmodel"));
  });

  test("a directory link inside a root cannot lead outside it", async () => {
    const outside = await mkdtemp(join(tmpdir(), "bb-headless-outside-"));
    try {
      await symlink(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
      expect(() => store.resolveModelPath("link/escape.bbmodel")).toThrow("outside the workspace");
      await expect(store.create("link/escape.bbmodel", creatureModel(), false)).rejects.toThrow("outside the workspace");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("writers in separate processes are serialized by the lock file, so none is lost", async () => {
    await store.create("race.bbmodel", creatureModel(), false);
    const worker = join(root, "worker.ts");
    const storeModule = join(import.meta.dir, "store.ts").replaceAll("\\", "/");
    const opsModule = join(import.meta.dir, "..", "edit", "operations.ts").replaceAll("\\", "/");
    await Bun.write(
      worker,
      [
        `import { ModelStore } from "${storeModule}";`,
        `import { applyOperations, operationSchema } from "${opsModule}";`,
        "const [root, tag] = process.argv.slice(2);",
        "const store = new ModelStore({ roots: [root] });",
        "for (let i = 0; i < 10; i++) {",
        "  const ops = operationSchema.array().parse([{ op: 'add_cube', name: `${tag}_${i}`, from: [0, 0, 0], to: [1, 1, 1] }]);",
        "  await store.update('race.bbmodel', undefined, ({ doc }) => ({ doc: applyOperations(doc, ops).doc, result: null }));",
        "}",
      ].join("\n"),
    );
    const runs = ["a", "b", "c"].map((tag) => Bun.spawn(["bun", "run", worker, root, tag], { stdout: "ignore", stderr: "pipe" }));
    const codes = await Promise.all(runs.map((run) => run.exited));
    expect(codes).toEqual([0, 0, 0]);
    const { doc } = await store.read("race.bbmodel");
    const added = doc.elements.filter((element) => /^[abc]_\d$/.test(element.name));
    expect(added).toHaveLength(30);
    expect(await Bun.file(join(root, "race.bbmodel.lock")).exists()).toBe(false);
  }, 60_000);

  test("create, read and update round-trip with changing revisions", async () => {
    const created = await store.create("a.bbmodel", creatureModel(), false);
    const read = await store.read("a.bbmodel");
    expect(read.revision).toBe(created.revision);
    const ops = operationSchema.array().parse([{ op: "update_node", target: "torso", to: [4, 13, 6] }]);
    const written = await store.update("a.bbmodel", read.revision, ({ doc }) => ({ doc: applyOperations(doc, ops).doc, result: null }));
    expect(written.revision).not.toBe(read.revision);
  });

  test("a stale expected_revision is refused and the file is untouched", async () => {
    const { revision } = await store.create("a.bbmodel", creatureModel(), false);
    await store.update("a.bbmodel", revision, ({ doc }) => ({ doc: { ...doc, name: "first" }, result: null }));
    await expect(store.update("a.bbmodel", revision, ({ doc }) => ({ doc: { ...doc, name: "second" }, result: null }))).rejects.toBeInstanceOf(RevisionConflictError);
    expect((await store.read("a.bbmodel")).doc.name).toBe("first");
  });

  test("concurrent updates in one process are serialized, so none is lost", async () => {
    await store.create("a.bbmodel", creatureModel(), false);
    const names = Array.from({ length: 12 }, (_, i) => `part_${i}`);
    await Promise.all(
      names.map((name) =>
        store.update("a.bbmodel", undefined, ({ doc }) => ({
          doc: applyOperations(doc, operationSchema.array().parse([{ op: "add_cube", name, from: [0, 0, 0], to: [1, 1, 1] }])).doc,
          result: null,
        })),
      ),
    );
    const { doc } = await store.read("a.bbmodel");
    expect(names.every((name) => doc.elements.some((element) => element.name === name))).toBe(true);
  });

  test("a failing edit writes nothing", async () => {
    const { revision } = await store.create("a.bbmodel", creatureModel(), false);
    const ops = operationSchema.array().parse([
      { op: "add_cube", name: "ok", from: [0, 0, 0], to: [1, 1, 1] },
      { op: "remove_node", target: "does-not-exist" },
    ]);
    await expect(store.update("a.bbmodel", undefined, ({ doc }) => ({ doc: applyOperations(doc, ops).doc, result: null }))).rejects.toThrow("Operation 2 (remove_node)");
    expect((await store.read("a.bbmodel")).revision).toBe(revision);
  });

  test("create refuses to overwrite unless asked", async () => {
    await store.create("a.bbmodel", creatureModel(), false);
    await expect(store.create("a.bbmodel", creatureModel(), false)).rejects.toThrow("already exists");
    await store.create("a.bbmodel", creatureModel(), true);
  });
});
