/**
 * Write tools: create a model, apply a batch of edits, and embed a texture.
 *
 * All edits go through {@link applyOperations} inside one locked
 * read-modify-write cycle, so a batch lands completely or not at all. Each
 * result returns the new revision; pass it as `expected_revision` on the next
 * write to detect edits by other agents in between.
 *
 * @module
 */

import { z } from "zod";
import { VERSION } from "@/lib/constants";
import { webAppField } from "../app/web-link";
import { enforceFormat } from "../edit/format-guard";
import { applyOperations, operationSchema, stampAiUsage } from "../edit/operations";
import { decodePngDataUrl, pngDataUrl, pngSize } from "../document/png";
import { bbmodelSchema, type IBBModel, PBR_CHANNELS } from "../document/schema";
import { defineTool, fileParam, type IHeadlessContext, type IRegistrableTool, revisionParam } from "../tool";

/** Blockbench formats that default to box UV. */
const BOX_UV_FORMATS = new Set(["bedrock", "bedrock_old", "modded_entity", "optifine_entity", "geckolib_model", "skin"]);

/**
 * Builds an empty 5.0 document with the root fields Blockbench writes.
 *
 * @param format - Blockbench format ID, such as `free`, `bedrock`, `java_block` or `geckolib_model`.
 */
export function emptyModel(format: string, name: string, boxUv: boolean, resolution: { width: number; height: number }): IBBModel {
  return bbmodelSchema.parse({
    meta: { format_version: "5.0", model_format: format, box_uv: boxUv },
    name,
    model_identifier: "",
    visible_box: [1, 1, 0],
    variable_placeholders: "",
    variable_placeholder_buttons: [],
    timeline_setups: [],
    unhandled_root_fields: {},
    resolution,
    elements: [],
    groups: [],
    outliner: [],
    textures: [],
  });
}

const stamp = (doc: IBBModel, context: IHeadlessContext): IBBModel => (context.aiDisclosure ? stampAiUsage(doc, context.clientName()) : doc);

const createTool = defineTool({
  name: "bbmodel_create",
  title: "Create Model",
  description: "Creates a new, empty .bbmodel file (format 5.0). Build it up with bbmodel_edit. Refuses to replace an existing file unless overwrite is true.",
  parameters: {
    file: fileParam,
    format: z.string().default("free").describe("Blockbench format ID: free, bedrock, bedrock_block, java_block, geckolib_model, modded_entity, ..."),
    name: z.string().default(""),
    box_uv: z.boolean().optional().describe("Defaults to true for entity formats (bedrock, geckolib_model, modded_entity, ...) and false otherwise."),
    resolution: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).default({ width: 16, height: 16 }),
    overwrite: z.boolean().default(false),
  },
  readOnly: false,
  destructive: true,
  async execute({ file, format, name, box_uv, resolution, overwrite }, context) {
    const doc = stamp(emptyModel(format, name, box_uv ?? BOX_UV_FORMATS.has(format), resolution), context);
    const { path, revision } = await context.store.create(file, doc, overwrite);
    return { path, revision, format, box_uv: doc.meta.box_uv, created_by: `blockbench-mcp-headless ${VERSION}`, ...(await webAppField(doc, path, context.webApp)) };
  },
});

const OPERATIONS_HELP = [
  "Applies edit operations to a .bbmodel file in order, as one atomic write. If any operation fails, nothing is written and the error names the failing operation.",
  "Operations (field op):",
  "add_group {name, origin, rotation, parent};",
  "add_cube {name, from, to, origin?, rotation?, inflate?, parent?, box_uv?, uv_offset?, mirror_uv?, texture?, faces?} (box-UV faces are laid out automatically);",
  "update_node {target, name?, origin?, rotation?, from?, to?, inflate?, uv_offset?, mirror_uv?, faces?, parent?} (parent moves the node; box UV is recomputed);",
  "remove_node {target} (groups are removed with their contents and animators);",
  "add_texture {name, source: PNG data URL, width, height, material?, channel?, wrap_mode?, render_mode?} (bbmodel_add_texture reads a PNG file for you);",
  "add_material {name, color_value?, mer_value?, subsurface_value?} (a PBR material; its textures fill the color, normal or height, and mer channels);",
  "update_material {target, name?, color_value?, mer_value?, subsurface_value?};",
  "update_texture {target, name?, source?, width?, height?, material?, channel?, wrap_mode?, render_mode?} (material null removes it from its material);",
  "assign_texture {targets, texture, faces?, mesh_faces?} (cubes and meshes);",
  "add_animation {name, length, loop, snapping};",
  "remove_animation {animation};",
  "set_keyframe {animation, bone, channel, time, value, interpolation} (replaces a key at the same channel and time);",
  "remove_keyframe {animation, bone, channel, time};",
  "set_model_properties {name?, model_identifier?, resolution?};",
  "add_locator {name, parent?, position, rotation?, ignore_inherited_scale?} (a named point particle effects spawn at; position is absolute model units);",
  "set_particle_keyframe {animation, time, effect, file?, locator?, pre_effect_script?, bind_to_actor?} (file is the particle JSON path relative to the .bbmodel, from bbmodel_particle_effect; replaces the same effect at the same time);",
  "remove_particle_keyframe {animation, time, effect?};",
  "add_mesh {name, vertices (key map or [x,y,z] list, relative to origin), faces [{vertices (3-4 keys or indices), uv?, texture?}], origin?, rotation?, parent?, texture?} (faces without uv get Blockbench's Auto UV);",
  "add_mesh_primitive {shape: cuboid|beveled_cuboid|pyramid|plane|circle|cylinder|tube|cone|sphere|icosphere|octahedron|dodecahedron|torus, diameter?, height?, sides?, align_edges?, detail?, minor_diameter?, minor_sides?, edge_size?, name?, origin?, rotation?, parent?, texture?} (Blockbench's Add Mesh dialog, same geometry and UVs);",
  "edit_mesh {target, actions: [set_vertices {vertices} | move_vertices {keys?, offset} | delete_vertices {keys} | transform {keys?, translate?, rotate?, scale?, pivot?} | add_faces {faces} | delete_faces {faces} | flip_faces {faces?} | merge_vertices {distance?, keys?, in_center?} | extrude_faces {faces, distance, direction?, even_extend?} | subdivide {faces?, cuts?} | loop_cut {face, direction?, cuts?, offset?, spacing?}]} (applied in order);",
  "map_mesh_uv {target, faces?, mode: auto|project_x|project_y|project_z|explicit, uv?, scale?, texture?}.",
  "Meshes are only allowed in the free (Generic) format.",
  "Nodes, textures and animations are addressed by UUID or exact name. Coordinates are absolute model units; rotations are degrees applied Z·Y·X about the origin.",
  "Format rules: a batch is refused when the nodes it adds or changes break the model format's limits, the way Blockbench would (meshes only in the free format; java_block cubes within -16..32 with rotations the model's java_block_version allows; no group rotation in java_block; box UV and integer sizes where forced). Softer problems come back as format_warnings.",
].join(" ");

const editTool = defineTool({
  name: "bbmodel_edit",
  title: "Edit Model",
  description: OPERATIONS_HELP,
  parameters: {
    file: fileParam,
    expected_revision: revisionParam,
    operations: z.array(operationSchema).min(1).max(500),
  },
  readOnly: false,
  async execute({ file, expected_revision, operations }, context) {
    const written = await context.store.update(file, expected_revision, ({ doc }) => {
      const { doc: edited, results } = applyOperations(doc, operations);
      const warnings = enforceFormat(doc, edited);
      const stamped = stamp(edited, context);
      return { doc: stamped, result: { results, doc: stamped, warnings } };
    });
    return {
      path: written.path,
      revision: written.revision,
      results: written.result.results,
      notes: written.notes,
      ...(written.result.warnings.length > 0 ? { format_warnings: written.result.warnings } : {}),
      ...(await webAppField(written.result.doc, written.path, context.webApp)),
    };
  },
});

const addTextureTool = defineTool({
  name: "bbmodel_add_texture",
  title: "Add Texture",
  description:
    "Embeds a PNG into a .bbmodel file as a new texture, from a PNG file inside the workspace or a PNG data URL. Optionally puts it in a PBR material channel (create the material first with bbmodel_edit add_material) and assigns it to every face of some cubes or groups. Assign only color textures to faces; normal, height and MER textures reach the faces through their material.",
  parameters: {
    file: fileParam,
    expected_revision: revisionParam,
    image: z.string().min(1).describe("Path to a .png file inside the workspace, or a data:image/png;base64 URL."),
    name: z.string().optional().describe("Defaults to the PNG file name."),
    material: z.string().min(1).optional().describe("PBR material (UUID or name) to put the texture in."),
    channel: z.enum(PBR_CHANNELS).optional().describe("Channel inside the material: color, normal, height or mer (R metal, G emissive, B roughness). Defaults to color."),
    wrap_mode: z.enum(["limited", "repeat"]).optional().describe("repeat tiles the image on faces whose UVs exceed it."),
    render_mode: z.enum(["default", "emissive", "additive", "layered"]).optional().describe("emissive makes the texture glow (signs, light panels)."),
    assign_to: z.array(z.string().min(1)).default([]).describe("Cubes or groups (UUID or name) whose faces should use the texture."),
  },
  readOnly: false,
  async execute({ file, expected_revision, image, name, material, channel, wrap_mode, render_mode, assign_to }, context) {
    const isDataUrl = image.startsWith("data:");
    const imagePath = isDataUrl ? undefined : context.store.resolvePath(image, [".png"]);
    const bytes = imagePath ? new Uint8Array(await Bun.file(imagePath).arrayBuffer()) : decodePngDataUrl(image);
    const { width, height } = pngSize(bytes);
    const textureName = name ?? imagePath?.split(/[\\/]/).at(-1) ?? "texture.png";
    const uuid = crypto.randomUUID();
    const operations = operationSchema.array().parse([
      { op: "add_texture", name: textureName, source: pngDataUrl(bytes), width, height, uuid, material, channel, wrap_mode, render_mode },
      ...(assign_to.length > 0 ? [{ op: "assign_texture", targets: assign_to, texture: uuid }] : []),
    ]);
    const written = await context.store.update(file, expected_revision, ({ doc }) => {
      const { doc: edited, results } = applyOperations(doc, operations);
      const stamped = stamp(edited, context);
      return { doc: stamped, result: { results, doc: stamped } };
    });
    return {
      path: written.path,
      revision: written.revision,
      texture: { uuid, name: textureName, width, height },
      results: written.result.results,
      ...(await webAppField(written.result.doc, written.path, context.webApp)),
    };
  },
});

/** Write tools. */
export const editTools: readonly IRegistrableTool[] = [createTool, editTool, addTextureTool];
