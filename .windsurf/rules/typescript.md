---
trigger: glob
globs: **/*.ts
---

# Code Style

This project uses Bun.

- Use `const` for constants and `let` for variables that may change.
- Use `async/await` for asynchronous operations, and handle errors with `try/catch`.
- Avoid using `if/else` statements for flow control; prefer early returns to reduce nesting.
- Never use `any` type; always specify a more specific type.
- Prefer TypeScript interfaces over types for defining object shapes.
- Never implement placeholder functions, always provide a complete implementation.

## When using Zod

Create reusable schemas and store them in `lib/zodObjects.ts`

## Blockbench Types

Blockbench is poorly-typed and several lint errors are to be expected. Reference the Blockbench codebase for proper types and usage examples.
It is OK to supress errors.