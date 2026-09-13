import { beforeAll, describe, expect, test } from "bun:test";
import { BUILD_ID, BUILD_MODE, VERSION } from "@/lib/constants";
import { tools } from "@/lib/factories";
import {
  capabilityToolDocs,
  getCapabilitiesParameters,
  registerCapabilityTools,
  type ICapabilitiesSnapshot,
} from "@/server/tools/capabilities";
import { isRecord, required } from "@/tests/helpers/assertions";
import { useGlobals } from "@/tests/helpers/globals";
import { executeStructured } from "@/tests/helpers/tool-execution";

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
  per_group_texture: false,
  uv_rotation: false,
  box_uv_float_size: false,
  integer_size: false,
  armature_rig: false,
  stretch_cubes: false,
  quaternion_interpolation: false,
  animation_loop_wrapping: false,
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
  registerCapabilityTools();
});

useGlobals(() => ({
  Blockbench: Object.freeze({ version: "5.0.6", isWeb: false, platform: "win32", isMobile: false }),
  Project: activeProject,
  Format: freeFormat,
  Formats: registeredFormats,
}));

function isSnapshot(value: unknown): value is ICapabilitiesSnapshot {
  return isRecord(value) && isRecord(value.plugin) && isRecord(value.blockbench) && Array.isArray(value.formats);
}

/**
 * Calls get_capabilities with raw arguments. The helper requires a JSON text item
 * deep-equal to structuredContent, which also proves the full public result is serializable.
 */
function inspect(args: Record<string, unknown> = {}): Promise<ICapabilitiesSnapshot> {
  return executeStructured("get_capabilities", args, isSnapshot);
}

describe("capability discovery", () => {
  test("works without a project and does not report a stale selected format", async () => {
    Object.assign(globalThis, { Project: null });
    const result = await inspect();
    expect(result.project).toBeNull();
    expect(result.format).toBeNull();
    expect(result.plugin.version).toBe(VERSION);
    expect(result.plugin.build_id).toBe(BUILD_ID);
    expect(result.plugin.build_mode).toBe(BUILD_MODE);
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
      const disabled = required(result.tools?.find(({ name }) => name === key), "disabled tool entry");
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
    required(first.format, "active format").features.meshes = false;
    required(first.project, "active project").counts.meshes = 900;
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
