/**
 * Shared pieces of the Java block/item model codec port: format-version flags,
 * display-slot normalization, texture links and small JSON guards.
 *
 * Blockbench keeps these on live objects (`Project.java_block_version`,
 * `DisplaySlot`, `Texture.javaTextureLink`). The headless compiler, importer and
 * the format rules all need the same answers from plain `.bbmodel` JSON, so they
 * live here once.
 *
 * @module
 */

import { compareVersions } from "../document/legacy";
import type { IBBModel, ITexture, Vec3 } from "../document/schema";

/** Plain JSON object. */
export type Json = Record<string, unknown>;

/** Axis letter as Java block models write it. */
export type AxisLetter = "x" | "y" | "z";

/** Axis letters by vector index. */
export const AXIS_LETTERS: readonly AxisLetter[] = ["x", "y", "z"];

/**
 * Java block version Blockbench assigns to new projects with the default
 * `default_java_block_version: latest` setting (`java_block_version` property in
 * js/io/project.ts). A document without `java_block_version` behaves as this.
 */
export const DEFAULT_JAVA_BLOCK_VERSION = "26.3";

/** Versions offered by Blockbench's project dialog (js/io/project.ts, `java_block_version` options). */
export const JAVA_BLOCK_VERSIONS = ["1.9.0", "1.21.6", "1.21.11", "26.3"] as const;

/**
 * Element coordinate range of the Java block format's `cube_size_limiter`
 * (`coordinate_limits` in js/formats/java/java_block.ts). The `block_limits` gate
 * in `../gates/geometry` uses the same range but keeps it private.
 */
export const JAVA_COORDINATE_LIMITS: readonly [number, number] = [-16, 32];

/** Parents that make a model a generated item (`ITEM_PARENTS` in java_block.ts). */
export const ITEM_PARENTS: readonly string[] = [
  "item/generated", "minecraft:item/generated",
  "item/handheld", "minecraft:item/handheld",
  "item/handheld_rod", "minecraft:item/handheld_rod",
  "builtin/generated", "minecraft:builtin/generated",
];

/** Display slots in Blockbench's order (`displayReferenceObjects.slots` in js/display_mode/display_mode.js). */
export const DISPLAY_SLOTS = [
  "thirdperson_righthand",
  "thirdperson_lefthand",
  "firstperson_righthand",
  "firstperson_lefthand",
  "ground",
  "gui",
  "head",
  "embedded",
  "fixed",
  "on_shelf",
] as const;

/** Rotation behavior that depends on the project's Java block version. */
export interface IJavaVersionFlags {
  /** The version string the flags were derived from. */
  version: string;
  /** One rotation axis and angles within ±45° (`rotation_limit` getter in java_block.ts: version below 1.21.11). */
  rotation_limit: boolean;
  /** Angles snap to 22.5° steps (`rotation_snap` getter: version exactly 1.9.0). */
  rotation_snap: boolean;
  /** Cubes use `shade_direction_override` instead of `shade` (getter: version 26.3 or newer). */
  shade_direction_override: boolean;
}

const VERSION_PATTERN = /^\d+(\.\d+)*$/;

/** Narrows to a plain JSON object. */
export const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** A finite number, or `undefined`. */
export const numberOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/**
 * Blockbench's `Merge.number`: numbers pass, numeric strings are parsed, the rest is ignored.
 *
 * @returns The merged number, or `fallback` when the source value is unusable.
 */
export function mergeNumber(value: unknown, fallback: number): number {
  if (typeof value === "number") return Number.isNaN(value) ? fallback : value;
  const parsed = typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Merges a 3-vector the way `Merge.number` does per index. */
export function mergeVec3(value: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(value)) return [...fallback];
  return [mergeNumber(value[0], fallback[0]), mergeNumber(value[1], fallback[1]), mergeNumber(value[2], fallback[2])];
}

/**
 * Version comparison with Blockbench's `VersionUtil.compare` failure mode: an
 * unparsable version makes the comparison throw, which the format getters catch.
 *
 * @returns `undefined` when either side is not a dotted number.
 */
function compareJavaVersions(a: string, b: string): number | undefined {
  if (!VERSION_PATTERN.test(a) || !VERSION_PATTERN.test(b)) return undefined;
  return compareVersions(a, b);
}

/** The document's Java block version, falling back to {@link DEFAULT_JAVA_BLOCK_VERSION}. */
export function javaBlockVersionOf(doc: IBBModel): string {
  const value = (doc as Json).java_block_version;
  return typeof value === "string" && value !== "" ? value : DEFAULT_JAVA_BLOCK_VERSION;
}

/**
 * Rotation and shading flags for a Java block version, ported from the
 * `Object.defineProperty(format, ...)` getters at the end of java_block.ts.
 */
export function javaVersionFlags(version: string): IJavaVersionFlags {
  const vsFreeRotation = compareJavaVersions(version, "1.21.11");
  const vsShadeOverride = compareJavaVersions(version, "26.3");
  return {
    version,
    rotation_limit: vsFreeRotation === undefined ? true : vsFreeRotation < 0,
    rotation_snap: version === "1.9.0",
    shade_direction_override: vsShadeOverride === undefined ? false : vsShadeOverride >= 0,
  };
}

/** `version < other`, treating unparsable versions as not lower (VersionUtil throws there). */
export function javaVersionBelow(version: string, other: string): boolean {
  const result = compareJavaVersions(version, other);
  return result !== undefined && result < 0;
}

/** Blockbench's `Math.trimDeg`: wraps an angle into [-180, 180). */
export const trimDeg = (angle: number): number => ((angle + 180 * 15) % 360) - 180;

/**
 * One display slot through `DisplaySlot.extend` then `DisplaySlot.export` (Java
 * variant) from js/display_mode/display_mode.js: scales become absolute with the
 * sign kept as a mirror flag, rotations wrap to ±180, and only non-default
 * channels are written.
 *
 * @returns The exported slot, or `undefined` when every channel is at its default.
 */
export function normalizeDisplaySlot(raw: unknown): Json | undefined {
  if (!isJson(raw)) return undefined;
  const channel = (key: string, fallback: Vec3): Vec3 => mergeVec3(raw[key], fallback);
  const rawScale = Array.isArray(raw.scale) ? raw.scale : [];
  const rawMirror = Array.isArray(raw.mirror) ? raw.mirror : [];
  const scale = channel("scale", [1, 1, 1]).map(Math.abs);
  const rotation = channel("rotation", [0, 0, 0]).map(trimDeg);
  const mirror = [0, 1, 2].map((i) => (typeof rawMirror[i] === "boolean" ? rawMirror[i] === true : false) || (typeof rawScale[i] === "number" && rawScale[i] < 0));
  const translation = channel("translation", [0, 0, 0]);
  const rotationPivot = channel("rotation_pivot", [0, 0, 0]);
  const scalePivot = channel("scale_pivot", [0, 0, 0]);
  const anyMirror = mirror.some(Boolean);
  const build: Json = {
    ...(rotation.some((v) => v !== 0) ? { rotation } : {}),
    ...(translation.some((v) => v !== 0) ? { translation } : {}),
    ...(scale.some((v) => v !== 1) || anyMirror ? { scale: scale.map((v, i) => (mirror[i] ? -v : v)) } : {}),
    ...(rotationPivot.some((v) => v !== 0) ? { rotation_pivot: rotationPivot } : {}),
    ...(scalePivot.some((v) => v !== 0) ? { scale_pivot: scalePivot } : {}),
  };
  return Object.keys(build).length > 0 ? build : undefined;
}

/**
 * A `display` object with every known slot normalized, in slot order
 * (`DisplayMode.loadJSON` + the display loop of the codec's `compile`).
 *
 * @returns `undefined` when no slot has data.
 */
export function normalizeDisplay(raw: unknown): Json | undefined {
  if (!isJson(raw)) return undefined;
  const entries = DISPLAY_SLOTS.flatMap((slot): [string, Json][] => {
    const value = normalizeDisplaySlot(raw[slot]);
    return value ? [[slot, value]] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * `Texture.javaTextureLink` (js/texturing/textures.js): the name without its
 * extension, prefixed by the folder, and by the namespace unless it is `minecraft`.
 */
export function javaTextureLink(texture: ITexture): string {
  const folder = typeof texture.folder === "string" ? texture.folder : "";
  const namespace = typeof texture.namespace === "string" ? texture.namespace : "";
  const base = texture.name.replace(/\.\w{2,8}$/, "");
  const withFolder = folder ? `${folder}/${base}` : base;
  return namespace && namespace !== "minecraft" ? `${namespace}:${withFolder}` : withFolder;
}

/**
 * Texture IDs as Blockbench sees them after loading: a saved `id`, or for
 * textures without one, the constructor's fallback (the lowest number, starting
 * at the texture's position, that no earlier texture uses).
 */
export function effectiveTextureIds(textures: readonly ITexture[]): string[] {
  return textures.reduce<string[]>((ids, texture, index) => {
    const saved = (texture as Json).id;
    if (typeof saved === "string" && saved !== "") return [...ids, saved];
    const taken = new Set(ids);
    const nextFree = (candidate: number): string => (taken.has(String(candidate)) ? nextFree(candidate + 1) : String(candidate));
    return [...ids, nextFree(index)];
  }, []);
}

/**
 * Resolves a saved face texture reference (index or UUID) to a texture index.
 *
 * @returns The index into `doc.textures`, or `undefined` for no texture or a dangling reference.
 */
export function faceTextureIndex(doc: IBBModel, ref: unknown): number | undefined {
  if (typeof ref === "number") return ref >= 0 && ref < doc.textures.length ? ref : undefined;
  if (typeof ref !== "string") return undefined;
  const index = doc.textures.findIndex((texture) => texture.uuid === ref);
  return index >= 0 ? index : undefined;
}
