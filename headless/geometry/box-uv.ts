/**
 * Cube UV layouts, ported from Blockbench.
 *
 * Box UV is the Minecraft entity layout: one unwrapped cross per cube, placed
 * at `uv_offset`. Blockbench computes the six face rectangles inside
 * `Cube.preview_controller.updateUV` (js/outliner/types/cube.js), which only
 * runs when a cube has a 3D mesh. A headless editor has no mesh, so it must
 * compute the same rectangles itself, or box-UV cubes it creates would carry
 * stale UVs.
 *
 * @module
 */

import { CUBE_FACES, type CubeFaceName, type UvRect, type Vec2, type Vec3 } from "../document/schema";

const EPSILON = 0.0000001;

interface IFaceLayout {
  face: CubeFaceName;
  from: Vec2;
  size: Vec2;
}

/**
 * Cube size as Blockbench measures it for box UV (`Cube.size(axis, floored)`).
 *
 * @param floatSize - The format's `box_uv_float_size`; when false, sizes are floored.
 */
export function boxUvSize(from: Vec3, to: Vec3, floatSize = false): Vec3 {
  const measure = (axis: 0 | 1 | 2): number => (floatSize ? to[axis] - from[axis] : Math.floor(to[axis] - from[axis] + EPSILON));
  return [measure(0), measure(1), measure(2)];
}

/**
 * Face rectangles for a box-UV cube.
 *
 * @param size - Cube size from {@link boxUvSize}.
 * @param offset - The cube's `uv_offset`.
 * @param mirror - The cube's `mirror_uv`: flips each face horizontally and swaps east/west.
 * @returns `[u1, v1, u2, v2]` per face; up/down have negative extents, exactly as Blockbench stores them.
 */
export function computeBoxUv(size: Vec3, offset: Vec2 = [0, 0], mirror = false): Record<CubeFaceName, UvRect> {
  const [sx, sy, sz] = size;
  const base: IFaceLayout[] = [
    { face: "east", from: [0, sz], size: [sz, sy] },
    { face: "west", from: [sz + sx, sz], size: [sz, sy] },
    { face: "up", from: [sz + sx, sz], size: [-sx, -sz] },
    { face: "down", from: [sz + sx * 2, 0], size: [-sx, sz] },
    { face: "south", from: [sz * 2 + sx, sz], size: [sx, sy] },
    { face: "north", from: [sz, sz], size: [sx, sy] },
  ];
  const flipped = mirror ? base.map((f): IFaceLayout => ({ face: f.face, from: [f.from[0] + f.size[0], f.from[1]], size: [-f.size[0], f.size[1]] })) : base;
  const east = flipped[0];
  const west = flipped[1];
  const swapped = mirror && east && west ? [{ ...west, face: "east" as const }, { ...east, face: "west" as const }, ...flipped.slice(2)] : flipped;
  return Object.fromEntries(
    swapped.map((f) => [f.face, [f.from[0] + offset[0], f.from[1] + offset[1], f.from[0] + f.size[0] + offset[0], f.from[1] + f.size[1] + offset[1]]]),
  ) as Record<CubeFaceName, UvRect>;
}

/**
 * Default per-face UVs for a new non-box-UV cube: each face gets a rectangle the
 * size of that face, anchored at the texture origin, clamped to the texture.
 */
export function defaultFaceUv(from: Vec3, to: Vec3, resolution: { width: number; height: number }): Record<CubeFaceName, UvRect> {
  const size = [Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]), Math.abs(to[2] - from[2])] as const;
  const faceDims: Record<CubeFaceName, readonly [number, number]> = {
    north: [size[0], size[1]],
    south: [size[0], size[1]],
    east: [size[2], size[1]],
    west: [size[2], size[1]],
    up: [size[0], size[2]],
    down: [size[0], size[2]],
  };
  return Object.fromEntries(
    CUBE_FACES.map((face) => {
      const [w, h] = faceDims[face];
      return [face, [0, 0, Math.min(w, resolution.width), Math.min(h, resolution.height)]];
    }),
  ) as Record<CubeFaceName, UvRect>;
}
