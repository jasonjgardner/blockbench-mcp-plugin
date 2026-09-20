import { describe, expect, test } from "bun:test";
import type { IToolSpec } from "@/lib/factories";
import { evaluateHostCondition } from "@/tests/helpers/condition-host";
import { animationToolDocs } from "@/server/tools/animation/docs";
import { armatureToolDocs } from "@/server/tools/armature";
import { cameraToolDocs } from "@/server/tools/camera";
import { capabilityToolDocs } from "@/server/tools/capabilities";
import { cubeToolDocs } from "@/server/tools/cubes";
import { cubeUvToolDocs } from "@/server/tools/cube-uv";
import { displayToolDocs } from "@/server/tools/display";
import { exportToolDocs } from "@/server/tools/export";
import { historyToolDocs } from "@/server/tools/history";
import { hytaleToolDocs } from "@/server/tools/hytale";
import { knifeToolDocs } from "@/server/tools/knife";
import { materialInstanceToolDocs } from "@/server/tools/material-instances";
import { meshToolDocs } from "@/server/tools/mesh";
import { paintToolDocs } from "@/server/tools/paint/docs";
import { projectToolDocs } from "@/server/tools/project";
import { textureToolDocs } from "@/server/tools/texture";
import { uiToolDocs } from "@/server/tools/ui";
import { useGlobals } from "@/tests/helpers/globals";

const specs = [
  ...animationToolDocs, ...armatureToolDocs, ...cameraToolDocs,
  ...capabilityToolDocs, ...cubeToolDocs, ...cubeUvToolDocs, ...displayToolDocs, ...exportToolDocs,
  ...historyToolDocs, ...hytaleToolDocs, ...knifeToolDocs, ...materialInstanceToolDocs,
  ...meshToolDocs, ...paintToolDocs, ...projectToolDocs, ...textureToolDocs,
  ...uiToolDocs,
];
const genericFormat = {
  id: "free", edit_mode: true, paint_mode: true, meshes: true,
  animation_mode: true, bone_rig: true, armature_rig: true, pbr: true,
};
const strokeTools = ["fill_tool", "draw_shape_tool", "gradient_tool", "copy_brush", "eraser"];

useGlobals(() => ({
  Project: { uuid: "project" },
  Format: { ...genericFormat },
  Modes: { id: "edit" },
  Blockbench: { isWeb: false },
  ModelProject: { all: [{ uuid: "project" }] },
  Preview: { selected: {} },
  Texture: { all: [{}], selected: null },
  Undo: { index: 1, history: [{}] },
  Plugins: { installed: [] },
  Dialog: { stack: [] },
  BarItems: Object.fromEntries(strokeTools.map(id => [id, { condition: { modes: ["paint"] } }])),
  Condition: evaluateHostCondition,
}));

/** Evaluates a named public specification using the same native entry point as the factory. */
function available(name: string): boolean {
  const spec: IToolSpec | undefined = specs.find(candidate => candidate.name === name);
  if (!spec) throw new Error(`Missing tool specification: ${name}`);
  return Condition(spec.condition);
}

describe("native tool availability contracts", () => {
  test("discovery and project creation remain available without an open project", () => {
    Object.assign(globalThis, { Project: null, ModelProject: { all: [] } });
    ["get_capabilities", "create_project", "list_export_formats", "create_brush_preset", "capture_app_screenshot",
      "create_offscreen_view", "list_views", "resize_offscreen_view", "delete_offscreen_view"]
      .forEach(name => expect(available(name)).toBe(true));
    ["get_project_info", "place_mesh", "create_animation", "place_cube", "create_texture", "capture_screenshot", "undo",
      "set_camera_angle"]
      .forEach(name => expect(available(name)).toBe(false));
  });

  test("set_camera_angle needs a render target even with a project open", () => {
    Object.assign(globalThis, { Preview: { selected: null, all: [] } });
    expect(available("set_camera_angle")).toBe(false);
    expect(available("capture_screenshot")).toBe(true);
  });

  test("format features distinguish generic models from Java display projects", () => {
    ["place_mesh", "create_animation", "bone_rigging", "add_armature", "create_pbr_material"]
      .forEach(name => expect(available(name)).toBe(true));
    ["enter_display_mode", "set_face_material_instance"].forEach(name => expect(available(name)).toBe(false));
    Object.assign(globalThis, { Format: { id: "java_block", edit_mode: true, paint_mode: true, display_mode: true } });
    ["place_cube", "enter_display_mode", "set_display_transform"].forEach(name => expect(available(name)).toBe(true));
    ["place_mesh", "create_animation", "add_armature", "create_pbr_material"]
      .forEach(name => expect(available(name)).toBe(false));
  });

  test("targeted tools and mode-entry tools do not require an existing selection or active mode", () => {
    Object.assign(globalThis, { Modes: { id: "paint" } });
    ["place_mesh", "select_mesh_elements", "manage_keyframes", "animation_timeline", "add_armature", "activate_texture"]
      .forEach(name => expect(available(name)).toBe(true));
    Object.assign(globalThis, { Format: { id: "java_block", display_mode: true } });
    expect(available("enter_display_mode")).toBe(true);
  });

  test("native painting observes toolbar conditions while direct texture editing accepts explicit targets", () => {
    expect(available("paint_fill_tool")).toBe(false);
    expect(available("paint_with_brush")).toBe(true);
    Object.assign(globalThis, { Modes: { id: "paint" } });
    ["paint_fill_tool", "draw_shape_tool", "gradient_tool", "copy_brush_tool", "eraser_tool"]
      .forEach(name => expect(available(name)).toBe(true));
    Object.assign(globalThis, { BarItems: { fill_tool: { condition: false } } });
    expect(available("paint_fill_tool")).toBe(false);
    expect(available("draw_shape_tool")).toBe(false);
    Object.assign(globalThis, { Texture: { all: [], selected: null } });
    expect(available("paint_with_brush")).toBe(false);
    expect(available("create_texture")).toBe(true);
  });

  test("undo, redo, dialogs, desktop APIs and unsupported tools track real prerequisites", () => {
    expect(available("undo")).toBe(true);
    expect(available("redo")).toBe(false);
    Object.assign(globalThis, { Undo: { index: 0, history: [{}] }, Dialog: { stack: [{}] } });
    expect(available("undo")).toBe(false);
    expect(available("redo")).toBe(true);
    expect(available("fill_dialog")).toBe(true);
    Object.assign(globalThis, { Blockbench: { isWeb: true } });
    ["capture_app_screenshot", "save_material_config", "import_texture_set", "emulate_clicks"]
      .forEach(name => expect(available(name)).toBe(false));
    expect(available("knife_tool")).toBe(false);
  });

  test("Hytale availability changes with plugin enablement and active format", () => {
    Object.assign(globalThis, { Format: { id: "hytale_character" } });
    expect(available("hytale_create_quad")).toBe(false);
    Object.assign(globalThis, { Plugins: { installed: [{ id: "hytale_plugin", disabled: false }] } });
    expect(available("hytale_create_quad")).toBe(true);
    Object.assign(globalThis, { Format: genericFormat });
    expect(available("hytale_create_quad")).toBe(false);
    Object.assign(globalThis, {
      Format: { id: "hytale_prop" },
      Plugins: { installed: [{ id: "hytale_plugin", disabled: true }] },
    });
    expect(available("hytale_create_quad")).toBe(false);
  });
});

describe("AI scratchpad mode availability", () => {
  test("edit-only geometry tools stay available in the scratchpad mode", () => {
    Object.assign(globalThis, { Modes: { id: "ai_scratchpad" } });
    ["knife_cut_cube", "slice_cubes_to_block_grid", "set_cube_uv"].forEach(name => {
      expect(available(name)).toBe(true);
    });
  });
});
