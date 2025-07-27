---
mode: agent
description: This is a Blockbench plugin that integrates with the Model Context Protocol (MCP) to allow AI models to interact with Blockbench (JannisX11/blockbench) through commands or directly execute JavaScript code in its context.
tools: ['githubRepo', 'get_commit', 'get_file_contents', 'list_branches', 'search_code', 'search_repositories', 'blockbench']
---

# Project Overview

This project is a Blockbench plugin which integrates with the Model Context Protocol (MCP) to allow AI models to interact with Blockbench through commands or directly execute JavaScript code in its context.

The plugin is written in TypeScript and uses Bun to compile the code into JavaScript for Blockbench to execute in its Electron Node.js environment. The plugin utilizes FastMCP for handling the MCP protocol in TypeScript.

### MCP Resources
As an AI agent, you have access to a GitHub MCP server, which should be used to reference Blockbench's Electron source code in #githubRepo JannisX11/blockbench to find missing types or understand how to interact with Blockbench's API or FastMCP's API (#githubRepo punkpeye/fastmcp). You can also reference the existing Blockbench plugins in the Blockbench Plugin Repository #githubRepo JannisX11/blockbench-plugins.

Additionally, you can use the `blockbench_risky_eval` tool to execute JavaScript code in the context of Blockbench, which is useful for testing and debugging purposes.

# TODO
- Add a new MCP tool to the plugin based on the following prompt:

${input:chatPrompt}

## Note
- If any of this functionality already exist in the project, inspect it for enhancements or bugs. Suggest changes if necessarry but confirm before applying any.
- Avoid cutting any corners and ensure the task is done well-enough to be used in production.
- If you are unsure about the implementation, ask for clarification or additional context.
- Document your code thoroughly to aid future maintenance and collaboration.

Finally, run `bun run compile` to compile the TypeScript code into JavaScript for Blockbench to execute.