/**
 * CLI for the still-frame renderer, run under Node 23.6+ (Bun cannot load Dawn's `dawn.node`).
 * The headless MCP server bundles this file and spawns it once per render.
 *
 * ```sh
 * node cli.mjs model.bbmodel -o out.png --preset showcase --view iso
 * ```
 */
import { parseArgs } from "node:util";

import { CAMERA_VIEWS, mergeOptions, PRESETS, resolveOptions, type RenderOptionsInput } from "./options";
import { render } from "./render";

const HELP = `Headless WebGPU renders of Blockbench .bbmodel files, as PNG stills.

Usage:
  cli <model.bbmodel> -o <output.png> [options]

Options:
  -o, --output <path>        Output PNG (required)
  -p, --preset <name>        ${Object.keys(PRESETS).join(" | ")}
      --width <px>           Default 1920
      --height <px>          Default 1080
      --supersample <1|2>    Render at 2x and downsample (default 2)
      --background <hex>     Background color, or "transparent" (default #1f2229)
      --transparent          Shorthand for --background transparent
      --tone-mapping <name>  agx | aces | neutral | linear | none
      --exposure <n>         Default 1
      --texture-filter <m>   auto | nearest | smooth
      --view <name>          ${Object.keys(CAMERA_VIEWS).join(" | ")}
      --azimuth <deg>        Degrees around the model (0 = front)
      --elevation <deg>      Degrees above the horizon
      --fov <deg>            Vertical field of view (default 30)
      --padding <n>          Framing margin (default 1.08)
      --ortho                Orthographic projection
      --fit <mode>           auto | box | sphere
      --lighting <name>      studio | outdoor | flat
      --no-shadows           Disable shadow maps
      --ground <mode>        shadow | solid | none
      --ground-color <hex>   Solid ground color
      --clip <name|index>    Animation clip to pose
      --start <sec>          Clip time to render
  -q, --quiet                Only print errors
      --help                 Show this help
`;

/** Converts a numeric flag, leaving it undefined when absent so it cannot override a preset. */
const num = (value: string | undefined): number | undefined => (value === undefined ? undefined : Number(value));

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      output: { type: "string", short: "o" },
      preset: { type: "string", short: "p" },
      width: { type: "string" },
      height: { type: "string" },
      supersample: { type: "string" },
      background: { type: "string" },
      transparent: { type: "boolean" },
      "tone-mapping": { type: "string" },
      exposure: { type: "string" },
      "texture-filter": { type: "string" },
      view: { type: "string" },
      azimuth: { type: "string" },
      elevation: { type: "string" },
      fov: { type: "string" },
      padding: { type: "string" },
      ortho: { type: "boolean" },
      fit: { type: "string" },
      lighting: { type: "string" },
      shadows: { type: "boolean" },
      ground: { type: "string" },
      "ground-color": { type: "string" },
      clip: { type: "string" },
      start: { type: "string" },
      quiet: { type: "boolean", short: "q" },
      help: { type: "boolean" },
    },
  });
  if (values.help === true || positionals.length === 0) {
    process.stdout.write(HELP);
    return;
  }
  const log = (message: string): void => {
    if (values.quiet !== true) process.stderr.write(`${message}\n`);
  };

  const preset = values.preset === undefined ? {} : PRESETS[values.preset];
  if (preset === undefined) throw new Error(`Unknown preset "${values.preset}". Available: ${Object.keys(PRESETS).join(", ")}`);

  const flags = {
    input: positionals[0],
    output: values.output,
    width: num(values.width),
    height: num(values.height),
    supersample: num(values.supersample),
    background: values.transparent === true ? "transparent" : values.background,
    toneMapping: values["tone-mapping"],
    exposure: num(values.exposure),
    textureFilter: values["texture-filter"],
    camera: {
      view: values.view,
      azimuth: num(values.azimuth),
      elevation: num(values.elevation),
      fov: num(values.fov),
      padding: num(values.padding),
      orthographic: values.ortho,
      fit: values.fit,
    },
    lighting: { preset: values.lighting, shadows: values.shadows, ground: values.ground, groundColor: values["ground-color"] },
    animation: { clip: values.clip, start: num(values.start) },
  };
  const options = resolveOptions(mergeOptions(preset as Record<string, unknown>, flags) as RenderOptionsInput & { input?: string; output?: string });
  const result = await render(options, { warn: (message) => log(`warning: ${message}`), info: log });
  log(`done in ${(result.totalMs / 1000).toFixed(2)}s -> ${result.output}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`render: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
