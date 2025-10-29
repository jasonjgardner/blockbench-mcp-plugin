# Blockbench Code Evaluation Safety Guide

**FOR AGENTS USING CODE EVALUATION TOOLS (e.g., `risky_eval`, code execution, REPL tools)**

## Critical Security Changes in Blockbench v5.0+

### ⚠️ BREAKING: Global Node.js APIs Removed

```javascript
// ❌ THESE NO LONGER WORK IN v5.0+
fs.readFileSync()         // undefined
os.platform()             // undefined  
child_process.spawn()     // undefined

// ✅ USE THESE INSTEAD
const fs = requireNativeModule('fs');
SystemInfo.platform
PathModule.join()         // Still global
```

## Quick Reference for Code Generation

### File System Operations
```javascript
// Always wrap in permission check
const fs = requireNativeModule('fs', {
    message: 'Describe why you need file system access'
});

if (!fs) {
    // User denied - handle gracefully
    return { error: 'File system access denied' };
}

// Now safe to use
fs.writeFileSync(path, data);
```

### System Information
```javascript
// No permission needed - USE THIS
const platform = SystemInfo.platform;        // 'win32' | 'darwin' | 'linux'
const home = SystemInfo.home_directory;
const arch = SystemInfo.arch;                // 'x64' | 'arm64'
const appdata = SystemInfo.appdata_directory;
const version = SystemInfo.os_version;
```

### Path Operations
```javascript
// No permission needed - USE THIS
const joined = PathModule.join('path', 'to', 'file');
const dirname = PathModule.dirname(path);
const basename = PathModule.basename(path);
```

### Child Process (Requires Permission)
```javascript
const child_process = requireNativeModule('child_process', {
    message: 'Execute external commands (e.g., FFmpeg for video encoding)'
});

if (!child_process) {
    return { error: 'Process execution denied' };
}

child_process.spawn('command', ['args']);
```

## Module Permission Matrix

| Module | Permission | Alternative |
|--------|-----------|-------------|
| `path` | ✅ None | Use `PathModule` |
| `crypto` | ✅ None | Direct require |
| `fs` | ⚠️ User prompt | `requireNativeModule('fs')` |
| `os` | ⚠️ User prompt | Use `SystemInfo` instead |
| `child_process` | ⚠️ User prompt | `requireNativeModule('child_process')` |
| `http/https` | ⚠️ User prompt | `requireNativeModule('https')` |

## Code Generation Template

When generating Blockbench plugin code, use this pattern:

```javascript
// ✅ SAFE PATTERN FOR v5.0+
function myFeature() {
    // 1. Check if we need native modules
    const needsFileSystem = true; // or false
    
    if (needsFileSystem) {
        // 2. Request permission with clear message
        const fs = requireNativeModule('fs', {
            message: 'Save configuration to disk'
        });
        
        // 3. Handle denial gracefully
        if (!fs) {
            Blockbench.showQuickMessage('Feature requires file system access', 2000);
            return false;
        }
        
        // 4. Use the module
        try {
            fs.writeFileSync(path, data);
            return true;
        } catch (error) {
            console.error('Failed:', error);
            return false;
        }
    }
    
    // 5. Use SystemInfo for basic system checks
    if (SystemInfo.platform === 'win32') {
        // Windows-specific code
    }
}
```

## Common Mistakes to Avoid

### ❌ Don't Do This
```javascript
// Requesting at plugin load
BBPlugin.register('my_plugin', {
    onload() {
        const fs = requireNativeModule('fs');
        const os = requireNativeModule('os');
        const cp = requireNativeModule('child_process');
        // Bombards user with 3 permission prompts!
    }
});

// Using without checking
const fs = requireNativeModule('fs');
fs.readFileSync(path); // Crashes if user denied!

// Using old globals
if (process.platform === 'win32') { // undefined in v5.0!
```

### ✅ Do This
```javascript
// Request on-demand
BBPlugin.register('my_plugin', {
    onload() {
        // Just setup, no permissions yet
        new Action('my_action', {
            click: () => this.doWork()
        });
    },
    
    doWork() {
        // Request only when needed
        const fs = requireNativeModule('fs', {
            message: 'Save your work'
        });
        
        if (!fs) {
            return; // Handle gracefully
        }
        
        // Use safely
        fs.writeFileSync(path, data);
    }
});

// Use SystemInfo instead of process/os
if (SystemInfo.platform === 'win32') {
    // Windows-specific
}
```

## Scoped File System (Enhanced Security)

For directory-specific access:

```javascript
const project_fs = requireNativeModule('fs', {
    scope: '/path/to/project',
    message: 'Access project files in /path/to/project'
});

if (project_fs) {
    // ✅ Works - inside scope
    project_fs.writeFileSync('/path/to/project/file.json', data);
    
    // ❌ Throws - outside scope  
    project_fs.writeFileSync('/etc/passwd', data);
}
```

## Evaluation Safety Checklist

Before running ANY generated code in Blockbench v5.0+:

- [ ] Uses `requireNativeModule()` instead of `require()` for native modules
- [ ] Checks if module is defined before use (`if (!module) return`)
- [ ] Uses `SystemInfo` for platform/arch/home instead of `os`/`process`
- [ ] Uses `PathModule` for path operations
- [ ] Requests permissions on-demand, not at plugin load
- [ ] Includes clear permission messages
- [ ] Handles user denial gracefully
- [ ] Avoids direct use of `fs`, `os`, `child_process` globals

## Migration Quick-Fixes

| Old Code | New Code |
|----------|----------|
| `fs.readFileSync()` | `const fs = requireNativeModule('fs'); if (fs) fs.readFileSync()` |
| `os.platform()` | `SystemInfo.platform` |
| `os.homedir()` | `SystemInfo.home_directory` |
| `process.platform` | `SystemInfo.platform` |
| `require('path')` | `PathModule` |
| At plugin load | On-demand in action handlers |

---

**Remember**: Code that works in Blockbench 4.x WILL BREAK in 5.0+ if it uses native modules. Always use the new patterns above.
