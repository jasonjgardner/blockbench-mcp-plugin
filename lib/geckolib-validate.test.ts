import { expect, test } from "bun:test";
import { GECKOLIB_ARMOR_TEMPLATE_BONES } from "./geckolib";
import {
  SURVEYED_GECKOLIB_PLUGIN_MAJOR,
  summarizeDiagnostics,
  validateGeckolibAnimations,
  validateGeckolibProject,
  type IGeckolibDiagnostic,
  type IGeckolibProjectFacts,
} from "./geckolib-validate";

/** A project that satisfies every rule, so each test can break exactly one thing. */
const validFacts: IGeckolibProjectFacts = {
  boneNames: ["body", "head", "rightArm"],
  modid: "my_mod",
  identifier: "my_entity",
  modelType: "Entity",
  declaredTextureSize: { width: 64, height: 64 },
  textureSizes: [{ name: "skin", width: 64, height: 64 }],
  pluginVersion: `${SURVEYED_GECKOLIB_PLUGIN_MAJOR}.2.1`,
};

const checkIds = (diagnostics: readonly IGeckolibDiagnostic[]): string[] => diagnostics.map((finding) => finding.check_id);

test("a complete project reports nothing", () => {
  const diagnostics = validateGeckolibProject(validFacts);
  expect(diagnostics).toEqual([]);
  expect(summarizeDiagnostics(diagnostics)).toEqual({ valid: true, errors: 0, warnings: 0 });
});

test("bone names outside Blockbench's bone-rig charset are errors", () => {
  const diagnostics = validateGeckolibProject({ ...validFacts, boneNames: ["left arm", "tail-01", "ok_bone"] });
  expect(checkIds(diagnostics)).toEqual(["geckolib_bone_name_charset", "geckolib_bone_name_charset"]);
  expect(diagnostics[0]).toMatchObject({ severity: "error", target: "left arm" });
});

test("bones that differ only in case collide in GeckoLib's name-keyed map", () => {
  const diagnostics = validateGeckolibProject({ ...validFacts, boneNames: ["Head", "head", "body"] });
  expect(checkIds(diagnostics)).toEqual(["geckolib_duplicate_bone_names"]);
  expect(diagnostics[0].message).toContain('"head" duplicates "Head"');
});

test.each([
  [{ modid: null }, "geckolib_modid"],
  [{ modid: "My_Mod" }, "geckolib_modid"],
  [{ modid: "my mod" }, "geckolib_modid"],
  [{ identifier: null }, "geckolib_identifier"],
  [{ identifier: "MyEntity" }, "geckolib_identifier"],
  [{ identifier: "my entity" }, "geckolib_identifier"],
])("invalid metadata %p reports %s as an error", (override, checkId) => {
  const diagnostics = validateGeckolibProject({ ...validFacts, ...override });
  expect(checkIds(diagnostics)).toEqual([checkId]);
  expect(diagnostics[0].severity).toBe("error");
});

test("an identifier may be a resource path, which the mod namespace may not", () => {
  // The plugin sanitizes the object ID with the path charset (it becomes a file
  // name as well as geometry.<identifier>), but a modid is a namespace.
  expect(validateGeckolibProject({ ...validFacts, identifier: "entity/my_entity" })).toEqual([]);
  expect(checkIds(validateGeckolibProject({ ...validFacts, modid: "my/mod" }))).toEqual(["geckolib_modid"]);
});

test("armor models warn once per missing template bone", () => {
  const diagnostics = validateGeckolibProject({
    ...validFacts,
    boneNames: [...GECKOLIB_ARMOR_TEMPLATE_BONES].filter((bone) => bone !== "armorLeftBoot"),
    modelType: "Armor",
  });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    severity: "warning",
    check_id: "geckolib_armor_template",
    target: "armorLeftBoot",
  });
});

test("the armor rule only applies to Armor projects", () => {
  expect(validateGeckolibProject({ ...validFacts, modelType: "Entity", boneNames: ["body"] })).toEqual([]);
});

test("textures whose real size differs from the UV base warn per texture", () => {
  const diagnostics = validateGeckolibProject({
    ...validFacts,
    textureSizes: [
      { name: "skin", width: 64, height: 64 },
      { name: "overlay", width: 32, height: 64 },
    ],
  });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ check_id: "geckolib_texture_size_mismatch", target: "overlay" });
  expect(diagnostics[0].message).toContain("32x64");
});

test("texture checks are skipped when either size is unknown", () => {
  expect(validateGeckolibProject({ ...validFacts, declaredTextureSize: undefined })).toEqual([]);
  expect(validateGeckolibProject({ ...validFacts, textureSizes: [] })).toEqual([]);
});

test("a different plugin generation warns instead of silently trusting the rules", () => {
  const diagnostics = validateGeckolibProject({ ...validFacts, pluginVersion: "5.0.0" });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ severity: "warning", check_id: "geckolib_plugin_version_untested" });
  // Same generation and unknown versions stay quiet.
  expect(validateGeckolibProject({ ...validFacts, pluginVersion: "4.9.9" })).toEqual([]);
  expect(validateGeckolibProject({ ...validFacts, pluginVersion: null })).toEqual([]);
  expect(validateGeckolibProject({ ...validFacts, pluginVersion: "dev" })).toEqual([]);
});

/** Compiled animation content with one linear, eased keyframe. */
const validAnimations = {
  format_version: "1.8.0",
  animations: {
    "animation.model.idle": {
      loop: true,
      animation_length: 2,
      bones: {
        head: {
          rotation: {
            "0": { vector: [0, 0, 0] },
            "1.5": { vector: [0, 10, 0], easing: "easeOutBack", easingArgs: [1.5] },
          },
        },
      },
    },
  },
};

test("valid compiled animations report nothing", () => {
  expect(validateGeckolibAnimations(validAnimations)).toEqual([]);
});

test("documents without animations are not an error", () => {
  expect(validateGeckolibAnimations({ format_version: "1.8.0" })).toEqual([]);
});

test.each([[null], ["{}"], [42], [[]]])("non-object animation content %p is an envelope error", (parsed) => {
  const diagnostics = validateGeckolibAnimations(parsed);
  expect(checkIds(diagnostics)).toEqual(["geckolib_animation_envelope"]);
});

test("an animations entry that is not a name-keyed object is an envelope error", () => {
  expect(checkIds(validateGeckolibAnimations({ animations: [] }))).toEqual(["geckolib_animation_envelope"]);
});

test("loop values GeckoLib cannot resolve are errors", () => {
  const diagnostics = validateGeckolibAnimations({
    animations: { walk: { loop: "hold", bones: {} } },
  });
  expect(checkIds(diagnostics)).toEqual(["geckolib_animation_loop_value"]);
  expect(diagnostics[0].message).toContain("plays anything else once");
});

test.each(["loop", "play_once", "hold_on_last_frame", "true", "false"])("loop value %p is accepted", (loop) => {
  expect(validateGeckolibAnimations({ animations: { walk: { loop, bones: {} } } })).toEqual([]);
});

test("unknown easing names are errors because GeckoLib falls back to linear", () => {
  const diagnostics = validateGeckolibAnimations({
    animations: { walk: { bones: { head: { rotation: { "0.5": { vector: [0, 0, 0], easing: "easeInSmooth" } } } } } },
  });
  expect(checkIds(diagnostics)).toEqual(["geckolib_animation_easing_name"]);
  expect(diagnostics[0].target).toBe("walk / head.rotation at 0.5s");
});

test("malformed easingArgs are errors, and missing ones a warning", () => {
  const malformed = validateGeckolibAnimations({
    animations: { walk: { bones: { head: { rotation: { "0": { easing: "step", easingArgs: ["5"] } } } } } },
  });
  expect(checkIds(malformed)).toEqual(["geckolib_animation_easing_args"]);
  expect(malformed[0].severity).toBe("error");

  const missing = validateGeckolibAnimations({
    animations: { walk: { bones: { head: { rotation: { "0": { easing: "easeInBounce" } } } } } },
  });
  expect(checkIds(missing)).toEqual(["geckolib_animation_easing_args_missing"]);
  expect(missing[0].severity).toBe("warning");
});

test("an easing beside a non-linear lerp_mode warns that the easing is ignored", () => {
  const diagnostics = validateGeckolibAnimations({
    animations: {
      walk: { bones: { head: { rotation: { "0": { easing: "easeInQuad", lerp_mode: "catmullrom" } } } } },
    },
  });
  expect(checkIds(diagnostics)).toEqual(["geckolib_animation_easing_interpolation"]);
});

test("a channel Blockbench compressed to one keyframe is read as that keyframe", () => {
  // One timecode, one data point and non-catmullrom interpolation: the codec
  // drops the timestamp layer entirely. This is the common static-offset shape.
  const compressed = {
    animations: {
      walk: {
        animation_length: 1,
        bones: {
          body: { rotation: { vector: [0, 22.5, 0], easing: "easeInOutQuad" } },
          head: { position: { pre: [0, 0, 0], post: [0, 1, 0], easing: "easeOutBack", easingArgs: [1.2] } },
        },
      },
    },
  };
  expect(validateGeckolibAnimations(compressed)).toEqual([]);
});

test("a compressed channel's easing is still validated", () => {
  const diagnostics = validateGeckolibAnimations({
    animations: { walk: { bones: { body: { rotation: { vector: [0, 0, 0], easing: "easeInSmooth" } } } } },
  });
  expect(checkIds(diagnostics)).toEqual(["geckolib_animation_easing_name"]);
  expect(diagnostics[0].target).toBe("walk / body.rotation (single keyframe)");
});

test("a null easing means linear, not a malformed easing", () => {
  expect(
    validateGeckolibAnimations({
      animations: { walk: { bones: { body: { rotation: { "0": { vector: [0, 0, 0], easing: null } } } } } },
    })
  ).toEqual([]);
});

test("channel metadata keys are not mistaken for keyframe timestamps", () => {
  expect(
    validateGeckolibAnimations({
      animations: { walk: { bones: { head: { rotation: { lerp_mode: "linear", "0": { vector: [0, 0, 0] } } } } } },
    })
  ).toEqual([]);
});

test("non-numeric timestamps are errors", () => {
  const diagnostics = validateGeckolibAnimations({
    animations: { walk: { bones: { head: { rotation: { start: { vector: [0, 0, 0] } } } } } },
  });
  expect(checkIds(diagnostics)).toEqual(["geckolib_animation_keyframe_time"]);
});

test("keyframes past animation_length warn that playback is truncated", () => {
  const diagnostics = validateGeckolibAnimations({
    animations: {
      walk: { animation_length: 1, bones: { head: { rotation: { "0": {}, "2.5": {} } } } },
    },
  });
  expect(checkIds(diagnostics)).toEqual(["geckolib_animation_length_mismatch"]);
  expect(diagnostics[0].message).toContain("2.5s");
  // A keyframe exactly at the declared length is fine.
  expect(
    validateGeckolibAnimations({ animations: { walk: { animation_length: 2.5, bones: { head: { rotation: { "2.5": {} } } } } } })
  ).toEqual([]);
});

test("summaries split errors from warnings", () => {
  const diagnostics = validateGeckolibProject({ ...validFacts, modid: null, pluginVersion: "5.1.0" });
  expect(summarizeDiagnostics(diagnostics)).toEqual({ valid: false, errors: 1, warnings: 1 });
});
