/**
 * Modded Entity (Java class) exporter for `.bbmodel` documents, ported from
 * Blockbench's `modded_entity` codec (`compile`, `getIdentifier`, `F`, `I` and
 * the `Templates` helpers in js/formats/java/modded_entity.ts).
 *
 * Conventions carried over exactly:
 *
 * - Groups are visited depth-first (`getAllGroups`). Root-level cubes go into a
 *   generated `bb_main` bone appended after every other bone.
 * - Rotated cubes cannot be rotated on their own in Java models, so each gets a
 *   `<cube>_r1` rotation subgroup placed right after its bone; cubes that share
 *   a rotation (and the pivot coordinates that matter for it) share a subgroup.
 * - Pivots are relative to the parent bone with X negated; with the project's
 *   `modded_entity_flip_y` (default on) Y is negated too and root bones get +24.
 * - Rotations are radians with X and Y negated (`Math.degToRad`).
 * - Floats print through `trimFloatNumber` (4 digits, trailing zeros trimmed) with
 *   an `F` suffix; UV offsets are floored; 1.12/1.14 templates floor cube sizes.
 *
 * The format sets `box_uv_float_size: true`, which only affects how Blockbench
 * lays out box UV in the editor (see `boxUvSize` in ../geometry/box-uv). The
 * codec itself writes `uv_offset` and measures sizes with `Cube.size(axis, true)`
 * (integer templates) or `Cube.size(axis, false)` (float templates).
 *
 * Not ported: the animation codec (`AnimationTemplates`, `compileFile`), the
 * `.java` importer (`parse`), and the codec's `compile` event for plugins.
 *
 * @module
 */

import { VERSION } from "@/lib/constants";
import { type IBBModel, type ICube, isCube, type Vec2, type Vec3 } from "../document/schema";
import { directElementsOf, type IModelIndex, indexModel } from "../document/tree";
import { MODDED_ENTITY_TEMPLATES, type ModdedEntityTemplateId, templateText } from "./modded-entity-templates";

export {
  DEFAULT_MODDED_ENTITY_TEMPLATE,
  type IModdedEntityTemplateInfo,
  isModdedEntityTemplateId,
  MODDED_ENTITY_TEMPLATE_IDS,
  MODDED_ENTITY_TEMPLATE_LIST,
  type ModdedEntityTemplateId,
} from "./modded-entity-templates";

/** Options for {@link compileModdedEntity}. */
export interface IModdedEntityOptions {
  /** Template id (Blockbench's `Project.modded_entity_version`), such as `"1.17"`. */
  template: ModdedEntityTemplateId;
  /** Class name source, used like Blockbench's `Project.geometry_name`; defaults to `model_identifier`, then the model name. */
  modelName?: string;
  /** Entity type for the 1.17+ generics (`Project.modded_entity_entity_class`); defaults to the document's value, then `Entity`. */
  entityClass?: string;
  /** Flip Y the way `Project.modded_entity_flip_y` does; defaults to the document's value, then `true`. */
  flipY?: boolean;
  /** Text for the `Made with Blockbench %(bb_version)` header; defaults to this server's name and version. */
  bbVersion?: string;
}

/** Generated class plus notes on what was changed or left out. */
export interface IModdedEntityResult {
  /** The Java source. */
  code: string;
  /** Class name, also the file name Blockbench suggests (`fileName()`). */
  className: string;
  /** Skipped elements, UV conversions, renames and other departures from the document. */
  notes: string[];
}

/** One bone as the codec sees it: a group, the generated `bb_main`, or a rotation subgroup. */
interface IExportBone {
  readonly name: string;
  readonly origin: Vec3;
  readonly rotation: Vec3;
  readonly parent?: { readonly name: string; readonly origin: Vec3 };
  readonly exported: boolean;
  readonly isRotationSubgroup: boolean;
  /** Cube children in the order the codec writes them. */
  readonly cubes: readonly ICube[];
}

interface ITemplateContext {
  readonly template: ModdedEntityTemplateId;
  readonly flipY: boolean;
  readonly integerSize: boolean;
}

const ZERO: Vec3 = [0, 0, 0];

/** Port of `trimFloatNumber` (js/util/math_util.js): fixed to 4 digits, trailing zeros removed. */
function trimFloatNumber(value: number, maxDigits = 4): string {
  const text = value.toFixed(maxDigits).replace(/0+$/g, "").replace(/\.$/g, "");
  return text === "-0" ? "0" : text;
}

/** Port of `F()`: a Java float literal. */
const F = (value: number): string => {
  const text = trimFloatNumber(value);
  return `${text.includes(".") ? text : `${text}.0`}F`;
};

/** Port of `I()`: floors to an integer literal. */
const I = (value: number): string => String(Math.floor(value));

/** Port of `Math.degToRad` (js/util/math_util.js), kept in its exact arithmetic form. */
const degToRad = (deg: number): number => Math.PI / (180 / deg);

/** Port of `Templates.getVariableRegex`. */
const R = (name: string): RegExp => new RegExp(`%\\(${name}\\)`, "g");

/** Port of `Templates.keepLine`: drops the first `?(flag)` marker. */
const keepLine = (line: string): string => line.replace(/\?\(\w+\)/, "");

/** Replacer that keeps a conditional line when `condition` holds and removes it otherwise. */
const keepIf = (condition: boolean) => (line: string): string => (condition ? keepLine(line) : "");

const isZero = (v: readonly number[]): boolean => v.every((n) => n === 0);
const sameVec = (a: readonly number[], b: readonly number[]): boolean => a.every((n, i) => n === b[i]);
const rotationOf = (cube: ICube): Vec3 => cube.rotation ?? ZERO;

/**
 * Port of `OutlinerNode.sanitizeName` with the format's `node_name_regex: '\\w'`:
 * dashes become underscores, other non-word characters are dropped.
 */
export function sanitizeBoneName(name: string): string {
  return name.replace(/[^\w]/g, (char) => {
    if (char === "-") return "_";
    const lower = char.toLowerCase();
    return /^\w$/.test(lower) ? lower : "";
  });
}

/**
 * Port of `OutlinerNode.createUniqueName`: keeps `name` when no other name matches it
 * case-insensitively, else strips trailing digits and appends the first free number from 2
 * (from 1 when the name ends in a lone `0`).
 */
export function createUniqueName(name: string, others: readonly string[]): string {
  const taken = new Set(others.map((other) => other.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const start = /[^\d]0$/.test(name) ? 1 : 2;
  const base = name.replace(/\d+$/, "").replace(/\s+/g, "_");
  const free = Array.from({ length: 8000 - start }, (_, i) => i + start).find((n) => !taken.has(`${base}${n}`.toLowerCase()));
  return free === undefined ? name : `${base}${free}`;
}

/** Port of `getIdentifier()`: geometry name with whitespace/dashes as underscores, else the project name, else `CustomModel`. */
function getIdentifier(geometryName: string | undefined, projectName: string): string {
  return (geometryName && geometryName.replace(/[\s-]+/g, "_")) || projectName || "CustomModel";
}

/** Makes an identifier a legal Java class name (a guard Blockbench does not have). */
function javaClassName(identifier: string): string {
  const cleaned = identifier.replace(/[\s-]+/g, "_").replace(/[^\w$]/g, "");
  if (!cleaned) return "CustomModel";
  return /^\d/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/**
 * A cube as the box-UV-only format stores it. Per-face UV cubes are converted the way
 * `Cube.setUVMode(true)` does when Blockbench switches a project to box UV: the offset comes
 * from the east (or, when mirrored, west) face and the top face's bottom edge.
 */
function asBoxUvCube(cube: ICube, projectBoxUv: boolean): { cube: ICube; converted: boolean } {
  if (cube.box_uv ?? projectBoxUv) return { cube, converted: false };
  const { west, east, up } = cube.faces;
  if (!west || !east || !up) return { cube, converted: true };
  const mirror = west.uv[2] < east.uv[0];
  const uvOffset: Vec2 = [Math.round(mirror ? west.uv[2] : east.uv[0]), Math.round(up.uv[3])];
  return { cube: { ...cube, box_uv: true, mirror_uv: mirror, uv_offset: uvOffset }, converted: true };
}

/** Group names made legal and unique in outliner order, as Blockbench enforces them for `bone_rig` formats. */
function boneNames(index: IModelIndex, groupIds: readonly string[], notes: string[]): Map<string, string> {
  const names = groupIds.reduce<string[]>((acc, uuid) => {
    const original = index.groups.get(uuid)?.name ?? "";
    const name = createUniqueName(sanitizeBoneName(original) || "bone", acc);
    if (name !== original) notes.push(`Group "${original}" is exported as "${name}" (Java identifiers allow letters, digits and _; bone names must be unique).`);
    return [...acc, name];
  }, []);
  return new Map(groupIds.map((uuid, i) => [uuid, names[i] ?? uuid]));
}

/** Rotation subgroup lookup from `compile`: same rotation, and the same pivot on the axes that matter. */
function matchesSubgroup(sub: IExportBone, cube: ICube): boolean {
  if (!sameVec(sub.rotation, rotationOf(cube))) return false;
  if (sub.rotation.filter((n) => n).length > 1) return sameVec(sub.origin, cube.origin);
  return [0, 1, 2].every((i) => sub.rotation[i] !== 0 || sub.origin[i] === cube.origin[i]);
}

/**
 * Inserts rotation subgroups after each exported bone, as `compile` does: children are
 * visited in reverse (`forEachReverse`), and each new subgroup is spliced in after the
 * previous one.
 */
function withRotationSubgroups(bones: readonly IExportBone[]): IExportBone[] {
  const initial = { out: [] as IExportBone[], taken: bones.map((bone) => bone.name) };
  return bones.reduce((acc, bone) => {
    if (!bone.exported) return { out: [...acc.out, bone], taken: acc.taken };
    const rotated = [...bone.cubes].reverse().filter((cube) => cube.export !== false && !isZero(rotationOf(cube)));
    const subs = rotated.reduce<IExportBone[]>((list, cube) => {
      const match = list.findIndex((sub) => matchesSubgroup(sub, cube));
      if (match >= 0) return list.map((sub, i) => (i === match ? { ...sub, cubes: [...sub.cubes, cube] } : sub));
      const name = createUniqueName(`${sanitizeBoneName(cube.name)}_r1`, [...acc.taken, ...list.map((sub) => sub.name)]);
      const parent = { name: bone.name, origin: bone.origin };
      return [...list, { name, origin: cube.origin, rotation: rotationOf(cube), parent, exported: true, isRotationSubgroup: true, cubes: [cube] }];
    }, []);
    return { out: [...acc.out, bone, ...subs], taken: [...acc.taken, ...subs.map((sub) => sub.name)] };
  }, initial).out;
}

/** Collects bones in `getAllGroups` order plus `bb_main`, and records skipped elements. */
function collectBones(doc: IBBModel, index: IModelIndex, notes: string[]): IExportBone[] {
  const groupIds = index.order.filter((uuid) => index.placement.get(uuid)?.kind === "group");
  const names = boneNames(index, groupIds, notes);
  const converted: string[] = [];
  const boxCube = (cube: ICube): ICube => {
    const result = asBoxUvCube(cube, doc.meta.box_uv);
    if (result.converted) converted.push(cube.name);
    return result.cube;
  };
  const cubesOf = (parent: string | null): ICube[] =>
    directElementsOf(index, parent).flatMap((uuid) => {
      const element = index.elements.get(uuid);
      if (!element || element.export === false) return [];
      if (isCube(element)) return [boxCube(element)];
      notes.push(`Skipped ${element.type} "${element.name}": Java entity models only hold cubes.`);
      return [];
    });
  const groupBones = groupIds.flatMap((uuid): IExportBone[] => {
    const group = index.groups.get(uuid);
    if (!group) return [];
    const parentId = index.placement.get(uuid)?.parent ?? null;
    const parentGroup = parentId === null ? undefined : index.groups.get(parentId);
    const parent = parentGroup && parentId !== null ? { name: names.get(parentId) ?? parentGroup.name, origin: parentGroup.origin } : undefined;
    if (group.export === false) notes.push(`Group "${group.name}" is not exported; child bones still reference it, as in Blockbench.`);
    return [{ name: names.get(uuid) ?? group.name, origin: group.origin, rotation: group.rotation, parent, exported: group.export !== false, isRotationSubgroup: false, cubes: cubesOf(uuid) }];
  });
  // Blockbench gathers loose cubes from Cube.all, which follows the elements array, not the outliner.
  const rootIds = new Set(directElementsOf(index, null));
  const looseCubes = doc.elements.filter((element): element is ICube => rootIds.has(element.uuid) && isCube(element) && element.export !== false).map(boxCube);
  directElementsOf(index, null).forEach((uuid) => {
    const element = index.elements.get(uuid);
    if (element && !isCube(element) && element.export !== false) notes.push(`Skipped ${element.type} "${element.name}": Java entity models only hold cubes.`);
  });
  const mainBone: IExportBone[] = looseCubes.length
    ? [{ name: createUniqueName("bb_main", groupBones.map((bone) => bone.name)), origin: ZERO, rotation: ZERO, exported: true, isRotationSubgroup: false, cubes: looseCubes }]
    : [];
  if (converted.length) notes.push(`Per-face UV cubes converted to box UV the way Blockbench's setUVMode does (offset from the east/west and up faces): ${converted.join(", ")}.`);
  return [...groupBones, ...mainBone];
}

/** One cube line (`cube` template) inside `%(cubes)`. */
function cubeSnippet(ctx: ITemplateContext, bone: IExportBone, cube: ICube): string {
  const uv = cube.uv_offset ?? [0, 0];
  const mirror = cube.mirror_uv === true;
  const size = (axis: 0 | 1 | 2): number => cube.to[axis] - cube.from[axis];
  const floored = (axis: 0 | 1 | 2): number => Math.floor(size(axis) + 0.0000001);
  const y = ctx.flipY ? -cube.from[1] - size(1) + bone.origin[1] : cube.from[1] - bone.origin[1];
  const dims = ([0, 1, 2] as const).map((axis) => (ctx.integerSize ? I(floored(axis)) : F(size(axis))));
  return (templateText(ctx.template, "cube") ?? "")
    .replace(R("bone"), bone.name)
    .replace(R("uv_x"), I(uv[0]))
    .replace(R("uv_y"), I(uv[1]))
    .replace(R("inflate"), F(cube.inflate ?? 0))
    .replace(/{\?\(has_mirror\)(.+?)}/g, mirror ? "$1" : "")
    .replace(R("mirror"), String(mirror))
    .replace(R("x"), F(bone.origin[0] - cube.to[0]))
    .replace(R("y"), F(y))
    .replace(R("z"), F(cube.from[2] - bone.origin[2]))
    .replace(R("dx"), dims[0] ?? "")
    .replace(R("dy"), dims[1] ?? "")
    .replace(R("dz"), dims[2] ?? "");
}

/** One bone definition (`bone` template), the body of `compile`'s `%(content)` loop. */
function boneSnippet(ctx: ITemplateContext, bone: IExportBone): string {
  const flat = isZero(bone.rotation);
  const hasParent = bone.parent !== undefined;
  const relative = bone.parent ? bone.origin.map((n, i) => n - (bone.parent?.origin[i] ?? 0)) : [...bone.origin];
  const y = relative[1] ?? 0;
  const pivotY = ctx.flipY ? -y + (hasParent ? 0 : 24) : y;
  const cubes = bone.cubes.filter((cube) => cube.export !== false && (isZero(rotationOf(cube)) || bone.isRotationSubgroup));
  return (templateText(ctx.template, "bone") ?? "")
    .replace(R("bone"), bone.name)
    .replace(/\n\?\(has_rotation\).+/, keepIf(!flat))
    .replace(/\n\?\(has_no_rotation\).+/, keepIf(flat))
    .replace(R("rx"), F(degToRad(-bone.rotation[0])))
    .replace(R("ry"), F(degToRad(-bone.rotation[1])))
    .replace(R("rz"), F(degToRad(bone.rotation[2])))
    .replace(R("x"), F(-(relative[0] ?? 0)))
    .replace(R("y"), F(pivotY))
    .replace(R("z"), F(relative[2] ?? 0))
    .replace(/(?:\n|^)\?\(has_parent\).+/, keepIf(hasParent))
    .replace(/(?:\n|^)\?\(has_no_parent\).+/, keepIf(!hasParent))
    .replace(/(?:\n|^)%\(remove_n\)/g, "")
    .trim()
    .replace(R("parent"), bone.parent?.name ?? "")
    .replace(R("cubes"), () => cubes.map((cube) => cubeSnippet(ctx, bone, cube)).join("\n"))
    .replace(/\n/g, "\n\t\t");
}

/** `%(model_parts)`: 1.17+ constructor lookups; empty for templates without `model_part`. */
function modelParts(ctx: ITemplateContext, bones: readonly IExportBone[]): string {
  const snippet = templateText(ctx.template, "model_part");
  if (snippet === undefined) return "";
  return bones
    .filter((bone) => !bone.isRotationSubgroup)
    .map((bone) =>
      snippet
        .replace(R("bone"), bone.name)
        .replace(/\t+/, "")
        .replace(/(?:\n|^)\?\(has_parent\).+/, keepIf(bone.parent !== undefined))
        .replace(/(?:\n|^)\?\(has_no_parent\).+/, keepIf(bone.parent === undefined))
        .trim()
        .replace(R("parent"), bone.parent?.name ?? ""),
    )
    .join("\n\t\t");
}

/** Integer-template notes: sizes Blockbench floors when writing `ModelBox`/`addBox(int...)`. */
function flooredSizeNotes(ctx: ITemplateContext, bones: readonly IExportBone[]): string[] {
  if (!ctx.integerSize) return [];
  const fractional = bones.flatMap((bone) => bone.cubes).filter((cube) => [0, 1, 2].some((axis) => !Number.isInteger(Math.round(((cube.to[axis] ?? 0) - (cube.from[axis] ?? 0)) * 1e6) / 1e6)));
  return fractional.length ? [`Template ${ctx.template} writes integer box sizes; these cube sizes were floored: ${[...new Set(fractional.map((cube) => cube.name))].join(", ")}.`] : [];
}

/**
 * Compiles a `.bbmodel` to a Java entity model class, as Blockbench's Modded Entity
 * "Export Java Entity" does.
 *
 * Meshes, locators and other non-cube elements are skipped and listed in `notes`.
 * Per-face UV cubes are converted to box UV as Blockbench does when a project switches
 * to this box-UV-only format.
 *
 * @param doc - A parsed 5.0 document.
 * @param options - Template id plus optional class name, entity class, Y flip and header version.
 * @returns The Java source, its class name, and notes on anything changed or left out.
 */
export function compileModdedEntity(doc: IBBModel, options: IModdedEntityOptions): IModdedEntityResult {
  const notes: string[] = [];
  const index = indexModel(doc);
  const docEntity = typeof doc.modded_entity_entity_class === "string" ? doc.modded_entity_entity_class : "";
  const docFlip = typeof doc.modded_entity_flip_y === "boolean" ? doc.modded_entity_flip_y : true;
  const template = options.template;
  const ctx: ITemplateContext = { template, flipY: options.flipY ?? docFlip, integerSize: MODDED_ENTITY_TEMPLATES[template].integer_size };
  const rawIdentifier = getIdentifier(options.modelName ?? doc.model_identifier, doc.name);
  const identifier = javaClassName(rawIdentifier);
  if (identifier !== rawIdentifier) notes.push(`Class name "${rawIdentifier}" is not a Java identifier; using "${identifier}".`);
  const entity = options.entityClass || docEntity || "Entity";
  const bones = withRotationSubgroups(collectBones(doc, index, notes)).filter((bone) => bone.exported);
  notes.push(...flooredSizeNotes(ctx, bones));
  const usesModelPart = templateText(template, "model_part") !== undefined;
  const fieldTemplate = templateText(template, "field") ?? "";
  const rendererTemplate = templateText(template, "renderer") ?? "";

  const code = (templateText(template, "file") ?? "")
    .replace(R("bb_version"), () => options.bbVersion ?? `MCP headless ${VERSION}`)
    .replace(R("entity"), () => entity)
    .replace(R("identifier"), () => identifier)
    .replace(R("identifier_rl"), () => identifier.toLowerCase().replace(" ", "_"))
    .replace(R("texture_width"), () => String(doc.resolution.width))
    .replace(R("texture_height"), () => String(doc.resolution.height))
    .replace(R("fields"), () => bones.filter((bone) => !(bone.isRotationSubgroup && usesModelPart)).map((bone) => fieldTemplate.replace(R("bone"), bone.name)).join("\n\t"))
    .replace(R("content"), () => bones.map((bone) => boneSnippet(ctx, bone)).join("\n\n\t\t"))
    .replace(R("model_parts"), () => modelParts(ctx, bones))
    // No template sets `render_subgroups`, so only root bones render.
    .replace(R("renderers"), () => bones.filter((bone) => bone.parent === undefined).map((bone) => rendererTemplate.replace(R("bone"), bone.name)).join("\n\t\t"));
  return { code, className: identifier, notes };
}

