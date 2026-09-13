# Hytale Animation Workflow

This guide covers creating animations for Hytale models using Blockbench with the Hytale plugin.

## Animation Basics

### Frame Rate
The native `.blockyanim` exporter uses a **60-frame-per-second timebase**. This is not a universal editor or renderer frame-rate requirement. When setting keyframe times:
- 1 second = 60 frames
- 0.5 seconds = 30 frames
- Use decimal seconds in tools (e.g., 0.5, 1.0, 2.5)

### File Format
Animations are stored in `.blockyanim` files, separate from the model (`.blockymodel`).

## Animation Channels

Hytale supports these animation channels per bone:

### Position
- Channel: `position`
- Values: [x, y, z] offset from rest pose

### Rotation (Quaternion)
- Channel: `rotation`
- Hytale uses **quaternion interpolation** for smooth 3D rotations
- Preview shortest-path interpolation; full turns need intermediate orientations less than 180 degrees apart

### Scale (Stretch)
- Channel: `scale`
- Values: [x, y, z] scale factors
- Linked to cube stretch system

### Visibility (Hytale-specific)
- Channel: `visibility`
- Values: boolean (true/false)
- Toggle bone visibility at keyframes
- Use `hytale_create_visibility_keyframe` tool

## Interpolation Types

- `linear` - Constant rate between keyframes
- Native keyframes use `catmullrom`; the inspected exporter maps that to `smooth`

Other editor interpolation types are not preserved as distinct `.blockyanim` curve types by the inspected exporter. Verify exported motion rather than assuming editor Bezier or step settings survive unchanged.

## Editor Loop Modes

Set with `hytale_set_animation_loop`:

- `loop` - Continuous playback, restarts from beginning
- `hold` - Play once, freeze on last frame
- `once` - One-shot editor playback

Inspect the exported hold/loop-related properties and game-side playback bindings; editor loop mode alone does not prove runtime behavior.

## Workflow

### 1. Create Animation
```
Use create_animation tool:
- name: "walk_cycle"
- animation_length: 1.0 (1 second)
- loop: true
```

### 2. Add Keyframes
Use animation tools to add keyframes:
- `manage_keyframes` for position/rotation/scale
- `hytale_create_visibility_keyframe` for visibility toggles

### 3. Set Interpolation
Use `animation_graph_editor` to adjust curves:
- `smooth` for organic movements
- `linear` for mechanical movements
- `stepped` only when its editor behavior is intended; verify delivery because the native Hytale exporter maps non-Catmull-Rom interpolation to linear

### 4. Multi-Bone Animation
Hytale can use repeated bone names for shared animation semantics. Use this deliberately: it can prevent independent limb motion. MCP targeting should retain returned UUIDs when names repeat, and the exported animation must be checked against the intended rig. Do not assume the tool copies separate editable tracks automatically.

## Tips

### Visibility Animations
Use visibility keyframes for:
- Showing/hiding alternate body parts
- Weapon swapping effects
- Damage states

### Attachment Animations
Attachment pieces inherit parent bone animation:
- Mark bones as attachment pieces with `is_piece: true`
- Attachments connect to matching bone names

### Performance
- Keep keyframes sparse, interpolation fills gaps
- Use linear interpolation for simple movements
- Preview rotation direction and the loop seam; quaternion interpolation does not preserve an unkeyed full revolution

Export animation through the discovered native `export_blockyanim` action. Do not invent a `blockyanim` model-codec argument for `export_model`. See the [native animation exporter](https://github.com/JannisX11/hytale-blockbench-plugin/blob/main/src/blockyanim.ts), checked 2026-09-13.

## Common Patterns

### Walk Cycle (1 second loop)
1. Contact pose (0s): Extended legs
2. Passing pose (0.25s): Mid-stride
3. Contact pose (0.5s): Opposite leg forward
4. Passing pose (0.75s): Return to start

### Idle Animation (2-3 second loop)
- Subtle breathing (scale Y on chest)
- Slight head movement
- Small position shifts for life

### Attack Animation (0.5-1 second)
- Wind-up phase with anticipation
- Quick strike (linear interpolation)
- Recovery with easing
