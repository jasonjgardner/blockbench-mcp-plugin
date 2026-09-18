/// <reference types="blockbench-types" />

/** Maximum 8-bit channel value; `material_config.color_value` stores RGBA as 0-255 integers. */
const MAX_CHANNEL_VALUE = 255;
/** Blockbench event emitted after undo, redo, or cancellation restores a saved project snapshot. */
const UNDO_RESTORE_EVENT = "load_undo_save";

const pendingImages = new Map<HTMLImageElement, () => void>();
let listening = false;

/**
 * Rebuild a material after channel/config changes, including uniform RGBA.
 * Some supported hosts pass a plain RGB object to THREE.Color.set and read
 * alpha at index 4; use the actual Color API and RGBA shape for that path.
 */
export function updateMaterialPreview(group: TextureGroup): void {
  group.updateMaterial();
  const material = group.material;
  if (!material || group.getTextures().some(texture => texture.pbr_channel === "color")) return;
  const [red, green, blue, alpha] = group.material_config.color_value;
  material.color.setRGB(red / MAX_CHANNEL_VALUE, green / MAX_CHANNEL_VALUE, blue / MAX_CHANNEL_VALUE);
  material.opacity = alpha / MAX_CHANNEL_VALUE;
  material.needsUpdate = true;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function refreshGroups(groups: TextureGroup[]): void {
  groups.forEach(group => {
    try {
      updateMaterialPreview(group);
    } catch (error) {
      // A malformed legacy material must not abort native undo/cancellation.
      console.warn(`[MCP] Could not refresh material "${group.name}" after undo`, error);
    }
  });
  if (groups.length > 0) Canvas.updateAllFaces();
}

function watchTextureImage(texture: Texture): void {
  const image = texture.img;
  if (!image || (image.complete && image.naturalWidth > 0) || pendingImages.has(image)) return;
  const project = Project;
  const cleanup = (): void => {
    image.removeEventListener("load", loaded);
    image.removeEventListener("error", failed);
    pendingImages.delete(image);
  };
  const loaded = (): void => {
    cleanup();
    if (typeof Project === "undefined" || Project !== project) return;
    const groups = TextureGroup.all.filter(group => group.is_material && group.getTextures().some(member => member.img === image));
    refreshGroups(groups);
  };
  const failed = (): void => {
    cleanup();
    // Undo already restored the snapshot; a broken channel image only leaves its preview stale.
    console.warn(`[MCP] Texture "${texture.name}" failed to load; its material preview was not refreshed after undo`);
  };
  pendingImages.set(image, cleanup);
  image.addEventListener("load", loaded);
  image.addEventListener("error", failed);
}

function refreshLoadedUndoSave(event: unknown): void {
  if (typeof Project === "undefined" || !Project) return;
  const details = asRecord(event);
  const ids = new Set(["save", "reference"].flatMap(key => {
    const snapshot = asRecord(details?.[key]);
    return Object.keys(asRecord(snapshot?.texture_groups) ?? {});
  }));
  if (ids.size === 0) return;
  const groups = TextureGroup.all.filter(group => group.is_material && ids.has(group.uuid));
  refreshGroups(groups);
  groups.flatMap(group => group.getTextures()).forEach(watchTextureImage);
}

/**
 * Listen for native undo/redo/cancellation restoring material group snapshots.
 * Only affected group UUIDs are refreshed; decoded images also refresh their
 * current material once ready. Calling setup repeatedly adds no extra listener.
 */
export function setupMaterialUndoRefresh(): void {
  if (listening) return;
  Blockbench.on(UNDO_RESTORE_EVENT, refreshLoadedUndoSave);
  listening = true;
}

/**
 * Stops material refreshes when the plugin unloads, so no Blockbench event or
 * image callback keeps calling into an unloaded bundle. Removes the undo
 * listener and every pending image load/error listener without refreshing
 * those materials. Safe to call repeatedly or without a prior setup.
 */
export function teardownMaterialUndoRefresh(): void {
  if (listening) Blockbench.removeListener(UNDO_RESTORE_EVENT, refreshLoadedUndoSave);
  listening = false;
  [...pendingImages.values()].forEach(cleanup => cleanup());
}
