# Blockbench Elements Reference

## Element Hierarchy

```
OutlinerElement (base)
├── OutlinerNode (groupable)
│   ├── Cube
│   ├── Mesh
│   └── Locator
└── Group (bone/folder)
```

## Cube

The fundamental box-shaped element.

### Creation

```javascript
const cube = new Cube({
    // Identity
    name: 'cube_name',
    
    // Position (min/max corners)
    from: [0, 0, 0],           // [x, y, z] minimum corner
    to: [16, 16, 16],          // [x, y, z] maximum corner
    
    // Transform
    origin: [8, 8, 8],         // Pivot/rotation point
    rotation: [0, 45, 0],      // Rotation in degrees [x, y, z]
    rescale: false,            // Rescale to maintain visual size when rotating
    
    // Inflation
    inflate: 0,                // Inflation amount (positive = expand)
    
    // Appearance
    color: 0,                  // Marker color (0-7)
    visibility: true,
    mirror_uv: false,          // Mirror UV horizontally
    
    // UV Mode 1: Box UV
    box_uv: true,
    uv_offset: [0, 0],         // Box UV offset [u, v]
    
    // UV Mode 2: Per-face UV (when box_uv: false)
    faces: {
        north: { uv: [0, 0, 16, 16], texture: 0, rotation: 0 },
        south: { uv: [0, 0, 16, 16], texture: 0, rotation: 0 },
        east:  { uv: [0, 0, 16, 16], texture: 0, rotation: 0 },
        west:  { uv: [0, 0, 16, 16], texture: 0, rotation: 0 },
        up:    { uv: [0, 0, 16, 16], texture: 0, rotation: 0 },
        down:  { uv: [0, 0, 16, 16], texture: 0, rotation: 0 }
    },
    
    // Export
    export: true
}).init();  // ALWAYS call init()
```

### Key Methods

```javascript
cube.init()                       // Initialize after creation
cube.addTo(group)                 // Add to group (or root if no arg)
cube.remove()                     // Remove from project
cube.duplicate()                  // Create copy

cube.getCenter()                  // Returns center [x, y, z]
cube.getSize()                    // Returns [width, height, depth]

cube.applyTexture(texture, true)  // Apply to all faces
cube.applyTexture(texture, ['north', 'south'])  // Specific faces

cube.extend({ from: [1,1,1] })    // Merge properties
```

### Face Properties

```javascript
cube.faces.north = {
    uv: [u1, v1, u2, v2],  // UV coordinates
    texture: 0,             // Texture index (or false for none)
    rotation: 0,            // 0, 90, 180, or 270
    tint: -1               // Tint index (Minecraft)
};
```

## Group (Bone)

Container for elements with its own transform.

### Creation

```javascript
const group = new Group({
    // Identity
    name: 'bone_name',
    
    // Transform
    origin: [0, 8, 0],         // Pivot point
    rotation: [0, 0, 0],       // Rotation in degrees
    
    // Bedrock-specific
    bedrock_binding: '',       // Molang binding expression
    
    // Appearance
    visibility: true,
    isOpen: true,              // Expanded in outliner
    
    // Export
    export: true
}).init();
```

### Key Methods

```javascript
group.init()                     // Initialize after creation
group.addTo(parent)              // Add to parent or root
group.remove()                   // Remove (and children)

group.children                   // Direct children array
group.resolve()                  // Flattened descendants
group.isParent(element)          // Check ancestry

group.fold(state)                // Collapse/expand in outliner
group.selectChildren(event)      // Select all children
group.selectLow()                // Select lowest elements
```

### Hierarchy Navigation

```javascript
// Get children by type
const cubes = group.children.filter(c => c instanceof Cube);
const subgroups = group.children.filter(c => c instanceof Group);

// Recursive traversal
function traverse(element) {
    console.log(element.name);
    if (element instanceof Group) {
        element.children.forEach(traverse);
    }
}
traverse(group);

// Find all cubes in group (recursive)
const allCubes = group.resolve().filter(e => e instanceof Cube);
```

## Mesh

Free-form polygon geometry (advanced formats).

### Creation

```javascript
const mesh = new Mesh({
    name: 'mesh_name',
    
    // Vertices (key: position)
    vertices: {
        'v0': [0, 0, 0],
        'v1': [16, 0, 0],
        'v2': [16, 16, 0],
        'v3': [0, 16, 0],
        'v4': [8, 24, 8]       // Arbitrary positions
    },
    
    // Transform
    origin: [8, 8, 8],
    rotation: [0, 0, 0],
    
    visibility: true,
    export: true
}).init();

// Add faces after init
const face = new MeshFace(mesh, {
    vertices: ['v0', 'v1', 'v2', 'v3'],  // Vertex keys (3-4 verts)
    uv: {
        'v0': [0, 16],      // Per-vertex UV
        'v1': [16, 16],
        'v2': [16, 0],
        'v3': [0, 0]
    },
    texture: 0
});
mesh.addFaces(face);
```

### Key Methods

```javascript
mesh.init()
mesh.addTo(group)
mesh.remove()

mesh.addVertices([x, y, z], [x2, y2, z2])  // Returns vertex keys
mesh.addFaces(face1, face2, ...)

mesh.getSelectedVertices()  // Array of selected vertex keys
mesh.getSelectedFaces()     // Array of selected face keys
```

## Locator

Point marker for attachment/reference.

```javascript
const locator = new Locator({
    name: 'locator_name',
    position: [0, 8, 0],      // [x, y, z]
    rotation: [0, 0, 0],      // Optional rotation
    visibility: true,
    export: true
}).init();
```

## Texture

Image texture for UV mapping.

### Creation

```javascript
// From file (desktop)
const texture = new Texture({ name: 'my_texture' });
texture.fromPath('/absolute/path/to/image.png');
texture.add(true);  // Add to project (true = include in undo)

// From data URL (web-compatible)
const texture2 = new Texture({ name: 'generated' });
texture2.fromDataURL('data:image/png;base64,...');
texture2.add(true);

// From File object (user upload)
Blockbench.import({
    extensions: ['png'],
    type: 'Image',
    readtype: 'image'
}, (files) => {
    files.forEach(file => {
        new Texture().fromFile(file).add(true);
    });
});
```

### Properties

```javascript
texture.name              // Display name
texture.mode              // 'bitmap' (embedded) or 'link' (external)
texture.path              // File path (if linked)
texture.width             // Image width
texture.height            // Image height
texture.source            // Data URL of image
texture.selected          // Is selected
texture.uuid              // Unique ID
```

### Key Methods

```javascript
texture.add(undo)         // Add to project
texture.remove()          // Remove from project
texture.select()          // Make active texture

texture.fromPath(path)    // Load from file
texture.fromDataURL(url)  // Load from data URL  
texture.fromFile(file)    // Load from File object

texture.getDataURL()      // Export as data URL
texture.save(options)     // Save to file

texture.getMaterial()     // Get THREE.Material
```

## Global Collections

```javascript
// All elements
Cube.all                  // All cubes in project
Mesh.all                  // All meshes
Group.all                 // All groups
Locator.all               // All locators
Texture.all               // All textures
Animation.all             // All animations

// Selected elements
Cube.selected             // Selected cubes
Mesh.selected             // Selected meshes
Group.selected            // Selected groups
Outliner.selected         // All selected elements

// Current
Texture.selected          // Active texture
Animation.selected        // Active animation

// Hierarchy
Outliner.root             // Root-level elements
Outliner.elements         // Flat list of all elements
```

## Common Operations

### Selecting Elements

```javascript
// Programmatic selection
cube.select(event, isSelected)  // event can be null
group.select()

// Clear selection
Cube.selected.length = 0;
Mesh.selected.length = 0;

// Select multiple
elements.forEach(el => el.select(null, true));
```

### Copying Elements

```javascript
// Duplicate with undo
Undo.initEdit({ elements: Cube.selected, outliner: true });
const copies = Cube.selected.map(c => c.duplicate());
Undo.finishEdit('Duplicate cubes');

// copies contains the new cubes
```

### Moving Elements

```javascript
Undo.initEdit({ elements: Cube.selected });

Cube.selected.forEach(cube => {
    cube.from[0] += 5;  // Move X
    cube.from[1] += 5;  // Move Y
    cube.from[2] += 5;  // Move Z
    cube.to[0] += 5;
    cube.to[1] += 5;
    cube.to[2] += 5;
});

Canvas.updateView({
    elements: Cube.selected,
    element_aspects: { transform: true }
});

Undo.finishEdit('Move cubes');
```

### Resizing Elements

```javascript
Undo.initEdit({ elements: Cube.selected });

Cube.selected.forEach(cube => {
    const center = cube.getCenter();
    const scale = 1.5;
    
    for (let i = 0; i < 3; i++) {
        cube.from[i] = center[i] + (cube.from[i] - center[i]) * scale;
        cube.to[i] = center[i] + (cube.to[i] - center[i]) * scale;
    }
});

Canvas.updateView({
    elements: Cube.selected,
    element_aspects: { geometry: true }
});

Undo.finishEdit('Scale cubes');
```

### Changing Parent

```javascript
Undo.initEdit({ outliner: true });

const targetGroup = Group.all.find(g => g.name === 'target');
Cube.selected.forEach(cube => {
    cube.addTo(targetGroup);
});

Undo.finishEdit('Reparent cubes');
```
