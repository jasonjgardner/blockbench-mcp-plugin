import { beforeEach, describe, expect, test } from "bun:test";
import { cutCubeAtPositions, cutRange, isCubeAlignedForAxis, isCutInsideCube, splitCubeAtPosition } from "./cube-knife";
import { useGlobals } from "@/tests/helpers/globals";
import type { Vector3Tuple } from "@/tests/helpers/shapes";

const directions = ["north", "east", "south", "west", "up", "down"] as const;
type Direction = typeof directions[number];
type UV = [number, number, number, number];

interface IFakeFace { uv: UV; rotation: number }
interface IFakeParent { rotation: Vector3Tuple; parent: IFakeParent | "root" }

/** Minimal Cube double: geometry, per-face UVs, and Blockbench's duplicate() contract. */
class FakeCube {
  static all: FakeCube[] = [];
  name: string;
  from: Vector3Tuple;
  to: Vector3Tuple;
  inflate = 0;
  box_uv = false;
  rotation: Vector3Tuple = [0, 0, 0];
  parent: IFakeParent | "root" = "root";
  faces: Record<Direction, IFakeFace>;
  constructor(name: string, from: Vector3Tuple, to: Vector3Tuple, uv: UV = [0, 0, 16, 16]) {
    this.name = name;
    this.from = [...from];
    this.to = [...to];
    this.faces = Object.fromEntries(directions.map(direction => [direction, { uv: [...uv] as UV, rotation: 0 }])) as Record<Direction, IFakeFace>;
    FakeCube.all.push(this);
  }
  duplicate(): FakeCube {
    const copy = new FakeCube(this.name, this.from, this.to);
    copy.inflate = this.inflate;
    copy.box_uv = this.box_uv;
    copy.rotation = [...this.rotation];
    copy.parent = this.parent;
    directions.forEach(direction => Object.assign(copy.faces[direction], structuredClone(this.faces[direction])));
    return copy;
  }
}

const asCube = (cube: FakeCube): Cube => cube as unknown as Cube;
const format = { optional_box_uv: true };

beforeEach(() => {
  FakeCube.all = [];
  format.optional_box_uv = true;
});

useGlobals(() => ({ Format: format }));

describe("splitCubeAtPosition", () => {
  test("splits geometry and shares face UVs proportionally along y", () => {
    const cube = new FakeCube("pole", [-2, 0, -2], [2, 40, 2], [0, 0, 4, 40]);
    const created = splitCubeAtPosition(asCube(cube), 1, 30, "pole_2");

    expect(cube.to).toEqual([2, 30, 2]);
    expect(created.from).toEqual([-2, 30, -2]);
    expect(created.to).toEqual([2, 40, 2]);
    expect(created.name).toBe("pole_2");
    // North face UV rows: v index 1 is the top edge, 3 the bottom. Lower piece keeps 3/4 of the height from the bottom.
    expect(cube.faces.north.uv).toEqual([0, 10, 4, 40]);
    expect(created.faces.north.uv).toEqual([0, 0, 4, 10]);
    // Faces perpendicular to the cut axis are untouched.
    expect(cube.faces.up.uv).toEqual([0, 0, 4, 40]);
    expect(created.faces.down.uv).toEqual([0, 0, 4, 40]);
  });

  test("honors face UV rotation like Blockbench's splitCube", () => {
    const cube = new FakeCube("beam", [0, 0, 0], [16, 4, 4], [0, 0, 16, 4]);
    cube.faces.north.rotation = 90;
    const created = splitCubeAtPosition(asCube(cube), 0, 4);
    // With 90° rotation, corner index 0 maps to index 3 for the kept piece and 2 → 1 for the new piece.
    expect(cube.faces.north.uv).toEqual([0, 0, 16, 1]);
    expect(created.faces.north.uv).toEqual([0, 1, 16, 4]);
  });

  test("accounts for inflate in geometry, UV fraction, and the cuttable range; converts box UV when allowed", () => {
    const cube = new FakeCube("puffy", [0, 0, 0], [8, 8, 8]);
    cube.inflate = 1;
    cube.box_uv = true;
    // Only cuts at least `inflate` away from from/to keep both pieces non-inverted.
    expect(cutRange(asCube(cube), 2)).toEqual([1, 7]);
    expect(isCutInsideCube(asCube(cube), 2, 1)).toBe(false);
    expect(isCutInsideCube(asCube(cube), 2, 1.5)).toBe(true);

    const created = splitCubeAtPosition(asCube(cube), 2, 2);
    expect(cube.to[2]).toBe(1);
    expect(created.from[2]).toBe(3);
    expect(cube.box_uv).toBe(false);
    expect(created.box_uv).toBe(false);
    // The visual span is [-1, 9]; a cut at 2 keeps 30% of the east face, not the 25% Blockbench's scalar inflate math yields.
    expect(cube.faces.east.uv[0]).toBeCloseTo(11.2);
    expect(created.faces.east.uv[2]).toBeCloseTo(11.2);

    expect(() => splitCubeAtPosition(asCube(cube), 2, 9)).toThrow(/does not pass through/);
    expect(() => splitCubeAtPosition(asCube(cube), 2, -1)).toThrow(/does not pass through/);
    const inverted = new FakeCube("inverted", [0, 0, 8], [8, 8, 0]);
    expect(() => splitCubeAtPosition(asCube(inverted), 2, 4)).toThrow(/inverted/);
  });

  test("keeps box UV when the format locks it", () => {
    format.optional_box_uv = false;
    const cube = new FakeCube("locked", [0, 0, 0], [8, 8, 8]);
    cube.box_uv = true;
    splitCubeAtPosition(asCube(cube), 0, 4);
    expect(cube.box_uv).toBe(true);
  });
});

describe("cutCubeAtPositions", () => {
  test("applies ascending cuts to the growing tail piece and skips misses", () => {
    const cube = new FakeCube("pole", [-2, 6, -2], [2, 64, 2]);
    const created: Cube[] = [];
    const sources: string[] = [];
    const result = cutCubeAtPositions(asCube(cube), 1, [48, 16, 32, 6, 99, 16], source => {
      sources.push(source.name);
      return `${source.name}_${sources.length + 1}`;
    }, created);
    expect(result.pieces.map(piece => [piece.from[1], piece.to[1]])).toEqual([[6, 16], [16, 32], [32, 48], [48, 64]]);
    // The namer always sees the original cube, never the tail piece, so names stay flat.
    expect(sources).toEqual(["pole", "pole", "pole"]);
    expect(result.pieces.map(piece => piece.name)).toEqual(["pole", "pole_2", "pole_3", "pole_4"]);
    expect(result.skipped).toEqual([6, 99]);
    expect(created).toHaveLength(3);
    expect(FakeCube.all).toHaveLength(4);
  });
});

describe("isCubeAlignedForAxis", () => {
  test("rotation about the cut axis is fine; rotation about other axes anywhere in the chain is not", () => {
    const cube = new FakeCube("arm", [0, 0, 0], [4, 4, 4]);
    cube.rotation = [0, 45, 0];
    expect(isCubeAlignedForAxis(asCube(cube), 1)).toBe(true);
    expect(isCubeAlignedForAxis(asCube(cube), 0)).toBe(false);

    const tilted: IFakeParent = { rotation: [10, 0, 0], parent: "root" };
    cube.rotation = [0, 0, 0];
    cube.parent = { rotation: [0, 0, 0], parent: tilted };
    expect(isCubeAlignedForAxis(asCube(cube), 0)).toBe(true);
    expect(isCubeAlignedForAxis(asCube(cube), 1)).toBe(false);
    expect(isCubeAlignedForAxis(asCube(cube), 2)).toBe(false);
  });
});
