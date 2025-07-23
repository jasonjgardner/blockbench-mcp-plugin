# Contributing to Blockbench MCP Plugin

## Getting Started

Addition or modification of tools, prompts and resources is welcome. It should be a relatively-familiar process for Blockbench contributor/plugin authors; however, does require TypeScript compilation. [Bun is required for the task.](https://bun.sh/)

### Dev Setup

```sh
bunx @modelcontextprotocol/inspector
```
The Streamable HTTP transport URL defaults to __http://localhost:3000/bb-mcp__

```sh
cd ./src/mcp
bun install
bun run build
```

### Adding Tools

```typescript
// ./src/mcp/server/tools.ts
import { z } from "zod";
import { createTool } from "@/lib/factories";

createTool({
    name: "tool_name",
    description: "Tool description for the AI agent"
    parameters: z.object({
        // Parameters required to execute your tool:
        examples: z.array({
            // Zod schema to collect arguments.
            // Does not have to be 1:1 with Blockbench
        })
    }),
    async execute({ examples }, { reportProgress }) {
        return JSON.stringify(examples.map((example, idx) => {
            reportProgress({
                progress: idx,
                total: examples.length
            });

            // Do something with parameters within current context.
            // Has access to Blockbench, electron, FastMCP, and other API
            // Return stringified results to report to AI agent context.

            return myExampleTransformFunction(example);
        }));
    }
});
```

### Adding Resources

No factory function has been created yet. Refer to [FactMCP's documentation for Resource examples](https://github.com/punkpeye/fastmcp?tab=readme-ov-file#resources).

Add resource-related code to `./src/mcp/server/resources.ts`

### Adding Prompts

No factory function has been created yet. Refer to [FactMCP's documentation for Prompts examples](https://github.com/punkpeye/fastmcp?tab=readme-ov-file#prompts).

Add prompt-related code to `./src/mcp/server/prompts.ts`