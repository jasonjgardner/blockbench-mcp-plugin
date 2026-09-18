# Desktop release and wrapper audit

Date: 2026-09-12. Follow-up to the [MCP identity test](2026-09-12-mcp-identity-test.md).

## Findings and changes

| Finding | Change |
| --- | --- |
| Releases could publish without a desktop test of the candidate source. | Tag deployments require `releases/desktop-smoke.json`. The local runner checks the loaded source build ID, runs all suites, and records environment and assertions. CI rejects stale or incomplete evidence. |
| Extrusion distance and subdivision cuts were passed to UI handlers that did not consume them; native operations could affect other selected meshes. | Direct operations target one mesh and honor their arguments, return geometry keys, and own one undo transaction. Extrusion supports face regions; subdivision splits selected triangles/quads into a grid. |
| Component deletion referenced an absent UI action. | Direct deletion removes selected components and incident faces, with explicit orphan-vertex behavior. |
| The point-list knife wrapper could report success without making cuts. | It now returns an actionable unsupported error before editing. A proper topology-aware knife API remains future work. |
| UV wrappers depended on global UI selection or nested native undo transactions. | Explicit mesh/face targeting, input validation, one undo entry, per-face planar unwrap, and UV rotation without atlas clamping. |
| Projected faces shared UV coordinate arrays. Desktop undo changed a neighboring face's UV seam while restoring arrays in place. | Copy UV tuples per face; regression and desktop tests verify restoration across adjacent faces. |
| Generic action/eval wrappers created empty or nested undo entries; action failures and unrelated dialogs were mishandled. | Native actions own undo, unavailable/non-action IDs fail, and only newly opened dialogs can be confirmed. `risky_eval` returns MCP errors and leaves undo management to evaluated code. |
| Native paint start/stop handlers owned undo while wrappers opened another transaction. | Keep a single transaction boundary for each native paint operation and pair disconnected stroke starts/stops correctly. |
| Native paint wrappers supplied an empty face UV map, creating an empty paint region and reporting success without changing pixels. | Texture-coordinate strokes use the native unrestricted texture path, with actual bitmap checks in the desktop suite. |
| PBR group edits validated references after mutation and omitted created, displaced, or moved entities from undo snapshots. | Prevalidated channel plans include source/destination groups and textures; creation, reassignment, configuration, and import commit atomically with rollback. |
| Desktop undo restored material configuration but left cached viewport roughness unchanged. A live probe restored MER roughness 40 while the cached material still used 80/255. | Refresh affected material previews after undo/redo, with listener cleanup when unloading the plugin. |
| Native uniform-color preview used an unsupported Three.js color setter argument and the wrong alpha index. | Normalize uniform RGB and alpha when refreshing MCP material edits and undo results. |
| Native texture-set import could silently fail or replace existing file-backed textures before the wrapper's undo snapshot. | Validate the texture-set and decode dependencies before editing; return the resulting material UUID. |
| Certain channel combinations make the host preview fail or are ambiguous. | Reject duplicate channels, normal+height, and MER maps without a color map, including when moving a source material's color texture away. |
| Project skills used unsupported format IDs, invented geometry keys, and non-schema PBR arguments. | Five project skills now use capability discovery, returned IDs, valid schemas and the audited operation constraints. |

## Release workflow

Run `bun run build`, reload `dist/mcp.js` in Blockbench desktop, then run `bun run release:smoke`. Commit the passing record with the source before tagging. [Contributor instructions](../../CONTRIBUTING.md#required-desktop-checks-before-releases) describe the source fingerprint, failure behavior and evidence limits. Raw generated models, screenshots and logs stay ignored under `artifacts/`; the compact release record is versioned.

## Verification

- Production plugin **1.8.0** loaded in **Blockbench 5.1.6 on Windows**. The release runner used Bun 1.3.8; direct regression checks also ran successfully with Bun 1.3.14.
- `bun run release:smoke`: **111 regression tests pass, 758 assertions, zero failures**; **210 desktop checks pass** (61 action/paint, 75 PBR, 36 identity, 38 inspection).
- `bun run release:verify v1.8.0` accepts the [passing desktop record](../../releases/desktop-smoke.json). Its source build ID is `b688f34a1bdd432efaceb5c6daf4fb3fa0ec4520ca725113876dfbd68f85f796`.
- Production bundle and API documentation build successfully (111 documented tools). All five edited project skills pass the skill validator; both repositories pass `git diff --check`.
- The identity project was recreated, exported, and visually inspected. It remains open in Blockbench, with generated outputs under `artifacts/mcp-identity/`.
- Regression tests reject stale source/version/tag evidence, development bundles, non-desktop environments, failed/incomplete suites, and invalid timestamps. A failed local run replaces any earlier passing record. No release was published during this work.
- Full repository typechecking still fails on existing typing debt (103 diagnostics in the captured run). The new release helpers, material preview helper, and test files had no diagnostics in that run. Broad legacy painting, animation, Hytale and SDK typing cleanup remains separate work.
- Test-harness corrections: compare exported geometry independently of JSON object-key order while preserving array order; update the isolated texture host fixture for the real project/image lifecycle. These retain the actual undo assertions.

## Compatibility and follow-ups

- Extrusion accepts face selections. Grid subdivision replaces the old loop-cut dispatch; clients should consume its returned vertex/face keys.
- Unwrap is per-face planar projection and does not pack UV islands. The knife point-list interface is explicitly unsupported.
- Native fill supports exact color matching; nonzero tolerance now fails before editing. Connected brush strokes interpolate between points. Disconnected eraser strokes each have their own undo entry.
- PBR texture replacement detaches displaced textures while preserving their channel. Ordinary groups containing multiple color textures must use `is_material: false`.
- `risky_eval` no longer supplies an automatic undo transaction. Mutating scripts must initialize, finish and roll back appropriate host undo aspects themselves.
- The local record covers the tested Blockbench version/platform. Additional desktop versions and operating systems would extend release coverage.
- Remaining improvements: topology-aware knife operations, UV island packing, uniform structured output contracts, and reducing existing TypeScript debt so full typechecking can become a release gate.
