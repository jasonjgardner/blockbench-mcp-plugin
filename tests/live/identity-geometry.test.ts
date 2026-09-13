import { describe, expect, test } from "bun:test";
import { createIdentityMeshes } from "./identity-geometry";

/** SHA-256 of `JSON.stringify(createIdentityMeshes())` captured before the helper refactor. */
const REFERENCE_OUTPUT_SHA256 = "96121aab3958069d7de9f5cfe26f9ff623c6760cbbb6ca71d905107d68ca1dcf";

/** `[name, vertex count, face count]` per ribbon, in reference path order. */
const REFERENCE_COUNTS = [
  ["MCP upper arch", 196, 224],
  ["MCP connector and tail", 272, 300],
  ["MCP lower link", 200, 228],
];

describe("identity geometry", () => {
  test("keeps the reference ribbon names and vertex/face counts", () => {
    expect(createIdentityMeshes().map(mesh => [mesh.name, mesh.vertices.length, mesh.faces.length])).toEqual(REFERENCE_COUNTS);
  });

  test("serializes byte-identically to the pre-refactor output", () => {
    const serialized = JSON.stringify(createIdentityMeshes());
    expect(new Bun.CryptoHasher("sha256").update(serialized).digest("hex")).toBe(REFERENCE_OUTPUT_SHA256);
  });

  test("every face references existing vertices with three-dimensional finite coordinates", () => {
    createIdentityMeshes().forEach(mesh => {
      expect(mesh.vertices.every(vertex => vertex.length === 3 && vertex.every(Number.isFinite))).toBe(true);
      expect(mesh.faces.every(face => face.length >= 3 && face.every(index => Number.isInteger(index) && index >= 0 && index < mesh.vertices.length))).toBe(true);
    });
  });

  test("each ribbon is a closed solid: every edge is shared by exactly two faces", () => {
    createIdentityMeshes().forEach(mesh => {
      const edgeUses = mesh.faces
        .flatMap(face => face.map((index, corner) => [index, face[(corner + 1) % face.length]].toSorted((a, b) => a - b).join(":")))
        .reduce((counts, edge) => counts.set(edge, (counts.get(edge) ?? 0) + 1), new Map<string, number>());
      expect([...edgeUses.values()].every(count => count === 2)).toBe(true);
    });
  });
});
