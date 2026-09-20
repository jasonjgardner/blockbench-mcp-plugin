/**
 * Pure helpers for Blockbench's animation "Variable Placeholders" text
 * (`Project.variable_placeholders`). Free of Blockbench globals so they can be
 * unit tested and imported by the documentation build.
 *
 * Each placeholder is one `variable = expression` line. Blockbench 5.2 turns
 * `slider('name', step, min, max)`, `toggle('name')` and
 * `impulse('name', duration)` expressions into preview controls.
 *
 * @module
 */

/** A constant or Molang expression assigned to a variable. */
export interface IValuePlaceholder {
  type: "value";
  variable: string;
  value: number | string;
}

/** A draggable numeric slider control; `range` is `[min, max]`. */
export interface ISliderPlaceholder {
  type: "slider";
  variable: string;
  name: string;
  step?: number;
  range?: [number, number];
}

/** A checkbox control yielding 0 or 1. */
export interface ITogglePlaceholder {
  type: "toggle";
  variable: string;
  name: string;
}

/** A button yielding 1 for `duration` seconds after being pressed. */
export interface IImpulsePlaceholder {
  type: "impulse";
  variable: string;
  name: string;
  duration?: number;
}

/** Any placeholder line the native "Create Variable Placeholder" dialog can produce. */
export type PlaceholderEntry = IValuePlaceholder | ISliderPlaceholder | ITogglePlaceholder | IImpulsePlaceholder;

/** One parsed `variable = expression` line, with the variable in its canonical long form. */
export interface IPlaceholderLine {
  variable: string;
  expression: string;
}

/** Molang short prefixes Blockbench expands when reading placeholder lines. */
const PREFIX_ALIASES: readonly (readonly [RegExp, string])[] = [
  [/^v\./, "variable."],
  [/^q\./, "query."],
  [/^t\./, "temp."],
  [/^c\./, "context."],
];

/**
 * Canonicalizes a placeholder key like Blockbench's `processVariablePlaceholderText`:
 * strips whitespace and semicolons, then expands `v.`/`q.`/`t.`/`c.` prefixes.
 *
 * @param key - Raw left-hand side, e.g. `" v.speed "`.
 * @returns The canonical name, e.g. `"variable.speed"`.
 */
export function normalizePlaceholderVariable(key: string): string {
  const stripped = key.replace(/[\s;]/g, "");
  return PREFIX_ALIASES.reduce((name, [pattern, replacement]) => name.replace(pattern, replacement), stripped);
}

/** Splits one line at its first `=` exactly like the native parser; `undefined` for non-assignments. */
function parseLine(line: string): IPlaceholderLine | undefined {
  const [key = "", expression] = line.split(/=\s*(.+)/);
  if (expression === undefined) return undefined;
  return { variable: normalizePlaceholderVariable(key), expression: expression.trim() };
}

/**
 * Parses placeholder text into assignments, skipping blank lines, comments and
 * any line without a right-hand side. Later lines win for duplicate variables
 * at runtime, but every line is reported in order.
 *
 * @param text - Full `Project.variable_placeholders` text.
 * @returns Parsed assignments in line order.
 */
export function parsePlaceholderLines(text: string): IPlaceholderLine[] {
  return text.split("\n").flatMap((line) => parseLine(line) ?? []);
}

/** Quotes a control name the way the native dialog does. */
const quote = (name: string): string => `'${name}'`;

/** Builders for each placeholder type, matching the native dialog's `getExpression()`. */
const EXPRESSION_BUILDERS: { [K in PlaceholderEntry["type"]]: (entry: Extract<PlaceholderEntry, { type: K }>) => string } = {
  value: ({ value }) => String(value),
  slider: ({ name, step, range }) => {
    const stepArgs = step !== undefined || range ? [step ?? 1] : [];
    return `slider(${[quote(name), ...stepArgs, ...(range ?? [])].join(", ")})`;
  },
  toggle: ({ name }) => `toggle(${quote(name)})`,
  impulse: ({ name, duration }) => `impulse(${[quote(name), ...(duration ? [duration] : [])].join(", ")})`,
};

/**
 * Builds one placeholder line in the exact syntax Blockbench 5.2's
 * `create_variable_placeholder` dialog writes, e.g.
 * `variable.speed = slider('speed', 0.1, 0, 2)`.
 *
 * @param entry - Structured placeholder definition.
 * @returns The single-line assignment.
 */
export function buildPlaceholderLine(entry: PlaceholderEntry): string {
  const build = EXPRESSION_BUILDERS[entry.type] as (value: PlaceholderEntry) => string;
  return `${entry.variable} = ${build(entry)}`;
}

/**
 * Appends a line the way the native dialog does: trailing whitespace is
 * trimmed, then the line is added on its own row.
 *
 * @param text - Existing placeholder text.
 * @param line - Line to append.
 * @returns New text; the input is not modified.
 */
export function appendPlaceholderLine(text: string, line: string): string {
  const trimmed = text.replace(/[\n\s]+$/, "");
  return trimmed ? `${trimmed}\n${line}` : line;
}

/** True when `line` assigns `variable`, comparing canonical names. */
function assigns(line: string, variable: string): boolean {
  return parseLine(line)?.variable === normalizePlaceholderVariable(variable);
}

/**
 * Replaces the first assignment of the line's variable in place and drops any
 * later duplicates, or appends the line when the variable is not assigned yet.
 *
 * @param text - Existing placeholder text.
 * @param variable - Variable the line assigns (aliases such as `v.` match).
 * @param line - Replacement line.
 * @returns New text and whether an existing assignment was replaced.
 */
export function upsertPlaceholderLine(text: string, variable: string, line: string): { text: string; replaced: boolean } {
  const lines = text.split("\n");
  const first = lines.findIndex((candidate) => assigns(candidate, variable));
  if (first === -1) return { text: appendPlaceholderLine(text, line), replaced: false };
  const updated = lines
    .map((candidate, index) => (index === first ? line : candidate))
    .filter((candidate, index) => index <= first || !assigns(candidate, variable));
  return { text: updated.join("\n"), replaced: true };
}

/**
 * Removes every assignment of `variable`, leaving other lines untouched.
 *
 * @param text - Existing placeholder text.
 * @param variable - Variable to remove (aliases such as `v.` match).
 * @returns New text and how many lines were removed.
 */
export function removePlaceholderVariable(text: string, variable: string): { text: string; removed: number } {
  const lines = text.split("\n");
  const kept = lines.filter((line) => !assigns(line, variable));
  return { text: kept.join("\n"), removed: lines.length - kept.length };
}
