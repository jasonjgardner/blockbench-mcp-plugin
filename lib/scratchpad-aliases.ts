/**
 * Lets host items gated to Blockbench's `edit` mode also accept a plugin mode.
 *
 * Native `Tool`, `Action`, and `Panel` conditions are `{ modes: [...] }` arrays
 * evaluated against `Modes.id`, so a plugin-registered mode is otherwise
 * invisible to every toolbar tool, menu action, and side panel. The arrays are
 * host state shared with the condition objects (a `Tool` reuses its `modes`
 * array as its condition), so they are extended in place and restored later.
 *
 * Pure with respect to Blockbench globals: callers pass the registries.
 *
 * @module
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === "string");
}

/** Mode arrays declared directly on an item and inside its structured condition. */
function modeArraysOf(item: unknown): string[][] {
  if (!isRecord(item)) return [];
  const own = isStringArray(item.modes) ? [item.modes] : [];
  const condition = isRecord(item.condition) && isStringArray(item.condition.modes) ? [item.condition.modes] : [];
  return [...own, ...condition];
}

/**
 * Collects every mode array from the given registries (for example `BarItems`
 * and `Panels`). Duplicate references are kept; {@link aliasEditMode} de-dupes.
 */
export function collectModeArrays(registries: Iterable<Record<string, unknown>>): string[][] {
  return [...registries].flatMap(registry => Object.values(registry).flatMap(modeArraysOf));
}

/**
 * Appends `alias` to every array that lists `edit` and does not yet list the
 * alias, recording each touched array in `aliased` so it can be reverted.
 */
export function aliasEditMode(alias: string, arrays: Iterable<string[]>, aliased: Set<string[]>): void {
  [...arrays].forEach(modes => {
    if (!modes.includes("edit") || modes.includes(alias)) return;
    modes.push(alias);
    aliased.add(modes);
  });
}

/** Removes `alias` from every array recorded by {@link aliasEditMode} and forgets them. */
export function removeEditAlias(alias: string, aliased: Set<string[]>): void {
  aliased.forEach(modes => {
    const index = modes.indexOf(alias);
    if (index >= 0) modes.splice(index, 1);
  });
  aliased.clear();
}
