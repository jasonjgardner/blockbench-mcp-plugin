/**
 * File access for the headless server: path sandboxing, revisions, locking and
 * atomic writes.
 *
 * Several agents can work at once because each one runs its own headless
 * process, or shares one process through several MCP sessions. Three guards keep
 * their edits from clobbering each other:
 *
 * - A lock file (`<model>.bbmodel.lock`, created with O_EXCL) serializes
 *   read-modify-write cycles across processes. Inside one process a promise
 *   chain does the same without touching the disk.
 * - Every read returns a `revision` (a hash of the file bytes). Write tools accept
 *   `expected_revision` and refuse to write when the file changed since the
 *   caller read it, so an agent never overwrites work it has not seen.
 * - Writes go to a temporary file first and are renamed into place, so a crash or
 *   a concurrent reader never sees a half-written model.
 *
 * The sandbox compares real paths (symlinks and junctions resolved), so a link
 * inside a root cannot lead outside it.
 *
 * @module
 */

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { upgradeToV5 } from "./legacy";
import { bbmodelSchema, type IBBModel } from "./schema";

/** Directories the server may read and write. */
export interface IWorkspace {
  readonly roots: readonly string[];
}

/** A model read from disk. */
export interface IModelSnapshot {
  /** Absolute path of the file. */
  path: string;
  doc: IBBModel;
  /** Hash of the file bytes; pass it back as `expected_revision` to guard writes. */
  revision: string;
  /** Notes produced while loading, such as a 4.x → 5.0 conversion. */
  notes: string[];
}

/** Outcome of a write. */
export interface IWriteResult<T> {
  path: string;
  revision: string;
  notes: string[];
  result: T;
}

/** Thrown when `expected_revision` no longer matches the file. */
export class RevisionConflictError extends Error {
  constructor(path: string, expected: string, actual: string) {
    super(`Revision conflict on ${path}: expected ${expected}, found ${actual}. Another agent changed the file; read it again and retry.`);
    this.name = "RevisionConflictError";
  }
}

/** How long a lock file may live before it is treated as abandoned by a crashed process. */
const STALE_LOCK_MS = 30_000;
/** How long a writer waits for another process's lock. */
const LOCK_TIMEOUT_MS = 15_000;
/** Windows errors raised while a scanner or another program briefly holds the target. */
const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EBUSY", "EACCES"]);

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;

const normalizeCase = (path: string): string => (process.platform === "win32" ? path.toLowerCase() : path);

const isInside = (root: string, target: string): boolean => {
  const rel = relative(normalizeCase(root), normalizeCase(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Real path of `target`, resolving links in its nearest existing ancestor. */
function realPathOf(target: string): string {
  if (existsSync(target)) return realpathSync.native(target);
  const parent = dirname(target);
  if (parent === target) return target;
  return join(realPathOf(parent), basename(target));
}

/**
 * Resolves a user-supplied path against the workspace and refuses anything outside it.
 *
 * @param input - Absolute path, or a path relative to the first root.
 * @param extensions - Allowed lowercase extensions such as `[".bbmodel"]`; empty allows any.
 * @throws Error for paths outside every root (after resolving symlinks), symlinked files, or a disallowed extension.
 */
export function resolveWorkspacePath(workspace: IWorkspace, input: string, extensions: readonly string[] = []): string {
  const [firstRoot] = workspace.roots;
  if (!firstRoot) throw new Error("The headless server has no workspace root configured.");
  const absolute = resolve(firstRoot, input);
  const roots = workspace.roots.map((root) => resolve(root));
  const realRoots = roots.map(realPathOf);
  const allowed = roots.some((root) => isInside(root, absolute)) && realRoots.some((root) => isInside(root, realPathOf(absolute)));
  if (!allowed) throw new Error(`Path ${absolute} is outside the workspace roots: ${workspace.roots.join(", ")}.`);
  if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) throw new Error(`Path ${absolute} is a symbolic link; use the real file.`);
  const lower = absolute.toLowerCase();
  if (extensions.length > 0 && !extensions.some((extension) => lower.endsWith(extension))) {
    throw new Error(`Path ${absolute} must end with ${extensions.join(" or ")}.`);
  }
  return absolute;
}

/** Short content hash used as a revision token. */
export function revisionOf(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);
}

/** Serializes a document the way Blockbench's default settings do (tab-indented JSON). */
export function serializeModel(doc: IBBModel): string {
  return JSON.stringify(doc, null, "\t");
}

/**
 * Parses `.bbmodel` text, converting legacy layouts to 5.0.
 *
 * @throws Error with the failing field paths when the JSON is not a `.bbmodel`.
 */
export function parseModel(text: string): { doc: IBBModel; notes: string[] } {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("A .bbmodel file must contain a JSON object.");
  const { doc, notes } = upgradeToV5(raw as Record<string, unknown>);
  const parsed = bbmodelSchema.safeParse(doc);
  if (parsed.success) return { doc: parsed.data, notes };
  const issues = parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  throw new Error(`Not a valid .bbmodel document:\n${issues.join("\n")}`);
}

/**
 * Takes the cross-process lock for `path`, waiting for other writers.
 *
 * @returns A release function.
 * @throws Error when another process holds the lock past the timeout.
 */
async function acquireFileLock(path: string, deadline = Date.now() + LOCK_TIMEOUT_MS, attempt = 0): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`;
  if (attempt === 0) await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
    await handle.close();
    return () => unlink(lockPath).catch(() => undefined);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const age = await stat(lockPath).then((info) => Date.now() - info.mtimeMs, () => 0);
  if (age > STALE_LOCK_MS) await unlink(lockPath).catch(() => undefined);
  if (age <= STALE_LOCK_MS && Date.now() > deadline) {
    throw new Error(`${path} is locked by another process (${lockPath}). Retry shortly, or delete the lock file if no agent is writing.`);
  }
  await Bun.sleep(Math.min(200, 20 * 2 ** Math.min(attempt, 4)));
  return acquireFileLock(path, deadline, attempt + 1);
}

/** Renames with short retries for transient Windows sharing violations. */
async function renameWithRetry(from: string, to: string, attempt = 0): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (attempt >= 5 || !TRANSIENT_RENAME_ERRORS.has(errorCode(error) ?? "")) throw error;
    await Bun.sleep(50 * (attempt + 1));
    await renameWithRetry(from, to, attempt + 1);
  }
}

/** Reads, locks and writes `.bbmodel` files inside a workspace. */
export class ModelStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(readonly workspace: IWorkspace) {}

  /** Resolves and sandboxes a `.bbmodel` path. */
  resolveModelPath(input: string): string {
    return resolveWorkspacePath(this.workspace, input, [".bbmodel"]);
  }

  /** Resolves and sandboxes any other workspace path. */
  resolvePath(input: string, extensions: readonly string[] = []): string {
    return resolveWorkspacePath(this.workspace, input, extensions);
  }

  /**
   * Reads a model.
   *
   * @throws Error when the file is missing or invalid.
   */
  async read(input: string): Promise<IModelSnapshot> {
    const path = this.resolveModelPath(input);
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`Model file not found: ${path}`);
    const text = await file.text();
    const { doc, notes } = parseModel(text);
    return { path, doc, revision: revisionOf(text), notes };
  }

  /**
   * Runs a read-modify-write cycle under the file's in-process and cross-process locks.
   *
   * @param expectedRevision - When set, the write is refused if the file changed since that revision.
   * @param edit - Returns the new document and a result for the caller. Throwing aborts without writing.
   * @throws RevisionConflictError when `expectedRevision` is stale.
   */
  async update<T>(input: string, expectedRevision: string | undefined, edit: (snapshot: IModelSnapshot) => { doc: IBBModel; result: T }): Promise<IWriteResult<T>> {
    const path = this.resolveModelPath(input);
    return this.withLock(path, async () => {
      const snapshot = await this.read(path);
      if (expectedRevision !== undefined && expectedRevision !== snapshot.revision) {
        throw new RevisionConflictError(path, expectedRevision, snapshot.revision);
      }
      const { doc, result } = edit(snapshot);
      const revision = await this.writeAtomic(path, serializeModel(doc));
      return { path, revision, notes: snapshot.notes, result };
    });
  }

  /**
   * Writes a new model file.
   *
   * @throws Error when the file exists and `overwrite` is false.
   */
  async create(input: string, doc: IBBModel, overwrite: boolean): Promise<{ path: string; revision: string }> {
    const path = this.resolveModelPath(input);
    return this.withLock(path, async () => {
      if (!overwrite && (await Bun.file(path).exists())) throw new Error(`${path} already exists; pass overwrite: true to replace it.`);
      return { path, revision: await this.writeAtomic(path, serializeModel(doc)) };
    });
  }

  /**
   * Writes any text file inside the workspace atomically, under the same locks.
   *
   * @param overwrite - When false, refuses to replace an existing file.
   */
  async writeText(path: string, text: string, overwrite: boolean): Promise<string> {
    return this.withLock(path, async () => {
      if (!overwrite && (await Bun.file(path).exists())) throw new Error(`${path} already exists; pass overwrite: true to replace it.`);
      return this.writeAtomic(path, text);
    });
  }

  private async writeAtomic(path: string, text: string): Promise<string> {
    const temporary = `${path}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    try {
      await Bun.write(temporary, text, { createPath: true });
      await renameWithRetry(temporary, path);
      return revisionOf(text);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async withLock<T>(path: string, task: () => Promise<T>): Promise<T> {
    const key = normalizeCase(path.split(sep).join("/"));
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const release = await acquireFileLock(path);
      try {
        return await task();
      } finally {
        await release();
      }
    });
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}
