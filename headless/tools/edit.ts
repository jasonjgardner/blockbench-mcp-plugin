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
import { applyOperations, operationSchema, stampAiUsage } from "../edit/operations";
import { decodePngDataUrl, pngDataUrl, pngSize } from "../document/png";
import { bbmodelSchema, type IBBModel } from "../document/schema";
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
    return { path, revision, format, box_uv: doc.meta.box_uv, created_by: `blockbench-mcp-headless ${VERSION}` };
  },
});

const OPERATIONS_HELP = [
  "Applies edit operations to a .bbmodel file in order, as one atomic write. If any operation fails, nothing is written and the error names the failing operation.",
  "Operations (field op):",
  "add_group {name, origin, rotation, parent};",
  "add_cube {name, from, to, origin?, rotation?, inflate?, parent?, box_uv?, uv_offset?, mirror_uv?, texture?, faces?} (box-UV faces are laid out automatically);",
  "update_node {target, name?, origin?, rotation?, from?, to?, inflate?, uv_offset?, mirror_uv?, parent?} (parent moves the node; box UV is recomputed);",
  "remove_node {target} (groups are removed with their contents and animators);",
  "add_texture {name, source: PNG data URL, width, height} (bbmodel_add_texture reads a PNG file for you);",
  "assign_texture {targets, texture, faces?};",
  "add_animation {name, length, loop, snapping};",
  "set_keyframe {animation, bone, channel, time, value, interpolation} (replaces a key at the same channel and time);",
  "remove_keyframe {animation, bone, channel, time};",
  "set_model_properties {name?, model_identifier?, resolution?}.",
  "Nodes, textures and animations are addressed by UUID or exact name. Coordinates are absolute model units; rotations are degrees applied Z·Y·X about the origin.",
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
      return { doc: stamp(edited, context), result: results };
    });
    return { path: written.path, revision: written.revision, results: written.result, notes: written.notes };
  },
});

const addTextureTool = defineTool({
  name: "bbmodel_add_texture",
  title: "Add Texture",
  description: "Embeds a PNG into a .bbmodel file as a new texture, from a PNG file inside the workspace or a PNG data URL. Optionally assigns it to every face of some cubes or groups.",
  parameters: {
    file: fileParam,
    expected_revision: revisionParam,
    image: z.string().min(1).describe("Path to a .png file inside the workspace, or a data:image/png;base64 URL."),
    name: z.string().optional().describe("Defaults to the PNG file name."),
    assign_to: z.array(z.string().min(1)).default([]).describe("Cubes or groups (UUID or name) whose faces should use the texture."),
  },
  readOnly: false,
  async execute({ file, expected_revision, image, name, assign_to }, context) {
    const isDataUrl = image.startsWith("data:");
    const imagePath = isDataUrl ? undefined : context.store.resolvePath(image, [".png"]);
    const bytes = imagePath ? new Uint8Array(await Bun.file(imagePath).arrayBuffer()) : decodePngDataUrl(image);
    const { width, height } = pngSize(bytes);
    const textureName = name ?? imagePath?.split(/[\\/]/).at(-1) ?? "texture.png";
    const uuid = crypto.randomUUID();
    const operations = operationSchema.array().parse([
      { op: "add_texture", name: textureName, source: pngDataUrl(bytes), width, height, uuid },
      ...(assign_to.length > 0 ? [{ op: "assign_texture", targets: assign_to, texture: uuid }] : []),
    ]);
    const written = await context.store.update(file, expected_revision, ({ doc }) => {
      const { doc: edited, results } = applyOperations(doc, operations);
      return { doc: stamp(edited, context), result: results };
    });
    return { path: written.path, revision: written.revision, texture: { uuid, name: textureName, width, height }, results: written.result };
  },
});

/** Write tools. */
export const editTools: readonly IRegistrableTool[] = [createTool, editTool, addTextureTool];
