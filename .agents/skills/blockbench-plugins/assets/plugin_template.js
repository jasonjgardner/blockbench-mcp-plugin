/**
 * Blockbench Plugin Template
 * Replace 'my_plugin' with your plugin ID (must match filename)
 */
(function() {
    // Store ALL component references for cleanup
    let mainAction, settingsAction, mainPanel, settingsDialog;
    let selectionCallback, projectCallback;
    let customCSS;

    Plugin.register('my_plugin', {
        title: 'My Plugin',
        author: 'Your Name',
        description: 'A brief description of what this plugin does',
        icon: 'extension',
        version: '1.0.0',
        variant: 'both',
        min_version: '4.8.0',
        tags: ['Utility'],
        
        onload() {
            // === ACTIONS ===
            mainAction = new Action('my_plugin_main', {
                name: 'Main Action',
                description: 'Performs the main plugin function',
                icon: 'play_arrow',
                category: 'filter',
                condition: () => Cube.selected.length > 0,
                keybind: new Keybind({ key: 'm', ctrl: true, shift: true }),
                click() {
                    performMainFunction();
                }
            });
            
            settingsAction = new Action('my_plugin_settings', {
                name: 'Plugin Settings',
                description: 'Configure plugin options',
                icon: 'settings',
                click() {
                    settingsDialog.show();
                }
            });
            
            // Add to menus
            MenuBar.addAction(mainAction, 'filter');
            MenuBar.addAction(settingsAction, 'filter');
            
            // === DIALOGS ===
            settingsDialog = new Dialog({
                id: 'my_plugin_settings_dialog',
                title: 'Plugin Settings',
                width: 400,
                form: {
                    intensity: {
                        label: 'Intensity',
                        type: 'number',
                        value: 1.0,
                        min: 0,
                        max: 10,
                        step: 0.1
                    },
                    mode: {
                        label: 'Mode',
                        type: 'select',
                        options: {
                            simple: 'Simple',
                            advanced: 'Advanced'
                        },
                        value: 'simple'
                    },
                    preview: {
                        label: 'Live Preview',
                        type: 'checkbox',
                        value: true
                    }
                },
                onConfirm(formData) {
                    // Save settings
                    localStorage.setItem('my_plugin_settings', JSON.stringify(formData));
                    Blockbench.showQuickMessage('Settings saved');
                    this.hide();
                }
            });
            
            // === PANELS ===
            mainPanel = new Panel('my_plugin_panel', {
                name: 'My Plugin',
                icon: 'extension',
                condition: () => Project,
                default_position: {
                    slot: 'right_bar',
                    height: 200
                },
                component: {
                    template: `
                        <div class="my-plugin-panel">
                            <p>Selected: {{ selectedCount }} elements</p>
                            <div class="button-row">
                                <button @click="runAction">Run</button>
                                <button @click="refresh">Refresh</button>
                            </div>
                        </div>
                    `,
                    data() {
                        return {
                            selectedCount: 0
                        };
                    },
                    methods: {
                        runAction() {
                            performMainFunction();
                        },
                        refresh() {
                            this.selectedCount = Outliner.selected.length;
                        }
                    },
                    mounted() {
                        this.refresh();
                    }
                }
            });
            
            // === EVENT LISTENERS ===
            selectionCallback = () => {
                if (mainPanel.isVisible) {
                    mainPanel.vue.refresh();
                }
            };
            Blockbench.on('update_selection', selectionCallback);
            
            projectCallback = () => {
                // React to project changes
            };
            Blockbench.on('select_project', projectCallback);
            
            // === CUSTOM CSS ===
            customCSS = Blockbench.addCSS(`
                .my-plugin-panel {
                    padding: 8px;
                }
                .my-plugin-panel .button-row {
                    display: flex;
                    gap: 8px;
                    margin-top: 8px;
                }
            `);
        },
        
        onunload() {
            // CRITICAL: Delete everything in reverse order
            mainAction.delete();
            settingsAction.delete();
            mainPanel.delete();
            settingsDialog.hide();
            
            Blockbench.removeListener('update_selection', selectionCallback);
            Blockbench.removeListener('select_project', projectCallback);
            
            customCSS.delete();
        },
        
        oninstall() {
            Blockbench.showQuickMessage('My Plugin installed!', 2000);
        },
        
        onuninstall() {
            localStorage.removeItem('my_plugin_settings');
        }
    });
    
    // === PLUGIN FUNCTIONS ===
    function performMainFunction() {
        if (Cube.selected.length === 0) {
            Blockbench.showQuickMessage('No cubes selected', 1500);
            return;
        }
        
        // Load settings
        let settings = { intensity: 1.0 };
        try {
            const saved = localStorage.getItem('my_plugin_settings');
            if (saved) settings = JSON.parse(saved);
        } catch (e) {}
        
        // Start undo tracking
        Undo.initEdit({ elements: Cube.selected });
        
        // Perform modifications
        Cube.selected.forEach(cube => {
            // Example: Scale cube by intensity
            const center = [
                (cube.from[0] + cube.to[0]) / 2,
                (cube.from[1] + cube.to[1]) / 2,
                (cube.from[2] + cube.to[2]) / 2
            ];
            
            for (let i = 0; i < 3; i++) {
                cube.from[i] = center[i] + (cube.from[i] - center[i]) * settings.intensity;
                cube.to[i] = center[i] + (cube.to[i] - center[i]) * settings.intensity;
            }
        });
        
        // Update view
        Canvas.updateView({
            elements: Cube.selected,
            element_aspects: { geometry: true }
        });
        
        // Commit to undo history
        Undo.finishEdit('My Plugin: Scale cubes');
        
        Blockbench.showQuickMessage(`Processed ${Cube.selected.length} cubes`);
    }
})();
