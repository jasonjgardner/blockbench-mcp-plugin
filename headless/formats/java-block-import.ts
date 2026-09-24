/**
 * Java Edition block/item model importer, ported from the `parse()` of
 * Blockbench's `java_block` codec (js/formats/java/java_block.ts) together with
 * the helpers it leans on: `collectParentModels`, `mergeParentModels`,
 * `getResourcePackRoot`, `getParentModelPath`, `Texture.fromJavaLink` /
 * `generateFolder` (js/texturing/textures.js), `Cube.extend` and
 * `Cube.mapAutoUV` for `autouv: 2` (js/outliner/types/cube.js), and
 * `DisplayMode.loadJSON` (js/display_mode/display_mode.js).
 *
 * The result is a 5.0 `java_block` document: elements become root cubes (then
 * moved into groups when the model has a `groups` outliner export), face UVs are
 * scaled from Minecraft's 16×16 space to the project resolution, and textures
 * become path-linked entries named after their resource location. Pixel data is
 * embedded only when `resolveTexture` returns PNG bytes.
 *
 * @module
 */

import { pngDataUrl, pngSize } from "../document/png";
import { bbmodelSchema, CUBE_FACES, type CubeFaceName, type IBBModel, type ITexture, type OutlinerNode, type UvRect, type Vec3 } from "../document/schema";
import {
  AXIS_LETTERS,
  DEFAULT_JAVA_BLOCK_VERSION,
  isJson,
  ITEM_PARENTS,
  type Json,
  javaVersionBelow,
  javaVersionFlags,
  mergeNumber,
  mergeVec3,
  normalizeDisplay,
  numberOf,
} from "./java-block-shared";
import { collectParents, mergeParents, normalizePath, parseParent, resourcePackRoot, withRoot } from "./java-block-parents";

/** Import options. */
export interface IJavaBlockImportOptions {
  /** Project name; defaults to the model file's base name, or "". */
  name?: string;
  /**
   * Where the model file sits, ideally inside a resource pack
   * (`<pack>/assets/<namespace>/models/block/stairs.json`). Texture and parent
   * paths are built from it the way Blockbench builds them from the opened file.
   */
  modelPath?: string;
  /**
   * Looks up texture pixels. Receives `assets/<namespace>/textures/<path>.png`
   * (prefixed with the pack root when `modelPath` reveals one) and returns PNG
   * bytes to embed, or `undefined` to keep the texture path-linked.
   */
  resolveTexture?: (path: string) => Uint8Array | undefined;
  /**
   * Looks up a parent model for element-less child models, like Blockbench's
   * "resolve parent" choice. Receives `assets/<namespace>/models/<id>.json` (with
   * the pack root when known) and returns the parsed JSON, JSON text or bytes.
   * Without it, `parent` is only recorded.
   */
  resolveParent?: (path: string) => unknown;
  /** Java block version for files without `format_version` (Blockbench's default setting: "26.3"). */
  defaultVersion?: string;
}

/** An imported document plus notes on what could not be carried over. */
export interface IJavaBlockImportResult {
  doc: IBBModel;
  notes: string[];
}

interface IImportTexture {
  texture: ITexture;
  /** Key the texture was created for (its Java ID). */
  key: string;
}

const MARKER_COLORS = 8;
const basename = (path: string): string => path.split("/").at(-1) ?? path;

/** Texture fields Blockbench writes for a link-mode texture. */
function baseTexture(id: string, name: string, doc: { width: number; height: number }): ITexture {
  return {
    path: "",
    name,
    folder: "",
    namespace: "",
    id,
    width: doc.width,
    height: doc.height,
    uv_width: doc.width,
    uv_height: doc.height,
    particle: false,
    use_as_default: false,
    layers_enabled: false,
    sync_to_project: "",
    render_mode: "default",
    render_sides: "auto",
    frame_time: 1,
    frame_order_type: "loop",
    frame_order: "",
    frame_interpolate: false,
    visible: true,
    internal: false,
    saved: true,
    uuid: crypto.randomUUID(),
  };
}

/** Embeds PNG bytes into a texture entry. */
function embed(texture: ITexture, bytes: Uint8Array | undefined): ITexture {
  if (!bytes) return texture;
  try {
    const size = pngSize(bytes);
    return { ...texture, source: pngDataUrl(bytes), width: size.width, height: size.height, internal: true };
  } catch {
    return texture;
  }
}

/** Port of `Texture.fromJavaLink` plus `generateFolder` for a resource-location link. */
function textureFromLink(id: string, link: string, packRoot: string | undefined, resolution: { width: number; height: number }, options: IJavaBlockImportOptions): ITexture {
  const base = baseTexture(id, "", resolution);
  if (link.startsWith("#") && !link.includes("/")) return base;
  if (link.startsWith("data:image/png;base64,")) {
    const bytes = new Uint8Array(Buffer.from(link.slice("data:image/png;base64,".length), "base64"));
    return embed({ ...base, name: id }, bytes);
  }
  if (/^[a-zA-Z]:[\\/]/.test(link)) {
    const path = normalizePath(link).replace(/\?\d+$/, "");
    return embed({ ...base, path, name: basename(path) }, options.resolveTexture?.(path));
  }
  const [namespace, resource] = link.includes(":") ? [link.split(":")[0] ?? "minecraft", link.split(":")[1] ?? ""] : ["minecraft", link];
  const cit = options.modelPath !== undefined && normalizePath(options.modelPath).split("/").includes("cit");
  const path = cit
    ? [...normalizePath(options.modelPath ?? "").split("/").slice(0, -1), `${resource.replace(/^\.*\//, "")}.png`].join("/")
    : withRoot(packRoot, `assets/${namespace}/textures/${resource}.png`);
  const folder = cit ? "." : resource.split("/").slice(0, -1).join("/");
  return embed({ ...base, path, name: `${basename(resource)}.png`, folder, namespace }, options.resolveTexture?.(path));
}

/** `Cube.mapAutoUV` with `autouv: 2` (relative UV) for a non-centered grid. */
function relativeUv(face: CubeFaceName, from: Vec3, to: Vec3, width: number, height: number): UvRect {
  const raw: Record<CubeFaceName, UvRect> = {
    north: [width - to[0], height - to[1], width - from[0], height - from[1]],
    south: [from[0], height - to[1], to[0], height - from[1]],
    west: [from[2], height - to[1], to[2], height - from[1]],
    east: [width - to[2], height - to[1], width - from[2], height - from[1]],
    up: [from[0], from[2], to[0], to[2]],
    down: [from[0], height - to[2], to[0], height - from[2]],
  };
  const clampAxis = (uv: UvRect, a: 0 | 1, b: 2 | 3, limit: number): UvRect => {
    const overflow = Math.max(uv[a], uv[b]) - limit;
    const shifted: UvRect = overflow > 0 ? uv.map((value, i) => (i === a || i === b ? value - overflow : value)) as UvRect : uv;
    const underflow = Math.min(shifted[a], shifted[b]);
    if (underflow >= 0) return shifted;
    return shifted.map((value, i) => (i === a || i === b ? Math.min(Math.max(value - underflow, 0), limit) : value)) as UvRect;
  };
  return clampAxis(clampAxis(raw[face], 0, 2, width), 1, 3, height);
}

/** Outliner nodes, group definitions and claimed element UUIDs built from a `groups` export. */
interface IGroupBuild {
  nodes: OutlinerNode[];
  groups: Json[];
  claimed: string[];
}

/**
 * `parseGroupsForJava`: numbers index the imported elements, strings are element
 * UUIDs, objects become groups whose `children` (or legacy `content`) recurse.
 */
function buildGroupNodes(entries: readonly unknown[], elementIds: readonly string[]): IGroupBuild {
  return entries.reduce<IGroupBuild>((acc, entry) => {
    if (typeof entry === "number" || typeof entry === "string") {
      const target = typeof entry === "number" ? elementIds[entry] : elementIds.find((id) => id === entry);
      return target ? { ...acc, nodes: [...acc.nodes, target], claimed: [...acc.claimed, target] } : acc;
    }
    if (!isJson(entry)) return acc;
    const uuid = typeof entry.uuid === "string" && entry.uuid ? entry.uuid : crypto.randomUUID();
    const group: Json = {
      name: typeof entry.name === "string" ? entry.name : "group",
      origin: mergeVec3(entry.origin, [8, 8, 8]),
      rotation: mergeVec3(entry.rotation, [0, 0, 0]),
      color: numberOf(entry.color) ?? 0,
      export: true,
      visibility: true,
      mirror_uv: false,
      reset: entry.reset === true,
      shade: entry.shade !== false,
      locked: false,
      autouv: 0,
      uuid,
    };
    const children = buildGroupNodes([
      ...(Array.isArray(entry.children) ? entry.children : []),
      ...(Array.isArray(entry.content) ? entry.content : []),
    ], elementIds);
    return {
      nodes: [...acc.nodes, { uuid, isOpen: entry.isOpen === true, children: children.nodes }],
      groups: [...acc.groups, group, ...children.groups],
      claimed: [...acc.claimed, ...children.claimed],
    };
  }, { nodes: [], groups: [], claimed: [] });
}

/**
 * Imports a Java Edition block/item model as a 5.0 `java_block` document.
 *
 * @param json - The parsed model JSON (or JSON text).
 * @throws Error when the JSON has none of `elements`, `parent`, `display` or `textures`
 *   (Blockbench's "invalid model" message).
 */
export function importJavaBlockModel(json: unknown, options: IJavaBlockImportOptions = {}): IJavaBlockImportResult {
  const input = typeof json === "string" ? parseParent(json) : isJson(json) ? json : undefined;
  if (!input || (!input.elements && !input.parent && !input.display && !input.textures)) {
    throw new Error("Not a Java block/item model: it needs at least one of elements, parent, display or textures.");
  }
  const packRoot = resourcePackRoot(options.modelPath);
  const parentId = typeof input.parent === "string" ? input.parent : undefined;
  const resolveParents = !input.elements && parentId !== undefined && !ITEM_PARENTS.includes(parentId) && options.resolveParent !== undefined;
  const stack = resolveParents && options.resolveParent ? collectParents(input, packRoot, options.resolveParent) : [input];
  const model: Json = stack.length > 1 ? { ...mergeParents(stack), parent: parentId } : input;
  const notes: string[] = [
    ...(stack.length > 1 ? [`Merged ${stack.length - 1} parent model(s) into the child, as Blockbench's "resolve parent" does.`] : []),
    ...(resolveParents && stack.length === 1 ? [`Parent ${parentId} could not be resolved; only its name was kept.`] : []),
  ];

  const elementsIn = Array.isArray(model.elements) ? model.elements.filter(isJson) : [];
  const baseVersion = typeof model.format_version === "string" ? model.format_version : options.defaultVersion ?? DEFAULT_JAVA_BLOCK_VERSION;
  const needsShadeOverride = !javaVersionFlags(baseVersion).shade_direction_override && elementsIn.some((element) => element.shade_direction_override);
  const version = needsShadeOverride ? "26.3" : baseVersion;
  const flags = javaVersionFlags(version);
  const sizeIn = Array.isArray(model.texture_size) ? model.texture_size : undefined;
  const clampSize = (value: unknown): number => Math.max(1, Number.parseInt(String(value), 10) || 1);
  const resolution = sizeIn ? { width: clampSize(sizeIn[0]), height: clampSize(sizeIn[1]) } : { width: 16, height: 16 };

  // Textures: `texture_ids` by key, `texture_paths` by raw value, deduplicated by resolved link.
  const texturesIn = isJson(model.textures) ? model.textures : {};
  const regular = Object.entries(texturesIn).filter(([key, value]) => typeof value === "string" && key !== "particle") as [string, string][];
  const resolveRef = (link: string): string => {
    const target = link.startsWith("#") ? texturesIn[link.slice(1)] : undefined;
    return typeof target === "string" ? target : link;
  };
  interface ITextureState { list: IImportTexture[]; byKey: Map<string, number>; byPath: Map<string, number>; byLink: Map<string, number> }
  const afterRegular = regular.reduce<ITextureState>((state, [key, raw]) => {
    const link = resolveRef(raw);
    const known = state.byLink.get(link);
    const position = known ?? state.list.length;
    const list = known !== undefined ? state.list : [...state.list, {
      key,
      texture: link.startsWith("#") ? { ...baseTexture(key, link, resolution) } : textureFromLink(key, link, packRoot, resolution, options),
    }];
    return {
      list,
      byKey: new Map([...state.byKey, [key, position]]),
      byPath: new Map([...state.byPath, [raw.replace(/^minecraft:/, ""), position]]),
      byLink: new Map([...state.byLink, [link, position]]),
    };
  }, { list: [], byKey: new Map(), byPath: new Map(), byLink: new Map() });
  const particleLink = typeof texturesIn.particle === "string" ? resolveRef(texturesIn.particle) : undefined;
  const afterParticle = ((): ITextureState => {
    if (particleLink === undefined) return afterRegular;
    const path = particleLink.replace(/^minecraft:/, "");
    const existing = afterRegular.byPath.get(path);
    if (existing !== undefined) {
      const list = afterRegular.list.map((entry, i) => (i === existing ? { ...entry, texture: { ...entry.texture, particle: true } } : entry));
      return { ...afterRegular, list };
    }
    const position = afterRegular.list.length;
    const texture = { ...textureFromLink("particle", particleLink, packRoot, resolution, options), particle: true };
    return {
      ...afterRegular,
      list: [...afterRegular.list, { key: "particle", texture }],
      byKey: new Map([...afterRegular.byKey, ["particle", position]]),
      byPath: new Map([...afterRegular.byPath, [path, position]]),
    };
  })();

  // Face textures that name no known key create empty `#id` textures, as Blockbench does.
  const faceRefs = elementsIn.flatMap((element) => (isJson(element.faces) ? Object.values(element.faces) : []))
    .flatMap((face) => (isJson(face) && typeof face.texture === "string" && face.texture !== "#missing" ? [face.texture] : []));
  const textureState = faceRefs.reduce<ITextureState>((state, ref) => {
    const id = ref.replace(/^#/, "");
    if (state.byKey.has(id)) return state;
    const byPath = state.byPath.get(ref);
    if (byPath !== undefined) {
      const entry = state.list[byPath];
      if (entry?.texture.id !== "particle") return { ...state, byKey: new Map([...state.byKey, [id, byPath]]) };
      const emptied: ITexture = { ...entry.texture, id, name: `#${id}`, path: "", folder: "", namespace: "", source: undefined };
      const list = state.list.map((item, i) => (i === byPath ? { ...item, texture: emptied } : item));
      return { ...state, list, byKey: new Map([...state.byKey, [id, byPath]]) };
    }
    const position = state.list.length;
    return { ...state, list: [...state.list, { key: id, texture: baseTexture(id, `#${id}`, resolution) }], byKey: new Map([...state.byKey, [id, position]]) };
  }, afterParticle);
  const faceTexture = (ref: unknown): number | undefined => {
    if (typeof ref !== "string" || ref === "#missing") return undefined;
    return textureState.byKey.get(ref.replace(/^#/, "")) ?? textureState.byPath.get(ref);
  };

  const cubes = elementsIn.map((element, i) => {
    const rotationIn = isJson(element.rotation) ? element.rotation : undefined;
    const from = mergeVec3(element.from, [0, 0, 0]);
    const to = mergeVec3(element.to, [16, 16, 16]);
    const facesIn = isJson(element.faces) ? element.faces : {};
    const originIn = rotationIn ? mergeVec3(rotationIn.origin, [0, 0, 0]) : [0, 0, 0] as Vec3;
    const rotatedIn = Array.isArray(element.rotated) ? mergeVec3(element.rotated, [0, 0, 0]) : [0, 0, 0] as Vec3;
    const axisIndex = typeof rotationIn?.axis === "string" ? AXIS_LETTERS.indexOf(rotationIn.axis.toLowerCase() as "x") : -1;
    const angle = numberOf(rotationIn?.angle);
    const newStyle = rotationIn && !rotationIn.axis && (rotationIn.x || rotationIn.y || rotationIn.z);
    const rotation: Vec3 = (() => {
      if (rotationIn?.axis && angle && axisIndex >= 0) return [0, 1, 2].map((a) => (a === axisIndex ? angle : 0)) as Vec3;
      if (newStyle) return [mergeNumber(rotationIn.x, 0) || 0, mergeNumber(rotationIn.y, 0) || 0, mergeNumber(rotationIn.z, 0) || 0];
      return rotatedIn;
    })();
    const withoutUv = CUBE_FACES.some((key) => isJson(facesIn[key]) && !(facesIn[key] as Json).uv);
    const faces = Object.fromEntries(CUBE_FACES.map((key) => {
      const read = facesIn[key];
      if (!isJson(read)) return [key, { uv: [0, 0, 0, 0], texture: null }];
      const uvIn = Array.isArray(read.uv) ? read.uv : undefined;
      const fallback: UvRect = withoutUv ? relativeUv(key, from, to, resolution.width, resolution.height) : [0, 0, 16, 16];
      const uv = uvIn ? fallback.map((_, j) => (mergeNumber(uvIn[j], 0) * (j % 2 ? resolution.height : resolution.width)) / 16) as UvRect : fallback;
      const texture = faceTexture(read.texture);
      const cullface = typeof read.cullface === "string" && (CUBE_FACES as readonly string[]).includes(read.cullface) ? read.cullface : undefined;
      return [key, {
        uv,
        ...(numberOf(read.rotation) ? { rotation: read.rotation } : {}),
        ...(typeof read.tintindex === "number" ? { tint: read.tintindex } : {}),
        ...(cullface ? { cullface } : {}),
        ...(texture === undefined ? {} : { texture }),
      }];
    }));
    // Shade backwards compatibility: shade:false becomes an "up" override on 26.3+, and an override becomes shade:false before it.
    const shadeDirection = typeof element.shade_direction_override === "string" && element.shade_direction_override ? element.shade_direction_override : undefined;
    const shadeOff = element.shade === false || (shadeDirection !== undefined && !flags.shade_direction_override);
    const directionOverride = flags.shade_direction_override ? (element.shade === false ? "up" : shadeDirection) : undefined;
    const name = typeof element.__comment === "string" ? element.__comment : typeof element.name === "string" ? element.name : "cube";
    return {
      name,
      box_uv: false,
      rescale: rotationIn?.rescale === true,
      locked: false,
      render_order: "default",
      allow_mirror_modeling: true,
      from,
      to,
      autouv: withoutUv ? 2 : 0,
      color: numberOf(element.color) ?? i % MARKER_COLORS,
      ...(shadeOff ? { shade: false } : {}),
      ...(directionOverride === undefined ? {} : { shade_direction_override: directionOverride }),
      ...(numberOf(element.light_emission) ? { light_emission: element.light_emission } : {}),
      origin: originIn,
      ...(rotation.some((value) => value !== 0) ? { rotation } : {}),
      ...(typeof rotationIn?.axis === "string" && ["x", "y", "z"].includes(rotationIn.axis) ? { rotation_axis: rotationIn.axis } : {}),
      faces,
      type: "cube",
      uuid: crypto.randomUUID(),
      newStyle: Boolean(newStyle),
    };
  });
  const usesNewRotations = cubes.some((cube) => cube.newStyle);
  const finalVersion = usesNewRotations && javaVersionBelow(version, "1.21.11") ? "1.21.11" : version;
  const elements = cubes.map(({ newStyle: _newStyle, ...cube }) => cube);

  // groups: numbers index the imported elements, objects become groups (`parseGroupsForJava`).
  const groupsIn = Array.isArray(model.groups) ? model.groups : [];
  const grouped = buildGroupNodes(groupsIn, elements.map((element) => element.uuid));
  const outliner: OutlinerNode[] = [...elements.map((element) => element.uuid).filter((uuid) => !grouped.claimed.includes(uuid)), ...grouped.nodes];
  const groupDefs = grouped.groups;

  const itemLayers = Array.from({ length: 5 }, (_, i) => `layer${i}`).filter((key, i, keys) => keys.slice(0, i + 1).every((layer) => typeof texturesIn[layer] === "string"));
  const supported = new Set(["textures", "elements", "groups", "parent", "display", "__comment", "credit", "texture_size", "overrides", "ambientocclusion", "gui_light"]);
  const unhandled = Object.fromEntries(Object.entries(model).filter(([key]) => !supported.has(key)));
  const credit = typeof (model.credit || model.__comment) === "string" ? String(model.credit || model.__comment) : undefined;
  const display = normalizeDisplay(model.display);
  const fileName = options.modelPath ? basename(normalizePath(options.modelPath)).replace(/\.json$/i, "") : "";
  const doc = bbmodelSchema.parse({
    meta: { format_version: "5.0", model_format: "java_block", box_uv: false },
    name: options.name ?? fileName,
    ...(model.parent === undefined ? {} : { parent: model.parent }),
    java_block_version: finalVersion,
    ...(credit === undefined ? {} : { credit }),
    ...(model.ambientocclusion === false ? { ambientocclusion: false } : {}),
    ...(model.gui_light === "front" ? { front_gui_light: true } : {}),
    model_identifier: "",
    visible_box: [1, 1, 0],
    variable_placeholders: "",
    variable_placeholder_buttons: [],
    timeline_setups: [],
    unhandled_root_fields: unhandled,
    resolution,
    elements,
    groups: groupDefs,
    outliner,
    textures: textureState.list.map((entry) => entry.texture),
    ...(display ? { display } : {}),
    ...(Array.isArray(model.overrides) ? { overrides: [...model.overrides] } : {}),
  });
  const textureNotes = textureState.list.filter((entry) => !entry.texture.source && !entry.texture.name.startsWith("#") && entry.texture.name !== "")
    .map((entry) => entry.texture.path);
  return {
    doc,
    notes: [
      ...notes,
      ...(finalVersion !== baseVersion ? [`java_block_version raised to ${finalVersion} because the model uses ${usesNewRotations ? "x/y/z rotations" : "shade_direction_override"}.`] : []),
      ...(!input.elements && parentId !== undefined && ITEM_PARENTS.includes(parentId) && itemLayers.length > 0
        ? [`Generated item (${parentId}) with ${itemLayers.join(", ")}: Blockbench previews it with generated-item placeholders, which are not created headless.`]
        : []),
      ...(textureNotes.length > 0 ? [`${textureNotes.length} texture(s) stay path-linked without pixels: ${textureNotes.join(", ")}.`] : []),
    ],
  };
}
