/**
 * GeckoLib project and animation validation rules.
 *
 * No official GeckoLib schema exists, so every diagnostic carries a stable
 * `geckolib_*` check ID that can be traced back to the behavior it protects
 * against and re-verified against a newer release. Rules are derived from the
 * GeckoLib Blockbench plugin source (`src/ts/{codec,easing,events}.ts`,
 * plugin 4.2.x) and from the GeckoLib 4 runtime's tolerance for malformed
 * animation JSON.
 *
 * Portions of the rule set are adapted from `adhi-jp/minecraft-blockbench-mcp`
 * (`src/shared/geckolib-validate.ts`), used under the MIT License:
 *
 *     Copyright (c) 2026 adhi-jp
 *
 *     Permission is hereby granted, free of charge, to any person obtaining a
 *     copy of this software and associated documentation files (the
 *     "Software"), to deal in the Software without restriction, including
 *     without limitation the rights to use, copy, modify, merge, publish,
 *     distribute, sublicense, and/or sell copies of the Software, and to
 *     permit persons to whom the Software is furnished to do so, subject to
 *     the following conditions:
 *
 *     The above copyright notice and this permission notice shall be included
 *     in all copies or substantial portions of the Software.
 *
 *     THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 *     OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 *     MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 *     IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 *     CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 *     TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 *     SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * This module stays free of Blockbench globals: callers pass already-gathered
 * project facts and compiled animation JSON.
 *
 * @module
 */

import {
  GECKOLIB_ARMOR_TEMPLATE_BONES,
  GECKOLIB_BONE_NAME_PATTERN,
  GECKOLIB_NAMESPACE_PATTERN,
  GECKOLIB_PATH_PATTERN,
} from "./geckolib";
import { isArgsEasing, isGeckolibEasing } from "./geckolib-easing";

/** GeckoLib Blockbench plugin generation the rules were surveyed against. */
export const SURVEYED_GECKOLIB_PLUGIN_MAJOR = 4;

/** Severity of a validation finding. `error` blocks a working export. */
export type GeckolibSeverity = "error" | "warning";

/** One validation finding, traceable through its stable check ID. */
export interface IGeckolibDiagnostic {
  severity: GeckolibSeverity;
  /** Stable `geckolib_*` identifier for the rule that produced this finding. */
  check_id: string;
  message: string;
  /** Bone, animation, or value the finding is about, when one applies. */
  target?: string;
}

/** Project facts the project-level rules are evaluated against. */
export interface IGeckolibProjectFacts {
  boneNames: readonly string[];
  modid: string | null;
  identifier: string | null;
  modelType: string | null;
  /** Declared project UV resolution. */
  declaredTextureSize?: { width: number; height: number };
  /** Actual pixel size of each assigned texture. */
  textureSizes?: readonly { name: string; width: number; height: number }[];
  pluginVersion?: string | null;
}

/** Loop values the GeckoLib 4 runtime resolves; anything else plays once. */
const ACCEPTED_LOOP_VALUES: readonly unknown[] = [
  true,
  false,
  "loop",
  "true",
  "false",
  "play_once",
  "hold_on_last_frame",
];

/** Keys inside a channel map that hold metadata rather than a timestamp. */
const CHANNEL_METADATA_KEYS = ["easing", "easingArgs", "lerp_mode"];

/**
 * Keys that identify a keyframe's own value payload.
 *
 * Blockbench's Bedrock animation codec compresses a channel to the bare
 * keyframe when it holds one timecode with one data point and non-catmullrom
 * interpolation, and GeckoLib's keyframe compiler returns an object there. The
 * channel then looks like `{ vector: [...], easing: ... }` with no timestamp
 * key at all, which a naive timestamp walk would misread as a keyframe named
 * "vector". Single-keyframe channels are common (a static bone offset), so
 * this is the normal shape, not an edge case.
 */
const KEYFRAME_VALUE_KEYS = ["vector", "pre", "post"];

function diagnostic(
  severity: GeckolibSeverity,
  check_id: string,
  message: string,
  target?: string
): IGeckolibDiagnostic {
  if (target === undefined) return { severity, check_id, message };
  return { severity, check_id, message, target };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks one bone name for charset violations and case-insensitive clashes. */
function checkBoneName(name: string, seen: Map<string, string>): IGeckolibDiagnostic[] {
  const findings: IGeckolibDiagnostic[] = [];
  if (!GECKOLIB_BONE_NAME_PATTERN.test(name)) {
    findings.push(
      diagnostic(
        "error",
        "geckolib_bone_name_charset",
        `Bone name "${name}" uses characters outside a-z, A-Z, 0-9 and _, which Blockbench bone-rig formats and GeckoLib's geometry loader both reject.`,
        name
      )
    );
  }
  const folded = name.toLowerCase();
  const existing = seen.get(folded);
  if (existing === undefined) {
    seen.set(folded, name);
    return findings;
  }
  return [
    ...findings,
    diagnostic(
      "error",
      "geckolib_duplicate_bone_names",
      `Bone name "${name}" duplicates "${existing}"; GeckoLib keys bones by name, so only the last one survives loading.`,
      name
    ),
  ];
}

/** Checks the mod namespace and object ID that feed export paths and geometry IDs. */
function checkIdentifiers(facts: IGeckolibProjectFacts): IGeckolibDiagnostic[] {
  const findings: IGeckolibDiagnostic[] = [];
  if (!facts.modid) {
    findings.push(
      diagnostic("error", "geckolib_modid", "The project has no geckolib_modid; GeckoLib exports need a mod namespace.")
    );
  }
  if (facts.modid && !GECKOLIB_NAMESPACE_PATTERN.test(facts.modid)) {
    findings.push(
      diagnostic(
        "error",
        "geckolib_modid",
        `geckolib_modid "${facts.modid}" must match ${GECKOLIB_NAMESPACE_PATTERN.source} (lowercase letters, digits, _, - and .).`,
        facts.modid
      )
    );
  }
  if (!facts.identifier) {
    findings.push(
      diagnostic(
        "error",
        "geckolib_identifier",
        "The project has no model identifier; the geometry would export as geometry.unknown."
      )
    );
  }
  // The identifier feeds file names as well as `geometry.<identifier>`, so the
  // plugin sanitizes it with the resource-path charset, which permits a folder
  // separator the mod namespace does not.
  if (facts.identifier && !GECKOLIB_PATH_PATTERN.test(facts.identifier)) {
    findings.push(
      diagnostic(
        "error",
        "geckolib_identifier",
        `Model identifier "${facts.identifier}" must match ${GECKOLIB_PATH_PATTERN.source}.`,
        facts.identifier
      )
    );
  }
  return findings;
}

/** Warns about armor rigs that dropped a template bone GeckoLib binds to. */
function checkArmorTemplate(facts: IGeckolibProjectFacts): IGeckolibDiagnostic[] {
  if (facts.modelType !== "Armor") return [];
  const present = new Set(facts.boneNames);
  return GECKOLIB_ARMOR_TEMPLATE_BONES.filter((bone) => !present.has(bone)).map((bone) =>
    diagnostic(
      "warning",
      "geckolib_armor_template",
      `Armor models need the template bone "${bone}"; GeckoLib's armor renderer binds each slot to the template rig.`,
      bone
    )
  );
}

/** Warns when a texture's real size does not match the UV base the model uses. */
function checkTextureSizes(facts: IGeckolibProjectFacts): IGeckolibDiagnostic[] {
  const declared = facts.declaredTextureSize;
  if (!declared || !facts.textureSizes?.length) return [];
  return facts.textureSizes
    .filter((texture) => texture.width !== declared.width || texture.height !== declared.height)
    .map((texture) =>
      diagnostic(
        "warning",
        "geckolib_texture_size_mismatch",
        `Texture "${texture.name}" is ${texture.width}x${texture.height} but the project UV base is ${declared.width}x${declared.height}; UVs will not line up in game.`,
        texture.name
      )
    );
}

/** Warns when the installed plugin generation differs from the surveyed one. */
function checkPluginVersion(version: string | null | undefined): IGeckolibDiagnostic[] {
  if (!version) return [];
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || major === SURVEYED_GECKOLIB_PLUGIN_MAJOR) return [];
  return [
    diagnostic(
      "warning",
      "geckolib_plugin_version_untested",
      `The installed GeckoLib plugin is ${version}; these checks were derived from plugin ${SURVEYED_GECKOLIB_PLUGIN_MAJOR}.x and may not describe that version's behavior.`,
      version
    ),
  ];
}

/**
 * Validates the facts of an open GeckoLib project.
 *
 * Bone parentage is deliberately not checked: outliner parents are live object
 * references inside Blockbench and cannot dangle, so only exported files can
 * carry a broken parent.
 *
 * @param facts - Project state gathered from the host.
 * @returns Findings, most structural first; an empty array means no rule fired.
 */
export function validateGeckolibProject(facts: IGeckolibProjectFacts): IGeckolibDiagnostic[] {
  const seen = new Map<string, string>();
  return [
    ...facts.boneNames.flatMap((name) => checkBoneName(name, seen)),
    ...checkIdentifiers(facts),
    ...checkArmorTemplate(facts),
    ...checkTextureSizes(facts),
    ...checkPluginVersion(facts.pluginVersion),
  ];
}

/** Validates one keyframe entry's GeckoLib easing metadata. */
function checkKeyframeEasing(
  keyframe: Record<string, unknown>,
  target: string
): IGeckolibDiagnostic[] {
  const findings: IGeckolibDiagnostic[] = [];
  const { easingArgs } = keyframe;
  // GeckoLib resolves a missing or null easing to linear (`easing || default`),
  // so both mean "no easing" rather than a malformed one.
  const easing = keyframe.easing ?? undefined;
  if (easing !== undefined && (typeof easing !== "string" || !isGeckolibEasing(easing))) {
    findings.push(
      diagnostic(
        "error",
        "geckolib_animation_easing_name",
        `${target} uses easing ${JSON.stringify(easing)}, which is not a GeckoLib easing name; GeckoLib silently falls back to linear.`,
        target
      )
    );
  }
  if (easingArgs !== undefined && (!Array.isArray(easingArgs) || !easingArgs.every((arg) => typeof arg === "number" && Number.isFinite(arg)))) {
    findings.push(
      diagnostic(
        "error",
        "geckolib_animation_easing_args",
        `${target} has easingArgs ${JSON.stringify(easingArgs)}; GeckoLib needs an array of finite numbers and drops the whole animation otherwise.`,
        target
      )
    );
  }
  if (typeof easing === "string" && isArgsEasing(easing) && easingArgs === undefined) {
    findings.push(
      diagnostic(
        "warning",
        "geckolib_animation_easing_args_missing",
        `${target} uses "${easing}" without easingArgs, so GeckoLib applies its own built-in default instead of the shape previewed in Blockbench.`,
        target
      )
    );
  }
  if (easing !== undefined && typeof keyframe.lerp_mode === "string" && keyframe.lerp_mode !== "linear") {
    findings.push(
      diagnostic(
        "warning",
        "geckolib_animation_easing_interpolation",
        `${target} carries both easing and lerp_mode "${keyframe.lerp_mode}"; GeckoLib applies only the interpolation mode and ignores the easing.`,
        target
      )
    );
  }
  return findings;
}

/** Walks one bone's channel map, returning findings and the latest keyframe time. */
function checkChannel(
  channel: Record<string, unknown>,
  label: string
): { findings: IGeckolibDiagnostic[]; lastTime: number } {
  // A compressed channel is the keyframe itself, and carries no timestamp.
  if (KEYFRAME_VALUE_KEYS.some((key) => key in channel)) {
    return { findings: checkKeyframeEasing(channel, `${label} (single keyframe)`), lastTime: 0 };
  }
  const entries = Object.entries(channel).filter(([key]) => !CHANNEL_METADATA_KEYS.includes(key));
  const findings = entries.flatMap(([time, keyframe]) => {
    const target = `${label} at ${time}s`;
    if (!Number.isFinite(Number.parseFloat(time))) {
      return [
        diagnostic(
          "error",
          "geckolib_animation_keyframe_time",
          `${label} has the non-numeric keyframe timestamp "${time}"; GeckoLib parses timestamps as seconds.`,
          target
        ),
      ];
    }
    if (!isRecord(keyframe)) return [];
    return checkKeyframeEasing(keyframe, target);
  });
  const times = entries.map(([time]) => Number.parseFloat(time)).filter(Number.isFinite);
  return { findings, lastTime: times.length ? Math.max(...times) : 0 };
}

/** Walks one animation, returning findings for its loop value, bones, and length. */
function checkAnimation(name: string, animation: Record<string, unknown>): IGeckolibDiagnostic[] {
  const findings: IGeckolibDiagnostic[] = [];
  if ("loop" in animation && !ACCEPTED_LOOP_VALUES.includes(animation.loop)) {
    findings.push(
      diagnostic(
        "error",
        "geckolib_animation_loop_value",
        `Animation "${name}" has loop value ${JSON.stringify(animation.loop)}; GeckoLib resolves only true/false, "loop", "play_once" and "hold_on_last_frame", and silently plays anything else once.`,
        name
      )
    );
  }
  const bones = isRecord(animation.bones) ? animation.bones : {};
  const channelResults = Object.entries(bones).flatMap(([bone, channels]) => {
    if (!isRecord(channels)) return [];
    return Object.entries(channels)
      .filter(([, channel]) => isRecord(channel))
      .map(([channelName, channel]) => checkChannel(channel as Record<string, unknown>, `${name} / ${bone}.${channelName}`));
  });
  findings.push(...channelResults.flatMap((result) => result.findings));

  const lastKeyframe = channelResults.reduce((latest, result) => Math.max(latest, result.lastTime), 0);
  const declaredLength = typeof animation.animation_length === "number" ? animation.animation_length : Number.parseFloat(String(animation.animation_length));
  if (Number.isFinite(declaredLength) && lastKeyframe - declaredLength > 1e-6) {
    findings.push(
      diagnostic(
        "warning",
        "geckolib_animation_length_mismatch",
        `Animation "${name}" declares animation_length ${declaredLength} but its last keyframe is at ${lastKeyframe}s; GeckoLib truncates playback at animation_length.`,
        name
      )
    );
  }
  return findings;
}

/**
 * Validates compiled GeckoLib animation-file content: loop values, per-keyframe
 * easing names and arguments, timestamp keys, and declared animation length.
 *
 * @param parsed - Animation document as compiled by the animation codec.
 * @returns Findings across every animation in the document.
 */
export function validateGeckolibAnimations(parsed: unknown): IGeckolibDiagnostic[] {
  if (!isRecord(parsed)) {
    return [
      diagnostic(
        "error",
        "geckolib_animation_envelope",
        "The compiled animation content is not a JSON object; GeckoLib expects an object with an animations map."
      ),
    ];
  }
  const animations = parsed.animations;
  if (animations === undefined) return [];
  if (!isRecord(animations)) {
    return [
      diagnostic(
        "error",
        "geckolib_animation_envelope",
        `The compiled "animations" entry is ${JSON.stringify(animations)} rather than a name-keyed object.`
      ),
    ];
  }
  return Object.entries(animations).flatMap(([name, animation]) =>
    isRecord(animation) ? checkAnimation(name, animation) : []
  );
}

/** Splits findings into the counts a tool result reports alongside them. */
export function summarizeDiagnostics(diagnostics: readonly IGeckolibDiagnostic[]): {
  valid: boolean;
  errors: number;
  warnings: number;
} {
  const errors = diagnostics.filter((finding) => finding.severity === "error").length;
  return { valid: errors === 0, errors, warnings: diagnostics.length - errors };
}
