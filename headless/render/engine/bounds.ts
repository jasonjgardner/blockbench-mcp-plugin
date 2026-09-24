import { Box3, Mesh, SkinnedMesh, type Object3D } from "three";

import type { IBounds, Vec3 } from "./framing";
import type { IPoser } from "./poser";

/**
 * Measures the model's bounds across a set of clip times so framing and the ground plane hold
 * steady for the whole animation instead of jumping per frame.
 *
 * Imports plain `three` (which shares its core classes with `three/webgpu`) so the browser path
 * tracer frames models identically.
 */
export function measureBounds(model: Object3D, poser: IPoser | undefined, times: readonly number[]): IBounds {
  const samples = poser === undefined ? [0] : times.filter((_, i) => i % Math.max(1, Math.floor(times.length / 24)) === 0);
  const poses = samples.map((time) => {
    poser?.pose(time);
    model.updateMatrixWorld(true);
    model.traverse((object) => {
      if (object instanceof SkinnedMesh) object.computeBoundingBox();
    });
    return { box: new Box3().setFromObject(model), points: partCorners(model) };
  });
  poser?.pose(times[0] ?? 0);
  const box = poses.reduce((union, pose) => union.union(pose.box), new Box3());
  if (box.isEmpty()) return { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] };
  return { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z], points: poses.flatMap((pose) => pose.points) };
}

/** World-space corners of every visible mesh's own bounding box: a cheap, tight outline of the model's shape. */
export function partCorners(model: Object3D): Vec3[] {
  const boxes: Box3[] = [];
  model.traverseVisible((object) => {
    if (!(object instanceof Mesh)) return;
    if (object.geometry.boundingBox === null) object.geometry.computeBoundingBox();
    const local = object instanceof SkinnedMesh && object.boundingBox !== null ? object.boundingBox : object.geometry.boundingBox;
    if (local !== null && !local.isEmpty()) boxes.push(local.clone().applyMatrix4(object.matrixWorld));
  });
  return boxes.flatMap((part) =>
    [0, 1, 2, 3, 4, 5, 6, 7].map((bits): Vec3 => [
      bits & 1 ? part.max.x : part.min.x,
      bits & 2 ? part.max.y : part.min.y,
      bits & 4 ? part.max.z : part.min.z,
    ]),
  );
}
