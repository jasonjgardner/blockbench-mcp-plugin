/// <reference types="three" />
/// <reference types="blockbench-types" />
import type { z } from "zod";
import { createTool } from "@/lib/factories";
import { runUndoableEdit } from "@/lib/undo";
import { getAndActivateTexture } from "@/lib/util";
import { paintToolDocs } from "./docs";
import {
  ancestorsOf,
  countPixelLayers,
  descendantsOf,
  findLayerNode,
  isLayerGroupNode,
  isSelfOrDescendant,
  layerDepth,
  layerNodeType,
  moveAmongSiblings,
  parentKey,
  placeNextTo,
  siblingsIn,
} from "./layer-hierarchy";
import { supportsLayerGroups } from "./runtime";
import { textureLayerManagementParameters, type textureLayerActionEnum } from "./schemas";

/** Validated `texture_layer_management` input. */
type LayerParams = z.infer<typeof textureLayerManagementParameters>;

/** One `texture_layer_management` action name. */
type LayerAction = z.infer<typeof textureLayerActionEnum>;

/** Texture plus caller input handed to every action. */
interface ILayerActionContext {
  texture: Texture;
  params: LayerParams;
}

/**
 * A layer action. `prepare` validates input and resolves targets without
 * touching state (so invalid calls never open an undo entry); read-only
 * actions return their result directly, mutating ones return the mutation
 * that runs inside one undo entry.
 */
type LayerActionSpec =
  | { readonly mutates: false; readonly run: (context: ILayerActionContext) => string }
  | { readonly mutates: true; readonly prepare: (context: ILayerActionContext) => () => string };

/** Default name Blockbench gives new layer groups. */
const DEFAULT_GROUP_NAME = "Layer Group";

/** Actions that only make sense with layer groups, which Blockbench added in 5.2. */
const GROUP_ONLY_ACTIONS: ReadonlySet<LayerAction> = new Set(["create_group", "ungroup", "move_to_group", "set_group_folded"]);

/** Throws a clear error instead of a ReferenceError when the host predates layer groups. */
function requireLayerGroupSupport(action: LayerAction): void {
  if (supportsLayerGroups()) return;
  throw new Error(`"${action}" requires Blockbench 5.2 or newer (texture layer groups). Update Blockbench to use layer groups.`);
}

/**
 * Whether an item is a layer group. Compares `type` because the
 * `TextureLayerGroup` class is missing on 5.0/5.1, where `instanceof` would throw.
 */
function isLayerGroup(item: TextureLayerItem): item is TextureLayerGroup {
  return isLayerGroupNode(item);
}

/** Throws unless the texture uses layers. */
function requireLayersEnabled(texture: Texture): void {
  if (!texture.layers_enabled) {
    throw new Error(`Texture "${texture.name}" has no layers. Use action "create_layer" to enable layers first.`);
  }
}

/**
 * Resolves the item an action works on: `layer_id` (UUID or name) when given,
 * otherwise the texture's selected layer or group.
 */
function resolveTarget({ texture, params }: ILayerActionContext): TextureLayerItem {
  requireLayersEnabled(texture);
  if (params.layer_id !== undefined) return findLayerNode(texture.layers, params.layer_id);
  if (texture.selected_layer) return texture.selected_layer;
  throw new Error("No layer selected. Pass layer_id (UUID or name); use action \"list_layers\" to see them.");
}

/** Narrows an item to a pixel layer, explaining when a group was targeted instead. */
function requirePixelLayer(item: TextureLayerItem, action: LayerAction): TextureLayer {
  if (item instanceof TextureLayer) return item;
  throw new Error(`"${action}" needs a pixel layer, but "${item.name}" is a layer group. Target a layer inside it with layer_id.`);
}

/** Narrows an item to a layer group. */
function requireGroup(item: TextureLayerItem, action: LayerAction): TextureLayerGroup {
  if (isLayerGroup(item)) return item;
  throw new Error(`"${action}" needs a layer group, but "${item.name}" is a pixel layer.`);
}

/**
 * Item a new group is inserted directly above: the top-most member when
 * grouping existing items, else the selected item if it shares the parent.
 */
function groupAnchor(texture: Texture, members: readonly TextureLayerItem[], parentUuid: string): TextureLayerItem | undefined {
  if (members.length > 0) {
    return members.reduce((top, item) => (texture.layers.indexOf(item) > texture.layers.indexOf(top) ? item : top));
  }
  const selected = texture.selected_layer;
  return selected && parentKey(selected) === parentUuid ? selected : undefined;
}

/** Resolves `group_id`: an empty string means the root (`null`), anything else must name a group. */
function resolveGroupRef(texture: Texture, groupId: string, action: LayerAction): TextureLayerGroup | null {
  if (groupId === "") return null;
  requireLayerGroupSupport(action);
  return requireGroup(findLayerNode(texture.layers, groupId), action);
}

/**
 * Flat order after re-parenting `target`: on top of the destination group's
 * children, or (for the root) directly above the outermost group it left.
 */
function placeForNewParent(
  list: readonly TextureLayerItem[],
  target: TextureLayerItem,
  destination: TextureLayerGroup | null,
  outermost: TextureLayerItem | undefined
): TextureLayerItem[] {
  if (destination) return placeNextTo(list, target, destination, "before");
  return outermost ? placeNextTo(list, target, outermost, "after") : [...list];
}

/** Parent UUID of the selected layer or group, or `""` (root) when nothing is selected. */
function selectedParentUuid(texture: Texture): string {
  return texture.selected_layer ? parentKey(texture.selected_layer) : "";
}

/**
 * Parent for a new item: the explicit `group_id` destination when given
 * (`null` = root), otherwise the selected layer's parent.
 */
function newItemParentUuid(texture: Texture, explicitGroup: TextureLayerGroup | null | undefined): string {
  if (explicitGroup === undefined) return selectedParentUuid(texture);
  return explicitGroup?.uuid ?? "";
}

/**
 * Replaces the texture's layer order in place with Blockbench's normalized
 * hierarchy order. The live array is kept because Undo re-reads it on finish.
 * Hosts without layer groups (5.0/5.1) have a flat list, so the order is used as is.
 */
function applyLayerOrder(texture: Texture, order: readonly TextureLayerItem[]): void {
  const solved = supportsLayerGroups() ? TextureLayerItem.solveLayerOrder([...order]) : [...order];
  texture.layers.splice(0, texture.layers.length, ...solved);
}

/** Creates a copy of a pixel layer (pixels included) with a new UUID, like Blockbench's duplicate action. */
function clonePixelLayer(texture: Texture, layer: TextureLayer): TextureLayer {
  const copy = new TextureLayer(layer.getUndoCopy(true), texture);
  copy.parent_uuid = layer.parent_uuid;
  return copy;
}

/** Creates an empty copy of a group; the constructor ignores `folded`, so it is set afterwards. */
function cloneGroupShell(texture: Texture, group: TextureLayerGroup, name: string): TextureLayerGroup {
  const copy = new TextureLayerGroup({ name }, texture);
  copy.parent_uuid = group.parent_uuid;
  copy.folded = group.folded;
  copy.visible = group.visible;
  return copy;
}

/**
 * Copies a group and everything nested in it, remapping `parent_uuid`s to the
 * copies, and returns the new items in flat order (children first, group last).
 */
function cloneGroupTree(texture: Texture, group: TextureLayerGroup, name: string): TextureLayerItem[] {
  const root = cloneGroupShell(texture, group, name);
  const descendants = descendantsOf(texture.layers, group);
  // Clone parents before children (children precede their group in flat order).
  const byDepth = descendants.toSorted((a, b) => layerDepth(texture.layers, a) - layerDepth(texture.layers, b));
  const clones = byDepth.reduce<ReadonlyMap<string, TextureLayerItem>>((map, item) => {
    const clone = isLayerGroup(item) ? cloneGroupShell(texture, item, item.name) : clonePixelLayer(texture, requirePixelLayer(item, "duplicate_layer"));
    clone.parent_uuid = map.get(item.parent_uuid)?.uuid ?? root.uuid;
    return new Map(map).set(item.uuid, clone);
  }, new Map([[group.uuid, root]]));
  const flat = descendants.flatMap(item => {
    const clone = clones.get(item.uuid);
    return clone ? [clone] : [];
  });
  return [...flat, root];
}

/** JSON description of one layer item for `list_layers`. */
function describeLayerItem(texture: Texture, item: TextureLayerItem, index: number): Record<string, unknown> {
  const base = {
    index,
    uuid: item.uuid,
    name: item.name,
    type: layerNodeType(item),
    parent_uuid: parentKey(item) || null,
    depth: layerDepth(texture.layers, item),
    sibling_index: siblingsIn(texture.layers, parentKey(item)).indexOf(item),
    visible: item.visible,
    selected: texture.selected_layer === item,
  };
  if (isLayerGroup(item)) {
    return { ...base, folded: Boolean(item.folded), child_count: item.children.length };
  }
  if (item instanceof TextureLayer) {
    return { ...base, opacity: item.opacity, blend_mode: item.blend_mode, width: item.width, height: item.height, offset: [...item.offset] };
  }
  return base;
}

/** Layer action table; every action name in the schema has exactly one entry. */
const LAYER_ACTIONS: Record<LayerAction, LayerActionSpec> = {
  list_layers: {
    mutates: false,
    run: ({ texture }) => {
      const active: unknown = texture.layers_enabled ? texture.getActiveLayer() : undefined;
      return JSON.stringify({
        texture: texture.name,
        layers_enabled: Boolean(texture.layers_enabled),
        order: "bottom_to_top",
        selected_layer: texture.selected_layer?.uuid ?? null,
        paint_target: active instanceof TextureLayer ? active.uuid : null,
        layers: texture.layers.map((item, index) => describeLayerItem(texture, item, index)),
      }, null, 2);
    },
  },

  select_layer: {
    mutates: false,
    run: (context) => {
      const target = resolveTarget(context);
      target.select();
      return `Selected ${isLayerGroup(target) ? "layer group" : "layer"} "${target.name}"`;
    },
  },

  create_layer: {
    mutates: true,
    prepare: ({ texture, params }) => {
      const group = params.group_id === undefined ? undefined : resolveGroupRef(texture, params.group_id, "create_layer");
      const name = params.layer_name ?? `Layer ${countPixelLayers(texture.layers) + 1}`;
      return () => {
        if (!texture.layers_enabled) texture.activateLayers(false);
        const layer = new TextureLayer({ name }, texture);
        layer.setSize(texture.width, texture.height);
        // 5.0/5.1 layers have no parent_uuid; only nest where groups exist.
        if (supportsLayerGroups()) layer.parent_uuid = newItemParentUuid(texture, group);
        layer.addForEditing();
        if (group) applyLayerOrder(texture, placeNextTo(texture.layers, layer, group, "before"));
        texture.updateChangesAfterEdit();
        return `Created layer "${layer.name}" (${layer.uuid})${group ? ` in group "${group.name}"` : ""}`;
      };
    },
  },

  delete_layer: {
    mutates: true,
    prepare: (context) => {
      const { texture } = context;
      const target = resolveTarget(context);
      const removed = [...descendantsOf(texture.layers, target), target];
      const remainingPixelLayers = texture.layers.filter(item => item instanceof TextureLayer && !removed.includes(item));
      if (remainingPixelLayers.length === 0) {
        throw new Error(`Cannot delete "${target.name}": it would remove the last pixel layer. Use "flatten_layers" to disable layers instead.`);
      }
      return () => {
        removed.forEach(item => item.remove(false));
        texture.updateChangesAfterEdit();
        const extra = removed.length > 1 ? ` and ${removed.length - 1} nested item(s)` : "";
        return `Deleted "${target.name}"${extra}`;
      };
    },
  },

  duplicate_layer: {
    mutates: true,
    prepare: (context) => {
      const { texture, params } = context;
      const target = resolveTarget(context);
      const name = params.layer_name ?? `${target.name} copy`;
      return () => {
        const copies = isLayerGroup(target)
          ? cloneGroupTree(texture, target, name)
          : [clonePixelLayer(texture, requirePixelLayer(target, "duplicate_layer"))];
        const top = copies[copies.length - 1];
        top.name = name;
        const index = texture.layers.indexOf(target);
        applyLayerOrder(texture, texture.layers.toSpliced(index + 1, 0, ...copies));
        top.select();
        texture.updateChangesAfterEdit();
        return `Duplicated "${target.name}" as "${top.name}" (${top.uuid})`;
      };
    },
  },

  merge_down: {
    mutates: true,
    prepare: (context) => {
      const { texture } = context;
      const layer = requirePixelLayer(resolveTarget(context), "merge_down");
      const below: TextureLayerItem | undefined = texture.layers[texture.layers.indexOf(layer) - 1];
      if (!(below instanceof TextureLayer)) {
        const reason = below ? `the item below is layer group "${below.name}"` : "it is the bottom-most layer";
        throw new Error(`Cannot merge "${layer.name}" down: ${reason}. Move it above a pixel layer first.`);
      }
      return () => {
        layer.mergeDown(false);
        texture.updateChangesAfterEdit();
        const crossesGroup = parentKey(layer) !== parentKey(below) ? " (the layer below is in a different group)" : "";
        return `Merged "${layer.name}" down into "${below.name}"${crossesGroup}`;
      };
    },
  },

  set_opacity: {
    mutates: true,
    prepare: (context) => {
      const { opacity } = context.params;
      if (opacity === undefined) throw new Error("set_opacity requires opacity (0-100).");
      const layer = requirePixelLayer(resolveTarget(context), "set_opacity");
      return () => {
        layer.opacity = opacity;
        context.texture.updateChangesAfterEdit();
        return `Set opacity of "${layer.name}" to ${opacity}%`;
      };
    },
  },

  set_blend_mode: {
    mutates: true,
    prepare: (context) => {
      const { blend_mode } = context.params;
      if (!blend_mode) throw new Error("set_blend_mode requires blend_mode.");
      const layer = requirePixelLayer(resolveTarget(context), "set_blend_mode");
      const mode: TextureLayer["blend_mode"] = blend_mode === "normal" ? "default" : blend_mode;
      return () => {
        layer.blend_mode = mode;
        context.texture.updateChangesAfterEdit();
        return `Set blend mode of "${layer.name}" to ${mode}`;
      };
    },
  },

  move_layer: {
    mutates: true,
    prepare: (context) => {
      const { target_index } = context.params;
      if (target_index === undefined) throw new Error("move_layer requires target_index (position among siblings, 0 = bottom-most).");
      const target = resolveTarget(context);
      return () => {
        applyLayerOrder(context.texture, moveAmongSiblings(context.texture.layers, target, target_index));
        context.texture.updateChangesAfterEdit();
        const position = siblingsIn(context.texture.layers, parentKey(target)).indexOf(target);
        return `Moved "${target.name}" to position ${position} within ${target.parent ? `group "${target.parent.name}"` : "the root"}`;
      };
    },
  },

  rename_layer: {
    mutates: true,
    prepare: (context) => {
      const { layer_name } = context.params;
      if (!layer_name) throw new Error("rename_layer requires layer_name.");
      const target = resolveTarget(context);
      const oldName = target.name;
      return () => {
        target.name = layer_name;
        return `Renamed "${oldName}" to "${layer_name}"`;
      };
    },
  },

  flatten_layers: {
    mutates: true,
    prepare: ({ texture }) => {
      requireLayersEnabled(texture);
      return () => {
        // Composite the visible layers first; disabling layers keeps texture.canvas as the result.
        texture.updateLayerChanges(true);
        const count = texture.layers.length;
        texture.layers_enabled = false;
        texture.selected_layer = null;
        texture.layers.splice(0, texture.layers.length);
        texture.updateChangesAfterEdit();
        UVEditor.vue.layer = null;
        return `Flattened ${count} layer item(s) into the texture and disabled layers`;
      };
    },
  },

  toggle_visibility: {
    mutates: true,
    prepare: (context) => {
      const target = resolveTarget(context);
      const visible = context.params.visible ?? !target.visible;
      const affected = isLayerGroup(target) ? [target, ...target.getAllChildren()] : [target];
      return () => {
        affected.forEach(item => {
          item.visible = visible;
        });
        context.texture.updateChangesAfterEdit();
        return `${visible ? "Showed" : "Hid"} "${target.name}"${affected.length > 1 ? ` and ${affected.length - 1} nested item(s)` : ""}`;
      };
    },
  },

  create_group: {
    mutates: true,
    prepare: ({ texture, params }) => {
      if (params.layer_ids?.length) requireLayersEnabled(texture);
      const members = (params.layer_ids ?? []).map(ref => findLayerNode(texture.layers, ref));
      if (new Set(members.map(parentKey)).size > 1) {
        throw new Error("create_group: all layer_ids must share the same parent. Move them into one group level first.");
      }
      const explicitGroup = params.group_id === undefined ? undefined : resolveGroupRef(texture, params.group_id, "create_group");
      if (members.length > 0 && explicitGroup !== undefined && (explicitGroup?.uuid ?? "") !== parentKey(members[0])) {
        throw new Error("create_group: group_id must match the parent of layer_ids, or be omitted.");
      }
      const parentUuid = members.length > 0 ? parentKey(members[0]) : newItemParentUuid(texture, explicitGroup);
      return () => {
        if (!texture.layers_enabled) texture.activateLayers(false);
        const group = new TextureLayerGroup({ name: params.layer_name ?? DEFAULT_GROUP_NAME }, texture);
        group.parent_uuid = parentUuid;
        group.folded = params.folded ?? false;
        const anchor = groupAnchor(texture, members, parentUuid);
        const order = anchor ? placeNextTo(texture.layers, group, anchor, "after") : [...texture.layers, group];
        members.forEach(member => {
          member.parent_uuid = group.uuid;
        });
        applyLayerOrder(texture, order);
        group.select();
        texture.updateChangesAfterEdit();
        return `Created layer group "${group.name}" (${group.uuid}) with ${members.length} item(s)`;
      };
    },
  },

  ungroup: {
    mutates: true,
    prepare: (context) => {
      const group = requireGroup(resolveTarget(context), "ungroup");
      return () => {
        const children = group.children;
        children.forEach(child => {
          child.parent_uuid = group.parent_uuid;
        });
        group.remove(false);
        applyLayerOrder(context.texture, context.texture.layers);
        context.texture.updateChangesAfterEdit();
        return `Ungrouped "${group.name}"; ${children.length} item(s) moved to ${group.parent ? `group "${group.parent.name}"` : "the root"}`;
      };
    },
  },

  move_to_group: {
    mutates: true,
    prepare: (context) => {
      const { texture, params } = context;
      if (params.group_id === undefined) throw new Error("move_to_group requires group_id (group UUID or name, or \"\" for the root).");
      const target = resolveTarget(context);
      const destination = resolveGroupRef(texture, params.group_id, "move_to_group");
      if (destination && isSelfOrDescendant(texture.layers, destination, target)) {
        throw new Error(`Cannot move "${target.name}" into "${destination.name}": a group cannot contain itself.`);
      }
      const outermost = ancestorsOf(texture.layers, target).at(-1);
      const { target_index } = params;
      return () => {
        target.parent_uuid = destination?.uuid ?? "";
        const placed = placeForNewParent(texture.layers, target, destination, outermost);
        const order = target_index === undefined ? placed : moveAmongSiblings(placed, target, target_index);
        applyLayerOrder(texture, order);
        texture.updateChangesAfterEdit();
        return `Moved "${target.name}" to ${destination ? `group "${destination.name}"` : "the root"}`;
      };
    },
  },

  set_group_folded: {
    mutates: true,
    prepare: (context) => {
      const { folded } = context.params;
      if (folded === undefined) throw new Error("set_group_folded requires folded.");
      const group = requireGroup(resolveTarget(context), "set_group_folded");
      return () => {
        group.folded = folded;
        return `${folded ? "Folded" : "Unfolded"} layer group "${group.name}"`;
      };
    },
  },
};

/**
 * Registers `texture_layer_management` (`paintToolDocs[11]`): one layer or
 * layer-group action on a texture. Mutating actions are validated first, then
 * applied inside one undo entry (reverted if they throw) before the panels
 * refresh; `list_layers` and `select_layer` create no history.
 */
export function registerTextureLayerManagementTool(): void {
  createTool(
    paintToolDocs[11].name,
    {
      ...paintToolDocs[11],
      parameters: textureLayerManagementParameters,
      async execute(params) {
        const texture = getAndActivateTexture(params.texture_id);
        if (GROUP_ONLY_ACTIONS.has(params.action)) requireLayerGroupSupport(params.action);
        const spec = LAYER_ACTIONS[params.action];
        const context: ILayerActionContext = { texture, params };

        if (!spec.mutates) return spec.run(context);

        const mutation = spec.prepare(context);
        const result = runUndoableEdit(
          { textures: [texture], layers: texture.layers, bitmap: true },
          `Layer management: ${params.action}`,
          mutation
        );
        updateInterfacePanels();
        BARS.updateConditions();
        return result;
      },
    },
    paintToolDocs[11].status
  );
}
