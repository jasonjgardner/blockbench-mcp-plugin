/// <reference types="three" />
/// <reference types="blockbench-types" />
import { FastMCP } from "fastmcp";

const server = new FastMCP({
  name: "Blockbench MCP",
  version: "1.0.0",
  instructions: Settings.get("mcp_instructions") || "",
});

export default server;
