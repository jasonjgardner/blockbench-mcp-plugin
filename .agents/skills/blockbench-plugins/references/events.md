# Blockbench Events Reference

## Subscription Pattern

```javascript
// Subscribe
const callback = (data) => { /* handle */ };
Blockbench.on('event_name', callback);

// With ID for targeted removal
Blockbench.on('event_name', {
    handler: callback,
    id: 'my_plugin_handler'
});

// Unsubscribe (must use same callback reference)
Blockbench.removeListener('event_name', callback);

// Dispatch custom event
Blockbench.dispatchEvent('my_custom_event', { data: 'value' });
```

## Selection Events

| Event | Data | Description |
|-------|------|-------------|
| `update_selection` | — | Element selection changed |
| `select_all` | — | Select all triggered |

## Project Events

| Event | Data | Description |
|-------|------|-------------|
| `new_project` | — | New project created |
| `load_project` | — | Project loaded from file |
| `save_project` | `{path}` | Project saved |
| `close_project` | — | Project closed |
| `select_project` | — | Project tab switched |
| `update_project_settings` | — | Project settings changed |

## Element Events

| Event | Data | Description |
|-------|------|-------------|
| `add_cube` | `cube` | Cube added |
| `add_mesh` | `mesh` | Mesh added |
| `add_group` | `group` | Group/bone added |
| `group_elements` | — | Elements grouped |
| `update_elements` | `elements` | Elements modified |

## Texture Events

| Event | Data | Description |
|-------|------|-------------|
| `add_texture` | `texture` | Texture added |
| `select_texture` | `texture` | Texture selected |
| `change_texture` | `texture` | Texture content changed |
| `update_texture_selection` | — | Texture selection changed |

## Animation Events

| Event | Data | Description |
|-------|------|-------------|
| `add_animation` | `animation` | Animation added |
| `select_animation` | `animation` | Animation selected |
| `display_animation_frame` | — | Animation frame rendered |
| `timeline_update` | — | Timeline state changed |
| `add_keyframe` | `keyframe` | Keyframe added |
| `select_keyframe` | `keyframe` | Keyframe selected |

## Canvas/View Events

| Event | Data | Description |
|-------|------|-------------|
| `render_frame` | — | 3D viewport rendered |
| `update_view` | — | View updated |
| `canvas_click` | `{event, element}` | Canvas clicked |
| `canvas_drag` | `{event, element}` | Canvas dragged |
| `resize_window` | — | Window resized |

## Undo/Redo Events

| Event | Data | Description |
|-------|------|-------------|
| `undo` | — | Undo performed |
| `redo` | — | Redo performed |
| `finish_edit` | `{aspects}` | Edit operation completed |

## Mode Events

| Event | Data | Description |
|-------|------|-------------|
| `select_mode` | `mode` | Edit mode changed |
| `update_toolbar` | — | Toolbar updated |

## File Events

| Event | Data | Description |
|-------|------|-------------|
| `import` | `{path}` | File imported |
| `export` | `{path}` | File exported |

## UI Events

| Event | Data | Description |
|-------|------|-------------|
| `press_key` | `{event}` | Key pressed |
| `update_settings` | — | Settings changed |
| `show_panel` | `panel` | Panel shown |
| `hide_panel` | `panel` | Panel hidden |

## Plugin Events

| Event | Data | Description |
|-------|------|-------------|
| `load_plugin` | `plugin` | Plugin loaded |
| `unload_plugin` | `plugin` | Plugin unloaded |

## Example Usage

```javascript
let selectionHandler, projectHandler;

Plugin.register('my_plugin', {
    onload() {
        // Track selection changes
        selectionHandler = () => {
            console.log('Selected:', Cube.selected.length, 'cubes');
        };
        Blockbench.on('update_selection', selectionHandler);
        
        // Track project changes
        projectHandler = () => {
            console.log('Project:', Project?.name);
        };
        Blockbench.on('select_project', projectHandler);
        Blockbench.on('new_project', projectHandler);
    },
    
    onunload() {
        Blockbench.removeListener('update_selection', selectionHandler);
        Blockbench.removeListener('select_project', projectHandler);
        Blockbench.removeListener('new_project', projectHandler);
    }
});
```
