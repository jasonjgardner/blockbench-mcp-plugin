import { describe, expect, test } from "bun:test";
import { createIdentityMeshes } from "./identity-geometry";

/**
 * Rounding steps per Blockbench unit applied to every number before hashing. Bun's float
 * math lands 1–2 ULP (~1e-15) apart across operating systems and CPUs, so raw doubles
 * cannot hash identically on every machine. Each reference coordinate sits at least
 * 1e-12 from a rounding boundary, far outside that noise, while any real geometry change
 * still moves the hash.
 */
const HASH_STEPS_PER_UNIT = 1e9;

/**
 * SHA-256 of the pre-refactor `createIdentityMeshes()` JSON with numbers rounded to
 * {@link HASH_STEPS_PER_UNIT}; verified identical on Windows and Linux.
 */
const REFERENCE_OUTPUT_SHA256 = "c148c654cf06e18aee27e46fb89c7c667e99523fdfc10aab4c42d963944826f7";

/** Serializes meshes with every number rounded so the hash is platform-independent. */
const serializeRounded = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) => typeof entry === "number" ? Math.round(entry * HASH_STEPS_PER_UNIT) / HASH_STEPS_PER_UNIT : entry);

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

  test("serializes identically to the pre-refactor output at nano-unit precision", () => {
    const serialized = serializeRounded(createIdentityMeshes());
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
