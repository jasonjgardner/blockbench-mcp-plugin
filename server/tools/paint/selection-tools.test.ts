import { describe, expect, test } from "bun:test";
import { morphSelection } from "./selection-tools";

/** The original O(W·H·r²) round-brush morph, kept as the reference. */
function bruteForce(before: boolean[], width: number, height: number, radius: number, grow: boolean): boolean[] {
  const r = Math.max(1, Math.round(radius));
  const offsets: Array<[number, number]> = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) offsets.push([dx, dy]);
  }
  return before.map((_, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    const at = (px: number, py: number): boolean =>
      px < 0 || py < 0 || px >= width || py >= height ? !grow : before[py * width + px];
    return grow ? offsets.some(([dx, dy]) => at(x + dx, y + dy)) : offsets.every(([dx, dy]) => at(x + dx, y + dy));
  });
}

/** Deterministic pseudo-random grid (mulberry32), so failures reproduce. */
function randomGrid(width: number, height: number, seed: number, density: number): boolean[] {
  let state = seed;
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: width * height }, () => next() < density);
}

describe("morphSelection", () => {
  test("matches the brute-force round brush when growing and shrinking", () => {
    const cases: Array<[number, number, number, number]> = [
      [16, 16, 1, 0.1],
      [17, 9, 2, 0.3],
      [32, 24, 3, 0.05],
      [20, 20, 5, 0.7],
      [8, 31, 7, 0.5],
    ];
    cases.forEach(([width, height, radius, density], seed) => {
      const before = randomGrid(width, height, seed + 1, density);
      [true, false].forEach((grow) => {
        expect(morphSelection(before, width, height, radius, grow)).toEqual(bruteForce(before, width, height, radius, grow));
      });
    });
  });

  test("shrinking keeps a fully selected texture whole at its edges", () => {
    const before = new Array<boolean>(10 * 6).fill(true);
    expect(morphSelection(before, 10, 6, 3, false)).toEqual(before);
  });
});
