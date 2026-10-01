/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool } from "@/lib/factories";
import { findGroupOrThrow } from "@/lib/util";
import { createGroupWithUndo } from "@/lib/group-creation";
import { runUndoableEdit } from "@/lib/undo";
import { runUndoableAnimationEdit } from "@/lib/animation-undo";
import { ancestorsOf, resetClipbenchDuplicateMap } from "@/lib/cube-knife";
import { vector3Schema } from "@/lib/zodObjects";
import { animationToolDocs } from "./docs";
import { boneRiggingParameters } from "./schemas";
import { getAnimationClass, toVector3 } from "./shared";

type BoneRiggingInput = z.infer<typeof boneRiggingParameters>;
type BoneData = BoneRiggingInput["bone_data"];
type BoneEditAction = Exclude<BoneRiggingInput["action"], "create" | "set_ik">;
type MirrorAxis = NonNullable<BoneData["mirror_axis"]>;

/** Index of each axis within an `[x, y, z]` vector. */
const AXIS_INDEX: Record<MirrorAxis, number> = { x: 0, y: 1, z: 2 };

// ============================================================================
// IK controller (NullObject) schema
// ============================================================================

/** Optional outliner reference; an empty string clears the property. */
const clearableReference = (description: string) => z.string().optional().describe(description);

/**
 * Parameters for `set_ik_controller`.
 *
 * Blockbench drives inverse kinematics from a NullObject, never from bones:
 * `ik_target` is the end effector (group, armature bone, or locator) that should
 * reach the null object, `ik_source` is the chain root (group or armature bone;
 * empty means the null object's own parent), `ik_pole` (Blockbench 5.2+) is a
 * group, locator, or null object that sets the bend direction, and
 * `lock_ik_target_rotation` keeps the end effector's world rotation. Omitted
 * fields keep their current value; empty strings clear references. The schema
 * uses no Blockbench globals; references are resolved at execution time.
 */
export const setIkControllerParameters = z.object({
  null_object: z
    .string()
    .optional()
    .describe("UUID or name of an existing null object to update. Omit to create a new IK controller null object."),
  name: z.string().optional().describe("Name for the null object. Defaults to '<ik_target name>_ik' when creating."),
  position: vector3Schema
    .optional()
    .describe("Null object position [x, y, z] as Blockbench stores it (model space for root and group parents). Defaults to the end effector's world pivot when creating."),
  parent: z
    .string()
    .optional()
    .describe("Parent group, armature, or armature bone (UUID or name), or 'root'. Defaults to root when creating. When ik_source is empty the parent is the implicit chain root, so keep IK controllers outside the chain they drive."),
  ik_target: clearableReference("End effector that reaches for the null object: a group/bone, armature bone, or locator (UUID or name). Required when creating; must be a descendant of the chain root. Empty string clears."),
  ik_source: clearableReference("Chain root: a group/bone or armature bone (UUID or name). The chain spans from here down to ik_target. Empty string clears, making the null object's parent the chain root."),
  ik_pole: clearableReference("Pole target controlling the bend direction (Blockbench 5.2+): a group, locator, or other null object (UUID or name). Empty string clears."),
  lock_ik_target_rotation: z
    .boolean()
    .optional()
    .describe("Keep the end effector's world rotation while the chain solves."),
});

/** Parsed `set_ik_controller` input. */
export type SetIkControllerInput = z.infer<typeof setIkControllerParameters>;

// ============================================================================
// IK controller runtime
// ============================================================================

/**
 * NullObject IK fields as Blockbench 5.2 stores them. blockbench-types declares
 * only `ik_target` and `lock_ik_target_rotation`; all references are UUIDs.
 */
interface IIkNullObject extends NullObject {
  ik_source: string;
  ik_pole: string;
}

/** Any outliner node that carries a name and UUID and can be resolved by reference. */
type NamedNode = OutlinerNode & { name: string; uuid: string };

/** Summary of one IK controller after an edit, returned to clients. */
export interface IIkControllerResult {
  /** Whether a new null object was created. */
  created: boolean;
  null_object: { uuid: string; name: string; parent: string };
  ik_target: { uuid: string; name: string } | null;
  ik_source: { uuid: string; name: string } | null;
  ik_pole: { uuid: string; name: string } | null;
  lock_ik_target_rotation: boolean;
  /** Bone names the solver rotates, chain root first; empty when there is no target. */
  chain: string[];
  /** Guidance about settings the solver will ignore or that look unintended. */
  warnings: string[];
}

/** ArmatureBone/Armature exist only on Blockbench 5.0+. */
function armatureBones(): ArmatureBone[] {
  return typeof ArmatureBone === "undefined" ? [] : ArmatureBone.all;
}

function armatures(): Armature[] {
  return typeof Armature === "undefined" ? [] : Armature.all;
}

/** Resolves a UUID or unique name among `candidates`, rejecting ambiguous names. */
function resolveNode<T extends NamedNode>(reference: string, candidates: readonly T[], role: string): T {
  const byUuid = candidates.find((candidate) => candidate.uuid === reference);
  if (byUuid) return byUuid;
  const named = candidates.filter((candidate) => candidate.name === reference);
  if (named.length > 1) throw new Error(`${role} name "${reference}" is ambiguous. Use its UUID.`);
  if (named.length === 0) throw new Error(`${role} "${reference}" not found. Use list_outline to inspect UUIDs and names.`);
  return named[0];
}

/** Resolves a clearable reference: `undefined` keeps `current`, `""` clears, anything else must resolve. */
function resolveClearable<T extends NamedNode>(reference: string | undefined, current: string, candidates: readonly T[], role: string): T | null {
  const effective = reference ?? current;
  if (!effective) return null;
  const found = candidates.find((candidate) => candidate.uuid === effective);
  if (reference === undefined) return found ?? null;
  return found ?? resolveNode(effective, candidates, role);
}

function summarize(node: NamedNode | null): { uuid: string; name: string } | null {
  return node ? { uuid: node.uuid, name: node.name } : null;
}

function parentLabel(parent: OutlinerNode["parent"]): string {
  return parent === "root" || !parent ? "root" : (parent as NamedNode).name;
}

/** Resolved references and placement for one controller edit. */
interface IIkPlan {
  existing: IIkNullObject | undefined;
  parent: NamedNode | "root" | undefined;
  target: NamedNode | null;
  source: NamedNode | null;
  pole: NamedNode | null;
  chain: NamedNode[];
}

/**
 * Nodes the solver rotates, chain root first, mirroring `NullObjectAnimator.displayIK`:
 * walk from the target up to the chain root, including the root only when it is an
 * explicit `ik_source`. Throws when the target is not below the chain root.
 */
function computeChain(target: NamedNode, source: NamedNode | null, parent: NamedNode | "root"): NamedNode[] {
  const root = source ?? parent;
  const ancestors = ancestorsOf(target) as NamedNode[];
  if (root === "root") return [target, ...ancestors].toReversed();
  const index = ancestors.indexOf(root);
  if (index < 0) {
    throw new Error(`IK target "${target.name}" is not a descendant of chain root "${root.name}". Pick an ik_source above the target, or parent the null object to one.`);
  }
  const chain = [target, ...ancestors.slice(0, index), ...(source ? [source] : [])];
  return chain.toReversed();
}

/**
 * Whether the host's null objects have an `ik_pole` property. It was added in
 * Blockbench 5.2 (`new Property(NullObject, 'string', 'ik_pole')`); older hosts
 * would neither save nor solve it.
 */
function supportsIkPole(): boolean {
  const properties: unknown = Reflect.get(NullObject, "properties");
  return typeof properties === "object" && properties !== null && "ik_pole" in properties;
}

/** Resolves the pole reference, rejecting a non-empty `ik_pole` on hosts older than 5.2. */
function resolvePole(input: SetIkControllerInput, existing: IIkNullObject | undefined): NamedNode | null {
  if (!supportsIkPole() && input.ik_pole) {
    throw new Error("ik_pole requires Blockbench 5.2 or newer; this version's null objects have no pole target. Omit ik_pole or update Blockbench.");
  }
  if (!supportsIkPole()) return null;
  const poles: NamedNode[] = [...Group.all, ...Locator.all, ...NullObject.all.filter((node) => node !== existing)];
  return resolveClearable(input.ik_pole, existing?.ik_pole ?? "", poles, "IK pole");
}

/** Resolves every reference before any undo state exists. */
function planIkController(input: SetIkControllerInput): IIkPlan {
  const existing = input.null_object === undefined
    ? undefined
    : resolveNode(input.null_object, NullObject.all as NamedNode[], "Null object") as unknown as IIkNullObject;
  const parentCandidates: NamedNode[] = [...Group.all, ...armatures(), ...armatureBones()];
  const parent = input.parent === undefined || input.parent === "root"
    ? (input.parent as "root" | undefined)
    : resolveNode(input.parent, parentCandidates, "Parent");
  const bones: NamedNode[] = [...Group.all, ...armatureBones()];
  const target = resolveClearable(input.ik_target, existing?.ik_target ?? "", [...bones, ...Locator.all], "IK target");
  const source = resolveClearable(input.ik_source, existing?.ik_source ?? "", bones, "IK source");
  const pole = resolvePole(input, existing);
  if (!existing && !target) throw new Error("ik_target is required when creating an IK controller.");
  const effectiveParent = parent ?? (existing ? (existing.parent as NamedNode | "root") : "root");
  const chain = target ? computeChain(target, source, effectiveParent) : [];
  return { existing, parent, target, source, pole, chain };
}

/** Default controller position: the end effector's world pivot, or the origin. */
function defaultPosition(target: NamedNode | null): ArrayVector3 {
  const center = (target as { getWorldCenter?: () => THREE.Vector3 } | null)?.getWorldCenter?.();
  return center ? [center.x, center.y, center.z] : [0, 0, 0];
}

function warningsFor(plan: IIkPlan, nullObject: IIkNullObject): string[] {
  const inChain = plan.chain.some((node) => nullObject.isChildOf(node as OutlinerNode, 0));
  const messages = [
    plan.target ? "" : "No ik_target is set, so this null object does not drive IK.",
    inChain ? "The null object is parented inside the chain it drives; the solver will chase its own tail. Parent it outside the chain." : "",
    plan.chain.length < 2 && plan.target ? "The chain has fewer than two bones; set ik_source further up the hierarchy for a bending chain." : "",
  ];
  return messages.filter((message) => message.length > 0);
}

/**
 * Creates or updates an IK controller null object in one undoable edit.
 *
 * All references are validated first, so invalid input leaves no history entry.
 * The animation preview is refreshed when Animate mode is active, matching the
 * native element panel's `onChange` for the IK properties.
 *
 * @param input - Parsed {@link setIkControllerParameters}.
 * @returns Summary of the resulting controller, its chain, and any warnings.
 * @throws When the project has no animation mode, or a reference is missing, ambiguous, or outside the chain.
 */
export function applyIkController(input: SetIkControllerInput): IIkControllerResult {
  if (typeof Project === "undefined" || !Project) throw new Error("Open a project before configuring IK.");
  if (!Format.animation_mode) throw new Error(`Format "${Format.id}" has no animation mode, so null object IK is unavailable.`);
  const plan = planIkController(input);
  const elements: OutlinerElement[] = plan.existing ? [plan.existing] : [];
  const nullObject = runUndoableEdit({ elements, outliner: true }, plan.existing ? "Agent updated IK controller" : "Agent added IK controller", () => {
    const target = plan.existing ?? createNullObject(input, plan, elements);
    if (plan.existing && plan.parent !== undefined) target.addTo(plan.parent);
    if (plan.existing && input.name !== undefined) target.name = input.name;
    if (plan.existing && input.position) target.position = toVector3(input.position);
    target.ik_target = plan.target?.uuid ?? "";
    target.ik_source = plan.source?.uuid ?? "";
    if (supportsIkPole()) target.ik_pole = plan.pole?.uuid ?? "";
    if (input.lock_ik_target_rotation !== undefined) target.lock_ik_target_rotation = input.lock_ik_target_rotation;
    target.preview_controller.updateTransform(target);
    return target;
  });
  Canvas.updateAll();
  if (Modes.animate) Animator.preview();
  return {
    created: !plan.existing,
    null_object: { uuid: nullObject.uuid, name: nullObject.name, parent: parentLabel(nullObject.parent) },
    ik_target: summarize(plan.target),
    ik_source: summarize(plan.source),
    ik_pole: summarize(plan.pole),
    lock_ik_target_rotation: Boolean(nullObject.lock_ik_target_rotation),
    chain: plan.chain.map((node) => node.name),
    warnings: warningsFor(plan, nullObject),
  };
}

/** Creates the null object, tracking it in the undo aspect before initialization. */
function createNullObject(input: SetIkControllerInput, plan: IIkPlan, tracked: OutlinerElement[]): IIkNullObject {
  const created = new NullObject({
    name: input.name ?? `${plan.target?.name ?? "ik"}_ik`,
    position: input.position ? toVector3(input.position) : defaultPosition(plan.target),
  }) as IIkNullObject;
  tracked.push(created);
  created.addTo(plan.parent ?? "root").init();
  if (input.name === undefined) created.createUniqueName();
  return created;
}

// ============================================================================
// bone_rigging
// ============================================================================

/**
 * One outliner edit for an existing bone, planned before Undo starts: the
 * aspects that let Undo rebuild everything the edit touches, and the change,
 * which returns the tool's result message.
 */
interface IBoneEdit {
  aspects: UndoAspects;
  /** Aspects snapshotted after the edit, when removed nodes must drop out of them. */
  finishAspects?: UndoAspects;
  /** Animations whose animators the edit removes; they are snapshotted in full so Undo brings the keyframes back. */
  animations?: BBAnimation[];
  apply: () => string;
}

/** Outliner reference meaning the project's top level. */
const ROOT_PARENT = "root";

/** A bone and its descendants, split the way Blockbench's Undo tracks them. */
function boneSubtree(bone: Group): { groups: Group[]; elements: OutlinerElement[] } {
  const groups: Group[] = [bone];
  const elements: OutlinerElement[] = [];
  bone.forEachChild((child: OutlinerNode) => {
    if (child instanceof Group) groups.push(child);
    else if (child instanceof OutlinerElement) elements.push(child);
  });
  return { groups, elements };
}

/**
 * Resolves the parent action's target: a bone UUID, then a unique bone name.
 * Omitting it, or `root` when no bone has that name, means the project root.
 */
function resolveParentBone(reference: string | undefined): Group | typeof ROOT_PARENT {
  if (!reference) return ROOT_PARENT;
  if (reference === ROOT_PARENT && !Group.all.some((group) => group.uuid === reference || group.name === reference)) return ROOT_PARENT;
  return resolveNode(reference, Group.all, "Parent bone");
}

function planParent(boneData: BoneData): IBoneEdit {
  const child = findGroupOrThrow(boneData.name);
  const parent = resolveParentBone(boneData.parent);
  if (parent !== ROOT_PARENT && (parent === child || parent.isChildOf(child, Infinity))) {
    throw new Error(`Cannot parent "${child.name}" to "${parent.name}": a bone cannot be placed inside itself or its own descendants.`);
  }
  return {
    aspects: { outliner: true },
    apply: () => {
      child.addTo(parent);
      if (child.parent !== parent) throw new Error("The current format does not allow the requested parent.");
      return `Parented "${child.name}" to "${parent === ROOT_PARENT ? ROOT_PARENT : parent.name}"`;
    },
  };
}

/**
 * Undo can only rebuild what the "before" snapshot holds, so the bone's
 * descendants are listed, as Blockbench's Delete does. `Group.remove` also
 * deletes the animators of every removed node in every animation, so those
 * animations are snapshotted too: all of them that animate any node of the
 * subtree, where Blockbench's own `Group.remove(true)` only checks the bone.
 */
function planDelete(boneData: BoneData): IBoneEdit {
  const bone = findGroupOrThrow(boneData.name);
  const { groups, elements } = boneSubtree(bone);
  const removed = new Set([...groups, ...elements].map((node) => node.uuid));
  const animations = (getAnimationClass().all ?? []).filter((animation) =>
    Object.keys(animation.animators ?? {}).some((uuid) => removed.has(uuid)));
  return {
    aspects: { elements, groups, outliner: true },
    finishAspects: { elements: [], groups: [], outliner: true },
    animations,
    apply: () => {
      bone.remove();
      return `Deleted bone "${boneData.name}" with ${groups.length - 1} child bone(s) and ${elements.length} element(s)`;
    },
  };
}

/** Group properties only reach Undo through the groups aspect; the outliner aspect holds just the hierarchy. */
function planGroupEdit(boneData: BoneData, edit: (bone: Group) => string): IBoneEdit {
  const bone = findGroupOrThrow(boneData.name);
  return { aspects: { groups: [bone], outliner: true }, apply: () => edit(bone) };
}

/** Element types flip through their own `flip(axis, center)`, as Blockbench's Flip action calls them. */
interface IFlippableElement {
  flip(axis: number, center: number, skipUV?: boolean): unknown;
}

function isFlippable(element: OutlinerElement): element is OutlinerElement & IFlippableElement {
  return typeof Reflect.get(element, "flip") === "function";
}

/**
 * Flips one copied bone like Blockbench's Flip action does in bone-rig formats
 * (`mirrorSelected`): the pivot mirrors on the axis, the rotation on the other
 * two axes flips sign, and left/right names swap when the swapped name is free.
 */
function flipBone(group: Group, axis: number): void {
  [0, 1, 2].forEach((index) => {
    if (index === axis) group.origin[index] *= -1;
    else group.rotation[index] *= -1;
  });
  const originalName: unknown = Reflect.get(group.temp_data ?? {}, "old_name");
  flipNameOnAxis(group, axis, (name: string) => !Group.all.some((other) => other.name === name), originalName);
}

/**
 * Creates the mirror image of a bone: Blockbench's Duplicate followed by its
 * Flip action on the copy, so the copied bones, cubes, meshes, locators and null
 * objects all mirror across the plane through the model origin (the grid center).
 * The copies are tracked for Undo, which removes them again.
 */
function planMirror(boneData: BoneData): IBoneEdit {
  const bone = findGroupOrThrow(boneData.name);
  const axisName = boneData.mirror_axis ?? "x";
  const axis = AXIS_INDEX[axisName];
  const fixed = boneSubtree(bone).elements.find((element) => !isFlippable(element));
  if (fixed) throw new Error(`"${fixed.name}" cannot be mirrored: its element type has no flip.`);
  const groups: Group[] = [];
  const elements: OutlinerElement[] = [];
  return {
    aspects: { elements, groups, outliner: true },
    apply: () => {
      const copy = bone.duplicate();
      resetClipbenchDuplicateMap();
      const created = boneSubtree(copy);
      // Undo re-reads these arrays when the edit finishes, so the copies land in its "after" snapshot.
      groups.push(...created.groups);
      elements.push(...created.elements);
      created.groups.forEach((group) => flipBone(group, axis));
      const center = Format.centered_grid ? 0 : 8;
      created.elements.filter(isFlippable).forEach((element) => element.flip(axis, center, false));
      return `Mirrored bone "${bone.name}" across the ${axisName} axis as "${copy.name}" (${copy.uuid})`;
    },
  };
}

/** Plans the outliner edits for existing bones; each resolves `bone_data.name` and validates before Undo starts. */
const BONE_EDITORS: Record<BoneEditAction, (boneData: BoneData) => IBoneEdit> = {
  parent: planParent,
  unparent: (boneData) => {
    const bone = findGroupOrThrow(boneData.name);
    return {
      aspects: { outliner: true },
      apply: () => {
        bone.addTo(ROOT_PARENT);
        return `Unparented "${boneData.name}"`;
      },
    };
  },
  delete: planDelete,
  rename: (boneData) => planGroupEdit(boneData, (bone) => {
    const newName = boneData.children?.[0] || "new_name";
    bone.name = newName;
    return `Renamed bone to "${newName}"`;
  }),
  set_pivot: (boneData) => planGroupEdit(boneData, (bone) => {
    if (boneData.origin) bone.origin = toVector3(boneData.origin);
    return `Set pivot point for "${boneData.name}"`;
  }),
  mirror: planMirror,
};

/**
 * Legacy `set_ik` / `create` IK flags, translated to Blockbench's real IK model.
 *
 * Earlier versions wrote `ik_enabled`/`ik_target` onto the Group, which
 * Blockbench never reads. Now `bone_data.name` is the end effector and
 * `bone_data.ik_target` names the controller null object (created at the
 * project root when missing). The chain root defaults to the bone's grandparent
 * (a two-segment limb). `ik_enabled: false` clears `ik_target` on every null
 * object that drives this bone. Use `set_ik_controller` for full control.
 */
function applyLegacyIk(boneData: BoneData): string {
  const bone = Group.all.find((group) => group.uuid === boneData.name) ?? findGroupOrThrow(boneData.name);
  if (boneData.ik_enabled === false) return disableIkFor(bone);
  const controllerName = boneData.ik_target || `${bone.name}_ik`;
  const existing = NullObject.all.find((node) => node.uuid === controllerName || node.name === controllerName);
  const [parentBone, grandparent] = ancestorsOf(bone) as NamedNode[];
  const result = applyIkController({
    null_object: existing?.uuid,
    name: existing ? undefined : controllerName,
    ik_target: bone.uuid,
    ik_source: existing ? undefined : (grandparent ?? parentBone)?.uuid ?? "",
  });
  return `IK on "${bone.name}" is driven by null object "${result.null_object.name}" (${result.null_object.uuid}); chain: ${result.chain.join(" > ")}. ` +
    "bone_rigging set_ik is deprecated; use set_ik_controller for ik_source, ik_pole, position, and rotation lock.";
}

/** Clears `ik_target` on null objects that drive `bone`, in one undoable edit. */
function disableIkFor(bone: Group): string {
  const drivers = NullObject.all.filter((node) => node.ik_target === bone.uuid);
  if (drivers.length === 0) return `No null object drives IK on "${bone.name}".`;
  runUndoableEdit({ elements: drivers }, "Agent disabled IK", () => {
    drivers.forEach((node) => {
      node.ik_target = "";
    });
  });
  if (Modes.animate) Animator.preview();
  return `Cleared ik_target on ${drivers.length} null object(s) that drove "${bone.name}".`;
}

/**
 * `create` resolves its parent through createGroupWithUndo: UUID first, then
 * name, and `root` is the project root. A name several bones share would
 * silently pick the first one, so it is refused here, as the parent action does.
 */
function assertUnambiguousParent(reference: string | undefined): void {
  if (!reference || reference === ROOT_PARENT || Group.all.some((group) => group.uuid === reference)) return;
  if (Group.all.filter((group) => group.name === reference).length > 1) {
    throw new Error(`Parent bone name "${reference}" is ambiguous. Use its UUID.`);
  }
}

/**
 * Creates a bone with its own validated, reversible edit. When `ik_enabled` is
 * set, IK is configured afterwards as a second history entry via
 * {@link applyLegacyIk}.
 */
function createBone(boneData: BoneData): string {
  assertUnambiguousParent(boneData.parent);
  const group = createGroupWithUndo({
    name: boneData.name,
    origin: boneData.origin ? toVector3(boneData.origin) : [0, 0, 0],
    rotation: boneData.rotation ? toVector3(boneData.rotation) : [0, 0, 0],
  }, boneData.parent, boneData.children, undefined, "Bone rigging: create");
  const created = `Created bone "${group.name}" with UUID ${group.uuid}`;
  if (!boneData.ik_enabled) return created;
  return `${created}. ${applyLegacyIk({ ...boneData, name: group.uuid })}`;
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
        if (action === "set_ik") return applyLegacyIk(bone_data);

        const edit = BONE_EDITORS[action](bone_data);
        const label = `Bone rigging: ${action}`;
        const result = edit.animations?.length
          ? runUndoableAnimationEdit(
            { ...edit.aspects, animations: edit.animations },
            label,
            edit.apply,
            edit.finishAspects && { ...edit.finishAspects, animations: edit.animations }
          )
          : runUndoableEdit(edit.aspects, label, edit.apply, edit.finishAspects);
        Canvas.updateAll();

        return result;
      },
    },
    animationToolDocs[3].status
  );
}
