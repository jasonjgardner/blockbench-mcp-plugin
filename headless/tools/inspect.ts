/**
 * Read-only inspection tools for `.bbmodel` files.
 *
 * These are file-backed counterparts of the desktop tools `get_project_info`,
 * `list_outline`, `find_elements_by_criteria`, `list_textures` and the
 * animation listing. They read a file on disk instead of the active Blockbench
 * project, so any number of agents can run them at once without touching the
 * editor.
 *
 * @module
 */

import { z } from "zod";
import { type IBBModel, type IElement, type IGroup, isCube, isGroupRef, isMesh, type OutlinerNode } from "../document/schema";
import { resolveTexture } from "../edit/operations";
import { ancestorsOf, descendantsOf, indexModel, type IModelIndex, nodeName, resolveNode } from "../document/tree";
import { aabbSize, elementBoxes, groupTransforms, round, roundVec, unionAabb } from "../geometry/bounds";
import { apply } from "../geometry/math";
import { emptySamplingNotes, samplePose } from "../geometry/pose";
import { defineTool, fileParam, type IRegistrableTool } from "../tool";

const counts = (doc: IBBModel) => ({
  groups: doc.groups.length,
  cubes: doc.elements.filter(isCube).length,
  meshes: doc.elements.filter(isMesh).length,
  other_elements: doc.elements.filter((element) => !isCube(element) && !isMesh(element)).length,
  textures: doc.textures.length,
  animations: doc.animations?.length ?? 0,
});

const infoTool = defineTool({
  name: "bbmodel_info",
  title: "Model Info",
  description: "Summarizes a .bbmodel file: format, version, resolution, node counts, world-space bounds and the current revision. Start here before editing.",
  parameters: { file: fileParam },
  readOnly: true,
  async execute({ file }, { store }) {
    const { path, doc, revision, notes } = await store.read(file);
    const index = indexModel(doc);
    const bounds = unionAabb([...elementBoxes(doc, index).values()]);
    return {
      path,
      revision,
      name: doc.name,
      model_identifier: doc.model_identifier ?? "",
      format: doc.meta.model_format,
      format_version: doc.meta.format_version,
      box_uv: doc.meta.box_uv,
      resolution: { width: doc.resolution.width, height: doc.resolution.height },
      counts: counts(doc),
      bounds: bounds ? { min: roundVec(bounds.min), max: roundVec(bounds.max), size: roundVec(aabbSize(bounds)) } : null,
      ai_used: doc.ai_used === true,
      notes,
    };
  },
});

interface IOutlineEntry {
  name: string;
  uuid: string;
  type: string;
  origin?: number[];
  rotation?: number[];
  from?: number[];
  to?: number[];
  children?: IOutlineEntry[];
}

/** Transform fields shown for a node in the outline. */
function transformFields(group: IGroup | undefined, element: IElement | undefined): Partial<IOutlineEntry> {
  if (group) return { origin: group.origin, rotation: group.rotation };
  if (!element || (!isCube(element) && !isMesh(element))) return {};
  const rotation = element.rotation ? { rotation: element.rotation } : {};
  if (isCube(element)) return { from: element.from, to: element.to, origin: element.origin, ...rotation };
  return { origin: element.origin, ...rotation };
}

/**
 * Case-insensitive wildcard match in linear time: `*` matches any run of
 * characters; a pattern without `*` matches as a substring. Regular expressions
 * from tool input are avoided on purpose, since a crafted one can stall the process.
 */
export function matchesName(name: string, pattern: string): boolean {
  const text = name.toLowerCase();
  const parts = pattern.toLowerCase().split("*");
  if (parts.length === 1) return text.includes(parts[0] ?? "");
  const first = parts[0] ?? "";
  const last = parts.at(-1) ?? "";
  if (!text.startsWith(first) || !text.endsWith(last) || first.length + last.length > text.length) return false;
  const middle = text.slice(first.length, text.length - last.length);
  const end = parts.slice(1, -1).reduce<number>((cursor, part) => {
    if (cursor < 0) return cursor;
    const found = middle.indexOf(part, cursor);
    return found < 0 ? -1 : found + part.length;
  }, 0);
  return end >= 0;
}

function outlineEntry(index: IModelIndex, node: OutlinerNode, depth: number, maxDepth: number, transforms: boolean): IOutlineEntry[] {
  const uuid = isGroupRef(node) ? node.uuid : node;
  const group = index.groups.get(uuid);
  const element = index.elements.get(uuid);
  if (!group && !element) return [];
  const base: IOutlineEntry = { name: nodeName(index, uuid), uuid, type: group ? "group" : element?.type ?? "unknown" };
  const withTransforms = transforms ? { ...base, ...transformFields(group, element) } : base;
  if (!isGroupRef(node)) return [withTransforms];
  const children = depth < maxDepth ? node.children.flatMap((child) => outlineEntry(index, child, depth + 1, maxDepth, transforms)) : undefined;
  return [{ ...withTransforms, ...(children ? { children } : {}) }];
}

const outlineTool = defineTool({
  name: "bbmodel_outline",
  title: "Model Outline",
  description: "Returns the group/element tree of a .bbmodel file. Set transforms to include origins, rotations and cube from/to.",
  parameters: {
    file: fileParam,
    max_depth: z.number().int().min(0).max(64).default(64).describe("Deeper groups are listed without children."),
    transforms: z.boolean().default(false),
  },
  readOnly: true,
  async execute({ file, max_depth, transforms }, { store }) {
    const { doc, revision } = await store.read(file);
    const index = indexModel(doc);
    return { revision, outline: doc.outliner.flatMap((node) => outlineEntry(index, node, 0, max_depth, transforms)) };
  },
});

const findTool = defineTool({
  name: "bbmodel_find_elements",
  title: "Find Elements",
  description: "Finds elements in a .bbmodel file by name, type, containing group or texture. Returns world-space bounds for each match.",
  parameters: {
    file: fileParam,
    name: z.string().max(200).optional().describe("Case-insensitive name filter. * matches any characters (leg_*, *_l); without * it matches as a substring."),
    type: z.string().optional().describe("Element type such as cube, mesh or locator."),
    group: z.string().optional().describe("Only elements inside this group (UUID or name), at any depth."),
    texture: z.union([z.string(), z.number().int()]).optional().describe("Only cubes/meshes with a face using this texture (UUID, name or index)."),
    limit: z.number().int().min(1).max(1000).default(200),
  },
  readOnly: true,
  async execute({ file, name, type, group, texture, limit }, { store }) {
    const { doc, revision } = await store.read(file);
    const index = indexModel(doc);
    const groupId = group === undefined ? undefined : resolveNode(index, group, ["group"]).uuid;
    const textureIndex = texture === undefined ? undefined : resolveTexture(doc, texture);
    const boxes = elementBoxes(doc, index);
    const usesTexture = (element: IElement): boolean => {
      if (textureIndex === undefined) return true;
      if (!isCube(element) && !isMesh(element)) return false;
      const faces: { texture?: string | number | null }[] = Object.values(element.faces);
      return faces.some((face) => face.texture === textureIndex || face.texture === doc.textures[textureIndex]?.uuid);
    };
    const matches = doc.elements.filter(
      (element) =>
        (name === undefined || matchesName(element.name, name)) &&
        (type === undefined || element.type === type) &&
        (groupId === undefined || ancestorsOf(index, element.uuid).includes(groupId)) &&
        usesTexture(element),
    );
    const results = matches.slice(0, limit).map((element) => {
      const box = boxes.get(element.uuid);
      return {
        name: element.name,
        uuid: element.uuid,
        type: element.type,
        group: ancestorsOf(index, element.uuid).map((id) => nodeName(index, id))[0] ?? null,
        ...(box ? { bounds: { min: roundVec(box.min), max: roundVec(box.max) } } : {}),
      };
    });
    return { revision, total: matches.length, returned: results.length, elements: results };
  },
});

const getNodeTool = defineTool({
  name: "bbmodel_get_node",
  title: "Get Node",
  description: "Returns the saved data of one group or element (by UUID or exact name), its parent, and its world-space bounds. Group results list their children.",
  parameters: { file: fileParam, target: z.string().min(1).describe("UUID or exact name.") },
  readOnly: true,
  async execute({ file, target }, { store }) {
    const { doc, revision } = await store.read(file);
    const index = indexModel(doc);
    const node = resolveNode(index, target);
    const parentId = index.placement.get(node.uuid)?.parent ?? null;
    const parent = parentId === null ? null : { uuid: parentId, name: nodeName(index, parentId) };
    if (node.kind === "group") {
      const inside = descendantsOf(index, node.uuid).filter((id) => index.elements.has(id));
      const boxes = elementBoxes(doc, index, undefined, (element) => inside.includes(element.uuid));
      const bounds = unionAabb([...boxes.values()]);
      const children = index.order.filter((id) => index.placement.get(id)?.parent === node.uuid).map((id) => ({ uuid: id, name: nodeName(index, id), kind: index.placement.get(id)?.kind }));
      return { revision, kind: "group", data: index.groups.get(node.uuid), parent, children, bounds: bounds ? { min: roundVec(bounds.min), max: roundVec(bounds.max) } : null };
    }
    const data = index.elements.get(node.uuid);
    const box = elementBoxes(doc, index, undefined, (element) => element.uuid === node.uuid).get(node.uuid);
    return { revision, kind: "element", data, parent, bounds: box ? { min: roundVec(box.min), max: roundVec(box.max) } : null };
  },
});

const texturesTool = defineTool({
  name: "bbmodel_list_textures",
  title: "List Textures",
  description: "Lists the textures of a .bbmodel file with their index, size, and whether the image is embedded. Image data is not returned.",
  parameters: { file: fileParam },
  readOnly: true,
  async execute({ file }, { store }) {
    const { doc, revision } = await store.read(file);
    const textures = doc.textures.map((texture, index) => ({
      index,
      name: texture.name,
      uuid: texture.uuid,
      width: texture.width ?? null,
      height: texture.height ?? null,
      embedded: typeof texture.source === "string" && texture.source.startsWith("data:"),
      material: (doc.texture_groups ?? []).find((group) => group.uuid === texture.group)?.name ?? null,
      channel: texture.group ? texture.pbr_channel ?? "color" : null,
      wrap_mode: texture.wrap_mode ?? "limited",
      path: texture.path ?? "",
    }));
    const materials = (doc.texture_groups ?? []).map((group) => ({
      name: group.name,
      uuid: group.uuid,
      is_material: group.is_material === true,
      channels: Object.fromEntries(doc.textures.filter((texture) => texture.group === group.uuid).map((texture) => [texture.pbr_channel ?? "color", texture.name])),
      material_config: group.material_config ?? {},
    }));
    return { revision, resolution: doc.resolution, textures, materials };
  },
});

const animationsTool = defineTool({
  name: "bbmodel_list_animations",
  title: "List Animations",
  description: "Lists animation clips with length, loop mode and, per animated bone, how many keyframes each channel has.",
  parameters: { file: fileParam },
  readOnly: true,
  async execute({ file }, { store }) {
    const { doc, revision } = await store.read(file);
    const index = indexModel(doc);
    const animations = (doc.animations ?? []).map((animation) => ({
      name: animation.name,
      uuid: animation.uuid,
      length: animation.length,
      loop: animation.loop,
      bones: Object.entries(animation.animators).map(([id, animator]) => ({
        bone: index.groups.get(id)?.name ?? animator.name ?? id,
        uuid: id,
        type: animator.type,
        exists: index.groups.has(id),
        channels: Object.fromEntries([...Map.groupBy(animator.keyframes, (key) => key.channel)].map(([channel, keys]) => [channel, keys.length])),
      })),
    }));
    return { revision, animations };
  },
});

const samplePoseTool = defineTool({
  name: "bbmodel_sample_pose",
  title: "Sample Pose",
  description:
    "Evaluates an animation at a time and returns each animated bone's world pivot and offsets, plus the posed model bounds. Use it to check an animation numerically without rendering. Bezier keys are sampled linearly; Molang expressions other than plain numbers are skipped and listed.",
  parameters: {
    file: fileParam,
    animation: z.string().min(1).describe("Animation name or UUID."),
    time: z.number().min(0).describe("Seconds."),
  },
  readOnly: true,
  async execute({ file, animation, time }, { store }) {
    const { doc, revision } = await store.read(file);
    const clip = (doc.animations ?? []).find((entry) => entry.uuid === animation || entry.name === animation);
    if (!clip) throw new Error(`No animation named or identified "${animation}".`);
    const index = indexModel(doc);
    const notes = emptySamplingNotes();
    const pose = samplePose(clip, time, notes);
    const transforms = groupTransforms(index, pose);
    const bones = [...pose].map(([id, delta]) => {
      const group = index.groups.get(id);
      return {
        bone: group?.name ?? id,
        world_pivot: group ? roundVec(apply(transforms(id), group.origin)) : null,
        rotation: roundVec(delta.rotation),
        position: roundVec(delta.position),
        scale: roundVec(delta.scale),
      };
    });
    const bounds = unionAabb([...elementBoxes(doc, index, pose).values()]);
    return {
      revision,
      animation: clip.name,
      time: round(time, 4),
      bones,
      bounds: bounds ? { min: roundVec(bounds.min), max: roundVec(bounds.max) } : null,
      skipped_channels: notes.skippedChannels,
      approximated_bezier: notes.approximatedBezier,
    };
  },
});

/** Read-only inspection tools. */
export const inspectTools: readonly IRegistrableTool[] = [infoTool, outlineTool, findTool, getNodeTool, texturesTool, animationsTool, samplePoseTool];
