import { beforeAll, beforeEach, expect, test } from "bun:test";
import { loadToolDefinitions, type IToolFixture } from "@/tests/helpers/tool-fixture";
import { useGlobals } from "@/tests/helpers/globals";
import { createUndoHost, type IUndoHost } from "@/tests/helpers/undo-host";
import { isRecord } from "@/tests/helpers/assertions";

interface IHostKeyframe {
  uuid: string;
  time: number;
  channel: string;
  interpolation: string;
  easing?: string;
  easingArgs?: number[];
  animator: IHostAnimator;
}

interface IHostAnimator {
  uuid: string;
  name: string;
  animation: IHostAnimation;
  rotation: IHostKeyframe[];
  position: IHostKeyframe[];
  scale: IHostKeyframe[];
}

interface IHostAnimation {
  uuid: string;
  name: string;
  animators: Record<string, IHostAnimator>;
}

/**
 * Snapshot of every keyframe's easing state in the animations being edited.
 *
 * The tools pass only the `animations` aspect, mirroring how Blockbench's own
 * `Animation.getUndoCopy` walks animators down to the GeckoLib-patched
 * `Keyframe.getUndoCopy`, so this host snapshots the same way.
 */
type Snapshot = readonly { frame: IHostKeyframe; easing?: string; easingArgs?: number[]; interpolation: string }[];

interface IAspects {
  animations?: IHostAnimation[];
  keyframes?: IHostKeyframe[];
}

const CHANNELS = ["rotation", "position", "scale"] as const;

let tools: IToolFixture;
let undo: IUndoHost<Snapshot, IAspects>;
let undoAspects: IAspects[];
let animation: IHostAnimation;
let frames: IHostKeyframe[];
let selection: IHostKeyframe[];
let previews: number;
let triggered: string[];
let actionAvailable: boolean;

const BODY_UUID = "group-body";

/** Compiled animation content both host compile routes return. */
const compiledAnimations = {
  format_version: "1.8.0",
  animations: {
    "animation.model.idle": {
      loop: "hold_on_last_frame",
      animation_length: 0.5,
      bones: { body: { rotation: { "0": { vector: [0, 0, 0] }, "1": { vector: [0, 10, 0] } } } },
    },
  },
};

/** Builds one bone animator with rotation keyframes at the given times. */
function createAnimation(times: readonly number[]): IHostAnimation {
  const host: IHostAnimation = { uuid: "anim-1", name: "animation.model.idle", animators: {} };
  const animator: IHostAnimator = {
    uuid: BODY_UUID,
    name: "body",
    animation: host,
    rotation: [],
    position: [],
    scale: [],
  };
  animator.rotation = times.map((time, index) => ({
    uuid: `kf-${index}`,
    time,
    channel: "rotation",
    interpolation: "linear",
    animator,
  }));
  host.animators[BODY_UUID] = animator;
  return host;
}

/** Captures the easing state of every keyframe in the snapshotted animations. */
function snapshotAnimations(aspects: IAspects): Snapshot {
  return (aspects.animations ?? []).flatMap((item) =>
    Object.values(item.animators).flatMap((animator) =>
      CHANNELS.flatMap((channel) =>
        animator[channel].map((frame) => ({
          frame,
          easing: frame.easing,
          easingArgs: frame.easingArgs,
          interpolation: frame.interpolation,
        }))
      )
    )
  );
}

beforeAll(async () => {
  tools = await loadToolDefinitions({ entries: ["server/tools/geckolib.ts"], register: ["registerGeckolibTools"] });
});

beforeEach(() => {
  animation = createAnimation([0, 0.5, 1]);
  frames = animation.animators[BODY_UUID].rotation;
  selection = [];
  previews = 0;
  triggered = [];
  actionAvailable = true;
  undoAspects = [];
  undo = createUndoHost<Snapshot, IAspects>({
    snapshot: (aspects) => {
      undoAspects.push(aspects);
      return snapshotAnimations(aspects);
    },
    restore: (target) => {
      target.forEach((entry) => {
        entry.frame.easing = entry.easing;
        entry.frame.easingArgs = entry.easingArgs;
        entry.frame.interpolation = entry.interpolation;
      });
    },
  });
});

useGlobals(() => ({
  Format: { id: "geckolib_model" },
  Plugins: { all: [{ id: "geckolib", version: "4.2.1" }], installed: [] },
  Project: {
    uuid: "project-1",
    name: "Model",
    texture_width: 64,
    texture_height: 64,
    box_uv: false,
    saved: true,
    parent: "",
    display_settings: {},
    textures: [{ name: "skin", width: 64, height: 64 }],
    geckolib_modid: "my_mod",
    geckolib_model_type: "Entity",
    model_identifier: "my_entity",
  },
  Group: { all: [{ uuid: BODY_UUID, name: "body" }] },
  Animation: {
    get all() {
      return [animation];
    },
    get selected() {
      return animation;
    },
  },
  Timeline: {
    get selected() {
      return selection;
    },
  },
  Animator: {
    preview: () => {
      previews += 1;
    },
    // The GeckoLib plugin patches buildFile, so this is the route that carries
    // its export patch; the host mirrors what the patched function returns.
    buildFile: () => ({ ...compiledAnimations, geckolib_format_version: 2 }),
  },
  AnimationCodec: { getCodec: () => ({ compileFile: () => compiledAnimations }) },
  Undo: {
    initEdit: (aspects: IAspects) => undo.initEdit(aspects),
    finishEdit: (message?: string, aspects?: IAspects) => undo.finishEdit(message, aspects),
    cancelEdit: (revert?: boolean) => undo.cancelEdit(revert),
  },
  Blockbench: { dispatchEvent: () => undefined },
  Codecs: { bedrock: { compile: () => ({ "minecraft:geometry": [{ bones: [{ name: "body" }] }] }) } },
  BarItems: {
    export_geckolib_model: {
      // Blockbench's Action.trigger re-checks its own condition and returns
      // false when it is not met.
      trigger: () => {
        if (!actionAvailable) return false;
        triggered.push("export_geckolib_model");
        return true;
      },
    },
  },
  DisplayMode: { slots: {} },
  settings: {},
}));

/** Parses a tool's JSON string result. */
async function call(name: string, input: unknown = {}): Promise<Record<string, unknown>> {
  const result = await tools.call(name, input);
  expect(result).toBeString();
  const parsed: unknown = JSON.parse(result as string);
  if (!isRecord(parsed)) throw new Error(`${name} did not return a JSON object.`);
  return parsed;
}

test("the easing catalogue needs no project and describes the argument-taking easings", async () => {
  const result = await call("geckolib_list_easings");
  expect(result.count).toBe(32);
  expect(result.clear_value).toBe("none");
  const easings = result.easings as { name: string; takes_args: boolean; default_arg: number | null }[];
  expect(easings.find((entry) => entry.name === "step")).toMatchObject({ takes_args: true, default_arg: 5 });
  expect(easings.find((entry) => entry.name === "easeInQuad")).toMatchObject({ takes_args: false, default_arg: null });
});

test("format info reports the project's GeckoLib metadata", async () => {
  const result = await call("geckolib_get_format_info");
  expect(result).toMatchObject({
    format: "geckolib_model",
    plugin_version: "4.2.1",
    model_type: "Entity",
    modid: "my_mod",
    model_identifier: "my_entity",
    bone_count: 1,
    animation_count: 1,
  });
});

test("every project tool refuses a non-GeckoLib project", async () => {
  Object.assign(globalThis, { Format: { id: "bedrock_block" } });
  await expect(call("geckolib_get_format_info")).rejects.toThrow("GeckoLib Animated Model format");
  await expect(
    tools.call("geckolib_set_keyframe_easing", { bone_name: "body", channel: "rotation", easing: "easeInQuad" })
  ).rejects.toThrow("GeckoLib Animated Model format");
  expect(undo.starts).toBe(0);
});

test("project settings are validated before anything is written", async () => {
  await expect(tools.call("geckolib_set_project_settings", { modid: "My_Mod" })).rejects.toThrow();
  await expect(tools.call("geckolib_set_project_settings", {})).rejects.toThrow("at least one");
  // @ts-ignore - the host project double stands in for the Blockbench global
  expect(Project.geckolib_modid).toBe("my_mod");
});

test("object IDs may carry a folder path, as the plugin's own sanitizer allows", async () => {
  const result = await call("geckolib_set_project_settings", { model_identifier: "entity/my_entity" });
  expect(result.model_identifier).toBe("entity/my_entity");
  // Mod IDs are namespaces, so they still may not contain a slash.
  await expect(tools.call("geckolib_set_project_settings", { modid: "my/mod" })).rejects.toThrow();
});

test("project settings write the plugin's own properties and flag the project unsaved", async () => {
  const result = await call("geckolib_set_project_settings", {
    modid: "other_mod",
    model_type: "Armor",
    model_identifier: "my_armor",
  });
  expect(result).toMatchObject({ modid: "other_mod", model_type: "Armor", model_identifier: "my_armor" });
  expect(result.notes).toHaveLength(1);
  // @ts-ignore - the host project double stands in for the Blockbench global
  expect(Project.saved).toBe(false);
});

test("setting an easing writes the plugin default argument in one undo entry", async () => {
  const result = await call("geckolib_set_keyframe_easing", {
    bone_name: "body",
    channel: "rotation",
    easing: "easeOutBack",
  });
  expect(result).toMatchObject({ easing: "easeOutBack", easing_args: [1], count: 2, converted_to_linear: 0 });
  expect(frames.map((frame) => frame.easing)).toEqual([undefined, "easeOutBack", "easeOutBack"]);
  expect(frames.map((frame) => frame.easingArgs)).toEqual([undefined, [1], [1]]);
  expect(undo.finishes).toBe(1);
  expect(undo.lastEdit?.message).toBe("Set GeckoLib easing easeOutBack");
  expect(previews).toBe(1);

  undo.undo();
  expect(frames.every((frame) => frame.easing === undefined)).toBe(true);
});

test("the first keyframe of a channel is skipped, because GeckoLib never reads its easing", async () => {
  const result = await call("geckolib_set_keyframe_easing", {
    bone_name: "body",
    channel: "rotation",
    easing: "easeInQuad",
  });
  expect(result.skipped_first_keyframes).toEqual([{ bone: "body", channel: "rotation", time: 0 }]);
  expect(frames[0].easing).toBeUndefined();

  // Targeting only the first keyframe is an error rather than a silent no-op.
  await expect(
    tools.call("geckolib_set_keyframe_easing", { bone_name: "body", channel: "rotation", times: [0], easing: "easeInQuad" })
  ).rejects.toThrow("first on its channel");
  expect(undo.finishes).toBe(1);
});

test("the undo aspects name only the animations, never the keyframes", async () => {
  // The keyframes aspect is tagged with Animation.selected and re-adds unknown
  // UUIDs on restore, so it can materialize a keyframe in the wrong animation.
  await call("geckolib_set_keyframe_easing", { bone_name: "body", channel: "rotation", easing: "easeInQuad" });
  // Blockbench snapshots the aspects twice per edit: before and after.
  expect(undoAspects).toHaveLength(2);
  undoAspects.forEach((aspects) => {
    expect(aspects.animations).toEqual([animation]);
    expect(aspects).not.toHaveProperty("keyframes");
    // runUndoableAnimationEdit adds its own full-restore marker alongside.
    expect(Object.keys(aspects).filter((key) => !key.startsWith("mcp_"))).toEqual(["animations"]);
  });
});

test("times narrow the edit to the named keyframes", async () => {
  const result = await call("geckolib_set_keyframe_easing", {
    bone_name: "body",
    channel: "rotation",
    times: [0.5],
    easing: "step",
    easing_args: [8.7],
  });
  expect(result).toMatchObject({ easing: "step", easing_args: [8] });
  expect(frames.map((frame) => frame.easing)).toEqual([undefined, "step", undefined]);
});

test("a requested time with no keyframe fails before the edit opens", async () => {
  await expect(
    tools.call("geckolib_set_keyframe_easing", { bone_name: "body", channel: "rotation", times: [2], easing: "linear" })
  ).rejects.toThrow("No rotation keyframe exists at 2s");
  expect(undo.starts).toBe(0);
});

test("easings are refused on keyframes GeckoLib would discard them from", async () => {
  frames[1].interpolation = "catmullrom";
  await expect(
    tools.call("geckolib_set_keyframe_easing", { bone_name: "body", channel: "rotation", easing: "easeInQuad" })
  ).rejects.toThrow("discards easings on non-linear keyframes");
  expect(undo.starts).toBe(0);

  const result = await call("geckolib_set_keyframe_easing", {
    bone_name: "body",
    channel: "rotation",
    easing: "easeInQuad",
    convert_interpolation: true,
  });
  expect(result.converted_to_linear).toBe(1);
  expect(frames.map((frame) => frame.interpolation)).toEqual(["linear", "linear", "linear"]);
});

test("clearing an easing needs no interpolation change and reaches the first keyframe", async () => {
  frames.forEach((frame) => {
    frame.easing = "easeInBounce";
    frame.easingArgs = [0.5];
    frame.interpolation = "bezier";
  });
  const result = await call("geckolib_set_keyframe_easing", { bone_name: "body", channel: "rotation", easing: "none" });
  expect(result).toMatchObject({ easing: null, easing_args: null, count: 3, skipped_first_keyframes: [] });
  expect(frames.map((frame) => frame.easing)).toEqual([undefined, undefined, undefined]);
  expect(frames.map((frame) => frame.easingArgs)).toEqual([undefined, undefined, undefined]);
  // The keyframes keep their own interpolation when only the easing is removed.
  expect(frames.map((frame) => frame.interpolation)).toEqual(["bezier", "bezier", "bezier"]);
});

test("omitting bone_name targets the timeline selection", async () => {
  selection = [frames[2]];
  const result = await call("geckolib_set_keyframe_easing", { easing: "easeInOutSine" });
  expect(result.count).toBe(1);
  expect(frames.map((frame) => frame.easing)).toEqual([undefined, undefined, "easeInOutSine"]);
  const reported = (result.keyframes as Record<string, unknown>[])[0];
  expect(reported).toMatchObject({
    animation: "animation.model.idle",
    bone: "body",
    channel: "rotation",
    time: 1,
    inert: false,
  });
});

test("effect keyframes in the selection are not mistaken for transform keyframes", async () => {
  const effect: IHostKeyframe = {
    uuid: "kf-sound",
    time: 0.25,
    channel: "sound",
    interpolation: "linear",
    animator: animation.animators[BODY_UUID],
  };
  selection = [effect, frames[1]];
  const result = await call("geckolib_set_keyframe_easing", { easing: "easeInQuad" });
  expect(result.count).toBe(1);
  expect(effect.easing).toBeUndefined();
  expect(frames[1].easing).toBe("easeInQuad");

  selection = [effect];
  await expect(tools.call("geckolib_set_keyframe_easing", { easing: "easeInQuad" })).rejects.toThrow(
    "no transform keyframes"
  );
});

test("an empty selection explains both ways to target keyframes", async () => {
  await expect(tools.call("geckolib_set_keyframe_easing", { easing: "linear" })).rejects.toThrow(
    "No keyframes are selected"
  );
});

test.each([
  [{ bone_name: "body", easing: "linear" }],
  [{ channel: "rotation", easing: "linear" }],
  [{ times: [0], easing: "linear" }],
])("incoherent target %p is rejected by the schema", async (input) => {
  await expect(tools.call("geckolib_set_keyframe_easing", input)).rejects.toThrow();
});

test("reading easings reports interpolation, the default GeckoLib would use, and inert frames", async () => {
  frames[1].easing = "easeInElastic";
  const result = await call("geckolib_get_keyframe_easing", { bone_name: "body", channel: "rotation" });
  expect(result.count).toBe(3);
  const reported = result.keyframes as Record<string, unknown>[];
  expect(reported[1]).toMatchObject({
    time: 0.5,
    interpolation: "linear",
    easing: "easeInElastic",
    easing_args: null,
    takes_args: true,
    default_arg: 1,
    inert: false,
  });
  expect(reported[0]).toMatchObject({ easing: null, takes_args: false, default_arg: null, inert: true });
});

test("a bone with no keyframes on the channel is reported, not silently empty", async () => {
  await expect(tools.call("geckolib_get_keyframe_easing", { bone_name: "body", channel: "scale" })).rejects.toThrow(
    "no scale keyframes"
  );
});

test("reversing mirrors directions and shifts them one keyframe later", async () => {
  frames[0].easing = "easeInQuad";
  frames[1].easing = "easeInOutCubic";
  frames[2].easing = "easeOutBack";
  frames[2].easingArgs = [2];

  const result = await call("geckolib_reverse_keyframe_easing", { bone_name: "body", channel: "rotation" });
  expect(result).toMatchObject({ count: 3, channels: 1 });
  expect(frames.map((frame) => frame.easing)).toEqual([undefined, "easeOutQuad", "easeInOutCubic"]);
  expect(frames.map((frame) => frame.easingArgs)).toEqual([undefined, undefined, undefined]);
  expect(undo.finishes).toBe(1);

  undo.undo();
  expect(frames.map((frame) => frame.easing)).toEqual(["easeInQuad", "easeInOutCubic", "easeOutBack"]);
});

test("reverse groups by animator, so two bones sharing a name do not merge", async () => {
  const twin: IHostAnimator = {
    uuid: "group-body-twin",
    name: "body",
    animation,
    rotation: [],
    position: [],
    scale: [],
  };
  twin.rotation = [
    { uuid: "twin-0", time: 0, channel: "rotation", interpolation: "linear", animator: twin },
    { uuid: "twin-1", time: 1, channel: "rotation", interpolation: "linear", easing: "easeInSine", animator: twin },
  ];
  animation.animators[twin.uuid] = twin;
  selection = [...frames, ...twin.rotation];

  const result = await call("geckolib_reverse_keyframe_easing", {});
  expect(result.channels).toBe(2);
  // Each animator shifts within itself: the twin's own easing moves nowhere
  // else, and its first keyframe is cleared.
  expect(twin.rotation.map((frame) => frame.easing)).toEqual([undefined, undefined]);
});

test("validation reports project and compiled-animation findings with check IDs", async () => {
  // @ts-ignore - the host project double stands in for the Blockbench global
  Project.geckolib_modid = "";
  const result = await call("geckolib_validate_model", {});
  expect(result).toMatchObject({ valid: false, errors: 1, warnings: 1 });
  const diagnostics = result.diagnostics as { check_id: string; severity: string }[];
  expect(diagnostics.map((finding) => finding.check_id)).toEqual([
    "geckolib_modid",
    "geckolib_animation_length_mismatch",
  ]);
  expect(result.scope).toMatchObject({ animations: true, armor_template: false });
});

test("animation checks can be skipped", async () => {
  const result = await call("geckolib_validate_model", { include_animations: false });
  expect(result).toMatchObject({ valid: true, errors: 0, warnings: 0 });
  expect(result.scope).toMatchObject({ animations: false });
});

test("model export compiles the geometry and honours the content budget", async () => {
  const result = await call("geckolib_export_model", { max_content_length: 20 });
  expect(result).toMatchObject({ mode: "compile", truncated: true, content_omitted: false, wrote_to_path: null });
  expect((result.content as string).length).toBe(20);
  expect(result.byte_length).toBeGreaterThan(20);

  const omitted = await call("geckolib_export_model", { max_content_length: 0 });
  expect(omitted).toMatchObject({ content: null, content_omitted: true, truncated: false });
});

test("animation export goes through the patched buildFile and names what it exported", async () => {
  const result = await call("geckolib_export_animations", {});
  expect(result).toMatchObject({
    mode: "compile",
    compiled_via: "animator_build_file",
    animations: ["animation.model.idle"],
  });
  expect(result.note).toBeUndefined();
  expect(JSON.parse(result.content as string)).toMatchObject({ geckolib_format_version: 2 });
  await expect(tools.call("geckolib_export_animations", { animation_ids: ["nope"] })).rejects.toThrow(
    'No animation matches "nope"'
  );
});

test("a host without the buildFile shim exports through the codec and says what is missing", async () => {
  Object.assign(globalThis, { Animator: { preview: () => undefined } });
  const result = await call("geckolib_export_animations", {});
  expect(result.compiled_via).toBe("animation_codec");
  expect(result.note).toContain("geckolib_format_version");
  expect(JSON.parse(result.content as string).geckolib_format_version).toBeUndefined();
});

test("dialog mode hands off to the plugin's own export action", async () => {
  const result = await call("geckolib_export_model", { mode: "dialog" });
  expect(result).toMatchObject({ mode: "dialog", action: "export_geckolib_model", triggered: true });
  expect(triggered).toEqual(["export_geckolib_model"]);

  // Action.trigger returning false is Blockbench's own availability answer.
  actionAvailable = false;
  await expect(tools.call("geckolib_export_model", { mode: "dialog" })).rejects.toThrow("refused");

  await expect(tools.call("geckolib_export_display", { mode: "dialog" })).rejects.toThrow("action is unavailable");
});

test("display settings compile the Java model envelope, flagging a model type that ships none", async () => {
  const result = await call("geckolib_export_display", {});
  expect(result.model_type).toBe("Entity");
  expect(result.note).toContain("Item and Block models");
  expect(JSON.parse(result.content as string)).toEqual({ parent: "builtin/entity", texture_size: [64, 64] });
});

test("an Item model's display export carries no caveat", async () => {
  // @ts-ignore - the host project double stands in for the Blockbench global
  Project.geckolib_model_type = "Item";
  const result = await call("geckolib_export_display", {});
  expect(result).toMatchObject({ model_type: "Item" });
  expect(result.note).toBeUndefined();
});
