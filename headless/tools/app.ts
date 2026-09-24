/**
 * Tools that hand a model to a Blockbench app: a Blockbench web app link that
 * carries the file in its URL, and a launcher for the desktop app.
 *
 * @module
 */

import { basename } from "node:path";
import { z } from "zod";
import { launchBlockbench, locateBlockbench, waitForEndpoint } from "../app/desktop";
import { buildWebAppFileLinks, buildWebAppLinks } from "../app/web-link";
import { defineTool, type IRegistrableTool } from "../tool";

/** Files the desktop app opens from its command line. */
const OPENABLE = [".bbmodel", ".json", ".obj", ".gltf", ".glb", ".png"];

const webUrlTool = defineTool({
  name: "bbmodel_web_url",
  title: "Blockbench Web App Link",
  description:
    "Makes a link that opens a .bbmodel (or a Bedrock/Java .json model) in the Blockbench web app, with the file carried in the URL's loaddata parameter, so nothing is uploaded. Returns tiers: url (the complete model) when it is short enough to paste; otherwise geometry_url (the model without texture images) when that fits, plus launcher, a local .html page that opens the complete model in a Chromium browser when its URL is under about 2 MB. Share the url, geometry_url or launcher.file_url with the user. Write tools already include these links as web_app.",
  parameters: {
    file: z.string().min(1).describe("Path to a .bbmodel or model .json file, absolute or relative to the first workspace root."),
    inline_max: z
      .number()
      .int()
      .min(200)
      .max(2_000_000)
      .optional()
      .describe("Longest URL to return inline, in characters. Defaults to the server setting (8000); raise it to get the complete model's URL even when it is long."),
  },
  // Writes a launcher page into the scratch folder, never into the workspace.
  readOnly: false,
  async execute({ file, inline_max }, { store, webApp }) {
    const options = { ...webApp, inlineMax: inline_max ?? webApp.inlineMax };
    const path = store.resolvePath(file, [".bbmodel", ".json"]);
    if (path.toLowerCase().endsWith(".bbmodel")) {
      const { doc, revision } = await store.read(path);
      return { path, revision, web_app: await buildWebAppLinks(doc as unknown as Record<string, unknown>, basename(path), options, path) };
    }
    const content = await Bun.file(path).text();
    return { path, web_app: await buildWebAppFileLinks(content, basename(path), options, path) };
  },
});

const launchTool = defineTool({
  name: "blockbench_launch",
  title: "Launch Blockbench Desktop",
  description:
    "Starts the Blockbench desktop app, optionally opening a file from the workspace (.bbmodel, .json, .obj, .gltf, .glb or .png). If Blockbench is already running, the file opens as a new tab in that window. Set wait_for_mcp_ms to wait until the desktop Blockbench MCP plugin answers, before driving the app with that server. The app is found from --blockbench, $BLOCKBENCH_PATH, blockbench on PATH, or the standard install folders. On Linux it needs a display, and snap or flatpak builds may be unable to read folders outside your home.",
  parameters: {
    file: z.string().min(1).optional().describe("File to open, absolute or relative to the first workspace root."),
    wait_for_mcp_ms: z
      .number()
      .int()
      .min(0)
      .max(180_000)
      .default(0)
      .describe("Wait up to this long for the desktop plugin's MCP endpoint to answer; 0 returns right after launching."),
  },
  // Starts another program: never auto-approved as read-only.
  readOnly: false,
  openWorld: true,
  async execute({ file, wait_for_mcp_ms }, { store, desktop }) {
    const path = file === undefined ? undefined : store.resolvePath(file, OPENABLE);
    if (path !== undefined && !(await Bun.file(path).exists())) throw new Error(`File not found: ${path}`);
    const executable = locateBlockbench(desktop.executable);
    if (!executable) {
      throw new Error(
        "Blockbench desktop was not found. Install it from https://www.blockbench.net/downloads, or start the headless server with --blockbench <path to the executable or .app>, or set BLOCKBENCH_PATH.",
      );
    }
    const { command, args, pid } = await launchBlockbench(executable, path);
    const mcp = wait_for_mcp_ms > 0 ? { url: desktop.mcpUrl, ...(await waitForEndpoint(desktop.mcpUrl, wait_for_mcp_ms)) } : undefined;
    return {
      launched: true,
      executable,
      command: [command, ...args],
      pid,
      ...(path ? { file: path } : {}),
      ...(mcp ? { mcp } : {}),
      note: [
        "An already-running Blockbench opens the file in a new tab instead of starting a second window.",
        "Headless edits made after this do not reload in the app; reopen the file there to see them.",
        mcp && !mcp.reachable ? `The desktop MCP plugin did not answer at ${mcp.url} in time; check that the plugin is installed and its server is enabled in Settings > General.` : "",
      ]
        .filter(Boolean)
        .join(" "),
    };
  },
});

/** App hand-off tools. */
export const appTools: readonly IRegistrableTool[] = [webUrlTool, launchTool];
