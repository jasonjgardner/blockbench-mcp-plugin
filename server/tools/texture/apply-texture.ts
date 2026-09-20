/// <reference types="blockbench-types" />

/** Maps apply_texture's `applyTo` option to `Texture.apply`: every face, blank faces only, or no faces. */
const APPLY_TO_FACES = { all: true, blank: "blank", none: false } as const;

/** apply_texture's `applyTo` option. */
export type ApplyToMode = keyof typeof APPLY_TO_FACES;

/** Element types whose faces can receive a texture. */
export type PaintableElement = Cube | Mesh;

/** Selection captured before apply_texture temporarily replaces it. */
interface ISelectionSnapshot {
  cubes: Cube[];
  meshes: Mesh[];
  groups: Group[];
}

/** Depth-first list of every cube and mesh below `group`, in outliner order. */
function collectPaintableDescendants(group: Group): PaintableElement[] {
  return (group.children ?? []).flatMap(child => {
    if (child instanceof Cube || child instanceof Mesh) return [child];
    return child instanceof Group ? collectPaintableDescendants(child) : [];
  });
}

/**
 * Resolves apply_texture's target to the concrete elements to texture:
 * a group expands to all descendant cubes and meshes; a cube or mesh is itself.
 *
 * @param element - Element or group found for `id`.
 * @param id - Original ID or name, used in the error message.
 * @returns Paintable elements in outliner order (empty for a group without any).
 * @throws When the element is not a group, cube, or mesh.
 */
export function resolveTextureTargets(element: OutlinerElement | Group, id: string): PaintableElement[] {
  if (element instanceof Group) return collectPaintableDescendants(element);
  if (element instanceof Cube || element instanceof Mesh) return [element];
  throw new Error(`Element "${id}" is not a cube, mesh, or group — cannot apply texture to it.`);
}

/**
 * Names the kind of element apply_texture was scoped by, for the result message.
 *
 * @param element - Element previously accepted by {@link resolveTextureTargets}.
 * @returns `"group"`, `"cube"`, or `"mesh"`.
 */
export function describeTargetKind(element: OutlinerElement | Group): string {
  if (element instanceof Group) return "group";
  return element instanceof Cube ? "cube" : "mesh";
}

/** Unselects every cube and mesh. */
function clearElementSelection(): void {
  Cube.all.forEach((cube: Cube) => {
    if (cube.selected) cube.unselect?.();
  });
  Mesh.all.forEach((mesh: Mesh) => {
    if (mesh.selected) mesh.unselect?.();
  });
}

/** Adds elements to the selection with shift-click semantics, keeping earlier selections. */
function addToSelection(elements: PaintableElement[]): void {
  elements.forEach(element => {
    // @ts-ignore - select method available on outliner elements
    element.select?.({ shiftKey: true });
  });
}

/** Restores the cube, mesh, and group selection captured before the edit. */
function restoreSelection(snapshot: ISelectionSnapshot): void {
  clearElementSelection();
  addToSelection(snapshot.cubes);
  addToSelection(snapshot.meshes);
  // Group.selected is a list in Blockbench 5; restore membership and the group's own
  // selected flag (what the outliner renders) without re-running click selection.
  snapshot.groups.forEach(group => {
    if (!Group.multi_selected.includes(group)) Group.multi_selected.push(group);
    group.selected = true;
  });
  updateSelection();
}

/**
 * Applies `projectTexture` to exactly `targets` as one undo edit, leaving the
 * caller's selection unchanged afterwards and refreshing face materials.
 *
 * @param projectTexture - Texture to apply.
 * @param targets - Elements resolved by {@link resolveTextureTargets}.
 * @param applyTo - Which faces receive the texture.
 */
export function applyTextureToTargets(projectTexture: Texture, targets: PaintableElement[], applyTo: ApplyToMode): void {
  // Save prior selection so the call is non-destructive to UI state.
  const previousSelection: ISelectionSnapshot = {
    cubes: [...Cube.selected],
    meshes: [...Mesh.selected],
    groups: [...Group.multi_selected],
  };
  // Undo must capture the element face-texture state, not just outliner.
  Undo.initEdit({ elements: targets, outliner: false, collections: [] });
  try {
    // Replace selection with the resolved targets so Texture.apply()
    // operates on exactly this scope.
    clearElementSelection();
    addToSelection(targets);
    updateSelection();
    projectTexture.select();
    Texture.selected?.apply(APPLY_TO_FACES[applyTo]);
    projectTexture.updateChangesAfterEdit();
  } finally {
    restoreSelection(previousSelection);
  }
  Undo.finishEdit("Agent applied texture");
  // Force face-level render refresh so the viewport matches the data.
  // Canvas.updateAll() alone sometimes doesn't push new face materials
  // into the THREE.js render targets.
  Canvas.updateView({
    elements: targets,
    element_aspects: { faces: true, uv: true, geometry: false },
  });
  Canvas.updateAll();
}
