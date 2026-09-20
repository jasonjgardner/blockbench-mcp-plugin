/// <reference types="blockbench-types" />
import type { z } from "zod";
import { createTool } from "@/lib/factories";
import { animationToolDocs } from "./docs";
import { listMolangVariablesParameters, variablePlaceholdersParameters } from "./schemas";
import {
  buildPlaceholderLine,
  normalizePlaceholderVariable,
  parsePlaceholderLines,
  removePlaceholderVariable,
  upsertPlaceholderLine,
  appendPlaceholderLine,
  type IPlaceholderLine,
} from "./variable-placeholders-text";

type PlaceholdersInput = z.infer<typeof variablePlaceholdersParameters>;
type PlaceholderAction = PlaceholdersInput["action"];

/** One live preview control parsed by the native panel's `updateButtons()`. */
interface IPlaceholderButton {
  type: "slider" | "toggle" | "impulse";
  id: string;
  value: number | string;
  variable?: string;
  step?: number;
  min?: number;
  max?: number;
  duration?: number;
}

/** Native `panel-placeholders` Vue component data (absent from blockbench-types). */
interface IPlaceholderPanelVue {
  text: string;
  buttons: IPlaceholderButton[];
}

/** Runtime Molang parser fields used here; the published type is the generic molangjs class. */
interface IMolangParserRuntime {
  global_variables: object;
  variables: Record<string, unknown>;
}

/** A text change produced by an action, plus the variables whose cached values must be dropped. */
interface IPlaceholderChange {
  text: string;
  variables: string[];
  message: string;
  initial?: { name: string; value: number };
}

/** Detached description of one built-in Molang variable. */
interface IBuiltInVariable {
  name: string;
  kind: "constant" | "dynamic" | "function";
  value: number | string | null;
  arguments?: number;
}

/** Delay matching the native dialog, letting the panel's Vue watcher sync the project and controls. */
const PANEL_SYNC_DELAY_MS = 50;

/** Query-function reference the native "View Built-in Variables" dialog links to. */
const QUERY_FUNCTION_DOCS =
  "https://learn.microsoft.com/en-us/minecraft/creator/reference/content/molangreference/examples/molangconcepts/queryfunctions?view=minecraft-bedrock-stable";

/**
 * Rejects projects whose format cannot use placeholders: no project, no
 * animation mode, or a format declaring `molang: false` (Blockbench 5.2).
 * @throws With an actionable message.
 */
function assertPlaceholdersSupported(): void {
  if (!Project || !Format.animation_mode || Format.molang === false) {
    throw new Error("Variable placeholders need an open project whose format supports animation and Molang. Use get_capabilities to check animation_mode and molang.");
  }
}

/**
 * Returns the native Variable Placeholders panel component.
 * @throws When the running Blockbench has no such panel.
 */
function getPanelVue(): IPlaceholderPanelVue {
  const vue: unknown = Interface.Panels.variable_placeholders?.inside_vue;
  if (!vue || typeof vue !== "object" || !("buttons" in vue)) {
    throw new Error("The Variable Placeholders panel is unavailable in this Blockbench build.");
  }
  return vue as IPlaceholderPanelVue;
}

/** The Molang parser behind animation previews. */
function getMolangParser(): IMolangParserRuntime {
  return Animator.MolangParser as unknown as IMolangParserRuntime;
}

/** Reads the project's current placeholder text; the property is unset on fresh projects. */
function currentText(): string {
  const text: unknown = Project?.variable_placeholders;
  return typeof text === "string" ? text : "";
}

/** Copies live controls so callers cannot mutate panel state. */
function snapshotControls(vue: IPlaceholderPanelVue): IPlaceholderButton[] {
  return vue.buttons.map((button) => ({ ...button }));
}

/** Detached text, parsed lines and live controls. */
function snapshot(vue: IPlaceholderPanelVue): { text: string; lines: IPlaceholderLine[]; controls: IPlaceholderButton[] } {
  const text = currentText();
  return { text, lines: parsePlaceholderLines(text), controls: snapshotControls(vue) };
}

/**
 * Writes placeholder text through the native panel so its Vue watcher updates
 * `Project.variable_placeholders`, `Animator.global_variable_lines` and the
 * preview controls, exactly like typing into the panel. Cached values of the
 * affected variables are dropped and the animation preview refreshed.
 */
async function applyChange(vue: IPlaceholderPanelVue, change: IPlaceholderChange): Promise<void> {
  if (!Project) throw new Error("The project was closed before placeholders could be written.");
  Project.variable_placeholders = change.text;
  vue.text = change.text;
  await new Promise((resolve) => setTimeout(resolve, PANEL_SYNC_DELAY_MS));
  const initial = change.initial;
  const button = initial && vue.buttons.find(({ id }) => id === initial.name);
  if (button && initial) button.value = initial.value;
  const parser = getMolangParser();
  change.variables.forEach((variable) => Reflect.deleteProperty(parser.variables, variable));
  if (Modes.animate) Animator.preview();
}

/** Builds the `add` change, upserting by default like a keyed edit instead of the native plain append. */
function planAdd({ entry, replace_existing }: PlaceholdersInput): IPlaceholderChange {
  if (!entry) throw new Error("entry is required for add.");
  const line = buildPlaceholderLine(entry);
  const variable = normalizePlaceholderVariable(entry.variable);
  const initial = "initial_value" in entry && entry.initial_value !== undefined
    ? { name: entry.name, value: entry.initial_value }
    : undefined;
  if (!replace_existing) {
    return { text: appendPlaceholderLine(currentText(), line), variables: [variable], message: `Appended: ${line}`, initial };
  }
  const result = upsertPlaceholderLine(currentText(), entry.variable, line);
  return { text: result.text, variables: [variable], message: `${result.replaced ? "Replaced" : "Appended"}: ${line}`, initial };
}

/** Builds the `set` change; every previously or newly assigned variable is reset. */
function planSet({ text }: PlaceholdersInput): IPlaceholderChange {
  if (text === undefined) throw new Error("text is required for set.");
  const variables = [...parsePlaceholderLines(currentText()), ...parsePlaceholderLines(text)].map(({ variable }) => variable);
  return { text, variables: [...new Set(variables)], message: `Replaced placeholder text (${parsePlaceholderLines(text).length} assignments).` };
}

/** Builds the `remove` change. @throws When the variable is not assigned. */
function planRemove({ variable }: PlaceholdersInput): IPlaceholderChange {
  if (!variable) throw new Error("variable is required for remove.");
  const result = removePlaceholderVariable(currentText(), variable);
  if (result.removed === 0) throw new Error(`No placeholder line assigns "${variable}".`);
  return { text: result.text, variables: [normalizePlaceholderVariable(variable)], message: `Removed ${result.removed} line(s) for ${variable}.` };
}

/** Change planners for every mutating action. */
const PLACEHOLDER_PLANNERS: Record<Exclude<PlaceholderAction, "get">, (input: PlaceholdersInput) => IPlaceholderChange> = {
  add: planAdd,
  remove: planRemove,
  set: planSet,
};

/** Describes one global without letting a throwing getter break the listing. */
function describeGlobal(name: string, descriptor: PropertyDescriptor, globals: object): IBuiltInVariable | undefined {
  if (typeof descriptor.value === "function") {
    return { name, kind: "function", value: null, arguments: (descriptor.value as (...args: unknown[]) => unknown).length };
  }
  const raw: unknown = descriptor.get ? readGetter(globals, name) : descriptor.value;
  const kind = descriptor.get ? "dynamic" : "constant";
  if (typeof raw === "number") return { name, kind, value: Math.round(raw * 1e5) / 1e5 };
  if (typeof raw === "string") return { name, kind, value: raw };
  return descriptor.get ? { name, kind, value: null } : undefined;
}

/** Evaluates a live getter such as `query.anim_time`; host state may make it throw. */
function readGetter(globals: object, name: string): unknown {
  try {
    return Reflect.get(globals, name);
  } catch {
    return undefined;
  }
}

/**
 * Lists `Animator.MolangParser.global_variables` like the native
 * "View Built-in Variables" dialog, skipping `true`/`false`.
 */
function listBuiltInVariables(filter: string | undefined): IBuiltInVariable[] {
  const globals = getMolangParser().global_variables;
  const needle = filter?.toLowerCase() ?? "";
  return Object.entries(Object.getOwnPropertyDescriptors(globals))
    .filter(([name]) => name !== "true" && name !== "false" && name.toLowerCase().includes(needle))
    .flatMap(([name, descriptor]) => describeGlobal(name, descriptor, globals) ?? [])
    .toSorted((first, second) => first.name.localeCompare(second.name));
}

/**
 * Registers `variable_placeholders` and `list_molang_variables`, the MCP
 * counterparts of Blockbench 5.2's Variable Placeholders panel,
 * `create_variable_placeholder` and `view_built_in_variables` actions.
 * Call only after Blockbench globals exist.
 */
export function registerVariablePlaceholderTools(): void {
  createTool(animationToolDocs[7].name, {
    ...animationToolDocs[7],
    parameters: variablePlaceholdersParameters,
    async execute(input) {
      assertPlaceholdersSupported();
      const vue = getPanelVue();
      if (input.action === "get") return JSON.stringify(snapshot(vue));
      const change = PLACEHOLDER_PLANNERS[input.action](input);
      await applyChange(vue, change);
      return JSON.stringify({ message: change.message, ...snapshot(vue) });
    },
  }, animationToolDocs[7].status);

  createTool(animationToolDocs[8].name, {
    ...animationToolDocs[8],
    parameters: listMolangVariablesParameters,
    async execute({ filter }) {
      if (typeof Animator === "undefined" || !Animator.MolangParser) {
        throw new Error("The Molang parser is unavailable in this Blockbench build.");
      }
      const variables = listBuiltInVariables(filter);
      return JSON.stringify({
        count: variables.length,
        variables,
        placeholders: parsePlaceholderLines(currentText()),
        query_function_docs: Format?.molang === false ? undefined : QUERY_FUNCTION_DOCS,
      });
    },
  }, animationToolDocs[8].status);
}
