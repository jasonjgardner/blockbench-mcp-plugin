/**
 * A texture-pixel position sampled by the brush, matching the `{ x, y }`
 * entries of `paint_with_brush` coordinates.
 */
export interface IPaintPoint {
  x: number;
  y: number;
}

/**
 * Upper bound on brush samples produced for one connected `paint_with_brush`
 * call. Interpolating far-apart coordinates pixel by pixel could otherwise
 * freeze Blockbench's UI thread or exhaust memory in a single tool call.
 */
export const MAX_BRUSH_SAMPLES = 100000;

/**
 * Expands brush coordinates into the samples the brush should stamp.
 *
 * With `connect` the stroke is interpolated so consecutive samples are no more
 * than one texture pixel apart on either axis (the start point is kept as-is,
 * each later coordinate ends its segment); without it the coordinates are
 * returned unchanged. The sample total is checked before any interpolation is
 * allocated.
 *
 * @param coordinates - Stroke coordinates in texture pixels, in drawing order.
 * @param connect - Whether to interpolate between consecutive coordinates.
 * @returns A new array of samples in drawing order.
 * @throws Error when any coordinate is not finite, or when a connected stroke
 *   would exceed {@link MAX_BRUSH_SAMPLES} samples.
 */
export function brushStrokeCoordinates(coordinates: IPaintPoint[], connect: boolean): IPaintPoint[] {
  if (coordinates.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    throw new Error("Brush coordinates must be finite texture positions.");
  }
  if (!connect) return [...coordinates];
  // The first coordinate contributes itself; every later one contributes its segment's steps.
  const sampleCounts = coordinates.map((point, index) => (index === 0 ? 1 : segmentSteps(coordinates[index - 1], point)));
  const totalSamples = sampleCounts.reduce((total, count) => total + count, 0);
  if (totalSamples > MAX_BRUSH_SAMPLES) {
    throw new Error(`Connected brush strokes exceed ${MAX_BRUSH_SAMPLES} samples. Split the stroke into shorter calls.`);
  }
  return coordinates.flatMap((point, index) => (
    index === 0 ? [point] : interpolateSegment(coordinates[index - 1], point, sampleCounts[index])
  ));
}

/** Number of one-pixel-or-shorter steps needed to travel from `previous` to `point`. */
function segmentSteps(previous: IPaintPoint, point: IPaintPoint): number {
  return Math.ceil(Math.max(Math.abs(point.x - previous.x), Math.abs(point.y - previous.y)));
}

/** Evenly spaced samples after `previous` up to and including `point`; empty when the points coincide. */
function interpolateSegment(previous: IPaintPoint, point: IPaintPoint, steps: number): IPaintPoint[] {
  return Array.from({ length: steps }, (_, step) => ({
    x: previous.x + (point.x - previous.x) * (step + 1) / steps,
    y: previous.y + (point.y - previous.y) * (step + 1) / steps,
  }));
}
