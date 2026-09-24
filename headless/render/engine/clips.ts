/** The clip fields {@link findClip} matches on; satisfied by three.js `AnimationClip` and plain summaries. */
export interface INamedClip {
  name: string;
  duration: number;
}

/**
 * Finds a clip by exact name, by name without the `animation.` prefix, or by zero-based index.
 *
 * Generic so the path tracer host, which only sees clip summaries from the browser, resolves
 * `--clip` exactly like the WebGPU renderer does with real clips.
 *
 * @throws Error listing the available clips when nothing matches.
 */
export function findClip<T extends INamedClip>(clips: readonly T[], query: string): T {
  const index = /^\d+$/.test(query) ? Number(query) : -1;
  const match = clips[index] ?? clips.find((clip) => clip.name === query || clip.name === `animation.${query}`);
  if (match !== undefined) return match;
  const names = clips.map((clip, i) => `  ${i}: ${clip.name} (${clip.duration.toFixed(2)}s)`).join("\n");
  throw new Error(`No clip matches "${query}". Available clips:\n${names || "  (none)"}`);
}
