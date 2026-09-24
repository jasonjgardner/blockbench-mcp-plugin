import { STATUS_EXPERIMENTAL } from "@/lib/constants";
import type { IToolSpec } from "@/lib/factories";
import {
  addLocatorParameters,
  createParticleEffectParameters,
  exportParticlePackParameters,
  listParticleEffectsParameters,
  listParticlePresetsParameters,
  manageParticleKeyframesParameters,
  updateParticleEffectParameters,
} from "./schemas";

/** Particle files live on disk; the web build cannot write them. */
const desktopProject = { project: true, method: () => typeof isApp !== "undefined" && isApp === true };

/**
 * Public specs for the particle tools, shared by registration and the docs
 * generator, so this array must stay free of Blockbench runtime globals
 * outside `condition` methods (which run only inside Blockbench).
 */
export const particleToolDocs: IToolSpec[] = [
  {
    name: "list_particle_presets",
    description:
      "Lists particle effect presets (smoke, fire, sparks, magic, glow, snow, drip, ...), built-in sprites and textures, materials and facing modes. Every preset uses a texture that ships with Minecraft and Blockbench, so it previews and runs with no image file. Read this before create_particle_effect.",
    annotations: { title: "List Particle Presets", readOnlyHint: true },
    parameters: listParticlePresetsParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "create_particle_effect",
    description:
      "Creates a Bedrock particle effect (the Snowstorm format Blockbench, Minecraft Bedrock and GeckoLib use) from a preset plus design knobs, or from raw JSON. Writes <pack_root>/particles/<name>.json (and an optional custom texture to textures/particle/), validates it, and loads it into Blockbench's particle preview. Then place it with manage_particle_keyframes, usually at a locator from add_locator. Refuses invalid effects and existing files unless overwrite is true. Blockbench desktop only.",
    annotations: { title: "Create Particle Effect", destructiveHint: false, openWorldHint: true },
    parameters: createParticleEffectParameters,
    condition: desktopProject,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "update_particle_effect",
    description:
      "Changes an existing particle effect file with design knobs (only the components each knob owns are rewritten) or replaces it with raw JSON, validates it, saves it and refreshes the preview. Also loads an effect file from disk that Blockbench has not seen yet. Blockbench desktop only.",
    annotations: { title: "Update Particle Effect", destructiveHint: true, openWorldHint: true },
    parameters: updateParticleEffectParameters,
    condition: desktopProject,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "list_particle_effects",
    description:
      "Lists particle effects loaded in Blockbench with their file, summary, texture status and validation warnings, every particle keyframe that uses them, keyframes that have no preview file or point at missing locators, and the client-entity particle_effects map a Bedrock pack needs.",
    annotations: { title: "List Particle Effects", readOnlyHint: true },
    parameters: listParticleEffectsParameters,
    condition: desktopProject,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "manage_particle_keyframes",
    description:
      "Adds, removes or lists particle keyframes on an animation's Effects track. A keyframe spawns an effect at a time, optionally at a locator; Blockbench previews it in Animate mode (set_mode animate, then animation_timeline set_time and capture a screenshot). Keyframes export with Bedrock and GeckoLib animations. One undo step.",
    annotations: { title: "Manage Particle Keyframes", destructiveHint: true },
    parameters: manageParticleKeyframesParameters,
    condition: { project: true, method: () => typeof Format !== "undefined" && Boolean(Format?.animation_mode) },
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "add_locator",
    description:
      "Adds a locator: a named point on a bone where particle effects (and sounds) spawn and which they follow as the bone animates. Exported as a Bedrock bone locator. Requires a format with locators (Bedrock Entity, GeckoLib, Generic Model). One undo step.",
    annotations: { title: "Add Locator", destructiveHint: false },
    parameters: addLocatorParameters,
    condition: { project: true, features: ["locators"] },
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "export_particle_pack",
    description:
      "Delivers particle effects to a Bedrock resource pack: writes particles/<name>.json and copies custom textures to textures/particle/, then returns the particle_effects map to paste into the client entity so animation keyframe names resolve. Defaults to every effect the project's keyframes use. Skips identical files; refuses to overwrite different ones unless overwrite is true. Blockbench desktop only.",
    annotations: { title: "Export Particle Pack", destructiveHint: true, openWorldHint: true },
    parameters: exportParticlePackParameters,
    condition: desktopProject,
    status: STATUS_EXPERIMENTAL,
  },
];
