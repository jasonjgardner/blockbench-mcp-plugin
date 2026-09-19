/// <reference types="blockbench-types" />

/**
 * GeckoLib plugin detection, project metadata, and headless compile helpers.
 *
 * The GeckoLib plugin (MIT, "GeckoLib Animation Utils") registers the
 * `geckolib_model` format for Minecraft Java mods built on the GeckoLib
 * library. Geometry rides Blockbench's Bedrock codec, animations ride the
 * Bedrock animation codec with GeckoLib's keyframe monkeypatches applied, and
 * three project properties carry the mod namespace and model type.
 *
 * Constants mirror the plugin's `src/ts/constants.ts` and `src/ts/codec.ts`.
 * Blockbench globals are only read inside functions so the docs generator can
 * import this module outside Blockbench.
 *
 * @module
 */

/** Format ID the GeckoLib plugin registers for its animated models. */
export const GECKOLIB_FORMAT_ID = "geckolib_model";

/** Plugin ID the GeckoLib plugin registers itself under. */
export const GECKOLIB_PLUGIN_ID = "geckolib";

/** `ModelProject` property holding the mod namespace exports are written for. */
export const GECKOLIB_MODID_PROPERTY = "geckolib_modid";

/** `ModelProject` property holding the GeckoLib model type. */
export const GECKOLIB_MODEL_TYPE_PROPERTY = "geckolib_model_type";

/** `ModelProject` property caching the last model/animation/display export paths. */
export const GECKOLIB_FILEPATH_CACHE_PROPERTY = "geckolib_filepath_cache";

/** GeckoLib model types, spelled as the plugin stores them on the project. */
export const GECKOLIB_MODEL_TYPES = ["Entity", "Block", "Item", "Armor", "Object"] as const;
export type GeckolibModelType = (typeof GECKOLIB_MODEL_TYPES)[number];

/** Mod namespace charset the plugin enforces on `geckolib_modid`. */
export const GECKOLIB_NAMESPACE_PATTERN = /^[_\-.a-z0-9]+$/;

/** Resource-path charset the plugin enforces on identifiers and texture paths. */
export const GECKOLIB_PATH_PATTERN = /^[_\-/.a-z0-9]+$/;

/** Blockbench's bone-name charset in `bone_rig` formats. */
export const GECKOLIB_BONE_NAME_PATTERN = /^[a-zA-Z0-9_]+$/;

/**
 * Bones the plugin's armor template ships with. GeckoLib's armor renderer
 * binds to this rig, so an Armor model that renames or drops them loses the
 * corresponding armor slot.
 */
export const GECKOLIB_ARMOR_TEMPLATE_BONES: readonly string[] = Object.freeze([
  "bipedHead",
  "bipedBody",
  "bipedRightArm",
  "bipedLeftArm",
  "bipedRightLeg",
  "bipedLeftLeg",
  "armorHead",
  "armorBody",
  "armorRightArm",
  "armorLeftArm",
  "armorRightLeg",
  "armorLeftLeg",
  "armorRightBoot",
  "armorLeftBoot",
]);

/** A Blockbench keyframe carrying GeckoLib's easing fields. */
export interface IGeckolibKeyframe extends BBKeyframe {
  easing?: string | null;
  easingArgs?: number[];
}

/** Installed-plugin entry shape both plugin registries expose. */
interface IPluginEntry {
  id?: string;
  version?: string;
  disabled?: boolean;
}

/** Reads both plugin registries: loaded instances first, then disk records. */
function getPluginEntries(): IPluginEntry[] {
  // @ts-ignore - Plugins is a Blockbench global
  if (typeof Plugins === "undefined") return [];
  // @ts-ignore - Plugins.all holds loaded instances, Plugins.installed the disk records
  return [...(Plugins.all ?? []), ...(Plugins.installed ?? [])] as IPluginEntry[];
}

/** Whether the GeckoLib plugin is present and not disabled. */
export function isGeckolibPluginInstalled(): boolean {
  return getPluginEntries().some((entry) => entry.id === GECKOLIB_PLUGIN_ID && !entry.disabled);
}

/**
 * Version of the installed GeckoLib plugin, or `null` when it is absent or
 * reports no version. Validation surfaces this so a rule set verified against
 * one plugin release is not silently trusted for another.
 */
export function getGeckolibPluginVersion(): string | null {
  const entry = getPluginEntries().find(
    (candidate) => candidate.id === GECKOLIB_PLUGIN_ID && typeof candidate.version === "string"
  );
  return entry?.version ?? null;
}

/** Whether the active project uses the GeckoLib format. */
export function isGeckolibFormat(): boolean {
  // @ts-ignore - Format is a Blockbench global
  if (typeof Format === "undefined" || !Format?.id) return false;
  // @ts-ignore - Format is a Blockbench global
  return Format.id === GECKOLIB_FORMAT_ID;
}

/**
 * Throws unless a GeckoLib project is active. Every GeckoLib tool starts here
 * so a wrong-format project fails with one actionable message instead of
 * writing plugin-specific fields into an unrelated model.
 */
export function assertGeckolibFormat(): void {
  if (isGeckolibFormat()) return;
  if (!isGeckolibPluginInstalled()) {
    throw new Error(
      'The GeckoLib plugin is not installed or is disabled. Install "GeckoLib Animation Utils" from Blockbench’s plugin store, then create a GeckoLib Animated Model project.'
    );
  }
  throw new Error(
    "The current project does not use the GeckoLib Animated Model format. Create or open a GeckoLib project first."
  );
}

/** Reads a string-valued project property, or `null` when unset or empty. */
function getProjectString(property: string): string | null {
  // @ts-ignore - Project is a Blockbench global
  if (typeof Project === "undefined" || !Project) return null;
  const value = (Project as unknown as Record<string, unknown>)[property];
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

/** Mod namespace the project exports under, or `null` when unset. */
export function getGeckolibModid(): string | null {
  return getProjectString(GECKOLIB_MODID_PROPERTY);
}

/**
 * GeckoLib model type of the project. The plugin defaults new projects to
 * `Entity`, so an unset property is reported as `null` rather than guessed.
 */
export function getGeckolibModelType(): GeckolibModelType | null {
  const value = getProjectString(GECKOLIB_MODEL_TYPE_PROPERTY);
  if (!value) return null;
  return GECKOLIB_MODEL_TYPES.find((type) => type.toLowerCase() === value.toLowerCase()) ?? null;
}

/**
 * Registered object ID the geometry exports as (`geometry.<identifier>`), or
 * `null` when the project has none.
 */
export function getGeckolibIdentifier(): string | null {
  return getProjectString("model_identifier");
}

/** Last export paths the plugin cached on the project, for reporting. */
export function getGeckolibFilepathCache(): { model?: string; animation?: string; display?: string } {
  // @ts-ignore - Project is a Blockbench global
  if (typeof Project === "undefined" || !Project) return {};
  const cache = (Project as unknown as Record<string, unknown>)[GECKOLIB_FILEPATH_CACHE_PROPERTY];
  if (!cache || typeof cache !== "object") return {};
  return cache as { model?: string; animation?: string; display?: string };
}

/** Bone names of the active project's outliner groups, in outliner order. */
export function getProjectBoneNames(): string[] {
  // @ts-ignore - Group is a Blockbench global
  if (typeof Group === "undefined") return [];
  // @ts-ignore - Group.all holds every group of the active project
  return ((Group.all ?? []) as Group[]).map((group) => group.name);
}

/**
 * Compiles the project geometry the way the plugin's "Export GeckoLib Model"
 * action does, without opening a save dialog. GeckoLib exports geometry through
 * Blockbench's Bedrock codec unchanged; only animations carry its patches.
 *
 * @returns The parsed `minecraft:geometry` document.
 * @throws When the Bedrock codec is unavailable or returns unusable content.
 */
export function compileGeckolibGeometry(): unknown {
  // @ts-ignore - Codecs is a Blockbench global
  const codec = typeof Codecs === "undefined" ? undefined : Codecs.bedrock;
  if (!codec || typeof codec.compile !== "function") {
    throw new Error("Blockbench's bedrock codec is unavailable; cannot compile GeckoLib geometry.");
  }
  const compiled: unknown = codec.compile({ raw: true });
  if (typeof compiled !== "string") return compiled;
  try {
    return JSON.parse(compiled);
  } catch {
    throw new Error("The bedrock codec returned geometry that is not valid JSON.");
  }
}

/** Compiled animation content and the host API that produced it. */
export interface IGeckolibAnimationCompile {
  content: unknown;
  /** `animator_build_file` also ran the GeckoLib plugin's own export patch. */
  via: "animator_build_file" | "animation_codec";
}

/**
 * Compiles animations into GeckoLib animation-file content, which is where the
 * plugin's keyframe patches write `easing` and `easingArgs`.
 *
 * `Animator.buildFile` is tried first, and not because it is the newer API — it
 * is deprecated in Blockbench 5.1+, where it is a thin shim over
 * `AnimationCodec.codecs.bedrock.compileFile`. The GeckoLib plugin patches
 * `Animator.buildFile`, so that route is the only one that also applies its
 * export patch: stamping `geckolib_format_version` and resolving bezier
 * keyframes. Calling the codec directly (as Blockbench's own export action now
 * does) silently drops both. The codec is the fallback for hosts that removed
 * the shim.
 *
 * The plugin's patch indexes into the name filter, so a name array is always
 * passed. It also pre-marks bezier keyframes for the first name only, matching
 * the plugin's own multi-animation export.
 *
 * @param animations - Animations to include; all project animations by default.
 * @returns The compiled document and the API that produced it.
 * @throws When no animation compiler exists in this Blockbench build.
 */
export function compileGeckolibAnimationFile(animations?: readonly BBAnimation[]): IGeckolibAnimationCompile {
  // @ts-ignore - libdom's Animation shadows the Blockbench class declaration
  const all: BBAnimation[] = animations ? [...animations] : ((Animation as unknown as typeof BBAnimation).all ?? []);
  // @ts-ignore - Animator is a Blockbench global
  if (typeof Animator !== "undefined" && typeof Animator.buildFile === "function") {
    // @ts-ignore - buildFile(path_filter, name_filter) filters by animation name
    return { content: Animator.buildFile(null, all.map((animation) => animation.name)), via: "animator_build_file" };
  }
  // @ts-ignore - AnimationCodec exists in Blockbench 5.1+
  const codec = typeof AnimationCodec === "undefined" ? undefined : AnimationCodec.getCodec?.();
  if (codec && typeof codec.compileFile === "function") {
    return { content: codec.compileFile(all), via: "animation_codec" };
  }
  throw new Error("This Blockbench build exposes no animation file compiler (Animator.buildFile or AnimationCodec).");
}
