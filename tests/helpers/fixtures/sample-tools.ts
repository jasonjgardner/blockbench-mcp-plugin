/**
 * Minimal tool module used only by `tests/helpers/tool-fixture.test.ts`.
 *
 * It imports the real `@/lib/factories` exactly like production tool modules do,
 * which proves that fixture bundles resolve the `@/` alias and swap in the capture
 * registry. Tests may import its constants, but must never call
 * `registerSampleTools()` outside a fixture bundle: registering against the real
 * factories would publish the tool on the shared MCP server.
 *
 * @module
 */

import { z } from "zod";
import { createTool } from "@/lib/factories";

/** Name under which {@link registerSampleTools} registers its echo tool. */
export const SAMPLE_TOOL_NAME = "helpers_sample_echo";

/** Echo parameters; the default proves the fixture parses input before `execute`. */
export const sampleEchoParameters = z.object({
  text: z.string().min(1).default("hello").describe("Text to echo back."),
});

/** Registers the echo tool through the (shimmed) factory. */
export function registerSampleTools(): void {
  createTool(SAMPLE_TOOL_NAME, {
    description: "Echoes its text parameter.",
    parameters: sampleEchoParameters,
    async execute({ text }) {
      return `echo:${text}`;
    },
  });
}
