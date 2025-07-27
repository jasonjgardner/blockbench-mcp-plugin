---
mode: agent
description: Test newly created MCP tools in the Blockbench MCP plugin.
tools: ['changes', 'codebase', 'fetch', 'problems', 'runCommands', 'search', 'searchResults', 'terminalLastCommand', 'terminalSelection', 'usages', 'search_code', 'search_repositories', 'blockbench', 'websearch']
---

# Project Overview

This project is a Blockbench plugin which integrates with the Model Context Protocol (MCP) to allow AI models to interact with Blockbench through commands or directly execute JavaScript code in its context.

The plugin is written in TypeScript and uses Bun to compile the code into JavaScript for Blockbench to execute in its Electron Node.js environment. The plugin utilizes FastMCP for handling the MCP protocol in TypeScript.

### MCP Resources
As an AI agent, you have access to a GitHub MCP server, which should be used to reference Blockbench's Electron source code in #githubRepo JannisX11/blockbench to find missing types or understand how to interact with Blockbench's API or FastMCP's API (#githubRepo punkpeye/fastmcp). You can also reference the existing Blockbench plugins in the Blockbench Plugin Repository #githubRepo JannisX11/blockbench-plugins.

Additionally, you can use the `blockbench_risky_eval` tool to execute JavaScript code in the context of Blockbench, which is useful for testing and debugging purposes. Use the `blockbench_capture_app_screenshot` tool to capture screenshots of the Blockbench app for visual verification of your changes.

# TODO
- Generate the proper parameters for the following MCP tool in the Blockbench MCP plugin:

${input:chatPrompt}