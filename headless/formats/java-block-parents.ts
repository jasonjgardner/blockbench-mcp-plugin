/**
 * Resource-pack path helpers and parent-model resolution for the Java block
 * importer, ported from `getResourcePackRoot`, `getParentModelPath`,
 * `readParentModel`, `collectParentModels` and `mergeParentModels` in
 * js/formats/java/java_block.ts. Paths use forward slashes.
 *
 * @module
 */

import { isJson, type Json } from "./java-block-shared";

/** Converts Windows separators to forward slashes. */
export const normalizePath = (path: string): string => path.replaceAll("\\", "/");

/** Prefixes a pack-relative path with the pack root when one is known. */
export const withRoot = (root: string | undefined, path: string): string => (root === undefined || root === "" ? path : `${root}/${path}`);

/** `getResourcePackRoot`: the folder above `assets/<namespace>/models/...`, or `undefined`. */
export function resourcePackRoot(modelPath: string | undefined): string | undefined {
  if (!modelPath) return undefined;
  const parts = normalizePath(modelPath).split("/");
  const models = parts.lastIndexOf("models");
  if (models < 2 || parts[models - 2] !== "assets") return undefined;
  return parts.slice(0, models - 2).join("/");
}

/** `getParentModelPath`, pack-relative when the pack root is unknown. */
export function parentModelPath(parent: string, root: string | undefined): string {
  const namespace = parent.includes(":") ? parent.split(":")[0] ?? "minecraft" : "minecraft";
  const id = parent.replace(/\w+:/, "");
  return withRoot(root, `assets/${namespace}/models/${id}.json`);
}

/** Parses whatever `resolveParent` returned; `readParentModel` swallows bad JSON the same way. */
export function parseParent(value: unknown): Json | undefined {
  const text = value instanceof Uint8Array ? new TextDecoder().decode(value) : value;
  if (isJson(text)) return text;
  if (typeof text !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isJson(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** `collectParentModels`: the model and its ancestors, nearest first, at most 32. */
export function collectParents(model: Json, root: string | undefined, resolve: (path: string) => unknown): Json[] {
  const walk = (stack: readonly Json[]): Json[] => {
    const current = stack.at(-1);
    const parent = current && typeof current.parent === "string" ? current.parent : undefined;
    if (!parent || stack.length >= 32 || parent.replace(/\w+:/, "").startsWith("builtin")) return [...stack];
    const next = parseParent(resolve(parentModelPath(parent, root)));
    return next ? walk([...stack, next]) : [...stack];
  };
  return walk([model]);
}

/** `mergeParentModels`: nearest value wins; textures and display merge per slot; `#ref` textures resolve. */
export function mergeParents(stack: readonly Json[]): Json {
  const merged = stack.reduce<Json>((acc, layer) => Object.entries(layer).reduce<Json>((inner, [key, value]) => {
    if ((key === "textures" || key === "display") && isJson(value)) {
      const existing = isJson(inner[key]) ? (inner[key] as Json) : {};
      const additions = Object.fromEntries(Object.entries(value).filter(([slot]) => existing[slot] === undefined));
      return { ...inner, [key]: { ...existing, ...additions } };
    }
    return inner[key] === undefined ? { ...inner, [key]: value } : inner;
  }, acc), {});
  const textures = isJson(merged.textures) ? merged.textures : {};
  const follow = (value: unknown, seen: ReadonlySet<string>): string | undefined => {
    if (typeof value !== "string") return undefined;
    if (!value.startsWith("#")) return value;
    const reference = value.slice(1);
    return seen.has(reference) ? undefined : follow(textures[reference], new Set([...seen, reference]));
  };
  const resolved = Object.fromEntries(Object.keys(textures).flatMap((key) => {
    const value = follow(textures[key], new Set([key]));
    return value === undefined ? [] : [[key, value]];
  }));
  const { parent: _parent, ...rest } = merged;
  return { ...rest, ...(isJson(merged.textures) ? { textures: resolved } : {}) };
}
