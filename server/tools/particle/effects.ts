/// <reference types="blockbench-types" />
import type { z } from "zod";
import { createTool } from "@/lib/factories";
import { applyParticleDesign, buildParticleEffect, shortNameOf } from "@/lib/particles/build";
import {
  BUILT_IN_PARTICLE_TEXTURES,
  FACING_CAMERA_MODES,
  PARTICLE_MATERIALS,
  PARTICLE_SPRITES,
} from "@/lib/particles/catalog";
import { type ParticleDesign, type ParticleEffectFile, particleEffectFileSchema } from "@/lib/particles/design";
import { particleFileRelativePath, planParticlePack } from "@/lib/particles/pack";
import { PARTICLE_PRESETS } from "@/lib/particles/presets";
import { animationTriggerWarning, summarizeParticleEffect, validateParticleEffect } from "@/lib/particles/validate";
import { createJsonResult } from "@/lib/tool-results";
import { particleToolDocs } from "./docs";
import {
  type IParticleFs,
  type ITextureImageInput,
  type IWrittenTexture,
  loadedEffects,
  packRootOf,
  particleFs,
  particlePath,
  readEffectFile,
  resolveEffect,
  resolvePackRoot,
  textureStatus,
  writeEffect,
  writeTextureImage,
} from "./host";
import type {
  createParticleEffectParameters,
  listParticleEffectsParameters,
  listParticlePresetsParameters,
  updateParticleEffectParameters,
} from "./schemas";
import { type IParticleUsage, projectParticleUsages } from "./usages";

type CreateInput = z.infer<typeof createParticleEffectParameters>;
type UpdateInput = z.infer<typeof updateParticleEffectParameters>;

const spec = (name: string) => {
  const found = particleToolDocs.find((entry) => entry.name === name);
  if (!found) throw new Error(`Missing particle tool spec ${name}.`);
  return found;
};

/**
 * Validates an effect and throws every error at once, so nothing invalid is
 * written or loaded.
 *
 * @returns The warnings, for the tool result.
 */
function assertValidEffect(file: ParticleEffectFile): readonly string[] {
  const validation = validateParticleEffect(file);
  if (!validation.valid) throw new Error(`The particle effect is invalid:\n- ${validation.errors.join("\n- ")}`);
  return validation.warnings;
}

/** Design knobs that point the effect at a freshly written custom texture. */
function textureDesign(written: IWrittenTexture | undefined): ParticleDesign {
  if (!written) return {};
  return { texture: written.texture, texture_size: written.size };
}

/** Parses raw JSON as a particle effect. */
function parseRaw(raw: Record<string, unknown>): ParticleEffectFile {
  const parsed = particleEffectFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`raw is not a Bedrock particle effect: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return parsed.data;
}

/** Builds the requested effect from raw JSON or preset + design, with the texture applied last. */
function composeEffect(input: CreateInput, written: IWrittenTexture | undefined): ParticleEffectFile {
  if (input.raw && (input.preset || input.design)) throw new Error("Pass raw on its own, or preset/design, not both.");
  if (input.raw) {
    const file = parseRaw(input.raw);
    const renamed = { ...file, particle_effect: { ...file.particle_effect, description: { ...file.particle_effect.description, identifier: input.identifier } } };
    return applyParticleDesign(renamed, textureDesign(written));
  }
  const preset = input.preset ? PARTICLE_PRESETS[input.preset].design : {};
  return buildParticleEffect(input.identifier, preset, input.design ?? {}, textureDesign(written));
}

/** The result every write tool returns about one effect. */
function effectReport(filePath: string, file: ParticleEffectFile, warnings: readonly string[], written: IWrittenTexture | undefined): Record<string, unknown> {
  const loaded = loadedEffects().find((entry) => entry.path === filePath);
  const identifier = file.particle_effect.description.identifier;
  return {
    file: filePath,
    identifier,
    effect_name: shortNameOf(identifier),
    summary: summarizeParticleEffect(file),
    texture: loaded ? textureStatus(loaded.effect) : "not loaded",
    ...(written ? { texture_file: written.file } : {}),
    warnings,
    next_steps: `Place it with manage_particle_keyframes (effect: "${shortNameOf(identifier)}"), usually at a locator from add_locator. Bedrock never stops a looping emitter fired from a keyframe: for keyframes use looping: false with duration = clip length; loops belong on animation controller states. Preview in Animate mode: animation_timeline set_time (to 0, then the time to inspect, so edited emitters restart), then capture_screenshot.`,
  };
}

/** Writes the optional texture image, returning undefined when none was requested. */
function maybeWriteTexture(fs: IParticleFs, packRoot: string, image: ITextureImageInput | undefined, fallbackName: string, overwrite: boolean): IWrittenTexture | undefined {
  if (!image) return undefined;
  return writeTextureImage(fs, packRoot, image, fallbackName, overwrite);
}

function registerListPresets(): void {
  const docs = spec("list_particle_presets");
  createTool(docs.name, {
    ...docs,
    async execute({ include_designs }: z.infer<typeof listParticlePresetsParameters>) {
      const presets = Object.entries(PARTICLE_PRESETS).map(([name, preset]) => ({
        name,
        description: preset.description,
        trigger: preset.trigger,
        ...(include_designs ? { design: preset.design } : {}),
      }));
      const sprites = Object.entries(PARTICLE_SPRITES).map(([name, sprite]) => ({ name, texture: sprite.texture, colored: sprite.colored, animated: "flipbook" in sprite, description: sprite.description }));
      return createJsonResult({
        presets,
        sprites,
        built_in_textures: BUILT_IN_PARTICLE_TEXTURES,
        materials: PARTICLE_MATERIALS,
        facing_modes: FACING_CAMERA_MODES,
        units: "Sizes, speeds and offsets are in blocks (1 block = 16 model units); times are seconds.",
      });
    },
  }, docs.status);
}

function registerCreate(): void {
  const docs = spec("create_particle_effect");
  createTool(docs.name, {
    ...docs,
    async execute(input: CreateInput) {
      const fs = particleFs(`MCP create_particle_effect writes ${input.identifier} into a particles folder`);
      const packRoot = resolvePackRoot(input.pack_root);
      const filePath = particlePath().join(packRoot, ...particleFileRelativePath(input.identifier).split("/"));
      if (fs.existsSync(filePath) && !input.overwrite) {
        throw new Error(`${filePath} already exists. Pass overwrite: true to replace it, use update_particle_effect to change it, or pick another identifier.`);
      }
      // Build once without the texture to fail fast before any file is written.
      const draft = composeEffect(input, input.texture_image ? { texture: "textures/particle/pending", file: "", size: [16, 16] } : undefined);
      assertValidEffect(draft);
      const written = maybeWriteTexture(fs, packRoot, input.texture_image, shortNameOf(input.identifier), input.overwrite);
      const file = composeEffect(input, written);
      const warnings = assertValidEffect(file);
      writeEffect(fs, filePath, file);
      return createJsonResult(effectReport(filePath, file, warnings, written));
    },
  }, docs.status);
}

function registerUpdate(): void {
  const docs = spec("update_particle_effect");
  createTool(docs.name, {
    ...docs,
    async execute(input: UpdateInput) {
      if (input.raw && input.design) throw new Error("Pass design or raw, not both.");
      const fs = particleFs(`MCP update_particle_effect edits ${input.effect}`);
      const { path: filePath } = resolveEffect(fs, input.effect);
      const current = readEffectFile(fs, filePath);
      const identifier = current.particle_effect.description.identifier;
      const replacement = input.raw ? parseRaw(input.raw) : undefined;
      // Renaming would orphan the keyframes and client entity entries that point at this identifier.
      const base = replacement ? { ...replacement, particle_effect: { ...replacement.particle_effect, description: { ...replacement.particle_effect.description, identifier } } } : current;
      const packRoot = packRootOf(filePath) ?? particlePath().dirname(filePath);
      const written = maybeWriteTexture(fs, packRoot, input.texture_image, shortNameOf(identifier), input.overwrite);
      const file = applyParticleDesign(applyParticleDesign(base, input.design ?? {}), textureDesign(written));
      const warnings = assertValidEffect(file);
      writeEffect(fs, filePath, file);
      return createJsonResult(effectReport(filePath, file, warnings, written));
    },
  }, docs.status);
}

/** Keyframes that cannot preview: no file attached, or a file Blockbench has not loaded. */
function unresolvedUsages(usages: readonly IParticleUsage[], loadedPaths: ReadonlySet<string>): string[] {
  return usages
    .filter((usage) => !usage.file || !loadedPaths.has(usage.file))
    .map((usage) => `${usage.owner}${usage.time === undefined ? ` state ${usage.state}` : ` at ${usage.time}s`}: effect "${usage.effect}" has ${usage.file ? `file ${usage.file}, which is not loaded` : "no particle file"}, so Blockbench cannot preview it. Attach one with manage_particle_keyframes.`);
}

/** Keyframes whose locator does not exist; the game would spawn them at the entity origin. */
function missingLocators(usages: readonly IParticleUsage[]): string[] {
  // @ts-ignore - Locator is a Blockbench global
  const names = new Set((typeof Locator === "undefined" ? [] : Locator.all).map((locator: { name: string }) => locator.name));
  return usages
    .filter((usage) => usage.locator && !names.has(usage.locator))
    .map((usage) => `${usage.owner}: effect "${usage.effect}" uses locator "${usage.locator}", which does not exist. Create it with add_locator.`);
}

/** Looping effects fired from animation keyframes, which Bedrock never stops. */
function loopingKeyframeWarnings(usages: readonly IParticleUsage[], entries: readonly { path: string; effect: { config: { emitter_lifetime_mode?: string } } }[]): string[] {
  const looping = new Set(entries.filter((entry) => entry.effect.config.emitter_lifetime_mode === "looping").map((entry) => entry.path));
  const names = new Set(usages.filter((usage) => usage.source === "keyframe" && usage.file && looping.has(usage.file)).map((usage) => usage.effect));
  return [...names].flatMap((name) => animationTriggerWarning(name, true) ?? []);
}

/** Reads an effect file for reporting, tolerating unreadable files. */
function tryRead(fs: IParticleFs, filePath: string): [string, undefined] | [undefined, ParticleEffectFile] {
  try {
    return [undefined, readEffectFile(fs, filePath)];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error), undefined];
  }
}

function registerList(): void {
  const docs = spec("list_particle_effects");
  createTool(docs.name, {
    ...docs,
    async execute({ include_json }: z.infer<typeof listParticleEffectsParameters>) {
      const fs = particleFs("MCP list_particle_effects reads the loaded particle files");
      const usages = projectParticleUsages();
      const entries = loadedEffects();
      const reads = entries.map(({ path, effect }) => ({ path, effect, read: tryRead(fs, path) }));
      const effects = reads.map(({ path, effect, read: [readError, file] }) => {
        const used = usages.filter((usage) => usage.file === path);
        return {
          file: path,
          identifier: effect.config.identifier ?? null,
          texture: textureStatus(effect),
          ...(file ? { summary: summarizeParticleEffect(file), warnings: validateParticleEffect(file).warnings } : { error: readError }),
          used_by: used.map(({ source, owner, time, state, effect: name, locator }) => ({ source, owner, time, state, effect: name, locator })),
          ...(include_json && file ? { json: file } : {}),
        };
      });
      const packable = reads.flatMap(({ path, read: [, file] }) => {
        if (!file) return [];
        const names = usages.filter((usage) => usage.file === path).map((usage) => usage.effect).filter(Boolean);
        return [{ file, short_names: [...new Set(names)] }];
      });
      const plan = planParticlePack(packable);
      return createJsonResult({
        effects,
        keyframe_count: usages.filter((usage) => usage.source === "keyframe").length,
        problems: [...unresolvedUsages(usages, new Set(entries.map((entry) => entry.path))), ...missingLocators(usages), ...loopingKeyframeWarnings(usages, entries), ...plan.conflicts],
        client_entity: plan.client_entity,
      });
    },
  }, docs.status);
}

/** Registers the effect authoring and inspection tools. */
export function registerParticleEffectTools(): void {
  registerListPresets();
  registerCreate();
  registerUpdate();
  registerList();
}
