# Blockbench v5.0 Native API Security Model

**CRITICAL: Read this carefully before using any Node.js APIs or native modules in Blockbench plugins.**

## Overview

Blockbench v5.0 introduces a new security model that significantly changes how plugins access native Node.js APIs. These changes give users more control and trust over plugin capabilities.

## Key Changes from Previous Versions

### 1. Global Module Variables Removed

- **OLD (pre-v5.0)**: All Node.js APIs were globally available (e.g., `fs`, `os`, `child_process`)
- **NEW (v5.0+)**: Most global variables have been removed
- **EXCEPTION**: `PathModule` is still globally available for Node's `path` module

### 2. Module Access via `requireNativeModule()`

Use the new `requireNativeModule()` function instead of `require()` for better TypeScript support:

```javascript
// TypeScript-friendly with proper type support
const os = requireNativeModule('os');

// Add custom permission message
const child_process = requireNativeModule('child_process', {
    message: 'This permission is required to open ffmpeg and encode the video.'
});
```

**IMPORTANT**: `requireNativeModule()` will:
- Open a user permission prompt for restricted modules
- Return the module **synchronously** if the user accepts
- Return `undefined` if the user denies
- Always check if the module is defined before use!

### 3. Module Categories

#### Safe Modules (No Permission Required)
These can be required without user confirmation:
- `path`
- `crypto`
- `events`
- `zlib`
- `timers`
- `url`
- `string_decoder`
- `querystring`

#### Restricted Modules (Require User Permission)
These prompt the user for permission:
- `fs` (File System - see scoped access below)
- `child_process`
- `electron`
- `https`
- `net`
- `tls`
- `util`
- `os`
- `v8`

### 4. Scoped File System Access

The `fs` module is now limited. For even more restrictive access, use **scoped file systems**:

```javascript
// Request scoped fs access to specific directory
const scoped_fs = requireNativeModule('fs', {
    scope: 'C:/path/to/directory'
});

if (scoped_fs) {
    // ✅ Will succeed - inside scope
    scoped_fs.writeFileSync('C:/path/to/directory/file.json', 'hello world');
    
    // ❌ Will throw error - outside scope
    scoped_fs.writeFileSync('C:/foo/bar.json', 'hello world');
}
```

**Benefits**:
- Gives users more control over file access
- Builds trust by limiting plugin scope
- Prevents accidental or malicious file system access

### 5. Limited File System Capabilities

Even with permission, the `fs` module has reduced capabilities:
- ✅ Reading and writing files is allowed
- ❌ Advanced operations like modifying file permissions are NOT available

### 6. SystemInfo Interface

For basic system information, use the new `SystemInfo` global instead of requiring `os` or `process`:

```javascript
// Available properties:
SystemInfo.platform          // 'win32' | 'darwin' | 'linux'
SystemInfo.home_directory    // 'path/to/home'
SystemInfo.arch             // 'x64' | 'arm64'
SystemInfo.appdata_directory // 'C:\\Users\\Name\\AppData\\Roaming'
SystemInfo.os_version       // 'Windows 11 Home', etc.
```

## Best Practices for Plugin Development

### 1. Request Permissions On-Demand

**DON'T** request modules during plugin load:
```javascript
// ❌ BAD - Bombards user with prompts on install
BBPlugin.register('my_plugin', {
    onload() {
        const fs = requireNativeModule('fs');
        const os = requireNativeModule('os');
        const child_process = requireNativeModule('child_process');
    }
});
```

**DO** request when actually needed:
```javascript
// ✅ GOOD - User knows why permission is needed
BBPlugin.register('my_plugin', {
    onload() {
        // Setup without requiring modules
    }
});

function exportModel() {
    const fs = requireNativeModule('fs', {
        message: 'File system access needed to save your model.'
    });
    
    if (!fs) {
        Blockbench.showQuickMessage('Export cancelled - file system access denied', 2000);
        return;
    }
    
    // Proceed with export...
}
```

### 2. Always Check for undefined

```javascript
const os = requireNativeModule('os');

// ✅ ALWAYS check before use
if (!os) {
    console.warn('OS module access denied');
    return;
}

// Now safe to use
const platform = os.platform();
```

### 3. Use Scoped Access When Possible

If you only need access to specific directories, use scoped file systems:

```javascript
// Instead of full fs access
const project_dir = 'C:/Users/Name/Projects/MyProject';
const scoped_fs = requireNativeModule('fs', {
    scope: project_dir,
    message: 'Access needed to read/write project files in ' + project_dir
});

if (scoped_fs) {
    // Limited to project_dir only - safer!
    scoped_fs.writeFileSync(PathModule.join(project_dir, 'output.json'), data);
}
```

### 4. Provide Clear Permission Messages

```javascript
const child_process = requireNativeModule('child_process', {
    message: 'This plugin needs to run FFmpeg to encode your animation as a video file.'
});
```

### 5. Use SystemInfo for Basic Info

```javascript
// ✅ No permission needed
if (SystemInfo.platform === 'win32') {
    // Windows-specific code
}

// ❌ Requires permission unnecessarily
const os = requireNativeModule('os');
if (os?.platform() === 'win32') {
    // Windows-specific code
}
```

## Example: Safe Plugin Structure

```javascript
BBPlugin.register('safe_exporter', {
    title: 'Safe Model Exporter',
    onload() {
        // Minimal setup - no permissions yet
        new Action('export_custom', {
            name: 'Export Custom Format',
            icon: 'save',
            click: () => this.exportModel()
        });
    },
    
    exportModel() {
        // Request permission only when needed
        const fs = requireNativeModule('fs', {
            message: 'Save your model to disk'
        });
        
        if (!fs) {
            Blockbench.showMessageBox({
                title: 'Permission Required',
                message: 'File system access is required to save the model.'
            });
            return;
        }
        
        // Proceed with export
        try {
            const data = this.generateModelData();
            fs.writeFileSync(this.getExportPath(), data);
            Blockbench.showQuickMessage('Export successful!', 2000);
        } catch (error) {
            console.error('Export failed:', error);
            Blockbench.showQuickMessage('Export failed', 2000);
        }
    }
});
```

## Migration from Pre-v5.0 Plugins

| Old (Pre-v5.0) | New (v5.0+) |
|----------------|-------------|
| `fs.readFileSync()` | `const fs = requireNativeModule('fs'); if (fs) fs.readFileSync()` |
| `os.platform()` | `SystemInfo.platform` |
| `process.cwd()` | Use Blockbench APIs or SystemInfo |
| `require('path')` | `PathModule` (still global) |
| Module at load time | Module on-demand with permission check |

## Summary Checklist

When using native APIs in Blockbench v5.0 plugins:

- [ ] Use `requireNativeModule()` instead of `require()`
- [ ] Always check if module is defined before use
- [ ] Request permissions on-demand, not during plugin load
- [ ] Provide clear permission messages
- [ ] Use `SystemInfo` for basic system info instead of `os`
- [ ] Consider scoped file system access for better security
- [ ] Use `PathModule` for path operations (no permission needed)
- [ ] Test with user denying permissions to ensure graceful failures

---

**Remember**: These changes improve user trust and security. Embrace them to build better, safer plugins!
