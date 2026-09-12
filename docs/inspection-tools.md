# Capability discovery and mesh inspection

Both tools are read-only and return the same JSON object in `structuredContent` and the text content block. They do not select a project, select geometry, or create an undo entry.

## Discover the environment

Call `get_capabilities` with `{}` before planning a modeling operation. The response includes:

- `blockbench`: application version, desktop/web environment, platform, and mobile flag.
- `plugin.version`: the version embedded in the running plugin bundle.
- `project`: active project identifier, name, format ID and element counts, or `null` when no project is open.
- `format`: active format with detailed feature flags, or `null` without an active project.
- `formats`: registered format IDs/names and compact `supported_features` lists.

Inspect another format without switching projects:

```json
{"format_id":"free","include_tools":true}
```

`format` now describes the requested format; `project` still describes the active project. `free` is Blockbench's Generic Model format. Use actual IDs from the returned registry for other built-in or plugin formats.

Detailed feature values are `true`, `false`, or `null` when the host does not declare a boolean value. In the compact format list, absent flags are false unless listed in `unknown_features`. The optional `tools` list reports names, stability status, and enabled state. These are registration states: a tool may also need a compatible format, editor mode, project, or selection.

## Inspect existing mesh geometry

Call `get_mesh_info` with a UUID/name from `list_outline` or `find_elements_by_criteria`:

```json
{"mesh_id":"MCP lower link","limit":50,"include_uv":true}
```

Omit `mesh_id` to inspect the first selected mesh. An explicit ID is useful when preserving a user's selection. Unknown IDs and missing selections produce an error with guidance.

The response includes `uuid`, `name`, `origin`, `rotation`, `parent`, `totals`, `bounds.local`, and `selection` counts. Vertices, bounds, and face normals are **mesh-local**: origin, rotation, and parent transforms are not applied. Empty meshes have `bounds.local: null`; a root mesh has `parent: null`. Normal vectors are normalized, with `[0,0,0]` for degenerate faces.

The optional `vertices` and `faces` pages each have:

```json
{"total":200,"offset":0,"limit":50,"next_offset":50,"truncated":true,"items":[]}
```

The example omits items for brevity. Vertex items contain `{key, position, selected}`. Face items contain `{key, vertices, normal, selected, texture}`; `vertices` is the perimeter ordering of actual runtime vertex keys. Request `include_uv: true` to add each face's UV map keyed by vertex ID, in Blockbench texture units.

Continue each page independently using its `next_offset`:

```json
{"mesh_id":"MCP lower link","vertex_offset":50,"face_offset":50,"limit":50}
```

Keys are sorted lexicographically for repeatable pagination. `limit` defaults to 100 and is capped at 500 per list. A `next_offset` of `null` means the end was reached. Avoid geometry edits between pages because edits may change ordering and totals. For metadata only:

```json
{"mesh_id":"MCP lower link","include_vertices":false,"include_faces":false}
```

## Texture references

Inspection reports the face's stored assignment, not a format-specific fallback material:

| `texture.status` | Meaning |
| --- | --- |
| `resolved` | The UUID resolves to a project texture; `uuid` and `name` are included. |
| `missing` | The stored UUID does not resolve; `reference` preserves it. |
| `unassigned` | Stored `false`, normally displayed using a fallback/checkerboard material. |
| `disabled` | Stored `null`. |
| `unset` | No stored reference; normalized to `reference: null`. |

The tool does not invoke texture-resolution hooks supplied by other plugins.

## Verification

`bun test` covers no-project discovery, format support, tool availability, pagination, normals, texture references, and read-only behavior. After rebuilding and reloading the plugin, reconnect clients and run `bun run test:inspection:live` against an open mesh project. The live test verifies discovery and inspection without changing the active project, selection, or undo history.

Verified on Blockbench 5.1.6: 48 regression tests and 37 read-only live checks pass. The production bundle and generated API documentation build successfully. Full repository typechecking still reports existing errors outside these new tools.
