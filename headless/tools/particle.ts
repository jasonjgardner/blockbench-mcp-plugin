/**
 * Particle tools: author Bedrock particle effect files next to a model and
 * deliver the effects a model uses into a resource pack.
 *
 * Effects are written in the resource-pack layout Blockbench resolves
 * (`<pack_root>/particles/<name>.json`, textures in `textures/particle/`), so
 * opening the model in Blockbench previews them and the same files ship. Place
 * effects on a model with `bbmodel_edit` (`add_locator`, `set_particle_keyframe`).
 * Shares its builder, presets and validator with the desktop plugin.
 *
 * @module
 */

import { dirname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { applyParticleDesign, buildParticleEffect, shortNameOf } from "@/lib/particles/build";
import { BUILT_IN_TEXTURE_PATHS } from "@/lib/particles/catalog";
import { type ParticleDesign, type ParticleEffectFile, particleDesignSchema, particleEffectFileSchema, particleIdentifierSchema } from "@/lib/particles/design";
import { type IPackEffect, packRootOfParticleFile, particleFileRelativePath, particleTexturePath, planParticlePack } from "@/lib/particles/pack";
import { PARTICLE_PRESET_NAMES, PARTICLE_PRESETS } from "@/lib/particles/presets";
import { animationTriggerWarning, isLoopingEffect, isSafeTexturePath, summarizeParticleEffect, validateParticleEffect } from "@/lib/particles/validate";
import { pngSize } from "../document/png";
import { EFFECTS_ANIMATOR_KEY, locatorsOf } from "../edit/particle-operations";
import { defineTool, fileParam, type IHeadlessContext, type IRegistrableTool } from "../tool";

/** Throws every validation error at once so nothing invalid is written. */
function assertValid(file: ParticleEffectFile): readonly string[] {
  const validation = validateParticleEffect(file);
  if (!validation.valid) throw new Error(`The particle effect is invalid:\n- ${validation.errors.join("\n- ")}`);
  return validation.warnings;
}

/** Parses a particle file's text. */
function parseEffect(text: string, path: string): ParticleEffectFile {
  const parsed = particleEffectFileSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${path} is not a Bedrock particle effect: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return parsed.data;
}

/** Reads a particle file, or undefined when it does not exist. */
async function readEffect(path: string): Promise<ParticleEffectFile | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  return parseEffect(await file.text(), path);
}

/** Forward-slash path from a model's folder to a file, as keyframes store it. */
const modelRelative = (modelPath: string, target: string): string => relative(dirname(modelPath), target).split(/[\\/]/).join("/");

/** Copies a workspace PNG into `<packRoot>/textures/particle/`, returning design knobs that point at it. */
async function copyTexture(context: IHeadlessContext, packRoot: string, source: string, name: string, overwrite: boolean): Promise<{ design: ParticleDesign; file: string }> {
  const sourcePath = context.store.resolvePath(source, [".png"]);
  const bytes = new Uint8Array(await Bun.file(sourcePath).arrayBuffer());
  const { width, height } = pngSize(bytes);
  const texture = particleTexturePath(name);
  const target = context.store.resolvePath(join(packRoot, ...`${texture}.png`.split("/")), [".png"]);
  if (!overwrite && target !== sourcePath && (await Bun.file(target).exists())) throw new Error(`${target} already exists; pass overwrite: true to replace it.`);
  if (target !== sourcePath) await Bun.write(target, bytes, { createPath: true });
  return { design: { texture, texture_size: [width, height] }, file: target };
}

const effectTool = defineTool({
  name: "bbmodel_particle_effect",
  title: "Particle Effect",
  description: [
    "Creates or updates a Bedrock particle effect file (the Snowstorm format Blockbench previews and Bedrock/GeckoLib use) at <pack_root>/particles/<name>.json.",
    "create builds it from a preset plus design knobs (units: blocks and seconds) or raw JSON; update applies design knobs to the existing file, rewriting only the components each knob owns.",
    "An optional workspace PNG is copied to textures/particle/. The file is validated before writing.",
    "Presets: " + PARTICLE_PRESET_NAMES.join(", ") + ".",
    "Then place it with bbmodel_edit: add_locator and set_particle_keyframe (use the returned keyframe_file when model is given).",
  ].join(" "),
  parameters: {
    identifier: particleIdentifierSchema,
    action: z.enum(["create", "update"]).default("create"),
    preset: z.enum(PARTICLE_PRESET_NAMES).optional().describe("create only: starting point, overridden by design."),
    design: particleDesignSchema.optional(),
    raw: z.record(z.string(), z.unknown()).optional().describe("A complete particle file instead of preset/design; its identifier is replaced."),
    texture_image: z.string().min(1).optional().describe("Workspace PNG to use as a custom texture; copied to <pack_root>/textures/particle/<effect name>.png."),
    pack_root: z.string().default(".").describe("Resource-pack-style folder inside the workspace (usually the model's folder or an RP root)."),
    model: fileParam.optional().describe("A .bbmodel the effect is for; the result then includes the keyframe file path relative to it."),
    overwrite: z.boolean().default(false).describe("Replace an existing effect file (create) or a texture PNG with different content (create and update)."),
  },
  readOnly: false,
  destructive: true,
  async execute({ identifier, action, preset, design, raw, texture_image, pack_root, model, overwrite }, context) {
    if (raw && (preset || design)) throw new Error("Pass raw on its own, or preset/design, not both.");
    if (action === "update" && preset) throw new Error("preset applies to create; pass design knobs to update.");
    const packRoot = context.store.resolvePath(pack_root);
    const path = context.store.resolvePath(join(packRoot, ...particleFileRelativePath(identifier).split("/")), [".json"]);
    const existing = await readEffect(path);
    if (action === "update" && !existing) throw new Error(`${path} does not exist; use action: create.`);
    if (action === "create" && existing && !overwrite) throw new Error(`${path} already exists; pass overwrite: true, or use action: update.`);
    // File names come from the short name, so b:smoke would otherwise edit a:smoke's file.
    const existingId = existing?.particle_effect.description.identifier;
    if (action === "update" && existingId !== identifier) throw new Error(`${path} holds ${existingId}, not ${identifier}. Pass that identifier, or create ${identifier} under another pack_root.`);
    const texture = texture_image ? await copyTexture(context, packRoot, texture_image, shortNameOf(identifier), overwrite) : undefined;
    const knobs = design ?? {};
    const rawFile = raw ? parseEffect(JSON.stringify(raw), "raw") : undefined;
    const renamed = rawFile ? { ...rawFile, particle_effect: { ...rawFile.particle_effect, description: { ...rawFile.particle_effect.description, identifier } } } : undefined;
    const base = renamed ?? (action === "update" && existing ? existing : undefined);
    const file = base
      ? applyParticleDesign(applyParticleDesign(base, knobs), texture?.design ?? {})
      : buildParticleEffect(identifier, preset ? PARTICLE_PRESETS[preset].design : {}, knobs, texture?.design ?? {});
    const warnings = assertValid(file);
    await context.store.writeText(path, `${JSON.stringify(file, null, "\t")}\n`, true);
    const modelPath = model ? context.store.resolveModelPath(model) : undefined;
    return {
      file: path,
      identifier,
      effect_name: shortNameOf(identifier),
      summary: summarizeParticleEffect(file),
      ...(texture ? { texture_file: texture.file } : {}),
      ...(modelPath ? { keyframe_file: modelRelative(modelPath, path) } : {}),
      warnings,
    };
  },
});

/** Whether `target` is `root` or inside it. */
function isInsideFolder(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The custom texture PNG for an effect, found the way Blockbench's preview
 * finds it (beside the pack's first `particles` folder). Built-in textures,
 * paths that leave the pack and files outside the workspace count as missing.
 */
async function findTexture(context: IHeadlessContext, effectPath: string, texture: string): Promise<string | undefined> {
  const packRoot = packRootOfParticleFile(effectPath);
  if (!packRoot || BUILT_IN_TEXTURE_PATHS.has(texture) || !isSafeTexturePath(texture)) return undefined;
  const [error, candidate] = tryResolve(() => context.store.resolvePath(join(packRoot, ...`${texture}.png`.split("/")), [".png"]));
  if (error || !candidate || !(await Bun.file(candidate).exists())) return undefined;
  return candidate;
}

/** Runs a path resolution as an error tuple. */
function tryResolve(resolvePath: () => string): [unknown, undefined] | [undefined, string] {
  try {
    return [undefined, resolvePath()];
  } catch (error) {
    return [error, undefined];
  }
}

/** One particle reference in a model's animations. */
interface IModelParticle {
  animation: string;
  time: number;
  effect: string;
  file: string;
  locator: string;
}

const packTool = defineTool({
  name: "bbmodel_particle_pack",
  title: "Particle Pack",
  description:
    "Delivers the particle effects a .bbmodel's animations use into a Bedrock resource pack: writes particles/<name>.json, copies custom textures to textures/particle/, and returns the client entity particle_effects map. Reports keyframes with no effect file, missing locators and effect name conflicts. Refuses to overwrite files with different content unless overwrite is true.",
  parameters: {
    file: fileParam,
    destination: z.string().min(1).describe("Resource pack root inside the workspace."),
    overwrite: z.boolean().default(false),
  },
  readOnly: false,
  destructive: true,
  async execute({ file, destination, overwrite }, context) {
    const { path: modelPath, doc } = await context.store.read(file);
    const usages: IModelParticle[] = (doc.animations ?? []).flatMap((animation) =>
      (animation.animators[EFFECTS_ANIMATOR_KEY]?.keyframes ?? [])
        .filter((key) => key.channel === "particle")
        .flatMap((key) => key.data_points.map((point) => ({
          animation: animation.name,
          time: key.time,
          effect: typeof point.effect === "string" ? point.effect : "",
          file: typeof point.file === "string" ? point.file : "",
          locator: typeof point.locator === "string" ? point.locator : "",
        }))),
    );
    const locatorNames = new Set(locatorsOf(doc).map((locator) => locator.name));
    const withFiles = usages.filter((usage) => usage.file);
    // Blockbench stores absolute paths when its export_asset_paths setting asks for them, or across drives.
    const resolveEffectPath = (usageFile: string): string => context.store.resolvePath(isAbsolute(usageFile) ? usageFile : join(dirname(modelPath), usageFile), [".json"]);
    const paths = [...new Set(withFiles.map((usage) => resolveEffectPath(usage.file)))];
    const sources = await Promise.all(paths.map(async (path) => {
      const effect = await readEffect(path);
      if (!effect) throw new Error(`Particle file ${path} (used by the model) does not exist.`);
      const names = withFiles.filter((usage) => resolveEffectPath(usage.file) === path).map((usage) => usage.effect).filter(Boolean);
      const textureSource = await findTexture(context, path, effect.particle_effect.description.basic_render_parameters.texture);
      const packEffect: IPackEffect = { file: effect, short_names: [...new Set(names)], ...(textureSource ? { texture_source: textureSource } : {}) };
      return { path, packEffect };
    }));
    const effects = sources.map((source) => source.packEffect);
    const plan = planParticlePack(effects);
    const root = context.store.resolvePath(destination);
    // An effect already inside this pack's particles folder ships as it is; a renamed copy would duplicate its identifier.
    const inPlace = sources.filter((source) => isInsideFolder(join(root, "particles"), source.path));
    const inPlaceIds = new Set(inPlace.map((source) => source.packEffect.file.particle_effect.description.identifier));
    const particleWrites = plan.particles
      .filter((particle) => !inPlaceIds.has(particle.identifier))
      .map((particle) => ({ target: context.store.resolvePath(join(root, ...particle.relative_path.split("/")), [".json"]), bytes: new TextEncoder().encode(particle.content) }));
    const textureWrites = await Promise.all(plan.textures.map(async (texture) => ({ target: context.store.resolvePath(join(root, ...texture.relative_path.split("/")), [".png"]), bytes: new Uint8Array(await Bun.file(texture.source_path).arrayBuffer()) })));
    const writes = [...particleWrites, ...textureWrites];
    const escaping = writes.filter((write) => !isInsideFolder(root, write.target));
    if (escaping.length) throw new Error(`Refusing to write outside ${root}: ${escaping.map((write) => write.target).join(", ")}.`);
    const current = await Promise.all(writes.map(async (write) => {
      const existing = Bun.file(write.target);
      if (!(await existing.exists())) return "new" as const;
      const bytes = new Uint8Array(await existing.arrayBuffer());
      return bytes.length === write.bytes.length && bytes.every((value, index) => value === write.bytes[index]) ? ("same" as const) : ("different" as const);
    }));
    const blocked = writes.filter((_, index) => current[index] === "different");
    if (blocked.length && !overwrite) throw new Error(`These files exist with different content: ${blocked.map((write) => write.target).join(", ")}. Pass overwrite: true to replace them.`);
    const pending = writes.filter((_, index) => current[index] !== "same");
    await Promise.all(pending.map((write) => Bun.write(write.target, write.bytes, { createPath: true })));
    const problems = [
      ...usages.filter((usage) => !usage.file).map((usage) => `${usage.animation} at ${usage.time}s: effect "${usage.effect}" has no particle file, so it is not packed or previewed.`),
      ...usages.filter((usage) => usage.locator && !locatorNames.has(usage.locator)).map((usage) => `${usage.animation} at ${usage.time}s: locator "${usage.locator}" does not exist.`),
      ...plan.conflicts,
      ...plan.missing_textures.map((texture) => `No PNG found for ${texture}; the game shows a missing texture.`),
      ...effects.filter((effect) => isLoopingEffect(effect.file)).flatMap((effect) => (effect.short_names ?? []).flatMap((name) => animationTriggerWarning(name, true) ?? [])),
    ];
    return {
      destination: root,
      written: pending.map((write) => write.target),
      unchanged: writes.filter((_, index) => current[index] === "same").map((write) => write.target),
      already_in_pack: inPlace.map((source) => source.path),
      client_entity: plan.client_entity,
      problems,
      next_steps: "Merge client_entity.particle_effects into the entity's client entity description. Export the model's animations from Blockbench so their particle_effects keyframes ship alongside.",
    };
  },
});

/** Particle tools. */
export const particleTools: readonly IRegistrableTool[] = [effectTool, packTool];
