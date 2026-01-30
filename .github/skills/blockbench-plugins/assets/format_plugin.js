/**
 * Blockbench Format Plugin Template
 * Creates a custom model format with import/export
 */
(function() {
    let myFormat, myCodec, importAction, exportAction;

    BBPlugin.register('my_format_plugin', {
        title: 'My Format Support',
        author: 'Your Name',
        description: 'Adds support for .mymodel format',
        icon: 'insert_drive_file',
        version: '1.0.0',
        variant: 'both',
        min_version: '4.8.0',
        await_loading: true,  // Important for format plugins
        tags: ['Format'],
        
        onload() {
            // === CODEC (handles serialization) ===
            myCodec = new Codec('my_format_codec', {
                name: 'My Model Format',
                extension: 'mymodel',
                remember: true,
                load_filter: {
                    type: 'json',
                    extensions: ['mymodel']
                },
                
                // Export: Model → File
                compile(options) {
                    const exportData = {
                        format_version: '1.0.0',
                        model: {
                            name: Project.name || 'model',
                            textures: [],
                            bones: []
                        }
                    };
                    
                    // Export textures and build UUID-to-index map
                    const textureIndexMap = {};
                    Texture.all.forEach((texture, index) => {
                        textureIndexMap[texture.uuid] = index;
                        exportData.model.textures.push({
                            id: index,
                            name: texture.name,
                            // For embedded textures:
                            data: texture.getDataURL()
                        });
                    });

                    // Export bones (groups) and cubes
                    function exportGroup(group, parentName = null) {
                        const boneData = {
                            name: group.name,
                            parent: parentName,
                            pivot: [...group.origin],
                            rotation: [...group.rotation],
                            cubes: []
                        };
                        
                        // Export cubes in this group
                        group.children.forEach(child => {
                            if (child instanceof Cube) {
                                boneData.cubes.push({
                                    name: child.name,
                                    origin: [...child.from],
                                    size: [
                                        child.to[0] - child.from[0],
                                        child.to[1] - child.from[1],
                                        child.to[2] - child.from[2]
                                    ],
                                    pivot: [...child.origin],
                                    rotation: [...child.rotation],
                                    inflate: child.inflate,
                                    uv: child.box_uv ? child.uv_offset : null,
                                    faces: !child.box_uv ? exportFaces(child) : null
                                });
                            } else if (child instanceof Group) {
                                exportGroup(child, group.name);
                            }
                        });
                        
                        exportData.model.bones.push(boneData);
                    }
                    
                    function exportFaces(cube) {
                        const faces = {};
                        for (const [key, face] of Object.entries(cube.faces)) {
                            // Get texture by reference and map to numeric index
                            const texture = face.getTexture();
                            const textureId = texture ? textureIndexMap[texture.uuid] : null;
                            faces[key] = {
                                uv: [...face.uv],
                                texture: textureId !== undefined ? textureId : null
                            };
                        }
                        return faces;
                    }
                    
                    // Export root-level cubes
                    const rootBone = {
                        name: 'root',
                        parent: null,
                        pivot: [0, 0, 0],
                        rotation: [0, 0, 0],
                        cubes: []
                    };
                    
                    Outliner.root.forEach(element => {
                        if (element instanceof Cube) {
                            rootBone.cubes.push({
                                name: element.name,
                                origin: [...element.from],
                                size: [
                                    element.to[0] - element.from[0],
                                    element.to[1] - element.from[1],
                                    element.to[2] - element.from[2]
                                ],
                                pivot: [...element.origin],
                                rotation: [...element.rotation]
                            });
                        } else if (element instanceof Group) {
                            exportGroup(element, null);
                        }
                    });
                    
                    if (rootBone.cubes.length > 0) {
                        exportData.model.bones.unshift(rootBone);
                    }
                    
                    return JSON.stringify(exportData, null, 2);
                },
                
                // Import: File → Model
                parse(content, path) {
                    const data = JSON.parse(content);
                    
                    // Create new project with this format
                    newProject(myFormat);
                    Project.name = data.model.name || pathToName(path);
                    
                    // Import textures
                    const textureMap = {};
                    if (data.model.textures) {
                        data.model.textures.forEach(texData => {
                            const texture = new Texture({
                                name: texData.name,
                                mode: 'bitmap'
                            });
                            
                            if (texData.data) {
                                texture.fromDataURL(texData.data);
                            } else if (texData.path) {
                                texture.fromPath(texData.path);
                            }
                            
                            texture.add(false);
                            textureMap[texData.id] = texture;
                        });
                    }
                    
                    // Import bones and cubes
                    const groupMap = {};
                    
                    if (data.model.bones) {
                        // First pass: create all groups
                        data.model.bones.forEach(boneData => {
                            if (boneData.name === 'root') return;
                            
                            const group = new Group({
                                name: boneData.name,
                                origin: boneData.pivot || [0, 0, 0],
                                rotation: boneData.rotation || [0, 0, 0]
                            });
                            group.init();
                            groupMap[boneData.name] = group;
                        });
                        
                        // Second pass: establish hierarchy and add cubes
                        data.model.bones.forEach(boneData => {
                            const parent = boneData.parent ? groupMap[boneData.parent] : null;
                            const group = groupMap[boneData.name];
                            
                            if (group && parent) {
                                group.addTo(parent);
                            }
                            
                            // Add cubes
                            if (boneData.cubes) {
                                boneData.cubes.forEach(cubeData => {
                                    const cube = new Cube({
                                        name: cubeData.name || 'cube',
                                        from: cubeData.origin,
                                        to: [
                                            cubeData.origin[0] + cubeData.size[0],
                                            cubeData.origin[1] + cubeData.size[1],
                                            cubeData.origin[2] + cubeData.size[2]
                                        ],
                                        origin: cubeData.pivot || cubeData.origin,
                                        rotation: cubeData.rotation || [0, 0, 0],
                                        inflate: cubeData.inflate || 0
                                    });
                                    
                                    // Handle UV
                                    if (cubeData.uv) {
                                        cube.box_uv = true;
                                        cube.uv_offset = cubeData.uv;
                                    } else if (cubeData.faces) {
                                        cube.box_uv = false;
                                        for (const [key, faceData] of Object.entries(cubeData.faces)) {
                                            cube.faces[key].uv = faceData.uv;
                                            // Look up recreated texture by numeric ID
                                            const texture = faceData.texture !== null ? textureMap[faceData.texture] : null;
                                            cube.faces[key].texture = texture ? texture.uuid : false;
                                        }
                                    }
                                    
                                    cube.init();
                                    
                                    if (group) {
                                        cube.addTo(group);
                                    } else if (boneData.name === 'root') {
                                        cube.addTo();
                                    }
                                });
                            }
                        });
                    }
                    
                    Canvas.updateAll();
                    Blockbench.showQuickMessage('Model imported successfully');
                },
                
                // File writing (desktop only)
                write(content, path) {
                    fs.writeFileSync(path, content);
                },
                
                // Optional: filename generation
                fileName() {
                    return Project.name || 'model';
                }
            });
            
            // === FORMAT DEFINITION ===
            myFormat = new ModelFormat('my_format', {
                id: 'my_format',
                name: 'My Model Format',
                description: 'Custom model format for My Game',
                icon: 'insert_drive_file',
                category: 'other',
                target: ['My Game'],
                
                // Format capabilities
                box_uv: true,
                optional_box_uv: true,
                single_texture: false,
                bone_rig: true,
                centered_grid: false,
                rotate_cubes: true,
                integer_size: false,
                locators: false,
                meshes: false,
                animation_mode: true,
                
                // Link codec
                codec: myCodec
            });
            
            // === OPTIONAL: Manual import/export actions ===
            importAction = new Action('import_my_format', {
                name: 'Import My Format',
                icon: 'file_upload',
                category: 'file',
                click() {
                    Blockbench.import({
                        extensions: ['mymodel'],
                        type: 'My Model Format'
                    }, (files) => {
                        files.forEach(file => {
                            myCodec.parse(file.content, file.path);
                        });
                    });
                }
            });
            
            exportAction = new Action('export_my_format', {
                name: 'Export My Format',
                icon: 'file_download',
                category: 'file',
                condition: () => Format.id === 'my_format',
                click() {
                    const content = myCodec.compile();
                    Blockbench.export({
                        type: 'My Model Format',
                        extensions: ['mymodel'],
                        content: content,
                        name: myCodec.fileName()
                    });
                }
            });
            
            MenuBar.addAction(importAction, 'file.import');
            MenuBar.addAction(exportAction, 'file.export');
        },
        
        onunload() {
            myFormat.delete();
            myCodec.delete();
            importAction.delete();
            exportAction.delete();
        }
    });
    
    // Helper function
    function pathToName(path) {
        if (!path) return 'model';
        const parts = path.replace(/\\/g, '/').split('/');
        const filename = parts[parts.length - 1];
        return filename.replace(/\.[^.]+$/, '');
    }
})();
