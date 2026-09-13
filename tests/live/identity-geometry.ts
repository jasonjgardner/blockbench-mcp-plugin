/** A two-dimensional point in the official mark's 180-unit SVG coordinates. */
type Point = [number, number];

/** Vertices and faces of one mesh piece; face entries index into the combined vertex list. */
interface IMeshPart {
  vertices: number[][];
  faces: number[][];
}

/** Indexed solid mesh accepted by place_mesh; coordinates use Blockbench units. */
export interface IIdentityMesh extends IMeshPart {
  name: string;
}

/** One SVG path command: a line to `end`, or a cubic Bézier to `end` through two control points. */
interface ISegment {
  end: Point;
  controls?: [Point, Point];
}

/** A named reference SVG path traced as one ribbon mesh. */
interface IReferencePath {
  name: string;
  start: Point;
  segments: ISegment[];
}

/** Samples emitted per cubic curve (excluding its start point, which the previous segment supplies). */
const CURVE_SAMPLES = 16;
/** Arc segments in each semicircular ribbon end cap. */
const CAP_SEGMENTS = 16;
/** SVG x coordinate mapped to Blockbench x = 0. */
const SVG_CENTER_X = 90;
/** SVG viewbox height; SVG y grows downward, Blockbench y grows upward. */
const SVG_HEIGHT = 180;
/** Blockbench units per SVG unit. */
const SVG_TO_BLOCKBENCH = 0.2;
/** Half of the 2.4-unit ribbon width (the 12-unit SVG stroke scaled by 0.2). */
const HALF_WIDTH = 1.2;
/** Half of the 1.4-unit ribbon depth along z. */
const HALF_DEPTH = 0.7;
/** Each sample contributes front-left, front-right, back-left and back-right vertices. */
const VERTICES_PER_SAMPLE = 4;

// Reference: modelcontextprotocol/docs, commit 573dc60, favicon.svg.
// The first path's final diagonal is shared with the second path; emit it once.
const referencePaths: readonly IReferencePath[] = [
  { name: "MCP upper arch", start: [18, 84.8528], segments: [
    { end: [85.8822, 16.9706] },
    { controls: [[95.2548, 7.59798], [110.451, 7.59798]], end: [119.823, 16.9706] },
    { controls: [[129.196, 26.3431], [129.196, 41.5391]], end: [119.823, 50.9117] },
  ] },
  { name: "MCP connector and tail", start: [68.5581, 102.177], segments: [
    { end: [119.823, 50.9117] },
    { controls: [[129.196, 41.5391], [144.392, 41.5391]], end: [153.765, 50.9117] },
    { end: [154.118, 51.2652] },
    { controls: [[163.491, 60.6378], [163.491, 75.8338]], end: [154.118, 85.2063] },
    { end: [92.7248, 146.6] },
    { controls: [[89.6006, 149.724], [89.6006, 154.789]], end: [92.7248, 157.913] },
    { end: [105.331, 170.52] },
  ] },
  { name: "MCP lower link", start: [102.853, 33.9411], segments: [
    { end: [52.6482, 84.1457] },
    { controls: [[43.2756, 93.5183], [43.2756, 108.714]], end: [52.6482, 118.087] },
    { controls: [[62.0208, 127.459], [77.2167, 127.459]], end: [86.5893, 118.087] },
    { end: [136.794, 67.8822] },
  ] },
];

/** Evaluates a cubic Bézier curve at parameter `t`. */
function cubicPoint(start: Point, a: Point, b: Point, end: Point, t: number): Point {
  const u = 1 - t;
  const axis = (index: 0 | 1): number => u ** 3 * start[index] + 3 * u ** 2 * t * a[index]
    + 3 * u * t ** 2 * b[index] + t ** 3 * end[index];
  return [axis(0), axis(1)];
}

/** Flattens a path into SVG-space points: lines add their end, curves add evenly sampled points. */
function sample(start: Point, segments: ISegment[]): Point[] {
  return segments.reduce<Point[]>((points, segment) => {
    const previous = points[points.length - 1];
    if (!segment.controls) return [...points, segment.end];
    const [a, b] = segment.controls;
    return [...points, ...Array.from({ length: CURVE_SAMPLES }, (_, index) => cubicPoint(previous, a, b, segment.end, (index + 1) / CURVE_SAMPLES))];
  }, [start]);
}

/** Unit tangents averaged from the incoming and outgoing directions at each point. */
function sampleTangents(points: Point[]): Point[] {
  return points.map((point, index): Point => {
    const before = points[Math.max(0, index - 1)];
    const after = points[Math.min(points.length - 1, index + 1)];
    const incoming = [point[0] - before[0], point[1] - before[1]];
    const outgoing = [after[0] - point[0], after[1] - point[1]];
    const inLength = Math.hypot(...incoming) || 1;
    const outLength = Math.hypot(...outgoing) || 1;
    const x = incoming[0] / inLength + outgoing[0] / outLength;
    const y = incoming[1] / inLength + outgoing[1] / outLength;
    const length = Math.hypot(x, y);
    return [x / length, y / length];
  });
}

/** Four vertices per sample, offset perpendicular to the tangent on the front and back planes. */
function ribbonVertices(points: Point[], tangents: Point[]): number[][] {
  return points.flatMap(([x, y], index) => {
    const [tx, ty] = tangents[index];
    return [[x - ty * HALF_WIDTH, y + tx * HALF_WIDTH, HALF_DEPTH], [x + ty * HALF_WIDTH, y - tx * HALF_WIDTH, HALF_DEPTH],
      [x - ty * HALF_WIDTH, y + tx * HALF_WIDTH, -HALF_DEPTH], [x + ty * HALF_WIDTH, y - tx * HALF_WIDTH, -HALF_DEPTH]];
  });
}

/** Front, back and two side quads between each pair of consecutive samples. */
function ribbonFaces(sampleCount: number): number[][] {
  return Array.from({ length: Math.max(0, sampleCount - 1) }, (_, index) => (index + 1) * VERTICES_PER_SAMPLE)
    .flatMap(b => {
      const a = b - VERTICES_PER_SAMPLE;
      return [[a, a + 1, b + 1, b], [a + 2, b + 2, b + 3, a + 3], [a, b, b + 2, a + 2], [a + 3, b + 3, b + 1, a + 1]];
    });
}

/**
 * Semicircular cap closing the ribbon at the first or last sample. Arc vertices are
 * appended after `vertexOffset`; the arc's first and last edges reuse the ribbon's
 * boundary vertices so the cap shares edges with the body.
 */
function roundCap(points: Point[], tangents: Point[], sampleIndex: number, vertexOffset: number): IMeshPart {
  const direction = sampleIndex === 0 ? -1 : 1;
  const [x, y] = points[sampleIndex];
  const [tx, ty] = tangents[sampleIndex].map(value => value * direction);
  const b = sampleIndex * VERTICES_PER_SAMPLE;
  const first = sampleIndex === 0 ? b : b + 1;
  const last = sampleIndex === 0 ? b + 1 : b;
  const interior = Array.from({ length: CAP_SEGMENTS - 1 }, (_, index) => index + 1);
  const vertices = interior.flatMap(step => {
    const angle = Math.PI * (1 - step / CAP_SEGMENTS);
    const px = x + HALF_WIDTH * (-ty * Math.cos(angle) + tx * Math.sin(angle));
    const py = y + HALF_WIDTH * (tx * Math.cos(angle) + ty * Math.sin(angle));
    return [[px, py, HALF_DEPTH], [px, py, -HALF_DEPTH]];
  });
  const arc = [[first, first + 2], ...interior.map(step => [vertexOffset + 2 * (step - 1), vertexOffset + 2 * (step - 1) + 1]), [last, last + 2]];
  const faces = arc.slice(1).flatMap((edge, step) => {
    const previous = arc[step];
    const side = [previous[0], previous[1], edge[1], edge[0]];
    return step === 0 ? [side] : [side, [arc[0][0], previous[0], edge[0]], [arc[0][1], edge[1], previous[1]]];
  });
  return { vertices, faces };
}

/** Creates three closed, rounded ribbons from the reference's cubic curves.
 * The 12-unit SVG stroke becomes 2.4 Blockbench units wide and 1.4 deep.
 * Triangles and quads share edge indices so each ribbon is a closed solid.
 *
 * @returns One mesh per reference path, in reference order, ready for `place_mesh`.
 */
export function createIdentityMeshes(): IIdentityMesh[] {
  return referencePaths.map(path => {
    const points = sample(path.start, path.segments)
      .map(([x, y]): Point => [(x - SVG_CENTER_X) * SVG_TO_BLOCKBENCH, (SVG_HEIGHT - y) * SVG_TO_BLOCKBENCH]);
    const tangents = sampleTangents(points);
    const body = ribbonVertices(points, tangents);
    const startCap = roundCap(points, tangents, 0, body.length);
    const endCap = roundCap(points, tangents, points.length - 1, body.length + startCap.vertices.length);
    return {
      name: path.name,
      vertices: [...body, ...startCap.vertices, ...endCap.vertices],
      faces: [...ribbonFaces(points.length), ...startCap.faces, ...endCap.faces],
    };
  });
}
