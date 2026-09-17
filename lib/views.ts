/// <reference types="three" />
/// <reference types="blockbench-types" />
/**
 * Registry of render targets for the camera tools.
 *
 * Agents can address the user's viewports or plugin-owned offscreen views. An
 * offscreen view is a Blockbench `Preview` created with `offscreen: true`: it
 * shares the live scene but owns its camera, renderer, and canvas and never
 * joins the DOM, so agents can frame the model without moving the user's
 * camera. This module tracks those previews, remembers the camera an agent
 * gave each one (Blockbench re-targets every preview, offscreen ones included,
 * when a project is selected), and renders gizmo-free frames.
 *
 * @module
 */
import { ACTIVE_VIEW_ID, MAX_OFFSCREEN_VIEWS, NO_COPY_VIEW_ID, RESERVED_VIEW_IDS } from "@/lib/constants";

/**
 * Render targets an agent can address. A `viewport` is a Blockbench preview the
 * user sees and interacts with; an `offscreen` view is owned by this plugin.
 */
export type ViewKind = "viewport" | "offscreen";

/** Camera projection of a view. */
export type ViewProjection = "orthographic" | "perspective";

/** Camera state of a view, rounded to three decimals for readable tool output. */
export interface IViewCamera {
  projection: ViewProjection;
  /** Camera position in Blockbench world units. */
  position: number[];
  /** Orbit target the camera looks at; empty when the preview exposes no orbit controls. */
  target: number[];
  /** Perspective field of view in degrees. */
  fov: number;
  /** Orthographic zoom factor. */
  zoom: number;
  /** Locked side view name (`top`, `north`, ...) when the view is axis-aligned. */
  locked_angle: string | null;
}

/** Metadata describing one render target, as reported by `list_views`. */
export interface IViewInfo {
  /** Identifier accepted by view-aware tools. Viewports use Blockbench's preview ID. */
  id: string;
  kind: ViewKind;
  /** Whether this is the viewport the user last interacted with (`Preview.selected`). */
  active: boolean;
  /** Rendered width in pixels: the canvas backing store for viewports, the fixed size for offscreen views. */
  width: number;
  /** Rendered height in pixels. */
  height: number;
  /** Multisampling flag chosen at creation; only reported for offscreen views. */
  antialias?: boolean;
  camera: IViewCamera;
}

/** Camera angle accepted by {@link loadViewAngle}; mirrors Blockbench's angle presets. */
export interface ICameraAngle {
  position: number[];
  target?: number[];
  /** Euler rotation in degrees, used to derive the target when `target` is omitted. */
  rotation?: number[];
  projection: "unset" | ViewProjection;
  /** Orthographic zoom factor; Blockbench ignores it while a side view is locked. */
  zoom?: number;
  /** Perspective field of view in degrees; Blockbench's setting applies when omitted. */
  fov?: number;
  /** Locks an orthographic side view such as `top` or `north`. */
  locked_angle?: string;
}

/** Inputs for {@link createOffscreenView}. */
export interface ICreateOffscreenViewOptions {
  /** Agent-facing ID; generated as `view_N` when omitted. */
  id?: string;
  width: number;
  height: number;
  antialias: boolean;
  /**
   * View whose camera seeds the new one. `"active"` (the default) copies the
   * user's active viewport; `"none"` keeps Blockbench's default angle.
   */
  copyFrom?: string;
}

/** Constructor options Blockbench accepts at runtime; `offscreen` is omitted by blockbench-types. */
interface IOffscreenPreviewOptions extends PreviewOptions {
  offscreen: boolean;
}

/** Runtime `Preview` members omitted by blockbench-types, verified by {@link isOffscreenPreview}. */
interface IOffscreenPreview extends Preview {
  offscreen: boolean;
  resize(width?: number, height?: number): unknown;
  copyView(preview: Preview): void;
}

interface IOffscreenViewRecord {
  readonly id: string;
  readonly preview: IOffscreenPreview;
  readonly width: number;
  readonly height: number;
  readonly antialias: boolean;
  /** Camera the agent last gave the view; re-applied before rendering when Blockbench changed it. */
  readonly camera: IViewCamera;
}

/** Keeps plugin previews distinguishable from Blockbench's own entries in `Preview.all`. */
const OFFSCREEN_PREVIEW_ID_PREFIX = "mcp_offscreen_";
const PREVIEW_METHODS = ["render", "resize", "copyView", "loadAnglePreset", "delete"] as const;

const offscreenViews = new Map<string, IOffscreenViewRecord>();
let generatedViewCount = 0;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOffscreenPreview(preview: Preview): preview is IOffscreenPreview {
  if (!preview.canvas || Reflect.get(preview, "offscreen") !== true) return false;
  return PREVIEW_METHODS.every(method => typeof Reflect.get(preview, method) === "function");
}

function isVectorLike(value: unknown): value is { toArray(): unknown } {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "toArray") === "function";
}

function roundComponent(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function toArrayVector(vector: number[]): ArrayVector3 {
  const [x = 0, y = 0, z = 0] = vector;
  return [x, y, z];
}

/** `Preview#controls` is `any` in blockbench-types, so the orbit target is read defensively. */
function readTarget(preview: Preview): number[] {
  const target: unknown = preview.controls?.target;
  if (!isVectorLike(target)) return [];
  const values = target.toArray();
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is number => typeof value === "number").map(roundComponent);
}

function describeCamera(preview: Preview): IViewCamera {
  const angle: unknown = preview.angle;
  return {
    projection: preview.isOrtho ? "orthographic" : "perspective",
    position: preview.camera.position.toArray().map(roundComponent),
    target: readTarget(preview),
    fov: roundComponent(preview.camPers.fov),
    zoom: roundComponent(preview.camOrtho.zoom),
    locked_angle: typeof angle === "string" ? angle : null,
  };
}

function sameCamera(a: IViewCamera, b: IViewCamera): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Builds a Blockbench angle preset, omitting unset keys so `loadAnglePreset` keeps its fallbacks. */
function buildAnglePreset(angle: ICameraAngle): AnglePreset {
  const preset: AnglePreset = {
    position: toArrayVector(angle.position),
    projection: angle.projection,
    ...(angle.target ? { target: toArrayVector(angle.target) } : {}),
    ...(angle.rotation ? { rotation: toArrayVector(angle.rotation) } : {}),
    ...(angle.zoom === undefined ? {} : { zoom: angle.zoom }),
    ...(angle.fov === undefined ? {} : { fov: angle.fov }),
  };
  // blockbench-types declares `locked_angle` as a number, but Blockbench compares it
  // with side-view names such as "top"; the intersection stays assignable to AnglePreset.
  return angle.locked_angle ? Object.assign(preset, { locked_angle: angle.locked_angle }) : preset;
}

function cameraToAngle(camera: IViewCamera): ICameraAngle {
  return {
    position: camera.position,
    target: camera.target,
    projection: camera.projection,
    zoom: camera.zoom,
    fov: camera.fov,
    ...(camera.locked_angle ? { locked_angle: camera.locked_angle } : {}),
  };
}

function findRecord(preview: Preview): IOffscreenViewRecord | undefined {
  return [...offscreenViews.values()].find(record => record.preview === preview);
}

function requireOffscreenView(id: string): IOffscreenViewRecord {
  const record = offscreenViews.get(id);
  if (!record) {
    throw new Error(`Unknown offscreen view "${id}". Create one with create_offscreen_view or check list_views.`);
  }
  return record;
}

function findActiveViewport(): Preview | undefined {
  return Preview.selected ?? Preview.all.find(preview => preview.canvas.isConnected);
}

/**
 * Describes a preview for tool output. Offscreen views report their agent-facing
 * ID and fixed size; viewports report Blockbench's preview ID and the canvas
 * backing-store size, which is what a screenshot of them measures.
 *
 * @param preview - Any Blockbench preview, connected or offscreen.
 * @returns View metadata including the current camera state.
 */
export function describeView(preview: Preview): IViewInfo {
  const record = findRecord(preview);
  const camera = describeCamera(preview);
  if (record) {
    return {
      id: record.id,
      kind: "offscreen",
      active: false,
      width: record.width,
      height: record.height,
      antialias: record.antialias,
      camera,
    };
  }
  return {
    id: preview.id,
    kind: "viewport",
    active: preview === Preview.selected,
    width: preview.canvas.width,
    height: preview.canvas.height,
    camera,
  };
}

/**
 * Lists the user's connected viewports followed by plugin-owned offscreen views.
 * Blockbench's internal media previews are excluded because Screencam owns them.
 *
 * @returns Every view an agent may target, viewports first.
 */
export function listViews(): IViewInfo[] {
  const viewports = Preview.all.filter(preview => preview.canvas.isConnected).map(describeView);
  const offscreen = [...offscreenViews.values()].map(record => describeView(record.preview));
  return [...viewports, ...offscreen];
}

/** @returns Number of offscreen views currently owned by the plugin. */
export function getOffscreenViewCount(): number {
  return offscreenViews.size;
}

/** @returns Whether another offscreen view fits under {@link MAX_OFFSCREEN_VIEWS}. */
export function canCreateOffscreenView(): boolean {
  return offscreenViews.size < MAX_OFFSCREEN_VIEWS;
}

/**
 * Resolves a view reference to a Blockbench preview.
 *
 * @param ref - `"active"` for the user's active viewport, an offscreen view ID, or a
 *   connected viewport ID from {@link listViews}. Defaults to the active viewport.
 * @returns The matching preview.
 * @throws {Error} When no viewport is active or the reference is unknown.
 */
export function resolveView(ref: string = ACTIVE_VIEW_ID): Preview {
  if (ref === ACTIVE_VIEW_ID) {
    const active = findActiveViewport();
    if (!active) throw new Error("No active viewport is available in the Blockbench editor.");
    return active;
  }
  const record = offscreenViews.get(ref);
  if (record) return record.preview;
  const viewport = Preview.all.find(preview => preview.id === ref && preview.canvas.isConnected);
  if (viewport) return viewport;
  throw new Error(
    `Unknown view "${ref}". Use "${ACTIVE_VIEW_ID}", an offscreen view ID from create_offscreen_view, or a viewport ID from list_views.`
  );
}

/**
 * Applies a camera angle to a view. Offscreen views also remember the angle so
 * it survives Blockbench re-targeting previews on project selection.
 *
 * @param preview - Target from {@link resolveView}.
 * @param angle - Position, target or rotation, projection, and optional zoom, FOV, and side-view lock.
 */
export function loadViewAngle(preview: Preview, angle: ICameraAngle): void {
  preview.loadAnglePreset(buildAnglePreset(angle));
  const record = findRecord(preview);
  if (!record) return;
  offscreenViews.set(record.id, { ...record, camera: describeCamera(preview) });
}

function nextGeneratedId(): string {
  generatedViewCount += 1;
  const id = `view_${generatedViewCount}`;
  return offscreenViews.has(id) ? nextGeneratedId() : id;
}

function assertAvailableId(id: string): void {
  if (RESERVED_VIEW_IDS.includes(id)) {
    throw new Error(`"${id}" is a reserved view reference and cannot name an offscreen view.`);
  }
  if (offscreenViews.has(id)) throw new Error(`Offscreen view "${id}" already exists.`);
  if (Preview.all.some(preview => preview.id === id)) {
    throw new Error(`"${id}" is the ID of a Blockbench viewport; choose a different offscreen view ID.`);
  }
}

function resolveCopySource(copyFrom: string | undefined): Preview | undefined {
  if (copyFrom === NO_COPY_VIEW_ID) return undefined;
  if (copyFrom === undefined || copyFrom === ACTIVE_VIEW_ID) return findActiveViewport();
  return resolveView(copyFrom);
}

function disposeQuietly(preview: Preview): void {
  try {
    if (typeof Reflect.get(preview, "delete") === "function") preview.delete();
  } catch (error) {
    console.error("[MCP] Failed to dispose an offscreen preview:", error);
  }
}

function instantiateOffscreenPreview(options: IOffscreenPreviewOptions): Preview {
  try {
    return new Preview(options);
  } catch (error) {
    throw new Error(
      `Blockbench could not create an offscreen preview; the WebGL context limit may be reached. ${describeError(error)}`,
      { cause: error }
    );
  }
}

/**
 * Creates a plugin-owned offscreen `Preview`. The preview shares the live scene
 * with the user's viewport but has its own camera, renderer, and canvas, so
 * moving it does not move the user's camera.
 *
 * @param options - Size, antialiasing, optional ID, and the view to copy the camera from.
 * @returns Metadata for the new view.
 * @throws {Error} When the ID is reserved, taken, or names a Blockbench viewport; the cap is
 *   reached; the copy source is unknown; or Blockbench cannot create an offscreen preview.
 */
export function createOffscreenView(options: ICreateOffscreenViewOptions): IViewInfo {
  const id = options.id ?? nextGeneratedId();
  assertAvailableId(id);
  if (!canCreateOffscreenView()) {
    throw new Error(
      `At most ${MAX_OFFSCREEN_VIEWS} offscreen views can exist at once; delete one with delete_offscreen_view first.`
    );
  }
  // Resolve the source before constructing so a bad reference never costs a WebGL context.
  const source = resolveCopySource(options.copyFrom);
  const preview = instantiateOffscreenPreview({
    id: `${OFFSCREEN_PREVIEW_ID_PREFIX}${id}`,
    antialias: options.antialias,
    offscreen: true,
  });
  if (!isOffscreenPreview(preview)) {
    disposeQuietly(preview);
    throw new Error("This Blockbench version does not support offscreen previews.");
  }
  try {
    // Size first: copyView() scales orthographic bounds to the current aspect ratio,
    // so it needs real dimensions and must not be overwritten by a later resize.
    preview.resize(options.width, options.height);
    if (source) preview.copyView(source);
  } catch (error) {
    disposeQuietly(preview);
    throw error;
  }
  offscreenViews.set(id, {
    id,
    preview,
    width: options.width,
    height: options.height,
    antialias: options.antialias,
    camera: describeCamera(preview),
  });
  return describeView(preview);
}

/**
 * Changes the canvas size of an offscreen view.
 *
 * @param id - Offscreen view ID.
 * @param width - New width in pixels.
 * @param height - New height in pixels.
 * @returns Updated view metadata.
 * @throws {Error} When the view does not exist.
 */
export function resizeOffscreenView(id: string, width: number, height: number): IViewInfo {
  const record = requireOffscreenView(id);
  record.preview.resize(width, height);
  offscreenViews.set(id, { ...record, width, height });
  return describeView(record.preview);
}

/**
 * Disposes an offscreen view, releasing its renderer and WebGL context. The
 * registry entry is removed even if Blockbench's disposal throws, so a
 * half-disposed preview is never reported as usable.
 *
 * @param id - Offscreen view ID.
 * @throws {Error} When the view does not exist or disposal fails.
 */
export function deleteOffscreenView(id: string): void {
  const record = requireOffscreenView(id);
  try {
    record.preview.delete();
  } finally {
    offscreenViews.delete(id);
  }
}

/** Disposes every offscreen view, continuing past failures; called when the plugin unloads. */
export function teardownOffscreenViews(): void {
  [...offscreenViews.keys()].forEach(id => {
    try {
      deleteOffscreenView(id);
    } catch (error) {
      console.error(`[MCP] Failed to dispose offscreen view "${id}":`, error);
    }
  });
  generatedViewCount = 0;
}

/**
 * Re-applies an offscreen view's recorded size and camera when Blockbench has
 * changed them. `ModelProject#loadEditorState()` runs on every project
 * selection and re-targets each entry in `Preview.all`, offscreen ones included.
 */
function restoreOffscreenView(record: IOffscreenViewRecord): void {
  const { preview, camera } = record;
  if (preview.width !== record.width || preview.height !== record.height) {
    preview.resize(record.width, record.height);
  }
  if (sameCamera(describeCamera(preview), camera)) return;
  preview.loadAnglePreset(buildAnglePreset(cameraToAngle(camera)));
  if (camera.projection !== "orthographic") return;
  // loadAnglePreset skips the zoom while a side view is locked.
  preview.camOrtho.zoom = camera.zoom;
  preview.camOrtho.updateProjectionMatrix();
}

/**
 * Renders one frame of a view with gizmos, grids, and selection outlines hidden
 * and returns the PNG data URL. A connected viewport is repainted afterwards so
 * the user never sees a gizmo-free frame linger while Blockbench's render loop
 * is idle.
 *
 * @param preview - A viewport or offscreen preview from {@link resolveView}.
 * @returns A `data:image/png;base64,...` URL.
 * @throws {Error} When rendering fails; Blockbench logs the underlying error.
 */
export function renderViewToDataUrl(preview: Preview): string {
  const record = findRecord(preview);
  if (record) restoreOffscreenView(record);
  let dataUrl: string | undefined;
  Canvas.withoutGizmos(() => {
    preview.render();
    dataUrl = preview.canvas.toDataURL();
  });
  if (!dataUrl) throw new Error("Failed to render the view.");
  if (preview.canvas.isConnected) preview.render();
  return dataUrl;
}
