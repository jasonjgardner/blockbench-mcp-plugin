/**
 * Pure edit operations on `.bbmodel` documents.
 *
 * Every write tool reduces to a list of operations applied in one
 * read-modify-write cycle, so a batch either lands completely or not at all.
 * Operations take a document and return a new one; nothing is mutated. Nodes are
 * addressed by UUID or exact name, the same way the desktop tools do.
 *
 * @module
 */

import { z } from "zod";
import { MAX_AGENT_NAME_LENGTH } from "@/lib/ai-disclosure";
import {
  CUBE_FACES,
  type CubeFaceName,
  cubeFaceNameSchema,
  type IAnimation,
  type IBBModel,
  type ICube,
  type ICubeFace,
  isMesh,
  type IGroup,
  type IKeyframe,
  isCube,
  type ITexture,
  type ITextureGroup,
  PBR_CHANNELS,
  type PbrChannel,
  type UvRect,
  uvRectSchema,
  vec2Schema,
  vec3Schema,
} from "../document/schema";
import { ancestorsOf, detachNode, groupRef, indexModel, insertNode, resolveNode, subtreeIds } from "../document/tree";
import { boxUvSize, computeBoxUv, defaultFaceUv } from "../geometry/box-uv";
import { addLocatorOp, applyAddLocator, applyRemoveParticleKeyframe, applySetParticleKeyframe, removeParticleKeyframeOp, setParticleKeyframeOp } from "./particle-operations";
import { addMeshOp, addMeshPrimitiveOp, assignMeshTexture, editMeshOp, mapMeshUvOp, MESH_HANDLERS } from "./mesh-operations";
import { findAnimation, freshUuid } from "./refs";

const nodeRef = z.string().min(1).describe("UUID or exact name.");
const parentRef = z.string().min(1).nullable().optional().describe("Parent group UUID or name; null or omitted places the node at the root.");
const textureRef = z.union([z.string().min(1), z.number().int().min(0)]).describe("Texture UUID, name, or index in textures[].");
const keyValue = z.union([z.number(), z.string()]);

/** Face overrides for a cube. */
export const faceInputSchema = z.object({
  uv: uvRectSchema.optional().describe("[u1, v1, u2, v2] in project-resolution units (every texture spans 0..resolution whatever its pixel size); values past the resolution tile when the texture's wrap_mode is repeat. Ignored for box-UV cubes."),
  texture: textureRef.nullable().optional().describe("Texture for this face; null disables the face."),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
});

/** Adds a group (bone). */
export const addGroupOp = z.object({
  op: z.literal("add_group"),
  name: z.string().min(1),
  origin: vec3Schema.default([0, 0, 0]).describe("Pivot point."),
  rotation: vec3Schema.default([0, 0, 0]).describe("Degrees, applied Z·Y·X about the origin."),
  parent: parentRef,
  uuid: z.string().uuid().optional(),
});

/** Adds a cube. */
export const addCubeOp = z.object({
  op: z.literal("add_cube"),
  name: z.string().min(1),
  from: vec3Schema,
  to: vec3Schema,
  origin: vec3Schema.optional().describe("Rotation pivot; defaults to the cube center."),
  rotation: vec3Schema.optional(),
  inflate: z.number().optional(),
  parent: parentRef,
  box_uv: z.boolean().optional().describe("Defaults to the model's box_uv setting."),
  uv_offset: vec2Schema.optional().describe("Box-UV layout position."),
  mirror_uv: z.boolean().optional(),
  texture: textureRef.optional().describe("Texture for every face."),
  faces: z.record(cubeFaceNameSchema, faceInputSchema).optional(),
  uuid: z.string().uuid().optional(),
});

/** Changes a group or cube. */
export const updateNodeOp = z.object({
  op: z.literal("update_node"),
  target: nodeRef,
  name: z.string().min(1).optional(),
  origin: vec3Schema.optional(),
  rotation: vec3Schema.optional(),
  from: vec3Schema.optional().describe("Cubes only."),
  to: vec3Schema.optional().describe("Cubes only."),
  inflate: z.number().optional().describe("Cubes only."),
  uv_offset: vec2Schema.optional().describe("Cubes only."),
  faces: z.record(cubeFaceNameSchema, faceInputSchema).optional().describe("Cubes only. Per-face UV, texture or rotation changes; unlisted faces are kept."),
  mirror_uv: z.boolean().optional(),
  parent: z.string().min(1).nullable().optional().describe("Move under this group; null moves to the root."),
});

/** Deletes a node; groups are deleted with everything inside them. */
export const removeNodeOp = z.object({ op: z.literal("remove_node"), target: nodeRef });

/** Adds an embedded texture. */
export const addTextureOp = z.object({
  op: z.literal("add_texture"),
  name: z.string().min(1),
  source: z.string().startsWith("data:image/").describe("PNG data URL."),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  material: z.string().min(1).optional().describe("Material (UUID or name) this texture belongs to."),
  channel: z.enum(PBR_CHANNELS).optional().describe("PBR channel inside the material; defaults to color."),
  wrap_mode: z.enum(["limited", "repeat"]).optional().describe("repeat tiles the image when face UVs exceed the texture."),
  render_mode: z.enum(["default", "emissive", "additive", "layered"]).optional().describe("emissive makes the texture glow in Blockbench and bb-render (signs, light panels)."),
  uuid: z.string().uuid().optional(),
});

/** Adds a PBR material (a texture group with `is_material`). */
export const addMaterialOp = z.object({
  op: z.literal("add_material"),
  name: z.string().min(1),
  color_value: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe("Uniform RGBA 0-255, used when no color texture is assigned."),
  mer_value: z.tuple([z.number(), z.number(), z.number()]).optional().describe("Uniform metalness, emissive, roughness 0-255, used when no MER texture is assigned."),
  subsurface_value: z.number().min(0).max(255).optional(),
  uuid: z.string().uuid().optional(),
});

/** Changes a material's name or uniform values. */
export const updateMaterialOp = z.object({
  op: z.literal("update_material"),
  target: z.string().min(1).describe("Material UUID or name."),
  name: z.string().min(1).optional(),
  color_value: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  mer_value: z.tuple([z.number(), z.number(), z.number()]).optional(),
  subsurface_value: z.number().min(0).max(255).optional(),
});

/** Moves a texture into a material channel, renames it, or changes its wrap mode. */
export const updateTextureOp = z.object({
  op: z.literal("update_texture"),
  target: z.union([z.string().min(1), z.number().int().min(0)]).describe("Texture UUID, name, or index."),
  name: z.string().min(1).optional(),
  source: z.string().startsWith("data:image/").optional().describe("New PNG data URL; replaces the image and keeps every face and material assignment."),
  width: z.number().int().positive().optional().describe("Pixel width of the new source (required with source)."),
  height: z.number().int().positive().optional().describe("Pixel height of the new source (required with source)."),
  material: z.string().min(1).nullable().optional().describe("Material UUID or name; null removes the texture from its material."),
  channel: z.enum(PBR_CHANNELS).optional(),
  wrap_mode: z.enum(["limited", "repeat"]).optional(),
  render_mode: z.enum(["default", "emissive", "additive", "layered"]).optional().describe("emissive makes the texture glow in Blockbench and bb-render (signs, light panels)."),
});

/** Assigns a texture to cube faces. */
export const assignTextureOp = z.object({
  op: z.literal("assign_texture"),
  targets: z.array(nodeRef).min(1).describe("Cubes, meshes, or groups (every cube and mesh inside is assigned)."),
  texture: textureRef.nullable().describe("null disables the faces."),
  faces: z.array(cubeFaceNameSchema).optional().describe("Cube faces; defaults to all six."),
  mesh_faces: z.array(z.string().min(1)).optional().describe("Mesh face keys; defaults to every face of each mesh."),
});

/** Adds an animation clip. */
export const addAnimationOp = z.object({
  op: z.literal("add_animation"),
  name: z.string().min(1).describe("Usually animation.<model>.<action>."),
  length: z.number().min(0),
  loop: z.enum(["once", "loop", "hold"]).default("once"),
  snapping: z.number().int().positive().default(24),
  uuid: z.string().uuid().optional(),
});

/** Deletes an animation clip and all of its keyframes. */
export const removeAnimationOp = z.object({ op: z.literal("remove_animation"), animation: nodeRef.describe("Animation UUID or name.") });

/** Adds or replaces a keyframe. */
export const setKeyframeOp = z.object({
  op: z.literal("set_keyframe"),
  animation: nodeRef.describe("Animation UUID or name."),
  bone: nodeRef.describe("Group UUID or name."),
  channel: z.enum(["rotation", "position", "scale"]),
  time: z.number().min(0),
  value: z.tuple([keyValue, keyValue, keyValue]).describe("Numbers or Molang strings. Rotation in degrees, 5.0 sign convention."),
  interpolation: z.enum(["linear", "step", "catmullrom", "bezier"]).default("linear"),
});

/** Removes a keyframe. */
export const removeKeyframeOp = z.object({
  op: z.literal("remove_keyframe"),
  animation: nodeRef,
  bone: nodeRef,
  channel: z.enum(["rotation", "position", "scale"]),
  time: z.number().min(0),
});

/** Changes model-level properties. */
export const setModelPropertiesOp = z.object({
  op: z.literal("set_model_properties"),
  name: z.string().optional(),
  model_identifier: z.string().optional(),
  resolution: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
});

/** Any edit operation. */
export const operationSchema = z.discriminatedUnion("op", [
  addGroupOp,
  addCubeOp,
  updateNodeOp,
  removeNodeOp,
  addTextureOp,
  addMaterialOp,
  updateMaterialOp,
  updateTextureOp,
  assignTextureOp,
  addAnimationOp,
  removeAnimationOp,
  setKeyframeOp,
  removeKeyframeOp,
  setModelPropertiesOp,
  addLocatorOp,
  setParticleKeyframeOp,
  removeParticleKeyframeOp,
  addMeshOp,
  addMeshPrimitiveOp,
  editMeshOp,
  mapMeshUvOp,
]);

/** One parsed edit operation. */
export type Operation = z.infer<typeof operationSchema>;

/** What one operation did. */
export interface IOperationResult {
  op: Operation["op"];
  uuid?: string;
  name?: string;
  detail?: string;
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/** Resolves a texture reference to its index in `textures[]`. */
export function resolveTexture(doc: IBBModel, ref: string | number): number {
  if (typeof ref === "number") {
    if (ref < doc.textures.length) return ref;
    throw new Error(`Texture index ${ref} is out of range (${doc.textures.length} textures).`);
  }
  const index = doc.textures.findIndex((texture) => texture.uuid === ref || texture.name === ref);
  if (index >= 0) return index;
  throw new Error(`No texture named or identified "${ref}".`);
}

export { freshUuid };

/** Resolves a face's texture: explicit null disables the face, an explicit reference wins, otherwise the cube-wide texture. */
function faceTexture(doc: IBBModel, input: string | number | null | undefined, fallback: number | undefined): number | null | undefined {
  if (input === null) return null;
  if (input === undefined) return fallback;
  return resolveTexture(doc, input);
}

/** Formats with `box_uv_float_size: true` (js/formats/java/modded_entity.ts); others floor box-UV sizes. */
const FLOAT_BOX_UV_FORMATS: ReadonlySet<string> = new Set(["modded_entity"]);

/**
 * Recomputes box-UV faces for a cube that uses box UV.
 *
 * @param meta - The document header: its `box_uv` is the default and its format decides float sizes.
 */
export function refreshBoxUv(cube: ICube, meta: IBBModel["meta"]): ICube {
  if (!(cube.box_uv ?? meta.box_uv)) return cube;
  const size = boxUvSize(cube.from, cube.to, FLOAT_BOX_UV_FORMATS.has(meta.model_format));
  const layout = computeBoxUv(size, cube.uv_offset ?? [0, 0], cube.mirror_uv === true);
  const faces = Object.fromEntries(
    CUBE_FACES.map((face) => {
      const existing: ICubeFace | undefined = cube.faces[face];
      if (existing?.texture === null) return [face, existing];
      return [face, { ...existing, uv: layout[face] }];
    }),
  );
  return { ...cube, faces };
}

function applyAddGroup(doc: IBBModel, op: z.infer<typeof addGroupOp>): [IBBModel, IOperationResult] {
  const index = indexModel(doc);
  const parent = op.parent ? resolveNode(index, op.parent, ["group"]).uuid : null;
  const uuid = freshUuid(doc, op.uuid);
  const group: IGroup = { name: op.name, uuid, origin: op.origin, rotation: op.rotation, export: true, visibility: true, mirror_uv: false, reset: false, color: 0, autouv: 0, shade: true, locked: false };
  return [{ ...doc, groups: [...doc.groups, group], outliner: insertNode(doc.outliner, parent, groupRef(uuid)) }, { op: op.op, uuid, name: op.name }];
}

function buildFaces(doc: IBBModel, op: z.infer<typeof addCubeOp>, boxUv: boolean): Record<CubeFaceName, ICubeFace> {
  const allTexture = op.texture === undefined ? undefined : resolveTexture(doc, op.texture);
  const defaults = defaultFaceUv(op.from, op.to, doc.resolution);
  return Object.fromEntries(
    CUBE_FACES.map((face) => {
      const input = op.faces?.[face];
      const texture = faceTexture(doc, input?.texture, allTexture);
      const uv: UvRect = boxUv ? defaults[face] : input?.uv ?? defaults[face];
      const entry: ICubeFace = { uv, ...(texture === undefined ? {} : { texture }), ...(input?.rotation ? { rotation: input.rotation } : {}) };
      return [face, entry];
    }),
  ) as Record<CubeFaceName, ICubeFace>;
}

/** Applies per-face overrides to existing faces; omitted fields keep their saved values. */
function mergeFaces(doc: IBBModel, faces: ICube["faces"], overrides: Partial<Record<CubeFaceName, z.infer<typeof faceInputSchema>>>): ICube["faces"] {
  return Object.fromEntries(
    CUBE_FACES.flatMap((face) => {
      const existing = faces[face];
      const input = overrides[face];
      if (!input) return existing ? [[face, existing]] : [];
      const texture = faceTexture(doc, input.texture, undefined);
      const merged: ICubeFace = {
        ...(existing ?? { uv: [0, 0, 0, 0] }),
        ...(input.uv ? { uv: input.uv } : {}),
        ...(input.texture === undefined ? {} : { texture }),
        ...(input.rotation === undefined ? {} : { rotation: input.rotation }),
      };
      return [[face, merged]];
    }),
  );
}

function applyAddCube(doc: IBBModel, op: z.infer<typeof addCubeOp>): [IBBModel, IOperationResult] {
  const index = indexModel(doc);
  const parent = op.parent ? resolveNode(index, op.parent, ["group"]).uuid : null;
  const uuid = freshUuid(doc, op.uuid);
  const boxUv = op.box_uv ?? doc.meta.box_uv;
  const center = [0, 1, 2].map((axis) => round(((op.from[axis] ?? 0) + (op.to[axis] ?? 0)) / 2)) as unknown as ICube["origin"];
  const base: ICube = {
    name: op.name,
    box_uv: boxUv,
    rescale: false,
    locked: false,
    light_emission: 0,
    render_order: "default",
    allow_mirror_modeling: true,
    from: op.from,
    to: op.to,
    autouv: 0,
    color: 0,
    origin: op.origin ?? center,
    ...(op.rotation && op.rotation.some((value) => value !== 0) ? { rotation: op.rotation } : {}),
    ...(op.inflate ? { inflate: op.inflate } : {}),
    ...(op.uv_offset && op.uv_offset.some((value) => value !== 0) ? { uv_offset: op.uv_offset } : {}),
    ...(op.mirror_uv ? { mirror_uv: true } : {}),
    faces: buildFaces(doc, op, boxUv),
    type: "cube",
    uuid,
  };
  const cube = refreshBoxUv(base, doc.meta);
  return [{ ...doc, elements: [...doc.elements, cube], outliner: insertNode(doc.outliner, parent, uuid) }, { op: op.op, uuid, name: op.name }];
}

function applyUpdateNode(doc: IBBModel, op: z.infer<typeof updateNodeOp>): [IBBModel, IOperationResult] {
  const index = indexModel(doc);
  const target = resolveNode(index, op.target);
  const moved = (() => {
    if (op.parent === undefined) return doc.outliner;
    const newParent = op.parent === null ? null : resolveNode(index, op.parent, ["group"]).uuid;
    const { outliner, removed } = detachNode(doc.outliner, target.uuid);
    const node = removed ?? (target.kind === "group" ? groupRef(target.uuid) : target.uuid);
    if (newParent !== null && subtreeIds(node).includes(newParent)) throw new Error("Cannot move a group inside itself.");
    return insertNode(outliner, newParent, node);
  })();
  const shared = {
    ...(op.name === undefined ? {} : { name: op.name }),
    ...(op.origin === undefined ? {} : { origin: op.origin }),
    ...(op.rotation === undefined ? {} : { rotation: op.rotation }),
    ...(op.mirror_uv === undefined ? {} : { mirror_uv: op.mirror_uv }),
  };
  if (target.kind === "group") {
    const cubeOnly = [op.from, op.to, op.inflate, op.uv_offset, op.faces].some((value) => value !== undefined);
    if (cubeOnly) throw new Error("from, to, inflate and uv_offset apply to cubes, not groups.");
    const groups = doc.groups.map((group) => (group.uuid === target.uuid ? { ...group, ...shared } : group));
    return [{ ...doc, groups, outliner: moved }, { op: op.op, uuid: target.uuid, name: op.name ?? index.groups.get(target.uuid)?.name }];
  }
  const elements = doc.elements.map((element) => {
    if (element.uuid !== target.uuid) return element;
    if (!isCube(element)) {
      const cubeOnly = [op.from, op.to, op.inflate, op.uv_offset, op.faces].some((value) => value !== undefined);
      if (cubeOnly) throw new Error(`${element.name} is a ${element.type}; from, to, inflate and uv_offset apply to cubes.`);
      return { ...element, ...shared };
    }
    const updated: ICube = {
      ...element,
      ...shared,
      ...(op.from === undefined ? {} : { from: op.from }),
      ...(op.to === undefined ? {} : { to: op.to }),
      ...(op.inflate === undefined ? {} : { inflate: op.inflate }),
      ...(op.uv_offset === undefined ? {} : { uv_offset: op.uv_offset }),
      ...(op.faces === undefined ? {} : { faces: mergeFaces(doc, element.faces, op.faces) }),
    };
    return refreshBoxUv(updated, doc.meta);
  });
  return [{ ...doc, elements, outliner: moved }, { op: op.op, uuid: target.uuid, name: op.name ?? index.elements.get(target.uuid)?.name }];
}

function applyRemoveNode(doc: IBBModel, op: z.infer<typeof removeNodeOp>): [IBBModel, IOperationResult] {
  const index = indexModel(doc);
  const target = resolveNode(index, op.target);
  const { outliner, removed } = detachNode(doc.outliner, target.uuid);
  const doomed = new Set(removed ? subtreeIds(removed) : [target.uuid]);
  const animations = doc.animations?.map((animation) => ({
    ...animation,
    animators: Object.fromEntries(Object.entries(animation.animators).filter(([id]) => !doomed.has(id))),
  }));
  const next: IBBModel = {
    ...doc,
    outliner,
    groups: doc.groups.filter((group) => !doomed.has(group.uuid)),
    elements: doc.elements.filter((element) => !doomed.has(element.uuid)),
    ...(animations ? { animations } : {}),
  };
  return [next, { op: op.op, uuid: target.uuid, detail: `removed ${doomed.size} node(s)` }];
}

function applyAddTexture(doc: IBBModel, op: z.infer<typeof addTextureOp>): [IBBModel, IOperationResult] {
  const uuid = freshUuid(doc, op.uuid);
  const texture: ITexture = {
    path: "",
    name: op.name,
    folder: "",
    namespace: "",
    id: String(doc.textures.length),
    width: op.width,
    height: op.height,
    uv_width: doc.resolution.width,
    uv_height: doc.resolution.height,
    particle: false,
    use_as_default: false,
    layers_enabled: false,
    sync_to_project: "",
    render_mode: op.render_mode ?? "default",
    render_sides: "auto",
    frame_time: 1,
    frame_order_type: "loop",
    frame_order: "",
    frame_interpolate: false,
    visible: true,
    internal: true,
    saved: false,
    uuid,
    relative_path: "",
    source: op.source,
    ...(op.wrap_mode ? { wrap_mode: op.wrap_mode } : {}),
  };
  const withTexture: IBBModel = { ...doc, textures: [...doc.textures, texture] };
  if (op.material === undefined) {
    if (op.channel !== undefined) throw new Error("channel needs a material.");
    return [withTexture, { op: op.op, uuid, name: op.name, detail: `index ${doc.textures.length}` }];
  }
  const placed = placeInMaterial(withTexture, uuid, op.material, op.channel ?? "color");
  return [placed, { op: op.op, uuid, name: op.name, detail: `index ${doc.textures.length}, ${op.channel ?? "color"} of ${op.material}` }];
}

/** Resolves a material (a texture group with `is_material`) by UUID or name. */
export function resolveMaterial(doc: IBBModel, ref: string): ITextureGroup {
  const matches = (doc.texture_groups ?? []).filter((group) => group.uuid === ref || group.name === ref);
  const [only] = matches;
  if (matches.length === 1 && only) return only;
  if (matches.length > 1) throw new Error(`"${ref}" matches ${matches.length} materials; pass a UUID.`);
  throw new Error(`No material named or identified "${ref}". Create it with add_material first.`);
}

/**
 * Puts a texture into a material channel.
 *
 * @throws Error when the channel is already filled by another texture, or when normal and height would coexist
 *   (Bedrock texture sets allow only one of them).
 */
function placeInMaterial(doc: IBBModel, textureUuid: string, materialRef: string, channel: PbrChannel): IBBModel {
  const material = resolveMaterial(doc, materialRef);
  const siblings = doc.textures.filter((texture) => texture.group === material.uuid && texture.uuid !== textureUuid);
  const channelOf = (texture: ITexture): string => texture.pbr_channel ?? "color";
  const occupant = siblings.find((texture) => channelOf(texture) === channel);
  if (occupant) throw new Error(`Material ${material.name} already has a ${channel} texture (${occupant.name}); move it out with update_texture first.`);
  const exclusive = ({ normal: "height", height: "normal" } as Readonly<Record<string, string>>)[channel];
  const conflict = exclusive === undefined ? undefined : siblings.find((texture) => channelOf(texture) === exclusive);
  if (conflict) throw new Error(`Material ${material.name} already has a ${exclusive} texture (${conflict.name}); a material uses normal or height, not both.`);
  return {
    ...doc,
    textures: doc.textures.map((texture) => (texture.uuid === textureUuid ? { ...texture, group: material.uuid, pbr_channel: channel } : texture)),
  };
}

function applyAddMaterial(doc: IBBModel, op: z.infer<typeof addMaterialOp>): [IBBModel, IOperationResult] {
  const uuid = freshUuid(doc, op.uuid);
  const taken = (doc.texture_groups ?? []).some((group) => group.name === op.name);
  if (taken) throw new Error(`A material or texture group named ${op.name} already exists.`);
  const material: ITextureGroup = {
    uuid,
    name: op.name,
    is_material: true,
    material_config: {
      color_value: op.color_value ?? [255, 255, 255, 255],
      ...(op.mer_value ? { mer_value: op.mer_value } : {}),
      ...(op.subsurface_value === undefined ? {} : { subsurface_value: op.subsurface_value }),
      saved: false,
    },
  };
  return [{ ...doc, texture_groups: [...(doc.texture_groups ?? []), material] }, { op: op.op, uuid, name: op.name }];
}

function applyUpdateMaterial(doc: IBBModel, op: z.infer<typeof updateMaterialOp>): [IBBModel, IOperationResult] {
  const material = resolveMaterial(doc, op.target);
  const config = {
    ...material.material_config,
    ...(op.color_value ? { color_value: op.color_value } : {}),
    ...(op.mer_value ? { mer_value: op.mer_value } : {}),
    ...(op.subsurface_value === undefined ? {} : { subsurface_value: op.subsurface_value }),
    saved: false,
  };
  const updated: ITextureGroup = { ...material, ...(op.name === undefined ? {} : { name: op.name }), material_config: config };
  const groups = (doc.texture_groups ?? []).map((group) => (group.uuid === material.uuid ? updated : group));
  return [{ ...doc, texture_groups: groups }, { op: op.op, uuid: material.uuid, name: updated.name }];
}

function applyUpdateTexture(doc: IBBModel, op: z.infer<typeof updateTextureOp>): [IBBModel, IOperationResult] {
  const target = doc.textures[resolveTexture(doc, op.target)];
  if (!target) throw new Error(`Texture ${op.target} not found.`);
  if (op.source !== undefined && (op.width === undefined || op.height === undefined)) throw new Error("source needs width and height.");
  const image = op.source === undefined ? {} : { source: op.source, width: op.width, height: op.height };
  const renamed: IBBModel = {
    ...doc,
    textures: doc.textures.map((texture) =>
      texture.uuid === target.uuid
        ? { ...texture, ...image, ...(op.name === undefined ? {} : { name: op.name }), ...(op.wrap_mode === undefined ? {} : { wrap_mode: op.wrap_mode }), ...(op.render_mode === undefined ? {} : { render_mode: op.render_mode }) }
        : texture,
    ),
  };
  if (op.material === null) {
    const detached: IBBModel = {
      ...renamed,
      textures: renamed.textures.map((texture) => {
        if (texture.uuid !== target.uuid) return texture;
        const { group: _group, ...rest } = texture;
        return { ...rest, pbr_channel: "color" };
      }),
    };
    return [detached, { op: op.op, uuid: target.uuid, detail: "removed from its material" }];
  }
  const materialRef = op.material ?? target.group;
  if (materialRef === undefined) {
    if (op.channel !== undefined) throw new Error(`${target.name} is not in a material; pass material with channel.`);
    return [renamed, { op: op.op, uuid: target.uuid }];
  }
  const channel = op.channel ?? ((target.pbr_channel as PbrChannel | undefined) ?? "color");
  return [placeInMaterial(renamed, target.uuid, materialRef, channel), { op: op.op, uuid: target.uuid, detail: `${channel} of ${resolveMaterial(renamed, materialRef).name}` }];
}

function applyAssignTexture(doc: IBBModel, op: z.infer<typeof assignTextureOp>): [IBBModel, IOperationResult] {
  const index = indexModel(doc);
  const texture = op.texture === null ? null : resolveTexture(doc, op.texture);
  const faces = op.faces ?? [...CUBE_FACES];
  const targets = new Set(
    op.targets.flatMap((ref) => {
      const node = resolveNode(index, ref);
      if (node.kind === "element") return [node.uuid];
      return doc.elements.filter((element) => ancestorsOf(index, element.uuid).includes(node.uuid)).map((element) => element.uuid);
    }),
  );
  const elements = doc.elements.map((element) => {
    if (!targets.has(element.uuid)) return element;
    if (isMesh(element)) return assignMeshTexture(element, texture, op.mesh_faces);
    if (!isCube(element)) return element;
    const updated = Object.fromEntries(
      Object.entries(element.faces).map(([face, data]) => [face, faces.includes(face as CubeFaceName) ? { ...data, texture } : data]),
    );
    return { ...element, faces: updated };
  });
  return [{ ...doc, elements }, { op: op.op, detail: `${targets.size} element(s)` }];
}

function applyAddAnimation(doc: IBBModel, op: z.infer<typeof addAnimationOp>): [IBBModel, IOperationResult] {
  const uuid = freshUuid(doc, op.uuid);
  const animation: IAnimation = {
    uuid,
    name: op.name,
    loop: op.loop,
    override: false,
    length: op.length,
    snapping: op.snapping,
    selected: false,
    anim_time_update: "",
    blend_weight: "",
    start_delay: "",
    loop_delay: "",
    animators: {},
  };
  return [{ ...doc, animations: [...(doc.animations ?? []), animation] }, { op: op.op, uuid, name: op.name }];
}

function applyRemoveAnimation(doc: IBBModel, op: z.infer<typeof removeAnimationOp>): [IBBModel, IOperationResult] {
  const animation = findAnimation(doc, op.animation);
  return [{ ...doc, animations: (doc.animations ?? []).filter((entry) => entry.uuid !== animation.uuid) }, { op: op.op, uuid: animation.uuid, name: animation.name }];
}

function updateAnimator(doc: IBBModel, animationRef: string, boneRef: string, edit: (keys: IKeyframe[]) => IKeyframe[]): { doc: IBBModel; animation: IAnimation; bone: IGroup } {
  const animation = findAnimation(doc, animationRef);
  const index = indexModel(doc);
  const boneId = resolveNode(index, boneRef, ["group"]).uuid;
  const bone = index.groups.get(boneId);
  if (!bone) throw new Error(`Group ${boneRef} not found.`);
  const animator = animation.animators[boneId] ?? { name: bone.name, type: "bone", keyframes: [] };
  const updated: IAnimation = { ...animation, animators: { ...animation.animators, [boneId]: { ...animator, keyframes: edit(animator.keyframes) } } };
  const animations = (doc.animations ?? []).map((entry) => (entry.uuid === animation.uuid ? updated : entry));
  return { doc: { ...doc, animations }, animation: updated, bone };
}

const sameSlot = (key: IKeyframe, channel: string, time: number): boolean => key.channel === channel && Math.abs(key.time - time) < 1e-6;

function applySetKeyframe(doc: IBBModel, op: z.infer<typeof setKeyframeOp>): [IBBModel, IOperationResult] {
  const [x, y, z] = op.value;
  const keyframe: IKeyframe = {
    channel: op.channel,
    data_points: [{ x: String(x), y: String(y), z: String(z) }],
    uuid: crypto.randomUUID(),
    time: op.time,
    color: -1,
    interpolation: op.interpolation,
  };
  const result = updateAnimator(doc, op.animation, op.bone, (keys) => [...keys.filter((key) => !sameSlot(key, op.channel, op.time)), keyframe].toSorted((a, b) => a.time - b.time));
  const extended = op.time > result.animation.length ? ` (past the clip length ${result.animation.length}s)` : "";
  return [result.doc, { op: op.op, uuid: keyframe.uuid, name: result.bone.name, detail: `${op.channel} at ${op.time}s${extended}` }];
}

function applyRemoveKeyframe(doc: IBBModel, op: z.infer<typeof removeKeyframeOp>): [IBBModel, IOperationResult] {
  const boneId = resolveNode(indexModel(doc), op.bone, ["group"]).uuid;
  const existing = findAnimation(doc, op.animation).animators[boneId]?.keyframes ?? [];
  const removed = existing.filter((key) => sameSlot(key, op.channel, op.time)).length;
  if (removed === 0) throw new Error(`No ${op.channel} keyframe at ${op.time}s on ${op.bone}.`);
  const result = updateAnimator(doc, op.animation, op.bone, (keys) => keys.filter((key) => !sameSlot(key, op.channel, op.time)));
  return [result.doc, { op: op.op, name: result.bone.name, detail: `removed ${removed}` }];
}

function applySetModelProperties(doc: IBBModel, op: z.infer<typeof setModelPropertiesOp>): [IBBModel, IOperationResult] {
  return [
    {
      ...doc,
      ...(op.name === undefined ? {} : { name: op.name }),
      ...(op.model_identifier === undefined ? {} : { model_identifier: op.model_identifier }),
      ...(op.resolution === undefined ? {} : { resolution: { ...doc.resolution, ...op.resolution } }),
    },
    { op: op.op },
  ];
}

type Handler<K extends Operation["op"]> = (doc: IBBModel, op: Extract<Operation, { op: K }>) => [IBBModel, IOperationResult];

const HANDLERS: { [K in Operation["op"]]: Handler<K> } = {
  add_group: applyAddGroup,
  add_cube: applyAddCube,
  update_node: applyUpdateNode,
  remove_node: applyRemoveNode,
  add_texture: applyAddTexture,
  add_material: applyAddMaterial,
  update_material: applyUpdateMaterial,
  update_texture: applyUpdateTexture,
  assign_texture: applyAssignTexture,
  add_animation: applyAddAnimation,
  remove_animation: applyRemoveAnimation,
  set_keyframe: applySetKeyframe,
  remove_keyframe: applyRemoveKeyframe,
  set_model_properties: applySetModelProperties,
  add_locator: applyAddLocator,
  set_particle_keyframe: applySetParticleKeyframe,
  remove_particle_keyframe: applyRemoveParticleKeyframe,
  ...MESH_HANDLERS,
};

/**
 * Applies operations in order. If any operation throws, the whole batch fails
 * and the caller writes nothing.
 *
 * @throws Error naming the failing operation's position and reason.
 */
export function applyOperations(doc: IBBModel, operations: readonly Operation[]): { doc: IBBModel; results: IOperationResult[] } {
  return operations.reduce<{ doc: IBBModel; results: IOperationResult[] }>(
    (state, operation, position) => {
      try {
        const handler = HANDLERS[operation.op] as Handler<typeof operation.op>;
        const [next, result] = handler(state.doc, operation);
        return { doc: next, results: [...state.results, result] };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Operation ${position + 1} (${operation.op}) failed: ${reason}`);
      }
    },
    { doc, results: [] },
  );
}

/**
 * Records AI involvement the way the desktop plugin does: `ai_used: true` and the
 * client name appended to the comma-separated `ai_agents` list.
 */
export function stampAiUsage(doc: IBBModel, agent: string): IBBModel {
  const name = agent.slice(0, MAX_AGENT_NAME_LENGTH);
  const existing = typeof doc.ai_agents === "string" && doc.ai_agents ? doc.ai_agents.split(", ") : [];
  const agents = existing.includes(name) ? existing : [...existing, name];
  return { ...doc, ai_used: true, ai_agents: agents.join(", ") };
}

