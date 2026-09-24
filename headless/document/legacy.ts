/**
 * Conversion between legacy (4.x) and current (5.0) `.bbmodel` layouts.
 *
 * Blockbench 5.0 made two changes that break round trips:
 *
 * 1. Group definitions moved out of the outliner into a top-level `groups[]`
 *    array. The outliner now holds `{ uuid, isOpen, children }` references.
 *    Blockbench 4.x cannot read that shape: it opens the file with an empty
 *    scene and no error.
 * 2. Position X, rotation X and rotation Y keyframe values changed sign.
 *
 * {@link upgradeToV5} mirrors `processCompatibility` (js/formats/bbmodel.js) and
 * the "legacy group support" branch of `Outliner.loadJSON`. {@link downgradeToV410}
 * mirrors the `export_legacy_project` action. Both work on plain JSON so they run
 * before schema validation.
 *
 * @module
 */

import { invertMolang } from "./molang";

/** Loosely typed JSON object. */
type JsonObject = Record<string, unknown>;

/** Result of a layout conversion. */
export interface IConversionResult {
  /** The converted document (a new object; the input is not modified). */
  doc: JsonObject;
  /** Human-readable notes about what changed. */
  notes: string[];
}

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Compares dotted version strings numerically.
 *
 * @returns Negative when `a < b`, zero when equal, positive when `a > b`.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  const length = Math.max(left.length, right.length);
  const diff = Array.from({ length }, (_, i) => (left[i] ?? 0) - (right[i] ?? 0)).find((value) => value !== 0);
  return diff ?? 0;
}

/** Reads `meta.format_version`, defaulting to `"0"` for headerless files. */
export function formatVersionOf(doc: JsonObject): string {
  const meta = isObject(doc.meta) ? doc.meta : {};
  return typeof meta.format_version === "string" ? meta.format_version : "0";
}

/** Keys Blockbench's `Group.compile(true)` writes into a legacy inline group. */
const LEGACY_GROUP_KEYS_DROPPED_FROM_REF = ["children", "isOpen"];

/** Group fields that only matter to the live editor and are not written to 4.10 files. */
const EDITOR_ONLY_GROUP_KEYS = ["_static", "primary_selected", "children"];

/**
 * Negates the keyframe values whose sign convention changed in 5.0.
 *
 * @param invertBezier - Also flip bezier handle values (the 4.x→5.0 import does this;
 *   Blockbench's legacy export does not, and this port matches that asymmetry).
 */
function invertKeyframeSigns(animations: unknown, invertBezier: boolean): unknown {
  if (!Array.isArray(animations)) return animations;
  const invertKeyframe = (keyframe: JsonObject): JsonObject => {
    const channel = keyframe.channel;
    const flipsX = channel === "position" || channel === "rotation";
    const flipsY = channel === "rotation";
    const dataPoints = Array.isArray(keyframe.data_points)
      ? keyframe.data_points.map((point: unknown) => {
          if (!isObject(point)) return point;
          const x = flipsX && point.x !== undefined && point.x !== "" ? invertMolang(point.x as string | number) : point.x;
          const y = flipsY && point.y !== undefined && point.y !== "" ? invertMolang(point.y as string | number) : point.y;
          return { ...point, ...(point.x === undefined ? {} : { x }), ...(point.y === undefined ? {} : { y }) };
        })
      : keyframe.data_points;
    const isBezier = invertBezier && keyframe.interpolation === "bezier";
    const flipHandle = (handle: unknown): unknown => {
      if (!isBezier || !Array.isArray(handle)) return handle;
      return handle.map((value: number, axis: number) => ((axis === 0 && flipsX) || (axis === 1 && flipsY) ? -value : value));
    };
    return {
      ...keyframe,
      data_points: dataPoints,
      ...(keyframe.bezier_left_value === undefined ? {} : { bezier_left_value: flipHandle(keyframe.bezier_left_value) }),
      ...(keyframe.bezier_right_value === undefined ? {} : { bezier_right_value: flipHandle(keyframe.bezier_right_value) }),
    };
  };
  return animations.map((animation: unknown) => {
    if (!isObject(animation) || !isObject(animation.animators)) return animation;
    const animators = Object.fromEntries(
      Object.entries(animation.animators).map(([id, animator]) => {
        if (!isObject(animator) || !Array.isArray(animator.keyframes)) return [id, animator];
        return [id, { ...animator, keyframes: animator.keyframes.map((kf: unknown) => (isObject(kf) ? invertKeyframe(kf) : kf)) }];
      }),
    );
    return { ...animation, animators };
  });
}

/** Splits a legacy outliner (inline groups) into 5.0 references plus group definitions. */
function extractGroups(outliner: unknown[], existing: ReadonlySet<string>): { outliner: unknown[]; groups: JsonObject[] } {
  const groups: JsonObject[] = [];
  const convert = (node: unknown): unknown => {
    if (!isObject(node)) return node;
    const children = Array.isArray(node.children) ? node.children.map(convert) : [];
    const isInlineGroup = node.name !== undefined;
    const uuid = typeof node.uuid === "string" ? node.uuid : crypto.randomUUID();
    if (isInlineGroup && !existing.has(uuid)) {
      const definition = Object.fromEntries(Object.entries(node).filter(([key]) => !LEGACY_GROUP_KEYS_DROPPED_FROM_REF.includes(key)));
      groups.push({ origin: [0, 0, 0], rotation: [0, 0, 0], ...definition, uuid });
    }
    return { uuid, isOpen: node.isOpen === true, children };
  };
  return { outliner: outliner.map(convert), groups };
}

/**
 * Converts any `.bbmodel` JSON to the 5.0 layout, as Blockbench does on open.
 *
 * Handles inline (legacy) outliner groups and the 5.0 keyframe sign change. The
 * 4.5 `shade → mirror_uv` fix-up for box-UV cubes is applied too. Files older
 * than 4.0 get a note, because their other quirks are not ported.
 *
 * @param raw - Parsed JSON of a `.bbmodel` file.
 * @returns A new document in 5.0 layout and notes describing the conversion.
 */
export function upgradeToV5(raw: JsonObject): IConversionResult {
  const version = formatVersionOf(raw);
  if (compareVersions(version, "5.0") >= 0) return { doc: raw, notes: [] };

  const notes = [`Converted from format ${version} to 5.0 in memory; the file is written as 5.0 on the next save.`];
  const tooOld = compareVersions(version, "4.0") < 0 ? ["Files older than format 4.0 may need opening and resaving in Blockbench first."] : [];
  const existingGroups = Array.isArray(raw.groups) ? raw.groups.filter(isObject) : [];
  const existingIds = new Set(existingGroups.map((group) => String(group.uuid)));
  const { outliner, groups } = extractGroups(Array.isArray(raw.outliner) ? raw.outliner : [], existingIds);
  const meta = isObject(raw.meta) ? raw.meta : {};
  // Before 4.5, box-UV projects stored mirrored UVs as `shade: false`. Blockbench keeps `shade` and adds `mirror_uv`.
  const shadeFix = compareVersions(version, "4.5") < 0 && meta.box_uv === true;
  const elements = Array.isArray(raw.elements)
    ? raw.elements.map((element: unknown) => (shadeFix && isObject(element) && element.shade === false ? { ...element, mirror_uv: true } : element))
    : raw.elements;
  const doc: JsonObject = {
    ...raw,
    meta: { ...meta, format_version: "5.0" },
    elements,
    groups: [...existingGroups, ...groups],
    outliner,
    ...(raw.animations === undefined ? {} : { animations: invertKeyframeSigns(raw.animations, true) }),
  };
  return { doc, notes: [...notes, ...tooOld] };
}

/**
 * Converts a 5.0 document to the 4.10 layout that Blockbench 4.x can open.
 *
 * Mirrors Blockbench's "Export Legacy Project" action: groups are inlined into the
 * outliner, `groups[]` is removed, and position X, rotation X and rotation Y
 * keyframe values are negated.
 *
 * @param doc - A document in 5.0 layout (plain JSON).
 * @returns The 4.10 document and notes.
 */
export function downgradeToV410(doc: JsonObject): IConversionResult {
  const groups = new Map(
    (Array.isArray(doc.groups) ? doc.groups : []).filter(isObject).map((group) => [String(group.uuid), group]),
  );
  const inline = (node: unknown): unknown => {
    if (!isObject(node)) return node;
    const definition = groups.get(String(node.uuid));
    const base = definition
      ? Object.fromEntries(Object.entries(definition).filter(([key]) => !EDITOR_ONLY_GROUP_KEYS.includes(key)))
      : {};
    const rotation = Array.isArray(base.rotation) && base.rotation.every((value) => value === 0) ? {} : { rotation: base.rotation };
    const { rotation: _rotation, ...rest } = base;
    return {
      ...rest,
      ...rotation,
      uuid: node.uuid,
      isOpen: node.isOpen === true,
      children: Array.isArray(node.children) ? node.children.map(inline) : [],
    };
  };
  const { groups: _groups, ...withoutGroups } = doc;
  const meta = isObject(doc.meta) ? doc.meta : {};
  const converted: JsonObject = {
    ...withoutGroups,
    meta: { ...meta, format_version: "4.10" },
    outliner: (Array.isArray(doc.outliner) ? doc.outliner : []).map(inline),
    ...(doc.animations === undefined ? {} : { animations: invertKeyframeSigns(doc.animations, false) }),
  };
  return {
    doc: converted,
    notes: [
      `Inlined ${groups.size} group(s) into the outliner and negated position/rotation X and rotation Y keyframes.`,
      "Bezier handles are not re-inverted, matching Blockbench's own legacy export.",
    ],
  };
}
