import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { VERSION } from "@/lib/constants";
import { getAllToolDefinitions, tools } from "@/lib/factories";
import {
  capabilityToolDocs,
  getCapabilitiesParameters,
  registerCapabilityTools,
  type CapabilitiesSnapshot,
} from "./capabilities";

const globals = ["Blockbench", "Project", "Format", "Formats"];
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
const baseFeatures = {
  meshes: false,
  bone_rig: false,
  edit_mode: true,
  paint_mode: true,
  image_editor: false,
  animation_mode: false,
  animation_files: false,
  animation_controllers: false,
  display_mode: false,
  box_uv: false,
  optional_box_uv: false,
  single_texture: false,
  per_texture_uv_size: false,
  pbr: false,
  rotate_cubes: true,
  rotation_limit: false,
  texture_meshes: false,
  locators: false,
};

const freeFormat = Object.freeze({ ...baseFeatures, id: "free", name: "Generic Model", meshes: true, bone_rig: true, animation_mode: true, pbr: true });
const javaFormat = Object.freeze({ ...baseFeatures, id: "java_block", name: "Java Block/Item", rotation_limit: true, display_mode: true });
const registeredFormats = Object.freeze({ java_block: javaFormat, free: freeFormat });
const activeProject = Object.freeze({
  uuid: "project-identity",
  name: "MCP identity",
  format: freeFormat,
  elements: Object.freeze([{ type: "mesh" }, { type: "mesh" }, { type: "cube" }]),
  groups: Object.freeze([{ uuid: "group-1" }]),
  textures: Object.freeze([{ uuid: "texture-1" }]),
  animations: Object.freeze([]),
});

beforeAll(() => {
  globals.forEach((name) => originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)));
  registerCapabilityTools();
});

beforeEach(() => {
  Object.assign(globalThis, {
    Blockbench: Object.freeze({ version: "5.0.6", isWeb: false, platform: "win32", isMobile: false }),
    Project: activeProject,
    Format: freeFormat,
    Formats: registeredFormats,
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

async function inspect(args: Record<string, unknown> = {}): Promise<CapabilitiesSnapshot> {
  const parameters = getCapabilitiesParameters.parse(args);
  const result = await getAllToolDefinitions().get_capabilities.execute(parameters);
  if (typeof result === "string") throw new Error("Expected a structured discovery result");
  const text = result.content.find((item) => item.type === "text");
  if (!text || text.type !== "text") throw new Error("Expected JSON text alongside structured content");
  const parsed: unknown = JSON.parse(text.text);
  expect(parsed).toEqual(result.structuredContent);
  // The equality check also ensures serializability of the full public result.
  return result.structuredContent as CapabilitiesSnapshot;
}

describe("capability discovery", () => {
  test("works without a project and does not report a stale selected format", async () => {
    Object.assign(globalThis, { Project: null });
    const result = await inspect();
    expect(result.project).toBeNull();
    expect(result.format).toBeNull();
    expect(result.plugin.version).toBe(VERSION);
    expect(result.blockbench).toEqual({ version: "5.0.6", environment: "desktop", platform: "win32", is_mobile: false });
    expect(result.formats.map(({ id }) => id)).toEqual(["free", "java_block"]);
    expect(result.formats[0]?.supported_features).toContain("meshes");
    expect(result.formats[1]?.supported_features).not.toContain("meshes");
    expect(result.tools).toBeUndefined();
  });

  test("works when the no-project host leaves Project undefined", async () => {
    Reflect.deleteProperty(globalThis, "Project");
    const result = await inspect({ format_id: "free" });
    expect(result.project).toBeNull();
    expect(result.format?.features.meshes).toBe(true);
  });

  test("reports current project counts and actual format features", async () => {
    const result = await inspect();
    expect(result.project).toEqual({
      uuid: "project-identity",
      name: "MCP identity",
      format_id: "free",
      counts: { elements: 3, meshes: 2, cubes: 1, groups: 1, textures: 1, animations: 0 },
    });
    expect(result.format).toMatchObject({ id: "free", features: { meshes: true, pbr: true, rotation_limit: false } });
  });

  test("inspects another format without switching the project or format", async () => {
    const result = await inspect({ format_id: "java_block" });
    expect(result.project?.format_id).toBe("free");
    expect(result.format).toMatchObject({ id: "java_block", features: { meshes: false, rotation_limit: true, display_mode: true } });
    expect(Reflect.get(globalThis, "Project")).toBe(activeProject);
    expect(Reflect.get(globalThis, "Format")).toBe(freeFormat);
  });

  test("reports web/mobile environment using Blockbench host flags", async () => {
    Object.assign(globalThis, { Blockbench: { version: "5.0.6", isWeb: true, platform: "web", isMobile: true } });
    expect((await inspect()).blockbench).toEqual({ version: "5.0.6", environment: "web", platform: "web", is_mobile: true });
  });

  test("preserves unknown feature declarations rather than claiming support", async () => {
    Object.assign(globalThis, { Formats: { ...registeredFormats, custom: { id: "custom", name: "Custom", meshes: "true" } } });
    const result = await inspect({ format_id: "custom" });
    expect(result.format?.features.meshes).toBeNull();
    const custom = result.formats.find(({ id }) => id === "custom");
    expect(custom?.supported_features).toEqual([]);
    expect(custom?.unknown_features).toContain("meshes");
    expect(custom?.unknown_features).toContain("pbr");
    expect(result.formats.find(({ id }) => id === "free")?.unknown_features).toBeUndefined();
  });

  test("includes disabled tools with their actual status and detached metadata", async () => {
    const key = "__capabilities_disabled_test_tool";
    tools[key] = { name: key, description: "Test disabled discovery entry", enabled: false, status: "experimental" };
    try {
      const result = await inspect({ include_tools: true });
      expect(result.tools).toContainEqual({ name: key, enabled: false, status: "experimental" });
      expect(result.tools).toContainEqual({ name: "get_capabilities", enabled: true, status: "stable" });
      const disabled = result.tools?.find(({ name }) => name === key);
      if (!disabled) throw new Error("Expected disabled entry");
      disabled.enabled = true;
      expect(tools[key]?.enabled).toBe(false);
    } finally {
      Reflect.deleteProperty(tools, key);
    }
  });

  test("rejects unknown and inherited format identifiers with recovery instructions", async () => {
    await expect(inspect({ format_id: "generic" })).rejects.toThrow("Call get_capabilities without format_id");
    await expect(inspect({ format_id: "toString" })).rejects.toThrow("Unknown format ID");
    expect(getCapabilitiesParameters.safeParse({ format_id: "" }).success).toBe(false);
    expect(getCapabilitiesParameters.safeParse({ include_tools: "true" }).success).toBe(false);
  });

  test("returns independent snapshots without modifying host arrays or flags", async () => {
    const before = JSON.stringify({ project: activeProject, formats: registeredFormats });
    const first = await inspect();
    if (!first.format || !first.project) throw new Error("Expected active project");
    first.format.features.meshes = false;
    first.project.counts.meshes = 900;
    first.formats[0]?.supported_features.pop();
    const second = await inspect();
    expect(second.format?.features.meshes).toBe(true);
    expect(second.project?.counts.meshes).toBe(2);
    expect(JSON.stringify({ project: activeProject, formats: registeredFormats })).toBe(before);
  });

  test("advertises read-only behavior and keeps schemas independent from runtime formats", () => {
    expect(capabilityToolDocs[0]?.annotations).toEqual({
      title: "Get Capabilities",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(getCapabilitiesParameters.parse({ format_id: "plugin_defined_later" })).toEqual({ format_id: "plugin_defined_later", include_tools: false });
  });
});
