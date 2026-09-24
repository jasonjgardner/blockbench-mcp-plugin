/**
 * What each Blockbench format allows, and which elements of a document break it.
 *
 * Blockbench enforces format limits in the editor: its UI hides tools a format
 * lacks, `ModelFormat.convertTo` (js/io/format.ts) deletes meshes, locators and
 * other unsupported elements and clamps rotations, and a `cube_size_limiter`
 * pushes cubes back into range. The headless server edits JSON directly, so
 * nothing stops an agent from writing a mesh into a Java block model or a
 * two-axis rotation into a 1.21.6 one. This module holds the relevant
 * `ModelFormat` flags per format ID, read from each format's definition, and
 * checks elements against them so edits can be refused or flagged before
 * Blockbench silently changes the model on open or export.
 *
 * Sources (JannisX11/blockbench):
 * - free: js/formats/generic.ts `new ModelFormat('free')`
 * - bedrock, bedrock_block: js/formats/bedrock/bedrock.js `entity_format`, `block_format`
 * - bedrock_old: js/formats/bedrock/bedrock_old.js
 * - java_block: js/formats/java/java_block.ts, plus its `rotation_limit` /
 *   `rotation_snap` / `java_cube_shade_direction_override` getters (version-dependent)
 * - modded_entity: js/formats/java/modded_entity.ts (`integer_size` getter, default setting on)
 * - optifine_entity, optifine_part: js/formats/optifine/optifine_jem.js, optifine_jpm.js
 * - skin: js/formats/minecraft/skin.ts; image: js/formats/image.ts
 * - geckolib_model: blockbench-plugins plugins/geckolib/src/ts/codec.ts
 *
 * @module
 */

import { BLOCK_CELL_SIZE, checkBlockBounds, OVERSIZED_BLOCK_MAX_CENTER_OFFSET, OVERSIZED_BLOCK_MAX_SIZE } from "@/lib/block-grid";
import { type IBBModel, type ICube, type IElement, type IGroup, isCube, type Vec3 } from "../document/schema";
import { indexModel } from "../document/tree";
import { elementBoxes } from "../geometry/bounds";
import { AXIS_LETTERS, DEFAULT_JAVA_BLOCK_VERSION, JAVA_COORDINATE_LIMITS, javaBlockVersionOf, javaVersionFlags } from "./java-block-shared";

/** Which cube-size limiter a format applies (`ModelFormat.cube_size_limiter`). */
export type CubeSizeLimiter = "java_block" | "bedrock_block";

/** How a format treats box UV: toggle per cube, or forced one way (`box_uv` + `optional_box_uv`). */
export type BoxUvMode = "optional" | "forced_box" | "forced_per_face";

/** The `ModelFormat` flags that matter when editing a model headless. */
export interface IFormatCapabilities {
  id: string;
  name: string;
  /** Where Blockbench defines the format. */
  source: string;
  /** The format holds 3D elements at all (false for the image editor). */
  elements: boolean;
  meshes: boolean;
  splines: boolean;
  texture_meshes: boolean;
  billboards: boolean;
  locators: boolean;
  /** Null objects (IK targets); Blockbench offers them where `animation_mode` is on. */
  null_objects: boolean;
  armature_rig: boolean;
  bounding_boxes: boolean;
  /** Cubes may rotate at all. */
  rotate_cubes: boolean;
  /** Cubes rotate on one axis only, within ±45°. */
  rotation_limit: boolean;
  /** Cube angles snap to multiples of 22.5°. */
  rotation_snap: boolean;
  cube_size_limiter: CubeSizeLimiter | undefined;
  /** Default UV mode for new cubes. */
  box_uv: boolean;
  /** Cubes may switch between box and per-face UV. */
  optional_box_uv: boolean;
  box_uv_mode: BoxUvMode;
  /** Cube sizes are whole numbers. */
  integer_size: boolean;
  /** Groups are bones with a pivot and rotation. */
  bone_rig: boolean;
  animation_mode: boolean;
  display_mode: boolean;
  /** Textures keep a resource-pack folder and namespace. */
  texture_folder: boolean;
  /** One texture for the whole model. */
  single_texture: boolean;
  per_texture_uv_size: boolean;
  uv_rotation: boolean;
  /** Origin at the block center (Bedrock/entity) rather than a block corner (Java). */
  centered_grid: boolean;
  /** Java face `cullface` and `tintindex`. */
  java_face_properties: boolean;
  molang: boolean;
  pbr: boolean;
  /** Version-dependent notes, such as the Java block version the flags assume. */
  notes: string[];
}

type FormatFlags = Omit<IFormatCapabilities, "id" | "box_uv_mode" | "notes">;

const BASE: FormatFlags = {
  name: "",
  source: "",
  elements: true,
  meshes: false,
  splines: false,
  texture_meshes: false,
  billboards: false,
  locators: false,
  null_objects: false,
  armature_rig: false,
  bounding_boxes: false,
  rotate_cubes: false,
  rotation_limit: false,
  rotation_snap: false,
  cube_size_limiter: undefined,
  box_uv: false,
  optional_box_uv: false,
  integer_size: false,
  bone_rig: false,
  animation_mode: false,
  display_mode: false,
  texture_folder: false,
  single_texture: false,
  per_texture_uv_size: false,
  uv_rotation: false,
  centered_grid: false,
  java_face_properties: false,
  molang: true,
  pbr: false,
};

const OPTIFINE: Partial<FormatFlags> = {
  box_uv: true, optional_box_uv: true, integer_size: true, bone_rig: true, centered_grid: true,
  texture_folder: true, per_texture_uv_size: true, molang: false, pbr: true,
};

/** Static flags per format ID. Version- and project-dependent flags are resolved in {@link formatCapabilities}. */
export const FORMAT_RULES: Readonly<Record<string, FormatFlags>> = {
  free: {
    ...BASE, name: "Generic Model", source: "js/formats/generic.ts",
    meshes: true, splines: true, billboards: true, locators: true, null_objects: true, armature_rig: true, bounding_boxes: true,
    rotate_cubes: true, optional_box_uv: true, bone_rig: true, animation_mode: true, per_texture_uv_size: true, uv_rotation: true,
    centered_grid: true, pbr: true,
  },
  bedrock: {
    ...BASE, name: "Bedrock Entity", source: "js/formats/bedrock/bedrock.js (entity_format)",
    texture_meshes: true, locators: true, null_objects: true, bounding_boxes: true, rotate_cubes: true, box_uv: true, optional_box_uv: true,
    single_texture: true, bone_rig: true, animation_mode: true, uv_rotation: true, centered_grid: true, pbr: true,
  },
  bedrock_block: {
    ...BASE, name: "Bedrock Block", source: "js/formats/bedrock/bedrock.js (block_format)",
    texture_meshes: true, bounding_boxes: true, rotate_cubes: true, optional_box_uv: true, cube_size_limiter: "bedrock_block",
    bone_rig: true, display_mode: true, uv_rotation: true, centered_grid: true, pbr: true,
  },
  bedrock_old: {
    ...BASE, name: "Bedrock Entity (legacy)", source: "js/formats/bedrock/bedrock_old.js",
    locators: true, null_objects: true, box_uv: true, single_texture: true, bone_rig: true, animation_mode: true, centered_grid: true, pbr: true,
  },
  java_block: {
    ...BASE, name: "Java Block/Item", source: "js/formats/java/java_block.ts",
    rotate_cubes: true, rotation_limit: true, optional_box_uv: true, cube_size_limiter: "java_block", display_mode: true,
    texture_folder: true, uv_rotation: true, java_face_properties: true, molang: false, pbr: true,
  },
  modded_entity: {
    ...BASE, name: "Modded Entity", source: "js/formats/java/modded_entity.ts",
    rotate_cubes: true, box_uv: true, integer_size: true, single_texture: true, bone_rig: true, animation_mode: true,
    centered_grid: true, pbr: true,
  },
  optifine_entity: { ...BASE, ...OPTIFINE, name: "OptiFine Entity", source: "js/formats/optifine/optifine_jem.js" },
  optifine_part: { ...BASE, ...OPTIFINE, name: "OptiFine Part", source: "js/formats/optifine/optifine_jpm.js" },
  skin: {
    ...BASE, name: "Minecraft Skin", source: "js/formats/minecraft/skin.ts",
    box_uv: true, integer_size: true, single_texture: true, bone_rig: true, centered_grid: true,
  },
  image: {
    ...BASE, name: "Image", source: "js/formats/image.ts",
    elements: false, single_texture: true, per_texture_uv_size: true,
  },
  geckolib_model: {
    ...BASE, name: "GeckoLib Animated Model", source: "blockbench-plugins: plugins/geckolib/src/ts/codec.ts",
    locators: true, null_objects: true, rotate_cubes: true, box_uv: true, optional_box_uv: true, single_texture: true,
    bone_rig: true, animation_mode: true, centered_grid: true,
  },
};

const boxUvModeOf = (flags: FormatFlags): BoxUvMode => {
  if (flags.optional_box_uv) return "optional";
  return flags.box_uv ? "forced_box" : "forced_per_face";
};

/**
 * Flags for one format, with project-dependent getters resolved against `doc`:
 * Java block rotation rules follow `java_block_version` (default 26.3, free
 * rotation), OptiFine's `integer_size` follows the project's box UV, and
 * Bedrock's `per_texture_uv_size` follows `multi_file_ruleset`.
 *
 * @returns `undefined` for format IDs this table does not know (plugin formats).
 */
export function formatCapabilities(formatId: string, doc?: IBBModel): IFormatCapabilities | undefined {
  const flags = FORMAT_RULES[formatId];
  if (!flags) return undefined;
  const base: IFormatCapabilities = { ...flags, id: formatId, box_uv_mode: boxUvModeOf(flags), notes: [] };
  const extra = (doc ?? {}) as Record<string, unknown>;
  if (formatId === "java_block") {
    const version = doc ? javaBlockVersionOf(doc) : DEFAULT_JAVA_BLOCK_VERSION;
    const java = javaVersionFlags(version);
    const rule = java.rotation_limit
      ? `one axis within ±45°${java.rotation_snap ? " in 22.5° steps" : ""}`
      : "any angle on any axes";
    return { ...base, rotation_limit: java.rotation_limit, rotation_snap: java.rotation_snap, notes: [`java_block_version ${version}: cube rotation allows ${rule}.`] };
  }
  if (formatId === "optifine_entity" || formatId === "optifine_part") return { ...base, integer_size: doc?.meta.box_uv ?? true };
  if (formatId === "bedrock") return { ...base, per_texture_uv_size: Boolean(extra.multi_file_ruleset) };
  return base;
}

/** Rule IDs a violation can carry. */
export type FormatRule =
  | "element_type"
  | "cube_rotation"
  | "rotation_axes"
  | "rotation_angle"
  | "rotation_snap"
  | "cube_bounds"
  | "block_bounds"
  | "inflate"
  | "integer_size"
  | "box_uv"
  | "group_rotation";

/** One element that breaks its format. */
export interface IFormatViolation {
  /** UUID of the element or group. */
  element: string;
  name: string;
  rule: FormatRule;
  /** `error`: Blockbench changes or drops it on open/export, or the game rejects it. `warning`: exported with a lossy change. */
  severity: "error" | "warning";
  /** What is wrong and how to fix it. */
  message: string;
}

/** Element types and the capability that allows them. */
const ELEMENT_TYPE_FLAGS: Readonly<Record<string, keyof FormatFlags>> = {
  cube: "elements",
  mesh: "meshes",
  spline: "splines",
  texture_mesh: "texture_meshes",
  billboard: "billboards",
  locator: "locators",
  null_object: "null_objects",
  armature: "armature_rig",
  armature_bone: "armature_rig",
  bounding_box: "bounding_boxes",
};

const EPSILON = 1e-6;
const fmt = (values: readonly number[]): string => values.map((value) => Math.round(value * 1000) / 1000).join(", ");

type Check<T> = (target: T, caps: IFormatCapabilities) => Omit<IFormatViolation, "element" | "name">[];

const checkType: Check<IElement> = (element, caps) => {
  const flag = ELEMENT_TYPE_FLAGS[element.type];
  if (flag === undefined || caps[flag] === true) return [];
  const fix = element.type === "mesh" && caps.elements
    ? "Rebuild it from cubes, or use a format with meshes (free)."
    : "Remove it, or switch to a format that supports it.";
  return [{ rule: "element_type", severity: "error", message: `${caps.id} has no ${element.type} elements; Blockbench deletes them when the model is converted, and ${caps.id} exports skip them. ${fix}` }];
};

const checkRotation: Check<ICube> = (cube, caps) => {
  const rotation: Vec3 = cube.rotation ?? [0, 0, 0];
  const rotatedAxes = [0, 1, 2].filter((axis) => rotation[axis] !== 0);
  if (rotatedAxes.length === 0) return [];
  if (!caps.rotate_cubes) {
    return [{ rule: "cube_rotation", severity: "error", message: `${caps.id} cannot rotate cubes (rotation ${fmt(rotation)}); Blockbench resets it to 0. Set rotation to [0, 0, 0]${caps.bone_rig ? " and rotate a parent group instead" : ""}.` }];
  }
  if (!caps.rotation_limit) return [];
  const axes = rotatedAxes.map((axis) => `${AXIS_LETTERS[axis]}=${rotation[axis]}`).join(", ");
  const upgrade = caps.id === "java_block" ? " or set java_block_version to 1.21.11 or newer for free rotation" : "";
  const multi: Omit<IFormatViolation, "element" | "name">[] = rotatedAxes.length > 1
    ? [{ rule: "rotation_axes", severity: "error", message: `Rotates on ${rotatedAxes.length} axes (${axes}); ${caps.id} allows one. Keep a single axis${upgrade}.` }]
    : [];
  const angles = rotatedAxes.flatMap((axis): Omit<IFormatViolation, "element" | "name">[] => {
    const angle = rotation[axis] ?? 0;
    const outOfRange = Math.abs(angle) > 45 + EPSILON;
    const offGrid = caps.rotation_snap && Math.abs(angle / 22.5 - Math.round(angle / 22.5)) > EPSILON;
    return [
      ...(outOfRange ? [{ rule: "rotation_angle" as const, severity: "error" as const, message: `${AXIS_LETTERS[axis]} angle ${angle}° is outside ±45°. Use an angle in -45…45 (turn the cube 90° by swapping its from/to axes)${upgrade}.` }] : []),
      ...(offGrid ? [{ rule: "rotation_snap" as const, severity: "error" as const, message: `${AXIS_LETTERS[axis]} angle ${angle}° is not a multiple of 22.5°, which java_block 1.9.0 requires; Blockbench rounds it to ${Math.round(angle / 22.5) * 22.5}°. Use -45, -22.5, 0, 22.5 or 45, or set java_block_version to 1.21.6 or newer.` }] : []),
    ];
  });
  return [...multi, ...angles];
};

/** Port of the java_block `cube_size_limiter.test`: any from/to ± inflate outside -16…32. */
const checkJavaBounds: Check<ICube> = (cube, caps) => {
  if (caps.cube_size_limiter !== "java_block") return [];
  const inflate = cube.inflate ?? 0;
  const [low, high] = JAVA_COORDINATE_LIMITS;
  const lo = cube.from.map((value, axis) => Math.min(value, cube.to[axis] ?? value) - inflate);
  const hi = cube.from.map((value, axis) => Math.max(value, cube.to[axis] ?? value) + inflate);
  const outside = [...lo, ...hi].some((value) => value < low - EPSILON || value > high + EPSILON);
  if (!outside) return [];
  return [{ rule: "cube_bounds", severity: "error", message: `Spans ${fmt(lo)} → ${fmt(hi)}${inflate ? " including inflate" : ""}; Java block elements must stay within ${low}…${high} on every axis. Move or shrink it (a model larger than 3×3×3 blocks needs several block models).` }];
};

const checkInflate: Check<ICube> = (cube, caps) => {
  if (caps.id !== "java_block" || !cube.inflate) return [];
  return [{ rule: "inflate", severity: "warning", message: `Inflate ${cube.inflate} has no Java equivalent; the export grows from/to by it instead. Set inflate to 0 and size the cube directly to keep the source and export identical.` }];
};

const checkIntegerSize: Check<ICube> = (cube, caps) => {
  if (!caps.integer_size) return [];
  const size = cube.to.map((value, axis) => value - (cube.from[axis] ?? 0));
  if (size.every((value) => Math.abs(value - Math.round(value)) < EPSILON)) return [];
  return [{ rule: "integer_size", severity: "warning", message: `Size ${fmt(size)} is not whole; ${caps.id} uses integer cube sizes and rounds them on export. Use whole-number sizes (inflate can fake sub-unit thickness).` }];
};

const checkBoxUv = (doc: IBBModel): Check<ICube> => (cube, caps) => {
  if (caps.optional_box_uv) return [];
  const boxUv = cube.box_uv ?? doc.meta.box_uv;
  if (boxUv === caps.box_uv) return [];
  return [{ rule: "box_uv", severity: "error", message: `Uses ${boxUv ? "box" : "per-face"} UV, but ${caps.id} only supports ${caps.box_uv ? "box" : "per-face"} UV. Set box_uv to ${caps.box_uv}.` }];
};

const checkGroup: Check<IGroup> = (group, caps) => {
  if (caps.bone_rig || !group.rotation.some((value) => value !== 0)) return [];
  return [{ rule: "group_rotation", severity: "error", message: `Group rotation ${fmt(group.rotation)} is ignored: ${caps.id} groups are folders, not bones. Set the group rotation to [0, 0, 0] and rotate the cubes instead.` }];
};

/**
 * Elements (and groups) that break the rules of the document's format
 * (`meta.model_format`).
 *
 * @param elementUuids - Element or group UUIDs to check; defaults to every element and group.
 * @returns Violations in document order; empty for formats {@link formatCapabilities} does not know.
 */
export function checkElements(doc: IBBModel, elementUuids?: Iterable<string>): IFormatViolation[] {
  const caps = formatCapabilities(doc.meta.model_format, doc);
  if (!caps) return [];
  const wanted = elementUuids === undefined ? undefined : new Set(elementUuids);
  const included = (uuid: string): boolean => wanted === undefined || wanted.has(uuid);
  const tag = (target: { uuid: string; name: string }) => (violation: Omit<IFormatViolation, "element" | "name">): IFormatViolation => ({ element: target.uuid, name: target.name, ...violation });
  const cubeChecks: Check<ICube>[] = [checkRotation, checkJavaBounds, checkInflate, checkIntegerSize, checkBoxUv(doc)];
  const elementViolations = doc.elements.filter((element) => included(element.uuid)).flatMap((element) => {
    const typeViolations = checkType(element, caps);
    const cubeViolations = isCube(element) && caps.elements ? cubeChecks.flatMap((check) => check(element, caps)) : [];
    return [...typeViolations, ...cubeViolations].map(tag(element));
  });
  const blockViolations = caps.cube_size_limiter === "bedrock_block" ? checkBedrockBlockBounds(doc, included) : [];
  const groupViolations = doc.groups.filter((group) => included(group.uuid)).flatMap((group) => checkGroup(group, caps).map(tag(group)));
  return [...elementViolations, ...blockViolations, ...groupViolations];
}

/** Bedrock block limiter: each element's world box must fit the 30-unit box near the block center (shared with the `block_limits` gate). */
function checkBedrockBlockBounds(doc: IBBModel, included: (uuid: string) => boolean): IFormatViolation[] {
  const index = indexModel(doc);
  const boxes = elementBoxes(doc, index, undefined, (element) => isCube(element) && included(element.uuid));
  const limits = { maxSize: OVERSIZED_BLOCK_MAX_SIZE, maxCenterOffset: OVERSIZED_BLOCK_MAX_CENTER_OFFSET, cellSize: BLOCK_CELL_SIZE };
  return [...boxes].flatMap(([uuid, box]): IFormatViolation[] => {
    if (checkBlockBounds(box, limits).valid) return [];
    const name = index.elements.get(uuid)?.name ?? uuid;
    return [{
      element: uuid,
      name,
      rule: "block_bounds",
      severity: "error",
      message: `Spans ${fmt(box.min)} → ${fmt(box.max)}; Bedrock block geometry must fit a 30-unit box within 7 units of the block center (x/z -22…22, y -14…30). Move or shrink it.`,
    }];
  });
}
