---
mode: agent
---

# Project Overview

This project is a Blockbench plugin which integrates with the Model Context Protocol (MCP) to allow AI models to interact with Blockbench through commands or directly execute JavaScript code in its context.

The plugin is written in TypeScript and uses Bun to compile the code into JavaScript for Blockbench to execute in its Electron Node.js environment. The plugin utilizes FastMCP for handling the MCP protocol in TypeScript.

Blockbench uses Vue.js for its UI; however, SFC (Single File Components) are not supported by Blockbench.

## Code Style
The code is written in TypeScript and follows a consistent style. It uses modern JavaScript features and adheres to best practices for readability and maintainability.

- Use `const` for constants and `let` for variables that may change.
- Use `async/await` for asynchronous operations, and handle errors with `try/catch`.
- Avoid using `if/else` statements for flow control; prefer early returns to reduce nesting.
- Never use `any` type; always specify a more specific type.
- Prefer TypeScript interfaces over types for defining object shapes.

### Blockbench and TypeScript
Blockbench TypeScript support is incomplete, so some workarounds are necessary:
- Use TypeScript ignore or expect error comments (`// @ts-ignore`) to bypass missing types.

### MCP Resources
As an AI agent, you have access to a GitHub MCP server, which can be used to reference Blockbench's Electron source code to find missing types or understand how to interact with Blockbench's API or FastMCP's API.

# TODO
- [ ] 