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
  type IGroup,
  type IKeyframe,
  isCube,
  type ITexture,
  type UvRect,
  uvRectSchema,
  vec2Schema,
  vec3Schema,
} from "../document/schema";
import { ancestorsOf, detachNode, groupRef, indexModel, insertNode, resolveNode, subtreeIds } from "../document/tree";
import { boxUvSize, computeBoxUv, defaultFaceUv } from "../geometry/box-uv";

const nodeRef = z.string().min(1).describe("UUID or exact name.");
const parentRef = z.string().min(1).nullable().optional().describe("Parent group UUID or name; null or omitted places the node at the root.");
const textureRef = z.union([z.string().min(1), z.number().int().min(0)]).describe("Texture UUID, name, or index in textures[].");
const keyValue = z.union([z.number(), z.string()]);

/** Face overrides for a cube. */
export const faceInputSchema = z.object({
  uv: uvRectSchema.optional().describe("[u1, v1, u2, v2] in texture pixels. Ignored for box-UV cubes."),
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
  uuid: z.string().uuid().optional(),
});

/** Assigns a texture to cube faces. */
export const assignTextureOp = z.object({
  op: z.literal("assign_texture"),
  targets: z.array(nodeRef).min(1).describe("Cubes, or groups (every cube inside is assigned)."),
  texture: textureRef.nullable().describe("null disables the faces."),
  faces: z.array(cubeFaceNameSchema).optional().describe("Defaults to all six faces."),
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
  assignTextureOp,
  addAnimationOp,
  setKeyframeOp,
  removeKeyframeOp,
  setModelPropertiesOp,
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

/**
 * Returns `requested` when no group, element, texture or animation uses it yet,
 * or a new random UUID when none was requested.
 *
 * @throws Error when `requested` is already taken; Blockbench misloads duplicate UUIDs.
 */
export function freshUuid(doc: IBBModel, requested: string | undefined): string {
  if (requested === undefined) return crypto.randomUUID();
  const taken = [doc.groups, doc.elements, doc.textures, doc.animations ?? []].some((list) => list.some((entry) => entry.uuid === requested));
  if (taken) throw new Error(`UUID ${requested} is already used in this model.`);
  return requested;
}

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
    const cubeOnly = [op.from, op.to, op.inflate, op.uv_offset].some((value) => value !== undefined);
    if (cubeOnly) throw new Error("from, to, inflate and uv_offset apply to cubes, not groups.");
    const groups = doc.groups.map((group) => (group.uuid === target.uuid ? { ...group, ...shared } : group));
    return [{ ...doc, groups, outliner: moved }, { op: op.op, uuid: target.uuid, name: op.name ?? index.groups.get(target.uuid)?.name }];
  }
  const elements = doc.elements.map((element) => {
    if (element.uuid !== target.uuid) return element;
    if (!isCube(element)) {
      const cubeOnly = [op.from, op.to, op.inflate, op.uv_offset].some((value) => value !== undefined);
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
    render_mode: "default",
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
  };
  return [{ ...doc, textures: [...doc.textures, texture] }, { op: op.op, uuid, name: op.name, detail: `index ${doc.textures.length}` }];
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
    if (!targets.has(element.uuid) || !isCube(element)) return element;
    const updated = Object.fromEntries(
      Object.entries(element.faces).map(([face, data]) => [face, faces.includes(face as CubeFaceName) ? { ...data, texture } : data]),
    );
    return { ...element, faces: updated };
  });
  return [{ ...doc, elements }, { op: op.op, detail: `${targets.size} element(s)` }];
}

function findAnimation(doc: IBBModel, ref: string): IAnimation {
  const matches = (doc.animations ?? []).filter((animation) => animation.uuid === ref || animation.name === ref);
  const [only] = matches;
  if (matches.length === 1 && only) return only;
  if (matches.length > 1) throw new Error(`"${ref}" matches ${matches.length} animations; pass a UUID.`);
  throw new Error(`No animation named or identified "${ref}".`);
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
  assign_texture: applyAssignTexture,
  add_animation: applyAddAnimation,
  set_keyframe: applySetKeyframe,
  remove_keyframe: applyRemoveKeyframe,
  set_model_properties: applySetModelProperties,
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

