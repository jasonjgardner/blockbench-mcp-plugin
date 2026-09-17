/**
 * Public contracts for every GeckoLib tool, free of Blockbench runtime globals
 * so the documentation generator can import them outside Blockbench.
 *
 * Registration reads these entries by index, so the order is part of the
 * contract: `[0]` get_format_info, `[1]` set_project_settings,
 * `[2]` list_easings, `[3]` get_keyframe_easing, `[4]` set_keyframe_easing,
 * `[5]` reverse_keyframe_easing, `[6]` validate_model, `[7]` export_model,
 * `[8]` export_animations, `[9]` export_display.
 *
 * @module
 */

import type { IToolSpec } from "@/lib/factories";
import { STATUS_EXPERIMENTAL } from "@/lib/constants";
import { GECKOLIB_FORMAT_ID, isGeckolibFormat, isGeckolibPluginInstalled } from "@/lib/geckolib";
import {
  geckolibEmptyParameters,
  geckolibExportAnimationsParameters,
  geckolibExportDisplayParameters,
  geckolibExportModelParameters,
  geckolibGetKeyframeEasingParameters,
  geckolibReverseKeyframeEasingParameters,
  geckolibSetKeyframeEasingParameters,
  geckolibSetProjectSettingsParameters,
  geckolibValidateModelParameters,
} from "./schemas";

/**
 * Native condition: the GeckoLib plugin is loaded and its format is active.
 * The `method` is only invoked while Blockbench evaluates availability, so no
 * global is read at import time.
 */
const GECKOLIB_CONDITION = {
  project: true,
  formats: [GECKOLIB_FORMAT_ID],
  method: () => isGeckolibPluginInstalled() && isGeckolibFormat(),
};

export const geckolibToolDocs: IToolSpec[] = [
  {
    name: "geckolib_get_format_info",
    condition: GECKOLIB_CONDITION,
    description:
      "Returns the active GeckoLib project's model type, mod ID, object ID, bone and animation counts, cached export paths, and the installed plugin version. Requires the GeckoLib plugin and a GeckoLib Animated Model project.",
    annotations: { title: "Get GeckoLib Format Info", readOnlyHint: true },
    parameters: geckolibEmptyParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "geckolib_set_project_settings",
    condition: GECKOLIB_CONDITION,
    description:
      "Sets the GeckoLib mod ID, model type and object ID on the active project. Values are validated against the plugin's namespace rules before anything is written. Does not generate the armor template rig.",
    annotations: { title: "Set GeckoLib Project Settings", destructiveHint: false },
    parameters: geckolibSetProjectSettingsParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "geckolib_list_easings",
    description:
      "Lists every easing name GeckoLib accepts on keyframes, which of them read easingArgs, and each argument's default and meaning. Needs no project, so it can be called while planning an animation.",
    annotations: { title: "List GeckoLib Easings", readOnlyHint: true },
    parameters: geckolibEmptyParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "geckolib_get_keyframe_easing",
    condition: GECKOLIB_CONDITION,
    description:
      "Reads the GeckoLib easing, easing arguments and interpolation of keyframes on one bone channel, or of the current timeline selection. An easing governs the segment arriving at its keyframe, so the first keyframe of a channel is reported as inert.",
    annotations: { title: "Get GeckoLib Keyframe Easing", readOnlyHint: true },
    parameters: geckolibGetKeyframeEasingParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "geckolib_set_keyframe_easing",
    condition: GECKOLIB_CONDITION,
    description:
      "Writes a GeckoLib easing (and its arguments) onto keyframes on one bone channel, or onto the current timeline selection, as one undoable edit. GeckoLib easings apply only to linear keyframes and shape the segment arriving at the keyframe they are set on, so the first keyframe of each channel is skipped and reported. Nothing in Blockbench's native keyframe API can author these.",
    annotations: { title: "Set GeckoLib Keyframe Easing", destructiveHint: false },
    parameters: geckolibSetKeyframeEasingParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "geckolib_reverse_keyframe_easing",
    condition: GECKOLIB_CONDITION,
    description:
      "Mirrors easing directions the way GeckoLib's own reverse-keyframes handler does: each easeIn becomes easeOut and back, the easings shift one keyframe later in time, and the first keyframe of each channel is cleared. Use after reversing keyframe values.",
    annotations: { title: "Reverse GeckoLib Keyframe Easing", destructiveHint: false },
    parameters: geckolibReverseKeyframeEasingParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "geckolib_validate_model",
    condition: GECKOLIB_CONDITION,
    description:
      "Checks the GeckoLib project against rules derived from the plugin and the GeckoLib runtime: bone-name charset and duplicates, mod ID and object ID validity, armor template bones, texture size against the UV base, and (optionally) compiled animation loop values, easing names, easing arguments and lengths. Each finding carries a stable check ID. Passing does not prove in-game correctness.",
    annotations: { title: "Validate GeckoLib Model", readOnlyHint: true },
    parameters: geckolibValidateModelParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "geckolib_export_model",
    condition: GECKOLIB_CONDITION,
    description:
      "Compiles the GeckoLib geometry the plugin's model export produces, returning it as JSON and optionally writing it to a path. Set mode='dialog' to trigger the plugin's own export action and its save dialog instead.",
    annotations: { title: "Export GeckoLib Model", destructiveHint: false, openWorldHint: true },
    parameters: geckolibExportModelParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "geckolib_export_animations",
    condition: GECKOLIB_CONDITION,
    description:
      "Compiles the project's animations into GeckoLib animation-file JSON, including the easing and easingArgs the plugin writes, and optionally writes it to a path. Reports which host API compiled it, since only the plugin-patched route stamps geckolib_format_version. Set mode='dialog' to trigger the plugin's own animation export action instead.",
    annotations: { title: "Export GeckoLib Animations", destructiveHint: false, openWorldHint: true },
    parameters: geckolibExportAnimationsParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "geckolib_export_display",
    condition: GECKOLIB_CONDITION,
    description:
      "Builds the Java item/block display-settings JSON for GeckoLib Item and Block models: parent model, texture size, GUI light, per-perspective display transforms and the namespaced particle texture. Reports when the active model type would not normally ship one. Set mode='dialog' to trigger the plugin's own display export action instead.",
    annotations: { title: "Export GeckoLib Display Settings", destructiveHint: false, openWorldHint: true },
    parameters: geckolibExportDisplayParameters,
    status: STATUS_EXPERIMENTAL,
  },
];
