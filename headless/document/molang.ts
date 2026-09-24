/**
 * Molang sign inversion, ported from Blockbench `js/util/molang.ts`
 * (`invertMolang`, `processMolangReturn`).
 *
 * Blockbench 5.0 flipped the sign convention of position/rotation X and
 * rotation Y keyframes. Converting a file between 4.x and 5.0 must negate
 * those values, and they may be Molang expressions rather than numbers, so the
 * negation has to rewrite the expression the same way Blockbench does.
 *
 * @module
 */

const STRING_NUMBER = /^-?\d+(\.\d+f?)?$/;
const BRACKET_OPEN = "{([";
const BRACKET_CLOSE = "})]";

/**
 * Applies `callback` to the value-producing part of a Molang program: every
 * `return` expression, or the last statement when there is no `return`.
 */
export function processMolangReturn(molang: string, callback: (expression: string) => string): string {
  if (molang.includes("return ")) {
    return molang.replace(/return (.+?)(;|$)/g, (_match, expression: string, end: string) => `return ${callback(expression)}${end}`);
  }
  const trimmed = molang.replace(/;+$/, "");
  const lastSemicolon = trimmed.lastIndexOf(";");
  if (lastSemicolon === -1) return trimmed.includes("=") ? `${trimmed};${callback("")}` : callback(trimmed);
  const before = trimmed.substring(0, lastSemicolon);
  const after = trimmed.substring(lastSemicolon + 1);
  if (after.includes("=")) return `${trimmed};${callback("")}`;
  return `${before};${callback(after)}`;
}

interface IInvertState {
  invert: boolean;
  depth: number;
  lastOperator: string | undefined;
  result: string;
}

/** Folds one character into the inversion state (a direct port of Blockbench's loop body). */
function invertStep(state: IInvertState, char: string): IInvertState {
  const nextDepth = state.depth + (BRACKET_OPEN.includes(char) ? 1 : 0) - (BRACKET_CLOSE.includes(char) ? 1 : 0);
  if (state.depth !== 0) return { ...state, depth: nextDepth, result: state.result + char };

  const afterMulDiv = state.lastOperator === "*" || state.lastOperator === "/";
  if (char === "-" && !afterMulDiv) {
    const prefix = !state.invert && !state.lastOperator ? "+" : "";
    return { ...state, invert: false, result: state.result + prefix };
  }
  if (char === "+" && !afterMulDiv) return { ...state, invert: false, result: `${state.result}-` };

  const isSpace = char === " " || char === "\n";
  const isTernary = "?:".includes(char);
  const isOperator = "+-*/&|".includes(char);
  const emitsMinus = !isSpace && !isTernary && state.invert;
  const operator = isTernary || (!emitsMinus && !isSpace && isOperator) ? char : undefined;
  return {
    invert: isTernary || (!emitsMinus && state.invert),
    depth: nextDepth,
    lastOperator: isSpace ? state.lastOperator : operator,
    result: state.result + (emitsMinus ? "-" : "") + char,
  };
}

/**
 * Negates a keyframe value. Numbers are negated; numeric strings stay strings;
 * Molang expressions are rewritten so they evaluate to the negated value.
 *
 * @param molang - A number or Molang expression such as `"math.sin(q.anim_time * 90) * 10"`.
 * @returns The negated value, in the same type as the input.
 */
export function invertMolang(molang: string | number): string | number {
  if (typeof molang === "number") return -molang;
  if (molang === "" || molang === "0") return molang;
  if (STRING_NUMBER.test(molang)) return (-parseFloat(molang)).toString();
  return processMolangReturn(molang, (expression) =>
    [...expression].reduce(invertStep, { invert: true, depth: 0, lastOperator: undefined, result: "" }).result,
  );
}
