import type { ToolCondition } from "@/server/tool-conditions";

/**
 * Evaluates the native Blockbench condition branches used by current tool
 * specifications: mode/format alternatives, required features, project presence,
 * wrapped conditions, and runtime methods. Install as the `Condition` global
 * alongside each fixture's Project, Format, and Modes state.
 *
 * The ordering follows Blockbench's `js/util/util.js`. Unexpected selection or
 * selected-tool rules throw so fixtures cannot silently make a newly restricted
 * operation available without modeling the required host selection.
 *
 * @param condition - A tool or toolbar condition from a production declaration.
 * @returns Whether the installed host state satisfies every declared rule.
 */
export function evaluateHostCondition(condition: ToolCondition): boolean {
  if (condition === undefined) return true;
  if (typeof condition === "boolean") return condition;
  if (typeof condition === "function") return condition();
  if (condition.condition !== undefined) return evaluateHostCondition(condition.condition);
  if (condition.selected || condition.tools) throw new Error("This fixture must model selection-dependent conditions.");
  if (condition.modes && !condition.modes.includes(Modes.id)) return false;
  if (condition.formats && !condition.formats.includes(Format.id)) return false;
  if (condition.features && Format && condition.features.some(feature => !Reflect.get(Format, feature))) return false;
  if (condition.project && !Project) return false;
  return condition.method?.() ?? true;
}
