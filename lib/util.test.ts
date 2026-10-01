import { describe, expect, test } from "bun:test";
import { installGlobals } from "@/tests/helpers/globals";
import { findMeshOrThrow } from "./util";

/** The mesh fields the lookup reads. */
interface IMeshDouble {
  uuid: string;
  name: string;
}

/** Runs `check` with `meshes` installed as `Mesh.all`. */
function withMeshes(meshes: IMeshDouble[], check: () => void): void {
  const restore = installGlobals({ Mesh: { all: meshes } });
  try {
    check();
  } finally {
    restore();
  }
}

describe("findMeshOrThrow", () => {
  test("an exact UUID wins over an earlier mesh named like it, then a unique name matches", () => {
    const shadow = { uuid: "shadow-uuid", name: "body-uuid" };
    const body = { uuid: "body-uuid", name: "body" };
    withMeshes([shadow, body], () => {
      expect(findMeshOrThrow("body-uuid").uuid).toBe(body.uuid);
      expect(findMeshOrThrow("body").uuid).toBe(body.uuid);
    });
  });

  test("a name shared by several meshes is refused with their UUIDs", () => {
    withMeshes([{ uuid: "a", name: "mesh" }, { uuid: "b", name: "mesh" }], () => {
      expect(() => findMeshOrThrow("mesh")).toThrow('Mesh name "mesh" matches 2 meshes (a, b); pass the UUID of the one you mean.');
    });
  });

  test("a missing mesh points to list_outline", () => {
    withMeshes([{ uuid: "a", name: "mesh" }], () => {
      expect(() => findMeshOrThrow("ghost")).toThrow('Mesh "ghost" not found. Use the list_outline tool');
    });
  });
});
