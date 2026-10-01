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
 *   chain does the same without touching the disk. A lock older than 30 s is
 *   taken over as abandoned, so the lock file holds an owner token: right before
 *   renaming, a writer checks that it still owns its lock, refreshes it, and
 *   checks that the file is unchanged since its read. A writer whose lock was
 *   taken over (an edit that blocked for longer) then writes nothing, instead of
 *   overwriting the new owner's work. The takeover itself is not atomic, so this
 *   narrows the window for a lost write rather than closing it.
 * - Every read returns a `revision` (a hash of the file bytes). Write tools accept
 *   `expected_revision` and refuse to write when the file changed since the
 *   caller read it, so an agent never overwrites work it has not seen.
 * - Writes go to a temporary file first and are renamed into place, so a crash or
 *   a concurrent reader never sees a half-written model.
 *
 * The sandbox compares real paths (symlinks and junctions resolved), so a link
 * inside a root cannot lead outside it. A link whose target is missing has no
 * real path and is refused.
 *
 * @module
 */

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, utimes } from "node:fs/promises";
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

/** Thrown when another process took over a writer's lock while it worked, so nothing was written. */
export class LockLostError extends Error {
  constructor(path: string, staleMs: number) {
    super(`${path} was not written: its lock was held for over ${staleMs / 1000} s, so another process took it over and may have changed the file. Read it again and retry, with a smaller batch if the edit is slow.`);
    this.name = "LockLostError";
  }
}

/** Cross-process lock timing. */
export interface ILockTiming {
  /** Age after which a lock file is treated as abandoned by a crashed process and taken over. */
  staleMs: number;
  /** How long a writer waits for another process's lock. */
  timeoutMs: number;
}

const DEFAULT_LOCK_TIMING: ILockTiming = { staleMs: 30_000, timeoutMs: 15_000 };
/** Errors raised while a scanner, a sync tool or another program briefly holds a file (mostly on Windows), or while file handles run out. */
const TRANSIENT_FILE_ERRORS = new Set(["EPERM", "EBUSY", "EACCES", "EMFILE", "ENFILE"]);

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;

/** Runs a file operation, retrying it a few times while the error looks transient. */
async function retryTransient<T>(operation: () => Promise<T>, attempt = 0): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (attempt >= 5 || !TRANSIENT_FILE_ERRORS.has(errorCode(error) ?? "")) throw error;
    await Bun.sleep(50 * (attempt + 1));
    return retryTransient(operation, attempt + 1);
  }
}

const normalizeCase = (path: string): string => (process.platform === "win32" ? path.toLowerCase() : path);

const isInside = (root: string, target: string): boolean => {
  const rel = relative(normalizeCase(root), normalizeCase(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Whether `path` itself is a symbolic link or junction, without following it. */
const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Real path of `target`, resolving links in its nearest existing ancestor.
 *
 * @throws Error when `target` or an ancestor is a link whose target does not exist: it has no real
 *   path to check, and a write through it would create that target wherever the link points.
 */
function realPathOf(target: string): string {
  if (existsSync(target)) return realpathSync.native(target);
  if (isLink(target)) throw new Error(`Path ${target} is a symbolic link to a missing target; use the real file.`);
  const parent = dirname(target);
  if (parent === target) return target;
  return join(realPathOf(parent), basename(target));
}

/** Real path of a root, or undefined for a link to a missing folder: that root then matches nothing, and the others keep working. */
function realRootOf(root: string): string | undefined {
  try {
    return realPathOf(root);
  } catch {
    return undefined;
  }
}

/**
 * Resolves a user-supplied path against the workspace and refuses anything outside it.
 *
 * @param input - Absolute path, or a path relative to the first root.
 * @param extensions - Allowed lowercase extensions such as `[".bbmodel"]`; empty allows any.
 * @throws Error for paths outside every root (after resolving symlinks), symlinked files, links to missing targets, or a disallowed extension.
 */
export function resolveWorkspacePath(workspace: IWorkspace, input: string, extensions: readonly string[] = []): string {
  const [firstRoot] = workspace.roots;
  if (!firstRoot) throw new Error("The headless server has no workspace root configured.");
  const absolute = resolve(firstRoot, input);
  const roots = workspace.roots.map((root) => resolve(root));
  const realRoots = roots.flatMap((root) => realRootOf(root) ?? []);
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

/** A cross-process lock this process took. */
interface IFileLock {
  /**
   * Checks that this process still owns the lock, then refreshes it so it cannot go stale before the write lands.
   *
   * @throws LockLostError when another process took the lock over.
   */
  confirm(): Promise<void>;
  /** Deletes the lock file, unless another process owns it by now. */
  release(): Promise<void>;
}

/**
 * Reads the owner token of a lock file, or undefined when the file is gone.
 *
 * @param read - Reads the file; tests replace it.
 * @throws The read error when it persists through short retries (a file another program holds).
 */
export async function readLockToken(lockPath: string, read: (path: string) => Promise<string> = (path) => readFile(path, "utf8")): Promise<string | undefined> {
  try {
    return await retryTransient(() => read(lockPath));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Takes the cross-process lock for `path`, waiting for other writers.
 *
 * @throws Error when another process holds the lock past the timeout.
 */
async function acquireFileLock(path: string, timing: ILockTiming, deadline = Date.now() + timing.timeoutMs, attempt = 0): Promise<IFileLock> {
  const lockPath = `${path}.lock`;
  if (attempt === 0) await mkdir(dirname(path), { recursive: true });
  // The token tells this owner apart from a process that takes the lock over once it looks stale.
  const token = `${process.pid} ${crypto.randomUUID()} ${new Date().toISOString()}\n`;
  try {
    const handle = await retryTransient(() => open(lockPath, "wx"));
    await handle.writeFile(token);
    await handle.close();
    return {
      async confirm() {
        // Checked before refreshing, so a lock another process took over is never kept alive by this one.
        if ((await readLockToken(lockPath)) !== token) throw new LockLostError(path, timing.staleMs);
        const now = new Date();
        await utimes(lockPath, now, now).catch(() => undefined);
      },
      async release() {
        // A lock file that cannot be read is almost surely still this one; deleting it beats blocking others until it goes stale.
        const owner = await readLockToken(lockPath).catch(() => token);
        if (owner === token) await retryTransient(() => unlink(lockPath)).catch(() => undefined);
      },
    };
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const age = await stat(lockPath).then((info) => Date.now() - info.mtimeMs, () => 0);
  // Taking over a stale lock is not atomic: two waiters can both see it stale, and the later one then
  // deletes the lock the first just took. The owner token and the checks before renaming (confirm, and
  // update's revision check) make the losing writer fail instead of overwriting, which narrows that
  // window without closing it.
  if (age > timing.staleMs) await unlink(lockPath).catch(() => undefined);
  if (age <= timing.staleMs && Date.now() > deadline) {
    throw new Error(`${path} is locked by another process (${lockPath}). Retry shortly, or delete the lock file if no agent is writing.`);
  }
  await Bun.sleep(Math.min(200, 20 * 2 ** Math.min(attempt, 4)));
  return acquireFileLock(path, timing, deadline, attempt + 1);
}

/** Renames with short retries for transient Windows sharing violations. */
const renameWithRetry = (from: string, to: string): Promise<void> => retryTransient(() => rename(from, to));

/** Reads, locks and writes `.bbmodel` files inside a workspace. */
export class ModelStore {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly lockTiming: ILockTiming;

  /** @param lockTiming - Overrides the 30 s stale age and 15 s wait of the cross-process lock. */
  constructor(readonly workspace: IWorkspace, lockTiming: Partial<ILockTiming> = {}) {
    this.lockTiming = { ...DEFAULT_LOCK_TIMING, ...lockTiming };
  }

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
   * @throws RevisionConflictError when `expectedRevision` is stale, or the file changed while the edit ran.
   * @throws LockLostError when the edit outlived the lock, which another process took over.
   */
  async update<T>(input: string, expectedRevision: string | undefined, edit: (snapshot: IModelSnapshot) => { doc: IBBModel; result: T }): Promise<IWriteResult<T>> {
    const path = this.resolveModelPath(input);
    return this.withLock(path, async (lock) => {
      const snapshot = await this.read(path);
      if (expectedRevision !== undefined && expectedRevision !== snapshot.revision) {
        throw new RevisionConflictError(path, expectedRevision, snapshot.revision);
      }
      const { doc, result } = edit(snapshot);
      const revision = await this.writeAtomic(path, serializeModel(doc), lock, snapshot.revision);
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
    return this.withLock(path, async (lock) => {
      if (!overwrite && (await Bun.file(path).exists())) throw new Error(`${path} already exists; pass overwrite: true to replace it.`);
      return { path, revision: await this.writeAtomic(path, serializeModel(doc), lock) };
    });
  }

  /**
   * Writes any text file inside the workspace atomically, under the same locks.
   *
   * @param overwrite - When false, refuses to replace an existing file.
   */
  async writeText(path: string, text: string, overwrite: boolean): Promise<string> {
    return this.withLock(path, async (lock) => {
      if (!overwrite && (await Bun.file(path).exists())) throw new Error(`${path} already exists; pass overwrite: true to replace it.`);
      return this.writeAtomic(path, text, lock);
    });
  }

  /**
   * Writes through a temporary file renamed into place, after confirming the lock.
   *
   * @param expectedRevision - Revision the file must still have, for read-modify-write cycles.
   */
  private async writeAtomic(path: string, text: string, lock: IFileLock, expectedRevision?: string): Promise<string> {
    const temporary = `${path}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    try {
      await Bun.write(temporary, text, { createPath: true });
      await lock.confirm();
      if (expectedRevision !== undefined) {
        const current = revisionOf(await Bun.file(path).text());
        if (current !== expectedRevision) throw new RevisionConflictError(path, expectedRevision, current);
      }
      await renameWithRetry(temporary, path);
      return revisionOf(text);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async withLock<T>(path: string, task: (lock: IFileLock) => Promise<T>): Promise<T> {
    const key = normalizeCase(path.split(sep).join("/"));
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const lock = await acquireFileLock(path, this.lockTiming);
      try {
        return await task(lock);
      } finally {
        await lock.release();
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
