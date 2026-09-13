/// <reference types="blockbench-types" />
import { createTool } from "@/lib/factories";
import { findGroupOrThrow } from "@/lib/util";
import { animationToolDocs } from "./docs";
import { findAnimationOrSelected } from "./shared";

/**
 * Registers `animation_copy_paste`, which copies a bone's keyframes into a
 * process-wide clipboard and pastes (optionally mirrored) onto another bone.
 * Call only after Blockbench globals exist.
 */
export function registerAnimationCopyPasteTool(): void {
  createTool(
    animationToolDocs[6].name,
    {
      ...animationToolDocs[6],
      async execute({ action, source, target }) {
        // Static storage for copied data between copy/paste operations
        // @ts-ignore
        if (!global.animationClipboard) {
          // @ts-ignore
          global.animationClipboard = null;
        }

        switch (action) {
          case "copy": {
            if (!source) {
              throw new Error("Source data required for copy operation.");
            }

            const srcAnimation = findAnimationOrSelected(source.animation);

            if (!srcAnimation) {
              throw new Error("Source animation not found.");
            }

            const srcBone = findGroupOrThrow(source.bone);

            const animator = srcAnimation.animators[srcBone.uuid];
            if (!animator) {
              throw new Error(`No animation data for bone "${source.bone}".`);
            }

            // Copy keyframe data
            const copiedData: any = {
              bone_name: source.bone,
              channels: {},
            };

            source.channels.forEach((channel) => {
              if (!animator[channel]) return;

              let keyframes = animator[channel];
              if (source.time_range) {
                keyframes = keyframes.filter(
                  (kf) =>
                    kf.time >= source.time_range.start &&
                    kf.time <= source.time_range.end
                );
              }

              copiedData.channels[channel] = keyframes.map((kf) => ({
                time: kf.time,
                values: kf.getArray(),
                interpolation: kf.interpolation,
                // @ts-ignore
                bezier_left_time: kf.bezier_left_time,
                // @ts-ignore
                bezier_left_value: kf.bezier_left_value,
                // @ts-ignore
                bezier_right_time: kf.bezier_right_time,
                // @ts-ignore
                bezier_right_value: kf.bezier_right_value,
              }));
            });

            // @ts-ignore
            global.animationClipboard = copiedData;

            return `Copied animation data from "${source.bone}" (${Object.keys(
              copiedData.channels
            ).join(", ")})`;
          }

          case "paste":
          case "mirror_paste": {
            if (!target) {
              throw new Error("Target data required for paste operation.");
            }

            // @ts-ignore
            if (!global.animationClipboard) {
              throw new Error("No animation data in clipboard. Copy first.");
            }

            const tgtAnimation = findAnimationOrSelected(target.animation);

            if (!tgtAnimation) {
              throw new Error("Target animation not found.");
            }

            const tgtBone = findGroupOrThrow(target.bone);

            let animator = tgtAnimation.animators[tgtBone.uuid];
            if (!animator) {
              animator = new BoneAnimator(
                tgtBone.uuid,
                tgtAnimation,
                target.bone
              );
              tgtAnimation.animators[tgtBone.uuid] = animator;
            }

            Undo.initEdit({
              animations: [tgtAnimation],
              keyframes: [],
            });

            // @ts-ignore
            const clipboardData = global.animationClipboard;
            const mirrorAxis =
              action === "mirror_paste" ? target.mirror_axis || "x" : null;
            const axisIndex =
              mirrorAxis === "x"
                ? 0
                : mirrorAxis === "y"
                ? 1
                : mirrorAxis === "z"
                ? 2
                : -1;

            Object.entries(clipboardData.channels).forEach(
              ([channel, keyframes]: [string, any[]]) => {
                keyframes.forEach((kfData) => {
                  const values = [...kfData.values];

                  // Apply mirroring if needed
                  if (
                    mirrorAxis &&
                    (channel === "rotation" || channel === "position")
                  ) {
                    values[axisIndex] *= -1;
                  }

                  const keyframe = animator.createKeyframe(
                    {
                      time: kfData.time + (target.time_offset || 0),
                      channel,
                      values,
                      interpolation: kfData.interpolation,
                    },
                    kfData.time + (target.time_offset || 0),
                    channel,
                    false
                  );

                  // Copy bezier data if present
                  if (kfData.interpolation === "bezier") {
                    // @ts-ignore
                    if (kfData.bezier_left_time !== undefined)
                      keyframe.bezier_left_time = kfData.bezier_left_time;
                    // @ts-ignore
                    if (kfData.bezier_left_value)
                      keyframe.bezier_left_value = kfData.bezier_left_value;
                    // @ts-ignore
                    if (kfData.bezier_right_time !== undefined)
                      keyframe.bezier_right_time = kfData.bezier_right_time;
                    // @ts-ignore
                    if (kfData.bezier_right_value)
                      keyframe.bezier_right_value = kfData.bezier_right_value;
                  }
                });
              }
            );

            Undo.finishEdit(`${action} animation data`);
            Animator.preview();

            return `Pasted animation data to "${target.bone}"${
              mirrorAxis ? ` (mirrored on ${mirrorAxis} axis)` : ""
            }`;
          }
        }
      },
    },
    animationToolDocs[6].status
  );
}
