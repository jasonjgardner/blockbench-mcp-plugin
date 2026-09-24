import { describe, expect, test } from "bun:test";
import {
  applyParticleDesign,
  buildParticleEffect,
  composePatches,
  hexToParticleColor,
  mergeDesigns,
  mergePatch,
  rangeToMolang,
  shortNameOf,
} from "./build";
import { BUILT_IN_TEXTURE_PATHS, PARTICLE_SPRITES } from "./catalog";
import { particleDesignSchema, particleEffectFileSchema } from "./design";
import { packRootOfParticleFile, particleFileRelativePath, particleTexturePath, planParticlePack } from "./pack";
import { PARTICLE_PRESET_NAMES, PARTICLE_PRESETS } from "./presets";
import { isSafeTexturePath, summarizeParticleEffect, validateParticleEffect } from "./validate";

const components = (file: ReturnType<typeof buildParticleEffect>): Record<string, unknown> => file.particle_effect.components;

describe("presets", () => {
  test.each(PARTICLE_PRESET_NAMES)("%s builds a valid effect with a built-in texture and no warnings", (name) => {
    const design = particleDesignSchema.parse(PARTICLE_PRESETS[name].design);
    const file = buildParticleEffect(`test:${name}`, design);
    const validation = validateParticleEffect(file);
    expect(validation.errors).toEqual([]);
    expect(validation.warnings).toEqual([]);
    expect(BUILT_IN_TEXTURE_PATHS.has(file.particle_effect.description.basic_render_parameters.texture)).toBe(true);
    expect(particleEffectFileSchema.safeParse(file).success).toBe(true);
  });

  test("one-shot presets emit a burst once and continuous presets loop", () => {
    PARTICLE_PRESET_NAMES.forEach((name) => {
      const file = buildParticleEffect(`test:${name}`, PARTICLE_PRESETS[name].design);
      const oneShot = PARTICLE_PRESETS[name].trigger === "one_shot";
      expect("minecraft:emitter_rate_instant" in components(file)).toBe(oneShot);
      expect("minecraft:emitter_lifetime_once" in components(file)).toBe(oneShot);
      expect("minecraft:emitter_lifetime_looping" in components(file)).toBe(!oneShot);
    });
  });
});

describe("buildParticleEffect", () => {
  test("an override burst replaces the preset's steady rate and stops looping", () => {
    const file = buildParticleEffect("test:smoke", PARTICLE_PRESETS.smoke.design, { burst: 12 });
    expect(components(file)["minecraft:emitter_rate_instant"]).toEqual({ num_particles: 12 });
    expect(components(file)["minecraft:emitter_rate_steady"]).toBeUndefined();
    expect(components(file)["minecraft:emitter_lifetime_once"]).toEqual({ active_time: 1 });
  });

  test("loops run 10 s per cycle so the preview does not restart them, and a new mode drops the old timing", () => {
    expect(components(buildParticleEffect("test:a", { rate: 5 }))["minecraft:emitter_lifetime_looping"]).toEqual({ active_time: 10 });
    const sparks = buildParticleEffect("test:a", PARTICLE_PRESETS.sparks.design);
    expect(components(applyParticleDesign(sparks, { rate: 5 }))["minecraft:emitter_lifetime_once"]).toEqual({ active_time: 0.1 });
    const fromBurst = applyParticleDesign(sparks, { rate: 5, looping: true });
    expect(components(fromBurst)["minecraft:emitter_lifetime_looping"]).toEqual({ active_time: 10 });
    expect(components(buildParticleEffect("test:a", PARTICLE_PRESETS.sparks.design, { rate: 5 }))["minecraft:emitter_lifetime_looping"]).toEqual({ active_time: 10 });
    const kept = applyParticleDesign(buildParticleEffect("test:a", { rate: 5, duration: 3 }), { rate: 8 });
    expect(components(kept)["minecraft:emitter_lifetime_looping"]).toEqual({ active_time: 3 });
  });

  test("estimates max_particles from rate and the longest lifetime", () => {
    const file = buildParticleEffect("test:a", { rate: 40, lifetime: [1, 3] });
    expect(components(file)["minecraft:emitter_rate_steady"]).toEqual({ spawn_rate: 40, max_particles: 150 });
  });

  test("sizes interpolate over life and vary per particle", () => {
    const file = buildParticleEffect("test:a", { size: [0.2, 0.6], size_variation: 0.5 });
    const billboard = components(file)["minecraft:particle_appearance_billboard"] as { size: string[] };
    expect(billboard.size[0]).toBe("(math.lerp(0.2, 0.6, variable.particle_age / variable.particle_lifetime)) * (1 + (variable.particle_random_3 - 0.5) * 0.5)");
    expect(billboard.size[1]).toBe(billboard.size[0]);
  });

  test("fade_out turns a single color into a gradient ending transparent", () => {
    const file = buildParticleEffect("test:a", { color: "#ff8000", fade_out: true, material: "particles_blend" });
    expect(components(file)["minecraft:particle_appearance_tinting"]).toEqual({
      color: { gradient: { "0.00": [1, 0.502, 0, 1], "1.00": [1, 0.502, 0, 0] }, interpolant: "variable.particle_age / variable.particle_lifetime" },
    });
  });

  test("point emitters get a random direction for outwards", () => {
    const file = buildParticleEffect("test:a", { shape: { type: "point" }, direction: "outwards" });
    expect(components(file)["minecraft:emitter_shape_point"]).toEqual({ direction: ["math.random(-1, 1)", "math.random(-1, 1)", "math.random(-1, 1)"] });
  });

  test("a disc lays flat by default and replaces the previous shape", () => {
    const file = buildParticleEffect("test:a", { shape: { type: "disc", radius: 0.4, surface_only: true } });
    expect(components(file)["minecraft:emitter_shape_point"]).toBeUndefined();
    expect(components(file)["minecraft:emitter_shape_disc"]).toEqual({ radius: 0.4, plane_normal: [0, 1, 0], surface_only: true, direction: "outwards" });
  });

  test("a custom vertical flipbook derives the texture size from its frames", () => {
    const file = buildParticleEffect("test:a", { texture: "textures/particle/leaf", flipbook: { frame_size: [16, 16], frames: 4, axis: "vertical" } });
    expect(file.particle_effect.description.basic_render_parameters.texture).toBe("textures/particle/leaf");
    expect((components(file)["minecraft:particle_appearance_billboard"] as { uv: unknown }).uv).toEqual({
      texture_width: 16,
      texture_height: 64,
      flipbook: { base_UV: [0, 0], size_UV: [16, 16], step_UV: [0, 16], frames_per_second: 4, max_frame: 4, stretch_to_lifetime: true },
    });
  });

  test("a new custom texture needs its size; the same texture keeps its recorded size", () => {
    expect(() => buildParticleEffect("test:a", { texture: "textures/particle/leaf" })).toThrow("texture_size");
    const leaf = buildParticleEffect("test:a", { texture: "textures/particle/leaf", texture_size: [8, 16] });
    const reapplied = applyParticleDesign(leaf, { texture: "textures/particle/leaf" });
    expect((components(reapplied)["minecraft:particle_appearance_billboard"] as { uv: unknown }).uv).toEqual({ texture_width: 8, texture_height: 16, uv: [0, 0], uv_size: [8, 16] });
  });

  test("a sprite replaces the whole UV block", () => {
    const file = buildParticleEffect("test:a", { sprite: "glow" });
    expect((components(file)["minecraft:particle_appearance_billboard"] as { uv: unknown }).uv).toEqual({ texture_width: 128, texture_height: 128, uv: [32, 16], uv_size: [32, 32] });
  });

  test("rate and burst together are rejected", () => {
    expect(() => buildParticleEffect("test:a", { rate: 1, burst: 2 })).toThrow("not both");
  });

  test("raw component patches apply last and null deletes", () => {
    const file = buildParticleEffect("test:a", { components: { "minecraft:particle_motion_dynamic": null, "minecraft:particle_initial_speed": "math.random(1, 2)" } });
    expect(components(file)["minecraft:particle_motion_dynamic"]).toBeUndefined();
    expect(components(file)["minecraft:particle_initial_speed"]).toBe("math.random(1, 2)");
  });
});

describe("applyParticleDesign", () => {
  test("changes only the components a knob owns", () => {
    const original = buildParticleEffect("test:a", PARTICLE_PRESETS.bubbles.design);
    const updated = applyParticleDesign(original, { lifetime: 4 });
    expect(components(updated)["minecraft:particle_lifetime_expression"]).toEqual({ max_lifetime: 4 });
    expect(components(updated)["minecraft:particle_motion_dynamic"]).toEqual(components(original)["minecraft:particle_motion_dynamic"]);
    expect(components(original)["minecraft:particle_lifetime_expression"]).toEqual({ max_lifetime: "math.random(1.5, 2.5)" });
  });

  test("rate on a once emitter keeps it finite and keeps a sufficient cap", () => {
    const once = buildParticleEffect("test:a", { rate: 5, looping: false, duration: 2, lifetime: 4, max_particles: 100 });
    const updated = applyParticleDesign(once, { rate: 10 });
    expect(components(updated)["minecraft:emitter_lifetime_once"]).toEqual({ active_time: 2 });
    expect(components(updated)["minecraft:emitter_lifetime_looping"]).toBeUndefined();
    expect(components(updated)["minecraft:emitter_rate_steady"]).toEqual({ spawn_rate: 10, max_particles: 100 });
    const raised = applyParticleDesign(once, { rate: 50 });
    expect(components(raised)["minecraft:emitter_rate_steady"]).toEqual({ spawn_rate: 50, max_particles: 250 });
  });

  test("fade_out alone keeps the current colors", () => {
    const orange = buildParticleEffect("test:a", { color: "#ff8000", material: "particles_blend" });
    const faded = applyParticleDesign(orange, { fade_out: true });
    expect(components(faded)["minecraft:particle_appearance_tinting"]).toEqual({
      color: { gradient: { "0.00": [1, 0.502, 0, 1], "1.00": [1, 0.502, 0, 0] }, interpolant: "variable.particle_age / variable.particle_lifetime" },
    });
    const gradient = buildParticleEffect("test:a", { color: ["#ff0000", "#0000ff"], fade_out: true, material: "particles_blend" });
    const opaque = applyParticleDesign(gradient, { fade_out: false });
    expect(components(opaque)["minecraft:particle_appearance_tinting"]).toEqual({
      color: { gradient: { "0.00": [1, 0, 0, 1], "1.00": [0, 0, 1, 1] }, interpolant: "variable.particle_age / variable.particle_lifetime" },
    });
    const molang = applyParticleDesign(buildParticleEffect("test:a"), { components: { "minecraft:particle_appearance_tinting": { color: ["variable.r", 1, 1, 1] } } });
    expect(() => applyParticleDesign(molang, { fade_out: true })).toThrow("pass color");
  });

  test("a shape of the same type and spin keep the fields a knob does not set", () => {
    const sphere = buildParticleEffect("test:a", { shape: { type: "sphere", radius: 2, offset: [0, 1, 0] }, direction: "inwards", spin: { initial: 45 } });
    const updated = applyParticleDesign(sphere, { shape: { type: "sphere", surface_only: true }, spin: { rate: 90 } });
    expect(components(updated)["minecraft:emitter_shape_sphere"]).toEqual({ offset: [0, 1, 0], radius: 2, direction: "inwards", surface_only: true });
    expect(components(updated)["minecraft:particle_initial_spin"]).toEqual({ rotation: 45, rotation_rate: 90 });
  });

  test("direction alone patches the existing shape", () => {
    const original = buildParticleEffect("test:a", { shape: { type: "sphere", radius: 1 } });
    const updated = applyParticleDesign(original, { direction: "inwards" });
    expect(components(updated)["minecraft:emitter_shape_sphere"]).toEqual({ radius: 1, direction: "inwards" });
  });

  test("max_particles alone updates the steady cap and is refused for bursts", () => {
    const steady = applyParticleDesign(buildParticleEffect("test:a"), { max_particles: 7 });
    expect(components(steady)["minecraft:emitter_rate_steady"]).toEqual({ spawn_rate: 8, max_particles: 7 });
    expect(() => applyParticleDesign(buildParticleEffect("test:a", { burst: 3 }), { max_particles: 7 })).toThrow("steady");
  });
});

describe("helpers", () => {
  test("hex colors convert in CSS order", () => {
    expect(hexToParticleColor("#ff000080")).toEqual([1, 0, 0, 0.502]);
    expect(hexToParticleColor("#00ff00")).toEqual([0, 1, 0, 1]);
  });

  test("ranges become Molang", () => {
    expect(rangeToMolang(2)).toBe(2);
    expect(rangeToMolang([1, 1])).toBe(1);
    expect(rangeToMolang([0.5, 2])).toBe("math.random(0.5, 2)");
    expect(rangeToMolang("variable.x")).toBe("variable.x");
  });

  test("short names drop the namespace and illegal characters", () => {
    expect(shortNameOf("mymod:fx/chimney.smoke")).toBe("fx_chimney_smoke");
    expect(shortNameOf("plain")).toBe("plain");
  });

  test("mergePatch deletes with null and replaces arrays", () => {
    expect(mergePatch({ a: { b: 1, c: 2 }, d: [1, 2] }, { a: { b: null }, d: [3] })).toEqual({ a: { c: 2 }, d: [3] });
  });

  test("composePatches keeps deletions for the final document", () => {
    const composed = composePatches({ a: { b: 1 } }, { a: null, c: 2 });
    expect(composed).toEqual({ a: null, c: 2 });
    expect(mergePatch({ a: { b: 5 }, z: 1 }, composed)).toEqual({ z: 1, c: 2 });
  });

  test("mergeDesigns drops the excluded knob and composes raw patches", () => {
    const merged = mergeDesigns({ rate: 5, sprite: "puff", components: { x: { a: 1 } } }, { burst: 3, texture: "textures/particle/y", components: { x: { b: 2 } } });
    expect(merged.rate).toBeUndefined();
    expect(merged.sprite).toBeUndefined();
    expect(merged.burst).toBe(3);
    expect(merged.components).toEqual({ x: { a: 1, b: 2 } });
  });

  test("sprite catalog UVs stay inside their textures", () => {
    Object.values(PARTICLE_SPRITES).forEach((sprite) => {
      const [u, v] = "flipbook" in sprite ? sprite.flipbook.base_UV : sprite.uv;
      const [w, h] = "flipbook" in sprite ? sprite.flipbook.size_UV : sprite.uv_size;
      if (typeof u === "number") expect(u + w).toBeLessThanOrEqual(sprite.texture_width);
      if (typeof v === "number") expect(v + h).toBeLessThanOrEqual(sprite.texture_height);
    });
  });
});

describe("validateParticleEffect", () => {
  const base = (): ReturnType<typeof buildParticleEffect> => buildParticleEffect("test:a");

  test("rejects non-effects", () => {
    expect(validateParticleEffect({}).valid).toBe(false);
    expect(validateParticleEffect({ particle_effect: {} }).errors).toEqual(["particle_effect.components must be an object."]);
  });

  test("reports invisible and non-emitting effects", () => {
    const file = base();
    const stripped = { ...file, particle_effect: { ...file.particle_effect, components: {} } };
    const result = validateParticleEffect(stripped);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("nothing is emitted");
    expect(result.errors.join(" ")).toContain("invisible");
  });

  test("warns on typos, alpha fades, saturation and missing events", () => {
    const file = applyParticleDesign(base(), {
      rate: 100,
      max_particles: 10,
      lifetime: 2,
      color: ["#ffffff", "#ffffff00"],
      components: { "minecraft:particle_apperance_lighting": {}, "minecraft:particle_lifetime_events": { expiration_event: "pop" } },
    });
    const warnings = validateParticleEffect(file).warnings.join("\n");
    expect(warnings).toContain("particle_apperance_lighting is not a Bedrock particle component");
    expect(warnings).toContain("particles_alpha cuts off");
    expect(warnings).toContain("emission stalls at the cap");
    expect(warnings).toContain("Event pop is referenced");
  });

  test("rejects texture paths that leave the pack", () => {
    ["../../outside/pwn", "/abs/tex", "C:/tex", "textures\\particle\\x", "textures//x"].forEach((texture) => {
      const file = buildParticleEffect("test:a", { texture, texture_size: [8, 8] });
      expect(validateParticleEffect(file).errors.join(" ")).toContain("must be pack-relative");
    });
    expect(isSafeTexturePath("textures/particle/spark")).toBe(true);
  });

  test("warns on .png texture paths and the minecraft namespace", () => {
    const file = buildParticleEffect("minecraft:thing", { texture: "textures/particle/x.png", texture_size: [8, 8], rate: 4 });
    const warnings = validateParticleEffect(file).warnings.join("\n");
    expect(warnings).toContain("omit the .png");
    expect(warnings).toContain("minecraft namespace");
  });

  test("summaries describe emission and texture source", () => {
    const summary = summarizeParticleEffect(buildParticleEffect("test:a", PARTICLE_PRESETS.sparks.design));
    expect(summary.emission).toBe("burst of 24");
    expect(summary.emitter_lifetime).toBe("once, 0.1s");
    expect(summary.built_in_texture).toBe(true);
  });
});

describe("planParticlePack", () => {
  test("maps effect names and copies only custom textures", () => {
    const smoke = buildParticleEffect("mymod:smoke", PARTICLE_PRESETS.smoke.design);
    const leaf = buildParticleEffect("mymod:leaf", { texture: "textures/particle/leaf", texture_size: [8, 8] });
    const plan = planParticlePack([
      { file: smoke, short_names: ["smoke", "chimney"] },
      { file: leaf, texture_source: "/pack/textures/particle/leaf.png" },
      { file: smoke },
    ]);
    expect(plan.client_entity.particle_effects).toEqual({ smoke: "mymod:smoke", chimney: "mymod:smoke", leaf: "mymod:leaf" });
    expect(plan.particles.map((file) => file.relative_path)).toEqual(["particles/smoke.json", "particles/leaf.json"]);
    expect(plan.textures).toEqual([{ texture: "textures/particle/leaf", relative_path: "textures/particle/leaf.png", source_path: "/pack/textures/particle/leaf.png" }]);
    expect(plan.missing_textures).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  test("reports missing textures, name conflicts and clashing file names", () => {
    const first = buildParticleEffect("a:spark", { texture: "textures/particle/spark", texture_size: [8, 8] });
    const second = buildParticleEffect("b:spark");
    const plan = planParticlePack([{ file: first, short_names: ["hit"] }, { file: second, short_names: ["hit"] }]);
    expect(plan.missing_textures).toEqual(["textures/particle/spark"]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.particles.map((file) => file.relative_path)).toEqual(["particles/a_spark.json", "particles/b_spark.json"]);
  });

  test("path helpers follow the resource pack layout", () => {
    expect(particleFileRelativePath("mymod:chimney_smoke")).toBe("particles/chimney_smoke.json");
    expect(particleTexturePath("My Leaf.PNG")).toBe("textures/particle/my_leaf");
    expect(packRootOfParticleFile("C:\\RP\\particles\\fx\\particles\\a.json")).toBe("C:\\RP");
    expect(packRootOfParticleFile("/rp/particles/a.json")).toBe("/rp");
    expect(packRootOfParticleFile("/rp/effects/a.json")).toBeUndefined();
  });

  test("textures that leave the pack are reported, never copied", () => {
    const file = buildParticleEffect("test:evil", { texture: "../../outside/pwn", texture_size: [8, 8] });
    const plan = planParticlePack([{ file, texture_source: "/somewhere/pwn.png" }]);
    expect(plan.textures).toEqual([]);
    expect(plan.conflicts.join(" ")).toContain("leaves the pack");
  });
});
