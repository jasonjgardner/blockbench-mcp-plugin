/// <reference types="three" />
/// <reference types="blockbench-types" />

import { tools, prompts } from "@/lib/factories";

// Import tool registration functions
import { registerCameraTools } from "./tools/camera";
import { registerAnimationTools } from "./tools/animation";
import { registerCubesTools } from "./tools/cubes";
import { registerElementTools } from "./tools/element";
import { registerImportTools } from "./tools/import";
import { registerMeshTools } from "./tools/mesh";
import { registerPaintTools } from "./tools/paint";
import { registerProjectTools } from "./tools/project";
import { registerTextureTools } from "./tools/texture";
import { registerUITools } from "./tools/ui";
import { registerUVTools } from "./tools/uv";
import { registerMaterialInstanceTools } from "./tools/material-instances";

// Optional plugin integrations (conditionally registered)
import { registerHytaleTools } from "./tools/hytale";
import { registerHytaleResources } from "./resources/hytale";
import { registerHytalePrompts } from "./prompts/hytale";

// All registration functions - MUST be used to prevent tree-shaking
const registrationFunctions = [
  registerAnimationTools,
  registerCameraTools,
  registerCubesTools,
  registerElementTools,
  registerImportTools,
  registerMaterialInstanceTools,
  registerMeshTools,
  registerPaintTools,
  registerProjectTools,
  registerTextureTools,
  registerUITools,
  registerUVTools,
];

// Optional plugin registration functions
// These check internally if their plugin is installed before registering
const optionalRegistrationFunctions = [
  registerHytaleTools,
  registerHytaleResources,
  registerHytalePrompts,
];

// Register all core tools immediately when this module loads
for (const register of registrationFunctions) {
  register();
}

// Register optional plugin integrations
// Each function checks if its plugin is installed before registering
for (const register of optionalRegistrationFunctions) {
  register();
}

// Function to get tool count - called at runtime after registration
export function getToolCount(): number {
  return Object.keys(tools).length;
}

// Re-export tools and prompts for use by other modules
export { tools, prompts };
