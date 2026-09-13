import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAllToolDefinitions } from "@/lib/factories";
import { SAMPLE_TOOL_NAME } from "./fixtures/sample-tools";
import { callTool, loadToolDefinitions, type IToolFixtureOptions } from "./tool-fixture";

const SAMPLE_ENTRY = "tests/helpers/fixtures/sample-tools.ts";
const BUNDLE_TIMEOUT_MS = 30_000;
let tempRoot: string;

function loadSample(overrides: Partial<IToolFixtureOptions> = {}) {
  return loadToolDefinitions({ entries: [SAMPLE_ENTRY], register: ["registerSampleTools"], tempRoot, ...overrides });
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "helpers-tool-fixture-test-"));
});

afterEach(async () => {
  // Every load, successful or not, must remove its private temp directory.
  expect(await readdir(tempRoot)).toEqual([]);
});

afterAll(async () => {
  await rm(tempRoot, { force: true, recursive: true });
});

describe("capture registry", () => {
  test("registers bundled tools privately and parses input before execute", async () => {
    const fixture = await loadSample();
    expect([...fixture.definitions.keys()]).toEqual([SAMPLE_TOOL_NAME]);
    expect(await fixture.call(SAMPLE_TOOL_NAME, {})).toBe("echo:hello");
    expect(await callTool(fixture.definitions, SAMPLE_TOOL_NAME, { text: "mark" })).toBe("echo:mark");
    await expect(fixture.call(SAMPLE_TOOL_NAME, { text: "" })).rejects.toThrow("at least 1 character");
    expect(Object.hasOwn(getAllToolDefinitions(), SAMPLE_TOOL_NAME)).toBe(false);
  }, BUNDLE_TIMEOUT_MS);

  test("each load gets an independent module graph", async () => {
    const [first, second] = await Promise.all([loadSample(), loadSample()]);
    expect(first.get(SAMPLE_TOOL_NAME)).not.toBe(second.get(SAMPLE_TOOL_NAME));
  }, BUNDLE_TIMEOUT_MS);

  test("missing tools report the captured names", async () => {
    const fixture = await loadSample();
    expect(() => fixture.get("absent")).toThrow(`Missing tool "absent". Captured tools: ${SAMPLE_TOOL_NAME}.`);
    await expect(fixture.call("absent", {})).rejects.toThrow("Missing tool");
  }, BUNDLE_TIMEOUT_MS);

  test("duplicate registration fails like the real factory, with the registration named", async () => {
    await expect(loadSample({ register: ["registerSampleTools", "registerSampleTools"] }))
      .rejects.toThrow(`Registration function "registerSampleTools" failed: Tool with name "${SAMPLE_TOOL_NAME}" already exists.`);
  }, BUNDLE_TIMEOUT_MS);
});

describe("failure cleanup", () => {
  test("build failures reject with Bun's logs and still remove the temp directory", async () => {
    const failure = loadSample({ shims: { [SAMPLE_ENTRY]: "export const = ;" } });
    await expect(failure).rejects.toBeInstanceOf(AggregateError);
    await expect(failure).rejects.toThrow("Tool fixture bundle failed");
  }, BUNDLE_TIMEOUT_MS);

  test("module evaluation errors still remove the temp directory", async () => {
    await expect(loadSample({ shims: { [SAMPLE_ENTRY]: "throw new Error(\"evaluation failed\");" } })).rejects.toThrow("evaluation failed");
  }, BUNDLE_TIMEOUT_MS);

  test("unknown registration names and empty entries are rejected", async () => {
    await expect(loadSample({ register: ["registerNothing"] })).rejects.toThrow(`No bundled entry exports a "registerNothing" function. Entries: ${SAMPLE_ENTRY}.`);
    await expect(loadSample({ entries: [] })).rejects.toThrow("at least one entry");
  }, BUNDLE_TIMEOUT_MS);

  test("factories overrides must still export a definitions Map", async () => {
    const shims = { "lib/factories.ts": "export const definitions = {}; export function createTool() {}" };
    await expect(loadSample({ shims })).rejects.toThrow("must export `definitions` as a Map");
  }, BUNDLE_TIMEOUT_MS);
});

describe("real tool modules used by bundle-based tests", () => {
  test("animation tools (tests/animation-tools.test.ts)", async () => {
    const fixture = await loadToolDefinitions({ entries: ["server/tools/animation.ts"], register: ["registerAnimationTools"], tempRoot });
    expect([...fixture.definitions.keys()]).toEqual(expect.arrayContaining(["create_animation", "manage_keyframes", "animation_timeline"]));
    await expect(fixture.call("create_animation", {})).rejects.toThrow();
  }, BUNDLE_TIMEOUT_MS);

  test("animation and element tools together (tests/group-creation.test.ts)", async () => {
    const fixture = await loadToolDefinitions({
      entries: ["server/tools/animation.ts", "server/tools/element.ts"],
      register: ["registerAnimationTools", "registerElementTools"],
      tempRoot,
    });
    expect([...fixture.definitions.keys()]).toEqual(expect.arrayContaining(["add_group", "bone_rigging"]));
  }, BUNDLE_TIMEOUT_MS);

  test("texture tools (tests/texture-undo.test.ts)", async () => {
    const fixture = await loadToolDefinitions({ entries: ["server/tools/texture.ts"], register: ["registerTextureTools"], tempRoot });
    expect(fixture.definitions.has("create_texture")).toBe(true);
  }, BUNDLE_TIMEOUT_MS);
});
