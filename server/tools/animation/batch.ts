/// <reference types="blockbench-types" />
import { createTool } from "@/lib/factories";
import { animationToolDocs } from "./docs";
import { KEYFRAME_TIME_EPSILON, findAnimationOrSelected } from "./shared";

/**
 * Registers `batch_keyframe_operations`, which offsets, scales, reverses,
 * mirrors, smooths, or bakes a set of keyframes in the selected animation.
 * Call only after Blockbench globals exist.
 */
export function registerBatchKeyframeOperationsTool(): void {
  createTool(
    animationToolDocs[5].name,
    {
      ...animationToolDocs[5],
      async execute({ selection, range, pattern, operation, parameters = {} }) {
        const selectedAnimation = findAnimationOrSelected();
        if (!selectedAnimation) {
          throw new Error("No animation selected.");
        }

        // Gather keyframes based on selection type
        let keyframes: any[] = [];

        switch (selection) {
          case "all":
            keyframes = Timeline.keyframes;
            break;

          case "selected":
            keyframes = Timeline.selected;
            break;

          case "range":
            if (!range) {
              throw new Error("Range required for range selection.");
            }
            keyframes = Timeline.keyframes.filter(
              (kf) => kf.time >= range.start && kf.time <= range.end
            );
            break;

          case "pattern":
            if (!pattern) {
              throw new Error("Pattern required for pattern selection.");
            }
            keyframes = Timeline.keyframes.filter((kf) => {
              const relativeTime = kf.time - pattern.offset;
              return Math.abs(relativeTime % pattern.interval) < KEYFRAME_TIME_EPSILON;
            });
            break;
        }

        if (keyframes.length === 0) {
          throw new Error("No keyframes found matching selection criteria.");
        }

        Undo.initEdit({
          keyframes: keyframes,
        });

        switch (operation) {
          case "offset":
            keyframes.forEach((kf) => {
              if (parameters.offset_time !== undefined) {
                kf.time += parameters.offset_time;
              }
              if (parameters.offset_values) {
                const values = kf.getArray();
                kf.set("values", [
                  values[0] + parameters.offset_values[0],
                  values[1] + parameters.offset_values[1],
                  values[2] + parameters.offset_values[2],
                ]);
              }
            });
            break;

          case "scale":
            const pivot = parameters.scale_pivot || 0;
            const factor = parameters.scale_factor || 1;
            keyframes.forEach((kf) => {
              kf.time = pivot + (kf.time - pivot) * factor;
            });
            break;

          case "reverse":
            const times = keyframes.map((kf) => kf.time);
            const minTime = Math.min(...times);
            const maxTime = Math.max(...times);
            keyframes.forEach((kf) => {
              kf.time = maxTime - (kf.time - minTime);
            });
            break;

          case "mirror":
            if (!parameters.mirror_axis) {
              throw new Error("Mirror axis required for mirror operation.");
            }
            const axisIndex =
              parameters.mirror_axis === "x"
                ? 0
                : parameters.mirror_axis === "y"
                ? 1
                : 2;
            keyframes.forEach((kf) => {
              const values = kf.getArray();
              values[axisIndex] *= -1;
              kf.set("values", values);
            });
            break;

          case "smooth":
            // Apply catmullrom interpolation to all keyframes
            keyframes.forEach((kf) => {
              kf.interpolation = "catmullrom";
            });
            break;

          case "bake":
            const interval =
              parameters.bake_interval || 1 / selectedAnimation.snapping;
            const animators = new Set(keyframes.map((kf) => kf.animator));

            animators.forEach((animator) => {
              const channels = ["rotation", "position", "scale"];
              channels.forEach((channel) => {
                const channelKfs = animator[channel];
                if (!channelKfs || channelKfs.length < 2) return;

                const startTime = Math.min(...channelKfs.map((kf) => kf.time));
                const endTime = Math.max(...channelKfs.map((kf) => kf.time));

                for (let time = startTime; time <= endTime; time += interval) {
                  if (
                    !channelKfs.find((kf) => Math.abs(kf.time - time) < KEYFRAME_TIME_EPSILON)
                  ) {
                    Timeline.time = time;
                    animator.fillValues(
                      animator.createKeyframe(
                        {
                          time,
                          channel,
                          values: animator.interpolate(channel, true),
                        },
                        time,
                        channel,
                        false
                      ),
                      null,
                      false
                    );
                  }
                }
              });
            });
            break;
        }

        Undo.finishEdit(`Batch keyframe operation: ${operation}`);
        Animator.preview();

        return `Performed ${operation} on ${keyframes.length} keyframes`;
      },
    },
    animationToolDocs[5].status
  );
}
