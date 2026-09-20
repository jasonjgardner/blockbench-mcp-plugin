/// <reference types="three" />
/// <reference types="blockbench-types" />

/**
 * MCP tools for the GeckoLib Blockbench plugin.
 *
 * All tools except `geckolib_list_easings` are gated on the GeckoLib plugin
 * being loaded and a `geckolib_model` project being active, so they appear in
 * `tools/list` only while they can actually run. Blockbench globals are read
 * inside `execute` so the documentation generator can import this module.
 *
 * @module
 */

import { createTool } from "@/lib/factories";
import {
  GECKOLIB_FORMAT_ID,
  GECKOLIB_MODEL_TYPE_PROPERTY,
  GECKOLIB_MODID_PROPERTY,
  assertGeckolibFormat,
  compileGeckolibAnimationFile,
  compileGeckolibGeometry,
  getGeckolibFilepathCache,
  getGeckolibIdentifier,
  getGeckolibModelType,
  getGeckolibModid,
  getGeckolibPluginVersion,
  getProjectBoneNames,
  type IGeckolibKeyframe,
} from "@/lib/geckolib";
import {
  GECKOLIB_EASING_DEFAULT,
  GECKOLIB_EASING_NAMES,
  getEasingArgDefault,
  getEasingArgDescription,
  isArgsEasing,
  normalizeEasingArgs,
  reverseEasing,
} from "@/lib/geckolib-easing";
import { buildGeckolibDisplaySettings } from "@/lib/geckolib-display";
import {
  summarizeDiagnostics,
  validateGeckolibAnimations,
  validateGeckolibProject,
  type IGeckolibDiagnostic,
} from "@/lib/geckolib-validate";
import { findGroupOrThrow } from "@/lib/util";
import { runUndoableAnimationEdit } from "@/lib/animation-undo";
import { KEYFRAME_TIME_EPSILON, TRANSFORM_CHANNELS, findAnimationOrSelected, getAnimationClass } from "./animation/shared";
import {
  CLEAR_EASING,
  geckolibEmptyParameters,
  geckolibExportAnimationsParameters,
  geckolibExportDisplayParameters,
  geckolibExportModelParameters,
  geckolibGetKeyframeEasingParameters,
  geckolibReverseKeyframeEasingParameters,
  geckolibSetKeyframeEasingParameters,
  geckolibSetProjectSettingsParameters,
  geckolibValidateModelParameters,
} from "./geckolib/schemas";
import { geckolibToolDocs } from "./geckolib/docs";

export { geckolibToolDocs } from "./geckolib/docs";
export {
  geckolibEmptyParameters,
  geckolibExportAnimationsParameters,
  geckolibExportDisplayParameters,
  geckolibExportModelParameters,
  geckolibGetKeyframeEasingParameters,
  geckolibReverseKeyframeEasingParameters,
  geckolibSetKeyframeEasingParameters,
  geckolibSetProjectSettingsParameters,
  geckolibValidateModelParameters,
} from "./geckolib/schemas";

// ============================================================================
// Keyframe targeting
// ============================================================================

/** One targeted keyframe with the labels a result reports it under. */
interface IEasingTarget {
  animation: BBAnimation;
  /** Animator UUID, which groups keyframes even when two bones share a name. */
  animatorId: string;
  bone: string;
  channel: string;
  /** `true` when no earlier keyframe exists on this channel, making an easing inert. */
  first: boolean;
  keyframe: IGeckolibKeyframe;
}

/** Requested keyframe target, shared by the easing tools. */
interface IKeyframeTargetInput {
  animation_id?: string;
  bone_name?: string;
  channel?: string;
  times?: number[];
}

/** Whether a keyframe is the earliest on its own channel. */
function isFirstInChannel(keyframe: IGeckolibKeyframe, siblings: readonly IGeckolibKeyframe[]): boolean {
  return !siblings.some((sibling) => sibling.time < keyframe.time);
}

/**
 * Targets the current timeline selection.
 *
 * Effect keyframes (sound, particle, timeline) are dropped: they are selectable
 * alongside transform keyframes and default to linear interpolation, so they
 * would otherwise be written to and counted while GeckoLib never reads them.
 */
function resolveSelectedTargets(): IEasingTarget[] {
  // @ts-ignore - Timeline is a Blockbench global
  const selected = (typeof Timeline === "undefined" ? [] : Timeline.selected ?? []) as IGeckolibKeyframe[];
  if (!selected.length) {
    throw new Error(
      "No keyframes are selected. Select keyframes in the timeline, or pass bone_name and channel to target them directly."
    );
  }
  const transforms = selected.filter((keyframe) => TRANSFORM_CHANNELS.includes(keyframe.channel as never));
  if (!transforms.length) {
    throw new Error(
      `The selection holds no transform keyframes. GeckoLib easings apply to ${TRANSFORM_CHANNELS.join(", ")} keyframes only.`
    );
  }
  return transforms.map(describeKeyframe);
}

/** Describes a keyframe through its animator, which owns the bone name and animation. */
function describeKeyframe(keyframe: IGeckolibKeyframe): IEasingTarget {
  // @ts-ignore - blockbench-types omits GeneralAnimator.animation and uuid, which exist at runtime
  const animator = keyframe.animator as { animation: BBAnimation; name?: string; uuid?: string } | undefined;
  if (!animator?.animation) {
    throw new Error("A targeted keyframe is not attached to an animation; reselect the keyframes and retry.");
  }
  const siblings = ((animator as unknown as Record<string, IGeckolibKeyframe[]>)[keyframe.channel] ?? []) as IGeckolibKeyframe[];
  return {
    animation: animator.animation,
    animatorId: animator.uuid ?? animator.name ?? "unknown",
    bone: animator.name ?? "unknown",
    channel: keyframe.channel,
    first: isFirstInChannel(keyframe, siblings),
    keyframe,
  };
}

/** Targets one bone channel, optionally narrowed to specific times. */
function resolveBoneTargets(input: IKeyframeTargetInput): IEasingTarget[] {
  const animation = findAnimationOrSelected(input.animation_id);
  if (!animation) throw new Error("No animation found or selected.");
  const group = findGroupOrThrow(input.bone_name as string);
  const channel = input.channel as string;
  const animator = animation.animators[group.uuid] as unknown as Record<string, unknown> | undefined;
  const frames = ((animator?.[channel] as IGeckolibKeyframe[] | undefined) ?? []) as IGeckolibKeyframe[];
  const describe = (keyframe: IGeckolibKeyframe): IEasingTarget => ({
    animation,
    animatorId: (animator?.uuid as string | undefined) ?? group.uuid,
    bone: group.name,
    channel,
    first: isFirstInChannel(keyframe, frames),
    keyframe,
  });
  if (!input.times) {
    if (!frames.length) {
      throw new Error(`Bone "${group.name}" has no ${channel} keyframes in animation "${animation.name}".`);
    }
    return frames.map(describe);
  }
  return input.times.map((time) => {
    const frame = frames.find((candidate) => Math.abs(candidate.time - time) < KEYFRAME_TIME_EPSILON);
    if (!frame) {
      throw new Error(
        `No ${channel} keyframe exists at ${time}s for bone "${group.name}" in animation "${animation.name}"; no easings changed.`
      );
    }
    return describe(frame);
  });
}

/** Resolves the keyframes a request targets before any edit begins. */
function resolveEasingTargets(input: IKeyframeTargetInput): IEasingTarget[] {
  if (!input.bone_name) return resolveSelectedTargets();
  return resolveBoneTargets(input);
}

/** Reports a keyframe's easing state, including the argument GeckoLib would default to. */
function reportTarget(target: IEasingTarget): Record<string, unknown> {
  const { keyframe } = target;
  const easing = keyframe.easing ?? null;
  return {
    animation: target.animation.name,
    bone: target.bone,
    channel: target.channel,
    time: keyframe.time,
    interpolation: keyframe.interpolation,
    easing,
    easing_args: keyframe.easingArgs ?? null,
    takes_args: easing ? isArgsEasing(easing) : false,
    default_arg: easing ? getEasingArgDefault(easing) : null,
    // GeckoLib reads the easing of the keyframe a segment arrives at, so an
    // easing on the earliest keyframe of a channel is never applied.
    inert: target.first,
  };
}

/**
 * The distinct animations a target set belongs to.
 *
 * This is the only undo aspect these tools pass. The `keyframes` aspect would
 * look more precise but is tagged with `Animation.selected` and, on restore,
 * re-adds unknown UUIDs into that animation — so editing a non-selected
 * animation can materialize a phantom keyframe in the wrong one. It is also
 * dropped entirely outside Animate mode. The `animations` aspect round-trips
 * easings correctly through the plugin's patched `Keyframe.getUndoCopy`.
 */
function targetAnimations(targets: readonly IEasingTarget[]): BBAnimation[] {
  return [...new Set(targets.map((target) => target.animation))];
}

/**
 * Rejects easings that GeckoLib would discard.
 *
 * The plugin wipes `easing` and `easingArgs` from any keyframe whose
 * interpolation is not linear on the next render frame, so writing one onto a
 * catmullrom, step or bezier keyframe silently disappears.
 */
function assertEasingApplies(targets: readonly IEasingTarget[], convert: boolean): void {
  if (convert) return;
  const blocked = targets.filter(
    (target) => target.keyframe.interpolation && target.keyframe.interpolation !== "linear"
  );
  if (!blocked.length) return;
  const listed = blocked
    .slice(0, 5)
    .map((target) => `${target.bone}.${target.channel} at ${target.keyframe.time}s (${target.keyframe.interpolation})`)
    .join(", ");
  throw new Error(
    `GeckoLib discards easings on non-linear keyframes; ${blocked.length} targeted keyframe(s) use another interpolation: ${listed}. Pass convert_interpolation=true to set them to linear, or target only linear keyframes.`
  );
}

// ============================================================================
// Export delivery
// ============================================================================

/** How an export tool should deliver its content. */
interface IExportDelivery {
  mode: "compile" | "dialog";
  path?: string;
  max_content_length: number;
}

/** A plugin-registered export action, whose `trigger` blockbench-types omits. */
interface IExportAction {
  trigger: () => boolean | undefined;
}

/**
 * Triggers one of the GeckoLib plugin's own export actions.
 *
 * `Action.trigger()` re-checks the action's own condition and returns `false`
 * when it is not met, which is the authoritative availability answer.
 */
function triggerPluginExport(actionId: string, label: string): string {
  // @ts-ignore - BarItems is a Blockbench global
  const registry = typeof BarItems === "undefined" ? undefined : (BarItems as unknown as Record<string, IExportAction | undefined>);
  const action = registry?.[actionId];
  if (!action || typeof action.trigger !== "function") {
    throw new Error(
      `The GeckoLib plugin's "${actionId}" action is unavailable. Install or update the GeckoLib plugin, or use mode='compile'.`
    );
  }
  if (action.trigger() === false) {
    throw new Error(
      `The GeckoLib plugin refused the "${actionId}" action for this project (${label} may not apply to this model type). Use mode='compile' to compile the content anyway.`
    );
  }
  return JSON.stringify({
    mode: "dialog",
    action: actionId,
    triggered: true,
    note: "Blockbench opened its native save dialog. The user must choose a location; this tool does not wait for that and returns no content.",
  });
}

/** Writes export content to disk through Blockbench's permission-checked fs access. */
function writeExportFile(path: string, content: string, label: string): string {
  // @ts-ignore - requireNativeModule is a Blockbench global
  const fs = requireNativeModule("fs", {
    message: `MCP ${label} requested write access to save to ${path}`,
  });
  if (!fs) {
    throw new Error("File system access was denied. Omit `path` to receive the content in the response instead.");
  }
  fs.writeFileSync(path, content);
  return path;
}

/**
 * Delivers compiled export content: optionally to disk, then back to the client
 * within the requested size budget.
 *
 * @param label - Tool name used in permission prompts and messages.
 * @param delivery - Requested mode, path and content budget.
 * @param build - Compiles the content; only called in compile mode.
 * @param extra - Additional metadata merged into the result, such as the host
 *   API the content came from.
 */
function deliverExport(
  label: string,
  delivery: IExportDelivery,
  build: () => unknown,
  extra: Record<string, unknown> = {}
): string {
  const compiled = build();
  const content = typeof compiled === "string" ? compiled : JSON.stringify(compiled, null, 2);
  const wrote_to_path = delivery.path ? writeExportFile(delivery.path, content, label) : null;
  const omitted = delivery.max_content_length === 0;
  const truncated = !omitted && content.length > delivery.max_content_length;
  return JSON.stringify({
    ...extra,
    mode: "compile",
    byte_length: Buffer.byteLength(content, "utf8"),
    content_omitted: omitted,
    truncated,
    wrote_to_path,
    content: omitted ? null : truncated ? content.slice(0, delivery.max_content_length) : content,
  });
}

/** Resolves requested animations by UUID or name, or every animation. */
function resolveAnimations(animationIds?: readonly string[]): BBAnimation[] {
  const all = getAnimationClass().all ?? [];
  if (!animationIds) return [...all];
  return animationIds.map((id) => {
    const animation = all.find((candidate) => candidate.uuid === id || candidate.name === id);
    if (!animation) throw new Error(`No animation matches "${id}".`);
    return animation;
  });
}

/** The active project, or a thrown error naming the tool's requirement. */
function requireProject(): ModelProject {
  // @ts-ignore - Project is a Blockbench global
  if (typeof Project === "undefined" || !Project) throw new Error("No project is open.");
  // @ts-ignore - Project is a Blockbench global
  return Project as ModelProject;
}

// ============================================================================
// Registration
// ============================================================================

/** Registers the two read-only project tools. */
function registerProjectTools(): void {
  createTool(
    geckolibToolDocs[0].name,
    {
      ...geckolibToolDocs[0],
      parameters: geckolibEmptyParameters,
      async execute() {
        assertGeckolibFormat();
        const project = requireProject();
        const bones = getProjectBoneNames();
        return JSON.stringify({
          format: GECKOLIB_FORMAT_ID,
          plugin_version: getGeckolibPluginVersion(),
          model_type: getGeckolibModelType(),
          modid: getGeckolibModid(),
          model_identifier: getGeckolibIdentifier(),
          bone_count: bones.length,
          bones,
          animation_count: (getAnimationClass().all ?? []).length,
          texture_size: [project.texture_width, project.texture_height],
          box_uv: project.box_uv,
          export_paths: getGeckolibFilepathCache(),
          easing_support: {
            names: GECKOLIB_EASING_NAMES.length,
            note: "GeckoLib easings apply only to linear keyframes and shape the segment arriving at the keyframe. Use geckolib_list_easings for the full set.",
          },
        });
      },
    },
    geckolibToolDocs[0].status
  );

  createTool(
    geckolibToolDocs[1].name,
    {
      ...geckolibToolDocs[1],
      parameters: geckolibSetProjectSettingsParameters,
      async execute({ modid, model_type, model_identifier }) {
        assertGeckolibFormat();
        const project = requireProject() as unknown as Record<string, unknown>;
        if (modid !== undefined) project[GECKOLIB_MODID_PROPERTY] = modid;
        if (model_type !== undefined) project[GECKOLIB_MODEL_TYPE_PROPERTY] = model_type;
        if (model_identifier !== undefined) project.model_identifier = model_identifier;
        project.saved = false;
        // The plugin's handler re-reads the project rather than the payload, but
        // it is keyed by property name so a future version reads it correctly.
        // Dispatching matters: the handler refreshes display mode and forces
        // Item models onto the builtin/entity parent.
        // @ts-ignore - Blockbench is a Blockbench global
        Blockbench.dispatchEvent("update_project_settings", {
          [GECKOLIB_MODID_PROPERTY]: modid,
          [GECKOLIB_MODEL_TYPE_PROPERTY]: model_type,
          model_identifier,
        });
        return JSON.stringify({
          model_type: getGeckolibModelType(),
          modid: getGeckolibModid(),
          model_identifier: getGeckolibIdentifier(),
          notes:
            model_type === "Armor"
              ? [
                "The model type was recorded, but the plugin's armor template rig is only generated when creating a new Armor project in Blockbench. Run geckolib_validate_model to see which template bones are missing.",
              ]
              : [],
        });
      },
    },
    geckolibToolDocs[1].status
  );
}

/** Registers the easing catalogue and the three keyframe easing tools. */
function registerEasingTools(): void {
  createTool(
    geckolibToolDocs[2].name,
    {
      ...geckolibToolDocs[2],
      parameters: geckolibEmptyParameters,
      async execute() {
        return JSON.stringify({
          default: GECKOLIB_EASING_DEFAULT,
          clear_value: CLEAR_EASING,
          count: GECKOLIB_EASING_NAMES.length,
          easings: GECKOLIB_EASING_NAMES.map((easing) => ({
            name: easing,
            takes_args: isArgsEasing(easing),
            default_arg: getEasingArgDefault(easing),
            arg: getEasingArgDescription(easing),
          })),
          notes: [
            "An easing set on a keyframe shapes the segment arriving at that keyframe, so the first keyframe of a channel has no use for one.",
            "GeckoLib discards easings on keyframes whose interpolation is not linear.",
          ],
        });
      },
    },
    geckolibToolDocs[2].status
  );

  createTool(
    geckolibToolDocs[3].name,
    {
      ...geckolibToolDocs[3],
      parameters: geckolibGetKeyframeEasingParameters,
      async execute(input) {
        assertGeckolibFormat();
        const targets = resolveEasingTargets(input);
        return JSON.stringify({ count: targets.length, keyframes: targets.map(reportTarget) });
      },
    },
    geckolibToolDocs[3].status
  );

  createTool(
    geckolibToolDocs[4].name,
    {
      ...geckolibToolDocs[4],
      parameters: geckolibSetKeyframeEasingParameters,
      async execute({ easing, easing_args, convert_interpolation, ...target }) {
        assertGeckolibFormat();
        const resolved = resolveEasingTargets(target);
        const clearing = easing === CLEAR_EASING;
        const args = clearing ? undefined : normalizeEasingArgs(easing, easing_args);
        // Clearing is normalization, so it may touch a first keyframe; writing an
        // easing there would be dead data GeckoLib never reads.
        const targets = clearing ? resolved : resolved.filter((entry) => !entry.first);
        const skipped = resolved.filter((entry) => entry.first && !clearing);
        if (!targets.length) {
          throw new Error(
            `Every targeted keyframe is the first on its channel, where GeckoLib never reads an easing. Target a later keyframe, or pass easing="${CLEAR_EASING}" to clear one.`
          );
        }
        assertEasingApplies(targets, convert_interpolation || clearing);
        const converted = targets.filter((entry) => entry.keyframe.interpolation !== "linear");

        runUndoableAnimationEdit(
          { animations: targetAnimations(targets) },
          clearing ? "Clear GeckoLib keyframe easing" : `Set GeckoLib easing ${easing}`,
          () => {
            targets.forEach(({ keyframe }) => {
              if (!clearing && keyframe.interpolation !== "linear") keyframe.interpolation = "linear";
              keyframe.easing = clearing ? undefined : easing;
              keyframe.easingArgs = args;
            });
            // @ts-ignore - Animator is a Blockbench global
            Animator.preview();
          }
        );

        return JSON.stringify({
          easing: clearing ? null : easing,
          easing_args: args ?? null,
          converted_to_linear: converted.length,
          count: targets.length,
          skipped_first_keyframes: skipped.map((entry) => ({
            bone: entry.bone,
            channel: entry.channel,
            time: entry.keyframe.time,
          })),
          keyframes: targets.map(reportTarget),
        });
      },
    },
    geckolibToolDocs[4].status
  );

  createTool(
    geckolibToolDocs[5].name,
    {
      ...geckolibToolDocs[5],
      parameters: geckolibReverseKeyframeEasingParameters,
      async execute(input) {
        assertGeckolibFormat();
        const targets = resolveEasingTargets(input);
        const byChannel = new Map<string, IEasingTarget[]>();
        targets.forEach((target) => {
          // Grouped by animator UUID, not bone name: duplicate bone names are a
          // real GeckoLib error this tool must not silently merge.
          const key = `${target.animation.uuid}/${target.animatorId}/${target.channel}`;
          byChannel.set(key, [...(byChannel.get(key) ?? []), target]);
        });

        runUndoableAnimationEdit(
          { animations: targetAnimations(targets) },
          "Reverse GeckoLib keyframe easing",
          () => {
            byChannel.forEach((channelTargets) => {
              const ordered = channelTargets.toSorted((a, b) => a.keyframe.time - b.keyframe.time);
              // Snapshot first: the shift reads each keyframe's original easing.
              const reversed = ordered.map(({ keyframe }) => ({
                easing: reverseEasing(keyframe.easing ?? undefined),
                easingArgs: keyframe.easingArgs,
              }));
              ordered.forEach(({ keyframe }, index) => {
                const source = index === 0 ? undefined : reversed[index - 1];
                keyframe.easing = source?.easing;
                keyframe.easingArgs = source?.easingArgs;
              });
            });
            // @ts-ignore - Animator is a Blockbench global
            Animator.preview();
          }
        );

        return JSON.stringify({
          count: targets.length,
          channels: byChannel.size,
          keyframes: targets.map(reportTarget),
        });
      },
    },
    geckolibToolDocs[5].status
  );
}

/** Registers validation. */
function registerValidationTool(): void {
  createTool(
    geckolibToolDocs[6].name,
    {
      ...geckolibToolDocs[6],
      parameters: geckolibValidateModelParameters,
      async execute({ include_animations }) {
        assertGeckolibFormat();
        const project = requireProject();
        const textures = project.textures ?? [];
        const diagnostics: IGeckolibDiagnostic[] = [
          ...validateGeckolibProject({
            boneNames: getProjectBoneNames(),
            modid: getGeckolibModid(),
            identifier: getGeckolibIdentifier(),
            modelType: getGeckolibModelType(),
            declaredTextureSize: { width: project.texture_width, height: project.texture_height },
            textureSizes: textures.map((texture) => ({
              name: texture.name,
              width: texture.width,
              height: texture.height,
            })),
            pluginVersion: getGeckolibPluginVersion(),
          }),
        ];

        const animations = getAnimationClass().all ?? [];
        const checkedAnimations = include_animations && animations.length > 0;
        if (checkedAnimations) {
          diagnostics.push(...validateGeckolibAnimations(compileGeckolibAnimationFile(animations).content));
        }

        return JSON.stringify({
          ...summarizeDiagnostics(diagnostics),
          diagnostics,
          scope: {
            project_metadata: true,
            bone_names: true,
            armor_template: getGeckolibModelType() === "Armor",
            textures: textures.length > 0,
            animations: checkedAnimations,
          },
          notes: [
            "Rules are derived from the GeckoLib Blockbench plugin and the GeckoLib 4 runtime's tolerances; no official schema exists.",
            "Passing these checks does not prove the model renders or animates correctly in game.",
          ],
        });
      },
    },
    geckolibToolDocs[6].status
  );
}

/** Registers the three export tools. */
function registerExportTools(): void {
  createTool(
    geckolibToolDocs[7].name,
    {
      ...geckolibToolDocs[7],
      parameters: geckolibExportModelParameters,
      async execute({ mode, path, max_content_length }) {
        assertGeckolibFormat();
        if (mode === "dialog") return triggerPluginExport("export_geckolib_model", "model export");
        return deliverExport(geckolibToolDocs[7].name, { mode, path, max_content_length }, compileGeckolibGeometry);
      },
    },
    geckolibToolDocs[7].status
  );

  createTool(
    geckolibToolDocs[8].name,
    {
      ...geckolibToolDocs[8],
      parameters: geckolibExportAnimationsParameters,
      async execute({ mode, path, max_content_length, animation_ids }) {
        assertGeckolibFormat();
        if (mode === "dialog") return triggerPluginExport("export_geckolib_animations", "animation export");
        const animations = resolveAnimations(animation_ids);
        if (!animations.length) throw new Error("The project has no animations to export.");
        const compiled = compileGeckolibAnimationFile(animations);
        return deliverExport(
          geckolibToolDocs[8].name,
          { mode, path, max_content_length },
          () => compiled.content,
          {
            compiled_via: compiled.via,
            animations: animations.map((animation) => animation.name),
            ...(compiled.via === "animation_codec"
              ? {
                note: "This host no longer exposes Animator.buildFile, so the GeckoLib plugin's export patch did not run: the content may lack geckolib_format_version and resolve bezier keyframes differently. Per-keyframe easings are unaffected.",
              }
              : {}),
          }
        );
      },
    },
    geckolibToolDocs[8].status
  );

  createTool(
    geckolibToolDocs[9].name,
    {
      ...geckolibToolDocs[9],
      parameters: geckolibExportDisplayParameters,
      async execute({ mode, path, max_content_length }) {
        assertGeckolibFormat();
        if (mode === "dialog") return triggerPluginExport("export_geckolib_display", "display settings export");
        const project = requireProject();
        const modelType = getGeckolibModelType();
        const shipsDisplaySettings =
          modelType === "Item" ||
          modelType === "Block" ||
          Object.keys(project.display_settings ?? {}).length > 0;
        return deliverExport(
          geckolibToolDocs[9].name,
          { mode, path, max_content_length },
          () => buildGeckolibDisplaySettings(project),
          {
            model_type: modelType,
            ...(shipsDisplaySettings
              ? {}
              : {
                note: `The plugin only offers this export for Item and Block models or projects with display transforms; this project is ${modelType ?? "of an unset type"} and has none, so the content is a bare parent model.`,
              }),
          }
        );
      },
    },
    geckolibToolDocs[9].status
  );
}

/**
 * Registers every GeckoLib tool. Definitions stay registered so their native
 * conditions can enable them when the GeckoLib plugin loads after MCP, and
 * disable them again when it is unloaded.
 */
export function registerGeckolibTools(): void {
  registerProjectTools();
  registerEasingTools();
  registerValidationTool();
  registerExportTools();
}
