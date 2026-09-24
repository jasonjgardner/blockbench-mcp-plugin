/// <reference types="blockbench-types" />
import type { z } from "zod";
import { createTool } from "@/lib/factories";
import { BUILT_IN_TEXTURE_PATHS } from "@/lib/particles/catalog";
import { planParticlePack } from "@/lib/particles/pack";
import { createJsonResult } from "@/lib/tool-results";
import { particleToolDocs } from "./docs";
import { bytesEqual, type IEffectEntry, type IParticleFs, isInsideFolder, particleFs, particlePath, readEffectFile, resolveEffect, textureFileFor } from "./host";
import type { exportParticlePackParameters } from "./schemas";
import { projectParticleUsages } from "./usages";

type ExportInput = z.infer<typeof exportParticlePackParameters>;

const spec = (name: string) => {
  const found = particleToolDocs.find((entry) => entry.name === name);
  if (!found) throw new Error(`Missing particle tool spec ${name}.`);
  return found;
};

/** A file the export will write, with the bytes to compare against what is there. */
interface IPlannedWrite {
  readonly target: string;
  readonly bytes: Uint8Array;
}

/** Effects to ship: the requested ones, else every effect the project's keyframes and controllers use. */
function selectEffects(fs: IParticleFs, references: readonly string[] | undefined): IEffectEntry[] {
  if (references?.length) return references.map((reference) => resolveEffect(fs, reference));
  const files = [...new Set(projectParticleUsages().map((usage) => usage.file).filter((file): file is string => Boolean(file)))];
  if (!files.length) throw new Error("No particle keyframe in this project has a particle file. Pass effects, or add keyframes with manage_particle_keyframes.");
  return files.map((file) => resolveEffect(fs, file));
}

/** Texture PNG for a custom texture, found the way Blockbench's preview finds it. */
function textureSource(fs: IParticleFs, entry: IEffectEntry, texture: string): string | undefined {
  if (BUILT_IN_TEXTURE_PATHS.has(texture)) return undefined;
  const beside = textureFileFor(entry.path, texture);
  if (beside && fs.existsSync(beside)) return beside;
  const preview = entry.effect.config.preview_texture;
  return preview && particlePath().isAbsolute(preview) && fs.existsSync(preview) ? preview : undefined;
}

function registerExportPack(): void {
  const docs = spec("export_particle_pack");
  createTool(docs.name, {
    ...docs,
    async execute({ destination, effects, overwrite }: ExportInput) {
      const path = particlePath();
      if (!path.isAbsolute(destination)) throw new Error("destination must be an absolute path.");
      const fs = particleFs(`MCP export_particle_pack writes particle files into ${destination}`);
      const entries = selectEffects(fs, effects);
      const usages = projectParticleUsages();
      const plan = planParticlePack(entries.map((entry) => {
        const file = readEffectFile(fs, entry.path);
        const names = usages.filter((usage) => usage.file === entry.path).map((usage) => usage.effect).filter(Boolean);
        return { file, short_names: [...new Set(names)], texture_source: textureSource(fs, entry, file.particle_effect.description.basic_render_parameters.texture) };
      }));
      // An effect already inside this pack's particles folder ships as it is; a copy under another name would duplicate its identifier.
      const inPlace = entries.filter((entry) => isInsideFolder(path.join(destination, "particles"), entry.path));
      const inPlaceIds = new Set(inPlace.map((entry) => entry.effect.config.identifier));
      const encoder = new TextEncoder();
      const writes: IPlannedWrite[] = [
        ...plan.particles.filter((particle) => !inPlaceIds.has(particle.identifier)).map((particle) => ({ target: path.join(destination, ...particle.relative_path.split("/")), bytes: encoder.encode(particle.content) })),
        ...plan.textures.map((texture) => ({ target: path.join(destination, ...texture.relative_path.split("/")), bytes: fs.readFileSync(texture.source_path) })),
      ];
      const escaping = writes.filter((write) => !isInsideFolder(destination, write.target));
      if (escaping.length) throw new Error(`Refusing to write outside ${destination}: ${escaping.map((write) => write.target).join(", ")}.`);
      const unchanged = writes.filter((write) => fs.existsSync(write.target) && bytesEqual(fs.readFileSync(write.target), write.bytes));
      const blocked = writes.filter((write) => fs.existsSync(write.target) && !unchanged.includes(write) && !overwrite);
      if (blocked.length) throw new Error(`These files exist with different content: ${blocked.map((write) => write.target).join(", ")}. Pass overwrite: true to replace them.`);
      const pending = writes.filter((write) => !unchanged.includes(write));
      pending.forEach((write) => {
        fs.mkdirSync(path.dirname(write.target), { recursive: true });
        fs.writeFileSync(write.target, write.bytes);
      });
      return createJsonResult({
        destination,
        written: pending.map((write) => write.target),
        unchanged: unchanged.map((write) => write.target),
        already_in_pack: inPlace.map((entry) => entry.path),
        client_entity: plan.client_entity,
        missing_textures: plan.missing_textures,
        conflicts: plan.conflicts,
        next_steps: [
          "Merge client_entity.particle_effects into the entity's client entity (entity/<name>.entity.json, description) or attachable, so animation keyframe effect names resolve.",
          "Export the animations (Bedrock animation JSON) so their particle_effects keyframes ship; GeckoLib animations carry the same keyframes for your mod's particle handler.",
          ...(plan.missing_textures.length ? [`Add PNGs for ${plan.missing_textures.join(", ")} or the game shows a missing texture.`] : []),
        ],
      });
    },
  }, docs.status);
}

/** Registers the resource pack delivery tool. */
export function registerParticlePackTools(): void {
  registerExportPack();
}
