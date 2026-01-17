# Hytale Model Creation Guide

This guide covers creating 3D models for Hytale using Blockbench with the Hytale plugin.

## Format Selection

Hytale uses two model formats:

### Character Format (`hytale_character`)
- **Block Size**: 64 pixels
- **Use Case**: Humanoid/creature models with complex rigs
- **Features**: Full bone hierarchy, attachments, animations

### Prop Format (`hytale_prop`)
- **Block Size**: 32 pixels
- **Use Case**: Items, weapons, decorative objects
- **Features**: Simpler structure, optimized for props

## Key Concepts

### Node Limit
Hytale has a **maximum of 255 nodes** per model. Nodes include:
- Groups/bones
- Individual cubes (excluding the main shape cube of a group)

Use `hytale_validate_model` tool to check node count.

### Shading Modes
Cubes support four shading modes:
- `standard` - Normal lighting (default)
- `flat` - No lighting/shadows
- `fullbright` - Always fully lit (emissive effect)
- `reflective` - Reflective material

Set with `hytale_set_cube_properties` tool.

### Double-Sided Faces
Enable `double_sided` on cubes to render both front and back faces. Useful for:
- Thin planes/quads
- Cloth/fabric elements
- Transparency effects

### Stretch vs Size
Hytale prefers **stretch** over floating-point sizes:
- Stretch is a multiplier [x, y, z] applied to the base cube
- Better UV handling than fractional sizes
- Use `hytale_set_cube_stretch` / `hytale_get_cube_stretch` tools

### Quads
Hytale supports single-face quads (2D planes):
- Created with `hytale_create_quad` tool
- Specify normal direction: +X, -X, +Y, -Y, +Z, -Z
- Automatically double-sided by default

## Workflow

1. **Create Project**: Use `create_project` with format `bedrock` (Hytale uses similar format structure)
2. **Build Skeleton**: Create bone hierarchy using `add_group` with proper origins
3. **Add Geometry**: Use `place_cube` for cubes, `hytale_create_quad` for flat surfaces
4. **Set Properties**: Apply shading modes and double-sided as needed
5. **Validate**: Run `hytale_validate_model` before export

## Texture Guidelines

- Character textures: 64x64 or multiples for flipbooks
- Prop textures: 32x32 or multiples for flipbooks
- UV size must match texture resolution
- Use integer positions for pixel-perfect UVs

## Tips

- Keep node count under 255
- Use stretch for scaling instead of fractional sizes
- Group related cubes under bones for animation
- Mark attachment bones with `is_piece: true` using `hytale_set_attachment_piece`
