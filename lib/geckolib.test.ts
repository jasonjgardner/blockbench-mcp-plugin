import { expect, test } from "bun:test";
import {
  GECKOLIB_FORMAT_ID,
  assertGeckolibFormat,
  compileGeckolibAnimationFile,
  compileGeckolibGeometry,
  getGeckolibFilepathCache,
  getGeckolibIdentifier,
  getGeckolibModelType,
  getGeckolibModid,
  getGeckolibPluginVersion,
  getProjectBoneNames,
  isGeckolibFormat,
  isGeckolibPluginInstalled,
} from "./geckolib";
import { useGlobals } from "@/tests/helpers/globals";

useGlobals(() => ({
  Format: { id: GECKOLIB_FORMAT_ID },
  Plugins: { all: [{ id: "geckolib", version: "4.2.1" }], installed: [{ id: "geckolib", version: "4.2.1" }] },
  Project: {
    geckolib_modid: "my_mod",
    geckolib_model_type: "Entity",
    model_identifier: "my_entity",
    geckolib_filepath_cache: { model: "C:/out/my_entity.geo.json" },
  },
  Group: { all: [{ name: "body" }, { name: "head" }] },
  Codecs: { bedrock: { compile: () => ({ "minecraft:geometry": [{ bones: [] }] }) } },
  AnimationCodec: undefined,
  Animator: undefined,
}));

test("detects the loaded plugin from either registry", () => {
  expect(isGeckolibPluginInstalled()).toBe(true);
  expect(getGeckolibPluginVersion()).toBe("4.2.1");

  Object.assign(globalThis, { Plugins: { installed: [{ id: "geckolib", version: "4.2.5" }] } });
  expect(isGeckolibPluginInstalled()).toBe(true);
  expect(getGeckolibPluginVersion()).toBe("4.2.5");
});

test("a disabled, absent, or version-less plugin is reported honestly", () => {
  Object.assign(globalThis, { Plugins: { all: [{ id: "geckolib", version: "4.2.1", disabled: true }] } });
  expect(isGeckolibPluginInstalled()).toBe(false);

  Object.assign(globalThis, { Plugins: { all: [{ id: "hytale_plugin" }], installed: [] } });
  expect(isGeckolibPluginInstalled()).toBe(false);
  expect(getGeckolibPluginVersion()).toBeNull();

  Object.assign(globalThis, { Plugins: { all: [{ id: "geckolib" }] } });
  expect(isGeckolibPluginInstalled()).toBe(true);
  expect(getGeckolibPluginVersion()).toBeNull();
});

test("format detection survives a missing or unrelated format", () => {
  expect(isGeckolibFormat()).toBe(true);
  expect(assertGeckolibFormat()).toBeUndefined();

  Object.assign(globalThis, { Format: { id: "bedrock_block" } });
  expect(isGeckolibFormat()).toBe(false);
  expect(assertGeckolibFormat).toThrow("does not use the GeckoLib Animated Model format");

  Object.assign(globalThis, { Format: {} });
  expect(isGeckolibFormat()).toBe(false);
});

test("a wrong-format project with no plugin points at installing the plugin first", () => {
  Object.assign(globalThis, { Format: { id: "free" }, Plugins: { all: [], installed: [] } });
  expect(assertGeckolibFormat).toThrow("not installed or is disabled");
});

test("reads project metadata and normalizes the stored model type", () => {
  expect(getGeckolibModid()).toBe("my_mod");
  expect(getGeckolibIdentifier()).toBe("my_entity");
  expect(getGeckolibModelType()).toBe("Entity");
  expect(getGeckolibFilepathCache()).toEqual({ model: "C:/out/my_entity.geo.json" });
  expect(getProjectBoneNames()).toEqual(["body", "head"]);

  // The plugin stores the enum value, which has appeared both cased and upper-cased.
  Object.assign(globalThis, { Project: { geckolib_model_type: "ARMOR" } });
  expect(getGeckolibModelType()).toBe("Armor");
});

test("unset, empty, and unknown metadata reads as null rather than a guess", () => {
  Object.assign(globalThis, { Project: { geckolib_modid: "", geckolib_model_type: "Vehicle" } });
  expect(getGeckolibModid()).toBeNull();
  expect(getGeckolibIdentifier()).toBeNull();
  expect(getGeckolibModelType()).toBeNull();
  expect(getGeckolibFilepathCache()).toEqual({});

  Object.assign(globalThis, { Project: undefined, Group: undefined });
  expect(getGeckolibModid()).toBeNull();
  expect(getGeckolibFilepathCache()).toEqual({});
  expect(getProjectBoneNames()).toEqual([]);
});

test("geometry compiles through the bedrock codec in raw mode", () => {
  let received: unknown;
  Object.assign(globalThis, {
    Codecs: {
      bedrock: {
        compile: (options: unknown) => {
          received = options;
          return { "minecraft:geometry": [{ bones: [{ name: "body" }] }] };
        },
      },
    },
  });
  expect(compileGeckolibGeometry()).toEqual({ "minecraft:geometry": [{ bones: [{ name: "body" }] }] });
  expect(received).toEqual({ raw: true });
});

test("a stringified geometry export is parsed, and unparsable output throws", () => {
  Object.assign(globalThis, { Codecs: { bedrock: { compile: () => '{"format_version":"1.12.0"}' } } });
  expect(compileGeckolibGeometry()).toEqual({ format_version: "1.12.0" });

  Object.assign(globalThis, { Codecs: { bedrock: { compile: () => "not json" } } });
  expect(compileGeckolibGeometry).toThrow("not valid JSON");

  Object.assign(globalThis, { Codecs: {} });
  expect(compileGeckolibGeometry).toThrow("bedrock codec is unavailable");
});

test("animations compile through Animator.buildFile, where the plugin's export patch lives", () => {
  const calls: unknown[][] = [];
  Object.assign(globalThis, {
    // On 5.1+ this is a deprecated shim over the codec, but it is the function
    // the GeckoLib plugin patches, so it must win over calling the codec directly.
    Animator: {
      buildFile: (...args: unknown[]) => {
        calls.push(args);
        return { animations: {}, geckolib_format_version: 2 };
      },
    },
    AnimationCodec: {
      getCodec: () => ({
        compileFile: () => {
          throw new Error("The codec must not be preferred over the patched buildFile.");
        },
      }),
    },
  });
  expect(compileGeckolibAnimationFile([{ name: "walk" }] as never[])).toEqual({
    content: { animations: {}, geckolib_format_version: 2 },
    via: "animator_build_file",
  });
  // The plugin's patch indexes into the name filter, so it is never omitted.
  expect(calls).toEqual([[null, ["walk"]]]);
});

test("hosts without the buildFile shim fall back to the animation codec", () => {
  const animations = [{ name: "animation.model.idle" }] as never[];
  let received: unknown;
  Object.assign(globalThis, {
    Animator: {},
    AnimationCodec: {
      getCodec: () => ({
        compileFile: (input: unknown) => {
          received = input;
          return { animations: { "animation.model.idle": {} } };
        },
      }),
    },
  });
  expect(compileGeckolibAnimationFile(animations)).toEqual({
    content: { animations: { "animation.model.idle": {} } },
    via: "animation_codec",
  });
  expect(received).toEqual(animations);
});

test("every project animation is compiled when none are named", () => {
  const all = [{ name: "idle" }, { name: "walk" }];
  const calls: unknown[][] = [];
  Object.assign(globalThis, {
    Animation: { all },
    Animator: {
      buildFile: (...args: unknown[]) => {
        calls.push(args);
        return {};
      },
    },
  });
  compileGeckolibAnimationFile();
  expect(calls).toEqual([[null, ["idle", "walk"]]]);
});

test("a host with no animation compiler fails instead of returning empty content", () => {
  Object.assign(globalThis, { AnimationCodec: undefined, Animator: {} });
  expect(() => compileGeckolibAnimationFile([] as never[])).toThrow("no animation file compiler");
});
