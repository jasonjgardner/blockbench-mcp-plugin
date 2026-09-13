/// <reference types="blockbench-types" />

/**
 * Creates one group and reparents existing nodes in a single reversible edit.
 * References are existing UUIDs or names; `root` targets the project root.
 * Both group properties and the UUID-only outliner hierarchy must be tracked:
 * tracking only the outliner leaves a newly created group alive after Undo.
 * All references and hierarchy cycles are checked before starting the edit.
 * The optional initializer runs inside the same transaction for bone settings.
 *
 * @returns The initialized group, including its native UUID.
 */
export function createGroupWithUndo(
  options: Partial<GroupOptions>,
  parentReference = "root",
  childReferences: string[] = [],
  initialize?: (group: Group) => void,
  label = "Agent added group",
): Group {
  if (typeof Project === "undefined" || !Project) throw new Error("Open a project before creating a group.");
  const parent = parentReference === "root" ? "root" :
    Group.all.find(group => group.uuid === parentReference) ?? Group.all.find(group => group.name === parentReference);
  if (!parent) throw new Error(`Parent group "${parentReference}" not found. Use list_outline to inspect group UUIDs and names.`);
  const nodes = [...Group.all, ...Outliner.elements];
  const children = [...new Set(childReferences.map(reference => {
    const child = nodes.find(node => node.uuid === reference) ?? nodes.find(node => node.name === reference);
    if (!child) throw new Error(`Child "${reference}" not found. Use list_outline to inspect element UUIDs and names.`);
    return child;
  }))];
  if (parent !== "root" && children.some(child => child === parent || parent.isChildOf(child, Infinity))) {
    throw new Error("A new group's children cannot include its parent or an ancestor of its parent.");
  }
  const groups: Group[] = [];
  Undo.initEdit({ groups, outliner: true });
  try {
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
    Undo.finishEdit(label);
    return group;
  } catch (error) {
    (Undo.cancelEdit as (revert?: boolean) => void)(true);
    throw error;
  }
}
