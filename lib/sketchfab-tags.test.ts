import { afterEach, describe, expect, test } from "bun:test";
import { setupSketchfabTags, teardownSketchfabTags } from "@/lib/sketchfab-tags";
import { useGlobals } from "@/tests/helpers/globals";

class HostDialog {
  rendered: string[] = [];
  selected = "";
  form_config?: { tag_suggestions: { buttons: string[]; click(index: number): void } };
  form?: HostDialog["form_config"];

  constructor(readonly id: string, tags: string[], legacy = false) {
    const config = { tag_suggestions: {
      buttons: tags,
      click: (index: number) => { this.selected = tags[index]!; },
    } };
    if (legacy) {
      this.form = config;
      return;
    }
    this.form_config = config;
  }

  build(): this {
    this.rendered = [...(this.form_config ?? this.form)!.tag_suggestions.buttons];
    return this;
  }
}

const project: { ai_used?: boolean } = {};
const originalBuild = HostDialog.prototype.build;
afterEach(teardownSketchfabTags);
useGlobals(() => {
  delete project.ai_used;
  return { Dialog: HostDialog, Project: project };
});

describe("Sketchfab AI tag suggestions", () => {
  test("replaces NoAI in the displayed buttons and the captured click array", () => {
    project.ai_used = true;
    setupSketchfabTags();
    const dialog = new HostDialog("sketchfab_uploader", ["low-poly", "pixel-art", "NoAI", "voxel"]);
    expect(dialog.build()).toBe(dialog);
    expect(dialog.rendered).toEqual(["low-poly", "pixel-art", "CreatedWithAI", "voxel"]);
    dialog.form_config!.tag_suggestions.click(2);
    expect(dialog.selected).toBe("CreatedWithAI");
  });

  test.each([false, undefined])("leaves suggestions unchanged with ai_used=%s", aiUsed => {
    project.ai_used = aiUsed;
    setupSketchfabTags();
    const tags = ["low-poly", "NoAI"];
    expect(new HostDialog("sketchfab_uploader", tags).build().rendered).toEqual(tags);
  });

  test("supports legacy forms and removes case variants without duplicating CreatedWithAI", () => {
    project.ai_used = true;
    setupSketchfabTags();
    const dialog = new HostDialog("sketchfab_uploader", ["noai", "NoAI", "CreatedWithAI", "skin"], true);
    expect(dialog.build().rendered).toEqual(["CreatedWithAI", "skin"]);
    dialog.form!.tag_suggestions.click(0);
    expect(dialog.selected).toBe("CreatedWithAI");
  });

  test("adds CreatedWithAI if the host has no NoAI suggestion", () => {
    project.ai_used = true;
    setupSketchfabTags();
    expect(new HostDialog("sketchfab_uploader", ["voxel"]).build().rendered).toEqual(["voxel", "CreatedWithAI"]);
  });

  test("leaves unrelated dialogs unchanged and restores the builder on unload", () => {
    project.ai_used = true;
    setupSketchfabTags();
    const patched = HostDialog.prototype.build;
    setupSketchfabTags();
    expect(HostDialog.prototype.build).toBe(patched);
    expect(new HostDialog("other", ["NoAI"]).build().rendered).toEqual(["NoAI"]);
    teardownSketchfabTags();
    expect(HostDialog.prototype.build).toBe(originalBuild);
    expect(new HostDialog("sketchfab_uploader", ["NoAI"]).build().rendered).toEqual(["NoAI"]);
  });
});
