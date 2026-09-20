/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type IToolSpec } from "@/lib/factories";
import { STATUS_EXPERIMENTAL } from "@/lib/constants";
import { readFrameRateContext, readWindowFocus, sampleRenderFrames, summarizeFrameRate } from "@/lib/frame-rate";
import { createJsonResult } from "@/lib/tool-results";

/** Shortest window: at least two frame periods at the lowest allowed `fps_limit` (10 fps, 100 ms per frame). */
export const MIN_FPS_SAMPLE_MS = 250;
/** Longest window, so a single call never holds an MCP request open for more than ten seconds. */
export const MAX_FPS_SAMPLE_MS = 10_000;
/** Default window: two seconds smooths out garbage-collection and interaction spikes. */
export const DEFAULT_FPS_SAMPLE_MS = 2_000;

/** Sampling window for `get_average_fps`. */
export const getAverageFpsParameters = z.object({
  duration_ms: z
    .number()
    .int()
    .min(MIN_FPS_SAMPLE_MS)
    .max(MAX_FPS_SAMPLE_MS)
    .optional()
    .default(DEFAULT_FPS_SAMPLE_MS)
    .describe(`Sampling window in milliseconds (${MIN_FPS_SAMPLE_MS}–${MAX_FPS_SAMPLE_MS}). The call waits this long while counting rendered frames.`),
});

type GetAverageFpsArgs = z.infer<typeof getAverageFpsParameters>;

const getAverageFpsSpec: IToolSpec = {
  name: "get_average_fps",
  description:
    "Measures the average frames per second of Blockbench's render loop by counting rendered frames for duration_ms, then returns the average with the frame count, the fps_limit setting, Blockbench's own last-second counter, window focus at the start of the window plus whether it changed, whether the page was hidden, and whether rendering was paused. The call waits for the whole window; keep other tools idle meanwhile for a representative reading. A minimised or fully occluded Blockbench renders no frames and freezes its timers, so the call returns an empty window at once with document_hidden and rendering_paused set rather than waiting; bring the window to the foreground to measure a real frame rate.",
  annotations: {
    title: "Get Average FPS",
    readOnlyHint: true,
  },
  parameters: getAverageFpsParameters,
  status: STATUS_EXPERIMENTAL,
};

/**
 * Public specs for the performance tools, shared by registration and the docs
 * generator, so this array must stay free of Blockbench runtime globals.
 */
export const performanceToolDocs: IToolSpec[] = [getAverageFpsSpec];

/**
 * Registers the viewport performance tools. Blockbench globals are only read
 * inside `execute`, keeping the module importable outside Blockbench.
 */
export function registerPerformanceTools(): void {
  createTool(getAverageFpsSpec.name, {
    ...getAverageFpsSpec,
    async execute({ duration_ms }: GetAverageFpsArgs) {
      const windowFocused = readWindowFocus();
      const sample = await sampleRenderFrames(duration_ms);
      return createJsonResult(summarizeFrameRate(sample, readFrameRateContext(windowFocused)));
    },
  }, getAverageFpsSpec.status);
}
