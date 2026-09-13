/// <reference types="blockbench-types" />
import type { z } from "zod";
import { findTextureGroupOrThrow, findTextureOrThrow } from "@/lib/util";
import { updateMaterialPreview } from "@/lib/material-preview";
import { runUndoableEdit } from "@/lib/undo";
import {
  pbrChannelEnum,
  type RgbByteTuple,
  type RgbaByteTuple,
} from "@/lib/zodObjects";

/** One of the PBR channels a texture can occupy inside a Blockbench material group. */
export type PbrChannel = z.infer<typeof pbrChannelEnum>;

/**
 * Uniform material values written to `material_config` when a channel has no
 * texture map: RGBA color bytes, MER bytes, and the Bedrock 1.21.30+ subsurface byte.
 * Omitted keys leave the current config value untouched.
 */
export interface IMaterialValues {
  color_value?: RgbaByteTuple;
  mer_value?: RgbByteTuple;
  subsurface_value?: number;
}

/**
 * Requested channel assignments keyed like tool arguments (`color_texture`, ...):
 * a texture ID/name to assign, `"none"` to detach the current map, or omitted
 * to leave the channel unchanged.
 */
export type MaterialChannels = Partial<Record<`${PbrChannel}_texture`, string>>;

/**
 * One planned texture move applied inside a material undo edit.
 * `group` is the destination group UUID, or `""` to detach the texture.
 */
export interface ITextureChange {
  texture: Texture;
  group: string;
  channel: PbrChannel;
}

/** Blockbench material config including `subsurface_value`, which upstream typings omit. */
export interface IMaterialConfig extends TextureGroupMaterialConfig {
  subsurface_value: number;
}

/** Any Blockbench entity identified by UUID (textures, texture groups). */
export interface IUuidEntity {
  uuid: string;
}

/** Channels in tool-argument order; assignments are planned in this order. */
const MATERIAL_CHANNELS: readonly PbrChannel[] = ["color", "normal", "height", "mer"];

/**
 * Guards texture/material tools against running without an open project or,
 * when `material` is true, in a format without PBR support.
 *
 * @param material - Also require `Format.pbr`; pass `false` for plain textures.
 * @throws When no project is open, or PBR is required but unsupported.
 */
export function requireTextureProject(material = true): void {
  if (typeof Project === "undefined" || !Project) throw new Error("Open a project before editing textures or materials.");
  if (material && !Format.pbr) {
    throw new Error(
      "The current format does not support PBR materials. Use get_capabilities to choose a format with pbr support, such as 'free'."
    );
  }
}

/**
 * Returns the group's material config typed with `subsurface_value`.
 * Subsurface is a host property since Bedrock 1.21.30; upstream typings omit
 * it, so this is the single place that widens the type.
 *
 * @param group - Texture group whose config is read or written.
 * @returns The live config object (mutations affect the group).
 */
export function materialConfig(group: TextureGroup): IMaterialConfig {
  return group.material_config as IMaterialConfig;
}

/**
 * Resolves a PBR material by name or UUID in a PBR-capable project.
 *
 * @param id - Material name or UUID.
 * @returns The matching texture group with `is_material` set.
 * @throws When no project/PBR format is active, the group is missing, or it is not a material.
 */
export function findMaterial(id: string): TextureGroup {
  requireTextureProject();
  const group = findTextureGroupOrThrow(id);
  if (!group.is_material) {
    throw new Error(
      `Texture group "${id}" is not a PBR material. Use create_pbr_material or add_texture_group with is_material=true.`
    );
  }
  return group;
}

/**
 * De-duplicates Blockbench entities by UUID while keeping first-seen order,
 * so the same texture or group is never snapshotted or moved twice.
 *
 * @param items - Textures or texture groups, possibly repeated.
 * @returns A new array with one entry per UUID.
 */
export function uniqueByUuid<T extends IUuidEntity>(items: T[]): T[] {
  return [...new Map(items.map(item => [item.uuid, item])).values()];
}

/**
 * Plans the texture moves for a set of channel assignments on `group`.
 * Incoming textures are resolved first (so a missing reference fails before any
 * map is cleared); existing maps in each touched channel are detached, not deleted.
 *
 * @param group - Destination material.
 * @param channels - Requested assignments (`"none"` only detaches).
 * @returns Detach changes followed by assignment changes.
 * @throws When a texture is missing or requested for more than one channel.
 */
export function planChannels(group: TextureGroup, channels: MaterialChannels): ITextureChange[] {
  const assignments = MATERIAL_CHANNELS.flatMap(channel => {
    const id = channels[`${channel}_texture`];
    if (id === undefined || id === "none") return [];
    return [{ texture: findTextureOrThrow(id), group: group.uuid, channel }];
  });
  if (uniqueByUuid(assignments.map(change => change.texture)).length !== assignments.length) {
    throw new Error("A texture can occupy only one PBR channel. Use a different texture for each channel.");
  }
  const displaced = group.getTextures().flatMap(texture => {
    const channel = pbrChannelEnum.parse(texture.pbr_channel);
    const untouched = channels[`${channel}_texture`] === undefined;
    if (untouched || assignments.some(change => change.texture.uuid === texture.uuid)) return [];
    return [{ texture, group: "", channel }];
  });
  return [...displaced, ...assignments];
}

/** Collects the target group plus every group the changed textures currently belong to. */
function affectedGroups(group: TextureGroup, changes: ITextureChange[]): TextureGroup[] {
  const sourceIds = new Set(changes.map(change => change.texture.group));
  return uniqueByUuid([group, ...TextureGroup.all.filter(source => sourceIds.has(source.uuid))]);
}

/**
 * Computes the channels `group` would hold after `changes` are applied, without mutating anything.
 *
 * @param group - Material to project.
 * @param changes - Planned moves; pass `[]` to read the current channels.
 * @returns One entry per texture, so duplicates reveal channel conflicts.
 */
export function projectedChannels(group: TextureGroup, changes: ITextureChange[]): PbrChannel[] {
  const changed = new Set(changes.map(change => change.texture.uuid));
  return [
    ...group.getTextures()
      .filter(texture => !changed.has(texture.uuid))
      .map(texture => pbrChannelEnum.parse(texture.pbr_channel)),
    ...changes.filter(change => change.group === group.uuid).map(change => change.channel),
  ];
}

/** Enforces Blockbench's material rules on one projected channel list. */
function assertMaterialChannels(material: TextureGroup, channels: PbrChannel[]): void {
  if (new Set(channels).size !== channels.length) {
    throw new Error(
      `Material "${material.name}" would have multiple textures in one channel. Assign one texture per channel or use is_material=false for ordinary texture groups.`
    );
  }
  if (channels.includes("normal") && channels.includes("height")) {
    throw new Error(
      `Material "${material.name}" cannot use normal and height maps together. Set normal_texture or height_texture to 'none' in configure_material before switching.`
    );
  }
  if (channels.includes("mer") && !channels.includes("color")) {
    throw new Error(
      `Material "${material.name}" needs a color texture when using a MER texture in Blockbench. Assign a color map or remove the MER map and use mer_value.`
    );
  }
}

/** Rejects uniform values that Blockbench would silently ignore because a map still occupies the channel. */
function assertUniformValuesApply(channels: PbrChannel[], values: IMaterialValues): void {
  if (values.color_value && channels.includes("color")) {
    throw new Error("color_value requires no color texture. Set color_texture to 'none' in the same configure_material call.");
  }
  if (values.mer_value && channels.includes("mer")) {
    throw new Error("mer_value requires no MER texture. Set mer_texture to 'none' in the same configure_material call.");
  }
}

/**
 * Validates planned changes against every affected material before any edit starts.
 *
 * @param group - Target material (or ordinary group).
 * @param changes - Planned texture moves.
 * @param values - Uniform values that will be applied to `group`.
 * @returns The target plus source groups, for undo tracking.
 * @throws When a material would break a channel rule or a uniform value would be ignored.
 */
export function validateMaterialChanges(
  group: TextureGroup,
  changes: ITextureChange[],
  values: IMaterialValues = {}
): TextureGroup[] {
  const groups = affectedGroups(group, changes);
  groups
    .filter(candidate => candidate.is_material)
    .forEach(candidate => assertMaterialChannels(candidate, projectedChannels(candidate, changes)));
  assertUniformValuesApply(projectedChannels(group, changes), values);
  return groups;
}

/** Copies provided uniform values into the group's config; omitted keys are left as-is. */
function applyMaterialValues(group: TextureGroup, values: IMaterialValues): void {
  const config = materialConfig(group);
  if (values.color_value) config.color_value = [...values.color_value];
  if (values.mer_value) config.mer_value = [...values.mer_value];
  if (values.subsurface_value !== undefined) config.subsurface_value = values.subsurface_value;
}

/** Returns the lowest numeric texture ID not used in the project, matching Blockbench's own ID scheme. */
function firstUnusedTextureId(): string | undefined {
  const usedIds = new Set(Texture.all.map(existing => existing.id));
  return Array.from({ length: Texture.all.length + 1 }, (_, index) => String(index))
    .find(id => !usedIds.has(id));
}

/** Adds a staged texture, refusing Blockbench's path de-duplication so planned changes target this instance. */
function addStagedTexture(texture: Texture): void {
  texture.id = firstUnusedTextureId() ?? texture.uuid;
  const added = texture.add(false);
  if (added !== texture) {
    throw new Error(`Texture "${texture.name}" could not be added independently. Import using unique image paths.`);
  }
}

/** Marks affected materials dirty (the target keeps `saved`) and rebuilds their previews. */
function refreshMaterialPreviews(groups: TextureGroup[], target: TextureGroup, saved: boolean): void {
  groups.filter(candidate => candidate.is_material).forEach(candidate => {
    candidate.material_config.saved = candidate === target ? saved : false;
    updateMaterialPreview(candidate);
  });
}

/**
 * Validates and applies a material/texture-group edit as one undoable step.
 * A group or textures not yet in the project are added inside the edit, so
 * undo removes them and redo restores them together with membership changes.
 *
 * @param group - Target group; added to the project when not already present.
 * @param changes - Planned texture moves (see {@link planChannels}).
 * @param values - Uniform values applied to `group`.
 * @param message - Undo history label.
 * @param createdTextures - Detached textures to add during the edit.
 * @param saved - `saved` flag for `group`'s config (true after importing from disk).
 * @throws Validation errors before the edit, or the original error after reverting a failed edit.
 */
export function commitMaterialEdit(
  group: TextureGroup,
  changes: ITextureChange[],
  values: IMaterialValues,
  message: string,
  createdTextures: Texture[] = [],
  saved = false
): void {
  const groups = validateMaterialChanges(group, changes, values);
  const isNewGroup = !TextureGroup.all.includes(group);
  const trackedGroups = groups.filter(candidate => candidate !== group || !isNewGroup);
  const trackedTextures = uniqueByUuid(changes.map(change => change.texture))
    .filter(texture => !createdTextures.includes(texture));
  // These mutable aspect arrays are intentional: cancellation and the final
  // snapshot must include entities created after the initial snapshot.
  // `texture_groups` is a runtime aspect missing from blockbench-types.
  const aspects = { textures: trackedTextures, texture_groups: trackedGroups };
  runUndoableEdit(aspects, message, () => {
    if (isNewGroup) {
      trackedGroups.push(group);
      group.add();
    }
    createdTextures.forEach(texture => {
      trackedTextures.push(texture);
      addStagedTexture(texture);
    });
    changes.forEach(change => change.texture.extend({ group: change.group, pbr_channel: change.channel }));
    applyMaterialValues(group, values);
    refreshMaterialPreviews(groups, group, saved);
    Canvas.updateAll();
  });
}
