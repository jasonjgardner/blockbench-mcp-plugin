import { describe, expect, test } from "bun:test";

import { boundingSphere, createOrbitFramer, frameCamera, orbitDirection, type IBounds, type Vec3 } from "./framing";

const unitCube: IBounds = { min: [-1, 0, -1], max: [1, 2, 1] };
const base0 = { bounds: unitCube, azimuth: 0, elevation: 0, fov: 30, aspect: 16 / 9, padding: 1, orthographic: false, fit: "sphere" as const };
const base = { bounds: unitCube, azimuth: 0, elevation: 0, fov: 30, aspect: 16 / 9, padding: 1, orthographic: false, fit: "sphere" as const };
const distance = (a: readonly number[], b: readonly number[]): number => Math.hypot(...a.map((v, i) => v - (b[i] ?? 0)));

describe("framing", () => {
  test("bounding sphere is centered with a half-diagonal radius", () => {
    const sphere = boundingSphere(unitCube);
    expect(sphere.center).toEqual([0, 1, 0]);
    expect(sphere.radius).toBeCloseTo(Math.sqrt(3), 12);
  });

  test("azimuth 0 looks at the model's front from -Z", () => {
    const [x, y, z] = orbitDirection(0, 0);
    expect(x).toBeCloseTo(0, 12);
    expect(y).toBeCloseTo(0, 12);
    expect(z).toBeCloseTo(-1, 12);
  });

  test("azimuth 90 views the model's right side from +X", () => {
    expect(orbitDirection(90, 0)[0]).toBeCloseTo(1, 12);
  });

  test("the bounding sphere exactly fills the vertical field of view at padding 1", () => {
    const placement = frameCamera(base);
    const d = distance(placement.position, placement.target);
    const halfFov = (15 * Math.PI) / 180;
    expect(Math.sin(halfFov) * d).toBeCloseTo(Math.sqrt(3), 9);
  });

  test("portrait output backs the camera off to fit the narrower horizontal field", () => {
    const landscape = distance(frameCamera(base).position, [0, 1, 0]);
    const portrait = distance(frameCamera({ ...base, aspect: 9 / 16 }).position, [0, 1, 0]);
    expect(portrait).toBeGreaterThan(landscape);
  });

  test("distance is identical at every orbit angle", () => {
    const distances = [0, 90, 137, 270].map((azimuth) => distance(frameCamera({ ...base, azimuth }).position, [0, 1, 0]));
    distances.forEach((d) => expect(d).toBeCloseTo(distances[0] ?? 0, 9));
  });

  test("orthographic half height fits the sphere on the shorter axis", () => {
    expect(frameCamera({ ...base, orthographic: true }).orthoHalfHeight).toBeCloseTo(Math.sqrt(3), 12);
    expect(frameCamera({ ...base, orthographic: true, aspect: 0.5 }).orthoHalfHeight).toBeCloseTo(Math.sqrt(3) * 2, 12);
  });

  test("an L-shaped model is framed tighter and centered on its outline when part points are known", () => {
    // A tall post at one end of a long base: the overall box is mostly empty space.
    const post = [[-0.1, 0, -0.1], [0.1, 4, 0.1]] as const;
    const base = [[-0.5, 0, -0.5], [4, 0.3, 0.5]] as const;
    const corners = (min: readonly number[], max: readonly number[]): Vec3[] =>
      [0, 1, 2, 3, 4, 5, 6, 7].map((bits): Vec3 => [bits & 1 ? max[0]! : min[0]!, bits & 2 ? max[1]! : min[1]!, bits & 4 ? max[2]! : min[2]!]);
    const box: IBounds = { min: [-0.5, 0, -0.5], max: [4, 4, 0.5] };
    const outline: IBounds = { ...box, points: [...corners(...post), ...corners(...base)] };
    const input = { ...base0, azimuth: 35, elevation: 20, fov: 30, aspect: 16 / 9, padding: 1, fit: "box" as const };
    const loose = frameCamera({ ...input, bounds: box });
    const tight = frameCamera({ ...input, bounds: outline });
    expect(distance(tight.position, tight.target)).toBeLessThan(distance(loose.position, loose.target));
    // Every outline point stays in frame, and the outline is balanced left/right around the target.
    const toCamera = orbitDirection(35, 20);
    const right = [-toCamera[2], 0, toCamera[0]].map((v, _, all) => v / Math.hypot(...all));
    const offsets = outline.points!.map((p) => p.reduce((sum, v, i) => sum + (v - tight.target[i]!) * right[i]!, 0));
    expect(Math.max(...offsets) + Math.min(...offsets)).toBeCloseTo(0, 6);
  });

  test("orbits ignore part points so the pivot never sways", () => {
    const outline: IBounds = { min: [-0.5, 0, -0.5], max: [4, 4, 0.5], points: [[-0.5, 0, -0.5], [4, 0.3, 0.5], [0, 4, 0]] };
    const framer = createOrbitFramer({ ...base0, bounds: outline, elevation: 20, fit: "box" }, 0, 360);
    const targets = [0, 90, 180, 270].map((azimuth) => framer(azimuth).target);
    targets.forEach((target) => expect(target).toEqual(targets[0]!));
  });

  test("box fit keeps every corner inside the frustum and is closer than sphere fit for a flat board", () => {
    const board: IBounds = { min: [-8, 0, -4], max: [8, 0.5, 4] };
    const input = { ...base, bounds: board, azimuth: 35, elevation: 20, fov: 30, aspect: 16 / 9, padding: 1 };
    const box = frameCamera({ ...input, fit: "box" });
    const sphere = frameCamera({ ...input, fit: "sphere" });
    expect(distance(box.position, box.target)).toBeLessThan(distance(sphere.position, sphere.target));

    const toCamera = orbitDirection(35, 20);
    const forward = toCamera.map((v) => -v);
    const right = [forward[1]! * 0 - forward[2]! * 1, forward[2]! * 0 - forward[0]! * 0, forward[0]! * 1 - forward[1]! * 0];
    const rightLength = Math.hypot(...right);
    const up = [
      right[1]! * forward[2]! - right[2]! * forward[1]!,
      right[2]! * forward[0]! - right[0]! * forward[2]!,
      right[0]! * forward[1]! - right[1]! * forward[0]!,
    ].map((v) => v / rightLength);
    const tanV = Math.tan((15 * Math.PI) / 180);
    const tanH = tanV * (16 / 9);
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((bits) => [
      bits & 1 ? 8 : -8, bits & 2 ? 0.5 : 0, bits & 4 ? 4 : -4,
    ]);
    corners.forEach((corner) => {
      const rel = corner.map((v, i) => v - (box.position[i] ?? 0));
      const depth = rel.reduce((sum, v, i) => sum + v * (forward[i] ?? 0), 0);
      const x = rel.reduce((sum, v, i) => sum + v * (right[i] ?? 0) / rightLength, 0);
      const y = rel.reduce((sum, v, i) => sum + v * (up[i] ?? 0), 0);
      expect(Math.abs(x) / depth).toBeLessThanOrEqual(tanH + 1e-9);
      expect(Math.abs(y) / depth).toBeLessThanOrEqual(tanV + 1e-9);
    });
  });

  test("a box-fit orbit holds one distance, tighter than sphere framing, and fits the widest angle", () => {
    const board: IBounds = { min: [-8, 0, -4], max: [8, 0.5, 4] };
    const input = { bounds: board, elevation: 55, fov: 30, aspect: 16 / 9, padding: 1, orthographic: false };
    const box = createOrbitFramer({ ...input, fit: "box" }, 35, 90);
    const sphere = createOrbitFramer({ ...input, fit: "sphere" }, 35, 90);
    const distances = [35, 60, 80, 125].map((azimuth) => distance(box(azimuth).position, box(azimuth).target));
    distances.forEach((d) => expect(d).toBeCloseTo(distances[0] ?? 0, 9));
    expect(distances[0]).toBeLessThan(distance(sphere(35).position, sphere(35).target));
    const widest = Math.max(...[35, 57.5, 80, 102.5, 125].map((azimuth) => {
      const single = frameCamera({ ...input, azimuth, fit: "box" });
      return distance(single.position, single.target);
    }));
    expect(distances[0]).toBeGreaterThanOrEqual(widest - 1e-9);
  });
});
