/**
 * Internationalization (i18n) support for the MCP plugin.
 *
 * Uses Blockbench's built-in translation system:
 * - Language.addTranslations(langCode, { key: value }) to register translations
 * - tl('key') or tl('key', variables) to get translated strings
 *
 * Translation keys follow the pattern: mcp.<section>.<item>
 */

// English translations (fallback)
const en: Record<string, string> = {
  // Panel sections
  "mcp.panel.sessions": "Sessions",
  "mcp.panel.server": "Server",
  "mcp.panel.tools": "Tools",
  "mcp.panel.resources": "Resources",
  "mcp.panel.prompts": "Prompts",

  // Sessions section
  "mcp.sessions.no_clients": "No clients connected",

  // Server section
  "mcp.server.name": "Server Name",
  "mcp.server.version": "Server Version",
  "mcp.server.connected_clients": "Connected Clients",

  // Filter UI
  "mcp.filter.tools_placeholder": "Filter tools...",
  "mcp.filter.resources_placeholder": "Filter resources...",
  "mcp.filter.prompts_placeholder": "Filter prompts...",
  "mcp.filter.show_experimental": "Show Experimental",

  // Empty states
  "mcp.tools.no_match": "No tools match your filter.",
  "mcp.tools.none_available": "No tools available.",
  "mcp.resources.no_match": "No resources match your filter.",
  "mcp.resources.none_available": "No resources available.",
  "mcp.prompts.no_match": "No prompts match your filter.",
  "mcp.prompts.none_available": "No prompts available.",

  // Prompts
  "mcp.prompts.argument_count": "%0 argument",
  "mcp.prompts.argument_count_plural": "%0 arguments",

  // Tooltips
  "mcp.tooltip.click_to_test": "Click to test %0",
  "mcp.tooltip.click_to_preview": "Click to preview %0",
  "mcp.tooltip.click_to_view_panel": "Click to view MCP panel",

  // Status bar
  "mcp.status.experimental_tooltip": "This tool is experimental",
  "mcp.status.server": "MCP Server",
  "mcp.status.server_one_client": "MCP Server (1 client)",
  "mcp.status.server_clients": "MCP Server (%0 clients)",

  // Settings
  "mcp.settings.instructions_name": "MCP System Instructions",
  "mcp.settings.instructions_desc": "Instructions for the MCP system.",
  "mcp.settings.port_name": "MCP Server Port",
  "mcp.settings.port_desc": "Port for the MCP server.",
  "mcp.settings.endpoint_name": "MCP Server Endpoint",
  "mcp.settings.endpoint_desc": "Endpoint for the MCP server.",

  // Tool test dialog
  "mcp.dialog.result_title": "Result: %0",
  "mcp.dialog.no_parameters": "This tool has no parameters.",
  "mcp.dialog.run_tool": "Run Tool",
  "mcp.dialog.copy_input": "Copy Input",
  "mcp.dialog.cancel": "Cancel",
  "mcp.dialog.close": "Close",
  "mcp.dialog.json_array_placeholder": "Enter JSON array, e.g. [1, 2, 3]",
  "mcp.dialog.json_object_placeholder": "Enter JSON object",
  "mcp.dialog.input_copied": "Input copied to clipboard",
  "mcp.dialog.copy_failed": "Failed to copy to clipboard",
  "mcp.dialog.running_tool": "Running tool...",
  "mcp.dialog.tool_not_found": "Tool \"%0\" not found",

  // Prompt preview dialog
  "mcp.dialog.prompt_title": "Prompt: %0",
  "mcp.dialog.copy": "Copy",
  "mcp.dialog.prompt_copied": "Prompt copied to clipboard",
  "mcp.dialog.no_arguments": "This prompt has no arguments.",
  "mcp.dialog.generate_prompt": "Generate Prompt",
  "mcp.dialog.generating_prompt": "Generating prompt...",
  "mcp.dialog.prompt_not_found": "Prompt \"%0\" not found",
  "mcp.dialog.role_user": "User",
  "mcp.dialog.role_assistant": "Assistant",
};

// German translations
const de: Record<string, string> = {
  // Panel sections
  "mcp.panel.sessions": "Sitzungen",
  "mcp.panel.server": "Server",
  "mcp.panel.tools": "Werkzeuge",
  "mcp.panel.resources": "Ressourcen",
  "mcp.panel.prompts": "Prompts",

  // Sessions section
  "mcp.sessions.no_clients": "Keine Clients verbunden",

  // Server section
  "mcp.server.name": "Servername",
  "mcp.server.version": "Serverversion",
  "mcp.server.connected_clients": "Verbundene Clients",

  // Filter UI
  "mcp.filter.tools_placeholder": "Werkzeuge filtern...",
  "mcp.filter.resources_placeholder": "Ressourcen filtern...",
  "mcp.filter.prompts_placeholder": "Prompts filtern...",
  "mcp.filter.show_experimental": "Experimentelle anzeigen",

  // Empty states
  "mcp.tools.no_match": "Keine Werkzeuge entsprechen Ihrem Filter.",
  "mcp.tools.none_available": "Keine Werkzeuge verfügbar.",
  "mcp.resources.no_match": "Keine Ressourcen entsprechen Ihrem Filter.",
  "mcp.resources.none_available": "Keine Ressourcen verfügbar.",
  "mcp.prompts.no_match": "Keine Prompts entsprechen Ihrem Filter.",
  "mcp.prompts.none_available": "Keine Prompts verfügbar.",

  // Prompts
  "mcp.prompts.argument_count": "%0 Argument",
  "mcp.prompts.argument_count_plural": "%0 Argumente",

  // Tooltips
  "mcp.tooltip.click_to_test": "Klicken zum Testen von %0",
  "mcp.tooltip.click_to_preview": "Klicken zur Vorschau von %0",
  "mcp.tooltip.click_to_view_panel": "Klicken zum Anzeigen des MCP-Panels",

  // Status bar
  "mcp.status.experimental_tooltip": "Dieses Werkzeug ist experimentell",
  "mcp.status.server": "MCP Server",
  "mcp.status.server_one_client": "MCP Server (1 Client)",
  "mcp.status.server_clients": "MCP Server (%0 Clients)",

  // Settings
  "mcp.settings.instructions_name": "MCP Systemanweisungen",
  "mcp.settings.instructions_desc": "Anweisungen für das MCP-System.",
  "mcp.settings.port_name": "MCP Server Port",
  "mcp.settings.port_desc": "Port für den MCP-Server.",
  "mcp.settings.endpoint_name": "MCP Server Endpunkt",
  "mcp.settings.endpoint_desc": "Endpunkt für den MCP-Server.",

  // Tool test dialog
  "mcp.dialog.result_title": "Ergebnis: %0",
  "mcp.dialog.no_parameters": "Dieses Werkzeug hat keine Parameter.",
  "mcp.dialog.run_tool": "Werkzeug ausführen",
  "mcp.dialog.copy_input": "Eingabe kopieren",
  "mcp.dialog.cancel": "Abbrechen",
  "mcp.dialog.close": "Schließen",
  "mcp.dialog.json_array_placeholder": "JSON-Array eingeben, z.B. [1, 2, 3]",
  "mcp.dialog.json_object_placeholder": "JSON-Objekt eingeben",
  "mcp.dialog.input_copied": "Eingabe in Zwischenablage kopiert",
  "mcp.dialog.copy_failed": "Kopieren in Zwischenablage fehlgeschlagen",
  "mcp.dialog.running_tool": "Werkzeug wird ausgeführt...",
  "mcp.dialog.tool_not_found": "Werkzeug \"%0\" nicht gefunden",

  // Prompt preview dialog
  "mcp.dialog.prompt_title": "Prompt: %0",
  "mcp.dialog.copy": "Kopieren",
  "mcp.dialog.prompt_copied": "Prompt in Zwischenablage kopiert",
  "mcp.dialog.no_arguments": "Dieser Prompt hat keine Argumente.",
  "mcp.dialog.generate_prompt": "Prompt generieren",
  "mcp.dialog.generating_prompt": "Prompt wird generiert...",
  "mcp.dialog.prompt_not_found": "Prompt \"%0\" nicht gefunden",
  "mcp.dialog.role_user": "Benutzer",
  "mcp.dialog.role_assistant": "Assistent",
};

// Japanese translations
const ja: Record<string, string> = {
  // Panel sections
  "mcp.panel.sessions": "セッション",
  "mcp.panel.server": "サーバー",
  "mcp.panel.tools": "ツール",
  "mcp.panel.resources": "リソース",
  "mcp.panel.prompts": "プロンプト",

  // Sessions section
  "mcp.sessions.no_clients": "クライアントが接続されていません",

  // Server section
  "mcp.server.name": "サーバー名",
  "mcp.server.version": "サーバーバージョン",
  "mcp.server.connected_clients": "接続中のクライアント",

  // Filter UI
  "mcp.filter.tools_placeholder": "ツールを検索...",
  "mcp.filter.resources_placeholder": "リソースを検索...",
  "mcp.filter.prompts_placeholder": "プロンプトを検索...",
  "mcp.filter.show_experimental": "実験的を表示",

  // Empty states
  "mcp.tools.no_match": "フィルターに一致するツールがありません。",
  "mcp.tools.none_available": "利用可能なツールがありません。",
  "mcp.resources.no_match": "フィルターに一致するリソースがありません。",
  "mcp.resources.none_available": "利用可能なリソースがありません。",
  "mcp.prompts.no_match": "フィルターに一致するプロンプトがありません。",
  "mcp.prompts.none_available": "利用可能なプロンプトがありません。",

  // Prompts
  "mcp.prompts.argument_count": "%0 引数",
  "mcp.prompts.argument_count_plural": "%0 引数",

  // Tooltips
  "mcp.tooltip.click_to_test": "クリックして %0 をテスト",
  "mcp.tooltip.click_to_preview": "クリックして %0 をプレビュー",
  "mcp.tooltip.click_to_view_panel": "クリックしてMCPパネルを表示",

  // Status bar
  "mcp.status.experimental_tooltip": "このツールは実験的です",
  "mcp.status.server": "MCPサーバー",
  "mcp.status.server_one_client": "MCPサーバー (1クライアント)",
  "mcp.status.server_clients": "MCPサーバー (%0クライアント)",

  // Settings
  "mcp.settings.instructions_name": "MCPシステム指示",
  "mcp.settings.instructions_desc": "MCPシステムの指示。",
  "mcp.settings.port_name": "MCPサーバーポート",
  "mcp.settings.port_desc": "MCPサーバーのポート。",
  "mcp.settings.endpoint_name": "MCPサーバーエンドポイント",
  "mcp.settings.endpoint_desc": "MCPサーバーのエンドポイント。",

  // Tool test dialog
  "mcp.dialog.result_title": "結果: %0",
  "mcp.dialog.no_parameters": "このツールにはパラメータがありません。",
  "mcp.dialog.run_tool": "ツールを実行",
  "mcp.dialog.copy_input": "入力をコピー",
  "mcp.dialog.cancel": "キャンセル",
  "mcp.dialog.close": "閉じる",
  "mcp.dialog.json_array_placeholder": "JSON配列を入力 (例: [1, 2, 3])",
  "mcp.dialog.json_object_placeholder": "JSONオブジェクトを入力",
  "mcp.dialog.input_copied": "入力をクリップボードにコピーしました",
  "mcp.dialog.copy_failed": "クリップボードへのコピーに失敗しました",
  "mcp.dialog.running_tool": "ツールを実行中...",
  "mcp.dialog.tool_not_found": "ツール \"%0\" が見つかりません",

  // Prompt preview dialog
  "mcp.dialog.prompt_title": "プロンプト: %0",
  "mcp.dialog.copy": "コピー",
  "mcp.dialog.prompt_copied": "プロンプトをクリップボードにコピーしました",
  "mcp.dialog.no_arguments": "このプロンプトには引数がありません。",
  "mcp.dialog.generate_prompt": "プロンプトを生成",
  "mcp.dialog.generating_prompt": "プロンプトを生成中...",
  "mcp.dialog.prompt_not_found": "プロンプト \"%0\" が見つかりません",
  "mcp.dialog.role_user": "ユーザー",
  "mcp.dialog.role_assistant": "アシスタント",
};

// Chinese (Simplified) translations
const zh: Record<string, string> = {
  // Panel sections
  "mcp.panel.sessions": "会话",
  "mcp.panel.server": "服务器",
  "mcp.panel.tools": "工具",
  "mcp.panel.resources": "资源",
  "mcp.panel.prompts": "提示词",

  // Sessions section
  "mcp.sessions.no_clients": "没有客户端连接",

  // Server section
  "mcp.server.name": "服务器名称",
  "mcp.server.version": "服务器版本",
  "mcp.server.connected_clients": "已连接客户端",

  // Filter UI
  "mcp.filter.tools_placeholder": "筛选工具...",
  "mcp.filter.resources_placeholder": "筛选资源...",
  "mcp.filter.prompts_placeholder": "筛选提示词...",
  "mcp.filter.show_experimental": "显示实验性",

  // Empty states
  "mcp.tools.no_match": "没有匹配的工具。",
  "mcp.tools.none_available": "没有可用的工具。",
  "mcp.resources.no_match": "没有匹配的资源。",
  "mcp.resources.none_available": "没有可用的资源。",
  "mcp.prompts.no_match": "没有匹配的提示词。",
  "mcp.prompts.none_available": "没有可用的提示词。",

  // Prompts
  "mcp.prompts.argument_count": "%0 个参数",
  "mcp.prompts.argument_count_plural": "%0 个参数",

  // Tooltips
  "mcp.tooltip.click_to_test": "点击测试 %0",
  "mcp.tooltip.click_to_preview": "点击预览 %0",
  "mcp.tooltip.click_to_view_panel": "点击查看MCP面板",

  // Status bar
  "mcp.status.experimental_tooltip": "此工具为实验性功能",
  "mcp.status.server": "MCP服务器",
  "mcp.status.server_one_client": "MCP服务器 (1个客户端)",
  "mcp.status.server_clients": "MCP服务器 (%0个客户端)",

  // Settings
  "mcp.settings.instructions_name": "MCP系统指令",
  "mcp.settings.instructions_desc": "MCP系统的指令。",
  "mcp.settings.port_name": "MCP服务器端口",
  "mcp.settings.port_desc": "MCP服务器的端口。",
  "mcp.settings.endpoint_name": "MCP服务器端点",
  "mcp.settings.endpoint_desc": "MCP服务器的端点。",

  // Tool test dialog
  "mcp.dialog.result_title": "结果: %0",
  "mcp.dialog.no_parameters": "此工具没有参数。",
  "mcp.dialog.run_tool": "运行工具",
  "mcp.dialog.copy_input": "复制输入",
  "mcp.dialog.cancel": "取消",
  "mcp.dialog.close": "关闭",
  "mcp.dialog.json_array_placeholder": "输入JSON数组，例如 [1, 2, 3]",
  "mcp.dialog.json_object_placeholder": "输入JSON对象",
  "mcp.dialog.input_copied": "输入已复制到剪贴板",
  "mcp.dialog.copy_failed": "复制到剪贴板失败",
  "mcp.dialog.running_tool": "正在运行工具...",
  "mcp.dialog.tool_not_found": "未找到工具 \"%0\"",

  // Prompt preview dialog
  "mcp.dialog.prompt_title": "提示词: %0",
  "mcp.dialog.copy": "复制",
  "mcp.dialog.prompt_copied": "提示词已复制到剪贴板",
  "mcp.dialog.no_arguments": "此提示词没有参数。",
  "mcp.dialog.generate_prompt": "生成提示词",
  "mcp.dialog.generating_prompt": "正在生成提示词...",
  "mcp.dialog.prompt_not_found": "未找到提示词 \"%0\"",
  "mcp.dialog.role_user": "用户",
  "mcp.dialog.role_assistant": "助手",
};

// All translations mapped by language code
const translations: Record<string, Record<string, string>> = {
  en,
  de,
  ja,
  zh,
};

/**
 * Registers all MCP plugin translations with Blockbench's language system.
 * Should be called during plugin setup.
 */
export function setupI18n(): void {
  // Always register English first as the fallback
  Language.addTranslations("en", en);

  // Register other languages
  for (const [langCode, strings] of Object.entries(translations)) {
    if (langCode !== "en") {
      Language.addTranslations(langCode, strings);
    }
  }
}

/**
 * Helper to format argument count with proper pluralization
 */
export function formatArgumentCount(count: number): string {
  if (count === 1) {
    return tl("mcp.prompts.argument_count", [count]);
  }
  return tl("mcp.prompts.argument_count_plural", [count]);
}
