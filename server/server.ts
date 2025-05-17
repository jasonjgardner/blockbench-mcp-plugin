/// <reference types="three" />
/// <reference path="../../../types/index.d.ts" />
import { FastMCP } from "fastmcp";

const server = new FastMCP({
  name: "Blockbench MCP",
  version: "1.0.0",
  instructions: Settings.get("mcp_instructions") || "",
});

export default server;
