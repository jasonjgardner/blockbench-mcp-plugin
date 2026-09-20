import { resolve } from "node:path";
import { sequential } from "./config";

/** File extensions for archived MCP binaries; anything unrecognized is stored as `.bin`. */
const extensions: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "model/gltf-binary": "glb",
};

/** Converts unknown failures into useful text without serializing requests, headers or SDK objects. */
export function errorText(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

/** Replaces known credentials anywhere in trace text, including model/tool echoes. */
export function redact(text: string, secrets: readonly string[]): string {
  return secrets
    .filter(Boolean)
    .reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), text)
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]");
}

/** Hashes exact serialized evidence to identify drift without relying on Git's clean state. */
export function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/**
 * Runs work and captures its failure instead of throwing, so later cleanup steps still run.
 * Returns `undefined` on success, or a wrapper holding whatever was thrown.
 */
export async function caught(
  work: () => Promise<unknown>,
): Promise<{ error: unknown } | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return { error };
  }
}

/** Writes ordered, individually durable events and artifacts into a local, git-ignored trial directory. */
export class Evidence {
  private sequence = 0;
  private artifact = 0;
  private readonly binaries = new Map<string, string>();

  /** Root is selected by the harness, never by a model; secrets are used only for redaction. */
  constructor(
    readonly root: string,
    private readonly secrets: readonly string[] = [],
  ) {}

  /**
   * Saves a named UTF-8 artifact; callers supply trusted relative paths. Bun creates
   * parent directories. Empty text is skipped, so no empty evidence files are written.
   */
  async text(path: string, value: string): Promise<void> {
    if (!value) return;
    await Bun.write(resolve(this.root, path), redact(value, this.secrets));
  }

  /** Saves readable JSON with stable indentation, omitting credentials from all string values. */
  async json(path: string, value: unknown): Promise<void> {
    await this.text(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  /** Persists an event immediately, preserving failed attempts as well as successful ones. */
  async event(kind: string, data: unknown): Promise<void> {
    this.sequence += 1;
    await this.json(`events/${String(this.sequence).padStart(5, "0")}.json`, {
      sequence: this.sequence,
      at: new Date().toISOString(),
      kind,
      data,
    });
  }

  /**
   * Extracts MCP images and embedded exports; text agents receive references instead of base64.
   * Traversal is sequential so artifact numbering and de-duplication stay deterministic.
   */
  async materialize(value: unknown): Promise<unknown> {
    if (Array.isArray(value))
      return sequential(value, (item) => this.materialize(item));
    if (typeof value !== "object" || value === null) return value;
    const record = value as Record<string, unknown>;
    const encoded =
      typeof record.data === "string" && record.type === "image"
        ? record.data
        : record.blob;
    if (typeof encoded === "string") {
      const mime =
        typeof record.mimeType === "string"
          ? record.mimeType
          : "application/octet-stream";
      const { data: _data, blob: _blob, ...metadata } = record;
      return {
        ...metadata,
        artifact: await this.archive(mime, encoded),
        observation:
          "Binary artifact archived; unavailable to this text-only agent.",
      };
    }
    const entries = await sequential(
      Object.entries(record),
      async ([key, item]) => [key, await this.materialize(item)] as const,
    );
    return Object.fromEntries(entries);
  }

  /** Writes a base64 payload once per distinct content and returns its relative artifact path. */
  private async archive(mime: string, encoded: string): Promise<string> {
    const hash = sha256(`${mime}:${encoded}`);
    const existing = this.binaries.get(hash);
    if (existing) return existing;
    this.artifact += 1;
    const path = `artifacts/${String(this.artifact).padStart(5, "0")}.${extensions[mime] ?? "bin"}`;
    // Buffer's lenient decoder (not strict Uint8Array.fromBase64) tolerates base64url and
    // stray characters, so an odd tool payload is archived instead of failing the trial.
    await Bun.write(resolve(this.root, path), Buffer.from(encoded, "base64"));
    this.binaries.set(hash, path);
    return path;
  }
}
