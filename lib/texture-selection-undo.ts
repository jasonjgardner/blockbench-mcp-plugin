/// <reference types="blockbench-types" />

/** Blockbench 5.2 IntMatrix fields omitted from the published texture types. */
interface ISelectionMatrix {
  width: number;
  height: number;
  is_custom: boolean;
  override: boolean | null;
  array?: Int8Array;
  setOverride(value: boolean | null): void;
}

interface ISelectionUndo extends UndoSystem {
  current_selection_save?: UndoSelectionSave;
}

/**
 * Runs a texture-mask change as one selection entry, independent of the UV editor.
 * Mirrors UndoSystem.initSelection/finishSelection in Blockbench's js/undo.js:
 * selection undo is opt-in, local-only, and does not mark bitmap content changed.
 */
export function runUndoableTextureSelection<T>(texture: Texture, label: string, edit: () => T): T {
  const settings = Reflect.get(globalThis, "settings") as {
    undo_selections: { value: boolean };
    undo_limit: { value: number };
  };
  const undo = Undo as ISelectionUndo;
  if (!settings.undo_selections.value || Blockbench.hasFlag("loading_selection_save") ||
      Project.EditSession || undo.current_selection_save) return edit();
  // Selection events are incorrectly typed with UndoAspects in blockbench-types.
  const aspects: UndoSelectionAspects & UndoAspects = { texture_selection: true };

  // Define lazily: tool schemas also load outside the Blockbench runtime.
  const SelectionSave = (UndoSystem as unknown as {
    selectionSave: new (aspects: UndoSelectionAspects) => UndoSelectionSave;
  }).selectionSave;
  class TextureSelectionSave extends SelectionSave {
    readonly texture_uuid: string;
    readonly state: Int8Array | boolean | null;

    constructor(target: Texture) {
      super({});
      this.aspects = aspects;
      this.texture_uuid = target.uuid;
      const selection = target.selection as unknown as ISelectionMatrix;
      this.state = selection.is_custom && selection.array
        ? new Int8Array(selection.array) : selection.override;
    }

    load(): void {
      const target = Texture.all.find(candidate => candidate.uuid === this.texture_uuid);
      if (!target) return;
      const selection = target.selection as unknown as ISelectionMatrix;
      if (this.state instanceof Int8Array) {
        if (selection.width * selection.height !== this.state.length) return;
        selection.override = null;
        if (selection.array?.length === this.state.length) selection.array.set(this.state);
        else selection.array = new Int8Array(this.state);
      } else {
        selection.setOverride(this.state);
      }
      const editor = Reflect.get(globalThis, "UVEditor") as {
        texture?: Texture;
        updateSelectionOutline(): void;
      } | undefined;
      if (editor?.texture === target) editor.updateSelectionOutline();
    }

    matches(other: UndoSelectionSave): boolean {
      if (!(other instanceof TextureSelectionSave) || other.texture_uuid !== this.texture_uuid) return false;
      if (!(this.state instanceof Int8Array)) return this.state === other.state;
      const state = other.state;
      return state instanceof Int8Array && this.state.length === state.length &&
        this.state.every((value, index) => value === state[index]);
    }
  }

  const selection_before = new TextureSelectionSave(texture);
  undo.current_selection_save = selection_before;
  let result: T;
  let selection_post: TextureSelectionSave;
  try {
    Blockbench.dispatchEvent("init_selection_change", { aspects, save: selection_before });
    result = edit();
    selection_post = new TextureSelectionSave(texture);
    if (selection_before.matches(selection_post)) {
      undo.cancelSelection();
      return result;
    }
    Blockbench.dispatchEvent("finish_selection_change", { aspects });
  } catch (error) {
    try {
      undo.cancelSelection(true);
    } catch (revertError) {
      throw new AggregateError([error, revertError], `"${label}" failed and could not be reverted.`);
    }
    throw error;
  }
  if (undo.history.length > undo.index) undo.history.length = undo.index;
  delete undo.current_selection_save;
  undo.history.push({ selection_before, selection_post, action: label, type: "selection", time: Date.now() });
  if (undo.history.length > settings.undo_limit.value) undo.history.shift();
  undo.index = undo.history.length;
  Blockbench.dispatchEvent("finished_selection_change", { aspects });
  return result;
}
