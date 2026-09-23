/**
 * Zod schema for Blockbench `.bbmodel` documents (format 5.0).
 *
 * The headless server edits `.bbmodel` files without Blockbench, so it needs its
 * own data model. Every object uses `.passthrough()`: fields this schema does not
 * name (plugin properties, editor state, future Blockbench fields) survive a
 * read-modify-write round trip untouched. Only the fields the headless tools
 * read or write are typed.
 *
 * Shapes follow what Blockbench 5.x writes in `js/formats/bbmodel.js` (`compile`),
 * `Cube.getSaveCopy`, `Face.getSaveCopy`, `Group.getChildlessCopy` and
 * `Outliner.toJSON`. Legacy 4.x files are converted before parsing by
 * `upgradeToV5` in `./legacy`.
 *
 * @module
 */

import { z } from "zod";

/** `[x, y, z]` in model units (1 unit = 1 pixel = 1/16 block). */
export const vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

/** `[u, v]` in texture pixels. */
export const vec2Schema = z.tuple([z.number(), z.number()]);

/** `[u1, v1, u2, v2]` face UV rectangle. */
export const uvRectSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

/** A 3D vector. */
export type Vec3 = z.infer<typeof vec3Schema>;

/** A 2D vector. */
export type Vec2 = z.infer<typeof vec2Schema>;

/** A face UV rectangle `[u1, v1, u2, v2]`. */
export type UvRect = z.infer<typeof uvRectSchema>;

/** Cube face keys in Blockbench's canonical order. */
export const CUBE_FACES = ["north", "east", "south", "west", "up", "down"] as const;

/** One cube face key. */
export type CubeFaceName = (typeof CUBE_FACES)[number];

/** Zod enum of cube face keys. */
export const cubeFaceNameSchema = z.enum(CUBE_FACES);

/**
 * Face texture reference as saved: a texture index into `textures[]`, a texture
 * UUID (partial exports), `null` for a disabled face, or absent for "no texture".
 */
export const faceTextureSchema = z.union([z.number().int(), z.string(), z.null()]);

/** One cube face. */
export const cubeFaceSchema = z
  .object({
    uv: uvRectSchema,
    texture: faceTextureSchema.optional(),
    rotation: z.number().optional(),
  })
  .passthrough();

/** A saved cube face. */
export type ICubeFace = z.infer<typeof cubeFaceSchema>;

const elementBase = {
  uuid: z.string().min(1),
  name: z.string(),
  origin: vec3Schema.default([0, 0, 0]),
  rotation: vec3Schema.optional(),
  export: z.boolean().optional(),
  visibility: z.boolean().optional(),
  color: z.number().int().optional(),
};

/** A cube element. `from`/`to` are absolute bind-pose coordinates. */
export const cubeSchema = z
  .object({
    ...elementBase,
    type: z.literal("cube"),
    from: vec3Schema,
    to: vec3Schema,
    inflate: z.number().optional(),
    box_uv: z.boolean().optional(),
    uv_offset: vec2Schema.optional(),
    mirror_uv: z.boolean().optional(),
    faces: z.record(z.string(), cubeFaceSchema).default({}),
  })
  .passthrough();

/** A saved cube. */
export type ICube = z.infer<typeof cubeSchema>;

/** One mesh face: vertex keys plus per-vertex UVs. */
export const meshFaceSchema = z
  .object({
    vertices: z.array(z.string()),
    uv: z.record(z.string(), vec2Schema).default({}),
    texture: faceTextureSchema.optional(),
  })
  .passthrough();

/** A mesh element. Vertex positions are relative to `origin`, before `rotation`. */
export const meshSchema = z
  .object({
    ...elementBase,
    type: z.literal("mesh"),
    vertices: z.record(z.string(), vec3Schema),
    faces: z.record(z.string(), meshFaceSchema).default({}),
  })
  .passthrough();

/** A saved mesh. */
export type IMesh = z.infer<typeof meshSchema>;

/** Any other element type (locator, null_object, texture_mesh, armature, plugin types). Kept opaque. */
export const otherElementSchema = z
  .object({
    uuid: z.string().min(1),
    name: z.string().default(""),
    type: z.string().refine((type) => type !== "cube" && type !== "mesh"),
  })
  .passthrough();

/** An element the headless tools do not model geometrically. */
export type IOtherElement = z.infer<typeof otherElementSchema>;

/** Any saved element. */
export type IElement = ICube | IMesh | IOtherElement;

/**
 * Any outliner element. Old files may omit `type`; Blockbench treats those as cubes.
 */
export const elementSchema: z.ZodType<IElement, z.ZodTypeDef, unknown> = z.preprocess(
  (value) => {
    const isUntypedObject = typeof value === "object" && value !== null && !("type" in value);
    return isUntypedObject ? { ...value, type: "cube" } : value;
  },
  z.union([cubeSchema, meshSchema, otherElementSchema]),
);

/** A group (bone) definition from the top-level `groups[]` array. */
export const groupSchema = z
  .object({
    uuid: z.string().min(1),
    name: z.string(),
    origin: vec3Schema.default([0, 0, 0]),
    rotation: vec3Schema.default([0, 0, 0]),
    export: z.boolean().optional(),
    visibility: z.boolean().optional(),
    mirror_uv: z.boolean().optional(),
    reset: z.boolean().optional(),
  })
  .passthrough();

/** A saved group definition. */
export type IGroup = z.infer<typeof groupSchema>;

/** A 5.0 outliner group reference: `{ uuid, isOpen, children }`. */
export interface IOutlinerGroupRef {
  uuid: string;
  isOpen?: boolean;
  children: OutlinerNode[];
  [key: string]: unknown;
}

/** An outliner entry: an element UUID or a group reference. */
export type OutlinerNode = string | IOutlinerGroupRef;

/** Outliner tree schema (5.0 shape: groups referenced by UUID). */
export const outlinerNodeSchema: z.ZodType<OutlinerNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z
      .object({
        uuid: z.string().min(1),
        isOpen: z.boolean().optional(),
        children: z.array(outlinerNodeSchema).default([]),
      })
      .passthrough(),
  ]),
);

/** A texture entry. `source` holds a data URL when the texture is embedded. */
export const textureSchema = z
  .object({
    uuid: z.string().min(1),
    name: z.string(),
    source: z.string().optional(),
    path: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    uv_width: z.number().optional(),
    uv_height: z.number().optional(),
  })
  .passthrough();

/** A saved texture. */
export type ITexture = z.infer<typeof textureSchema>;

const molangValue = z.union([z.string(), z.number()]);

/**
 * One keyframe data point. Transform channels hold x/y/z as numbers or Molang
 * strings; effect channels carry other fields (such as the boolean
 * `bind_to_actor` on particle keys), which pass through untouched.
 */
export const dataPointSchema = z.object({ x: molangValue.optional(), y: molangValue.optional(), z: molangValue.optional() }).passthrough();

/** A keyframe data point. */
export type DataPoint = z.infer<typeof dataPointSchema>;

/** A keyframe. */
export const keyframeSchema = z
  .object({
    uuid: z.string().min(1),
    channel: z.string(),
    time: z.number(),
    data_points: z.array(dataPointSchema).default([]),
    interpolation: z.string().default("linear"),
    bezier_left_value: vec3Schema.optional(),
    bezier_right_value: vec3Schema.optional(),
  })
  .passthrough();

/** A saved keyframe. */
export type IKeyframe = z.infer<typeof keyframeSchema>;

/** An animator: the keyframes for one bone (keyed by the bone's UUID in `animators`). */
export const animatorSchema = z
  .object({
    name: z.string().default(""),
    type: z.string().default("bone"),
    keyframes: z.array(keyframeSchema).default([]),
  })
  .passthrough();

/** A saved animator. */
export type IAnimator = z.infer<typeof animatorSchema>;

/** An animation clip. */
export const animationSchema = z
  .object({
    uuid: z.string().min(1),
    name: z.string(),
    loop: z.string().default("once"),
    length: z.number().default(0),
    snapping: z.number().optional(),
    animators: z.record(z.string(), animatorSchema).default({}),
  })
  .passthrough();

/** A saved animation. */
export type IAnimation = z.infer<typeof animationSchema>;

/** File header. */
export const metaSchema = z
  .object({
    format_version: z.string(),
    model_format: z.string().default("free"),
    box_uv: z.boolean().default(false),
  })
  .passthrough();

/** A whole `.bbmodel` document in 5.0 shape. */
export const bbmodelSchema = z
  .object({
    meta: metaSchema,
    name: z.string().default(""),
    model_identifier: z.string().optional(),
    visible_box: vec3Schema.optional(),
    resolution: z.object({ width: z.number(), height: z.number() }).passthrough().default({ width: 16, height: 16 }),
    elements: z.array(elementSchema).default([]),
    groups: z.array(groupSchema).default([]),
    outliner: z.array(outlinerNodeSchema).default([]),
    textures: z.array(textureSchema).default([]),
    animations: z.array(animationSchema).optional(),
  })
  .passthrough();

/** A parsed `.bbmodel` document. */
export type IBBModel = z.infer<typeof bbmodelSchema>;

/** Narrows an element to a cube. */
export function isCube(element: IElement): element is ICube {
  return element.type === "cube";
}

/** Narrows an element to a mesh. */
export function isMesh(element: IElement): element is IMesh {
  return element.type === "mesh";
}

/** Narrows an outliner node to a group reference. */
export function isGroupRef(node: OutlinerNode): node is IOutlinerGroupRef {
  return typeof node !== "string";
}
