/// <reference types="three" />
/// <reference types="blockbench-types" />

import { tools, prompts } from "@/lib/factories";

// Import tool registration functions
import { registerCameraTools } from "@/server/tools/camera";
import { registerCapabilityTools } from "@/server/tools/capabilities";
import { registerAnimationTools } from "@/server/tools/animation";
import { registerCubesTools } from "@/server/tools/cubes";
import { registerCubeUvTools } from "@/server/tools/cube-uv";
import { registerDisplayTools } from "@/server/tools/display";
import { registerElementTools } from "@/server/tools/element";
import { registerImportTools } from "@/server/tools/import";
import { registerKnifeTools } from "@/server/tools/knife";
import { registerMeshTools } from "@/server/tools/mesh";
import { registerMeshInspectionTools } from "@/server/tools/mesh-inspection";
import { registerModeTools } from "@/server/tools/modes";
import { registerPaintTools } from "@/server/tools/paint";
import { registerParticleTools } from "@/server/tools/particle";
import { registerPerformanceTools } from "@/server/tools/performance";
import { registerProjectTools } from "@/server/tools/project";
import { registerTextureTools } from "@/server/tools/texture";
import { registerUITools } from "@/server/tools/ui";
import { registerUVTools } from "@/server/tools/uv";
import { registerMaterialInstanceTools } from "@/server/tools/material-instances";
import { registerArmatureTools } from "@/server/tools/armature";
import { registerHistoryTools } from "@/server/tools/history";
import { registerExportTools } from "@/server/tools/export";

// Core resource registrations
import { registerValidatorResources } from "@/server/resources/validator";

// Optional plugin integrations (tool availability is checked by native conditions)
import { registerGeckolibTools } from "@/server/tools/geckolib";
import { registerHytaleTools } from "@/server/tools/hytale";
import { registerHytaleResources } from "@/server/resources/hytale";
import { registerHytalePrompts } from "@/server/prompts/hytale";

// All registration functions - MUST be used to prevent tree-shaking
const registrationFunctions = [
  registerAnimationTools,
  registerArmatureTools,
  registerCameraTools,
  registerCapabilityTools,
  registerCubesTools,
  registerCubeUvTools,
  registerDisplayTools,
  registerElementTools,
  registerExportTools,
  registerHistoryTools,
  registerImportTools,
  registerKnifeTools,
  registerMaterialInstanceTools,
  registerMeshTools,
  registerMeshInspectionTools,
  registerModeTools,
  registerPaintTools,
  registerParticleTools,
  registerPerformanceTools,
  registerProjectTools,
  registerTextureTools,
  registerUITools,
  registerUVTools,
  registerValidatorResources,
];

// Optional integration registrations: GeckoLib and Hytale tools always register
// definitions so availability can follow later plugin load/unload; resources and
// prompts retain their own registration rules.
const optionalRegistrationFunctions = [
  registerGeckolibTools,
  registerHytaleTools,
  registerHytaleResources,
  registerHytalePrompts,
];

// Register all core tools immediately when this module loads
registrationFunctions.forEach(register => register());

// Register optional plugin integrations according to their lifecycle rules.
optionalRegistrationFunctions.forEach(register => register());

/**
 * Counts registered MCP tools. Call at runtime, after this module's
 * import-time registration has run, so optional integrations are included.
 *
 * @returns Number of tool entries in the shared registry, including disabled tools.
 */
export function getToolCount(): number {
  return Object.keys(tools).length;
}

// Re-export tools and prompts for use by other modules
export { tools, prompts };
