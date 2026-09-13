/// <reference types="blockbench-types" />
import type { z } from "zod";
import { createTool } from "@/lib/factories";
import { findGroupOrThrow } from "@/lib/util";
import { createGroupWithUndo } from "@/lib/group-creation";
import { animationToolDocs } from "./docs";
import { boneRiggingParameters } from "./schemas";
import { toVector3 } from "./shared";

type BoneRiggingInput = z.infer<typeof boneRiggingParameters>;
type BoneData = BoneRiggingInput["bone_data"];
type BoneEditAction = Exclude<BoneRiggingInput["action"], "create">;
type MirrorAxis = NonNullable<BoneData["mirror_axis"]>;

/**
 * A bone as Blockbench stores it at runtime. blockbench-types declares
 * `ik_enabled` on `Group` but not the IK chain target, which rigs also persist.
 */
interface IIkBone extends Group {
  ik_target?: string;
}

/** Index of each axis within an `[x, y, z]` vector. */
const AXIS_INDEX: Record<MirrorAxis, number> = { x: 0, y: 1, z: 2 };

/**
 * Outliner edits for existing bones, run inside the shared bone-rigging undo
 * entry. Each resolves `bone_data.name` and returns the tool's result message.
 */
const BONE_EDITORS: Record<BoneEditAction, (boneData: BoneData) => string> = {
  parent: (boneData) => {
    const child = findGroupOrThrow(boneData.name);
    const parent = boneData.parent
      ? Group.all.find((g) => g.name === boneData.parent)
      : "root";
    child.addTo(parent);
    return `Parented "${boneData.name}" to "${boneData.parent || "root"}"`;
  },
  unparent: (boneData) => {
    findGroupOrThrow(boneData.name).addTo("root");
    return `Unparented "${boneData.name}"`;
  },
  delete: (boneData) => {
    findGroupOrThrow(boneData.name).remove();
    return `Deleted bone "${boneData.name}"`;
  },
  rename: (boneData) => {
    const bone = findGroupOrThrow(boneData.name);
    const newName = boneData.children?.[0] || "new_name";
    bone.name = newName;
    return `Renamed bone to "${newName}"`;
  },
  set_pivot: (boneData) => {
    const bone = findGroupOrThrow(boneData.name);
    if (boneData.origin) bone.origin = toVector3(boneData.origin);
    return `Set pivot point for "${boneData.name}"`;
  },
  set_ik: (boneData) => {
    const bone: IIkBone = findGroupOrThrow(boneData.name);
    bone.ik_enabled = boneData.ik_enabled || false;
    if (boneData.ik_target) bone.ik_target = boneData.ik_target;
    return `Updated IK settings for "${boneData.name}"`;
  },
  mirror: mirrorBone,
};

/** Swaps the first left/right marker in a bone name, or appends `_mirrored`. */
function mirroredBoneName(name: string): string {
  if (name.includes("left")) return name.replace("left", "right");
  if (name.includes("right")) return name.replace("right", "left");
  return name + "_mirrored";
}

/** Duplicates a bone with its pivot negated on the mirror axis (default `x`). */
function mirrorBone(boneData: BoneData): string {
  const bone = findGroupOrThrow(boneData.name);
  const axis = boneData.mirror_axis || "x";
  const mirroredBone = bone.duplicate();
  mirroredBone.origin[AXIS_INDEX[axis]] *= -1;
  mirroredBone.name = mirroredBoneName(bone.name);
  return `Mirrored bone "${boneData.name}" across ${axis} axis`;
}

/**
 * Creates a bone with its own validated, reversible edit; IK settings are
 * applied inside that same transaction when both a flag and target are given.
 */
function createBone(boneData: BoneData): string {
  const group = createGroupWithUndo({
    name: boneData.name,
    origin: boneData.origin ? toVector3(boneData.origin) : [0, 0, 0],
    rotation: boneData.rotation ? toVector3(boneData.rotation) : [0, 0, 0],
  }, boneData.parent, boneData.children, (created) => {
    if (!boneData.ik_enabled || !boneData.ik_target) return;
    const bone: IIkBone = created;
    bone.ik_enabled = true;
    bone.ik_target = boneData.ik_target;
  }, "Bone rigging: create");
  return `Created bone "${group.name}" with UUID ${group.uuid}`;
}

/**
 * Registers `bone_rigging`, which creates and edits the bone hierarchy used for
 * animation. Call only after Blockbench globals exist.
 */
export function registerBoneRiggingTool(): void {
  createTool(
    animationToolDocs[3].name,
    {
      ...animationToolDocs[3],
      parameters: boneRiggingParameters,
      async execute({ action, bone_data }) {
        if (action === "create") return createBone(bone_data);

        Undo.initEdit({
          outliner: true,
          elements: [],
          groups: [],
        });
        const result = BONE_EDITORS[action](bone_data);
        Undo.finishEdit(`Bone rigging: ${action}`);
        Canvas.updateAll();

        return result;
      },
    },
    animationToolDocs[3].status
  );
}
