# Texturing a Go Kart: Pitfalls and MCP Server Improvement Recommendations

Session notes from an attempt to texture an existing Bedrock-format Go Kart
model using only `mcp__blockbench__*` tools. Format: `bedrock`, 162 cubes
across nested groups under `dalibustudios_vehicles > main > { body,
front_axle, rear_axle, steering_wheel_no }`.

## Summary of Pitfalls

### P1 — `list_outline` is a flat list with no hierarchy or type info

**Observed**: The returned array is 162 items of `{ name, uuid }` only. 39
cubes all named `"body"`, plus a group named `"body"`, plus many ambiguously
named `"bone*"`, `"wi*"`, `"front*"` entries — no way to tell parents,
children, or cube-vs-group from the response.

**Impact**: First call wasted context and gave no actionable layout. Had to
fall back to `find_elements_by_criteria type=group` to get a real hierarchy.

**Recommendation**: Either return a tree (groups with `children: []` arrays)
or include `type` + `parent` fields on every row. The current response is
effectively a name/uuid dump with neither the hierarchy of `get_undo_stack`
nor the filtering of `find_elements_by_criteria` — consider deprecating it
in favor of making `find_elements_by_criteria` the first-class discovery
tool.

### P2 — `risky_eval` is denied by default, even for read-only introspection

**Observed**: A purely read-only `JSON.stringify({ format, project, ... })`
got permission-denied with a generic "arbitrary JavaScript" rationale, even
though it was inspecting `Format.id`, `Project.name`, counts of `Texture.all`
and `Outliner.elements` — no mutations.

**Impact**: Lost the fastest way to answer "what format is this and what's
in the project?". Had to use `list_export_formats only_current_format=true`
to infer format (via the bedrock codec).

**Recommendation**: Add a dedicated `get_project_info` tool that returns
`{ format.id, name, texture_size, element_counts, root_groups }` — so
agents don't need `risky_eval` for basic orientation.

### P3 — `apply_texture` silently ignores the `id` parameter; operates on current selection

**Most important finding.** Symptoms looked like four separate bugs; they're
all one.

**Observed**: With `apply_texture id="<anything>" texture="kart_body"
applyTo="all"` and NO explicit selection, the tool reported success
("Applied texture kart_body to element with ID <x>") but `filter_by_material
texture="kart_body"` returned 0 matches — nothing was actually assigned.

After `select_all_of_type type=cube parent_group="body"` (68 cubes selected)
followed by the same `apply_texture` call, `filter_by_material` returned all
68 cubes. **The `id` parameter is decorative — the tool applies to whatever
is currently selected.**

**Impact**:
- I applied `kart_wheel` to `front_axle`, then `rear_axle`, then
  `steering_wheel_no` in sequence. Each call preserved the previous
  selection (no deselect between them), so the LAST selection dictated
  whose faces got the texture. Body cubes appeared to get overwritten with
  a dark texture — they didn't; they just still showed the _last applied
  texture visually_ because of the rendering consequence in P5.
- Used `applyTo="blank"` as a workaround; it also didn't respect the `id`.
- Burned 20+ minutes and a checkpoint roll-back on this.

**Recommendation** (pick one or both):
1. **Honor the `id`**: When `id` is provided, resolve it to element(s) —
   group UUID → all descendant cubes, cube UUID → that cube, name match
   with warning if ambiguous — and apply to that scope. Preserve selection
   across the call.
2. **Document + error loudly**: If design intent is "selection-driven",
   rename the param to `scope_hint` or require it to match the current
   selection; reject mismatches instead of silently ignoring.

Same root cause likely affects: `draw_shape_tool`, `paint_fill_tool`,
`paint_with_brush`, `gradient_tool`, `eraser_tool` — any `texture_id`
parameter is suspected to be decorative unless that texture is the
_panel-active_ texture.

### P4 — `draw_shape_tool` / paint tools ignore `texture_id` too

**Observed**: Called `draw_shape_tool texture_id="kart_body"` twice to
stripe the body. `get_texture kart_body` afterward showed pure red — no
stripe. The paint had landed on `wheel_v2` (which was panel-active at the
time). Calling the same `draw_shape_tool` after re-selecting body cubes
+ re-applying `kart_body` _still_ didn't paint on `kart_body`. The only
reliable way to paint on a specific texture was `paint_fill_tool
fill_mode="selected_elements"`, which scoped the fill to the selected
cubes' UV footprint on the active texture.

**Recommendation**: Before any paint call, the MCP server should either
(a) activate the texture referenced by `texture_id`, or (b) fail fast with
"texture_id must be the active texture; call `activate_texture` first".
Currently the success response is a lie ("Drew rectangle ... on texture
'kart_body'") — log said yes, texture didn't change.

### P5 — Viewport renders the last-applied texture for all cubes until forced to refresh

**Observed**: After assigning three distinct textures to three distinct
cube sets, `filter_by_material` confirmed the data model was correct
(68 body cubes → `kart_body`, 52 wheel cubes → `wheel_v2`, 12 steering
→ `kart_steering`). But the `capture_screenshot` rendering showed the
entire model in the single dark color of whichever texture was last
touched. Only after a _paint_ operation (`paint_fill_tool` with
`selected_elements`) did the viewport refresh and reveal per-cube
texture assignments.

**Impact**: `capture_screenshot` is unreliable for verifying texturing
work — it can show the wrong colors even when the model is correct.
Without `filter_by_material`, I would have kept undoing and reapplying
for hours.

**Recommendation**: Add a `refresh_canvas` / `update_preview` action, or
call `Canvas.updateAllFaces()` (or the Bedrock-equivalent) at the end of
every `apply_texture` invocation. Also worth asserting that
`capture_screenshot` forces a render before reading pixels.

### P6 — `undo` reports success but doesn't roll back `apply_texture`

**Observed**: After three `apply_texture` mutations, `undo steps=3` returned
`{ undone_count: 3, undone: ["Agent applied texture" ×3] }`. Visually
nothing changed; `get_undo_stack` showed the three entries as
`is_applied: false`. Re-applying manually was required.

**Impact**: The checkpoint-before-risk pattern from the `blockbench-use`
skill became useless for texture work — you can't actually get back to
the checkpoint.

**Recommendation**: Investigate whether `apply_texture` is bypassing
Blockbench's undo stack (e.g. writing to face objects directly instead of
through `Undo.initEdit` / `Undo.finishEdit`). If yes, wrap the operation in
`Undo.initEdit({ elements: selected })` so undo actually captures the
prior face-texture state.

### P7 — `applyTo="blank"` doesn't distinguish blank from already-textured faces

**Observed**: Body cubes with `kart_body` assigned (verified via
`filter_by_material`), then `apply_texture id=front_axle texture=wheel_v2
applyTo="blank"` caused the viewport to render everything black.
(Entangled with P3/P5, but worth calling out: `"blank"` did not protect
already-assigned faces.)

**Recommendation**: Given P3's root cause, this is likely a downstream
symptom — fix the scoping and re-test. Keep the `blank|all|none` enum
but make sure each value has a documented, verifiable behavior and a
response that states faces-affected count so agents can sanity-check.

### P8 — `draw_shape_tool` hollow variants crash

**Observed**: `draw_shape_tool shape="ellipse_h" line_width=3` returned
`BarItems.slider_brush_size.set is not a function`.

**Impact**: Can't draw outlines at all; must use solid shapes.

**Recommendation**: The tool's internal handler is trying to mutate a
slider that no longer exists. Update the Blockbench-shim selector or the
hollow-shape drawing code. Low-hanging repro — happens on any hollow
shape call.

### P9 — `texture_selection action="select_all"` crashes

**Observed**: `texture_selection texture_id="kart_body" action="select_all"`
returned `H.selectAll is not a function`. Other actions weren't tested.

**Recommendation**: Another broken internal call. Check whether all
documented `action` enum values are wired up against the current
Blockbench API (this is likely not the only one).

### P10 — Bedrock project had no `get_project_info` hint about texture resolution

**Context**: Bedrock models have a `texture_width` / `texture_height` on
the geometry. Creating textures at a size that doesn't match causes UVs
to pull the wrong regions. There's no tool that surfaces this, so the
first texture I created (`kart_body` 64×64) might or might not match
what the model expected. (Painting via `selected_elements` sidesteps the
issue, but it's a trap waiting for anyone who goes the "paint manually on
the sheet" route.)

**Recommendation**: Include `texture_width` / `texture_height` (or
`resolution`) in whatever replaces `list_outline`. Warn if
`create_texture` is called with a size that doesn't match the active
project's resolution.

## What Worked Well

- `find_elements_by_criteria type=group` gave clean parent-child
  hierarchy and was the first tool that actually helped.
- `save_checkpoint` + `get_undo_stack` is a nice concept (even though
  undo-of-apply-texture was broken, the _indexing_ was accurate).
- `filter_by_material` was the single most important tool for debugging
  the state mismatch — without it I'd have been flying blind.
- `paint_fill_tool fill_mode="selected_elements"` is the one paint tool
  that behaved predictably when `texture_id` was specified alongside a
  selection.
- `select_all_of_type parent_group=<name>` was reliable and fast.
- `set_camera_angle` with explicit `position`/`target` worked on the
  first try.

## Recommended Prioritized Fixes

1. **P3 + P4 together** — the `id`/`texture_id` parameters are false
   advertising today. Fix the scope resolution so agents can trust the
   API surface. (Biggest time-sink of the session.)
2. **P5** — make `capture_screenshot` force a preview refresh, and/or
   add an explicit `refresh_canvas` tool.
3. **P6** — wire `apply_texture` into the undo stack so checkpoints are
   actually recoverable.
4. **P8, P9** — small API mismatches; both likely one-line fixes.
5. **P1 + P10** — improve discovery so first-look tools return enough
   information to act on.

## Suggested New Tools

- `get_project_info` — returns `{ format.id, format.display_name, name,
  texture_width, texture_height, uv_mode, element_counts, root_groups }`.
- `activate_texture texture="<name|uuid>"` — sets the panel-active
  texture explicitly. This would make P3/P4 workarounds explicit and
  self-documenting.
- `get_selection` — the inverse of `select_all_of_type`; returns what
  cubes/faces are currently selected. Would have helped debug P3.
- `list_outline_tree` — tree-shaped replacement for the current flat
  `list_outline` (or just fix the existing one).

## Final Texturing Result

Achieved: body chassis textured yellow with red UV seams, wheels
assigned `wheel_v2` (dark), steering assigned `kart_steering`. The model
visually reads as a go-kart-shaped vehicle rather than an untextured
silhouette. Not production-quality styling — the session time was
dominated by tool-behavior investigation rather than artistic iteration.
