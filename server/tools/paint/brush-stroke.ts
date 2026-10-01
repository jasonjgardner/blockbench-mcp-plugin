/**
 * A texture-pixel position sampled by the brush, matching the `{ x, y }`
 * entries of `paint_with_brush` coordinates.
 */
export interface IPaintPoint {
  x: number;
  y: number;
}

/**
 * Upper bound on the one-pixel steps of one connected `paint_with_brush`
 * stroke. Blockbench's Painter draws a line between consecutive coordinates in
 * steps of at most one texture pixel, so far-apart coordinates could otherwise
 * freeze its UI thread in a single tool call.
 */
export const MAX_BRUSH_SAMPLES = 100000;

/**
 * Checks brush coordinates before a native stroke paints them.
 *
 * @param coordinates - Stroke coordinates in texture pixels, in drawing order.
 * @param connect - Whether Painter will draw lines between consecutive coordinates.
 * @throws Error when any coordinate is not finite, or when a connected stroke
 *   would take more than {@link MAX_BRUSH_SAMPLES} one-pixel steps.
 */
export function assertBrushStroke(coordinates: IPaintPoint[], connect: boolean): void {
  if (coordinates.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    throw new Error("Brush coordinates must be finite texture positions.");
  }
  if (!connect) return;
  // The first coordinate is one stamp; every later one adds its segment's steps.
  const totalSamples = coordinates.reduce((total, point, index) => total + (index === 0 ? 1 : segmentSteps(coordinates[index - 1], point)), 0);
  if (totalSamples > MAX_BRUSH_SAMPLES) {
    throw new Error(`Connected brush strokes exceed ${MAX_BRUSH_SAMPLES} samples. Split the stroke into shorter calls.`);
  }
}

/** Number of one-pixel-or-shorter steps needed to travel from `previous` to `point`. */
function segmentSteps(previous: IPaintPoint, point: IPaintPoint): number {
  return Math.ceil(Math.max(Math.abs(point.x - previous.x), Math.abs(point.y - previous.y)));
}
