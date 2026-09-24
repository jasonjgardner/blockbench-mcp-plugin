/**
 * Helpers for building and resolving human-readable MCP resource URIs.
 *
 * A resource URI looks like `scope://<id>`. Historically `<id>` was always the
 * element UUID, which is opaque. These helpers prefer a slugified element name
 * when it is unique among its siblings, falling back to a slug~uuid8 suffix on
 * collision, or the raw UUID if the name is missing or unprintable.
 *
 * The resolution side (`findByResourceId`) accepts any of:
 *   - raw UUID
 *   - raw name (exact match)
 *   - slug of the name (case-insensitive)
 *   - slug~uuid8 format emitted on collision
 */

const SLUG_MAX_LENGTH = 40;
const UUID_DISAMBIGUATOR_LENGTH = 8;

/**
 * Normalizes a display name into a URI-safe slug.
 * Returns an empty string when the input has no URI-safe characters.
 */
export function slugify(name: string | null | undefined): string {
  if (!name) return "";
  const normalized = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.slice(0, SLUG_MAX_LENGTH).replace(/-+$/g, "");
}

export interface INamedItem {
  uuid: string;
  name?: string | null;
}

/** How long a sibling slug tally stays valid, so one listing's `map()` shares it while later edits are seen. */
const SLUG_COUNT_TTL_MS = 250;

interface ISlugCounts {
  at: number;
  counts: Map<string, number>;
}

const slugCountCache = new WeakMap<readonly INamedItem[], ISlugCounts>();

/**
 * Tallies the slug of every sibling once per listing instead of once per item.
 *
 * Callers build a resource list with `siblings.map(item => makeResourceId(item, siblings))`,
 * which made every listing quadratic: the editor-state refresh runs it once a
 * second, and a 600-node project spent over a second per tick slugifying. The
 * tally is cached on the array identity and expires after `SLUG_COUNT_TTL_MS`,
 * so a live array such as `Cube.all` still reflects renames on the next tick.
 */
function countSiblingSlugs(siblings: readonly INamedItem[]): Map<string, number> {
  const cached = slugCountCache.get(siblings);
  const now = Date.now();
  if (cached && now - cached.at < SLUG_COUNT_TTL_MS) return cached.counts;
  const counts = siblings.reduce((map, sibling) => {
    const slug = slugify(sibling.name);
    if (!slug) return map;
    return map.set(slug, (map.get(slug) ?? 0) + 1);
  }, new Map<string, number>());
  slugCountCache.set(siblings, { at: now, counts });
  return counts;
}

/**
 * Builds a human-readable ID fragment for a resource item.
 *
 * Preference order:
 *   1. `<slug>` when the slug is non-empty and unique among siblings
 *   2. `<slug>~<uuid8>` when the slug collides with another sibling
 *   3. `<uuid>` when the name is missing or produces an empty slug
 *
 * Use `makeResourceUri` to also prepend a scope; use `makeResourceId`
 * directly when the URI template is path-style (e.g. `hytale://attachments/{id}`).
 */
export function makeResourceId(
  item: INamedItem,
  siblings: readonly INamedItem[]
): string {
  const slug = slugify(item.name);
  if (!slug) return item.uuid;

  const collisionCount = countSiblingSlugs(siblings).get(slug) ?? 0;

  if (collisionCount <= 1) {
    return slug;
  }

  const suffix = item.uuid.slice(0, UUID_DISAMBIGUATOR_LENGTH);
  return `${slug}~${suffix}`;
}

/**
 * Builds a `scope://<id>` URI using `makeResourceId`.
 * For path-style URIs, call `makeResourceId` directly and interpolate the result.
 */
export function makeResourceUri(
  scope: string,
  item: INamedItem,
  siblings: readonly INamedItem[]
): string {
  return `${scope}://${makeResourceId(item, siblings)}`;
}

/**
 * Resolves an ID fragment (from a URI variable) against a list of items.
 * Returns the first match, or undefined if nothing matches.
 */
export function findByResourceId<T extends INamedItem>(
  items: readonly T[],
  id: string | null | undefined
): T | undefined {
  if (!id) return undefined;

  const directMatch = items.find(
    (item) => item.uuid === id || item.name === id
  );
  if (directMatch) return directMatch;

  const tildeIndex = id.indexOf("~");
  if (tildeIndex > 0) {
    const slugPart = id.slice(0, tildeIndex).toLowerCase();
    const uuidPart = id.slice(tildeIndex + 1);
    const match = items.find(
      (item) =>
        slugify(item.name) === slugPart &&
        item.uuid.startsWith(uuidPart)
    );
    if (match) return match;
  }

  const slugLower = id.toLowerCase();
  return items.find(
    (item) => item.name && slugify(item.name) === slugLower
  );
}
