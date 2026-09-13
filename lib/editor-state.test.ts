import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Resource } from "@modelcontextprotocol/sdk/types.js";
import { useGlobals } from "@/tests/helpers/globals";

interface IFixtureState {
  resources: Resource[];
  toolRefreshes: number;
  notifications: number;
  reads: number;
  listCalls: number;
  rejectList: boolean;
  pendingList?: Promise<{ resources: Resource[] }>;
}

interface IEditorFixture {
  state: IFixtureState;
  setupEditorStateSync(): void;
  teardownEditorStateSync(): void;
}

const FACTORIES_SHIM = `
export const state = { resources: [], toolRefreshes: 0, notifications: 0, reads: 0, listCalls: 0, rejectList: false, pendingList: undefined };
export function refreshToolAvailability() { state.toolRefreshes++; }
export function notifyResourceListChanged() { state.notifications++; }
export function getAllResourceDefinitions() {
  return {
    project: {
      listCallback: async () => {
        state.listCalls++;
        if (state.rejectList) throw new Error('Editor changing projects');
        if (state.pendingList) return state.pendingList;
        return { resources: state.resources };
      },
      readCallback: () => { state.reads++; throw new Error('Refresh must not compile resources'); }
    }
  };
}`;

let fixture: IEditorFixture;
let listeners: Map<string, Set<() => void>>;
let intervals: Map<number, () => void>;
let nextInterval = 0;

beforeAll(async () => {
  // A private bundle prevents lifecycle imports from sharing production registries
  // or mock.module replacements with the MCP client integration tests.
  const result = await Bun.build({
    entrypoints: ["editor-state-fixture"],
    target: "bun",
    format: "esm",
    plugins: [{
      name: "editor-state-fixture",
      setup(build) {
        build.onResolve({ filter: /^editor-state-fixture$/ }, () => ({ path: "entry", namespace: "fixture" }));
        build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          loader: "ts",
          contents: `export * from ${JSON.stringify(`${import.meta.dir}/editor-state.ts`)}; export { state } from ${JSON.stringify(`${import.meta.dir}/factories.ts`)};`,
        }));
        build.onLoad({ filter: /[/\\]lib[/\\]factories\.ts$/ }, () => ({ loader: "ts", contents: FACTORIES_SHIM }));
      },
    }],
  });
  const output = result.outputs[0];
  if (!result.success || !output) throw new Error(`Lifecycle fixture failed: ${result.logs.map(String).join("\n")}`);
  fixture = await import(`data:text/javascript;base64,${Buffer.from(await output.text()).toString("base64")}`) as IEditorFixture;
});

beforeEach(() => {
  listeners = new Map();
  intervals = new Map();
  nextInterval = 0;
  Object.assign(fixture.state, {
    resources: [{ uri: "blockbench://project/first.bbmodel", name: "First.bbmodel", mimeType: "application/json" }],
    toolRefreshes: 0, notifications: 0, reads: 0, listCalls: 0, rejectList: false, pendingList: undefined,
  });
});

afterEach(() => fixture.teardownEditorStateSync());
useGlobals(() => ({
  Blockbench: {
    on: (name: string, callback: () => void) => {
      const callbacks = listeners.get(name) ?? new Set();
      callbacks.add(callback);
      listeners.set(name, callbacks);
    },
    removeListener: (name: string, callback: () => void) => listeners.get(name)?.delete(callback),
  },
  setInterval: (callback: () => void) => {
    const id = ++nextInterval;
    intervals.set(id, callback);
    return id;
  },
  clearInterval: (id: number) => intervals.delete(id),
}));

function emit(name: string): void {
  listeners.get(name)?.forEach(callback => callback());
}

async function flushRefresh(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

test("editor event bursts refresh tools once after state updates and notify only resource-list changes", async () => {
  fixture.setupEditorStateSync();
  fixture.setupEditorStateSync();
  await flushRefresh();
  expect(intervals.size).toBe(1);
  expect(fixture.state.toolRefreshes).toBe(1);
  expect(fixture.state.notifications).toBe(0);

  fixture.state.resources = [{ uri: "blockbench://project/second.bbmodel", name: "Second.bbmodel" }];
  emit("select_project");
  emit("select_mode");
  emit("update_selection");
  expect(fixture.state.toolRefreshes).toBe(1);
  await flushRefresh();
  expect(fixture.state.toolRefreshes).toBe(2);
  expect(fixture.state.notifications).toBe(1);
  emit("update_selection");
  await flushRefresh();
  expect(fixture.state.toolRefreshes).toBe(3);
  expect(fixture.state.notifications).toBe(1);
  expect(fixture.state.reads).toBe(0);
});

test("polling catches metadata changes without reading files, while resource reordering stays quiet", async () => {
  fixture.state.resources.push({ uri: "texture://second", name: "texture.png" });
  fixture.setupEditorStateSync();
  await flushRefresh();
  fixture.state.resources = fixture.state.resources.toReversed();
  intervals.forEach(callback => callback());
  await flushRefresh();
  expect(fixture.state.notifications).toBe(0);
  fixture.state.resources = fixture.state.resources.map(resource => ({ ...resource, name: `${resource.name} renamed` }));
  intervals.forEach(callback => callback());
  await flushRefresh();
  expect(fixture.state.notifications).toBe(1);
  expect(fixture.state.reads).toBe(0);
});

test("teardown removes listeners and polling and invalidates an already queued refresh", async () => {
  fixture.setupEditorStateSync();
  await flushRefresh();
  emit("close_project");
  fixture.teardownEditorStateSync();
  await flushRefresh();
  expect(fixture.state.toolRefreshes).toBe(1);
  expect(intervals.size).toBe(0);
  expect([...listeners.values()].every(callbacks => callbacks.size === 0)).toBe(true);
  emit("select_project");
  await flushRefresh();
  expect(fixture.state.toolRefreshes).toBe(1);
});

test("pending resource lists cannot notify after unload, and setup can run again", async () => {
  fixture.setupEditorStateSync();
  await flushRefresh();
  const pending = Promise.withResolvers<{ resources: Resource[] }>();
  fixture.state.pendingList = pending.promise;
  emit("select_project");
  await flushRefresh();
  fixture.teardownEditorStateSync();
  pending.resolve({ resources: [] });
  await flushRefresh();
  expect(fixture.state.notifications).toBe(0);
  fixture.state.pendingList = undefined;
  fixture.setupEditorStateSync();
  await flushRefresh();
  expect(intervals.size).toBe(1);
  expect(fixture.state.notifications).toBe(0);
  fixture.state.resources = [];
  emit("close_project");
  await flushRefresh();
  expect(fixture.state.notifications).toBe(1);
});

test("transient listing failures preserve the previous list so recovery still notifies", async () => {
  fixture.setupEditorStateSync();
  await flushRefresh();
  fixture.state.rejectList = true;
  fixture.state.resources = [];
  emit("close_project");
  await flushRefresh();
  expect(fixture.state.notifications).toBe(0);
  fixture.state.rejectList = false;
  emit("select_project");
  await flushRefresh();
  expect(fixture.state.notifications).toBe(1);
});
