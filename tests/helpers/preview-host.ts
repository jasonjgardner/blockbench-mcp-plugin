/**
 * Doubles for Blockbench's `Preview` class and `Canvas.withoutGizmos`.
 *
 * Every camera, resize, render, and lifecycle call is appended to `events` in
 * order, so tests can prove that offscreen views never touch the user's
 * viewport and that frames are rendered inside the gizmo-free window, exactly
 * as Blockbench's own Screencam does. Install the returned `Preview` and
 * `Canvas` as globals with `useGlobals`.
 *
 * @module
 */

/** Constructor options mirrored from Blockbench's `PreviewOptions` plus the runtime-only `offscreen` flag. */
export interface IHostPreviewOptions {
  readonly id: string;
  readonly antialias?: boolean;
  readonly offscreen?: boolean;
}

/** Angle preset shape passed to `loadAnglePreset`, mirroring Blockbench's `AnglePreset`. */
export interface IHostAnglePreset {
  readonly position: number[];
  readonly target?: number[];
  readonly rotation?: number[];
  readonly projection: string;
  readonly zoom?: number;
  readonly fov?: number;
  readonly locked_angle?: string | number;
}

/** Minimal `THREE.Vector3` stand-in supporting the calls the views module makes. */
export class HostVector3 {
  x: number;
  y: number;
  z: number;

  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  toArray(): number[] {
    return [this.x, this.y, this.z];
  }

  fromArray(values: number[]): this {
    const [x = 0, y = 0, z = 0] = values;
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  copy(other: HostVector3): this {
    return this.fromArray(other.toArray());
  }
}

/** One preview double; connected unless created with `offscreen: true`. */
export interface IHostPreview {
  readonly id: string;
  readonly offscreen: boolean;
  readonly antialias: boolean;
  width: number;
  height: number;
  isOrtho: boolean;
  angle: string | null;
  deleted: boolean;
  renders: number;
  /** Every preset passed to `loadAnglePreset`, in order. */
  readonly presets: IHostAnglePreset[];
  readonly camPers: { readonly position: HostVector3; fov: number };
  readonly camOrtho: { readonly position: HostVector3; zoom: number; updateProjectionMatrix(): void };
  readonly controls: { readonly target: HostVector3 };
  /** Canvas backing store; `width`/`height` follow `resize` like Blockbench's renderer does. */
  readonly canvas: { readonly isConnected: boolean; width: number; height: number; toDataURL(): string };
  /** Active camera, like Blockbench's getter. */
  readonly camera: { readonly position: HostVector3 };
  resize(width?: number, height?: number): this;
  render(): void;
  loadAnglePreset(preset: IHostAnglePreset): this;
  copyView(source: IHostPreview): void;
  delete(): void;
}

/** Static surface of the `Preview` double. */
export interface IHostPreviewClass {
  new (options: IHostPreviewOptions): IHostPreview;
  all: IHostPreview[];
  selected: IHostPreview | null;
}

/** Globals and inspection handles returned by {@link createPreviewHost}. */
export interface IPreviewHost {
  readonly Canvas: { withoutGizmos(callback: () => void): void };
  readonly Preview: IHostPreviewClass;
  /** Ordered log of every host call, e.g. `render:main` or `resize:mcp_offscreen_a:640x480`. */
  readonly events: string[];
  /** The connected, selected viewport created with the host (`id: "main"`, like Blockbench's). */
  readonly main: IHostPreview;
}

/**
 * Builds a fresh `Preview`/`Canvas` host with one connected viewport named `main`.
 *
 * `toDataURL` encodes `<preview id>:<render count>` so a test can tell which
 * preview produced an image and how many frames it rendered.
 *
 * @returns The host globals plus the `events` log and the `main` viewport.
 */
export function createPreviewHost(): IPreviewHost {
  const events: string[] = [];

  class HostPreview implements IHostPreview {
    static all: HostPreview[] = [];
    static selected: HostPreview | null = null;

    readonly id: string;
    readonly offscreen: boolean;
    readonly antialias: boolean;
    width = 0;
    height = 0;
    isOrtho = false;
    angle: string | null = null;
    deleted = false;
    renders = 0;
    readonly presets: IHostAnglePreset[] = [];
    readonly camPers = { position: new HostVector3(-80, 40, 80), fov: 45 };
    readonly camOrtho = { position: new HostVector3(), zoom: 0.5, updateProjectionMatrix: () => {} };
    readonly controls = { target: new HostVector3(0, 8, 0) };
    readonly canvas: { readonly isConnected: boolean; width: number; height: number; toDataURL(): string };

    constructor(options: IHostPreviewOptions) {
      this.id = options.id;
      this.offscreen = options.offscreen === true;
      this.antialias = options.antialias !== false;
      this.canvas = {
        isConnected: !this.offscreen,
        width: 0,
        height: 0,
        toDataURL: () => `data:image/png;base64,${btoa(`${this.id}:${this.renders}`)}`,
      };
      events.push(`create:${this.id}`);
      HostPreview.all.push(this);
    }

    get camera(): { readonly position: HostVector3 } {
      return this.isOrtho ? this.camOrtho : this.camPers;
    }

    resize(width?: number, height?: number): this {
      events.push(`resize:${this.id}:${width}x${height}`);
      if (width && height) {
        this.width = width;
        this.height = height;
        this.canvas.width = width;
        this.canvas.height = height;
      }
      return this;
    }

    render(): void {
      this.renders += 1;
      events.push(`render:${this.id}`);
    }

    loadAnglePreset(preset: IHostAnglePreset): this {
      this.presets.push(preset);
      events.push(`angle:${this.id}`);
      // Blockbench carries the position over when it switches cameras, so apply the
      // projection first and then position whichever camera is now active.
      if (preset.projection !== "unset") this.isOrtho = preset.projection === "orthographic";
      this.camera.position.fromArray(preset.position);
      if (preset.target) this.controls.target.fromArray(preset.target);
      if (this.isOrtho && preset.zoom && !preset.locked_angle) this.camOrtho.zoom = preset.zoom;
      if (!this.isOrtho) this.camPers.fov = preset.fov ?? 45;
      this.angle = this.isOrtho && typeof preset.locked_angle === "string" ? preset.locked_angle : null;
      return this;
    }

    copyView(source: IHostPreview): void {
      events.push(`copy:${this.id}<-${source.id}`);
      this.isOrtho = source.isOrtho;
      this.camPers.position.copy(source.camPers.position);
      this.camPers.fov = source.camPers.fov;
      this.camOrtho.position.copy(source.camOrtho.position);
      this.camOrtho.zoom = source.camOrtho.zoom;
      this.controls.target.copy(source.controls.target);
    }

    delete(): void {
      this.deleted = true;
      events.push(`delete:${this.id}`);
      HostPreview.all = HostPreview.all.filter(preview => preview !== this);
      if (HostPreview.selected !== this) return;
      HostPreview.selected = HostPreview.all.find(preview => preview.canvas.isConnected) ?? null;
    }
  }

  const Canvas = {
    withoutGizmos(callback: () => void): void {
      events.push("gizmos:hidden");
      // Blockbench logs and swallows callback errors so gizmos are always restored.
      try {
        callback();
      } catch {
        events.push("gizmos:error");
      }
      events.push("gizmos:restored");
    },
  };

  const main = new HostPreview({ id: "main" });
  HostPreview.selected = main;
  return { Canvas, Preview: HostPreview, events, main };
}
