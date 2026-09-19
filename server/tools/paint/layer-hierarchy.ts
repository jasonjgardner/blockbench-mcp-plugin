/**
 * Pure helpers for Blockbench 5.2 texture layer hierarchies.
 *
 * Since 5.2, `texture.layers` is a flat array of `TextureLayerItem`s: pixel
 * layers (`type: "pixel_layer"`) and layer groups (`type: "layer_group"`).
 * Nesting is expressed only through `parent_uuid` (empty for root items), and
 * Blockbench's `TextureLayerItem.solveLayerOrder` rebuilds the flat order from
 * each parent's children in their current relative order, bottom-most first.
 * These helpers compute the orders and lookups the layer tool needs; they never
 * touch Blockbench globals, so they are unit-testable.
 *
 * @module
 */

/** `type` of a Blockbench pixel layer (`TextureLayer`). */
export const PIXEL_LAYER_TYPE = "pixel_layer";

/** `type` of a Blockbench layer group (`TextureLayerGroup`). */
export const LAYER_GROUP_TYPE = "layer_group";

/**
 * The structural subset of `TextureLayerItem` the helpers read.
 * `parent_uuid` is empty, `null`, or absent for root items. `type` may be
 * absent on Blockbench 5.0/5.1, whose `TextureLayer` predates layer groups;
 * such items are pixel layers.
 */
export interface ILayerNode {
  readonly uuid: string;
  readonly name: string;
  readonly type?: string;
  readonly parent_uuid?: string | null;
}

/**
 * Whether `node` is a layer group. Compares `type` rather than using
 * `instanceof TextureLayerGroup`, because that class only exists since 5.2.
 */
export function isLayerGroupNode(node: ILayerNode): boolean {
  return node.type === LAYER_GROUP_TYPE;
}

/** The node's layer type; items without a `type` (5.0/5.1 layers) are pixel layers. */
export function layerNodeType(node: ILayerNode): string {
  return node.type ?? PIXEL_LAYER_TYPE;
}

/** Parent key of a node: its `parent_uuid`, or `""` for root items. */
export function parentKey(node: ILayerNode): string {
  return node.parent_uuid ?? "";
}

/**
 * Resolves a layer reference by UUID first, then by exact name.
 *
 * @param list - The texture's flat layer list.
 * @param ref - UUID or name of a layer or group.
 * @returns The single matching item.
 * @throws Error when nothing matches, or when a name matches several items
 *   (the message lists their UUIDs so the caller can disambiguate).
 */
export function findLayerNode<T extends ILayerNode>(list: readonly T[], ref: string): T {
  const byUuid = list.find(node => node.uuid === ref);
  if (byUuid) return byUuid;
  const byName = list.filter(node => node.name === ref);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(`Layer name "${ref}" is ambiguous; use one of these UUIDs: ${byName.map(node => node.uuid).join(", ")}.`);
  }
  const available = list.map(node => `"${node.name}" (${node.uuid})`).join(", ") || "none";
  throw new Error(`Layer "${ref}" not found. Available layers: ${available}. Use the list_layers action to inspect them.`);
}

/**
 * Ancestor groups of `node`, nearest first. Stops at a missing parent and
 * guards against malformed cyclic `parent_uuid` chains.
 */
export function ancestorsOf<T extends ILayerNode>(list: readonly T[], node: ILayerNode): T[] {
  const parent = list.find(candidate => candidate.uuid === parentKey(node) && parentKey(node) !== "");
  if (!parent) return [];
  const collect = (current: T, found: T[]): T[] => {
    if (found.includes(current) || found.length > list.length) return found;
    const next = list.find(candidate => candidate.uuid === parentKey(current) && parentKey(current) !== "");
    return next ? collect(next, [...found, current]) : [...found, current];
  };
  return collect(parent, []);
}

/** Nesting depth of `node`: 0 for root items, 1 inside one group, and so on. */
export function layerDepth(list: readonly ILayerNode[], node: ILayerNode): number {
  return ancestorsOf(list, node).length;
}

/** Whether `candidate` is `ancestor` itself or nested (at any depth) inside it. */
export function isSelfOrDescendant(list: readonly ILayerNode[], candidate: ILayerNode, ancestor: ILayerNode): boolean {
  return candidate === ancestor || ancestorsOf(list, candidate).includes(ancestor);
}

/** Every item nested inside `group` at any depth, in list order. */
export function descendantsOf<T extends ILayerNode>(list: readonly T[], group: ILayerNode): T[] {
  return list.filter(node => node !== group && isSelfOrDescendant(list, node, group));
}

/** Items directly inside the parent `parentUuid` (`""` for root), in list order (bottom-most first). */
export function siblingsIn<T extends ILayerNode>(list: readonly T[], parentUuid: string): T[] {
  return list.filter(node => parentKey(node) === parentUuid);
}

/**
 * Returns a new flat order where `node` sits at `targetIndex` among the other
 * items of its parent (0 = bottom-most). Out-of-range indices are clamped, so a
 * large index moves the item to the top of its parent.
 *
 * Only the relative order of siblings matters: Blockbench's
 * `TextureLayerItem.solveLayerOrder` must be applied to the result to restore
 * the grouped layout.
 *
 * @param list - Current flat layer list.
 * @param node - Item to move; must be in `list`.
 * @param targetIndex - Desired position among its siblings.
 */
export function moveAmongSiblings<T extends ILayerNode>(list: readonly T[], node: T, targetIndex: number): T[] {
  const without = list.filter(item => item !== node);
  const siblings = siblingsIn(without, parentKey(node));
  if (siblings.length === 0) return [...list];
  const index = Math.min(siblings.length, Math.max(0, Math.trunc(targetIndex)));
  const anchor = index === siblings.length ? siblings[siblings.length - 1] : siblings[index];
  const offset = index === siblings.length ? 1 : 0;
  return without.toSpliced(without.indexOf(anchor) + offset, 0, node);
}

/**
 * Returns a new flat order with `node` placed directly before or after `anchor`.
 * Used to put a re-parented item on top of a group's children (before the
 * group) or right above the group it left (after the group).
 *
 * @param list - Current flat layer list.
 * @param node - Item to move.
 * @param anchor - Item to position against; must differ from `node`.
 * @param side - `"before"` or `"after"` the anchor.
 */
export function placeNextTo<T extends ILayerNode>(list: readonly T[], node: T, anchor: T, side: "before" | "after"): T[] {
  const without = list.filter(item => item !== node);
  const anchorIndex = without.indexOf(anchor);
  if (anchorIndex === -1) return [...without, node];
  return without.toSpliced(anchorIndex + (side === "after" ? 1 : 0), 0, node);
}

/**
 * Counts pixel layers only, so auto-generated names like `Layer 3` ignore groups.
 * Items without a `type` (5.0/5.1 layers) count as pixel layers.
 */
export function countPixelLayers(list: readonly ILayerNode[]): number {
  return list.filter(node => layerNodeType(node) === PIXEL_LAYER_TYPE).length;
}
