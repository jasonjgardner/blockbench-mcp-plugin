import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";

import { createFrameRenderer } from "./gpu";
import { assertInputExists, findClip, loadModel } from "./load";
import { resolveCameraAngles, type RenderOptions } from "./options";
import { encodePng } from "./png";
import { createStage, measureBounds } from "./stage";

/** Diagnostics callbacks; all optional so library callers can stay silent. */
export interface IRenderReporter {
  warn?(message: string): void;
  info?(message: string): void;
}

/** Timing and size facts about a finished render. */
export interface IRenderResult {
  output: string;
  width: number;
  height: number;
  clip: string | undefined;
  totalMs: number;
}

/**
 * Renders one still of a Blockbench model to a PNG.
 *
 * With `animation.clip`, the model is posed at `animation.start` seconds of that clip; the pose is
 * derived from the time alone, so the same request always renders the same image.
 *
 * @throws Error for a missing input, a non-PNG output path, an unknown clip or a GPU failure.
 */
export async function render(options: RenderOptions, reporter: IRenderReporter = {}): Promise<IRenderResult> {
  const startedAt = performance.now();
  if (extname(options.output).toLowerCase() !== ".png") throw new Error(`Output must be a .png file (got "${options.output}")`);
  if (extname(options.input).toLowerCase() !== ".bbmodel") throw new Error(`Input must be a .bbmodel file (got "${options.input}")`);
  await assertInputExists(options.input);

  const gpu = await createFrameRenderer({
    width: options.width,
    height: options.height,
    supersample: options.supersample,
    toneMapping: options.toneMapping,
    exposure: options.exposure,
    background: options.background === "transparent" ? undefined : options.background,
  });

  try {
    const model = await loadModel(options.input, { textureFilter: options.textureFilter });
    try {
      model.warnings.forEach((warning) => reporter.warn?.(warning));
      const clip = options.animation.clip === undefined ? undefined : findClip(model.clips, options.animation.clip);
      const poser = clip === undefined ? undefined : model.play(clip);
      const time = options.animation.start;
      const angles = resolveCameraAngles(options.camera);
      const stage = await createStage({
        model: model.root,
        bounds: measureBounds(model.root, poser, [time]),
        width: options.width,
        height: options.height,
        azimuth: angles.azimuth,
        elevation: angles.elevation,
        camera: options.camera,
        lighting: options.lighting,
        renderer: gpu.renderer,
      });
      try {
        poser?.pose(time);
        stage.aim(angles.azimuth);
        const frame = await gpu.render(stage.scene, stage.camera);
        await mkdir(dirname(options.output), { recursive: true });
        await writeFile(options.output, encodePng(frame, options.width, options.height));
      } finally {
        stage.dispose();
      }
      reporter.info?.(`${options.width}x${options.height}${clip === undefined ? "" : ` at ${time}s of ${clip.name}`} -> ${options.output}`);
      return { output: options.output, width: options.width, height: options.height, clip: clip?.name, totalMs: performance.now() - startedAt };
    } finally {
      model.dispose();
    }
  } finally {
    await gpu.dispose();
  }
}
