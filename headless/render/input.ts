/**
 * The model copy a render reads.
 *
 * The render engine (like bb-render) loads each texture as the `.bbmodel` says:
 * from its embedded data URL, or from a file its `relative_path`, `path` or a
 * non-data `source` names. A model is data, so those paths could make the
 * renderer read any image on the machine and show it in the render. Renders
 * therefore read a copy whose textures carry image data only: the embedded data
 * URL, or else the PNG that `relative_path` or `path` names inside the workspace,
 * inlined. Any other texture renders without its image, with a warning.
 *
 * @module
 */

import { mkdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pngDataUrl, pngSize } from "../document/png";
import type { ModelStore } from "../document/store";

/** A model copy written for the renderer. */
export interface IRenderInput {
  /** File to pass to the renderer. */
  path: string;
  /** Textures that render without their image because it could not be used, and why. */
  warnings: string[];
  /** Deletes the copy. */
  dispose(): Promise<void>;
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads a PNG the model links to, when the link resolves to one inside the workspace. */
async function workspacePng(store: ModelStore, target: string): Promise<{ source: string } | { problem: string }> {
  try {
    const path = store.resolvePath(target, [".png"]);
    const file = Bun.file(path);
    if (!(await file.exists())) return { problem: `${path} does not exist.` };
    const bytes = new Uint8Array(await file.arrayBuffer());
    pngSize(bytes);
    return { source: pngDataUrl(bytes) };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

/** The image a texture renders with, if any, and why its links could not be used. */
async function textureImage(store: ModelStore, modelDir: string, texture: JsonRecord): Promise<{ source?: string; problems: string[] }> {
  const { source } = texture;
  // An embedded image is used as it is, so models that carry their images render as before.
  if (typeof source === "string" && source.startsWith("data:")) return { source, problems: [] };
  const problems = typeof source === "string" && source !== "" ? ["its source is not an embedded image, so it was not read."] : [];
  // Links in the order Blockbench's .bbmodel codec tries them: relative_path, then path.
  for (const link of [texture.relative_path, texture.path]) {
    if (typeof link !== "string" || link === "") continue;
    const found = await workspacePng(store, resolve(modelDir, link));
    if ("source" in found) return { source: found.source, problems: [] };
    problems.push(found.problem);
  }
  return { problems };
}

/**
 * Writes the copy of a model that a render reads.
 *
 * @param modelPath - Model path already resolved inside the workspace.
 * @param dir - Folder for the copy (the scratch folder).
 * @throws Error when the model is not a JSON object.
 */
export async function writeRenderInput(store: ModelStore, modelPath: string, dir: string): Promise<IRenderInput> {
  const doc: unknown = JSON.parse(await Bun.file(modelPath).text());
  if (!isRecord(doc)) throw new Error(`${modelPath} does not hold a JSON object.`);
  const entries: unknown[] = Array.isArray(doc.textures) ? doc.textures : [];
  const prepared = await Promise.all(
    entries.map(async (texture, index): Promise<{ texture: unknown; warning?: string }> => {
      if (!isRecord(texture)) return { texture };
      const { path: _path, relative_path: _relativePath, source: _source, ...rest } = texture;
      const image = await textureImage(store, dirname(modelPath), texture);
      if (image.source !== undefined) return { texture: { ...rest, source: image.source } };
      const name = typeof texture.name === "string" ? texture.name : String(index);
      return image.problems.length > 0 ? { texture: rest, warning: `Texture "${name}" renders without its image: ${image.problems.join(" ")}` } : { texture: rest };
    }),
  );
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${basename(modelPath, ".bbmodel")}-render-${crypto.randomUUID().slice(0, 8)}.bbmodel`);
  const copy = Array.isArray(doc.textures) ? { ...doc, textures: prepared.map((entry) => entry.texture) } : doc;
  await writeFile(path, JSON.stringify(copy), { flag: "wx", mode: 0o600 });
  const warnings = prepared.flatMap((entry) => (entry.warning === undefined ? [] : [entry.warning]));
  return { path, warnings, dispose: () => unlink(path).catch(() => undefined) };
}
