/// <reference types="blockbench-types" />
import { runUndoableEdit } from "@/lib/undo";

/** Parent reference (and Blockbench `addTo` target) meaning the project's top outliner level. */
const ROOT_PARENT = "root";

/**
 * Creates one group and reparents existing nodes in a single reversible edit.
 * References are existing UUIDs or names; `root` targets the project root.
 * Both group properties and the UUID-only outliner hierarchy must be tracked:
 * tracking only the outliner leaves a newly created group alive after Undo.
 * All references and hierarchy cycles are checked before starting the edit.
 * The optional initializer runs inside the same transaction for bone settings.
 *
 * @param options - Native group options such as `name`, `origin`, and `rotation`.
 * @param parentReference - UUID or name of the parent group, or `"root"` (default) for the project root.
 *   UUID matches take precedence over name matches.
 * @param childReferences - UUIDs or names of existing groups/elements to move into the new group;
 *   duplicate references collapse to one child.
 * @param initialize - Optional callback run inside the same Undo edit after reparenting and before
 *   the preview refresh, e.g. to apply bone settings.
 * @param label - Undo history label for the finished edit.
 * @returns The initialized group, including its native UUID.
 * @throws When no project is open, a reference is missing, a child is the parent or its ancestor
 *   (all before Undo starts), or the format rejects the hierarchy (reverted inside the edit).
 */
export function createGroupWithUndo(
  options: Partial<GroupOptions>,
  parentReference = ROOT_PARENT,
  childReferences: string[] = [],
  initialize?: (group: Group) => void,
  label = "Agent added group",
): Group {
  if (typeof Project === "undefined" || !Project) throw new Error("Open a project before creating a group.");
  const parent = parentReference === ROOT_PARENT ? ROOT_PARENT :
    Group.all.find(group => group.uuid === parentReference) ?? Group.all.find(group => group.name === parentReference);
  if (!parent) throw new Error(`Parent group "${parentReference}" not found. Use list_outline to inspect group UUIDs and names.`);
  const nodes = [...Group.all, ...Outliner.elements];
  const children = [...new Set(childReferences.map(reference => {
    const child = nodes.find(node => node.uuid === reference) ?? nodes.find(node => node.name === reference);
    if (!child) throw new Error(`Child "${reference}" not found. Use list_outline to inspect element UUIDs and names.`);
    return child;
  }))];
  if (parent !== ROOT_PARENT && children.some(child => child === parent || parent.isChildOf(child, Infinity))) {
    throw new Error("A new group's children cannot include its parent or an ancestor of its parent.");
  }
  // Undo re-reads this aspect array when finishing, so the new group is tracked once pushed.
  const groups: Group[] = [];
  return runUndoableEdit({ groups, outliner: true }, label, () => {
    const group = new Group(options);
    groups.push(group);
    group.init().addTo(parent);
    if (group.parent !== parent) throw new Error("The current format does not allow the requested group parent.");
    children.forEach(child => {
      child.addTo(group);
      if (child.parent !== group) throw new Error(`The current format does not allow "${child.name}" inside the new group.`);
    });
    initialize?.(group);
    Canvas.updateAll();
    return group;
  });
}
