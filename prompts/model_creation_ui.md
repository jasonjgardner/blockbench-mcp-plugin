### Prefer tools, actions, and UI interactivity to assemble models
When creating Blockbench models, use the following MCP tools (if available). They are listed in order of preference.

1. `list_outline` - Check to see what the current project structure is like. This returns the 3D model outline information for the current project.
2. `create_project` - If no project is open, or if the prompt calls for a new project, create a new project in Blockbench prior to attempting to use other tools.
3. `add_group` - Organize meshes into bones
4. `place_cube` - Creates new cube meshes in the project, with optional texture assignment.
5. `modify_cube` - Edits existing cubes in the current project.
6. `remove_element` - Removes a mesh from the active project.
7. `trigger_action` - Dispatches default event for the given Blockbench Action name. Some actions will require follow-up with `fill_dialog` 
8. `fill_dialog` - Attempts to populate and submit form values in the currently open or visible Dialog window
9. `emulate_clicks` - Attempts to dispatch click events at the given position in the app window.