import type { RenderOptions } from "./options";

/** One light in a preset, placed relative to a camera looking at the model's front. */
export interface ILightSpec {
  type: "directional" | "hemisphere" | "ambient";
  color: number;
  intensity: number;
  /** Unit-ish direction from the model toward the light; scaled by the model radius. */
  direction?: readonly [number, number, number];
  groundColor?: number;
  castShadow?: boolean;
}

/** A named light rig plus how strongly the built-in studio environment contributes. */
export interface ILightingPreset {
  lights: readonly ILightSpec[];
  /** Strength of the built-in studio environment; 0 disables it. */
  room: number;
}

/**
 * Lighting presets. Directions are expressed for the front view and rotate with the camera.
 *
 * Kept free of three.js so the WebGPU stage and the browser path tracer build the same rig.
 */
export const LIGHTING_PRESETS: Record<RenderOptions["lighting"]["preset"], ILightingPreset> = {
  studio: {
    room: 0.55,
    lights: [
      { type: "directional", color: 0xffffff, intensity: 2.6, direction: [-0.7, 1.1, -0.9], castShadow: true },
      { type: "directional", color: 0xcfe0ff, intensity: 0.9, direction: [0.9, 0.5, -0.3] },
      { type: "directional", color: 0xffffff, intensity: 1.4, direction: [0.3, 0.8, 1.0] },
    ],
  },
  outdoor: {
    room: 0,
    lights: [
      { type: "hemisphere", color: 0xcfe3ff, groundColor: 0x5b4a3a, intensity: 1.3 },
      { type: "directional", color: 0xfff1dc, intensity: 3.2, direction: [-0.5, 1.2, -0.6], castShadow: true },
    ],
  },
  flat: {
    room: 0,
    lights: [{ type: "ambient", color: 0xffffff, intensity: 1.0 }],
  },
};

/** Opacity of the WebGPU `ShadowMaterial` ground, which only darkens where the key light is blocked. */
export const SHADOW_GROUND_OPACITY = 0.35;

/**
 * Strength of the path tracer's shadow catcher. Its shadow term is the traced light the model
 * blocks, fill and environment included, so a key-light shadow only removes about half of the
 * ground's light. Scaling that by 0.65 lands near {@link SHADOW_GROUND_OPACITY} under the key light
 * while keeping the soft contact shadows only path tracing produces.
 */
export const PATHTRACE_SHADOW_OPACITY = 0.65;
