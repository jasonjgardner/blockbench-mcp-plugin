/// <reference types="three" />
/// <reference types="blockbench-types" />
import { VERSION } from "@/lib/constants";
import { FastMCP } from "fastmcp";

const server = new FastMCP({
  name: "Blockbench MCP",
  version: VERSION,
  instructions: Settings.get("mcp_instructions") || "",
});

export default server;
