/**
 * Hytale plugin detection and helper utilities.
 * The Hytale plugin adds support for Hytale character and prop formats.
 */

// Hytale format IDs as defined in the Hytale plugin
export const HYTALE_FORMAT_IDS = ["hytale_character", "hytale_prop"] as const;
export type HytaleFormatId = (typeof HYTALE_FORMAT_IDS)[number];

// Hytale shading modes for cubes
export const HYTALE_SHADING_MODES = ["flat", "standard", "fullbright", "reflective"] as const;
export type HytaleShadingMode = (typeof HYTALE_SHADING_MODES)[number];

// Quad normal directions
export const HYTALE_QUAD_NORMALS = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"] as const;
export type HytaleQuadNormal = (typeof HYTALE_QUAD_NORMALS)[number];

/**
 * Check if the Hytale plugin is installed and enabled in Blockbench.
 */
export function isHytalePluginInstalled(): boolean {
  // @ts-ignore - Plugins is globally available in Blockbench
  if (typeof Plugins === "undefined") return false;
  // @ts-ignore - Plugins.installed is an array of installed plugins
  return Plugins.installed?.some?.((p: { id: string; disabled: boolean }) => p.id === "hytale_plugin" && !p.disabled) ?? false;
}

/**
 * Check if the current project uses a Hytale format.
 */
export function isHytaleFormat(): boolean {
  // @ts-ignore - Format is globally available in Blockbench
  if (typeof Format === "undefined" || !Format?.id) return false;
  return HYTALE_FORMAT_IDS.includes(Format.id as HytaleFormatId);
}

/**
 * Get the current Hytale format type (character or prop).
 * Returns null if not a Hytale format.
 */
export function getHytaleFormatType(): "character" | "prop" | null {
  if (!isHytaleFormat()) return null;
  // @ts-ignore - Format is globally available in Blockbench
  if (Format.id === "hytale_character") return "character";
  // @ts-ignore - Format is globally available in Blockbench
  if (Format.id === "hytale_prop") return "prop";
  return null;
}

/**
 * Get block size for current Hytale format.
 * Characters use 64, props use 32.
 */
export function getHytaleBlockSize(): number {
  const formatType = getHytaleFormatType();
  if (formatType === "character") return 64;
  if (formatType === "prop") return 32;
  return 16; // Default Blockbench block size
}

/**
 * Extended cube interface for Hytale cubes with shading_mode and double_sided.
 */
export interface IHytaleCube extends Cube {
  shading_mode?: HytaleShadingMode;
  double_sided?: boolean;
}

/**
 * Extended group interface for Hytale groups with is_piece flag.
 */
export interface IHytaleGroup extends Group {
  is_piece?: boolean;
}

/**
 * Hytale attachment collection interface.
 */
export interface IHytaleAttachmentCollection extends Collection {
  texture?: string; // UUID of collection's texture
}

/**
 * Get all attachment collections in the current project.
 */
export function getAttachmentCollections(): IHytaleAttachmentCollection[] {
  if (!isHytalePluginInstalled()) return [];
  // @ts-ignore - Collection is globally available in Blockbench
  if (typeof Collection === "undefined") return [];
  // @ts-ignore - Collection.all contains all collections
  return (Collection.all ?? []).filter(
    (c: Collection) => c.export_codec === "blockymodel"
  ) as IHytaleAttachmentCollection[];
}

/**
 * Find an attachment collection by name or UUID.
 */
export function findAttachmentCollection(
  id: string
): IHytaleAttachmentCollection | null {
  const collections = getAttachmentCollections();
  return (
    collections.find((c) => c.uuid === id || c.name === id) ?? null
  );
}

/**
 * Check if a group is marked as an attachment piece.
 */
export function isAttachmentPiece(group: Group): boolean {
  return (group as IHytaleGroup).is_piece === true;
}

/**
 * Get all groups marked as attachment pieces.
 */
export function getAttachmentPieces(): IHytaleGroup[] {
  // @ts-ignore - Group is globally available in Blockbench
  if (typeof Group === "undefined") return [];
  // @ts-ignore - Group.all contains all groups
  return (Group.all ?? []).filter(
    (g: Group) => (g as IHytaleGroup).is_piece === true
  ) as IHytaleGroup[];
}

/**
 * Get the shading mode of a cube (Hytale-specific).
 */
export function getCubeShadingMode(cube: Cube): HytaleShadingMode {
  const hytaleCube = cube as IHytaleCube;
  return hytaleCube.shading_mode ?? "standard";
}

/**
 * Check if a cube is double-sided (Hytale-specific).
 */
export function isCubeDoubleSided(cube: Cube): boolean {
  const hytaleCube = cube as IHytaleCube;
  return hytaleCube.double_sided ?? false;
}

/**
 * Get Hytale animation FPS (always 60 for Hytale).
 */
export function getHytaleAnimationFPS(): number {
  return 60;
}

/**
 * Get Hytale max node count (255 limit).
 */
export function getHytaleMaxNodes(): number {
  return 255;
}

/**
 * Count nodes in the active Hytale codec's main-model output without writing a
 * file. The codec decides which cubes fold into group shapes, export toggles,
 * and attachment exclusions; an outliner object count cannot reproduce that.
 *
 * @returns Exported main-model node count; zero outside a Hytale project.
 * @throws When the installed codec is unavailable or returns an invalid tree.
 *   Never substitute a guessed count that could falsely pass the engine limit.
 */
export function countProjectNodes(): number {
  if (!isHytaleFormat()) return 0;
  const codec = typeof Codecs === "undefined" ? undefined : Codecs.blockymodel;
  if (!codec || typeof codec.compile !== "function") throw new Error("Hytale blockymodel codec is unavailable; cannot validate exported node count.");
  const compiled: unknown = codec.compile({ raw: true });
  const model: unknown = typeof compiled === "string" ? JSON.parse(compiled) : compiled;
  if (!model || typeof model !== "object" || !("nodes" in model) || !Array.isArray(model.nodes)) {
    throw new Error("Hytale codec did not return a model with a nodes array.");
  }
  const seen = new Set<object>();
  const countNodes = (nodes: unknown[]): number => nodes.reduce<number>((total, node) => {
    if (!node || typeof node !== "object" || seen.has(node)) throw new Error("Hytale codec returned an invalid or cyclic node tree.");
    seen.add(node);
    if (!("children" in node) || node.children === undefined) return total + 1;
    if (!Array.isArray(node.children)) throw new Error("Hytale codec returned invalid node children.");
    return total + 1 + countNodes(node.children);
  }, 0);
  return countNodes(model.nodes);
}

/**
 * Checks the published Hytale atlas-size rule independently of 64/32 character
 * and prop texel density. Both bitmap dimensions must be positive multiples of
 * 32; rectangular textures are valid. Does not infer flipbooks from dimensions.
 *
 * @param textures - Texture names and actual decoded bitmap dimensions.
 * @returns One actionable issue per invalid bitmap; no host state is changed.
 */
export function getHytaleTextureDimensionIssues(textures: readonly { name: string; width: number; height: number }[]): string[] {
  return textures.flatMap(texture => {
    const valid = [texture.width, texture.height].every(value => Number.isInteger(value) && value > 0 && value % 32 === 0);
    if (valid) return [];
    return [`Texture "${texture.name}" has invalid dimensions (${texture.width}x${texture.height}). Width and height must each be positive multiples of 32 pixels; non-square atlases are supported.`];
  });
}

/**
 * Validate node count against Hytale limit.
 */
export function validateNodeCount(): { valid: boolean; count: number; max: number; message?: string } {
  const count = countProjectNodes();
  const max = getHytaleMaxNodes();
  const valid = count <= max;

  return {
    valid,
    count,
    max,
    message: valid
      ? undefined
      : `Node count (${count}) exceeds Hytale limit of ${max} nodes.`,
  };
}
