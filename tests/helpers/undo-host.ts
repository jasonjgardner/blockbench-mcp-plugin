/**
 * Headless stand-in for Blockbench's global `Undo` (`UndoSystem` in `js/undo.js`).
 *
 * Tool tests must prove that edits are recorded as one reversible history entry,
 * that failures cancel and revert, and that validation fails before `initEdit`.
 * Every test used to hand-roll a slightly different undo double; this host keeps
 * Blockbench's transaction contract in one place while each test supplies only
 * how to snapshot and restore its own fake model.
 *
 * Mirrored native behavior: `initEdit` captures `current_save`; `finishEdit(message, aspects?)`
 * snapshots the post-edit state (native calls it `post`, exposed here as `after`),
 * truncates any redo tail, and moves `index` to the end; `cancelEdit(revert = false)`
 * reloads the saved state only when `revert` is true; `undo`/`redo` call
 * `restore(target, reference)` like `loadSave(save, reference)`.
 *
 * Strict mode (the default) turns silent native no-ops into errors so tests
 * catch nested transactions, unmatched `finishEdit` calls, and out-of-range undo/redo.
 *
 * @module
 */

/** One committed history entry. */
export interface IUndoEntry<TSnapshot> {
  /** State captured by `initEdit`. */
  readonly before: TSnapshot;
  /** State captured by `finishEdit` (Blockbench's `entry.post`). */
  readonly after: TSnapshot;
  /** Label passed to `finishEdit`, if any. */
  readonly message: string | undefined;
}

/** The open transaction between `initEdit` and `finishEdit`/`cancelEdit`. */
export interface IPendingEdit<TSnapshot, TAspects> {
  readonly aspects: TAspects;
  readonly before: TSnapshot;
}

/**
 * How a test's fake model is captured and reloaded.
 *
 * @typeParam TSnapshot - Immutable copy of the model state, e.g. `readonly string[]` of pixels.
 * @typeParam TAspects - Undo aspects the tool passes to `initEdit`, e.g. `{ elements: TestMesh[] }`;
 *   use `void` for hosts whose `initEdit()` takes no aspects.
 */
export interface IUndoHostOptions<TSnapshot, TAspects> {
  /** Captures the state described by `aspects`. Must copy, not reference, mutable model data. */
  snapshot(aspects: TAspects): TSnapshot;
  /**
   * Reloads `target`. `reference` is the state being replaced, so implementations can
   * remove objects present in `reference` but absent from `target` (created or deleted elements).
   */
  restore(target: TSnapshot, reference: TSnapshot): void;
  /**
   * `true` (default) throws on nested `initEdit`, `finishEdit` without a pending edit,
   * and undo/redo with nothing to apply. `false` mirrors native silent no-ops.
   */
  readonly strict?: boolean;
}

/** Observable undo host installed as the `Undo` global. Call its members as methods (`Undo.initEdit(...)`). */
export interface IUndoHost<TSnapshot, TAspects> {
  /** Open transaction, or `undefined` when none is pending. */
  readonly pending: IPendingEdit<TSnapshot, TAspects> | undefined;
  /** Native alias for the pending `before` snapshot. */
  readonly current_save: TSnapshot | undefined;
  /** Committed entries, oldest first. A new array is produced on every change. */
  readonly history: readonly IUndoEntry<TSnapshot>[];
  /** Number of entries currently applied; `undo` decrements and `redo` increments it. */
  readonly index: number;
  /** Most recently committed entry (`history.at(-1)`), regardless of `index`. */
  readonly lastEdit: IUndoEntry<TSnapshot> | undefined;
  /** Count of `initEdit` calls since creation or `reset`. */
  readonly starts: number;
  /** Count of committed `finishEdit` calls since creation or `reset`. */
  readonly finishes: number;
  /** Count of `cancelEdit` calls that closed a pending edit since creation or `reset`. */
  readonly cancels: number;
  /**
   * Opens a transaction by snapshotting `aspects`.
   * @returns The `before` snapshot (native returns `current_save`).
   * @throws {Error} In strict mode, when a transaction is already pending.
   */
  initEdit(aspects: TAspects): TSnapshot;
  /**
   * Commits the pending transaction.
   * @param message - History label.
   * @param aspects - Post-edit aspects; defaults to the aspects given to `initEdit`.
   * @returns The committed entry, or `undefined` when nothing was pending in non-strict mode.
   * @throws {Error} In strict mode, when no transaction is pending.
   */
  finishEdit(message?: string, aspects?: TAspects): IUndoEntry<TSnapshot> | undefined;
  /**
   * Closes the pending transaction without recording history; a no-op when none is pending.
   * @param revert - `true` restores the `before` snapshot. Defaults to `false`, as in Blockbench.
   */
  cancelEdit(revert?: boolean): void;
  /** Restores `before` of the entry at `index - 1`. @throws {Error} In strict mode, when nothing can be undone. */
  undo(): void;
  /** Restores `after` of the entry at `index`. @throws {Error} In strict mode, when nothing can be redone. */
  redo(): void;
  /** Clears history, the pending edit, and all counters; call from `beforeEach` when reusing one host. */
  reset(): void;
}

interface IUndoState<TSnapshot, TAspects> {
  readonly pending: IPendingEdit<TSnapshot, TAspects> | undefined;
  readonly history: readonly IUndoEntry<TSnapshot>[];
  readonly index: number;
  readonly starts: number;
  readonly finishes: number;
  readonly cancels: number;
}

const EMPTY_STATE = Object.freeze({ cancels: 0, finishes: 0, history: Object.freeze([]), index: 0, pending: undefined, starts: 0 });

class UndoHost<TSnapshot, TAspects> implements IUndoHost<TSnapshot, TAspects> {
  #state: IUndoState<TSnapshot, TAspects> = EMPTY_STATE;
  readonly #options: IUndoHostOptions<TSnapshot, TAspects>;
  readonly #strict: boolean;

  constructor(options: IUndoHostOptions<TSnapshot, TAspects>) {
    this.#options = options;
    this.#strict = options.strict ?? true;
  }

  get pending(): IPendingEdit<TSnapshot, TAspects> | undefined { return this.#state.pending; }
  get current_save(): TSnapshot | undefined { return this.#state.pending?.before; }
  get history(): readonly IUndoEntry<TSnapshot>[] { return this.#state.history; }
  get index(): number { return this.#state.index; }
  get lastEdit(): IUndoEntry<TSnapshot> | undefined { return this.#state.history.at(-1); }
  get starts(): number { return this.#state.starts; }
  get finishes(): number { return this.#state.finishes; }
  get cancels(): number { return this.#state.cancels; }

  initEdit(aspects: TAspects): TSnapshot {
    if (this.#strict && this.#state.pending) {
      throw new Error("Nested undo transaction: finish or cancel the pending edit before starting another.");
    }
    const before = this.#options.snapshot(aspects);
    this.#state = { ...this.#state, pending: { aspects, before }, starts: this.#state.starts + 1 };
    return before;
  }

  finishEdit(message?: string, aspects?: TAspects): IUndoEntry<TSnapshot> | undefined {
    const { pending } = this.#state;
    if (!pending && this.#strict) throw new Error("finishEdit was called without a pending undo transaction.");
    if (!pending) return undefined;
    const entry: IUndoEntry<TSnapshot> = { after: this.#options.snapshot(aspects ?? pending.aspects), before: pending.before, message };
    const history = [...this.#state.history.slice(0, this.#state.index), entry];
    this.#state = { ...this.#state, finishes: this.#state.finishes + 1, history, index: history.length, pending: undefined };
    return entry;
  }

  cancelEdit(revert = false): void {
    const { pending } = this.#state;
    if (!pending) return;
    this.#state = { ...this.#state, cancels: this.#state.cancels + 1, pending: undefined };
    if (!revert) return;
    this.#options.restore(pending.before, this.#options.snapshot(pending.aspects));
  }

  undo(): void {
    const entry = this.#state.index > 0 ? this.#state.history.at(this.#state.index - 1) : undefined;
    if (!entry && this.#strict) throw new Error("Nothing to undo.");
    if (!entry) return;
    this.#state = { ...this.#state, index: this.#state.index - 1 };
    this.#options.restore(entry.before, entry.after);
  }

  redo(): void {
    const entry = this.#state.history.at(this.#state.index);
    if (!entry && this.#strict) throw new Error("Nothing to redo.");
    if (!entry) return;
    this.#state = { ...this.#state, index: this.#state.index + 1 };
    this.#options.restore(entry.after, entry.before);
  }

  reset(): void {
    this.#state = EMPTY_STATE;
  }
}

/**
 * Creates an undo host for one test file's fake model.
 *
 * @example
 * const undo = createUndoHost({
 *   snapshot: (aspects: { elements: TestMesh[] }) => snapshot(aspects.elements),
 *   restore: (target, reference) => loadSnapshot(target, reference),
 * });
 * useGlobals(() => ({ Undo: undo }));
 *
 * @example
 * // Hosts whose initEdit takes no aspects (paint strokes):
 * const undo = createUndoHost<readonly string[]>({ snapshot: () => [...pixels], restore: (target) => { pixels = [...target]; } });
 *
 * @param options - Snapshot/restore callbacks and strictness.
 * @param members - Extra host members merged onto the host, e.g. `{ initSelection() {}, finishSelection() {} }`.
 *   Merge extras here instead of spreading the host: spreading copies getter values once and they go stale.
 * @returns The host, typed with `members`.
 */
export function createUndoHost<TSnapshot, TAspects = void, TMembers extends object = Record<never, never>>(
  options: IUndoHostOptions<TSnapshot, TAspects>,
  members?: TMembers,
): IUndoHost<TSnapshot, TAspects> & TMembers {
  return Object.assign(new UndoHost(options), members);
}
