import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createResource, registerResourcesOnServer } from "@/lib/factories";
import { createServer, getServer } from "@/server/server";

// This executable fixture has its own registries and globals. The Bun test
// process only consumes its JSON output, avoiding shared factory module state.
Object.assign(globalThis, {
  ModelProject: { all: [] },
  Project: undefined,
  Outliner: { elements: [] },
  Plugins: { installed: [] },
  Blockbench: { hasFlag: () => false, removeFlag: () => undefined },
});
await import("@/server/resources");

let failListing = false;
createResource("protocol-failure", {
  uriTemplate: "failure://{id}",
  description: "Resource failure protocol fixture.",
  async listCallback() {
    if (failListing) throw new Error("Resource listing failed.");
    return { resources: [] };
  },
  async readCallback() {
    throw new Error("Resource serialization failed.");
  },
});

async function readFailure(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return { unexpectedSuccess: true };
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error)) throw error;
    return { code: error.code, data: "data" in error ? error.data : undefined };
  }
}

async function run(mode: "initial" | "session"): Promise<Record<string, unknown>> {
  const server = mode === "initial" ? getServer() : createServer();
  if (mode === "session") registerResourcesOnServer(server);
  const client = new Client({ name: `resource-${mode}-test`, version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const emptyList = await client.listResources();
    const unknown = await readFailure(() => client.readResource({ uri: "unknown://missing" }));
    const missing = await readFailure(() => client.readResource({ uri: "projects://missing" }));
    const malformed = await readFailure(() => client.readResource({ uri: "not a URI" }));
    const internal = await readFailure(() => client.readResource({ uri: "failure://read" }));
    failListing = true;
    const listingFailure = await readFailure(() => client.listResources());
    failListing = false;
    const project = { uuid: "e31df98f-1552-4d97-965f-891af5a2cb37", name: "Unsaved", saved: false };
    Object.assign(globalThis, {
      Project: project,
      ModelProject: { all: [project] },
      Codecs: { project: { compile: () => ({ meta: { format_version: "5.0" }, elements: [{ name: "Live cube" }] }) } },
    });
    const files = await client.listResources();
    const file = files.resources.find(resource => resource.uri.endsWith(".bbmodel"));
    const contents = file ? await client.readResource({ uri: file.uri }) : undefined;
    return { mode, emptyList, unknown, missing, malformed, internal, listingFailure, file, contents };
  } finally {
    failListing = false;
    Reflect.set(globalThis, "Project", undefined);
    Reflect.set(globalThis, "ModelProject", { all: [] });
    await client.close();
    await server.close();
  }
}

const initial = await run("initial");
const session = await run("session");
console.log(JSON.stringify([initial, session]));
