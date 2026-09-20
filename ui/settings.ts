import { SETTING_DISCLOSE_AI_USAGE, SETTING_SCRATCHPAD_ENABLED } from "@/lib/constants";
import { onScratchpadSettingChanged } from "@/lib/scratchpad-mode";

const settings: Setting[] = [];

export function settingsSetup() {
  const category = "general";

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

export function settingsTeardown() {
  settings.forEach((setting) => {
    setting.delete();
  });
}
