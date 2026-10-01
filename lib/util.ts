import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ACTIVE_VIEW_ID } from "@/lib/constants";
import { renderViewToDataUrl, resolveView } from "@/lib/views";

/**
 * Helper function to create properly formatted image content for MCP responses.
 * Handles data URLs, base64 strings, and objects with url property.
 *
 * @param dataOrOptions - Image data as base64/data URL string, or object with { url: string }
 * @param mimeType - MIME type of the image (e.g., 'image/png', 'image/jpeg')
 * @returns Formatted MCP tool result with image content
 */
export function imageContent(
  dataOrOptions: string | { url: string },
  mimeType: string = "image/png"
): { content: Array<{ type: "image"; data: string; mimeType: string }> } {
  // Handle object with url property
  const data = typeof dataOrOptions === "string" ? dataOrOptions : dataOrOptions.url;
  let base64Data = data;

  // If it's a data URL, extract the base64 part
  if (data.startsWith("data:")) {
    const matches = data.match(/^data:([^;]+);base64,(.+)$/);
    if (matches) {
      mimeType = matches[1] || mimeType;
      base64Data = matches[2];
    }
  }

  return {
    content: [
      {
        type: "image" as const,
        data: base64Data,
        mimeType,
      },
    ],
  };
}

export function fixCircularReferences<
  T extends Record<string, any>,
  K extends keyof T,
  V extends T[K]
>(o: T): (k: K, v: V) => V | string {
  const weirdTypes = [
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    BigInt64Array,
    BigUint64Array,
    //Float16Array,
    Float32Array,
    Float64Array,
    ArrayBuffer,
    // SharedArrayBuffer,
    DataView,
  ];

  const defs = new Map();

  return function (k: K, v: V): V | string {
    if (k && (v as unknown) === o)
      return "[" + (k as string) + " is the same as original object]";
    if (v === undefined) return undefined as V;
    if (v === null) return null as V;
    const weirdType = weirdTypes.find((t) => (v as unknown) instanceof t);
    if (weirdType) return weirdType.toString();
    if (typeof v == "function") {
      return v.toString();
    }
    if (v && typeof v == "object") {
      const def = defs.get(v);
      if (def)
        return "[" + (k as string) + " is the same as " + (def as string) + "]";
      defs.set(v, k);
    }
    return v;
  };
}

export function getProjectTexture(id: string): Texture | null {
  const texture = (Project?.textures ?? Texture.all).find(
    ({ id: textureId, name, uuid }) =>
      textureId === id || name === id || uuid === id
  );

  return texture || null;
}

/**
 * Programmatically sets a BarItems slider/widget's value, tolerating the API
 * drift between Blockbench versions where some items expose `.set(n)`,
 * `.change(n)`, or only allow `.value = n`. Prior to this helper, calls like
 * `BarItems.slider_brush_size.set(n)` crashed hollow-shape drawing with
 * `… .set is not a function` on current Blockbench builds.
 */
export function setBarItemValue(id: string, value: unknown): void {
  const item: unknown = Reflect.get(BarItems, id);
  if (typeof item !== "object" || item === null) return;
  const set: unknown = Reflect.get(item, "set");
  if (typeof set === "function") {
    try {
      set.call(item, value);
      return;
    } catch {
      // Fall through to direct assignment for widgets whose runtime method
      // signatures drifted from the public type surface.
    }
  }
  if ("value" in item) {
    Reflect.set(item, "value", value);
    const update: unknown = Reflect.get(item, "update");
    if (typeof update === "function") update.call(item);
    return;
  }
  const change: unknown = Reflect.get(item, "change");
  if (typeof change !== "function") return;
  try {
    change.call(item, value);
  } catch {
    // Best-effort UI setting; callers should not fail because Blockbench
    // changed an optional widget mutator signature.
  }
}

/**
 * Resolves a texture reference and activates it in the panel so that paint
 * tools, which historically act on `Texture.selected` regardless of their
 * `texture_id` argument, target the intended texture.
 *
 * If `id` is omitted, the currently selected texture is used as-is. Throws an
 * actionable error when the reference cannot be resolved.
 */
export function getAndActivateTexture(id?: string): Texture {
  if (!id) {
    const active = Texture.selected ?? Texture.getDefault();
    if (!active) {
      throw new Error(
        "No texture available. Use create_texture first, or pass texture_id explicitly."
      );
    }
    if (Texture.selected?.uuid !== active.uuid) {
      active.select();
    }
    return active;
  }

  const texture = getProjectTexture(id);
  if (!texture) {
    throw new Error(
      `Texture "${id}" not found. Use the list_textures tool to see available textures.`
    );
  }
  // Blockbench paint tools operate on Texture.selected, so activating the
  // requested texture is the only reliable way to make texture_id behave like
  // a real scope argument.
  if (Texture.selected?.uuid !== texture.uuid) {
    texture.select();
  }
  return texture;
}

// ============================================================================
// Lookup Helpers with Actionable Error Messages
// ============================================================================

/**
 * Finds a group/bone by name and throws an actionable error if not found.
 * @param name - The name of the group/bone to find
 * @returns The found Group
 * @throws Error with suggestion to use list_outline
 */
export function findGroupOrThrow(name: string): Group {
  // @ts-ignore - Group is globally available in Blockbench
  const group = Group.all.find((g: Group) => g.name === name);
  if (!group) {
    throw new Error(
      `Bone/group "${name}" not found. Use the list_outline tool to see available groups and bones.`
    );
  }
  return group;
}

/**
 * Finds a mesh by UUID, or by a unique name, and throws an actionable error if not found.
 * @param id - The UUID or name of the mesh to find
 * @returns The found Mesh
 * @throws Error with suggestion to use list_outline, or listing the UUIDs when the name is shared
 */
export function findMeshOrThrow(id: string): Mesh {
  // UUID first; a name must be unique, as in findElementOrThrow, or edits land on the wrong mesh.
  const byUuid = Mesh.all.find((m: Mesh) => m.uuid === id);
  if (byUuid) return byUuid;
  const byName = Mesh.all.filter((m: Mesh) => m.name === id);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const listed = byName.map((m: Mesh) => m.uuid).join(", ");
    throw new Error(`Mesh name "${id}" matches ${byName.length} meshes (${listed}); pass the UUID of the one you mean.`);
  }
  throw new Error(
    `Mesh "${id}" not found. Use the list_outline tool to see available meshes.`
  );
}

/**
 * Finds an element (cube, mesh, group) by ID or name and throws an actionable error if not found.
 * @param id - The UUID or name of the element to find
 * @returns The found element or group
 * @throws Error with suggestion to use list_outline
 */
export function findElementOrThrow(id: string): OutlinerElement | Group {
  // UUID first. A name must be unique: geo.json imports name each cube after
  // its bone, and the first match would silently be the wrong node.
  const byUuid = Outliner.elements.find((el: OutlinerElement) => el.uuid === id)
    ?? Group.all.find((g: Group) => g.uuid === id);
  if (byUuid) return byUuid;
  const byName: Array<OutlinerElement | Group> = [
    ...Outliner.elements.filter((el: OutlinerElement) => el.name === id),
    ...Group.all.filter((g: Group) => g.name === id),
  ];
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const listed = byName.map((node) => `${node instanceof Group ? "group" : node.type} ${node.uuid}`).join(", ");
    throw new Error(`Name "${id}" matches ${byName.length} nodes (${listed}); pass the UUID of the one you mean.`);
  }
  throw new Error(
    `Element "${id}" not found. Use the list_outline tool to see available elements.`
  );
}

/**
 * Finds a texture by ID, name, or UUID and throws an actionable error if not found.
 * @param id - The ID, name, or UUID of the texture to find
 * @returns The found Texture
 * @throws Error with suggestion to use list_textures
 */
export function findTextureOrThrow(id: string): Texture {
  const texture = getProjectTexture(id);
  if (!texture) {
    throw new Error(
      `Texture "${id}" not found. Use the list_textures tool to see available textures.`
    );
  }
  return texture;
}

/**
 * Helper to find a TextureGroup by name or UUID
 */
export function findTextureGroupOrThrow(id: string): TextureGroup {
  // @ts-ignore - TextureGroup is globally available in Blockbench
  const group = TextureGroup.all.find(
    (g: TextureGroup) => g.uuid === id || g.name === id
  );
  if (!group) {
    throw new Error(
      `Material/texture group "${id}" not found. Use the list_materials tool to see available materials.`
    );
  }
  return group;
}

/**
 * Helper to get texture info for a PBR channel
 */
export function getChannelTextureInfo(textures: Texture[], channel: string) {
  const tex = textures.find((t: Texture) => t.pbr_channel === channel);
  return tex
    ? { name: tex.name, uuid: tex.uuid, hasTexture: true }
    : { hasTexture: false };
}

/**
 * Gets a mesh by ID or returns the selected mesh if no ID provided.
 * Throws an actionable error if no mesh is found.
 * @param meshId - Optional mesh UUID or name
 * @returns The found or selected Mesh
 * @throws Error with suggestion to use list_outline
 */
export function getMeshOrSelected(meshId?: string): Mesh {
  if (meshId) {
    return findMeshOrThrow(meshId);
  }
  // @ts-ignore - Mesh is globally available in Blockbench
  const selected = Mesh.selected[0];
  if (!selected) {
    throw new Error(
      "No mesh selected and no mesh_id provided. Select a mesh or provide a mesh_id. Use the list_outline tool to see available meshes."
    );
  }
  return selected;
}

/**
 * Captures a screenshot of a 3D view using Blockbench's native rendering pipeline.
 *
 * @param project - Project name or UUID to select before rendering; defaults to the active project.
 * @param view - `"active"` for the user's active viewport, an offscreen view ID, or a viewport ID.
 * @returns MCP image content holding the PNG frame.
 * @throws {Error} When no project is open, the view is unknown, or rendering fails.
 */
export function captureScreenshot(project?: string, view: string = ACTIVE_VIEW_ID) {
  const previous: ModelProject | undefined = Project || undefined;
  const target = project === undefined ? previous : findProject(project);

  if (!target) {
    throw new Error("No project found in the Blockbench editor.");
  }

  // Render the requested project, then give the user their tab back.
  const switched = !target.selected;
  const release = switched ? holdDeferredCallbacks(target) : undefined;
  if (switched && (target.select() as unknown) === false) {
    release?.();
    throw new Error(`Could not switch to project "${target.name}".`);
  }
  try {
    return imageContent(renderViewToDataUrl(resolveView(view)), "image/png");
  } finally {
    if (switched && previous && previous !== target && ModelProject.all.includes(previous)) {
      previous.select();
    }
    release?.();
  }
}

/** A project's queue of `whenNextOpen` callbacks, which `ModelProject#select()` runs on the next Vue tick. */
interface IDeferredCallbacks {
  on_next_upen?: Array<() => void>;
}

/**
 * Takes `project`'s pending `whenNextOpen` callbacks off it for a brief tab switch.
 *
 * `select()` runs them in `Vue.nextTick`, after a synchronous capture has already
 * switched back, so they would run against the user's tab (texture reloads can
 * resize or convert the active project). The returned function puts them back
 * on a later tick, after the switch's own tick has found the queue empty, so
 * they still run when the user really opens the project. If the project is
 * active again by then, they run right away.
 *
 * @param project - The project about to be selected temporarily.
 * @param schedule - Defers the restore; Blockbench's `Vue.nextTick` by default.
 * @returns A function that restores the callbacks; call it once, after switching back.
 */
export function holdDeferredCallbacks(
  project: ModelProject,
  // @ts-ignore - Vue is a Blockbench global
  schedule: (callback: () => void) => void = (callback) => Vue.nextTick(callback),
): () => void {
  const host = project as unknown as IDeferredCallbacks;
  const held = host.on_next_upen;
  if (!Array.isArray(held) || held.length === 0) return () => {};
  delete host.on_next_upen;
  return () =>
    schedule(() => {
      if (project.selected) {
        held.forEach((callback) => callback());
        return;
      }
      host.on_next_upen = [...held, ...(host.on_next_upen ?? [])];
    });
}

/**
 * Finds an open project by UUID, or by a unique name.
 *
 * @throws {Error} When nothing matches or the name is shared by several projects.
 */
function findProject(ref: string): ModelProject {
  const byUuid = ModelProject.all.find((p) => p.uuid === ref);
  if (byUuid) return byUuid;
  const byName = ModelProject.all.filter((p) => p.name === ref);
  if (byName.length === 1) return byName[0];
  const open = ModelProject.all.map((p) => `"${p.name}" (${p.uuid})`).join(", ") || "none";
  if (byName.length > 1) {
    throw new Error(`Project name "${ref}" is shared by ${byName.length} open projects; use the UUID. Open projects: ${open}.`);
  }
  throw new Error(`No open project with name or UUID "${ref}". Open projects: ${open}.`);
}

/** Text returned with app captures taken while Chromium treats the window as hidden. */
export const HIDDEN_WINDOW_CAPTURE_WARNING =
  'Warning: the Blockbench window is covered or minimized (document.visibilityState is "hidden"). ' +
  "Chromium does not repaint hidden windows, so this image can show an earlier state than the current one. " +
  "Confirm state with a read-only query, use capture_screenshot for 3D views (it renders on demand), " +
  "or bring Blockbench to the front.";

/**
 * Captures a screenshot of the entire Blockbench application window.
 * Uses Electron's native capturePage API through Blockbench's Screencam.
 * Only available when running as a desktop application.
 *
 * capturePage returns the last frame Chromium painted. While the window is
 * covered or minimized the page is hidden and nothing repaints (repainting
 * viewports or waiting for frames does not help), so the image can predate the
 * latest tool calls; the result then starts with a text warning.
 */
export async function captureAppScreenshot(): Promise<CallToolResult> {
  const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  const capture = await captureAppImage();
  if (!hidden) return capture;
  return { content: [{ type: "text", text: HIDDEN_WINDOW_CAPTURE_WARNING }, ...capture.content] };
}

/** Screencam.fullScreen wrapped in a promise, with a timeout and an empty-capture check. */
function captureAppImage(): Promise<ReturnType<typeof imageContent>> {
  return new Promise((resolve, reject) => {
    let resolved = false;

    // Add a timeout in case the callback is never called
    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error("App screenshot timed out after 5 seconds."));
      }
    }, 5000);

    // Use Blockbench's native Screencam.fullScreen which uses Electron's capturePage
    // @ts-ignore - Screencam is globally available in Blockbench
    Screencam.fullScreen({}, (dataUrl: string) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        // A bare "data:image/png;base64," is an empty capture, not an image.
        if (dataUrl && !/^data:[^;,]*;base64,$/.test(dataUrl)) {
          resolve(imageContent(dataUrl, "image/png"));
        } else {
          reject(
            new Error("Failed to capture app screenshot - no data returned.")
          );
        }
      }
    });
  });
}

/**
 * Whether the active format keys bones by name (GeckoLib, Bedrock). Tolerates
 * hosts without the `Format` global, such as unit tests.
 */
export function formatUsesBoneRig(): boolean {
  const format: unknown = Reflect.get(globalThis, "Format");
  return typeof format === "object" && format !== null && Boolean(Reflect.get(format, "bone_rig"));
}
