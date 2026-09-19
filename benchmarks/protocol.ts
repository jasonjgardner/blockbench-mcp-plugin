import { z } from "zod";
import { errorText } from "./evidence";

/** Provider-independent action envelope; no native tool-calling support is assumed. */
export const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("describe_tool"), name: z.string() }).strict(),
  z
    .object({
      action: z.literal("call_tool"),
      name: z.string(),
      arguments: z.record(z.unknown()),
    })
    .strict(),
  z.object({ action: z.literal("read_context"), path: z.string() }).strict(),
  z.object({ action: z.literal("read_resource"), uri: z.string() }).strict(),
  z
    .object({
      action: z.literal("delegate"),
      agent: z.string(),
      task: z.string(),
    })
    .strict(),
  z.object({ action: z.literal("done"), summary: z.string() }).strict(),
]);

/** One validated agent action, discriminated by its `action` field. */
export type Action = z.infer<typeof actionSchema>;

/** Outcome of a non-throwing parse: the action, or the reason the output was rejected. */
export type ParsedAction =
  { success: true; action: Action } | { success: false; error: string };

/** Parses one JSON action, tolerating a surrounding Markdown fence but no prose or batch calls. */
export function parseAction(text: string): Action {
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, "$1");
  return actionSchema.parse(JSON.parse(body) as unknown);
}

/** Non-throwing variant for agent loops, where invalid output becomes an observation instead of an exception. */
export function safeParseAction(text: string): ParsedAction {
  try {
    return { success: true, action: parseAction(text) };
  } catch (error) {
    return { success: false, error: errorText(error) };
  }
}

/** Common prompt protocol, fixed across providers and stages; screenshots are archived for humans. */
export const protocol = `You are the modeling agent in a controlled Blockbench quality benchmark.
Return exactly one JSON object per turn, using one of these shapes:
{"action":"describe_tool","name":"tool_name"}
{"action":"call_tool","name":"tool_name","arguments":{}}
{"action":"read_context","path":"skills/blockbench-modeling/SKILL.md"}
{"action":"read_resource","uri":"URI returned by a tool"}
{"action":"delegate","agent":"blockbench-physical-accuracy-reviewer","task":"specific review request"}
{"action":"done","summary":"stage outcome, verified evidence, remaining limitations"}
Read a tool's schema before calling it. Tool arguments are JSON objects, not code.
The harness already created your project. Work only on that project; do not create,
switch, close, import, or rename projects. Dedicated tools only: arbitrary JavaScript,
generic UI actions, external file access, settings changes and external generation
are unavailable in this track. Exports must return content, never write a path.
Use the supplied Project skills and read linked references as needed. Reviewer calls
use your own model, run sequentially, and count against your shared prediction budget.
This is a text-observation track: image bytes are archived, not sent as vision inputs.
Do not claim to have visually inspected an image you cannot see. Inspect geometry,
UVs and animation data; request screenshots as evidence for later human assessment.
Unavailable web research or image-generation skills must be reported as limitations.
No human is present during trials; use the explicit brief, budget and target. Do not
ask clarification questions. Tool failures are observations: fix inputs or report them.
Finish only the current stage; later user messages will supply subsequent stages.`;

/** Clips observations explicitly while retaining the original response in the on-disk trace. */
export function boundedObservation(value: unknown, limit: number): string {
  const text = JSON.stringify(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[TRUNCATED observation; full response is archived. Use targeted/paginated queries.]`;
}
