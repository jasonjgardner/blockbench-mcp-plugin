import { describe, expect, test } from "bun:test";
import type { IAnimation, IBBModel, IKeyframe } from "../document/schema";
import { creatureModel } from "../test-fixtures";
import { compileBedrockAnimations } from "./bedrock-animation";

const keyframe = (
  uuid: string,
  time: number,
  channel: string,
  values: [string | number, string | number, string | number],
  interpolation = "linear",
): IKeyframe => ({
  uuid,
  time,
  channel,
  interpolation,
  data_points: [{ x: values[0], y: values[1], z: values[2] }],
});

interface ICompiledAnimation {
  loop?: string;
  animation_length?: number;
  bones?: Record<string, Record<string, unknown>>;
}

describe("compileBedrockAnimations (port of Blockbench's Bedrock animation codec)", () => {
  test("mirrors coordinates and preserves loop, length, Molang, and step keyframes", () => {
    const model = creatureModel(true);
    const group = model.groups.find((entry) => entry.name === "body");
    const animation = model.animations?.[0];
    expect(group).toBeDefined();
    expect(animation).toBeDefined();
    if (!group || !animation) return;

    const customized: IAnimation = {
      ...animation,
      loop: "hold",
      snapping: 4,
      animators: {
        [group.uuid]: {
          name: group.name,
          type: "bone",
          keyframes: [
            keyframe("rotation", 0, "rotation", ["12.5", "math.sin(q.anim_time)", 5]),
            keyframe("position-start", 0, "position", [1, 2, 3], "step"),
            keyframe("position-end", 0.5, "position", ["math.sin(q.anim_time)", 0, 0]),
            keyframe("scale-catmullrom", 0.26, "scale", [1, 2, 3], "catmullrom"),
            keyframe("scale", 0.75, "scale", [1, 2, 3]),
          ],
        },
      },
    };
    const doc: IBBModel = { ...model, animations: [customized] };
    const { animation: exported } = compileBedrockAnimations(doc);
    expect(exported.format_version).toBe("1.8.0");
    const body = (exported.animations as Record<string, ICompiledAnimation>)[customized.name];
    const bodyBones = body?.bones?.body;
    expect(body).toMatchObject({ loop: "hold_on_last_frame", animation_length: 1 });
    expect(bodyBones?.rotation).toMatchObject({ "0.0": ["-12.5", "-math.sin(q.anim_time)", 5] });
    expect(bodyBones?.position).toMatchObject({
      "0.0": [-1, 2, 3],
      "0.5": { pre: [-1, 2, 3], post: ["-math.sin(q.anim_time)", 0, 0] },
    });
    expect(bodyBones?.scale).toMatchObject({
      "0.25": { pre: [1, 2, 3], post: [1, 2, 3], lerp_mode: "catmullrom" },
      "0.75": [1, 2, 3],
    });
  });

  test("selects by UUID and reports unknown animation references", () => {
    const doc = creatureModel(true);
    const animation = doc.animations?.[0];
    expect(animation).toBeDefined();
    if (!animation) return;
    const { animation: exported, names } = compileBedrockAnimations(doc, { animations: [animation.uuid] });
    expect(names).toEqual([animation.name]);
    expect(Object.keys(exported.animations as Record<string, unknown>)).toEqual([animation.name]);
    expect(compileBedrockAnimations(doc, { animations: [animation.name] }).names).toEqual([animation.name]);
    expect(() => compileBedrockAnimations(doc, { animations: ["missing"] })).toThrow('No animation named or identified "missing".');
    expect(JSON.stringify(compileBedrockAnimations(doc).animation)).toBe(JSON.stringify(compileBedrockAnimations(doc).animation));
  });
});
