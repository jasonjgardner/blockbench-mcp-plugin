/// <reference types="blockbench-types" />
/**
 * Blockbench and file-system access for the particle tools.
 *
 * Blockbench keeps loaded effects in `Animator.particle_effects`, keyed by the
 * effect file's absolute path, each with a Wintersky config that the preview
 * renders. The published types declare that map as `any`, so this module is the
 * one place that narrows it. Effects are always backed by a file, because
 * Blockbench watches that file and keyframes store its path.
 *
 * @module
 */

import { pngSize } from "@/lib/png";
import { shortNameOf } from "@/lib/particles/build";
import { type ParticleEffectFile, particleEffectFileSchema } from "@/lib/particles/design";
import { packRootOfParticleFile, particleTexturePath } from "@/lib/particles/pack";
import { isSafeTexturePath } from "@/lib/particles/validate";
import { findTextureOrThrow } from "@/lib/util";

/** The parts of Node's `fs` the particle tools use. */
export interface IParticleFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  readFileSync(path: string): Uint8Array;
  writeFileSync(path: string, data: string | Uint8Array): void;
  mkdirSync(path: string, options: { recursive: true }): unknown;
}

/** The parts of Node's `path` the particle tools use. */
export interface IParticlePath {
  sep: string;
  isAbsolute(path: string): boolean;
  join(...segments: string[]): string;
  dirname(path: string): string;
  basename(path: string, extension?: string): string;
  normalize(path: string): string;
}

/** Wintersky's parsed view of an effect file. */
interface IWinterskyConfig {
  identifier?: string;
  file_path?: string;
  particle_texture_path?: string;
  /** `built_in`, `loaded` or `placeholder` (the missing-texture checkerboard). */
  texture_source_category?: string;
  preview_texture?: string;
  /** `looping`, `once` or `expression`, from the effect's emitter lifetime component. */
  emitter_lifetime_mode?: string;
  updateTexture(): void;
}

/** One entry of `Animator.particle_effects`. */
export interface ILoadedParticleEffect {
  config: IWinterskyConfig;
  emitters: Record<string, unknown>;
}

/** The particle members of Blockbench's `Animator`. */
interface IParticleAnimator {
  particle_effects: Record<string, ILoadedParticleEffect>;
  loadParticleEmitter(path: string, content: string): ILoadedParticleEffect | undefined;
  preview(inLoop?: boolean): void;
}

/** A loaded effect and the file it came from. */
export interface IEffectEntry {
  readonly path: string;
  readonly effect: ILoadedParticleEffect;
}

/** Blockbench's `Animator`, narrowed to its particle members. */
export function particleAnimator(): IParticleAnimator {
  return Animator as unknown as IParticleAnimator;
}

/** Scoped file access; Blockbench asks the user once. */
export function particleFs(reason: string): IParticleFs {
  // @ts-ignore - requireNativeModule is a Blockbench global
  const fs = requireNativeModule("fs", { message: reason }) as IParticleFs | undefined;
  if (!fs) throw new Error("File system access was denied, so particle files cannot be read or written. Allow file access for the MCP plugin and try again.");
  return fs;
}

/** Node's `path` module. */
export function particlePath(): IParticlePath {
  // @ts-ignore - requireNativeModule is a Blockbench global
  return requireNativeModule("path") as IParticlePath;
}

/** Every loaded effect, in load order. */
export function loadedEffects(): IEffectEntry[] {
  return Object.entries(particleAnimator().particle_effects ?? {}).map(([path, effect]) => ({ path, effect }));
}

/** Whether `reference` names this effect exactly, by path or full identifier. */
function matchesExactly(entry: IEffectEntry, reference: string, path: IParticlePath): boolean {
  const byPath = path.isAbsolute(reference) && path.normalize(reference) === path.normalize(entry.path);
  return byPath || entry.effect.config.identifier === reference;
}

/**
 * Finds a loaded effect by path or identifier, or else by short name.
 *
 * @throws Error when a short name matches several effects (`a:smoke` and `b:smoke`), so the wrong one is never edited.
 */
export function findLoadedEffect(reference: string): IEffectEntry | undefined {
  const path = particlePath();
  const entries = loadedEffects();
  const exact = entries.find((entry) => matchesExactly(entry, reference, path));
  if (exact) return exact;
  const byShortName = entries.filter((entry) => entry.effect.config.identifier && shortNameOf(entry.effect.config.identifier) === reference);
  if (byShortName.length > 1) {
    throw new Error(`"${reference}" matches ${byShortName.map((entry) => entry.effect.config.identifier).join(" and ")}; pass the full identifier or file path.`);
  }
  return byShortName[0];
}

/** Whether `target` is `root` or inside it. */
export function isInsideFolder(root: string, target: string): boolean {
  const path = particlePath();
  const normalizedRoot = path.normalize(root).replace(/[\\/]+$/, "").toLowerCase();
  const normalizedTarget = path.normalize(target).toLowerCase();
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`.toLowerCase());
}

/**
 * Reads and schema-checks an effect file.
 *
 * @throws When the file is missing, is not JSON, or is not a particle effect.
 */
export function readEffectFile(fs: IParticleFs, filePath: string): ParticleEffectFile {
  if (!fs.existsSync(filePath)) throw new Error(`Particle file not found: ${filePath}`);
  const [parseError, json] = parseJson(fs.readFileSync(filePath, "utf8"));
  if (parseError) throw new Error(`${filePath} is not valid JSON: ${parseError}`);
  const parsed = particleEffectFileSchema.safeParse(json);
  if (!parsed.success) throw new Error(`${filePath} is not a Bedrock particle effect: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return parsed.data;
}

/** JSON.parse as an error tuple. */
function parseJson(text: string): [string, undefined] | [undefined, unknown] {
  try {
    return [undefined, JSON.parse(text)];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error), undefined];
  }
}

/**
 * Resolves an effect reference to its file: a loaded effect's path, or an
 * absolute path to an existing file (which is then loaded).
 *
 * @throws When nothing matches.
 */
export function resolveEffect(fs: IParticleFs, reference: string): IEffectEntry {
  const loaded = findLoadedEffect(reference);
  if (loaded) return loaded;
  const path = particlePath();
  if (!path.isAbsolute(reference) || !fs.existsSync(reference)) {
    const known = loadedEffects().map((entry) => entry.effect.config.identifier ?? entry.path);
    throw new Error(`No loaded particle effect matches "${reference}". Loaded: ${known.length ? known.join(", ") : "none"}. Pass an absolute path to load a file, or create one with create_particle_effect.`);
  }
  const file = readEffectFile(fs, reference);
  return { path: reference, effect: loadEffect(reference, file) };
}

/** Serializes an effect the way Snowstorm and Blockbench do. */
export function serializeEffect(file: ParticleEffectFile): string {
  return `${JSON.stringify(file, null, "\t")}\n`;
}

/**
 * Loads (or reloads) an effect into Blockbench's preview and re-resolves its
 * texture, which Wintersky caches after the first lookup.
 */
export function loadEffect(filePath: string, file: ParticleEffectFile): ILoadedParticleEffect {
  const loaded = particleAnimator().loadParticleEmitter(filePath, serializeEffect(file));
  if (!loaded) throw new Error(`Blockbench could not load ${filePath} as a particle effect.`);
  delete loaded.config.preview_texture;
  loaded.config.updateTexture();
  return loaded;
}

/** Writes an effect file, creating folders, and loads it into the preview. */
export function writeEffect(fs: IParticleFs, filePath: string, file: ParticleEffectFile): ILoadedParticleEffect {
  fs.mkdirSync(particlePath().dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, serializeEffect(file));
  return loadEffect(filePath, file);
}

/** Bedrock-entity project state set when a model is opened from a resource pack. */
interface IBedrockEntityManager {
  root_path?: string;
}

/**
 * Picks the resource-pack-style folder effects are written to.
 *
 * @throws When no folder is given and the project has never been saved.
 */
export function resolvePackRoot(explicit: string | undefined): string {
  const path = particlePath();
  if (explicit !== undefined) {
    if (!path.isAbsolute(explicit)) throw new Error("pack_root must be an absolute path.");
    return explicit;
  }
  const project = Project as unknown as { BedrockEntityManager?: IBedrockEntityManager; save_path?: string; export_path?: string } | null;
  const entityRoot = project?.BedrockEntityManager?.root_path;
  if (entityRoot) return entityRoot;
  const saved = project?.save_path || project?.export_path;
  if (saved) return path.dirname(saved);
  throw new Error("The project has not been saved, so there is no folder for particle files. Pass pack_root (an absolute folder), or save the project first.");
}

/** The pack root an effect file lives in: the folder above its `particles` folder. */
export function packRootOf(filePath: string): string | undefined {
  return packRootOfParticleFile(particlePath().normalize(filePath));
}

/** Where a custom texture is expected on disk, following Blockbench's own lookup; undefined for paths that leave the pack. */
export function textureFileFor(effectPath: string, texture: string): string | undefined {
  const root = packRootOf(effectPath);
  if (!root || !isSafeTexturePath(texture)) return undefined;
  return particlePath().join(root, ...`${texture}.png`.split("/"));
}

/** A PNG chosen for a custom particle texture. */
export interface ITextureImageInput {
  texture?: string;
  path?: string;
  name?: string;
}

/** A texture written into the pack. */
export interface IWrittenTexture {
  readonly texture: string;
  readonly file: string;
  readonly size: [number, number];
}

/** PNG bytes from a Blockbench texture or a file. */
function textureBytes(fs: IParticleFs, image: ITextureImageInput): Uint8Array {
  if (image.path !== undefined) {
    if (!fs.existsSync(image.path)) throw new Error(`Texture image not found: ${image.path}`);
    return fs.readFileSync(image.path);
  }
  const texture = findTextureOrThrow(image.texture ?? "");
  const base64 = texture.getDataURL().replace(/^data:image\/png;base64,/, "");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

/** Whether two byte arrays hold the same bytes. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Saves a custom texture to `<packRoot>/textures/particle/<name>.png`.
 *
 * @throws When the target exists with different bytes and `overwrite` is false, or the image is not a PNG.
 */
export function writeTextureImage(fs: IParticleFs, packRoot: string, image: ITextureImageInput, fallbackName: string, overwrite: boolean): IWrittenTexture {
  const bytes = textureBytes(fs, image);
  const { width, height } = pngSize(bytes);
  const texture = particleTexturePath(image.name ?? fallbackName);
  const file = particlePath().join(packRoot, ...`${texture}.png`.split("/"));
  const same = fs.existsSync(file) && bytesEqual(fs.readFileSync(file), bytes);
  if (fs.existsSync(file) && !same && !overwrite) throw new Error(`${file} already exists. Pass overwrite: true to replace it, or choose another texture_image.name.`);
  fs.mkdirSync(particlePath().dirname(file), { recursive: true });
  if (!same) fs.writeFileSync(file, bytes);
  return { texture, file, size: [width, height] };
}

/** Texture state Wintersky reports, in words an agent can act on. */
export function textureStatus(effect: ILoadedParticleEffect): string {
  const category = effect.config.texture_source_category;
  if (category === "built_in") return "built-in texture";
  if (category === "loaded") return "custom texture found";
  return "texture not found; the preview shows a checkerboard. Put the PNG at <pack>/<texture>.png or pass texture_image.";
}
