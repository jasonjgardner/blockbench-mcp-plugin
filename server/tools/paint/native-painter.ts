/// <reference types="three" />
/// <reference types="blockbench-types" />
import { cancelUndoEdit } from "@/lib/undo";

/**
 * Native stroke members omitted from published blockbench-types, verified in the
 * desktop Painter implementation (`js/texturing/painter.js`).
 *
 * `paint_stroke_canceled` is set by `startPaintTool` when Blockbench refuses a
 * stroke (stylus-only mode, pointer target busy, brush `onStrokeStart` veto);
 * `brushChanges` tells `stopPaintTool` whether to commit the pending undo entry.
 */
export interface INativePainter {
  paint_stroke_canceled?: boolean;
  brushChanges: boolean;
  current: { element?: unknown; face?: unknown; face_matrices?: unknown };
  startPaintTool(texture: Texture, x: number, y: number, uvTag: unknown, event: Record<string, unknown>): void;
  movePaintTool(texture: Texture, x: number, y: number, event: Record<string, unknown>): void;
  useShapeTool(texture: Texture, x: number, y: number, event: Record<string, unknown>): void;
  useGradientTool(texture: Texture, x: number, y: number, event: Record<string, unknown>): void;
  stopPaintTool(): void;
}

/**
 * One phase of a native stroke (start or move). It receives the live, typed
 * Painter so callers never cast the global themselves.
 */
export type PaintStrokeStep = (painter: INativePainter) => void;

/** Error text when Blockbench refuses a stroke; callers and tests match on "canceled". */
const CANCELED_STROKE_MESSAGE = "Blockbench canceled this paint stroke. Check paint mode, stylus-only settings, and the selected tool.";

/**
 * Returns the Blockbench `Painter` global with its undeclared stroke members typed.
 *
 * This is the single place the incomplete blockbench-types surface is widened;
 * it must only be called at runtime inside Blockbench, never at module load.
 */
function nativePainter(): typeof Painter & INativePainter {
  // Blockbench types omit the stroke API; the intersection keeps the declared members intact.
  return Painter as typeof Painter & INativePainter;
}

/** Guards against nested edits and resets viewport face context before a texture-coordinate stroke. */
function prepareTexturePaint(): INativePainter {
  if (Undo.current_save) throw new Error("A Blockbench edit is already in progress. Finish the active edit before painting.");
  const painter = nativePainter();
  // Match the UV editor's texture-coordinate entry point rather than inheriting
  // raycast element/face context from a previous viewport stroke.
  delete painter.current.element;
  delete painter.current.face;
  delete painter.current.face_matrices;
  return painter;
}

/**
 * Starts a native stroke at a texture-pixel coordinate, the way the UV editor does.
 *
 * `uvTag` is `undefined` because a truthy empty object makes Painter treat the
 * stroke as a mesh UV map with no vertices (no paintable pixels), and the
 * synthetic event disables shift-click line continuation from an earlier stroke.
 *
 * @param painter - Painter handed to a {@link PaintStrokeStep}.
 * @param texture - Texture being painted.
 * @param x - Texture-pixel X coordinate.
 * @param y - Texture-pixel Y coordinate.
 */
export function startTextureStroke(painter: INativePainter, texture: Texture, x: number, y: number): void {
  painter.startPaintTool(texture, x, y, undefined, { shiftKey: false });
}

/**
 * Runs one native stroke and lets Painter own its undo transaction.
 *
 * On success the stroke is stopped (committing history when pixels changed) and
 * any uncommitted snapshot left by an unchanged stroke is discarded. When the
 * stroke is canceled or throws, the pending edit is reverted and the stroke is
 * closed exactly once before the error propagates.
 *
 * @param start - Opens the stroke, typically via {@link startTextureStroke}.
 * @param move - Optional follow-up (drag, shape, or gradient end point).
 * @throws Error when an edit is already in progress or Blockbench cancels the
 *   stroke; the original stroke error otherwise; an `AggregateError` carrying
 *   both errors when closing the failed stroke also fails.
 */
export function nativePaintStroke(start: PaintStrokeStep, move?: PaintStrokeStep): void {
  const painter = prepareTexturePaint();
  try {
    start(painter);
    if (painter.paint_stroke_canceled) throw new Error(CANCELED_STROKE_MESSAGE);
    move?.(painter);
    painter.stopPaintTool();
    if (Undo.current_save) cancelUndoEdit(false);
  } catch (error) {
    rethrowAfterCleanup(error, abortPaintStroke(painter), "Paint stroke failed and Blockbench could not close it.");
  }
}

/**
 * Picks the copy brush source point (the Ctrl+click equivalent) as a closed native stroke.
 *
 * Blockbench's copy brush vetoes Ctrl strokes after recording the source, so no
 * history entry is created; the stroke is still stopped even if starting it throws.
 *
 * @param texture - Texture to sample.
 * @param x - Source texture-pixel X coordinate.
 * @param y - Source texture-pixel Y coordinate.
 * @throws Error when an edit is already in progress; the original start error,
 *   or an `AggregateError` when stopping the failed stroke also fails.
 */
export function setCopyBrushSource(texture: Texture, x: number, y: number): void {
  const painter = prepareTexturePaint();
  try {
    painter.startPaintTool(texture, x, y, undefined, { ctrlOrCmd: true });
  } catch (error) {
    rethrowAfterCleanup(error, attempt(() => painter.stopPaintTool()), "Setting the copy brush source failed and Blockbench could not close the stroke.");
  }
  painter.stopPaintTool();
}

/** Reverts and closes a failed stroke, collecting cleanup errors instead of masking the stroke's own failure. */
function abortPaintStroke(painter: INativePainter): unknown[] {
  const revertErrors = attempt(() => {
    if (Undo.current_save) cancelUndoEdit(true);
  });
  painter.brushChanges = false;
  return [...revertErrors, ...attempt(() => painter.stopPaintTool())];
}

/** Runs a cleanup action, returning its error (if any) as a list so callers can aggregate failures. */
function attempt(action: () => void): unknown[] {
  try {
    action();
    return [];
  } catch (error) {
    return [error];
  }
}

/** Rethrows the original failure, wrapping it with cleanup failures so neither is lost. */
function rethrowAfterCleanup(error: unknown, cleanupErrors: unknown[], message: string): never {
  if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], message);
  throw error;
}
