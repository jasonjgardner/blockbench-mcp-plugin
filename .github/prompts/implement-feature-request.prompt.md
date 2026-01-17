---
mode: agent
description: Implements an MCP feature request from a GitHub issue using the standardized feature request template.
tools: ['githubRepo', 'get_file_contents', 'search_code', 'blockbench']
---

# Implement MCP Feature Request

You are implementing a new MCP feature based on a GitHub issue created using the `mcp-feature-request.yml` template. Parse the issue content below and implement the feature according to the specification.

## Issue Content

${input:issueContent}

---

## Implementation Instructions

### 1. Parse the Feature Request

Extract the following from the issue:

- **Feature Type**: Tool, Resource, or Prompt
- **Feature Name**: The snake_case identifier
- **Description**: What the feature does
- **Domain**: Which tool file to add this to (animation.ts, texture.ts, mesh.ts, etc.)
- **Parameters**: Input schema with types and validation
- **Output**: Expected return value format
- **Annotations**: readOnlyHint, destructiveHint based on the answers

### 2. Determine the Target File

Based on the Domain field, add the feature to the appropriate file:

| Domain | File |
|--------|------|
| Animation | `server/tools/animation.ts` |
| Camera | `server/tools/camera.ts` |
| Cubes | `server/tools/cubes.ts` |
| Elements | `server/tools/element.ts` |
| Import/Export | `server/tools/import.ts` |
| Mesh | `server/tools/mesh.ts` |
| Paint | `server/tools/paint.ts` |
| Project | `server/tools/project.ts` |
| Texture | `server/tools/texture.ts` |
| UI | `server/tools/ui.ts` |
| UV | `server/tools/uv.ts` |

### 3. Implement the Feature

For **Tools**, use this pattern:

```typescript
createTool(
  "feature_name",
  {
    description: "Description from issue",
    annotations: {
      title: "Human Readable Title",
      readOnlyHint: true/false,  // Based on "Is this read-only?" answer
      destructiveHint: true/false,  // Based on "Is this destructive?" answer
    },
    parameters: z.object({
      // Convert parameters from issue to Zod schema
      // string -> z.string()
      // number -> z.number()
      // boolean -> z.boolean()
      // array[3] -> z.array(z.number()).length(3)
      // enum[a,b,c] -> z.enum(["a", "b", "c"])
      // Add .optional() for optional params
      // Add .default(value) for defaults
      // Add .describe("...") for each parameter
    }),
    async execute({ /* destructured params */ }) {
      // Implement using Blockbench API
      // Use Undo.initEdit/finishEdit for modifications
      // Use Canvas.updateAll() after visual changes
      // Return appropriate output format
    },
  },
  STATUS_EXPERIMENTAL  // Use STATUS_STABLE after testing
);
```

For **Resources**, use `createResource()` pattern.

For **Prompts**, use `createPrompt()` pattern.

### 4. Error Handling

Based on the "Edge Cases & Error Handling" section:

- Use helper functions like `findTextureOrThrow()`, `findElementOrThrow()` for lookups
- Throw descriptive errors with actionable suggestions
- Validate inputs before performing operations

### 5. Testing

After implementation:

1. Run `bun run build` to verify compilation
2. Use `blockbench_risky_eval` to test the feature in Blockbench
3. Verify the output matches the expected format from the issue

### 6. Reference Blockbench Source

If the "Relevant Blockbench API" section is empty or incomplete:

- Search `JannisX11/blockbench` for relevant code
- Check `blockbench-types` for type definitions
- Reference similar existing tools in this codebase

---

## Checklist

- [ ] Feature name matches the issue specification
- [ ] All parameters are implemented with correct types
- [ ] Required/optional status matches the issue
- [ ] Output format matches the expected output
- [ ] Error cases from the issue are handled
- [ ] Undo support added for destructive operations
- [ ] Build succeeds without errors
- [ ] Related features mentioned in issue are considered
