# Hytale Model Creation Guide

This guide covers creating 3D models for Hytale using Blockbench with the Hytale plugin.

## Format Selection

Hytale uses two model formats:

### Character Format (`hytale_character`)
- **Block Size / Intended Density**: 64 pixels per world unit
- **Use Case**: Characters and attachments, including held weapons, tools and food
- **Features**: Full bone hierarchy, attachments, animations

### Prop Format (`hytale_prop`)
- **Block Size / Intended Density**: 32 pixels per world unit
- **Use Case**: Environmental props and decorative objects
- **Features**: Use the actual format flags and codec; do not infer a rig restriction from the word prop

## Key Concepts

### Node Limit
Hytale has a **maximum of 255 nodes** per model. Nodes include:
- Groups/bones
- Individual cubes (excluding the main shape cube of a group)

Use `hytale_validate_model` to count the installed codec's exported main-model nodes. Export toggles and main-shape folding affect the count. Attachment exports need separate validation; this tool does not certify every UV, material or engine integration rule.

### Shading Modes
Cubes support four shading modes:
- `standard` - Normal lighting
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

1. **Create Project**: Discover `hytale_character` or `hytale_prop` with `get_capabilities`, then pass that exact format to `create_project`. The Hytale Models plugin must be installed; Bedrock is not a Hytale substitute.
2. **Build Skeleton**: Create bone hierarchy using `add_group` with proper origins
3. **Add Geometry**: Use `place_cube` for cubes, `hytale_create_quad` for flat surfaces
4. **Set Properties**: Apply shading modes and double-sided as needed
5. **Validate**: Run `hytale_validate_model` before export

## Texture Guidelines

- Width and height must each be positive multiples of 32; rectangular atlases such as 128x96 are valid.
- Atlas dimensions are separate from character/prop density. Aspect ratio alone does not identify a flipbook.
- Match logical UV size to the intended static bitmap dimensions. `create_texture` accepts `uv_width` and `uv_height` together; inspect `list_textures` afterward.
- Face UV dimensions stay linked to base geometry. `set_cube_uv` permits matching-size offsets/mirroring and rotation; Hytale retains Auto UV 1. Quads cannot use box UV.
- Use integer base dimensions with the native default size setting and stretch for finer visible sizes; arbitrary integer-position rules are not universal.

## Tips

- Keep exported node count within the 255-node limit
- Use stretch for scaling instead of fractional sizes
- Group related cubes under bones for animation
- Mark attachment bones with `is_piece: true` using `hytale_set_attachment_piece`

Technical guidance checked against the [official Hytale art introduction](https://hytale.com/news/2025/12/an-introduction-to-making-models-for-hytale) and [format declarations](https://github.com/JannisX11/hytale-blockbench-plugin/blob/main/src/formats.ts) on 2026-09-13. Inspect the installed format when versions differ.
