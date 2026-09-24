/**
 * Plans where particle effects and their textures go in a Bedrock resource
 * pack, and builds the client-entity mapping that lets animations find them.
 *
 * The layout is the one Blockbench itself resolves: an effect in
 * `<pack>/particles/` finds a texture `textures/particle/x` at
 * `<pack>/textures/particle/x.png`. Authoring into this layout makes the
 * Blockbench preview, the headless files and the shipped pack identical.
 * Pure functions: callers do the file writes.
 *
 * @module
 */

import { shortNameOf } from "./build";
import { BUILT_IN_TEXTURE_PATHS } from "./catalog";
import type { ParticleEffectFile } from "./design";
import { isSafeTexturePath } from "./validate";

/** Folder, relative to a pack root, that holds particle effect files. */
export const PARTICLES_FOLDER = "particles";

/** Folder, relative to a pack root, for custom particle textures. */
export const PARTICLE_TEXTURES_FOLDER = "textures/particle";

/**
 * The pack root an effect file belongs to: everything before the first
 * `particles` folder, which is how Blockbench's preview resolves textures.
 *
 * @returns The root, or undefined when the path has no `particles` folder.
 */
export function packRootOfParticleFile(filePath: string): string | undefined {
  const separator = filePath.includes("\\") ? "\\" : "/";
  const segments = filePath.split(/[\\/]/);
  const index = segments.indexOf(PARTICLES_FOLDER);
  if (index <= 0) return undefined;
  return segments.slice(0, index).join(separator);
}

/** Pack-relative JSON path for an effect, e.g. `particles/chimney_smoke.json`. */
export function particleFileRelativePath(identifier: string): string {
  return `${PARTICLES_FOLDER}/${shortNameOf(identifier)}.json`;
}

/** Bedrock texture path (no extension) for a custom texture file name. */
export function particleTexturePath(name: string): string {
  const base = name.replace(/\.png$/i, "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "particle";
  return `${PARTICLE_TEXTURES_FOLDER}/${base}`;
}

/** One effect to deliver. */
export interface IPackEffect {
  readonly file: ParticleEffectFile;
  /** Effect names used by keyframes for this identifier; defaults to its short name. */
  readonly short_names?: readonly string[];
  /** Where the texture PNG was found, for custom textures. */
  readonly texture_source?: string;
}

/** A particle JSON to write. */
export interface IPackParticleFile {
  readonly identifier: string;
  readonly relative_path: string;
  readonly content: string;
}

/** A texture PNG to copy. */
export interface IPackTextureFile {
  readonly texture: string;
  readonly relative_path: string;
  readonly source_path: string;
}

/** Everything needed to deliver a set of effects. */
export interface IParticlePackPlan {
  readonly particles: readonly IPackParticleFile[];
  readonly textures: readonly IPackTextureFile[];
  /** Custom textures with no source file; the pack would show a missing-texture checkerboard. */
  readonly missing_textures: readonly string[];
  /** Paste into the client entity's `description` (Bedrock entities and attachables). */
  readonly client_entity: { readonly particle_effects: Readonly<Record<string, string>> };
  /** Problems that make the mapping ambiguous. */
  readonly conflicts: readonly string[];
}

/** Picks unique JSON file names, prefixing the namespace when two identifiers share a short name. */
function particleFiles(effects: readonly IPackEffect[]): IPackParticleFile[] {
  const shortNameCounts = Map.groupBy(effects, (effect) => shortNameOf(effect.file.particle_effect.description.identifier));
  return effects.map((effect) => {
    const identifier = effect.file.particle_effect.description.identifier;
    const clashes = (shortNameCounts.get(shortNameOf(identifier))?.length ?? 0) > 1;
    const relativePath = clashes ? `${PARTICLES_FOLDER}/${shortNameOf(identifier.replace(":", "_"))}.json` : particleFileRelativePath(identifier);
    return { identifier, relative_path: relativePath, content: `${JSON.stringify(effect.file, null, "\t")}\n` };
  });
}

/**
 * Plans a Bedrock resource-pack delivery for the given effects.
 *
 * @param effects - Effects to ship; duplicates by identifier are collapsed, keeping the first.
 */
export function planParticlePack(effects: readonly IPackEffect[]): IParticlePackPlan {
  const unique = effects.filter((effect, index) => effects.findIndex((other) => other.file.particle_effect.description.identifier === effect.file.particle_effect.description.identifier) === index);
  const mappings = unique.flatMap((effect) => {
    const identifier = effect.file.particle_effect.description.identifier;
    const names = effect.short_names?.length ? effect.short_names : [shortNameOf(identifier)];
    return names.map((name) => [name, identifier] as const);
  });
  const identifiersByName = Map.groupBy(mappings, ([name]) => name);
  const conflicts = [...identifiersByName]
    .map(([name, entries]) => [name, [...new Set(entries.map(([, identifier]) => identifier))]] as const)
    .filter(([, identifiers]) => identifiers.length > 1)
    .map(([name, identifiers]) => `Effect name "${name}" maps to ${identifiers.join(" and ")}; give each keyframe effect its own name so the client entity can map it.`);
  const textureOf = (effect: IPackEffect): string => effect.file.particle_effect.description.basic_render_parameters.texture;
  const unsafe = unique.filter((effect) => !isSafeTexturePath(textureOf(effect)));
  const custom = unique.filter((effect) => !BUILT_IN_TEXTURE_PATHS.has(textureOf(effect)) && isSafeTexturePath(textureOf(effect)));
  const textures = custom.flatMap((effect): IPackTextureFile[] => {
    const texture = effect.file.particle_effect.description.basic_render_parameters.texture;
    return effect.texture_source ? [{ texture, relative_path: `${texture}.png`, source_path: effect.texture_source }] : [];
  });
  const missing = custom.filter((effect) => !effect.texture_source).map((effect) => effect.file.particle_effect.description.basic_render_parameters.texture);
  return {
    particles: particleFiles(unique),
    textures: textures.filter((entry, index) => textures.findIndex((other) => other.relative_path === entry.relative_path) === index),
    missing_textures: [...new Set(missing)],
    client_entity: { particle_effects: Object.fromEntries(mappings) },
    conflicts: [
      ...conflicts,
      ...unsafe.map((effect) => `${effect.file.particle_effect.description.identifier} uses texture path "${textureOf(effect)}", which leaves the pack; its texture was not copied. Use a path like textures/particle/<name>.`),
    ],
  };
}
