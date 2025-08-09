const settings: Setting[] = [];

export function settingsSetup() {
  const category = "general";

  settings.push(
    new Setting("mcp_instructions", {
      name: "MCP System Instructions",
      // https://github.com/punkpeye/fastmcp?tab=readme-ov-file#providing-instructions
      description: "Instructions for the MCP system.",
      type: "text",
      value:
        "Generate simple, low-poly models for Minecraft inside Blockbench.",
      category,
      icon: "psychology",
    }),
    new Setting("mcp_port", {
      name: "MCP Server Port",
      description: "Port for the MCP server.",
      type: "number",
      value: 3000,
      category,
      icon: "numbers",
    }),
    new Setting("mcp_endpoint", {
      name: "MCP Server Endpoint",
      description: "Endpoint for the MCP server.",
      type: "text",
      value: "/bb-mcp",
      category,
      icon: "webhook",
    })
  );
}

export function settingsTeardown() {
  settings.forEach((setting) => {
    setting.delete();
  });
}
