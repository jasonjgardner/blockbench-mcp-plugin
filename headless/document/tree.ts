/**
 * Read-only index over a 5.0 `.bbmodel` and immutable outliner edits.
 *
 * Blockbench keeps a live object graph (`Outliner.root`, `OutlinerNode.uuids`).
 * The headless server works on plain JSON instead, so every tool builds an
 * {@link IModelIndex} from the document: which group owns each node, which
 * nodes the outliner references, and in what order Blockbench would visit
 * them. Edits return new outliner arrays and never mutate their input.
 *
 * @module
 */

import { type IBBModel, type IElement, type IGroup, isGroupRef, type IOutlinerGroupRef, type OutlinerNode } from "./schema";

/** Whether an indexed node is a group or an element. */
export type NodeKind = "group" | "element";

/** Where one node sits in the outliner. */
export interface INodePlacement {
  kind: NodeKind;
  /** UUID of the owning group, or `null` at the outliner root. */
  parent: string | null;
  /** Depth below the root (root children are 0). */
  depth: number;
}

/** Lookup tables built from a document. */
export interface IModelIndex {
  readonly groups: ReadonlyMap<string, IGroup>;
  readonly elements: ReadonlyMap<string, IElement>;
  /** Placement of every node the outliner references. */
  readonly placement: ReadonlyMap<string, INodePlacement>;
  /** Node UUIDs in depth-first pre-order, the order Blockbench visits them. */
  readonly order: readonly string[];
  /** Outliner references whose UUID matches no group or element. */
  readonly danglingRefs: readonly string[];
  /** Nodes the outliner references more than once (including cycles); only the first placement counts. */
  readonly repeatedRefs: readonly string[];
  /** UUIDs used by more than one group or element. */
  readonly duplicateIds: readonly string[];
}

/**
 * Builds lookup tables for a document.
 *
 * @param doc - A parsed 5.0 document.
 */
export function indexModel(doc: IBBModel): IModelIndex {
  const allIds = [...doc.groups.map((group) => group.uuid), ...doc.elements.map((element) => element.uuid)];
  const seen = new Set<string>();
  const duplicateIds = [...new Set(allIds.filter((id) => seen.has(id) || !seen.add(id)))];
  const groups = new Map(doc.groups.map((group) => [group.uuid, group]));
  const elements = new Map(doc.elements.map((element) => [element.uuid, element]));
  const placement = new Map<string, INodePlacement>();
  const order: string[] = [];
  const danglingRefs: string[] = [];
  const repeatedRefs: string[] = [];
  const kindOf = (uuid: string): NodeKind | undefined => {
    if (groups.has(uuid)) return "group";
    return elements.has(uuid) ? "element" : undefined;
  };

  const visit = (node: OutlinerNode, parent: string | null, depth: number): void => {
    const uuid = isGroupRef(node) ? node.uuid : node;
    const kind = kindOf(uuid);
    if (!kind) {
      danglingRefs.push(uuid);
      return;
    }
    // First placement wins, so a cyclic or repeated reference can never recurse forever.
    if (placement.has(uuid)) {
      repeatedRefs.push(uuid);
      return;
    }
    placement.set(uuid, { kind, parent, depth });
    order.push(uuid);
    if (isGroupRef(node)) node.children.forEach((child) => visit(child, uuid, depth + 1));
  };
  doc.outliner.forEach((node) => visit(node, null, 0));
  return { groups, elements, placement, order, danglingRefs, repeatedRefs, duplicateIds };
}

/**
 * Group UUIDs from a node's parent up to the root.
 *
 * @returns Nearest ancestor first; empty for root nodes and unplaced nodes.
 */
export function ancestorsOf(index: IModelIndex, uuid: string): string[] {
  const parent = index.placement.get(uuid)?.parent ?? null;
  if (parent === null) return [];
  return [parent, ...ancestorsOf(index, parent)];
}

/** Every node UUID below a group, depth-first. */
export function descendantsOf(index: IModelIndex, groupUuid: string): string[] {
  const children = index.order.filter((id) => index.placement.get(id)?.parent === groupUuid);
  return children.flatMap((child) => [child, ...descendantsOf(index, child)]);
}

/** Element UUIDs directly inside a group (not in nested groups). */
export function directElementsOf(index: IModelIndex, groupUuid: string | null): string[] {
  return index.order.filter((id) => {
    const place = index.placement.get(id);
    return place?.kind === "element" && place.parent === groupUuid;
  });
}

/** Display name for a node UUID. */
export function nodeName(index: IModelIndex, uuid: string): string {
  return index.groups.get(uuid)?.name ?? index.elements.get(uuid)?.name ?? uuid;
}

/**
 * Resolves a node by UUID or by exact name.
 *
 * @param kinds - Which node kinds may match.
 * @throws Error when nothing matches or a name matches several nodes.
 */
export function resolveNode(index: IModelIndex, ref: string, kinds: readonly NodeKind[] = ["group", "element"]): { uuid: string; kind: NodeKind } {
  if (kinds.includes("group") && index.groups.has(ref)) return { uuid: ref, kind: "group" };
  if (kinds.includes("element") && index.elements.has(ref)) return { uuid: ref, kind: "element" };
  const matches = [
    ...(kinds.includes("group") ? [...index.groups.values()].filter((g) => g.name === ref).map((g) => ({ uuid: g.uuid, kind: "group" as const })) : []),
    ...(kinds.includes("element") ? [...index.elements.values()].filter((e) => e.name === ref).map((e) => ({ uuid: e.uuid, kind: "element" as const })) : []),
  ];
  const [only] = matches;
  if (matches.length === 1 && only) return only;
  if (matches.length > 1) throw new Error(`"${ref}" matches ${matches.length} ${kinds.join("/")} nodes; pass a UUID instead.`);
  throw new Error(`No ${kinds.join(" or ")} named or identified "${ref}".`);
}

/**
 * Returns a new outliner with `node` appended to `parent`'s children (or the root).
 *
 * @throws Error when `parent` is not a group in the outliner.
 */
export function insertNode(outliner: readonly OutlinerNode[], parent: string | null, node: OutlinerNode): OutlinerNode[] {
  if (parent === null) return [...outliner, node];
  if (!findNode(outliner, parent)) throw new Error(`Parent group ${parent} is not in the outliner.`);
  const walk = (entry: OutlinerNode): OutlinerNode => {
    if (!isGroupRef(entry)) return entry;
    if (entry.uuid === parent) return { ...entry, children: [...entry.children, node] };
    return { ...entry, children: entry.children.map(walk) };
  };
  return outliner.map(walk);
}

/** Finds the first outliner entry for `uuid`, depth-first. */
export function findNode(outliner: readonly OutlinerNode[], uuid: string): OutlinerNode | undefined {
  return outliner.reduce<OutlinerNode | undefined>((found, entry) => {
    if (found) return found;
    if ((isGroupRef(entry) ? entry.uuid : entry) === uuid) return entry;
    return isGroupRef(entry) ? findNode(entry.children, uuid) : undefined;
  }, undefined);
}

/**
 * Returns a new outliner without the node `uuid`, plus the removed subtree.
 *
 * @returns `removed` is `undefined` when the node was not referenced.
 */
export function detachNode(outliner: readonly OutlinerNode[], uuid: string): { outliner: OutlinerNode[]; removed: OutlinerNode | undefined } {
  const prune = (entries: readonly OutlinerNode[]): OutlinerNode[] =>
    entries.flatMap((entry): OutlinerNode[] => {
      if ((isGroupRef(entry) ? entry.uuid : entry) === uuid) return [];
      return isGroupRef(entry) ? [{ ...entry, children: prune(entry.children) }] : [entry];
    });
  return { outliner: prune(outliner), removed: findNode(outliner, uuid) };
}

/** All node UUIDs inside an outliner subtree, including its root. */
export function subtreeIds(node: OutlinerNode): string[] {
  if (!isGroupRef(node)) return [node];
  return [node.uuid, ...node.children.flatMap(subtreeIds)];
}

/** A fresh 5.0 group reference. */
export function groupRef(uuid: string): IOutlinerGroupRef {
  return { uuid, isOpen: false, children: [] };
}
