import { SETTING_DISCLOSE_AI_USAGE, SETTING_SCRATCHPAD_ENABLED } from "@/lib/constants";
import { onScratchpadSettingChanged } from "@/lib/scratchpad-mode";

const settings: Setting[] = [];

export function settingsSetup() {
  const category = "general";

  // Objects kept by an earlier `keepValues` teardown are superseded by the ones created below.
  // Forget them: `Setting.delete()` works by id, so deleting a stale one later would remove the new one.
  settings.length = 0;

  settings.push(
    new Setting("mcp_instructions", {
      name: tl("mcp.settings.instructions_name"),
      // https://github.com/punkpeye/fastmcp?tab=readme-ov-file#providing-instructions
      description: tl("mcp.settings.instructions_desc"),
      type: "text",
      value:
        "Generate simple, low-poly models for Minecraft inside Blockbench.",
      category,
      icon: "psychology",
    }),
    new Setting("mcp_port", {
      name: tl("mcp.settings.port_name"),
      description: tl("mcp.settings.port_desc"),
      type: "number",
      value: 3000,
      category,
      icon: "numbers",
    }),
    new Setting("mcp_endpoint", {
      name: tl("mcp.settings.endpoint_name"),
      description: tl("mcp.settings.endpoint_desc"),
      type: "text",
      value: "/bb-mcp",
      category,
      icon: "webhook",
    }),
    new Setting("mcp_prompt_cdn_enabled", {
      name: tl("mcp.settings.prompt_cdn_name"),
      description: tl("mcp.settings.prompt_cdn_desc"),
      type: "toggle",
      value: true,
      category,
      icon: "cloud_download",
    }),
    new Setting("mcp_session_timeout", {
      name: tl("mcp.settings.session_timeout_name"),
      description: tl("mcp.settings.session_timeout_desc"),
      type: "number",
      value: 30,
      min: 1,
      max: 1440,
      category,
      icon: "timer",
    }),
    new Setting("mcp_sse_heartbeat", {
      name: tl("mcp.settings.sse_heartbeat_name"),
      description: tl("mcp.settings.sse_heartbeat_desc"),
      type: "number",
      value: 15,
      min: 0,
      max: 600,
      category,
      icon: "favorite",
    }),
    new Setting(SETTING_SCRATCHPAD_ENABLED, {
      name: tl("mcp.settings.scratchpad_name"),
      description: tl("mcp.settings.scratchpad_desc"),
      type: "toggle",
      value: false,
      category,
      icon: "science",
      onChange: onScratchpadSettingChanged,
    }),
    new Setting(SETTING_DISCLOSE_AI_USAGE, {
      name: tl("mcp.settings.disclose_ai_name"),
      description: tl("mcp.settings.disclose_ai_desc"),
      type: "toggle",
      value: true,
      category,
      icon: "verified_user",
    })
  );
}

/** Options for {@link settingsTeardown}. */
export interface ISettingsTeardownOptions {
  /** Keep the stored values so a reload (`onunload` + `onload`) does not reset them to defaults. */
  keepValues?: boolean;
}

/**
 * Remove the plugin's settings from the Settings dialog.
 *
 * Blockbench saves settings by iterating the live `Setting` objects, so `delete()` on unload drops
 * every user-changed value (e.g. `mcp_port`) and defaults come back on the next launch. URL-installed
 * plugins are unloaded and reloaded on every start, so this hit everyone who changed the port. With
 * `keepValues` the current values are written to `Settings.stored`, which the `Setting` objects that
 * `settingsSetup()` re-creates read from, and the old objects stay registered so the next save still
 * includes them. Uninstalling deletes them for real.
 *
 * Blockbench runs `onunload` and then `onuninstall` on the same instance when uninstalling, so a
 * `keepValues` teardown must leave the objects tracked for the plain teardown that follows. A reload
 * does not accumulate stale objects because `settingsSetup()` forgets them before creating new ones.
 */
export function settingsTeardown(options: ISettingsTeardownOptions = {}) {
  // blockbench-types declares `stored` as Setting records, but at runtime it is `{ value }` per id.
  const stored = Settings.stored as Record<string, { value: unknown }>;

  settings.forEach((setting) => {
    if (options.keepValues) {
      stored[setting.id] = { value: setting.master_value };
      return;
    }
    setting.delete();
    delete stored[setting.id];
  });

  if (!options.keepValues) {
    settings.length = 0;
  }
}
