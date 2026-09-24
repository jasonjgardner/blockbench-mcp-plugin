/**
 * Format conversion tools that run without Blockbench.
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { ModelStore } from "../document/store";
import { stampAiUsage } from "../edit/operations";
import { compileJavaBlockModel, importJavaBlockModel } from "../formats/java-block";
import { JAVA_BLOCK_VERSIONS } from "../formats/java-block-shared";
import { buildWebAppFileLinks, type IWebAppOptions, linkOrNote, webAppField } from "../app/web-link";
import { compileBedrockGeometry } from "../formats/bedrock";
import { downgradeToV410 } from "../document/legacy";
import { compileModdedEntity, DEFAULT_MODDED_ENTITY_TEMPLATE, MODDED_ENTITY_TEMPLATE_IDS, MODDED_ENTITY_TEMPLATE_LIST } from "../formats/modded-entity";
import { defineTool, fileParam, type IRegistrableTool } from "../tool";

const outputParam = z.string().min(1).describe("Output path inside the workspace.");

/** Web-app links for compiled geometry, or nothing when links are off. */
const geometryLinks = async (text: string, name: string, options: IWebAppOptions, key: string) =>
  options.enabled ? { web_app: await linkOrNote(buildWebAppFileLinks(text, name, options, key)) } : {};

const legacyTool = defineTool({
  name: "bbmodel_convert_legacy",
  title: "Convert to Blockbench 4",
  description:
    "Writes a copy of a .bbmodel in the 4.10 layout that Blockbench 4.x can open (a 5.0 file opens there as an empty scene). Mirrors Blockbench's Export Legacy Project: groups are inlined into the outliner and position/rotation X and rotation Y keyframes are negated.",
  parameters: { file: fileParam, output: outputParam.describe("Output .bbmodel path inside the workspace."), overwrite: z.boolean().default(false) },
  readOnly: false,
  async execute({ file, output, overwrite }, { store, webApp }) {
    const { doc } = await store.read(file);
    const target = store.resolveModelPath(output);
    const converted = downgradeToV410(doc as unknown as Record<string, unknown>);
    const revision = await store.writeText(target, JSON.stringify(converted.doc, null, "\t"), overwrite);
    return { path: target, revision, notes: converted.notes, ...(await webAppField(converted.doc, target, webApp)) };
  },
});

const bedrockTool = defineTool({
  name: "bbmodel_export_bedrock_geometry",
  title: "Export Bedrock Geometry",
  description:
    "Compiles a .bbmodel to Minecraft Bedrock geometry (.geo.json) using the same conventions as Blockbench's Bedrock codec: mirrored X, flipped up/down UVs, bb_main for root cubes, and visible bounds. Only cubes are exported; other element types are listed in skipped. Returns the JSON inline when no output path is given.",
  parameters: {
    file: fileParam,
    output: outputParam.optional().describe("Output .json path inside the workspace; omit to return the geometry inline."),
    identifier: z.string().optional().describe("Geometry identifier; defaults to the model identifier or name."),
    visible_bounds: z.boolean().default(true),
    overwrite: z.boolean().default(false),
  },
  readOnly: false,
  async execute({ file, output, identifier, visible_bounds, overwrite }, { store, webApp }) {
    const { doc, path: source } = await store.read(file);
    const { geometry, skipped } = compileBedrockGeometry(doc, { identifier, visibleBounds: visible_bounds });
    const text = JSON.stringify(geometry, null, "\t");
    if (output === undefined) return { geometry, skipped, ...(await geometryLinks(text, `${basename(source, ".bbmodel")}.geo.json`, webApp, source)) };
    const target = store.resolvePath(output, [".json"]);
    await store.writeText(target, text, overwrite);
    // Links come after the write, so a refused output path leaves no launcher behind.
    return { path: target, skipped, ...(await geometryLinks(text, basename(target), webApp, target)) };
  },
});

const moddedEntityTool = defineTool({
  name: "bbmodel_export_modded_entity",
  title: "Export Modded Entity (Java)",
  description: `Compiles a .bbmodel to a Java entity model class with the same templates and code generation as Blockbench's Modded Entity exporter. Templates: ${MODDED_ENTITY_TEMPLATE_LIST.map((template) => `${template.id} (${template.name})`).join(", ")}. Groups become bones, rotated cubes get _r1 rotation parts like Blockbench's, root cubes go in bb_main. Only cubes are exported; skipped elements, renamed bones and floored sizes are listed in notes. Returns the code inline when no output path is given.`,
  parameters: {
    file: fileParam,
    template: z.enum(MODDED_ENTITY_TEMPLATE_IDS).default(DEFAULT_MODDED_ENTITY_TEMPLATE).describe("Loader, mappings and Minecraft version of the generated class."),
    output: outputParam.optional().describe("Output .java path inside the workspace; omit to return the code inline."),
    model_name: z.string().min(1).optional().describe("Class name source; defaults to the model identifier, then the model name."),
    entity_class: z.string().min(1).optional().describe("Entity type in the generated generics; defaults to the project's setting, then Entity."),
    flip_y: z.boolean().optional().describe("Blockbench's Flip Y option (default true): Y-down pivots, root bones offset by 24."),
    overwrite: z.boolean().default(false),
  },
  readOnly: false,
  async execute({ file, template, output, model_name, entity_class, flip_y, overwrite }, { store }) {
    const { doc } = await store.read(file);
    const { code, className, notes } = compileModdedEntity(doc, { template, modelName: model_name, entityClass: entity_class, flipY: flip_y });
    if (output === undefined) return { class_name: className, template, code, notes };
    const target = store.resolvePath(output, [".java"]);
    await store.writeText(target, code, overwrite);
    return { path: target, class_name: className, template, notes };
  },
});

const javaExportTool = defineTool({
  name: "bbmodel_export_java_block",
  title: "Export Java Block/Item Model",
  description:
    "Compiles a .bbmodel to a Minecraft Java Edition block/item model .json the way Blockbench's Java Block/Item codec does: format_version, textures map (#id → namespace:folder/name), elements with 16-scale UVs, rotation (single-axis angle/axis for older versions, x/y/z for 1.21.11+ and 26.3), cullface, tintindex, display, groups and ambientocclusion. Meshes and other non-cube elements are skipped and listed in notes. Returns the JSON inline when no output path is given.",
  parameters: {
    file: fileParam,
    output: outputParam.optional().describe("Output .json path inside the workspace (usually assets/<namespace>/models/block/<name>.json); omit to return the model inline."),
    version: z.enum(JAVA_BLOCK_VERSIONS).optional().describe("Target java_block_version; defaults to the model's own, then 26.3."),
    export_groups: z.boolean().optional().describe("Write Blockbench's groups outliner export (default true, like Blockbench)."),
    export_pivots: z.boolean().optional().describe("Write zero-angle rotation blocks for cubes with a pivot (Blockbench's java_export_pivots, default true)."),
    credit: z.string().optional().describe("Credit line; defaults to Blockbench's."),
    overwrite: z.boolean().default(false),
  },
  readOnly: false,
  async execute({ file, output, version, export_groups, export_pivots, credit, overwrite }, { store, webApp }) {
    const { doc, path: source } = await store.read(file);
    const { model, notes } = compileJavaBlockModel(doc, { version, exportGroups: export_groups, exportPivots: export_pivots, credit });
    const text = JSON.stringify(model, null, "\t");
    if (output === undefined) return { model, notes, ...(await geometryLinks(text, `${basename(source, ".bbmodel")}.json`, webApp, source)) };
    const target = store.resolvePath(output, [".json"]);
    await store.writeText(target, text, overwrite);
    return { path: target, notes, ...(await geometryLinks(text, basename(target), webApp, target)) };
  },
});

/** Reads a workspace file for the Java importer's callbacks; anything outside the sandbox or missing is undefined. */
function packReader(store: ModelStore, packs: readonly string[]): (path: string) => Uint8Array | undefined {
  return (path) => {
    const candidates = isAbsolute(path) ? [path] : [...packs.map((pack) => join(pack, path)), path];
    const found = candidates.flatMap((candidate) => {
      try {
        const resolved = store.resolvePath(candidate);
        return existsSync(resolved) ? [resolved] : [];
      } catch {
        return [];
      }
    })[0];
    return found === undefined ? undefined : new Uint8Array(readFileSync(found));
  };
}

const javaImportTool = defineTool({
  name: "bbmodel_import_java_block",
  title: "Import Java Block/Item Model",
  description:
    "Converts a Minecraft Java Edition block/item model .json into a new java_block .bbmodel, porting Blockbench's Java Block/Item import: elements become cubes (UVs scaled to the project resolution), rotations, cullface, tintindex, display and groups are kept, and parent models are resolved and merged the way Blockbench's 'resolve parent' does. Textures are embedded when their PNGs are found in the model's resource pack or in resource_packs; otherwise they stay path-linked (namespace:folder/name).",
  parameters: {
    model: z.string().min(1).describe("Path to the Java model .json inside the workspace, ideally inside a resource pack (…/assets/<namespace>/models/…)."),
    output: z.string().min(1).describe("New .bbmodel path inside the workspace."),
    resource_packs: z.array(z.string().min(1)).default([]).describe("Extra resource pack folders (containing assets/) searched for textures and parent models, e.g. an extracted vanilla pack."),
    resolve_parents: z.boolean().default(true).describe("Merge parent models found in the packs."),
    default_version: z.enum(JAVA_BLOCK_VERSIONS).optional().describe("java_block_version for files without format_version (Blockbench's default: 26.3)."),
    name: z.string().optional(),
    overwrite: z.boolean().default(false),
  },
  readOnly: false,
  destructive: true,
  async execute({ model, output, resource_packs, resolve_parents, default_version, name, overwrite }, context) {
    const modelPath = context.store.resolvePath(model, [".json"]);
    const packs = resource_packs.map((pack) => context.store.resolvePath(pack));
    const read = packReader(context.store, packs);
    const json: unknown = JSON.parse(await Bun.file(modelPath).text());
    const { doc, notes } = importJavaBlockModel(json, {
      name: name ?? basename(modelPath, ".json"),
      modelPath,
      defaultVersion: default_version,
      resolveTexture: read,
      ...(resolve_parents ? { resolveParent: (path: string) => read(path) } : {}),
    });
    const stamped = context.aiDisclosure ? stampAiUsage(doc, context.clientName()) : doc;
    const { path, revision } = await context.store.create(output, stamped, overwrite);
    const embedded = stamped.textures.filter((texture) => typeof texture.source === "string" && texture.source.startsWith("data:")).length;
    return {
      path,
      revision,
      counts: { cubes: stamped.elements.length, groups: stamped.groups.length, textures: stamped.textures.length, embedded_textures: embedded },
      notes,
      ...(await webAppField(stamped, path, context.webApp)),
    };
  },
});

/** Conversion tools. */
export const convertTools: readonly IRegistrableTool[] = [legacyTool, bedrockTool, javaExportTool, javaImportTool, moddedEntityTool];
