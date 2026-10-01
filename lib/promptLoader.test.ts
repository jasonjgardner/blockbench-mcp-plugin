import { describe, expect, test } from "bun:test";
import { VERSION } from "@/lib/constants";
import { getPromptContent, initPromptLoader, type IPromptManifest } from "@/lib/promptLoader";
import manifestFile from "@/prompts/manifest.json";
import { useGlobals } from "@/tests/helpers/globals";

let fetchCalls = 0;

/** A manifest of `version` whose `java_block` prompt names where it came from. */
function manifest(version: string, source: string): IPromptManifest {
  return { version, generatedAt: "2026-01-01T00:00:00.000Z", prompts: { java_block: source } };
}

useGlobals(() => {
  fetchCalls = 0;
  return {
    // No persistent storage: every test starts without a cached manifest.
    localStorage: undefined,
    fetch: async (): Promise<Response> => {
      fetchCalls++;
      return Response.json(manifest(VERSION, "from the CDN"));
    },
  };
});

describe("initPromptLoader", () => {
  test("uses the prompts bundled for this version without a network request", async () => {
    await initPromptLoader(true, manifest(VERSION, "bundled"));
    expect(getPromptContent("java_block")).toBe("bundled");
    expect(fetchCalls).toBe(0);
  });

  test("bundles prompts/manifest.json by default", async () => {
    await initPromptLoader(false);
    expect(getPromptContent("java_block")).toBe(manifestFile.prompts.java_block);
    expect(fetchCalls).toBe(0);
  });

  test("fetches from the CDN only when the bundle lacks this version and the CDN is enabled", async () => {
    await initPromptLoader(true, manifest("0.0.0", "older bundle"));
    expect(fetchCalls).toBe(1);
    expect(getPromptContent("java_block")).toBe("from the CDN");
  });

  test("prefers an older bundle to no prompts when the CDN is disabled", async () => {
    await initPromptLoader(false, manifest("0.0.0", "older bundle"));
    expect(fetchCalls).toBe(0);
    expect(getPromptContent("java_block")).toBe("older bundle");
  });
});
