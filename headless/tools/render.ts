/**
 * Render tools backed by bb-render (see `../render/bb-render`).
 *
 * Renders happen in separate Node processes, so they never block other tool
 * calls or the Blockbench editor. Images are returned inline as PNG content and
 * also kept on disk.
 *
 * @module
 */

import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RENDER_PRESETS, RENDER_VIEWS, type IRenderRequest, type RenderView } from "../render/bb-render";
import { defineTool, fileParam, type IHeadlessContext, type IRegistrableTool } from "../tool";

const clipParams = {
  clip: z.string().optional().describe("Animation clip name or index; renders the pose at time."),
  time: z.number().min(0).default(0).describe("Clip time in seconds."),
};

async function outputPath(context: IHeadlessContext, file: string, label: string, explicit: string | undefined, overwrite = false): Promise<string> {
  if (explicit !== undefined) {
    const target = context.store.resolvePath(explicit, [".png"]);
    if (!overwrite && (await Bun.file(target).exists())) throw new Error(`${target} already exists; pass overwrite: true to replace it.`);
    return target;
  }
  await mkdir(context.scratchDir, { recursive: true });
  const stem = basename(file).replace(/\.bbmodel$/i, "");
  return join(context.scratchDir, `${stem}-${label}-${Date.now().toString(36)}.png`);
}

async function imageContent(path: string): Promise<CallToolResult["content"][number]> {
  const data = Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64");
  return { type: "image", data, mimeType: "image/png" };
}

const renderTool = defineTool({
  name: "bbmodel_render",
  title: "Render Model",
  description:
    "Renders a .bbmodel file to a PNG with bb-render (headless three.js WebGPU), without Blockbench. Returns the image and its path. Optionally poses the model at a time in an animation clip. Views are relative to the model's front (-Z).",
  parameters: {
    file: fileParam,
    view: z.enum(RENDER_VIEWS).default("three-quarter"),
    preset: z.enum(RENDER_PRESETS).optional().describe("bb-render preset; icon is orthographic with a transparent background."),
    width: z.number().int().min(64).max(4096).default(768),
    height: z.number().int().min(64).max(4096).default(768),
    transparent: z.boolean().default(false),
    orthographic: z.boolean().default(false),
    lighting: z.enum(["studio", "outdoor", "flat"]).optional(),
    output: z.string().optional().describe("PNG path inside the workspace; defaults to a scratch file outside it."),
    overwrite: z.boolean().default(false).describe("Allow output to replace an existing PNG."),
    ...clipParams,
  },
  // Not read-only: an explicit output path writes into the workspace.
  readOnly: false,
  async execute(args, context) {
    const { path } = await context.store.read(args.file);
    const output = await outputPath(context, path, args.view, args.output, args.overwrite);
    const request: IRenderRequest = {
      input: path,
      output,
      view: args.view,
      preset: args.preset,
      width: args.width,
      height: args.height,
      transparent: args.transparent,
      orthographic: args.orthographic,
      lighting: args.lighting,
      ...(args.clip === undefined ? {} : { clip: args.clip, time: args.time }),
    };
    const outcome = await context.renderer.render(request);
    return {
      content: [
        { type: "text", text: JSON.stringify({ path: outcome.output, view: args.view, milliseconds: outcome.milliseconds }) },
        await imageContent(outcome.output),
      ],
    };
  },
});

const DEFAULT_SHEET_VIEWS: RenderView[] = ["front", "right", "back", "left", "three-quarter", "top"];

const contactSheetTool = defineTool({
  name: "bbmodel_contact_sheet",
  title: "Render Contact Sheet",
  description:
    "Renders several named views of a .bbmodel (front, right, back, left, three-quarter, top by default) with identical settings and returns every image, labeled. Use it to review a model from all sides in one call, for example after bbmodel_validate. Flat lighting and an orthographic camera make faces easy to compare.",
  parameters: {
    file: fileParam,
    views: z.array(z.enum(RENDER_VIEWS)).min(1).max(7).default(DEFAULT_SHEET_VIEWS),
    size: z.number().int().min(64).max(2048).default(384).describe("Width and height of each view."),
    orthographic: z.boolean().default(true),
    lighting: z.enum(["studio", "outdoor", "flat"]).default("flat"),
    ...clipParams,
  },
  readOnly: true,
  async execute(args, context) {
    const { path } = await context.store.read(args.file);
    const renders = await Promise.all(
      args.views.map(async (view) => {
        const output = await outputPath(context, path, view, undefined);
        const outcome = await context.renderer.render({
          input: path,
          output,
          view,
          width: args.size,
          height: args.size,
          orthographic: args.orthographic,
          lighting: args.lighting,
          ...(args.clip === undefined ? {} : { clip: args.clip, time: args.time }),
        });
        return { view, outcome };
      }),
    );
    const content = await Promise.all(
      renders.map(async ({ view, outcome }) => [{ type: "text" as const, text: `${view}: ${outcome.output}` }, await imageContent(outcome.output)]),
    );
    return { content: content.flat() };
  },
});

/** Render tools. */
export const renderTools: readonly IRegistrableTool[] = [renderTool, contactSheetTool];
