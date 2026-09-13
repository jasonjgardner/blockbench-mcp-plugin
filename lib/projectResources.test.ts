import { beforeEach, describe, expect, mock, test } from "bun:test";
import { getProjectFileResource, getProjectFileUri, listProjectFiles, readProjectFile } from "./projectResources";
import { withResourceErrors } from "./resourceErrors";
import { useGlobals } from "@/tests/helpers/globals";

const project = { uuid: "bf593817-1396-43a5-9cd9-f540aa0c84e7", name: "Unsaved Character", saved: false };
const otherProject = { uuid: "38dcff8a-0427-4f26-959d-4424a0e87e07", name: "Other project" };
let activeProject: typeof project | undefined;
let compiledModel: unknown;
const compile = mock((_options: unknown): unknown => compiledModel);
const select = mock(() => { throw new Error("Resource reads must not select projects."); });
const write = mock(() => { throw new Error("Resource reads must not write files."); });
const flags = new Set<string>();

beforeEach(() => {
  activeProject = project;
  compiledModel = {
    meta: { format_version: "5.0", model_format: "free" },
    elements: [{ name: "Unsaved cube" }],
    textures: [{ source: "data:image/png;base64,dGV4dHVyZQ==" }],
    plugin_specific_data: { preserved: true },
  };
  compile.mockClear();
  select.mockClear();
  write.mockClear();
  flags.clear();
});
useGlobals(() => ({
  Project: activeProject,
  ModelProject: { all: [{ ...project, select }, { ...otherProject, select }] },
  Codecs: { project: { compile, write } },
  Blockbench: { hasFlag: (flag: string) => flags.has(flag), removeFlag: (flag: string) => flags.delete(flag) },
}));

describe("live project file resources", () => {
  test("lists only the current project without compiling or selecting tabs", () => {
    expect(listProjectFiles()).toEqual({ resources: [getProjectFileResource(project)] });
    expect(compile).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  test("keeps URIs stable across renames and provides usable bbmodel filenames", () => {
    const renamed = { ...project, name: "Renamed" };
    expect(getProjectFileUri(renamed)).toBe(getProjectFileUri(project));
    expect(getProjectFileResource({ ...project, name: "already.bbmodel" }).name).toBe("already.bbmodel");
    expect(getProjectFileResource({ ...project, name: "folder/model" }).name).toBe("folder_model.bbmodel");
  });

  test("reads native codec JSON including unsaved data, textures and plugin fields", () => {
    const uri = new URL(getProjectFileUri(project));
    const result = readProjectFile(uri);
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]).toEqual({ uri: uri.href, mimeType: "application/json", text: JSON.stringify(compiledModel) });
    expect(compile).toHaveBeenCalledWith({ raw: true, bitmaps: true, absolute_paths: false });
    expect(select).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(Object.is(Project, project)).toBe(true);
    expect(project.saved).toBe(false);
  });

  test.each([
    getProjectFileUri(otherProject),
    "blockbench://project/../../private.bbmodel",
    `${getProjectFileUri(project)}?path=C:/private.bbmodel`,
  ])("rejects unavailable or unrelated URIs without compiling: %s", async (value) => {
    await expect(withResourceErrors(() => readProjectFile(new URL(value)))).rejects.toMatchObject({ code: -32602 });
    expect(compile).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  test("does not list files with no active project and rejects a stale file URI", async () => {
    Reflect.set(globalThis, "Project", undefined);
    expect(listProjectFiles()).toEqual({ resources: [] });
    await expect(withResourceErrors(() => readProjectFile(new URL(getProjectFileUri(project))))).rejects.toMatchObject({ code: -32602 });
  });

  test("reports invalid native codec output as a protocol internal error", async () => {
    compiledModel = undefined;
    const uri = new URL(getProjectFileUri(project));
    await expect(withResourceErrors(() => readProjectFile(uri), uri)).rejects.toMatchObject({ code: -32603, data: { uri: uri.href } });
  });

  test("reports native serialization failures as internal errors", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    compiledModel = cyclic;
    await expect(withResourceErrors(() => readProjectFile(new URL(getProjectFileUri(project))))).rejects.toMatchObject({ code: -32603 });
  });

  test("clears the native compilation flag when compilation throws", async () => {
    compile.mockImplementationOnce(() => {
      flags.add("compiling_bbmodel");
      throw new Error("Plugin compile listener failed.");
    });
    await expect(withResourceErrors(() => readProjectFile(new URL(getProjectFileUri(project))))).rejects.toMatchObject({ code: -32603 });
    expect(flags.has("compiling_bbmodel")).toBe(false);
  });

  test("does not interrupt an existing native compilation", async () => {
    flags.add("compiling_bbmodel");
    await expect(withResourceErrors(() => readProjectFile(new URL(getProjectFileUri(project))))).rejects.toMatchObject({ code: -32603 });
    expect(flags.has("compiling_bbmodel")).toBe(true);
    expect(compile).not.toHaveBeenCalled();
  });
});
