/// <reference types="three" />
/// <reference types="blockbench-types" />
import { VERSION } from "@/lib/constants";
import { FastMCP } from "fastmcp";

let serverInstance: FastMCP | null = null;

/**
 * Creates a new FastMCP server instance
 */
export function createServer() {
  return new FastMCP({
    name: "Blockbench MCP",
    version: VERSION,
    instructions: Settings.get("mcp_instructions") || "",
  });
}

/**
 * Gets the current server instance
 */
export function getServer() {
  if (!serverInstance) {
    serverInstance = createServer();
  }
  return serverInstance;
}

/**
 * Replaces the current server instance with a new one
 * @param newServer - The new server instance
 */
export function setServer(newServer: FastMCP) {
  serverInstance = newServer;
}

// Export the default server instance
const server = getServer();
export default server;
