/**
 * Builds the headless MCP server: `.bbmodel` tools that run in Bun without
 * Blockbench.
 *
 * Why this exists: the desktop plugin runs every tool on Blockbench's single
 * renderer thread against the one active project, so parallel agents contend
 * for the same editor and block the user. The headless server works on files
 * instead. Each agent can start its own process (stdio), and several processes
 * can share a workspace because writes are atomic and guarded by revisions.
 *
 * @module
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "@/lib/constants";
import type { IHeadlessContext, IRegistrableTool } from "./tool";
import { convertTools } from "./tools/convert";
import { editTools } from "./tools/edit";
import { inspectTools } from "./tools/inspect";
import { renderTools } from "./tools/render";
import { validateTools } from "./tools/validate";

/** Server name reported to clients. */
export const HEADLESS_SERVER_NAME = "blockbench-mcp-headless";

/** Every headless tool, in listing order. */
export const HEADLESS_TOOLS: readonly IRegistrableTool[] = [...inspectTools, ...validateTools, ...editTools, ...convertTools, ...renderTools];

const INSTRUCTIONS = [
  "Edits and checks Blockbench .bbmodel files directly on disk, without the Blockbench app, so several agents can work in parallel.",
  "Workflow: bbmodel_create or bbmodel_info, then bbmodel_edit with batches of operations, then bbmodel_validate (and bbmodel_validate_animations) and bbmodel_contact_sheet to review.",
  "Every read returns a revision; pass it as expected_revision when writing so another agent's edits are never overwritten silently.",
  "Files open in Blockbench do not reload automatically; reopen them after headless edits, and do not edit the same file in both at once.",
].join(" ");

/**
 * Creates a server with every headless tool registered.
 *
 * @param makeContext - Receives the server so the context can read the connected client's name.
 */
export function createHeadlessServer(makeContext: (server: McpServer) => IHeadlessContext): McpServer {
  const server = new McpServer({ name: HEADLESS_SERVER_NAME, version: VERSION }, { instructions: INSTRUCTIONS, capabilities: { tools: {} } });
  const context = makeContext(server);
  HEADLESS_TOOLS.forEach((tool) => tool.register(server, context));
  return server;
}
