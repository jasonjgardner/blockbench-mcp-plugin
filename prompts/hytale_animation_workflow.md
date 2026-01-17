# Hytale Animation Workflow

This guide covers creating animations for Hytale models using Blockbench with the Hytale plugin.

## Animation Basics

### Frame Rate
Hytale animations run at **60 FPS**. When setting keyframe times:
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
- Avoids gimbal lock issues

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
- `smooth` - Catmull-Rom spline for natural easing (default for Hytale)

## Loop Modes

Set with `hytale_set_animation_loop`:

- `loop` - Continuous playback, restarts from beginning
- `hold` - Play once, freeze on last frame
- `once` - Play once, return to rest pose

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
- `stepped` for snappy transitions

### 4. Multi-Bone Animation
Hytale supports **duplicate bone names**:
- Multiple bones with same name receive same animation
- Useful for symmetrical limbs (left_leg, left_leg)
- Animation is automatically copied

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
- Quaternion rotation prevents flip issues

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
