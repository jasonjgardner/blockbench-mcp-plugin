# Blockbench MCP identity mark test

Date: 2026-09-12. Live application: Blockbench 5.1.6; plugin: 1.7.0 loaded from this repository's `dist/mcp.js`.

The requested reference is the official Model Context Protocol symbol, confirmed by the user. Geometry reference: [official favicon.svg](https://github.com/modelcontextprotocol/docs/blob/573dc60c2e7aab2605b29d0bf27194aa7b02e4fb/favicon.svg). The recreation uses rounded, extruded ribbons with an ivory finish. It is a test model, not an official brand asset.

## Reproduced problems

| Problem | Evidence before fix | Resolution / verification |
| --- | --- | --- |
| `place_mesh` ignored transforms | Requested position `[5,7,2]`, rotation `[0,0,30]`, scale `[2,2,1]`; project export contained origin/rotation zero and unscaled vertices. | Fixed; exported origin, rotation and scaled vertices verified live. |
| Custom mesh topology inaccessible in creation | Tool accepted vertices only and returned a sentence with UUID. Building curves required discovering random vertex keys and creating individual faces. | Added optional indexed faces and ordered vertex/face key mappings. Live logo uses this API. |
| Mesh undo left orphan elements | Undo reported success; root group children fell to zero but `get_project_info` still counted one mesh. | Fixed for mesh/sphere/cylinder creation. Live single and three-mesh batch undo/redo succeed; sphere covered by regression tests. |
| Cylinder normals pointed inward | Live side normal dotted with center was negative; top normal `[0,-1,0]`, bottom `[0,1,0]`. | Fixed; every exported cylinder face has an outward normal. |
| Mesh selection was not persisted | Tool reported 3 selected vertices; `Project.mesh_selection` was `{}` and `getSelectedVertices()` returned `[]`. | Fixed selection storage and lifecycle ordering. Installed 5.1.6 clears component selections when selecting the object, unlike the newer local source. Live select→move now changes vertices; add-selection has regression coverage. |
| Cross-field schema validation was skipped | `create_texture` with `fill_color` and no `layer_name` succeeded, despite its required-field refinement. Independent width/height validation did work. | Full original Zod parser is retained for initial and session registration. Live invalid request leaves no texture; SDK tests cover async refinements, transforms exactly once, and unknown-key policies. |
| Texture undo retained created texture | Undo reported `Agent created texture`; `list_textures` still listed the new texture. | Fixed final snapshot to include the created texture. Live undo/redo and blank/filled/imported regression cases pass. |
| Tool annotations omitted on registration | Source audit found both registration paths omit declared read-only/destructive/open-world hints. | Fixed both paths, including idempotency hints. Verified through SDK tests and live discovery. |
| Mesh creation did not apply the supplied texture | Screenshots showed cyan fallback surfaces; exported faces lacked texture references. `Mesh.applyTexture(texture)` only affects selected faces. | Creation now explicitly applies the texture to every face; verified through regression tests, export and visual inspection. |

## Environment observations

- The existing empty Generic Model was left in its tab; testing used a separate project.
- `prompts/manifest.json` was already modified before this work.
- Building regenerated its timestamp; prompt contents remain unchanged relative to the checked-in manifest.
- The web reader rejected SVG content type; a read-only download of the official SVG succeeded through the shell with network authorization.
- Test requests with 4×4 texture dimensions were correctly rejected; the documented minimum is 16×16.
- `package.json` initially had a placeholder failing test command and no automated tests.
- Reloading the development plugin expired the attached connector's session with HTTP 404. A fresh SDK connection succeeded; the repeatable smoke script connects afresh on every run. This is a reconnect requirement, not a continuing server failure.
- Bun printed ancestor-directory `EPERM` scan diagnostics under the filesystem sandbox while tests, build and docs generation still completed successfully.
- Diagnostic eval probes encountered an unavailable canvas helper and a circular MeshFace object. Inspection used the documented canvas property and codec export instead; these were probe mistakes, not additional plugin defects.

## Validation

- Production bundle rebuilt and loaded into the live application; API docs regenerated (109 tools, 6 prompts, 12 resources in the documentation manifest).
- `bun test`: **31 tests pass, 162 assertions, zero failures**.
- `bun run test:live`: **36 live checks pass**, recorded locally in `artifacts/mcp-identity/smoke-results.json`. This includes actual HTTP discovery, resource read, input rejection with unchanged state, texture and mesh undo/redo, indexed topology, transforms, selection, cylinder normals, screenshots and full project export.
- Artifact geometry: 3 closed ribbon meshes, 668 vertices and 752 triangle/quad faces. Each ribbon has two incident faces per edge. The two upper strokes touch/overlap at the shared join; they remain editable separate meshes, not a Boolean-unioned solid.
- Exports: `mcp-identity.bbmodel`, `front.png`, and `perspective.png` in `artifacts/mcp-identity/`. These generated files are ignored by Git; run `bun run test:live` against the development plugin to reproduce them. This report and the test scripts are versioned.
- Full TypeScript checking remains failing on existing repository debt: the initial captured run reported 168 diagnostics; the later run reported 146. These snapshots include edits in progress and should not be interpreted as a clean baseline comparison. No diagnostics appeared in the new test files or live harness. Broad animation, UV, Hytale, prompt and UI typing cleanup is outside this test's scope.
- This validates a modeling workflow and the corrected paths, not every behavior of all 109 tools. Animation, PBR/Hytale workflows and external export codecs were not exercised live.

## Compatibility notes

`place_mesh` still accepts vertex-only inputs. Position is the mesh origin/pivot, vertices are local, rotation is in degrees, and scale is baked into vertices. New optional faces use zero-based vertex indices in perimeter order. Its text JSON response changes from an array of human-readable sentences to `{ "meshes": [{ "name", "uuid", "vertex_keys", "face_keys" }] }`; clients parsing the old response must adapt. Invalid group/texture references now fail before mutations instead of silently using the root group. Creating untextured meshes is supported as documented.

## Suggested MCP project improvements

1. **Make the live smoke workflow part of release checks.** Keep version-specific Blockbench behavior in regression doubles and run a real desktop test before publishing. Tests that only mock happy-path APIs missed the selection cleanup and texture-face scope.
2. **Expose capability and geometry inspection.** Implemented in the follow-up: `get_capabilities` reports versions, format declarations and optional tool registration state; `get_mesh_info` exposes paginated existing vertex/face keys, local normals/bounds and stored texture references. See [inspection tools](../inspection-tools.md).
3. **Correct project skill examples.** Recommend `free` for built-in mesh work; `generic` is not the built-in format ID, and `modded_entity`/`optifine_entity` do not support meshes. Replace invented keys like `top_face` with returned identifiers, and document indexed topology and reconnect after plugin reload.
4. **Audit remaining UI-action wrappers and undo boundaries.** Source review identified `extrude_mesh`/`subdivide_mesh` forwarding parameters to UI handlers that may not consume them, texture-group validation occurring after creation, and PBR material creation using similar incomplete undo tracking. These are follow-up candidates, not live-verified fixes in this change.
5. **Make screenshots easier to target and frame.** Add orthographic zoom/fit-to-model controls. Review named-project capture: its search combines the requested project and active-project fallback, so the active project can win incorrectly.
6. **Reduce typecheck debt and document output contracts.** Keep stable machine-readable result shapes, propagate MCP errors consistently, and retire the remaining legacy SDK typings so a clean typecheck can become a release gate.
