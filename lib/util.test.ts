import { describe, expect, test } from "bun:test";
import { installGlobals } from "@/tests/helpers/globals";
import { findMeshOrThrow, holdDeferredCallbacks } from "./util";

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

describe("holdDeferredCallbacks", () => {
  /** A project double with a `whenNextOpen` queue and a scheduler that runs on demand. */
  function setup(queue?: Array<() => void>) {
    const project = { selected: false, on_next_upen: queue };
    const ticks: Array<() => void> = [];
    const release = holdDeferredCallbacks(project as unknown as ModelProject, (callback) => ticks.push(callback));
    return { project, ticks, release };
  }

  test("the queue is empty while the project is briefly selected, then restored for its real opening", () => {
    const ran: string[] = [];
    const { project, ticks, release } = setup([() => ran.push("reload")]);
    expect(project.on_next_upen).toBeUndefined();
    release();
    ticks.forEach((tick) => tick());
    expect(ran).toEqual([]);
    expect(project.on_next_upen?.length).toBe(1);
  });

  test("callbacks queued meanwhile are kept after the held ones", () => {
    const ran: string[] = [];
    const { project, ticks, release } = setup([() => ran.push("held")]);
    project.on_next_upen = [() => ran.push("new")];
    release();
    ticks.forEach((tick) => tick());
    project.on_next_upen?.forEach((callback) => callback());
    expect(ran).toEqual(["held", "new"]);
  });

  test("the callbacks run at once when the project is still active at restore time", () => {
    const ran: string[] = [];
    const { project, ticks, release } = setup([() => ran.push("reload")]);
    project.selected = true;
    release();
    ticks.forEach((tick) => tick());
    expect(ran).toEqual(["reload"]);
  });

  test("a project with nothing queued schedules nothing", () => {
    const { ticks, release } = setup();
    release();
    expect(ticks).toEqual([]);
  });
});
