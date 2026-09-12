type Vector = [number, number, number];
type UV = [number, number];
type Selection = { vertices: string[]; edges: string[][]; faces: string[] };

/** Resolve explicit or selected polygon keys before editing; stale and empty selections are errors. */
export function resolveMeshFaces(mesh: Mesh, requested?: string[]): string[] {
  const keys = [...new Set(requested ?? mesh.getSelectedFaces())];
  if (!keys.length) throw new Error("No faces selected. Use select_mesh_elements with returned face keys, or provide faces.");
  keys.forEach(key => {
    const face = mesh.faces[key];
    if (!face || face.vertices.length < 3 || face.vertices.some(vertex => !mesh.vertices[vertex])) {
      throw new Error(`Face "${key}" is missing or is not a valid polygon.`);
    }
  });
  return keys;
}

/** Run one targeted geometry/UV edit and revert the host snapshot if mutation or preview refresh fails. */
export function editMesh<T>(mesh: Mesh, label: string, mutate: () => T, uvOnly = false): T {
  // Full mesh snapshots retain geometry and UVs; uvOnly limits the preview refresh.
  Undo.initEdit({ elements: [mesh], selection: true });
  try {
    const result = mutate();
    Canvas.updateView({ elements: [mesh], element_aspects: { geometry: !uvOnly, uv: true, faces: true }, selection: true });
    Undo.finishEdit(label);
    return result;
  } catch (error) {
    (Undo.cancelEdit as (revert: boolean) => void)(true);
    throw error;
  }
}

function selectionMap(): Record<string, Selection> {
  if (!Project) throw new Error("No project is open.");
  // Published host types incorrectly describe edges as string[]; runtime uses key pairs.
  return Project.mesh_selection as unknown as Record<string, Selection>;
}

function selection(mesh: Mesh): Selection {
  return selectionMap()[mesh.uuid] ??= { vertices: [], edges: [], faces: [] };
}

function copyFace(mesh: Mesh, source: MeshFace, vertices: string[], uv: Record<string, UV>): string {
  return mesh.addFaces(new MeshFace(mesh, source).extend({ vertices, uv }))[0];
}

function edgeKey(a: string, b: string): string {
  return JSON.stringify([a, b].toSorted());
}

/** Extrude a selected face region along averaged unit normals, retaining cap IDs and adding boundary walls. */
export function extrudeMeshFaces(mesh: Mesh, distance: number): { vertex_keys: string[]; face_keys: string[] } {
  const keys = resolveMeshFaces(mesh);
  if (!Number.isFinite(distance) || distance === 0) throw new Error("Extrusion distance must be finite and nonzero.");
  const sources = keys.map(key => ({ key, face: mesh.faces[key], vertices: mesh.faces[key].getSortedVertices() }));
  const originals = [...new Set(sources.flatMap(source => source.vertices))];
  const normals = originals.map(key => {
    const sum = sources.filter(source => source.vertices.includes(key)).reduce<Vector>((value, source) => {
      const normal = source.face.getNormal(true);
      return [value[0] + normal[0], value[1] + normal[1], value[2] + normal[2]];
    }, [0, 0, 0]);
    const length = Math.hypot(...sum);
    if (!Number.isFinite(length) || length < 1e-8) throw new Error(`Cannot extrude vertex "${key}": selected face normals cancel or are degenerate.`);
    return sum.map(value => value / length) as Vector;
  });
  const edges = sources.flatMap(source => source.vertices.map((a, index) => ({ source, a, b: source.vertices[(index + 1) % source.vertices.length] })));
  const counts = edges.reduce((map, edge) => map.set(edgeKey(edge.a, edge.b), (map.get(edgeKey(edge.a, edge.b)) ?? 0) + 1), new Map<string, number>());
  if ([...counts.values()].some(count => count > 2)) throw new Error("Cannot extrude a non-manifold selected region.");
  return editMesh(mesh, "Extrude mesh faces", () => {
    const newVertices = originals.map((key, index) => mesh.addVertices(mesh.vertices[key].map((value, axis) => value + normals[index][axis] * distance) as Vector)[0]);
    const replacement = new Map(originals.map((key, index) => [key, newVertices[index]]));
    const created = edges.filter(edge => counts.get(edgeKey(edge.a, edge.b)) === 1).map(({ source, a, b }) => {
      const nextA = replacement.get(a)!;
      const nextB = replacement.get(b)!;
      const uvA = source.face.uv[a] ?? [0, 0];
      const uvB = source.face.uv[b] ?? [0, 0];
      return copyFace(mesh, source.face, [a, b, nextB, nextA], {
        [a]: [...uvA], [b]: [...uvB], [nextB]: [uvB[0], uvB[1] + distance], [nextA]: [uvA[0], uvA[1] + distance],
      });
    });
    sources.forEach(({ face, vertices }) => {
      const uv = Object.fromEntries(vertices.map(key => [replacement.get(key)!, [...(face.uv[key] ?? [0, 0])] as UV]));
      face.extend({ vertices: vertices.map(key => replacement.get(key)!), uv });
    });
    const referenced = new Set(Object.values(mesh.faces).flatMap(face => face.vertices));
    originals.filter(key => !referenced.has(key)).forEach(key => { delete mesh.vertices[key]; });
    const selected = selection(mesh);
    selected.vertices = newVertices;
    selected.edges = [];
    selected.faces = keys;
    return { vertex_keys: newVertices, face_keys: [...keys, ...created] };
  });
}

/** Split selected triangles/quads into a regular grid, sharing edge vertices and interpolating each face's UVs. */
export function subdivideMeshFaces(mesh: Mesh, cuts: number): { vertex_keys: string[]; face_keys: string[] } {
  const keys = resolveMeshFaces(mesh);
  if (!Number.isInteger(cuts) || cuts < 1 || cuts > 10) throw new Error("Subdivision cuts must be an integer from 1 to 10.");
  if (keys.some(key => mesh.faces[key].vertices.length > 4)) throw new Error("Subdivision supports triangle and quad faces only.");
  const segments = cuts + 1;
  return editMesh(mesh, "Subdivide mesh faces", () => {
    const edgeVertices = new Map<string, string>();
    const createdVertices: string[] = [];
    const createdFaces: string[] = [];
    keys.forEach(key => {
      const source = mesh.faces[key];
      const corners = source.getSortedVertices();
      const points = new Map<string, { key: string; uv: UV }>();
      const triangle = corners.length === 3;
      Array.from({ length: segments + 1 }, (_, i) => {
        Array.from({ length: (triangle ? segments - i : segments) + 1 }, (_, j) => {
          const u = i / segments;
          const v = j / segments;
          const weights = triangle ? [1 - u - v, u, v] : [(1 - u) * (1 - v), u * (1 - v), u * v, (1 - u) * v];
          const active = corners.map((corner, index) => ({ corner, weight: weights[index] })).filter(entry => entry.weight > 1e-8);
          const cacheKey = active.length <= 2 ? JSON.stringify(active.map(entry => [entry.corner, Math.round(entry.weight * segments)]).toSorted((a, b) => String(a[0]).localeCompare(String(b[0])))) : `${key}:${i}:${j}`;
          let vertex = active.length === 1 ? active[0].corner : edgeVertices.get(cacheKey);
          if (!vertex) {
            const position = [0, 1, 2].map(axis => corners.reduce((sum, corner, index) => sum + mesh.vertices[corner][axis] * weights[index], 0)) as Vector;
            vertex = mesh.addVertices(position)[0];
            edgeVertices.set(cacheKey, vertex);
            createdVertices.push(vertex);
          }
          const uv = [0, 1].map(axis => corners.reduce((sum, corner, index) => sum + (source.uv[corner]?.[axis] ?? 0) * weights[index], 0)) as UV;
          points.set(`${i}:${j}`, { key: vertex, uv });
        });
      });
      const add = (coordinates: [number, number][]): void => {
        const values = coordinates.map(([i, j]) => points.get(`${i}:${j}`)!);
        createdFaces.push(copyFace(mesh, source, values.map(value => value.key), Object.fromEntries(values.map(value => [value.key, value.uv]))));
      };
      Array.from({ length: segments }, (_, i) => {
        Array.from({ length: triangle ? segments - i : segments }, (_, j) => {
          if (!triangle) {
            add([[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]]);
            return;
          }
          add([[i, j], [i + 1, j], [i, j + 1]]);
          if (i + j < segments - 1) add([[i + 1, j], [i + 1, j + 1], [i, j + 1]]);
        });
      });
      delete mesh.faces[key];
    });
    const selected = selection(mesh);
    selected.faces = createdFaces;
    selected.edges = [];
    selected.vertices = [...new Set(createdFaces.flatMap(key => mesh.faces[key].vertices))];
    return { vertex_keys: createdVertices, face_keys: createdFaces };
  });
}

/** Delete selected components and their incident faces; optionally retain vertices orphaned by face/edge removal. */
export function deleteMeshSelection(mesh: Mesh, mode: "faces" | "edges" | "vertices", keepVertices: boolean): { deleted_vertices: number; deleted_faces: number } {
  const selected: Selection = selectionMap()[mesh.uuid] ?? { vertices: [], edges: [], faces: [] };
  const vertices = mode === "vertices" ? [...selected.vertices] : [];
  const edges = mode === "edges" ? selected.edges : [];
  if ((mode === "vertices" && !vertices.length) || (mode === "edges" && !edges.length) || (mode === "faces" && !selected.faces.length)) {
    throw new Error(`No ${mode} selected. Use select_mesh_elements before deleting components.`);
  }
  const faces = mode === "faces" ? [...selected.faces] : Object.keys(mesh.faces).filter(key => {
    const sorted = mesh.faces[key].getSortedVertices();
    if (mode === "vertices") return sorted.some(vertex => vertices.includes(vertex));
    return edges.some(edge => sorted.some((a, index) => edgeKey(a, sorted[(index + 1) % sorted.length]) === edgeKey(edge[0], edge[1])));
  });
  if (faces.some(key => !mesh.faces[key]) || vertices.some(key => !mesh.vertices[key]) || edges.some(edge => edge.length !== 2 || edge.some(key => !mesh.vertices[key]))) {
    throw new Error("Mesh selection contains missing geometry. Select current keys from get_mesh_info.");
  }
  const candidates = new Set([...vertices, ...edges.flat(), ...faces.flatMap(key => mesh.faces[key].vertices)]);
  return editMesh(mesh, `Delete mesh ${mode}`, () => {
    faces.forEach(key => { delete mesh.faces[key]; });
    const referenced = new Set(Object.values(mesh.faces).flatMap(face => face.vertices));
    const removed = [...candidates].filter(key => vertices.includes(key) || (!keepVertices && !referenced.has(key)));
    removed.forEach(key => { delete mesh.vertices[key]; });
    selected.vertices = selected.vertices.filter(key => !!mesh.vertices[key]);
    selected.faces = selected.faces.filter(key => !!mesh.faces[key]);
    selected.edges = selected.edges.filter(edge => edge.every(key => !!mesh.vertices[key]) && !edges.includes(edge));
    return { deleted_vertices: removed.length, deleted_faces: faces.length };
  });
}
