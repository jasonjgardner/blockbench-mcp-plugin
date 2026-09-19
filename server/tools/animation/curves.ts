/// <reference types="blockbench-types" />
import { createTool } from "@/lib/factories";
import { findGroupOrThrow } from "@/lib/util";
import { animationToolDocs } from "./docs";
import { findAnimationOrSelected } from "./shared";

/**
 * Registers `animation_graph_editor`, which applies interpolation presets or a
 * custom bezier curve to one bone channel. Call only after Blockbench globals exist.
 */
export function registerAnimationGraphEditorTool(): void {
  createTool(
    animationToolDocs[2].name,
    {
      ...animationToolDocs[2],
      async execute({
        animation_id,
        bone_name,
        channel,
        axis,
        action,
        keyframe_range,
        custom_curve,
      }) {
        const animation = findAnimationOrSelected(animation_id);

        if (!animation) {
          throw new Error("No animation found or selected.");
        }

        const group = findGroupOrThrow(bone_name);

        const animator = animation.animators[group.uuid];
        if (!animator || !animator[channel]) {
          throw new Error(`No keyframes found for ${bone_name}.${channel}`);
        }

        Undo.initEdit({
          animations: [animation],
          keyframes: animator[channel],
        });

        const keyframes = animator[channel].filter((kf: BBKeyframe) => {
          if (!keyframe_range) return true;
          return kf.time >= keyframe_range.start && kf.time <= keyframe_range.end;
        });

        keyframes.forEach((kf: BBKeyframe, index: number) => {
          switch (action) {
            case "linear":
              kf.interpolation = "linear";
              break;

            case "stepped":
              kf.interpolation = "step";
              break;

            case "smooth":
              kf.interpolation = "catmullrom";
              break;

            case "ease_in":
            case "ease_out":
            case "ease_in_out":
              kf.interpolation = "bezier";
              // Set bezier handles based on easing type
              const next = keyframes[index + 1];
              if (next) {
                const duration = next.time - kf.time;
                // @ts-ignore
                kf.bezier_left_time = 0;
                // @ts-ignore
                kf.bezier_right_time = duration;

                if (action === "ease_in") {
                  // @ts-ignore
                  kf.bezier_right_time = duration * 0.6;
                } else if (action === "ease_out") {
                  // @ts-ignore
                  kf.bezier_left_time = duration * 0.4;
                } else {
                  // @ts-ignore
                  kf.bezier_left_time = duration * 0.3;
                  // @ts-ignore
                  kf.bezier_right_time = duration * 0.7;
                }
              }
              break;

            case "custom":
              if (!custom_curve) {
                throw new Error("custom_curve is required for 'custom' action.");
              }
              kf.interpolation = "bezier";
              // @ts-ignore
              kf.bezier_left_time = custom_curve.control_point_1[0];
              // @ts-ignore
              kf.bezier_left_value = [
                custom_curve.control_point_1[1],
                custom_curve.control_point_1[1],
                custom_curve.control_point_1[1],
              ];
              // @ts-ignore
              kf.bezier_right_time = custom_curve.control_point_2[0];
              // @ts-ignore
              kf.bezier_right_value = [
                custom_curve.control_point_2[1],
                custom_curve.control_point_2[1],
                custom_curve.control_point_2[1],
              ];
              break;
          }
        });

        Undo.finishEdit("Modify animation curves");
        Animator.preview();
        updateKeyframeSelection();

        return `Applied ${action} curve to ${keyframes.length} keyframes in ${bone_name}.${channel}`;
      },
    },
    animationToolDocs[2].status
  );
}
