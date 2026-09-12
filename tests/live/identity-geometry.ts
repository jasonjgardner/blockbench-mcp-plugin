/** A two-dimensional point in the official mark's 180-unit SVG coordinates. */
type Point = [number, number];

/** Indexed solid mesh accepted by place_mesh; coordinates use Blockbench units. */
export interface IIdentityMesh {
  name: string;
  vertices: number[][];
  faces: number[][];
}

type Segment = { end: Point; controls?: [Point, Point] };

// Reference: modelcontextprotocol/docs, commit 573dc60, favicon.svg.
// The first path's final diagonal is shared with the second path; emit it once.
const paths: { name: string; start: Point; segments: Segment[] }[] = [
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

function sample(start: Point, segments: Segment[]): Point[] {
  return segments.reduce<Point[]>((points, segment) => {
    const previous = points[points.length - 1];
    if (!segment.controls) return [...points, segment.end];
    const [a, b] = segment.controls;
    return [...points, ...Array.from({ length: 16 }, (_, index): Point => {
      const t = (index + 1) / 16;
      const u = 1 - t;
      return [0, 1].map(axis => u ** 3 * previous[axis] + 3 * u ** 2 * t * a[axis]
        + 3 * u * t ** 2 * b[axis] + t ** 3 * segment.end[axis]) as Point;
    })];
  }, [start]);
}

/** Creates three closed, rounded ribbons from the reference's cubic curves.
 * The 12-unit SVG stroke becomes 2.4 Blockbench units wide and 1.4 deep.
 * Triangles and quads share edge indices so each ribbon is a closed solid.
 */
export function createIdentityMeshes(): IIdentityMesh[] {
  return paths.map(path => {
    const points = sample(path.start, path.segments).map(([x, y]): Point => [(x - 90) * 0.2, (180 - y) * 0.2]);
    const vertices: number[][] = [];
    const faces: number[][] = [];
    const tangents = points.map((point, index): Point => {
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
    points.forEach(([x, y], index) => {
      const [tx, ty] = tangents[index];
      vertices.push([x - ty * 1.2, y + tx * 1.2, 0.7], [x + ty * 1.2, y - tx * 1.2, 0.7],
        [x - ty * 1.2, y + tx * 1.2, -0.7], [x + ty * 1.2, y - tx * 1.2, -0.7]);
      if (index === 0) return;
      const b = index * 4;
      const a = b - 4;
      faces.push([a, a + 1, b + 1, b], [a + 2, b + 2, b + 3, a + 3],
        [a, b, b + 2, a + 2], [a + 3, b + 3, b + 1, a + 1]);
    });
    [0, points.length - 1].forEach(index => {
      const direction = index === 0 ? -1 : 1;
      const [x, y] = points[index];
      const [tx, ty] = tangents[index].map(value => value * direction);
      const b = index * 4;
      const first = index === 0 ? b : b + 1;
      const last = index === 0 ? b + 1 : b;
      const arc = Array.from({ length: 17 }, (_, step) => {
        if (step === 0) return [first, first + 2];
        if (step === 16) return [last, last + 2];
        const angle = Math.PI * (1 - step / 16);
        const px = x + 1.2 * (-ty * Math.cos(angle) + tx * Math.sin(angle));
        const py = y + 1.2 * (tx * Math.cos(angle) + ty * Math.sin(angle));
        const front = vertices.length;
        vertices.push([px, py, 0.7], [px, py, -0.7]);
        return [front, front + 1];
      });
      arc.slice(1).forEach((edge, step) => {
        const previous = arc[step];
        faces.push([previous[0], previous[1], edge[1], edge[0]]);
        if (step === 0) return;
        faces.push([arc[0][0], previous[0], edge[0]], [arc[0][1], edge[1], previous[1]]);
      });
    });
    return { name: path.name, vertices, faces };
  });
}
