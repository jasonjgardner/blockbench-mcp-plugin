# MCP Tools

This document lists all available MCP tools for the Blockbench plugin, organized by stability status and category.

## Legend
- **Stable**: Production-ready tools that are thoroughly tested
- **Experimental**: Tools that are functional but may have limitations or rough edges

---

## Basic Operations

### place_cube
#### ✅ Stable
Places one or more cubes at specified positions with customizable properties.

**Parameters:**
- `elements`: Array of cube definitions with name, origin, from, to, rotation
- `texture`: Optional texture ID or name to apply
- `group`: Optional group/bone to add cubes to
- `faces`: Face configuration (boolean for auto UV or array for custom faces/UV)

### place_mesh
#### ⚠️ Experimental
Creates mesh elements with custom vertices and positioning.

**Parameters:**
- `elements`: Array of mesh definitions with vertices and transforms
- `texture`: Optional texture to apply
- `group`: Optional group/bone assignment

### place_sphere
#### ✅ Stable
Creates spherical meshes using procedural vertex generation.

**Parameters:**
- `elements`: Array of sphere definitions with position, diameter, sides
- `texture`: Optional texture to apply
- `group`: Optional group assignment
- Supports hollow spheres and quality settings

---

## Element Management

### modify_cube
#### ✅ Stable
Modifies properties of existing cube elements.

**Parameters:**
- `id`: Cube ID/name to modify (optional, defaults to selected)
- `name`, `origin`, `from`, `to`, `rotation`: Cube properties
- `autouv`: Auto UV setting (0=disabled, 1=enabled, 2=relative)
- `uv_offset`, `mirror_uv`, `shade`, `inflate`, `color`, `visibility`: Additional properties

### remove_element
#### ⚠️ Experimental
Removes elements by ID or name from the project.

**Parameters:**
- `id`: Element ID or name to remove

### apply_texture
#### ✅ Stable
Applies textures to specific elements.

**Parameters:**
- `id`: Element ID/name to apply texture to
- `texture`: Texture ID or name
- `applyTo`: Application mode (all/blank/none)

---

## Project Structure

### add_group
#### ✅ Stable
Creates new groups/bones for organizing elements.

**Parameters:**
- `name`: Group name
- `origin`, `rotation`: Transform properties
- `parent`: Parent group (defaults to root)
- `visibility`, `autouv`, `selected`, `shade`: Group properties

### list_outline
#### ✅ Stable
Returns hierarchical list of all project elements.

**Returns:** JSON array of elements with names and UUIDs

### create_project
#### ✅ Stable
Creates new projects with specified format.

**Parameters:**
- `name`: Project name
- `format`: Project format (defaults to bedrock_block)

---

## Texture Management

### create_texture
#### ⚠️ Experimental
Creates new textures with various options.

**Parameters:**
- `name`: Texture name
- `width`, `height`: Texture dimensions (16-4096)
- `data`: Optional image file path or data URL
- `fill_color`: Optional solid color fill (RGB array or hex)
- `layer_name`: Required if using fill_color
- `pbr_channel`: PBR channel type
- `render_mode`, `render_sides`: Rendering options

### list_textures
#### ✅ Stable
Returns list of all project textures.

**Returns:** JSON array with texture names, UUIDs, and groups

### get_texture
#### ✅ Stable
Retrieves texture image data.

**Parameters:**
- `texture`: Texture ID/name (optional, defaults to default texture)

**Returns:** Image content with texture data URL

### add_texture_group
#### ⚠️ Experimental
Creates texture groups for PBR materials management.

**Parameters:**
- `name`: Group name
- `textures`: Array of texture IDs to add
- `is_material`: Whether group is a PBR material

---

## Animation System

### create_animation
#### ✅ Stable
Creates animations with keyframes for multiple bones.

**Parameters:**
- `name`: Animation name
- `loop`: Whether animation loops
- `animation_length`: Duration in seconds
- `bones`: Record of bone names to keyframe arrays
- `particle_effects`: Optional particle effects with timing

### manage_keyframes
#### ⚠️ Experimental
Creates, edits, deletes, or selects keyframes in animations.

**Parameters:**
- `animation_id`: Target animation (optional)
- `action`: create/delete/edit/select
- `bone_name`: Target bone name
- `channel`: Animation channel (rotation/position/scale)
- `keyframes`: Array of keyframe data with timing and values

### animation_graph_editor
#### ⚠️ Experimental
Controls animation curves for smooth motion.

**Parameters:**
- `animation_id`: Target animation
- `bone_name`: Target bone
- `channel`: Animation channel
- `action`: Curve type (smooth/linear/ease_in/ease_out/etc.)
- `keyframe_range`: Optional time range
- `custom_curve`: Custom bezier control points

### bone_rigging
#### ⚠️ Experimental
Creates and manipulates bone hierarchies.

**Parameters:**
- `action`: create/parent/unparent/delete/rename/set_pivot/set_ik/mirror
- `bone_data`: Bone configuration with transforms and relationships

### animation_timeline
#### ⚠️ Experimental
Controls animation playback and timeline settings.

**Parameters:**
- `action`: play/pause/stop/set_time/set_length/set_fps/loop/select_range
- `time`, `length`, `fps`: Timeline properties
- `loop_mode`: Playback mode
- `range`: Selection range

### batch_keyframe_operations
#### ⚠️ Experimental
Performs batch operations on multiple keyframes.

**Parameters:**
- `selection`: Selection mode (all/selected/range/pattern)
- `operation`: offset/scale/reverse/mirror/smooth/bake
- `parameters`: Operation-specific settings

### animation_copy_paste
#### ⚠️ Experimental
Copies animation data between bones or animations.

**Parameters:**
- `action`: copy/paste/mirror_paste
- `source`: Source animation and bone data
- `target`: Target location with optional mirroring

---

## Mesh Editing

### select_mesh_elements
#### ⚠️ Experimental
Selects vertices, edges, or faces for mesh editing.

**Parameters:**
- `mesh_id`: Target mesh
- `mode`: vertex/edge/face selection
- `elements`: Specific elements to select
- `action`: select/add/remove/toggle

### move_mesh_vertices
#### ⚠️ Experimental
Moves selected mesh vertices by offset.

**Parameters:**
- `mesh_id`: Target mesh (optional)
- `offset`: XYZ movement vector
- `vertices`: Specific vertices to move

### extrude_mesh
#### ⚠️ Experimental
Extrudes faces, edges, or vertices outward.

**Parameters:**
- `mesh_id`: Target mesh
- `distance`: Extrusion distance
- `mode`: faces/edges/vertices

### subdivide_mesh
#### ⚠️ Experimental
Adds geometry detail through subdivision.

**Parameters:**
- `mesh_id`: Target mesh
- `cuts`: Number of subdivision cuts (1-10)

### knife_tool
#### ⚠️ Experimental
Cuts custom edges into mesh faces.

**Parameters:**
- `mesh_id`: Target mesh
- `points`: Cut path definition with 3D positions

### merge_mesh_vertices
#### ⚠️ Experimental
Merges nearby vertices within threshold distance.

**Parameters:**
- `mesh_id`: Target mesh
- `threshold`: Maximum merge distance
- `selected_only`: Only merge selected vertices

### create_mesh_face
#### ⚠️ Experimental
Creates faces from selected vertices.

**Parameters:**
- `mesh_id`: Target mesh
- `vertices`: 3-4 vertex keys for face creation
- `texture`: Optional texture to apply

### delete_mesh_elements
#### ⚠️ Experimental
Deletes selected mesh elements.

**Parameters:**
- `mesh_id`: Target mesh
- `mode`: vertices/edges/faces
- `keep_vertices`: Preserve vertices when deleting faces/edges

---

## UV Mapping

### set_mesh_uv
#### ⚠️ Experimental
Sets custom UV coordinates for mesh faces.

**Parameters:**
- `mesh_id`: Target mesh
- `face_key`: Specific face to UV map
- `uv_mapping`: Vertex-to-UV coordinate mapping

### auto_uv_mesh
#### ⚠️ Experimental
Automatically generates UV mapping.

**Parameters:**
- `mesh_id`: Target mesh
- `mode`: project/unwrap/cylinder/sphere mapping
- `faces`: Specific faces to map

### rotate_mesh_uv
#### ⚠️ Experimental
Rotates UV coordinates of selected faces.

**Parameters:**
- `mesh_id`: Target mesh
- `angle`: Rotation angle (-90/90/180 degrees)
- `faces`: Specific faces to rotate

---

## Paint Mode Tools

### paint_with_brush
#### ⚠️ Experimental
Paints on textures using customizable brush.

**Parameters:**
- `texture_id`: Target texture
- `coordinates`: Array of paint positions
- `brush_settings`: Size, opacity, softness, shape, color, blend mode
- `connect_strokes`: Whether to connect paint points

### create_brush_preset
#### ⚠️ Experimental
Creates custom brush presets with settings.

**Parameters:**
- `name`: Preset name
- Brush properties: size, opacity, softness, shape, color, blend_mode
- `pixel_perfect`: Enable pixel-perfect drawing

### load_brush_preset
#### ⚠️ Experimental
Loads and applies saved brush presets.

**Parameters:**
- `preset_name`: Name of preset to load

### paint_fill_tool
#### ⚠️ Experimental
Fills areas with color using bucket tool.

**Parameters:**
- `texture_id`: Target texture
- `x`, `y`: Fill start coordinates
- `color`, `opacity`, `tolerance`: Fill properties
- `fill_mode`: Fill behavior mode

### draw_shape_tool
#### ⚠️ Experimental
Draws geometric shapes on textures.

**Parameters:**
- `texture_id`: Target texture
- `shape`: rectangle/ellipse (with hollow variants)
- `start`, `end`: Shape bounds
- `color`, `line_width`, `opacity`: Shape properties

### gradient_tool
#### ⚠️ Experimental
Applies color gradients to textures.

**Parameters:**
- `texture_id`: Target texture
- `start`, `end`: Gradient line endpoints
- `start_color`, `end_color`: Gradient colors
- `opacity`, `blend_mode`: Application settings

### color_picker_tool
#### ⚠️ Experimental
Picks colors from textures for use in painting.

**Parameters:**
- `texture_id`: Source texture
- `x`, `y`: Pick coordinates
- `set_as_secondary`: Use as secondary color
- `pick_opacity`: Also pick pixel opacity

### copy_brush_tool
#### ⚠️ Experimental
Copies/clones texture areas using brush.

**Parameters:**
- `texture_id`: Target texture
- `source`: Source coordinates to copy from
- `target`: Target coordinates to paste to
- `brush_size`, `opacity`: Brush properties

### eraser_tool
#### ⚠️ Experimental
Erases texture areas with customizable settings.

**Parameters:**
- `texture_id`: Target texture
- `coordinates`: Array of erase positions
- `brush_size`, `opacity`, `softness`: Eraser properties

---

## Texture Layers

### texture_selection
#### ⚠️ Experimental
Creates and manipulates texture selections for painting.

**Parameters:**
- `action`: select_rectangle/ellipse/all/clear/invert/expand/contract/feather
- `texture_id`: Target texture
- `coordinates`: Selection bounds
- `radius`: For expand/contract/feather operations

### texture_layer_management
#### ⚠️ Experimental
Manages texture layers for complex painting.

**Parameters:**
- `action`: create/delete/duplicate/merge/set_opacity/set_blend_mode/move/rename/flatten
- `texture_id`: Target texture
- `layer_name`: Layer identifier
- `opacity`, `blend_mode`: Layer properties

### paint_settings
#### ⚠️ Experimental
Configures global paint mode settings.

**Parameters:**
- `mirror_painting`: Mirror painting configuration
- `lock_alpha`, `pixel_perfect`: Drawing modes
- `brush_opacity_modifier`, `brush_size_modifier`: Stylus settings
- Various other paint behavior settings

---

## Import/Export

### from_geo_json
#### ✅ Stable
Imports models from GeoJSON format files.

**Parameters:**
- `geojson`: File path, data URL, or GeoJSON string

---

## System Interaction

### trigger_action
#### ⚠️ Experimental
Triggers Blockbench actions programmatically.

**Parameters:**
- `action`: Action ID from BarItems
- `confirmDialog`: Auto-confirm dialogs
- `confirmEvent`: Event arguments as JSON

### risky_eval
#### ✅ Stable
Evaluates JavaScript code in Blockbench context.

**Parameters:**
- `code`: JavaScript code to execute (no console commands or comments)

### emulate_clicks
#### ⚠️ Experimental
Simulates mouse clicks and drags on interface.

**Parameters:**
- `position`: Click coordinates and button
- `drag`: Optional drag operation with target and duration

### fill_dialog
#### ⚠️ Experimental
Fills and submits dialog forms programmatically.

**Parameters:**
- `values`: Dialog field values as JSON
- `confirm`: Whether to confirm or cancel dialog

---

## Screenshots and Visualization

### capture_screenshot
#### ✅ Stable
Captures viewport screenshots of the current model.

**Parameters:**
- `project`: Optional project name/UUID filter

**Returns:** Image content with screenshot data

### capture_app_screenshot
#### ✅ Stable
Captures full application window screenshot.

**Returns:** Image content with app screenshot

### set_camera_angle
#### ⚠️ Experimental
Sets viewport camera position and angle.

**Parameters:**
- `angle`: Camera configuration with position, target, rotation, projection

**Returns:** Screenshot after camera change
