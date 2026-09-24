/**
 * Bedrock geometry (`.geo.json`) compiler for `.bbmodel` documents, ported from
 * Blockbench's `bedrock` codec (`compileCube`, `compileGroup`, `compile`,
 * `getFormatVersion` and `calculateVisibleBox` in js/formats/bedrock/bedrock.js).
 *
 * Conventions carried over exactly:
 *
 * - Bedrock mirrors X. Cube origins become `[-(from.x + size.x), from.y, from.z]`,
 *   pivots have X negated, and rotations negate X and Y.
 * - Per-face `up`/`down` UVs are stored flipped (origin at the far corner, negative size).
 * - Root-level elements are wrapped in a generated `bb_main` bone.
 *
 * - Locators and null objects become the bone's `locators` map; null objects get
 *   a `_null_` prefix and never rotate.
 *
 * Not ported: texture meshes (listed in `skipped`), display transforms, and the
 * export offset option.
 *
 * @module
 */

import { CUBE_FACES, type IBBModel, type ICube, isCube, type OutlinerNode, isGroupRef, type Vec3 } from "../document/schema";
import { type IModelIndex, indexModel } from "../document/tree";
import { elementBoxes, unionAabb } from "../geometry/bounds";

/** Compile options. */
export interface IBedrockCompileOptions {
  /** Geometry identifier without the `geometry.` prefix; defaults to the model identifier or name. */
  identifier?: string;
  /** Write `visible_bounds_*` (default true). */
  visibleBounds?: boolean;
  /** Export groups with no exported elements (Blockbench's `export_empty_groups`, default true). */
  exportEmptyGroups?: boolean;
}

/** Compiled geometry plus notes on what was left out. */
export interface IBedrockCompileResult {
  geometry: Record<string, unknown>;
  /** Names of elements that are neither cubes nor locators and were not exported. */
  skipped: string[];
}

type Json = Record<string, unknown>;

const negX = (v: Vec3): Vec3 => [-v[0], v[1], v[2]];

/** Element types Bedrock writes into a bone's `locators` map. */
const LOCATOR_TYPES: ReadonlySet<string> = new Set(["locator", "null_object"]);

const vec3Of = (value: unknown): Vec3 | undefined =>
  Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === "number") ? [value[0], value[1], value[2]] : undefined;

/**
 * Locators and null objects among a bone's direct children → its `locators` map,
 * as Blockbench's `compileGroup` writes them: a bare offset, or an object when a
 * locator is rotated or ignores inherited scale.
 */
function compileLocators(children: readonly OutlinerNode[], index: IModelIndex): Json {
  const entries = children
    .filter((child): child is string => typeof child === "string")
    .flatMap((id): [string, unknown][] => {
      const element = index.elements.get(id);
      if (!element || !LOCATOR_TYPES.has(element.type) || element.export === false) return [];
      const isNull = element.type === "null_object";
      const key = isNull ? `_null_${element.name}` : element.name;
      const offset = negX(vec3Of((element as Json).position) ?? [0, 0, 0]);
      const rotation = vec3Of((element as Json).rotation) ?? [0, 0, 0];
      const ignoreScale = (element as Json).ignore_inherited_scale === true;
      const rotated = !isNull && rotation.some((value) => value !== 0);
      if (!rotated && !ignoreScale) return [[key, offset]];
      return [[key, {
        offset,
        ...(isNull ? {} : { rotation: [-rotation[0], -rotation[1], rotation[2]] }),
        ...(ignoreScale ? { ignore_inherited_scale: true } : {}),
      }]];
    });
  return Object.fromEntries(entries);
}

/** Cube → Bedrock cube template. */
function compileCube(cube: ICube, boneMirror: boolean, projectBoxUv: boolean): Json {
  const size: Vec3 = [cube.to[0] - cube.from[0], cube.to[1] - cube.from[1], cube.to[2] - cube.from[2]];
  const origin: Vec3 = [-(cube.from[0] + size[0]), cube.from[1], cube.from[2]];
  const rotated = (cube.rotation ?? [0, 0, 0]).some((value) => value !== 0);
  const rotation = cube.rotation ?? [0, 0, 0];
  const boxUv = cube.box_uv ?? projectBoxUv;
  const mirror = cube.mirror_uv === true;
  const uv = boxUv
    ? cube.uv_offset ?? [0, 0]
    : Object.fromEntries(
        CUBE_FACES.flatMap((key) => {
          const face = cube.faces[key];
          if (!face || face.texture === null) return [];
          const flip = key === "up" || key === "down";
          const w = face.uv[2] - face.uv[0];
          const h = face.uv[3] - face.uv[1];
          const entry: Json = {
            uv: flip ? [face.uv[0] + w, face.uv[1] + h] : [face.uv[0], face.uv[1]],
            uv_size: flip ? [-w, -h] : [w, h],
            ...(face.rotation ? { uv_rotation: face.rotation } : {}),
            ...(typeof face.material_name === "string" && face.material_name ? { material_instance: face.material_name } : {}),
          };
          return [[key, entry]];
        }),
      );
  return {
    origin,
    size,
    ...(cube.inflate ? { inflate: cube.inflate } : {}),
    ...(rotated ? { pivot: negX(cube.origin), rotation: [-rotation[0], -rotation[1], rotation[2]] } : {}),
    uv,
    ...(boxUv && mirror === !boneMirror ? { mirror } : {}),
  };
}

/** Bedrock format version Blockbench would pick for this model. */
export function bedrockFormatVersion(doc: IBBModel): string {
  const faceRotation = doc.elements.filter(isCube).some((cube) => !(cube.box_uv ?? doc.meta.box_uv) && Object.values(cube.faces).some((face) => face.rotation));
  if (faceRotation) return "1.21.0";
  if (doc.groups.some((group) => group.bedrock_binding)) return "1.16.0";
  return "1.12.0";
}

/** Blockbench's visible-bounds estimate, from world-space cube bounds. */
function visibleBounds(doc: IBBModel, index: IModelIndex): { width: number; height: number; offset: number } {
  const exported = elementBoxes(doc, index, undefined, (element) => isCube(element) && element.export !== false && index.placement.has(element.uuid));
  const union = unionAabb([...exported.values()]);
  const project = doc.visible_box ?? [1, 1, 0];
  if (!union) return { width: project[0], height: project[1], offset: project[2] };
  const min: Vec3 = [union.min[0] + 8, union.min[1] + 8, union.min[2] + 8];
  const max: Vec3 = [union.max[0] + 8, union.max[1] + 8, union.max[2] + 8];
  const radius = Math.max(max[0], max[2], -min[0], -min[2]);
  const width = Math.max(Math.ceil((radius * 2) / 16), project[0]);
  const yMin = Math.min(Math.floor(min[1] / 16), project[2] - project[1] / 2);
  const yMax = Math.max(Math.ceil(max[1] / 16), project[2] + project[1] / 2);
  return { width, height: yMax - yMin, offset: (yMax + yMin) / 2 };
}

/**
 * Compiles a `.bbmodel` to Bedrock geometry JSON.
 *
 * @returns The `minecraft:geometry` document and the names of skipped non-cube elements.
 */
export function compileBedrockGeometry(doc: IBBModel, options: IBedrockCompileOptions = {}): IBedrockCompileResult {
  const index = indexModel(doc);
  const exportEmpty = options.exportEmptyGroups ?? true;
  const cubeOf = (uuid: string): ICube | undefined => {
    const element = index.elements.get(uuid);
    return element && isCube(element) ? element : undefined;
  };
  // Mirrors Blockbench's hasChildrenToExport: a child counts when it exists and is exported,
  // or when it is a group with an exported descendant.
  const exportedFlag = (node: OutlinerNode): boolean => {
    const entry = isGroupRef(node) ? index.groups.get(node.uuid) : index.elements.get(node);
    return entry !== undefined && entry.export !== false;
  };
  const hasExported = (node: OutlinerNode): boolean => exportedFlag(node) || (isGroupRef(node) && node.children.some(hasExported));

  const looseElements = doc.outliner.filter((node): node is string => typeof node === "string");
  const takenNames = new Set(doc.groups.map((group) => group.name));
  const mainName = takenNames.has("bb_main") ? `bb_main${Array.from({ length: takenNames.size + 1 }, (_, i) => i + 2).find((n) => !takenNames.has(`bb_main${n}`))}` : "bb_main";

  const bones: Json[] = [];
  const skipped: string[] = [];
  const skipNonCubes = (children: readonly OutlinerNode[]): void => {
    children.filter((child): child is string => typeof child === "string").forEach((id) => {
      const element = index.elements.get(id);
      if (element && !isCube(element) && !LOCATOR_TYPES.has(element.type) && element.export !== false) skipped.push(element.name || id);
    });
  };
  const cubesIn = (children: readonly OutlinerNode[], boneMirror: boolean): Json[] =>
    children
      .filter((child): child is string => typeof child === "string")
      .flatMap((id) => {
        const cube = cubeOf(id);
        return cube && cube.export !== false ? [compileCube(cube, boneMirror, doc.meta.box_uv)] : [];
      });

  if (looseElements.length > 0) {
    const cubes = cubesIn(looseElements, false);
    const locators = compileLocators(looseElements, index);
    skipNonCubes(looseElements);
    bones.push({ name: mainName, pivot: [0, 0, 0], ...(cubes.length ? { cubes } : {}), ...(Object.keys(locators).length ? { locators } : {}) });
  }

  const visit = (node: OutlinerNode, parentName: string | undefined): void => {
    if (!isGroupRef(node)) return;
    const group = index.groups.get(node.uuid);
    if (!group) return;
    const exportable = group.export !== false || node.children.some(hasExported);
    // Blockbench's export_empty_groups check looks at direct children only.
    const hasExportedChild = node.children.some(exportedFlag);
    if (exportable && (exportEmpty || hasExportedChild)) {
      const boneMirror = group.mirror_uv === true && doc.meta.box_uv;
      const rotated = group.rotation.some((value) => value !== 0);
      const cubes = cubesIn(node.children, boneMirror);
      const locators = compileLocators(node.children, index);
      skipNonCubes(node.children);
      bones.push({
        name: group.name,
        ...(parentName === undefined ? {} : { parent: parentName }),
        pivot: negX(group.origin),
        ...(rotated ? { rotation: [-group.rotation[0], -group.rotation[1], group.rotation[2]] } : {}),
        ...(typeof group.bedrock_binding === "string" && group.bedrock_binding ? { binding: group.bedrock_binding } : {}),
        ...(group.reset ? { reset: true } : {}),
        ...(boneMirror ? { mirror: true } : {}),
        ...(typeof group.material === "string" && group.material ? { material: group.material } : {}),
        ...(cubes.length ? { cubes } : {}),
        ...(Object.keys(locators).length ? { locators } : {}),
      });
    }
    node.children.forEach((child) => visit(child, group.name));
  };
  doc.outliner.forEach((node) => visit(node, undefined));

  const identifier = options.identifier ?? doc.model_identifier ?? (doc.name || "unknown");
  const bounds = bones.length > 0 && options.visibleBounds !== false ? visibleBounds(doc, index) : undefined;
  const description: Json = {
    identifier: identifier.startsWith("geometry.") ? identifier : `geometry.${identifier}`,
    texture_width: doc.resolution.width || 16,
    texture_height: doc.resolution.height || 16,
    ...(bounds ? { visible_bounds_width: bounds.width, visible_bounds_height: bounds.height, visible_bounds_offset: [0, bounds.offset, 0] } : {}),
  };
  return {
    geometry: {
      format_version: bedrockFormatVersion(doc),
      "minecraft:geometry": [{ description, ...(bones.length ? { bones } : {}) }],
    },
    skipped,
  };
}
