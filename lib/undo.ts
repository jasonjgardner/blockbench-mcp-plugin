/// <reference types="blockbench-types" />

/**
 * Cancels the pending Blockbench edit.
 *
 * The desktop runtime's `Undo.cancelEdit(revert)` accepts a revert flag, but the
 * published blockbench-types declare `cancelEdit(): void`. This is the single
 * typed bridge for that signature so tools never repeat ad-hoc casts.
 *
 * @param revert - `true` restores the snapshot captured by `Undo.initEdit`;
 *   `false` discards the pending history entry while keeping current state.
 */
export function cancelUndoEdit(revert: boolean): void {
  (Undo.cancelEdit as (revertChanges: boolean) => void)(revert);
}

/**
 * Runs `edit` inside one Blockbench undo transaction.
 *
 * The entry is finished with `label` when `edit` returns, or canceled and
 * reverted when it throws, so a partial failure never leaves a half-applied
 * scene in history. Aspect arrays may be mutated by `edit` (for example,
 * pushing newly created elements) because Blockbench re-reads them when the
 * edit finishes or is canceled.
 *
 * @param aspects - Undo aspects snapshotted before the edit starts.
 * @param label - History entry label shown in Blockbench's Edit menu.
 * @param edit - Mutation to apply; its return value is passed through.
 * @returns The value returned by `edit`.
 * @throws The original error from `edit` after reverting; an `AggregateError`
 *   carrying both errors when the revert itself also fails.
 */
export function runUndoableEdit<T>(aspects: UndoAspects, label: string, edit: () => T): T {
  Undo.initEdit(aspects);
  try {
    const result = edit();
    Undo.finishEdit(label);
    return result;
  } catch (error) {
    const [revertError] = attemptRevert();
    if (revertError) throw new AggregateError([error, revertError], `"${label}" failed and could not be reverted.`);
    throw error;
  }
}

/** Reverts the pending edit, returning an error tuple instead of masking the caller's original failure. */
function attemptRevert(): [unknown] | [] {
  try {
    cancelUndoEdit(true);
    return [];
  } catch (revertError) {
    return [revertError];
  }
}
