# Tool availability and project resources

The server advertises `tools.listChanged: true`. Each tool's optional `condition`
is evaluated by Blockbench's native `Condition` function. The MCP list and plugin
test panel update when the active project, format, mode, selection, or other
required state changes. Existing client sessions receive
`notifications/tools/list_changed`; unavailable tools also reject stale calls.
Tools accepting explicit target IDs need not require those targets to be selected.
An explicit disabled registration remains disabled even when its condition passes.

Use `list_modes` to inspect the current editor tab and each registered mode's
native availability. Use `set_mode` to enter a supported mode before work that
needs that tab:

```json
{ "mode_id": "animate" }
```

The Animate tab's ID is `animate`; other common IDs are `edit`, `paint`, and
`display`. Plugin-added IDs appear automatically. Both navigation tools remain
discoverable across mode changes. Switching respects Blockbench's conditions and
runs its normal mode hooks, and selecting the current mode does nothing. A format
without animation support cannot enter Animate through this tool. After switching,
refresh `tools/list` to discover newly available tools. Use `set_camera_angle` for
camera views and `enter_display_mode` when you also need a display slot/reference.

### AI Scratchpad mode

With **Settings** > **General** > **Enable AI Scratchpad** on, `list_modes` also
reports `ai_scratchpad` whenever a project with edit-mode support is open. Entering
it through `set_mode` relaxes the active format's geometry guardrails (cube size
limiter and coordinate limits, single-axis rotation limit and 22.5° snapping,
integer sizes) until another mode is selected, which restores the values captured
on entry. Leaving the mode does not clamp geometry that no longer fits; use
`inspect_block_bounds` and `slice_cubes_to_block_grid` to conform it. Tools gated
to `edit` (the knife tools and `set_cube_uv`) stay available in the scratchpad.

### AI usage disclosure

With **Disclose AI Usage** on (the default), the first tool call that finishes an
undoable edit or creates a project stamps two native project properties, saved in
the `.bbmodel` and shown in the Project settings dialog: `ai_used` (`true`) and
`ai_agents`, the comma-separated client names from each session's `initialize`
request (for example `Claude Code, Cline`). Read-only tools, camera moves, and
mode switches never stamp a project; untouched files are written unchanged.

## Views: sharing or not sharing the viewport

`capture_screenshot` and `set_camera_angle` accept a `view`. The default,
`"active"`, is the viewport the user last interacted with, so moving its camera
changes what they see (and clears any side-view lock they had). To inspect the
model without moving the user's camera, create a plugin-owned offscreen view and
target it instead:

```json
{ "id": "inspect", "width": 1024, "height": 768 }
```

`create_offscreen_view` builds a Blockbench `Preview` that never joins the DOM.
It shares the live scene but owns its camera, renderer, and canvas, and starts
where the user's camera is unless `copy_view` is `"none"`. Then call
`set_camera_angle` or `capture_screenshot` with `"view": "inspect"`.
`set_camera_angle` also accepts `zoom`, `fov`, and `locked_angle` (`top`,
`north`, ...) and returns the applied camera state next to the frame. The
camera an agent gives an offscreen view is remembered and restored before each
render, because Blockbench re-targets every preview when a project is selected.

`list_views` reports every target with its rendered size and camera state.
Connected viewports keep their Blockbench IDs (`main`, `split_screen_1`, ...)
and can be addressed by those IDs too; `"active"` and `"none"` are reserved and
cannot name an offscreen view. `resize_offscreen_view` changes an offscreen
view's pixel size. Each offscreen view holds a WebGL context, so at most four
exist at once; `create_offscreen_view` returns an explanatory error at the cap.
Delete views with `delete_offscreen_view` when finished; the plugin disposes any
that remain when it unloads.

Resource discovery advertises `resources.listChanged: true` and emits
`notifications/resources/list_changed` when the listed metadata changes. Clients
can use `resources/list` to find the active project's live file:

```text
blockbench://project/{uuid}.bbmodel
```

Read that URI with `resources/read` to receive `application/json` `.bbmodel`
content, including unsaved edits and embedded textures. The URI stays stable when
the project is renamed. Only the active project's file is readable: Blockbench's
native project codec depends on the active editor globals. Select another tab
and list resources again to read that project. Reading does not switch tabs or
save a file to disk. The existing `projects://{id}` resources remain metadata
for open projects. Reference model URIs use the valid `reference-models://`
scheme; underscores are not permitted in URI schemes.

Project inspection/creation and export results include a `resource_link` to the
live project file. Export defaults preserve the JSON `content` payload. Request
an embedded file when you want a typed snapshot instead:

```json
{
  "codec_id": "project",
  "result_format": "embedded",
  "max_content_length": 2000000
}
```

Complete exports within the limit return an MCP `resource` content block with
text or base64 blob data, a filename, and MIME type; metadata reports
`resource_uri` and sets `content` to null. An export exceeding the limit returns
an explicitly truncated preview, never an incomplete embedded file. Embedded
snapshot URIs identify the returned content; they are not persistent
`resources/read` links. The separate live project link remains available while
its project is active.

[Blockbench web URL parameters](https://blockbench.net/wiki/docs/url-parameters/)
accept the complete file in `loaddata`, or a shared-service model ID in `m`.
They cannot load a local MCP resource URI directly. The plugin uses MCP resource
links and embedded files; it does not construct full-project query strings or
upload models to the sharing service.

Resource failures follow the
[MCP resource error rules](https://modelcontextprotocol.io/specification/2026-07-28/server/resources#error-handling):
missing or unavailable resources return JSON-RPC `-32602`, unexpected read/list
failures return `-32603`, and named missing resources never return an empty
`contents` array. A valid empty collection still has a real JSON content entry.
Tool execution failures remain MCP tool results with `isError: true`.

## Manual verification

1. Build and load `dist/mcp.js` in desktop Blockbench. Connect an MCP client and
   verify both advertised `listChanged` capabilities.
2. With no project open, list tools. Open a Generic Model, then a format without
   mesh support. Check tool list notifications and mesh tool availability in
   the same client session. Repeat with two clients connected.
3. Change selection/mode or load an optional plugin. Confirm relevant tools
   update, and a stale call to a disabled tool fails without editing the model.
4. Read the listed `.bbmodel` resource after an unsaved edit. Verify the edit and
   texture data are present. Switch projects and confirm the old URI returns
   `-32602` until that project is selected again.
5. Export with `result_format: "embedded"`, and inspect the resource's MIME type
   and contents. Repeat with a low limit and confirm no partial file is embedded.
6. Rename the project or add/remove a texture, and confirm resource list change
   notifications. Reload/unload the plugin and confirm listeners stop cleanly.
