/**
 * Format conversion tools that run without Blockbench.
 *
 * @module
 */

import { z } from "zod";
import { compileBedrockGeometry } from "../formats/bedrock";
import { downgradeToV410 } from "../document/legacy";
import { defineTool, fileParam, type IRegistrableTool } from "../tool";

const outputParam = z.string().min(1).describe("Output path inside the workspace.");

const legacyTool = defineTool({
  name: "bbmodel_convert_legacy",
  title: "Convert to Blockbench 4",
  description:
    "Writes a copy of a .bbmodel in the 4.10 layout that Blockbench 4.x can open (a 5.0 file opens there as an empty scene). Mirrors Blockbench's Export Legacy Project: groups are inlined into the outliner and position/rotation X and rotation Y keyframes are negated.",
  parameters: { file: fileParam, output: outputParam.describe("Output .bbmodel path inside the workspace."), overwrite: z.boolean().default(false) },
  readOnly: false,
  async execute({ file, output, overwrite }, { store }) {
    const { doc } = await store.read(file);
    const target = store.resolveModelPath(output);
    const converted = downgradeToV410(doc as unknown as Record<string, unknown>);
    const revision = await store.writeText(target, JSON.stringify(converted.doc, null, "\t"), overwrite);
    return { path: target, revision, notes: converted.notes };
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
  async execute({ file, output, identifier, visible_bounds, overwrite }, { store }) {
    const { doc } = await store.read(file);
    const { geometry, skipped } = compileBedrockGeometry(doc, { identifier, visibleBounds: visible_bounds });
    if (output === undefined) return { geometry, skipped };
    const target = store.resolvePath(output, [".json"]);
    await store.writeText(target, JSON.stringify(geometry, null, "\t"), overwrite);
    return { path: target, skipped };
  },
});

/** Conversion tools. */
export const convertTools: readonly IRegistrableTool[] = [legacyTool, bedrockTool];
