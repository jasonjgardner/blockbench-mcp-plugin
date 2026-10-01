/// <reference types="blockbench-types" />

/**
 * Builds the Java item/block display-settings JSON that GeckoLib Item and Block
 * models ship alongside their geometry.
 *
 * GeckoLib reuses the vanilla Java model envelope for display settings: a
 * `parent` model, optional texture size and GUI light, the per-perspective
 * display transforms, and a single `particle` texture reference namespaced with
 * the project's mod ID. Adapted from the GeckoLib Blockbench plugin's
 * `buildDisplaySettingsJson` (MIT, `src/ts/codec.ts`, plugin 4.2.x) with the
 * `Blockbench.export()` save dialog removed so the content can be returned to
 * an MCP client instead.
 *
 * @module
 */

import { GECKOLIB_PATH_PATTERN, getGeckolibModelType, getGeckolibModid } from "./geckolib";

/** Setting the plugin exposes to guess the particle texture of single-texture models. */
const SETTING_AUTO_PARTICLE_TEXTURE = "geckolib_auto_particle_texture";

/**
 * Parent the GeckoLib plugin writes when the project has none, and forces onto
 * Item models. Minecraft Java 1.21.3 and older render such items through it.
 */
export const GECKOLIB_DEFAULT_DISPLAY_PARENT = "builtin/entity";

/**
 * Parent written to the display file: the requested one (an empty string means
 * none), else the project's own, else the plugin's default.
 */
export function resolveDisplayParent(project: ModelProject, requested?: string): string {
  return requested ?? (project.parent || GECKOLIB_DEFAULT_DISPLAY_PARENT);
}

/**
 * Whether a parent is `builtin/entity`, which Minecraft Java 1.21.4 removed:
 * from then on (26.3 included) the model loader only provides
 * builtin/generated and builtin/missing, so the game reports a missing model
 * and the file inherits nothing from it.
 */
export function isRemovedBuiltinEntityParent(parent: string): boolean {
  return parent === GECKOLIB_DEFAULT_DISPLAY_PARENT || parent === `minecraft:${GECKOLIB_DEFAULT_DISPLAY_PARENT}`;
}

/** Reads a Blockbench setting's value without assuming the setting exists. */
function getSettingValue(id: string): unknown {
  // @ts-ignore - settings is a Blockbench global
  if (typeof settings === "undefined") return undefined;
  // @ts-ignore - settings entries expose a value field
  return settings[id]?.value;
}

/** Non-default display transforms, keyed by perspective slot. */
function buildDisplayTransforms(project: ModelProject): Record<string, unknown> {
  // @ts-ignore - DisplayMode is a Blockbench global
  if (typeof DisplayMode === "undefined") return {};
  // @ts-ignore - DisplayMode.slots lists the perspective keys in display order
  const slots: string[] = Object.values(DisplayMode.slots ?? {});
  return Object.fromEntries(
    slots.flatMap((perspective) => {
      const slot = project.display_settings?.[perspective];
      const exported = slot?.export?.();
      return exported ? [[perspective, exported]] : [];
    })
  );
}

/**
 * Namespaced `item/`-or-`block/` particle texture path for the project, or
 * `null` when no texture qualifies. A texture whose name cannot be reduced to
 * a valid resource path is skipped rather than exported as a broken reference.
 */
function buildParticleTexture(project: ModelProject): string | null {
  const modid = getGeckolibModid();
  if (!modid) return null;
  const textures = project.textures ?? [];
  const autoParticle = getSettingValue(SETTING_AUTO_PARTICLE_TEXTURE) === true && textures.length === 1;
  const texture = textures.find((candidate) => candidate.particle) ?? (autoParticle ? textures[0] : undefined);
  if (!texture) return null;
  const bare = texture.name.replace(/\.png$/i, "");
  const normalized = GECKOLIB_PATH_PATTERN.test(bare)
    ? bare
    : bare.toLowerCase().replace(/\s+/g, "_");
  if (!GECKOLIB_PATH_PATTERN.test(normalized)) return null;
  const folder = getGeckolibModelType() === "Block" ? "block/" : "item/";
  return `${modid}:${folder}${normalized}`;
}

/**
 * Compiles the display-settings document for the active project.
 *
 * @param project - The active Blockbench project.
 * @param parent - Parent model to write instead of the project's; an empty
 *   string writes none. See {@link resolveDisplayParent}.
 * @returns The display-settings JSON object, ready to stringify.
 */
export function buildGeckolibDisplaySettings(project: ModelProject, parent?: string): Record<string, unknown> {
  const transforms = buildDisplayTransforms(project);
  const particle = buildParticleTexture(project);
  const resolvedParent = resolveDisplayParent(project, parent);
  return {
    ...(getSettingValue("credit") ? { credit: getSettingValue("credit") } : {}),
    ...(resolvedParent ? { parent: resolvedParent } : {}),
    ...(project.ambientocclusion === false ? { ambientocclusion: false } : {}),
    ...(project.texture_width !== 16 || project.texture_height !== 16
      ? { texture_size: [project.texture_width, project.texture_height] }
      : {}),
    ...(project.front_gui_light ? { gui_light: "front" } : {}),
    ...(project.overrides ? { overrides: project.overrides } : {}),
    ...(Object.keys(transforms).length ? { display: transforms } : {}),
    ...(particle ? { textures: { particle } } : {}),
  };
}
