/**
 * Stand-in for an agent CLI in offline tests. Reads the prompt from stdin like the
 * real CLIs, connects to the benchmark proxy over MCP, and follows the directive in
 * the prompt's last line: `CALL <tool> [times]`, `SLEEP <ms>`, or nothing.
 * Prints a JSON result `{ result, session }`.
 */
import { connect } from "../mcp";

const [proxyUrl, session] = Bun.argv.slice(2);
const prompt = await new Response(Bun.stdin.stream()).text();
const directive = prompt.trim().split("\n").at(-1) ?? "";
const [verb, target, times] = directive.split(" ");

if (verb === "SLEEP") await Bun.sleep(Number(target));

const results =
  verb === "CALL" && proxyUrl && target
    ? await (async () => {
        const client = await connect(proxyUrl, "fake-cli");
        try {
          const count = Number(times ?? "1");
          const calls = Array.from({ length: count }, () => target);
          return await calls.reduce<Promise<string[]>>(
            async (previous, name) => {
              const done = await previous;
              const response = await client.call(name, {});
              const text = response.content
                .flatMap((item) => (item.type === "text" ? [item.text] : []))
                .join(" ");
              return [...done, `${response.isError ? "ERROR " : ""}${text}`];
            },
            Promise.resolve([]),
          );
        } finally {
          await client.close();
        }
      })()
    : [];

console.log(
  JSON.stringify({ result: results.join(" | ") || "no calls", session }),
);
