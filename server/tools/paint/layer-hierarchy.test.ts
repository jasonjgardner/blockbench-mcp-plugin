import { describe, expect, test } from "bun:test";
import {
  ancestorsOf,
  countPixelLayers,
  descendantsOf,
  findLayerNode,
  isSelfOrDescendant,
  layerDepth,
  moveAmongSiblings,
  placeNextTo,
  type ILayerNode,
} from "./layer-hierarchy";

/** Builds a node; `parent` defaults to the root. */
function node(uuid: string, type: "pixel_layer" | "layer_group", parent = ""): ILayerNode {
  return { uuid, name: uuid, type, parent_uuid: parent };
}

// Flat order (bottom to top), as Blockbench's solveLayerOrder produces:
// root: base, [group G: a, [group H: b], c], top
const base = node("base", "pixel_layer");
const a = node("a", "pixel_layer", "G");
const b = node("b", "pixel_layer", "H");
const h = node("H", "layer_group", "G");
const c = node("c", "pixel_layer", "G");
const g = node("G", "layer_group");
const top = node("top", "pixel_layer");
const list = [base, a, b, h, c, g, top];

const names = (items: readonly ILayerNode[]): string[] => items.map(item => item.uuid);

describe("lookup", () => {
  test("finds by uuid, then by exact name", () => {
    expect(findLayerNode(list, "b")).toBe(b);
    const renamed = [...list, { uuid: "x", name: "Paint", type: "pixel_layer" }];
    expect(findLayerNode(renamed, "Paint").uuid).toBe("x");
  });

  test("rejects unknown and ambiguous names", () => {
    expect(() => findLayerNode(list, "missing")).toThrow("not found");
    const dup = [{ uuid: "1", name: "Same", type: "pixel_layer" }, { uuid: "2", name: "Same", type: "pixel_layer" }];
    expect(() => findLayerNode(dup, "Same")).toThrow("ambiguous");
  });
});

describe("hierarchy", () => {
  test("ancestors and depth", () => {
    expect(names(ancestorsOf(list, b))).toEqual(["H", "G"]);
    expect(layerDepth(list, b)).toBe(2);
    expect(layerDepth(list, a)).toBe(1);
    expect(layerDepth(list, top)).toBe(0);
  });

  test("descendants and containment", () => {
    expect(names(descendantsOf(list, g))).toEqual(["a", "b", "H", "c"]);
    expect(isSelfOrDescendant(list, h, g)).toBe(true);
    expect(isSelfOrDescendant(list, g, h)).toBe(false);
    expect(isSelfOrDescendant(list, g, g)).toBe(true);
  });

  test("cyclic parent chains terminate", () => {
    const loopA = node("loopA", "layer_group", "loopB");
    const loopB = node("loopB", "layer_group", "loopA");
    expect(ancestorsOf([loopA, loopB], loopA).length).toBeLessThanOrEqual(2);
  });

  test("counts pixel layers only", () => {
    expect(countPixelLayers(list)).toBe(5);
  });
});

describe("ordering", () => {
  test("moveAmongSiblings reorders only within the parent", () => {
    // Children of G are [a, H, c]; move c to the bottom of G.
    const moved = moveAmongSiblings(list, c, 0);
    expect(names(moved.filter(item => item.parent_uuid === "G"))).toEqual(["c", "a", "H"]);
    expect(names(moved.filter(item => !item.parent_uuid))).toEqual(["base", "G", "top"]);
  });

  test("moveAmongSiblings clamps the target index", () => {
    const moved = moveAmongSiblings(list, base, 99);
    expect(names(moved.filter(item => !item.parent_uuid))).toEqual(["G", "top", "base"]);
    expect(names(moveAmongSiblings(list, top, -5).filter(item => !item.parent_uuid))).toEqual(["top", "base", "G"]);
  });

  test("placeNextTo inserts beside the anchor without duplicating", () => {
    expect(names(placeNextTo(list, top, g, "before"))).toEqual(["base", "a", "b", "H", "c", "top", "G"]);
    expect(names(placeNextTo(list, base, g, "after"))).toEqual(["a", "b", "H", "c", "G", "base", "top"]);
  });
});
