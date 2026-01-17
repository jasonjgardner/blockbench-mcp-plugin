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
export interface HytaleCube extends Cube {
  shading_mode?: HytaleShadingMode;
  double_sided?: boolean;
}

/**
 * Extended group interface for Hytale groups with is_piece flag.
 */
export interface HytaleGroup extends Group {
  is_piece?: boolean;
}

/**
 * Hytale attachment collection interface.
 */
export interface HytaleAttachmentCollection extends Collection {
  texture?: string; // UUID of collection's texture
}

/**
 * Get all attachment collections in the current project.
 */
export function getAttachmentCollections(): HytaleAttachmentCollection[] {
  if (!isHytalePluginInstalled()) return [];
  // @ts-ignore - Collection is globally available in Blockbench
  if (typeof Collection === "undefined") return [];
  // @ts-ignore - Collection.all contains all collections
  return (Collection.all ?? []).filter(
    (c: Collection) => c.export_codec === "blockymodel"
  ) as HytaleAttachmentCollection[];
}

/**
 * Find an attachment collection by name or UUID.
 */
export function findAttachmentCollection(
  id: string
): HytaleAttachmentCollection | null {
  const collections = getAttachmentCollections();
  return (
    collections.find((c) => c.uuid === id || c.name === id) ?? null
  );
}

/**
 * Check if a group is marked as an attachment piece.
 */
export function isAttachmentPiece(group: Group): boolean {
  return (group as HytaleGroup).is_piece === true;
}

/**
 * Get all groups marked as attachment pieces.
 */
export function getAttachmentPieces(): HytaleGroup[] {
  // @ts-ignore - Group is globally available in Blockbench
  if (typeof Group === "undefined") return [];
  // @ts-ignore - Group.all contains all groups
  return (Group.all ?? []).filter(
    (g: Group) => (g as HytaleGroup).is_piece === true
  ) as HytaleGroup[];
}

/**
 * Get the shading mode of a cube (Hytale-specific).
 */
export function getCubeShadingMode(cube: Cube): HytaleShadingMode {
  const hytaleCube = cube as HytaleCube;
  return hytaleCube.shading_mode ?? "standard";
}

/**
 * Check if a cube is double-sided (Hytale-specific).
 */
export function isCubeDoubleSided(cube: Cube): boolean {
  const hytaleCube = cube as HytaleCube;
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
 * Count total nodes in the current project (for validation).
 */
export function countProjectNodes(): number {
  // @ts-ignore - Group is globally available in Blockbench
  if (typeof Group === "undefined") return 0;
  // @ts-ignore - Cube is globally available in Blockbench
  if (typeof Cube === "undefined") return 0;

  let count = 0;
  // @ts-ignore - Group.all contains all groups
  const groups = Group.all ?? [];
  // @ts-ignore - Cube.all contains all cubes
  const cubes = Cube.all ?? [];

  // Count groups
  count += groups.length;

  // Count cubes (excluding main shape cubes that are part of their parent group)
  for (const cube of cubes) {
    // If cube has a parent group and is the only child, it's likely the "shape"
    // and counted as part of the group. Otherwise count separately.
    const parent = cube.parent;
    if (parent instanceof Group) {
      const siblings = parent.children.filter((c: OutlinerElement) => c instanceof Cube);
      if (siblings.length > 1) {
        count += 1;
      }
    } else {
      count += 1;
    }
  }

  return count;
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
