/**
 * Shared type shapes for Blockbench host doubles used across unit tests.
 *
 * Only shapes that are genuinely identical between test files live here. Fake
 * host classes (meshes, textures, texture groups) intentionally stay local to
 * their tests because their behavior diverges on purpose — for example,
 * `server/tools/mesh.test.ts` generates descending numeric vertex keys to expose
 * index-mapping bugs, while `tests/action-wrappers.test.ts` needs ascending keys,
 * UV extension, and three.js normals.
 *
 * @module
 */

/** XYZ tuple used for Blockbench vertex positions, origins, and rotations (degrees). */
export type Vector3Tuple = [number, number, number];

/** UV coordinate pair, in texture pixels, stored per vertex key on a mesh face. */
export type UvTuple = [number, number];

/** Uniform RGBA color in `TextureGroup.material_config.color_value` (0–255 per channel). */
export type RgbaTuple = [number, number, number, number];

/** Uniform metalness, emissive, roughness triple in `material_config.mer_value` (0–255). */
export type MerTuple = [number, number, number];

/** PBR channel a texture occupies inside a material texture group. */
export type PbrChannel = "color" | "normal" | "height" | "mer";

/**
 * Component selection for one mesh, as stored in `Project.mesh_selection[mesh.uuid]`.
 *
 * Edges are vertex-key pairs; tests may deliberately store malformed pairs
 * (duplicates, missing keys) to exercise validation, so no tuple length is enforced.
 */
export interface IMeshSelection {
  vertices: string[];
  edges: string[][];
  faces: string[];
}

/** `Project.mesh_selection`: component selections keyed by mesh UUID. */
export type MeshSelectionMap = Record<string, IMeshSelection>;

/** Minimal texture entry for `Project.textures` when a test only resolves textures by UUID or name. */
export interface ITextureReference {
  uuid: string;
  name: string;
}

/** Uniform material values shared by texture-group doubles; extend locally for extra config fields. */
export interface IMaterialUniforms {
  color_value: RgbaTuple;
  mer_value: MerTuple;
}

/**
 * Parsing surface shared by Zod schemas from any Zod instance.
 *
 * Bundled tool fixtures carry their own copy of Zod, so `instanceof z.ZodType`
 * cannot be used to recognize their schemas; helpers depend on this structural
 * interface instead.
 */
export interface ISchemaParser {
  parse(input: unknown): unknown;
  parseAsync(input: unknown): Promise<unknown>;
}
