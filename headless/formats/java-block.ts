/**
 * Java Edition block/item model (`.json`) compiler for `.bbmodel` documents,
 * ported from the `compile()` of Blockbench's `java_block` codec
 * (js/formats/java/java_block.ts), including its helpers `computeCube`, the
 * texture map loop, the display loop and the `groups` outliner export
 * (`Group.compile(false)` in js/outliner/types/group.js).
 *
 * Conventions carried over exactly:
 *
 * - Inflate is baked into `from`/`to`; Java models have no inflate field.
 * - Face UVs are rescaled to the 16×16 space Minecraft expects: `uv * 16 / resolution`.
 * - Faces whose texture is `null` (disabled) are omitted; faces without a texture
 *   point at `#missing`. Elements left with no faces are dropped.
 * - A cube whose pivot is not at 0,0,0 gets a zero-angle `rotation` block, as
 *   Blockbench's default `java_export_pivots` setting does.
 * - Rotation style follows the project's `java_block_version`: before 1.21.11 one
 *   `angle`/`axis` pair (snapped to 22.5° for 1.9.0, with Blockbench's own
 *   `rotated` field keeping the extra axes); from 1.21.11 `x`/`y`/`z` when a cube
 *   turns on several axes or past ±45°.
 * - Blockbench writes `format_version` (its `java_block_version`) at the top.
 *
 * Headless differences (reported in `notes`): meshes, locators and other
 * non-cube elements are skipped; dialogs (the oversized-cube warning) become notes.
 *
 * @module
 */

import { CUBE_FACES, type IBBModel, type ICube, type ICubeFace, isCube, isGroupRef, type OutlinerNode, type Vec3 } from "../document/schema";
import { type IModelIndex, indexModel } from "../document/tree";
import {
  AXIS_LETTERS,
  type AxisLetter,
  effectiveTextureIds,
  faceTextureIndex,
  type IJavaVersionFlags,
  isJson,
  type Json,
  JAVA_COORDINATE_LIMITS,
  javaBlockVersionOf,
  javaTextureLink,
  javaVersionFlags,
  normalizeDisplay,
} from "./java-block-shared";

export { type IJavaBlockImportOptions, type IJavaBlockImportResult, importJavaBlockModel } from "./java-block-import";

/** Compile options; each mirrors a Blockbench setting or codec option. */
export interface IJavaBlockCompileOptions {
  /** Write element names (`cube_name` option; default true, as with `minifiedout` off). */
  cubeName?: boolean;
  /** Write a pivot-only `rotation` block for unrotated cubes with a pivot (`java_export_pivots`, default true). */
  exportPivots?: boolean;
  /** Write the `groups` outliner export (`export_groups`, default true). */
  exportGroups?: boolean;
  /** Credit used when the document has none (`credit` setting, default "Made with Blockbench"). */
  credit?: string;
  /** Overrides the document's `java_block_version`. */
  version?: string;
}

/** A compiled model plus notes on what Blockbench would have warned about or what was left out. */
export interface IJavaBlockCompileResult {
  /** The Java block model JSON object, keys in Blockbench's order. */
  model: Json;
  notes: string[];
}

/** Default credit (`credit` setting in js/interface/setup_settings.js). */
export const DEFAULT_JAVA_CREDIT = "Made with Blockbench";

interface ICompileContext {
  doc: IBBModel;
  flags: IJavaVersionFlags;
  textureIds: readonly string[];
  options: Required<Omit<IJavaBlockCompileOptions, "version" | "credit">>;
}

/** A compiled element plus the textures its faces used. */
interface ICompiledCube {
  element: Json;
  texturesUsed: number[];
  notes: string[];
}

const positiveItems = (values: readonly number[]): number => values.filter((value) => value !== 0).length;

/** `Cube.rotationAxis()`: the first rotated axis, else the saved `rotation_axis`. */
function rotationAxisOf(cube: ICube, rotation: Vec3): AxisLetter | undefined {
  const index = rotation.findIndex((value) => value !== 0);
  if (index >= 0) return AXIS_LETTERS[index];
  const saved = (cube as Json).rotation_axis;
  return saved === "x" || saved === "y" || saved === "z" ? saved : undefined;
}

/** The `rotation` block of `computeCube`, or `undefined` when none is written. */
function compileRotation(cube: ICube, context: ICompileContext): Json | undefined {
  const rotation: Vec3 = cube.rotation ?? [0, 0, 0];
  const origin: Vec3 = [...cube.origin];
  const rotated = rotation.some((value) => value !== 0);
  const writePivot = origin.some((value) => value !== 0) && context.options.exportPivots;
  const base = ((): Json | undefined => {
    if (!rotated && !writePivot) return undefined;
    const freeStyle = !context.flags.rotation_limit && (positiveItems(rotation) > 1 || rotation.some((value) => Math.abs(value) > 45));
    if (freeStyle) return { x: rotation[0], y: rotation[1], z: rotation[2], origin };
    const axis = rotationAxisOf(cube, rotation) ?? "y";
    const angle = rotation[AXIS_LETTERS.indexOf(axis)] ?? 0;
    return { angle: context.flags.rotation_snap ? Math.round(angle / 22.5) * 22.5 : angle, axis, origin };
  })();
  if ((cube as Json).rescale !== true) return base;
  if (base) return { ...base, rescale: true };
  const savedAxis = (cube as Json).rotation_axis;
  return { angle: 0, axis: typeof savedAxis === "string" && savedAxis ? savedAxis : "y", origin, rescale: true };
}

/** One face tag of `computeCube`, or `undefined` for a disabled face. */
function compileFace(face: ICubeFace | undefined, context: ICompileContext): { tag: Json; texture: number | undefined; textured: boolean } | undefined {
  // Blockbench always holds six faces; a face missing from the file loads with its defaults.
  const source: ICubeFace = face ?? { uv: [0, 0, 16, 16] };
  if (source.texture === null) return undefined;
  const { width, height } = context.doc.resolution;
  const texture = faceTextureIndex(context.doc, source.texture);
  const textureId = texture === undefined ? undefined : context.textureIds[texture];
  const tint = (source as Json).tint;
  const cullface = (source as Json).cullface;
  const tag: Json = {
    ...((source as Json).enabled === false ? {} : { uv: source.uv.map((value, i) => (value * 16) / ((i % 2 ? height : width) || 16)) }),
    ...(source.rotation ? { rotation: source.rotation } : {}),
    texture: textureId === undefined ? "#missing" : `#${textureId}`,
    ...(typeof cullface === "string" && cullface ? { cullface } : {}),
    ...(typeof tint === "number" && tint >= 0 ? { tintindex: tint } : {}),
  };
  return { tag, texture, textured: textureId !== undefined };
}

/** Port of `computeCube` for one exported cube. */
function compileCube(cube: ICube, context: ICompileContext): ICompiledCube {
  const inflate = cube.inflate ?? 0;
  const from = cube.from.map((value) => value - inflate);
  const to = cube.to.map((value) => value + inflate);
  const rotation: Vec3 = cube.rotation ?? [0, 0, 0];
  const extra = cube as Json;
  const faces = CUBE_FACES.flatMap((key) => {
    const compiled = compileFace(cube.faces[key], context);
    return compiled ? [[key, compiled] as const] : [];
  });
  const textured = faces.some(([, compiled]) => compiled.textured);
  const shadeOff = !context.flags.shade_direction_override && extra.shade === false;
  const lightEmission = typeof extra.light_emission === "number" && extra.light_emission ? extra.light_emission : undefined;
  const shadeOverride = context.flags.shade_direction_override && typeof extra.shade_direction_override === "string" && extra.shade_direction_override ? extra.shade_direction_override : undefined;
  const rotationBlock = compileRotation(cube, context);
  const multiAxis = context.flags.rotation_limit && positiveItems(rotation) >= 2;
  const element: Json = {
    ...(context.options.cubeName && cube.name !== "cube" ? { name: cube.name } : {}),
    from,
    to,
    ...(shadeOff ? { shade: false } : {}),
    ...(lightEmission === undefined ? {} : { light_emission: lightEmission }),
    ...(shadeOverride === undefined ? {} : { shade_direction_override: shadeOverride }),
    ...(rotationBlock ? { rotation: rotationBlock } : {}),
    ...(multiAxis ? { rotated: [...rotation] } : {}),
    ...(textured ? {} : { color: cube.color }),
    faces: Object.fromEntries(faces.map(([key, compiled]) => [key, compiled.tag])),
  };
  const [low, high] = JAVA_COORDINATE_LIMITS;
  const outside = [...from, ...to].some((value) => value < low || value > high);
  const angle = rotationBlock && typeof rotationBlock.angle === "number" ? rotationBlock.angle : 0;
  const notes = [
    ...(outside ? [`${cube.name}: spans ${from.join(",")} → ${to.join(",")}, outside Java's ${low}…${high} element range; Minecraft clips or rejects it.`] : []),
    ...(multiAxis ? [`${cube.name}: rotates on ${positiveItems(rotation)} axes, but java_block ${context.flags.version} allows one; only the ${String(rotationBlock?.axis)} axis was written (Blockbench keeps the rest in "rotated").`] : []),
    ...(context.flags.rotation_limit && Math.abs(angle) > 45 ? [`${cube.name}: angle ${angle}° is outside ±45°, which java_block ${context.flags.version} does not allow.`] : []),
    ...(inflate ? [`${cube.name}: inflate ${inflate} was baked into from/to.`] : []),
    ...(faces.length === 0 ? [`${cube.name}: every face is disabled, so the element was not written.`] : []),
  ];
  const texturesUsed = faces.flatMap(([, compiled]) => (compiled.texture === undefined ? [] : [compiled.texture]));
  return { element, texturesUsed, notes };
}

/** Element UUIDs in outliner order (Blockbench's `iterate(Outliner.root)` visits every group, exported or not). */
function outlinerElementOrder(nodes: readonly OutlinerNode[]): string[] {
  return nodes.flatMap((node) => (isGroupRef(node) ? outlinerElementOrder(node.children) : [node]));
}

/** `Group.compile(false)`: name, properties the java_block format enables, then children. */
function compileGroup(index: IModelIndex, node: OutlinerNode, elementIndex: ReadonlyMap<string, number>): unknown[] {
  if (!isGroupRef(node)) {
    const position = elementIndex.get(node);
    return position === undefined ? [] : [position];
  }
  const group = index.groups.get(node.uuid);
  if (!group || group.export === false) return [];
  const extra = group as Json;
  return [{
    name: group.name,
    origin: [...group.origin],
    ...(group.rotation.some((value) => value !== 0) ? { rotation: [...group.rotation] } : {}),
    scope: typeof extra.scope === "number" ? extra.scope : 0,
    color: typeof extra.color === "number" ? extra.color : 0,
    ...(extra.shade === false ? { shade: false } : {}),
    ...(group.reset ? { reset: true } : {}),
    children: node.children.flatMap((child) => compileGroup(index, child, elementIndex)),
  }];
}

/** The `textures` map: particle first where it appears, then IDs whose link differs from the ID. */
function compileTextures(doc: IBBModel, textureIds: readonly string[], used: ReadonlySet<number>, texturesOnly: boolean): Record<string, string> {
  return doc.textures.reduce<Record<string, string>>((map, texture, i) => {
    const link = javaTextureLink(texture);
    const id = textureIds[i] ?? String(i);
    const withParticle = (texture as Json).particle === true ? { ...map, particle: link } : map;
    const listed = used.has(i) || texturesOnly;
    return listed && id !== link.replace(/^#/, "") ? { ...withParticle, [id]: link } : withParticle;
  }, {});
}

/**
 * Compiles a `.bbmodel` to a Java Edition block/item model.
 *
 * @param doc - A 5.0 document; its `meta.model_format` is not checked, so free or
 *   Bedrock models can be exported too (non-cube elements are skipped).
 * @returns The model object with Blockbench's key order and notes on skipped or out-of-spec content.
 */
export function compileJavaBlockModel(doc: IBBModel, options: IJavaBlockCompileOptions = {}): IJavaBlockCompileResult {
  const index = indexModel(doc);
  const root = doc as Json;
  const context: ICompileContext = {
    doc,
    flags: javaVersionFlags(options.version ?? javaBlockVersionOf(doc)),
    textureIds: effectiveTextureIds(doc.textures),
    options: { cubeName: options.cubeName ?? true, exportPivots: options.exportPivots ?? true, exportGroups: options.exportGroups ?? true },
  };
  const ordered = outlinerElementOrder(doc.outliner).flatMap((uuid) => {
    const element = index.elements.get(uuid);
    return element && element.export !== false ? [element] : [];
  });
  const skipped = ordered.filter((element) => !isCube(element)).map((element) => `${element.name || element.uuid} (${element.type})`);
  const compiled = ordered.filter(isCube).map((cube) => ({ uuid: cube.uuid, ...compileCube(cube, context) }));
  const written = compiled.filter((entry) => Object.keys(entry.element.faces as Json).length > 0);
  const elementIndex = new Map(written.map((entry, i) => [entry.uuid, i]));
  const used = new Set(compiled.flatMap((entry) => entry.texturesUsed));
  const parent = typeof root.parent === "string" ? root.parent : "";
  const textures = compileTextures(doc, context.textureIds, used, written.length === 0 && parent !== "");
  const credit = typeof root.credit === "string" && root.credit ? root.credit : options.credit ?? DEFAULT_JAVA_CREDIT;
  const unhandled = isJson(root.unhandled_root_fields) ? root.unhandled_root_fields : {};
  const overrides = Array.isArray(root.overrides) ? root.overrides.map((entry) => (isJson(entry) ? Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "_uuid")) : entry)) : [];
  const display = normalizeDisplay(root.display);
  const groups = context.options.exportGroups && doc.groups.length > 0 ? doc.outliner.flatMap((node) => compileGroup(index, node, elementIndex)) : [];
  const { width, height } = doc.resolution;
  const model: Json = {
    format_version: context.flags.version,
    ...(credit ? { credit } : {}),
    ...(parent ? { parent } : {}),
    ...(root.ambientocclusion === false ? { ambientocclusion: false } : {}),
    ...(unhandled.render_type ? { render_type: unhandled.render_type } : {}),
    ...(width !== 16 || height !== 16 ? { texture_size: [width, height] } : {}),
    ...(Object.keys(textures).length > 0 ? { textures } : {}),
    ...(written.length > 0 ? { elements: written.map((entry) => entry.element) } : {}),
    ...(root.front_gui_light === true ? { gui_light: "front" } : {}),
    ...(overrides.length > 0 ? { overrides } : {}),
    ...(display ? { display } : {}),
    // Blockbench writes groups only when the root holds at least one group.
    ...(groups.some((entry) => typeof entry === "object") ? { groups } : {}),
  };
  const withUnhandled = Object.entries(unhandled).reduce<Json>((acc, [key, value]) => (acc[key] === undefined ? { ...acc, [key]: value } : acc), model);
  const notes = [
    ...compiled.flatMap((entry) => entry.notes),
    ...(skipped.length > 0 ? [`Skipped ${skipped.length} non-cube element(s) Java block models cannot hold: ${skipped.join(", ")}.`] : []),
  ];
  return { model: withUnhandled, notes };
}
