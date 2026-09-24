/**
 * Test fixtures for the headless package: a small symmetric creature built
 * through the same operations the `bbmodel_edit` tool applies.
 *
 * Layout (units): a 8×6×12 body standing on four 2×6×2 legs, a head at the front
 * (-Z), all legs directly under the body. Leg groups pivot at the hip.
 *
 * @module
 */

import { applyOperations, operationSchema } from "./edit/operations";
import type { IBBModel } from "./document/schema";
import { emptyModel } from "./tools/edit";

/** Leg descriptors: name, x center, z center. */
const LEGS = [
  ["leg_front_l", 3, -4],
  ["leg_front_r", -3, -4],
  ["leg_back_l", 3, 4],
  ["leg_back_r", -3, 4],
] as const;

/**
 * Builds the creature. Every call returns fresh UUIDs.
 *
 * @param withWalk - Adds `animation.creature.walk`, swinging the legs ±30°.
 */
export function creatureModel(withWalk = false): IBBModel {
  const legOps = LEGS.flatMap(([name, x, z]) => [
    { op: "add_group", name, origin: [x, 6, z], parent: "body" },
    { op: "add_cube", name: `${name}_cube`, from: [x - 1, 0, z - 1], to: [x + 1, 6, z + 1], parent: name },
  ]);
  const walkOps = withWalk
    ? [
        { op: "add_animation", name: "animation.creature.walk", length: 1, loop: "loop" },
        ...LEGS.flatMap(([name], i) => {
          const sign = i % 3 === 0 ? 1 : -1;
          return [
            { op: "set_keyframe", animation: "animation.creature.walk", bone: name, channel: "rotation", time: 0, value: [30 * sign, 0, 0] },
            { op: "set_keyframe", animation: "animation.creature.walk", bone: name, channel: "rotation", time: 0.5, value: [-30 * sign, 0, 0] },
            { op: "set_keyframe", animation: "animation.creature.walk", bone: name, channel: "rotation", time: 1, value: [30 * sign, 0, 0] },
          ];
        }),
      ]
    : [];
  const operations = operationSchema.array().parse([
    { op: "add_group", name: "body", origin: [0, 6, 0] },
    { op: "add_cube", name: "torso", from: [-4, 6, -6], to: [4, 12, 6], parent: "body" },
    { op: "add_group", name: "head", origin: [0, 10, -6], parent: "body" },
    { op: "add_cube", name: "skull", from: [-3, 8, -11], to: [3, 13, -6], parent: "head" },
    ...legOps,
    ...walkOps,
  ]);
  return applyOperations(emptyModel("free", "creature", false, { width: 64, height: 64 }), operations).doc;
}
