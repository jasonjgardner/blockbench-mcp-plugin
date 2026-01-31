# Blockbench API Reference

## Global Objects

### Project
Current project state and metadata.

```javascript
Project.name           // Project name
Project.geometry_name  // Geometry identifier
Project.format         // Format object
Project.box_uv         // Box UV mode enabled
Project.texture_width  // UV texture width
Project.texture_height // UV texture height
Project.save_path      // File path (desktop)
```

### Format
Current model format definition.

```javascript
Format.id              // Format ID string
Format.name            // Display name
Format.box_uv          // Supports box UV
Format.bone_rig        // Supports bones
Format.animation_mode  // Supports animations
Format.meshes          // Supports meshes
Format.rotate_cubes    // Supports cube rotation
```

### Canvas
Scene and rendering control.

```javascript
Canvas.updateView(options)    // Update specific elements
Canvas.updateAll()            // Full scene rebuild
Canvas.updateSelected(aspects) // Update selected elements
Canvas.scene                  // THREE.Scene object
Canvas.gizmo                  // Transform gizmo
```

**updateView options:**
```javascript
Canvas.updateView({
    elements: Cube.selected,
    element_aspects: {
        geometry: true,    // Rebuild geometry
        uv: true,          // Update UV mapping
        faces: true,       // Update face materials
        transform: true,   // Update position/rotation
        visibility: true   // Update visibility
    },
    selection: true,       // Update selection highlight
    groups: true           // Update group hierarchy
});
```

### Undo
Undo/redo history management.

```javascript
Undo.initEdit(aspects)       // Start tracking changes
Undo.finishEdit(name)        // Commit changes with description
Undo.cancelEdit()            // Discard tracked changes
Undo.undo()                  // Undo last action
Undo.redo()                  // Redo last undone action
```

**initEdit aspects:**
```javascript
Undo.initEdit({
    elements: [...],        // Elements being modified
    outliner: true,         // Track hierarchy changes
    textures: [...],        // Textures being modified
    animations: [...],      // Animations being modified
    uv_only: false,         // UV-only changes
    bitmap: true            // Texture bitmap changes
});
```

### Outliner
Model hierarchy management.

```javascript
Outliner.root              // Root elements array
Outliner.elements          // All elements flat list
Outliner.selected          // Currently selected elements
Outliner.control           // UI control methods
```

### Timeline
Animation timeline state.

```javascript
Timeline.time              // Current time in seconds
Timeline.playing           // Is animation playing
Timeline.selected          // Selected keyframes
Timeline.setTime(time)     // Set playback time
Timeline.start()           // Start playback
Timeline.pause()           // Pause playback
```

## Element Classes

### Cube

```javascript
// Properties
cube.name                  // Display name
cube.from                  // [x, y, z] min corner
cube.to                    // [x, y, z] max corner
cube.origin                // [x, y, z] pivot point
cube.rotation              // [x, y, z] rotation degrees
cube.inflate               // Inflation amount
cube.box_uv                // Using box UV mode
cube.uv_offset             // [u, v] box UV offset
cube.faces                 // Face UV data object
cube.color                 // Marker color index (0-7)
cube.visibility            // Is visible
cube.export                // Include in export
cube.uuid                  // Unique identifier

// Methods
cube.init()                // Initialize (required after new)
cube.addTo(group)          // Add to group or root
cube.remove()              // Remove from project
cube.duplicate()           // Create copy
cube.extend(data)          // Apply data object
cube.getCenter()           // Get center position
cube.getSize()             // Get [w, h, d] dimensions
cube.applyTexture(tex, faces) // Apply texture
```

**Face properties:**
```javascript
cube.faces.north  // { uv: [u1, v1, u2, v2], texture: index, rotation: 0 }
cube.faces.south
cube.faces.east
cube.faces.west
cube.faces.up
cube.faces.down
```

### Group (Bone)

```javascript
// Properties
group.name                 // Display name
group.origin               // [x, y, z] pivot point
group.rotation             // [x, y, z] rotation degrees
group.visibility           // Is visible
group.export               // Include in export
group.children             // Direct children array
group.parent               // Parent group or 'root'
group.uuid                 // Unique identifier

// Methods
group.init()               // Initialize
group.addTo(parent)        // Add to parent or root
group.remove()             // Remove from project
group.resolve()            // Get flattened descendants
group.isParent(element)    // Check if parent of element
```

### Mesh

```javascript
// Properties
mesh.name                  // Display name
mesh.vertices              // { id: [x,y,z], ... } vertex positions
mesh.faces                 // { id: MeshFace, ... } face definitions
mesh.origin                // [x, y, z] pivot point
mesh.rotation              // [x, y, z] rotation degrees
mesh.uuid                  // Unique identifier

// Methods
mesh.init()                // Initialize
mesh.addVertices(...)      // Add vertex positions
mesh.addFaces(...)         // Add MeshFace objects
mesh.getSelectedVertices() // Get selected vertex IDs
mesh.getSelectedFaces()    // Get selected face IDs
```

### Texture

```javascript
// Properties
texture.name               // Display name
texture.mode               // 'bitmap' or 'link'
texture.path               // File path (link mode)
texture.width              // Image width
texture.height             // Image height
texture.uuid               // Unique identifier

// Methods
texture.add(undo)          // Add to project
texture.remove()           // Remove from project
texture.fromPath(path)     // Load from file path
texture.fromDataURL(url)   // Load from data URL
texture.getDataURL()       // Get as data URL
texture.fromFile(file)     // Load from File object
```

### Animation

```javascript
// Properties
animation.name             // Animation name
animation.loop             // 'loop', 'once', 'hold'
animation.length           // Duration in seconds
animation.snapping         // FPS snapping
animation.animators        // { uuid: BoneAnimator }
animation.uuid             // Unique identifier

// Methods
animation.add()            // Add to project
animation.select()         // Make active animation
animation.remove()         // Remove from project
animation.createUniqueName(name) // Generate unique name
```

### Keyframe

```javascript
// Properties
keyframe.channel           // 'rotation', 'position', 'scale'
keyframe.time              // Time in seconds
keyframe.data_points       // [{ x, y, z }, ...]
keyframe.interpolation     // 'linear', 'catmullrom', 'bezier', 'step'
keyframe.uuid              // Unique identifier

// Methods
keyframe.select()          // Select keyframe
keyframe.remove()          // Remove keyframe
```

### BoneAnimator

```javascript
// Properties
animator.keyframes         // Array of keyframes
animator.uuid              // Group UUID this animates

// Methods
animator.addKeyframe(keyframe)      // Add keyframe
animator.createKeyframe(options)    // Create and add keyframe
animator.getKeyframe(channel, time) // Get keyframe at time
```

## UI Components

### Dialog Form Field Types

| Type | Properties |
|------|------------|
| `text` | `value`, `placeholder`, `min_length`, `max_length` |
| `number` | `value`, `min`, `max`, `step` |
| `range` | `value`, `min`, `max`, `step` |
| `checkbox` | `value` (boolean) |
| `select` | `value`, `options: { key: 'Label' }` |
| `radio` | `value`, `options: { key: 'Label' }` |
| `color` | `value` (hex string) |
| `vector` | `value: [x, y, z]`, `dimensions: 3` |
| `file` | `extensions: ['png']`, `readtype` |
| `folder` | — |
| `textarea` | `value`, `placeholder` |
| `info` | `text` (non-interactive) |

**Conditional fields:**
```javascript
form: {
    show_advanced: { type: 'checkbox', value: false },
    advanced_option: {
        type: 'text',
        condition: (formData) => formData.show_advanced
    }
}
```

### Action Categories

For keybind settings grouping:
- `'file'` — File operations
- `'edit'` — Edit operations
- `'transform'` — Transform operations
- `'filter'` — Filter/effects
- `'animation'` — Animation controls
- `'tools'` — Tools
- `'view'` — View controls
- `'navigate'` — Navigation

## Utility Functions

### Blockbench

```javascript
Blockbench.showQuickMessage(message, duration)
Blockbench.showMessageBox({ title, message, buttons, icon })
Blockbench.textPrompt(title, value, callback)

Blockbench.import({ extensions, type, readtype }, callback)
Blockbench.export({ type, extensions, content, name })

Blockbench.read(paths, options, callback)  // Read files
Blockbench.writeFile(path, options)        // Write file

Blockbench.addCSS(css)           // Returns deletable reference
Blockbench.addDragHandler(id, options, callback)
Blockbench.removeDragHandler(id)

Blockbench.platform               // 'win32', 'darwin', 'linux', 'web'
Blockbench.isWeb                  // Is web version
Blockbench.isMobile               // Is mobile browser
Blockbench.version                // Version string
```

### Import/Export

```javascript
// Import
Blockbench.import({
    extensions: ['png', 'jpg'],
    type: 'Image',
    readtype: 'image',         // 'text', 'buffer', 'image'
    multiple: true
}, (files) => {
    files.forEach(file => {
        console.log(file.name, file.content, file.path);
    });
});

// Export
Blockbench.export({
    type: 'My Format',
    extensions: ['mymodel'],
    content: jsonString,
    name: 'model',
    custom_writer: (content, path) => { }  // Optional
});
```

### THREE.js Access

```javascript
// Scene objects
Canvas.scene                      // THREE.Scene
Canvas.scene.children             // Scene children
Canvas.outlines                   // Selection outlines group

// Common THREE.js usage
new THREE.Vector3(x, y, z)
new THREE.Quaternion()
new THREE.Matrix4()
new THREE.Box3()
new THREE.Raycaster()
```

## Keybinds

```javascript
new Keybind({
    key: 'k',          // Key code or character
    ctrl: false,       // Require Ctrl
    shift: false,      // Require Shift
    alt: false,        // Require Alt
    meta: false        // Require Meta/Cmd
});

// Special keys
key: 'space'
key: 'enter'
key: 'escape'
key: 'delete'
key: 'backspace'
key: 'tab'
key: 'arrowup'
key: 'arrowdown'
key: 'arrowleft'
key: 'arrowright'
key: 'f1' through 'f12'
```
