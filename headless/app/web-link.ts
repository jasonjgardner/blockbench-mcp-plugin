/**
 * Links that open a model in the Blockbench web app with the file's content in the URL.
 *
 * Blockbench's web build reads `location.search || location.hash`, runs ONE
 * `decodeURIComponent` over the whole string, splits it on `&`, splits each part
 * at its first `=` with `/=\s*(.+)/`, and for `loadtype=json` passes `loaddata`
 * to `loadModelFile({ content, name: loadname, path: loadname })`, which picks the
 * codec from the extension of `loadname` (js/web.ts `loadInfoFromURL`, js/io/io.js).
 * That parser shapes the encoding here:
 *
 * - The payload goes in the `#` fragment, so it never reaches a server (no 414
 *   errors, nothing logged) and only the browser's URL length limit applies.
 * - After the single decode the content must hold no `&` (it would end the
 *   value) and no line terminator (`.` does not match them). Compact JSON has no
 *   raw newlines, and `&`, U+2028 and U+2029 only occur inside JSON strings,
 *   where they are rewritten as `\u0026`, `\u2028` and `\u2029`.
 *
 * Model URLs grow with embedded textures, so {@link buildWebAppLinks} returns
 * tiers: the full URL when it is short enough to paste, a geometry-only URL
 * (texture images removed) when that one is, and a local HTML launcher that
 * redirects to the full URL when it is under the browser limit.
 *
 * @module
 */

import { lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Where the Blockbench web app lives. */
export const DEFAULT_WEB_APP_URL = "https://web.blockbench.net/";
/** Longest URL returned inline in a tool result (characters). */
export const DEFAULT_INLINE_MAX = 8_000;
/** Longest URL a launcher is written for: Chromium accepts 2 MiB. */
export const DEFAULT_BROWSER_MAX = 2_000_000;

/** How web-app links are produced. */
export interface IWebAppOptions {
  /** Set false to leave links out of write results (bbmodel_web_url still works). */
  enabled: boolean;
  /** Blockbench web app base URL. */
  baseUrl: string;
  /** Longest URL returned inline. */
  inlineMax: number;
  /** Longest URL a launcher file is written for. */
  browserMax: number;
  /** Folder for launcher .html files. */
  launcherDir: string;
}

/** Web-app links for one file, from most to least complete. */
export interface IWebAppLinks {
  /** Opens the complete model. Present when it fits `inlineMax`. */
  url?: string;
  /** Opens the model without texture images. Present when `url` is too long and this fits. */
  geometry_url?: string;
  /** Length of the geometry-only URL when it was too long to include; pass it as bbmodel_web_url `inline_max` to get it. */
  geometry_length?: number;
  /** Local page that redirects to the complete model's URL (for URLs too long to paste). */
  launcher?: { path: string; file_url: string };
  /** Length of the complete model's URL, in characters. */
  length: number;
  /** Why a tier is missing, and what to do instead. */
  note?: string;
}

/** Escapes the characters Blockbench's URL parser cannot carry inside compact JSON. */
export function escapeJsonForQuery(json: string): string {
  return json.replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** Percent-encodes a value; `:` `,` and `/` stay literal, which is legal in a fragment and keeps URLs shorter. */
export function encodeFragmentValue(value: string): string {
  return encodeURIComponent(value).replace(/%3A/g, ":").replace(/%2C/g, ",").replace(/%2F/g, "/");
}

/**
 * Builds a web-app URL that loads `content` as the file `name`.
 *
 * @param content - File text. JSON is re-serialized compactly; other text must not contain `&` or line breaks.
 * @param name - File name whose extension selects the codec (`.bbmodel`, `.geo.json`, ...).
 */
export function webAppUrl(content: string, name: string, baseUrl: string = DEFAULT_WEB_APP_URL): string {
  const compact = compactJson(content);
  if (compact !== undefined) return urlFromCompact(compact, name, baseUrl);
  if (BREAKS_QUERY.some((character) => content.includes(character))) throw new Error(`${name} cannot travel in a web-app URL: it contains "&" or a line break.`);
  return urlFromData(content, name, baseUrl);
}

/** Characters that end a value in Blockbench's query parser. */
const BREAKS_QUERY = ["&", "\r", "\n", String.fromCharCode(0x2028), String.fromCharCode(0x2029)];

/** Same as {@link webAppUrl} for text that is already compact JSON (skips the re-parse on large models). */
function urlFromCompact(compact: string, name: string, baseUrl: string): string {
  return urlFromData(escapeJsonForQuery(compact), name, baseUrl);
}

function urlFromData(data: string, name: string, baseUrl: string): string {
  return `${baseUrl}#loadtype=json&loadname=${encodeFragmentValue(safeName(name))}&loaddata=${encodeFragmentValue(data)}`;
}

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value: unknown): JsonRecord[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const withoutKeys = (record: JsonRecord, keys: readonly string[]): JsonRecord => Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));

/** Sound keyframes in the effects animator store the audio file's local path in `data_points[].file`. */
function stripAnimationPaths(animation: JsonRecord): JsonRecord {
  const animators = isRecord(animation.animators) ? animation.animators : undefined;
  const effects = animators && isRecord(animators.effects) ? animators.effects : undefined;
  const base = withoutKeys(animation, ["path"]);
  if (!animators || !effects) return base;
  const keyframes = records(effects.keyframes).map((keyframe) => ({ ...keyframe, data_points: records(keyframe.data_points).map((point) => withoutKeys(point, ["file"])) }));
  return { ...base, animators: { ...animators, effects: { ...effects, keyframes } } };
}

/**
 * Removes what only makes sense on this machine or is too heavy for a link:
 * local file paths always (textures, animation files, animation controllers,
 * sound effects), and texture image data when `stripImages` is set.
 */
export function prepareModelForWeb(doc: JsonRecord, stripImages: boolean): JsonRecord {
  const textureKeys = stripImages ? ["path", "relative_path", "source"] : ["path", "relative_path"];
  return {
    ...doc,
    textures: records(doc.textures).map((texture) => withoutKeys(texture, textureKeys)),
    ...(Array.isArray(doc.animations) ? { animations: records(doc.animations).map(stripAnimationPaths) } : {}),
    ...(Array.isArray(doc.animation_controllers) ? { animation_controllers: records(doc.animation_controllers).map((controller) => withoutKeys(controller, ["path"])) } : {}),
  };
}

/**
 * Validates a web app base URL: http(s), with no query string or fragment,
 * because Blockbench reads `location.search` before the fragment and would
 * ignore the model.
 *
 * @throws Error for anything else.
 */
export function normalizeWebAppUrl(raw: string): string {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.search !== "" || url.hash !== "") {
    throw new Error(`--web-app-url must be an http(s) URL without a query string or #fragment, got "${raw}".`);
  }
  return url.href;
}

/** Turns a failed link build into a note, so links never fail the write they describe. */
export function linkOrNote(build: Promise<IWebAppLinks>): Promise<IWebAppLinks> {
  return build.catch((error: unknown) => ({ length: 0, note: `No web-app link: ${error instanceof Error ? error.message : String(error)}` }));
}

/**
 * Produces the tiered links for a `.bbmodel` document.
 *
 * @param fileName - Name shown in the web app tab; `.bbmodel` is appended when missing.
 * @param launcherKey - Distinguishes launchers of different files with the same name (e.g. the absolute path).
 */
export async function buildWebAppLinks(doc: Record<string, unknown>, fileName: string, options: IWebAppOptions, launcherKey: string = fileName): Promise<IWebAppLinks> {
  const name = fileName.toLowerCase().endsWith(".bbmodel") ? fileName : `${fileName}.bbmodel`;
  const full = urlFromCompact(JSON.stringify(prepareModelForWeb(doc, false)), name, options.baseUrl);
  if (full.length <= options.inlineMax) return { url: full, length: full.length };

  const geometry = urlFromCompact(JSON.stringify(prepareModelForWeb(doc, true)), name, options.baseUrl);
  const fits = geometry.length <= options.inlineMax;
  const geometryTier = fits ? { geometry_url: geometry } : { geometry_length: geometry.length };
  const geometryHint = fits
    ? "; geometry_url shows it without textures"
    : `; a geometry-only URL (no texture images) is ${geometry.length} characters, returned by bbmodel_web_url with inline_max ${geometry.length}`;
  if (full.length > options.browserMax) {
    return {
      ...geometryTier,
      length: full.length,
      note: `The full model needs a ${kb(full.length)} URL, over the ${kb(options.browserMax)} browsers accept. Open the file in Blockbench desktop (blockbench_launch) instead${geometryHint}.`,
    };
  }
  const launcher = await writeLauncher(full, name, launcherKey, options.launcherDir);
  return {
    ...geometryTier,
    launcher,
    length: full.length,
    note: `The full model's URL is ${kb(full.length)}, too long to paste. Open launcher.file_url in a Chromium browser to load the complete model${geometryHint}.`,
  };
}

/**
 * The `web_app` field write tools add to their results. A link that cannot be
 * built never fails the write; it becomes a note instead.
 *
 * @param path - Absolute path of the written file; its name labels the web-app tab.
 */
export async function webAppField(doc: JsonRecord, path: string, options: IWebAppOptions): Promise<{ web_app?: IWebAppLinks }> {
  if (!options.enabled) return {};
  return { web_app: await linkOrNote(buildWebAppLinks(doc, basename(path), options, path)) };
}

/** Links for any text file the web app can open (Bedrock .geo.json, Java block .json, ...). */
export async function buildWebAppFileLinks(content: string, fileName: string, options: IWebAppOptions, launcherKey: string = fileName): Promise<IWebAppLinks> {
  const url = webAppUrl(content, fileName, options.baseUrl);
  if (url.length <= options.inlineMax) return { url, length: url.length };
  if (url.length > options.browserMax) return { length: url.length, note: `The file needs a ${kb(url.length)} URL, over the ${kb(options.browserMax)} browsers accept.` };
  return { launcher: await writeLauncher(url, fileName, launcherKey, options.launcherDir), length: url.length, note: `The URL is ${kb(url.length)}, too long to paste. Open launcher.file_url in a Chromium browser.` };
}

/** HTML page that forwards the browser to `url`, with a manual link as a fallback. */
export function launcherHtml(url: string, title: string): string {
  const href = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const text = title.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${text} - Blockbench web app</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<p>Opening <strong>${text}</strong> in the Blockbench web app&hellip;</p>
<p><a id="open" href="${href}">Open it manually</a> if nothing happens.</p>
<script>location.replace(document.getElementById("open").href);</script>
</body>
</html>
`;
}

/**
 * Writes a launcher page. The folder is created private (0700) and refused when
 * it is a symbolic link, and the page is written to a random name and renamed
 * into place, because rename replaces a planted symlink instead of following it
 * (the default folder sits in the shared OS temp directory on Linux).
 */
async function writeLauncher(url: string, name: string, key: string, dir: string): Promise<{ path: string; file_url: string }> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await lstat(dir)).isSymbolicLink()) throw new Error(`Launcher folder ${dir} is a symbolic link; refusing to write there.`);
  const hash = new Bun.CryptoHasher("sha1").update(key).digest("hex").slice(0, 8);
  const path = join(dir, `${basename(name).replace(/[^\w.-]+/g, "_")}-${hash}.html`);
  const temporary = `${path}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, launcherHtml(url, basename(name)), { mode: 0o600, flag: "wx" });
  await rename(temporary, path).catch(async (error: unknown) => {
    await unlink(temporary).catch(() => undefined);
    throw error;
  });
  return { path, file_url: pathToFileURL(path).href };
}

/** Compact JSON when `content` parses, otherwise undefined. */
function compactJson(content: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(content));
  } catch {
    return undefined;
  }
}

/** File names travel as a query value too, so keep them free of `&`, `=` and line breaks. */
const safeName = (name: string): string => basename(name).replace(/[&=\r\n\u2028\u2029#]+/g, "_");

const kb = (length: number): string => `${Math.round(length / 1024)} KB`;
