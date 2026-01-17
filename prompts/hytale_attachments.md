# Hytale Attachments System

This guide covers the attachment system in Hytale models for creating modular equipment, accessories, and interchangeable parts.

## What Are Attachments?

Attachments are separate models that can be dynamically attached to bones in a base model. Common uses:
- Armor pieces
- Weapons and tools
- Accessories (hats, capes)
- Alternate body parts
- Equipment variations

## Key Concepts

### Attachment Collections
Attachments are organized as **Collections** in Blockbench:
- Each collection is a separate exportable unit
- Collections have their own textures
- Export codec: `blockymodel`

Use `hytale_list_attachments` to see all attachment collections.

### Attachment Pieces
Groups marked as **attachment pieces** define connection points:
- Set with `hytale_set_attachment_piece` tool
- Pieces attach to bones with matching names in the base model
- Origin point defines the attachment anchor

Use `hytale_list_attachment_pieces` to see marked pieces.

## Workflow

### Creating an Attachment

1. **Create Collection**
   - Use Blockbench's collection panel
   - Set export codec to `blockymodel`

2. **Build Geometry**
   - Add cubes/meshes to the collection
   - Structure under bones as needed

3. **Mark Piece Bones**
   ```
   hytale_set_attachment_piece:
   - group_name: "hand_right"
   - is_piece: true
   ```
   This bone will attach to `hand_right` in the base model.

4. **Assign Texture**
   - Each attachment can have its own texture
   - Texture is stored in collection metadata

### Attachment Naming Convention

For automatic attachment:
- Base model has bone: `hand_right`
- Attachment has piece bone: `hand_right`
- Attachment snaps to base bone at runtime

### Multiple Attachments

A single bone can have multiple possible attachments:
- Create separate collections for each variant
- All share the same piece bone name
- Game logic selects which to display

## Resources

### hytale://attachments
Lists all attachment collections with:
- UUID and name
- Associated texture
- Element count

### hytale://pieces
Lists all attachment piece bones with:
- UUID and name
- Origin position
- Rotation

## Tips

### Pivot Points
Set piece bone origins carefully:
- Origin = attachment point
- Rotation = attachment orientation
- Match base model's bone origin for perfect fit

### Animation Inheritance
Attached pieces inherit animation from base:
- No separate animation needed
- Follows parent bone transforms
- Visibility can be animated

### Texture Organization
Keep attachment textures separate:
- One texture per attachment collection
- Allows mixing and matching
- Efficient for palette swaps

### Performance
- Attachments are lightweight
- Only active attachment is rendered
- Use for equipment variations instead of model variants

## Common Patterns

### Armor System
```
Base Model: character.blockymodel
├── body
│   └── [geometry]
├── arm_left (can have attachments)
├── arm_right (can have attachments)
└── head (can have attachments)

Attachments:
├── helmet.blockymodel
│   └── head (is_piece: true)
├── chestplate.blockymodel
│   └── body (is_piece: true)
└── gauntlet_left.blockymodel
    └── arm_left (is_piece: true)
```

### Weapon Slots
```
character.blockymodel
└── hand_right

Weapon Attachments:
├── sword.blockymodel → hand_right
├── axe.blockymodel → hand_right
└── pickaxe.blockymodel → hand_right
```

### Accessory Layers
```
Base: character.blockymodel
├── head
└── back

Accessories:
├── hat.blockymodel → head
├── glasses.blockymodel → head
└── cape.blockymodel → back
```
