/**
 * Geometry gates: automated checks for defects that numbers catch and eyes miss.
 *
 * Ported and generalized from the `gatekit` module of
 * https://github.com/Kizunad/bbmodel-maker (Python). The thresholds keep that
 * project's calibration and its reasoning:
 *
 * - **Contact needs all three axes.** Two boxes touch only when they overlap by more
 *   than `contact_overlap` on at least two axes and leave no visible gap
 *   (`contact_tolerance`) on the third. Checking two axes alone lets a part
 *   floating 0.06 units beside another pass.
 * - **Interpenetration is judged across groups only.** Adjacent segments of one
 *   part (same group) are meant to overlap. Thin overlaps are seating, not
 *   penetration, so only overlaps deeper than `interpenetration_depth` count.
 * - **Bounds are rotated bounds.** Every box is the world-space box of the
 *   rotated element under its rotated groups.
 *
 * Each gate has a matching defect injector in `./inject`, so a validation run can
 * prove the gate still detects the defect it exists for.
 *
 * @module
 */

import { blockCenter, BLOCK_CELL_SIZE, checkBlockBounds, OVERSIZED_BLOCK_MAX_CENTER_OFFSET, OVERSIZED_BLOCK_MAX_SIZE } from "@/lib/block-grid";
import { type IBBModel, type IElement, isCube, type Vec3 } from "../document/schema";
import { ancestorsOf, type IModelIndex, indexModel, nodeName } from "../document/tree";
import { aabbSize, elementBoxes, type IAabb, overlapPerAxis, round, roundVec } from "../geometry/bounds";
import { gateResult, type IGateResult, type IGateViolation, skippedGate } from "./types";

/** Which block-size rule `block_limits` enforces. */
export type BlockLimitMode = "none" | "java_block" | "bedrock_block";

/** What counts as "the same material" for the interpenetration exemption. */
export type MaterialKey = "none" | "color" | "texture";

/** Tunable thresholds. Defaults come from bbmodel-maker's calibration. */
export interface IGeometryGateOptions {
  /** Thinner than this on any axis is a sliver that renders as nothing (units). */
  minThickness: number;
  /** Allow zero-thickness planes (common for leaves, grass and flat decals). */
  allowPlanes: boolean;
  /** Largest gap on the third axis that still counts as touching. */
  contactTolerance: number;
  /** Overlap on two axes needed for a real contact face. */
  contactOverlap: number;
  /** Overlap depth on all three axes that counts as penetration rather than seating. */
  interpenetrationDepth: number;
  /** Element names allowed to float (deliberately detached parts). */
  freeElements: readonly string[];
  /** Node names excluded from the mirror check (deliberately asymmetric parts). */
  asymmetric: readonly string[];
  /** X coordinate of the symmetry plane; `undefined` picks 8 for Java block models and 0 otherwise. */
  mirrorX: number | undefined;
  /** Mirror tolerance in units. */
  mirrorTolerance: number;
  blockLimits: BlockLimitMode;
  materialKey: MaterialKey;
}

/** Default thresholds. */
export const DEFAULT_GEOMETRY_OPTIONS: IGeometryGateOptions = {
  minThickness: 0.2,
  allowPlanes: true,
  contactTolerance: 0.12,
  contactOverlap: 0.15,
  interpenetrationDepth: 0.55,
  freeElements: [],
  asymmetric: [],
  mirrorX: undefined,
  mirrorTolerance: 0.02,
  blockLimits: "none",
  materialKey: "none",
};

/** Gate IDs in run order. */
export const GEOMETRY_GATE_IDS = ["outliner", "unlisted_nodes", "degenerate", "block_limits", "floating", "interpenetration", "mirror"] as const;

/** One geometry gate ID. */
export type GeometryGateId = (typeof GEOMETRY_GATE_IDS)[number];

interface IGateContext {
  doc: IBBModel;
  index: IModelIndex;
  boxes: Map<string, IAabb>;
  options: IGeometryGateOptions;
}

/** Outliner references to missing nodes, and UUIDs used twice. Blockbench misloads both. */
function gateOutliner({ index }: IGateContext): IGateResult {
  const violations: IGateViolation[] = [
    ...index.danglingRefs.map((id) => ({ message: `Outliner references ${id}, which is neither a group nor an element.`, targets: [id] })),
    ...index.duplicateIds.map((id) => ({ message: `UUID ${id} is used by more than one node.`, targets: [id] })),
    ...[...new Set(index.repeatedRefs)].map((id) => ({ message: `${nodeName(index, id)} appears more than once in the outliner, or inside itself.`, targets: [nodeName(index, id)] })),
  ];
  return gateResult("outliner", "Outliner references resolve and UUIDs are unique", "error", violations);
}

/** Nodes missing from the outliner. Blockbench appends them to the root on open, outside their intended group. */
function gateUnlisted({ doc, index }: IGateContext): IGateResult {
  const missing = [...doc.elements, ...doc.groups].filter((node) => !index.placement.has(node.uuid));
  return gateResult(
    "unlisted_nodes",
    "Every group and element is placed in the outliner",
    "warning",
    missing.map((node) => ({ message: `${node.name || node.uuid} is not in the outliner; Blockbench will append it to the root.`, targets: [node.name || node.uuid] })),
  );
}

/** Cubes too thin to render, and inverted cubes. */
function gateDegenerate({ doc, options }: IGateContext): IGateResult {
  const violations = doc.elements.filter(isCube).flatMap((cube): IGateViolation[] => {
    const size = [0, 1, 2].map((axis) => (cube.to[axis] ?? 0) - (cube.from[axis] ?? 0));
    const magnitudes = size.map(Math.abs);
    const inverted = size.some((value) => value < 0);
    const thin = magnitudes.some((value) => value < options.minThickness && (value > 0 || !options.allowPlanes));
    return [
      ...(thin ? [{ message: `${cube.name} is ${roundVec(magnitudes).join("×")}; an axis is thinner than ${options.minThickness}.`, targets: [cube.name] }] : []),
      ...(inverted ? [{ message: `${cube.name} has "to" below "from" on an axis (size ${roundVec(size).join(", ")}).`, targets: [cube.name] }] : []),
    ];
  });
  return gateResult("degenerate", "No sliver or inverted cubes", "warning", violations);
}

/** Geometry outside the block-model limits of the chosen format. */
function gateBlockLimits({ doc, index, boxes, options }: IGateContext): IGateResult {
  const label = "Geometry stays inside the block-model limits";
  if (options.blockLimits === "none") return skippedGate("block_limits", label, "error", "Pass block_limits: java_block or bedrock_block to enable.");
  const javaBox: IAabb = { min: [-16, -16, -16], max: [32, 32, 32] };
  const violations = [...boxes].flatMap(([uuid, box]): IGateViolation[] => {
    const name = nodeName(index, uuid);
    if (options.blockLimits === "java_block") {
      const outside = [0, 1, 2].some((axis) => (box.min[axis] ?? 0) < (javaBox.min[axis] ?? 0) - 1e-6 || (box.max[axis] ?? 0) > (javaBox.max[axis] ?? 0) + 1e-6);
      return outside ? [{ message: `${name} spans ${roundVec(box.min)} → ${roundVec(box.max)}, outside Java's -16…32 element range.`, targets: [name] }] : [];
    }
    const check = checkBlockBounds(box, { maxSize: OVERSIZED_BLOCK_MAX_SIZE, maxCenterOffset: OVERSIZED_BLOCK_MAX_CENTER_OFFSET, cellSize: BLOCK_CELL_SIZE });
    return check.valid ? [] : [{ message: `${name} spans ${roundVec(box.min)} → ${roundVec(box.max)}, outside Bedrock's 30-unit box within 7 units of ${blockCenter()}.`, targets: [name] }];
  });
  const whole = [...boxes.values()];
  const overallCheck = options.blockLimits === "bedrock_block" && whole.length > 0;
  const overall = overallCheck
    ? (() => {
        const union: IAabb = {
          min: [0, 1, 2].map((axis) => Math.min(...whole.map((box) => box.min[axis] ?? 0))) as unknown as Vec3,
          max: [0, 1, 2].map((axis) => Math.max(...whole.map((box) => box.max[axis] ?? 0))) as unknown as Vec3,
        };
        const check = checkBlockBounds(union, { maxSize: OVERSIZED_BLOCK_MAX_SIZE, maxCenterOffset: OVERSIZED_BLOCK_MAX_CENTER_OFFSET, cellSize: BLOCK_CELL_SIZE });
        return check.within_size_limit ? [] : [{ message: `The whole model measures ${roundVec(check.size)}, over Bedrock's 30-unit limit.`, targets: [] }];
      })()
    : [];
  return gateResult("block_limits", label, "error", [...violations, ...overall]);
}

/** Whether two boxes share a contact face (see module notes). */
export function touches(a: IAabb, b: IAabb, contactTolerance: number, contactOverlap: number): boolean {
  const overlap = overlapPerAxis(a, b);
  return Math.min(...overlap) > -contactTolerance && overlap.filter((value) => value > contactOverlap).length >= 2;
}

/** Groups of mutually touching elements, largest first. */
export function contactComponents(uuids: readonly string[], boxes: ReadonlyMap<string, IAabb>, contactTolerance: number, contactOverlap: number): string[][] {
  const parent = new Map(uuids.map((id) => [id, id]));
  const find = (id: string): string => {
    const up = parent.get(id) ?? id;
    if (up === id) return id;
    const root = find(up);
    parent.set(id, root);
    return root;
  };
  uuids.forEach((a, i) =>
    uuids.slice(i + 1).forEach((b) => {
      const boxA = boxes.get(a);
      const boxB = boxes.get(b);
      if (boxA && boxB && touches(boxA, boxB, contactTolerance, contactOverlap)) parent.set(find(a), find(b));
    }),
  );
  const components = Map.groupBy(uuids, find);
  return [...components.values()].toSorted((x, y) => y.length - x.length);
}

/** Parts not connected to the main body. */
function gateFloating({ index, boxes, options }: IGateContext): IGateResult {
  const label = "Every part touches the main body";
  const free = new Set(options.freeElements);
  const candidates = [...boxes.keys()].filter((uuid) => !free.has(nodeName(index, uuid)));
  if (candidates.length < 2) return skippedGate("floating", label, "warning", "Needs at least two geometric elements.");
  const [, ...detached] = contactComponents(candidates, boxes, options.contactTolerance, options.contactOverlap);
  const violations = detached.map((component) => {
    const names = component.map((uuid) => nodeName(index, uuid));
    const shown = names.length > 6 ? `${names.slice(0, 6).join(", ")} and ${names.length - 6} more` : names.join(", ");
    return { message: `${shown} ${names.length === 1 ? "touches" : "touch"} nothing in the main body. Add to free_elements if intended.`, targets: names };
  });
  return gateResult("floating", label, "warning", violations);
}

/** Material key of an element for the same-material exemption. */
function materialOf(element: IElement, key: MaterialKey): string {
  if (key === "color") return String(element.color ?? "none");
  if (key === "texture" && isCube(element)) {
    const textures = Object.values(element.faces).map((face) => String(face.texture ?? "none"));
    const counts = Map.groupBy(textures, (texture) => texture);
    return [...counts.entries()].toSorted((a, b) => b[1].length - a[1].length)[0]?.[0] ?? "none";
  }
  return "none";
}

/** Deep overlaps between parts of different groups. */
function gateInterpenetration({ index, boxes, options }: IGateContext): IGateResult {
  const entries = [...boxes].map(([uuid, box]) => {
    const element = index.elements.get(uuid);
    return {
      uuid,
      box,
      name: nodeName(index, uuid),
      group: ancestorsOf(index, uuid)[0] ?? null,
      material: element ? materialOf(element, options.materialKey) : "none",
    };
  });
  const violations = entries.flatMap((a, i) =>
    entries.slice(i + 1).flatMap((b): IGateViolation[] => {
      const sameMaterial = options.materialKey !== "none" && a.material === b.material;
      if (a.group === b.group || sameMaterial) return [];
      const depth = Math.min(...overlapPerAxis(a.box, b.box));
      if (depth <= options.interpenetrationDepth) return [];
      return [{ message: `${a.name} and ${b.name} (different groups) interpenetrate by ${round(depth, 2)} units.`, targets: [a.name, b.name] }];
    }),
  );
  return gateResult("interpenetration", "Parts of different groups do not pass through each other", "warning", violations);
}

const SIDE_TOKENS: Readonly<Record<string, string>> = { l: "r", r: "l", left: "right", right: "left" };

/** Splits a name into word tokens and separators, keeping both. */
const tokenize = (name: string): string[] => name.split(/([_\-. ]+)/);

/** Which side a name is on, or `undefined` for center parts. */
export function sideOf(name: string): "left" | "right" | undefined {
  const token = tokenize(name.toLowerCase()).find((part) => part in SIDE_TOKENS);
  if (token === undefined) return undefined;
  return token.startsWith("l") ? "left" : "right";
}

/** The mirrored name: `arm_l` → `arm_r`, `Left Wing` → `Right Wing`. */
export function mirrorName(name: string): string {
  return tokenize(name)
    .map((part) => {
      const swapped = SIDE_TOKENS[part.toLowerCase()];
      if (swapped === undefined) return part;
      const isUpper = part === part.toUpperCase();
      const isTitle = part[0] === part[0]?.toUpperCase();
      if (isUpper) return swapped.toUpperCase();
      return isTitle ? `${swapped[0]?.toUpperCase() ?? ""}${swapped.slice(1)}` : swapped;
    })
    .join("");
}

/** Left/right parts that are not mirror images across the symmetry plane. */
function gateMirror({ doc, index, boxes, options }: IGateContext): IGateResult {
  const mirrorX = options.mirrorX ?? (doc.meta.model_format === "java_block" ? 8 : 0);
  const excluded = new Set(options.asymmetric);
  const pathOf = (uuid: string): string =>
    [...ancestorsOf(index, uuid).toReversed().map((id) => nodeName(index, id)), nodeName(index, uuid)].join("/");
  const isExcluded = (uuid: string): boolean => [uuid, ...ancestorsOf(index, uuid)].some((id) => excluded.has(nodeName(index, id)));
  const sided = [...boxes.keys()].filter((uuid) => !isExcluded(uuid)).map((uuid) => ({ uuid, path: pathOf(uuid) }));
  const byPath = Map.groupBy(sided, (entry) => entry.path);
  const lefts = sided.filter((entry) => entry.path.split("/").some((part) => sideOf(part) === "left"));
  const tol = options.mirrorTolerance;
  const violations = lefts.flatMap((left): IGateViolation[] => {
    const siblings = byPath.get(left.path) ?? [];
    const position = siblings.findIndex((entry) => entry.uuid === left.uuid);
    const matePath = left.path.split("/").map(mirrorName).join("/");
    const mate = byPath.get(matePath)?.[position];
    const name = nodeName(index, left.uuid);
    if (!mate) return [{ message: `${left.path} has no mirror counterpart ${matePath}.`, targets: [name] }];
    const a = boxes.get(left.uuid);
    const b = boxes.get(mate.uuid);
    if (!a || !b) return [];
    const mirroredX = Math.abs(a.min[0] + b.max[0] - 2 * mirrorX) <= tol && Math.abs(a.max[0] + b.min[0] - 2 * mirrorX) <= tol;
    const sameYZ = [1, 2].every((axis) => Math.abs((a.min[axis] ?? 0) - (b.min[axis] ?? 0)) <= tol && Math.abs((a.max[axis] ?? 0) - (b.max[axis] ?? 0)) <= tol);
    if (mirroredX && sameYZ) return [];
    return [{
      message: `${left.path} (x ${round(a.min[0], 2)}…${round(a.max[0], 2)}, size ${roundVec(aabbSize(a), 2)}) does not mirror ${matePath} (x ${round(b.min[0], 2)}…${round(b.max[0], 2)}, size ${roundVec(aabbSize(b), 2)}) across x = ${mirrorX}.`,
      targets: [name, nodeName(index, mate.uuid)],
    }];
  });
  if (lefts.length === 0) return skippedGate("mirror", "Left/right parts mirror each other", "warning", "No node names carry a left/right token (l, r, left, right).");
  return gateResult("mirror", "Left/right parts mirror each other", "warning", violations);
}

const GATES: Readonly<Record<GeometryGateId, (context: IGateContext) => IGateResult>> = {
  outliner: gateOutliner,
  unlisted_nodes: gateUnlisted,
  degenerate: gateDegenerate,
  block_limits: gateBlockLimits,
  floating: gateFloating,
  interpenetration: gateInterpenetration,
  mirror: gateMirror,
};

/**
 * Runs geometry gates on a document in its bind pose.
 *
 * @param gates - Which gates to run; defaults to all.
 */
export function runGeometryGates(doc: IBBModel, options: Partial<IGeometryGateOptions> = {}, gates: readonly GeometryGateId[] = GEOMETRY_GATE_IDS): IGateResult[] {
  const index = indexModel(doc);
  const context: IGateContext = {
    doc,
    index,
    boxes: elementBoxes(doc, index, undefined, (element) => index.placement.has(element.uuid)),
    options: { ...DEFAULT_GEOMETRY_OPTIONS, ...options },
  };
  return gates.map((id) => GATES[id](context));
}
