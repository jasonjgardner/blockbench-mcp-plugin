import { beforeEach, describe, expect, test } from "bun:test";
import { useGlobals } from "@/tests/helpers/globals";
import { settingsSetup, settingsTeardown } from "@/ui/settings";

/** Minimal double for Blockbench's `Setting`; records deletion instead of touching a dialog. */
class TestSetting {
  static all = new Map<string, TestSetting>();
  master_value: unknown;
  deleted = false;

  constructor(readonly id: string, data: { value: unknown }) {
    this.master_value = data.value;
    TestSetting.all.set(id, this);
  }

  delete(): void {
    this.deleted = true;
    TestSetting.all.delete(this.id);
  }
}

let stored: Record<string, { value: unknown }>;

beforeEach(() => {
  stored = {};
  TestSetting.all.clear();
});

useGlobals(() => ({
  Setting: TestSetting,
  Settings: { stored },
  tl: (key: string) => key,
}));

function portSetting(): TestSetting {
  const setting = TestSetting.all.get("mcp_port");
  if (!setting) throw new Error("mcp_port setting was not registered");
  return setting;
}

describe("settingsTeardown", () => {
  test("with keepValues writes the current values to Settings.stored and keeps the settings registered", () => {
    settingsSetup();
    const registered = [...TestSetting.all.values()];
    portSetting().master_value = 3010;

    settingsTeardown({ keepValues: true });

    expect(stored.mcp_port).toEqual({ value: 3010 });
    expect(stored.mcp_endpoint).toEqual({ value: "/bb-mcp" });
    expect(Object.keys(stored).sort()).toEqual(registered.map((setting) => setting.id).sort());
    expect(registered.every((setting) => !setting.deleted)).toBe(true);
    expect(TestSetting.all.size).toBe(registered.length);
  });

  test("without keepValues deletes every setting and stores nothing", () => {
    settingsSetup();
    const registered = [...TestSetting.all.values()];
    portSetting().master_value = 3010;

    settingsTeardown();

    expect(registered.every((setting) => setting.deleted)).toBe(true);
    expect(TestSetting.all.size).toBe(0);
    expect(stored).toEqual({});
  });

  test("forgets torn-down settings so a later teardown does not touch them again", () => {
    settingsSetup();
    const registered = [...TestSetting.all.values()];
    settingsTeardown({ keepValues: true });
    stored = {};
    Object.assign(Settings, { stored });

    settingsTeardown();

    expect(stored).toEqual({});
    expect(registered.every((setting) => !setting.deleted)).toBe(true);
  });
});
