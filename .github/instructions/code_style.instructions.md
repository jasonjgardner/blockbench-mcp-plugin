---
applyTo: '**/*.ts'
---

The code is written in TypeScript and follows a consistent style. It uses modern JavaScript features and adheres to best practices for readability and maintainability.

- Use `const` for constants and `let` for variables that may change.
- Use `async/await` for asynchronous operations, and handle errors with `try/catch`.
- Avoid using `if/else` statements for flow control; prefer early returns to reduce nesting.
- Never use `any` type; always specify a more specific type.
- Prefer TypeScript interfaces over types for defining object shapes.
- Never implement placeholder functions, always provide a complete implementation.

This project uses Bun to compile the code into JavaScript for Blockbench to execute in its Electron Node.js environment. The plugin utilizes FastMCP for handling the MCP protocol in TypeScript.

When adding Blockbench-related features, reference the Blockbench source code on GitHub to find missing types or understand how to interact with Blockbench's API or FastMCP's API. You can also reference the existing Blockbench plugins in the Blockbench Plugin Repository.

#githubRepo JannisX11/blockbench-plugins
#githubRepo JannisX11/blockbench
#githubRepo punkpeye/fastmcp

Blockbench TypeScript support is incomplete, so some workarounds are necessary:
- Use TypeScript ignore or expect error comments (`// @ts-ignore`) to bypass missing types.