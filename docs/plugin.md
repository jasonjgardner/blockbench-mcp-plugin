# Extending Blockbench MCP from another plugin

Any Blockbench plugin can add its own MCP tools. The MCP plugin installs a global `MCP` API when it loads and drains an `MCP_QUEUE` array, so registration works whichever plugin Blockbench loads first. Nothing is bundled or imported: your plugin stays independent of this one.

> [!WARNING]
> Plugins published to the official Blockbench plugin repository (the in-app plugin store) are not allowed to use AI features. Per Blockbench's maintainer, a plugin that registers MCP tools will not be accepted there, so distribute it another way, for example by URL or from your own repository.

## Setup

1. Copy [`blockbench-mcp-api.d.ts`](https://jasonjgardner.github.io/blockbench-mcp-plugin/blockbench-mcp-api.d.ts) (also shipped in `dist/` and with each release) into your plugin source for types. Its schema types come from `zod`, so add it as a dev dependency: `bun add -d zod`. At runtime use `mcp.z`, MCP's own instance, and never bundle zod.
2. In your plugin's `onload`, queue a setup entry:

```ts
onload() {
  (globalThis.MCP_QUEUE ??= []).push({
    plugin: "my_plugin",
    setup(mcp) {
      mcp.registerTool({
        name: "my_plugin_bake",
        description: "Bakes the selected groups into keyframes of a new animation.",
        parameters: mcp.z.object({
          fps: mcp.z.number().int().min(1).max(120).default(24).describe("Keyframes per second."),
        }),
        condition: { project: true, modes: ["animate"] },
        annotations: { title: "Bake Selection" },
        execute: ({ fps }) => mcp.createJsonResult(bakeSelection(fps)),
      });
    },
  });
}
```

Tools registered with a `plugin` id are removed when that plugin unloads; `registerTool` also returns a disposer for `onunload`. Connected clients receive `tools/list_changed`, and the MCP panel lists the tool with a badge naming your plugin.

To publish an existing Blockbench `Action` instead, call `mcp.exposeAction("my_action_id")`. The tool follows the action's condition and runs `action.trigger()`; pass `execute` to run something else, for example when the action normally opens a dialog.

## Rules

- Tool names share one namespace with the built-in tools and must match `^[a-zA-Z0-9_-]{1,64}$`. Prefix yours with your plugin id; a clash throws at registration.
- `parameters` must be a Zod object schema built with `mcp.z`.
- Wrap edits in `mcp.runUndoableEdit(aspects, label, edit)` so a failing call reverts cleanly and the write counts toward AI usage disclosure like a built-in tool.
- `condition` uses Blockbench's native rules (`modes`, `formats`, `features`, `project`, `method`), so an unavailable tool is hidden without running your code.
- Return a string for text, or `mcp.createJsonResult({...})` for structured content.
- Reloading the MCP plugin re-runs queued entries. `{ plugin, setup }` entries are dropped when your plugin unloads; a bare function entry should check that your plugin is still loaded before registering.

The [Havok Physics Animations plugin](https://github.com/jasonjgardner/blockbench-plugins) is a complete example; it registers `havok_simulate_physics` this way.
