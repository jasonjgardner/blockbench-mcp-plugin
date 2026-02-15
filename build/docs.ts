import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { toolManifest, promptDocs, resourceDocs } from "./docs-manifest";
import type { ToolSpec, PromptSpec, ResourceSpec } from "../lib/factories";
import { version } from "../package.json";
import { log } from "./utils";

// ============================================================================
// Types
// ============================================================================

interface ToolDocEntry {
  name: string;
  title: string;
  description: string;
  status: string;
  category: string;
  annotations: {
    destructiveHint?: boolean;
    readOnlyHint?: boolean;
    openWorldHint?: boolean;
  };
  parameters: object;
}

interface PromptDocEntry {
  name: string;
  title: string;
  description: string;
  status: string;
  arguments: object | null;
}

interface ResourceDocEntry {
  name: string;
  title: string;
  description: string;
  uriTemplate: string;
}

interface DocOutput {
  version: string;
  generatedAt: string;
  tools: ToolDocEntry[];
  prompts: PromptDocEntry[];
  resources: ResourceDocEntry[];
}

// ============================================================================
// Schema Conversion
// ============================================================================

function convertSchema(name: string, schema: z.ZodType): object {
  try {
    return zodToJsonSchema(schema, {
      name,
      $refStrategy: "none",
      errorMessages: true,
      markdownDescription: true,
    });
  } catch (err) {
    console.warn(`Warning: Failed to convert schema for "${name}":`, err);
    return { type: "object", description: "Schema conversion failed" };
  }
}

function convertToolSpec(spec: ToolSpec, category: string): ToolDocEntry {
  return {
    name: spec.name,
    title: spec.annotations?.title ?? spec.name,
    description: spec.description,
    status: spec.status,
    category,
    annotations: {
      destructiveHint: spec.annotations?.destructiveHint,
      readOnlyHint: spec.annotations?.readOnlyHint,
      openWorldHint: spec.annotations?.openWorldHint,
    },
    parameters: convertSchema(spec.name, spec.parameters),
  };
}

function convertPromptSpec(spec: PromptSpec): PromptDocEntry {
  return {
    name: spec.name,
    title: spec.title ?? spec.name,
    description: spec.description,
    status: spec.status,
    arguments: spec.argsSchema ? convertSchema(spec.name, spec.argsSchema) : null,
  };
}

function convertResourceSpec(spec: ResourceSpec): ResourceDocEntry {
  return {
    name: spec.name,
    title: spec.title ?? spec.name,
    description: spec.description,
    uriTemplate: spec.uriTemplate,
  };
}

// ============================================================================
// HTML Generation
// ============================================================================

function getTypeLabel(schema: Record<string, unknown>): string {
  if (schema.enum) return (schema.enum as string[]).map((v) => `"${v}"`).join(" | ");
  if (schema.anyOf) return (schema.anyOf as Record<string, unknown>[]).map(getTypeLabel).join(" | ");
  if (schema.oneOf) return (schema.oneOf as Record<string, unknown>[]).map(getTypeLabel).join(" | ");
  if (schema.type === "array") {
    const items = schema.items as Record<string, unknown> | undefined;
    return items ? `${getTypeLabel(items)}[]` : "array";
  }
  if (schema.type === "object" && schema.additionalProperties) {
    const valType = getTypeLabel(schema.additionalProperties as Record<string, unknown>);
    return `Record<string, ${valType}>`;
  }
  if (schema.type) return schema.type as string;
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  return "unknown";
}

function renderParameterRow(
  name: string,
  prop: Record<string, unknown>,
  required: boolean
): string {
  const typeLabel = getTypeLabel(prop);
  const description = (prop.description as string) ?? "";
  const defaultVal = prop.default !== undefined ? JSON.stringify(prop.default) : "";
  const constraints: string[] = [];

  if (prop.minimum !== undefined) constraints.push(`min: ${prop.minimum}`);
  if (prop.maximum !== undefined) constraints.push(`max: ${prop.maximum}`);
  if (prop.minLength !== undefined) constraints.push(`minLength: ${prop.minLength}`);
  if (prop.maxLength !== undefined) constraints.push(`maxLength: ${prop.maxLength}`);
  if (prop.minItems !== undefined) constraints.push(`minItems: ${prop.minItems}`);
  if (prop.maxItems !== undefined) constraints.push(`maxItems: ${prop.maxItems}`);

  return `
    <tr class="border-b border-gray-200 dark:border-gray-700">
      <td class="py-2 px-3 font-mono text-sm text-blue-700 dark:text-blue-400">${name}</td>
      <td class="py-2 px-3 font-mono text-xs text-gray-600 dark:text-gray-400">${escapeHtml(typeLabel)}</td>
      <td class="py-2 px-3 text-sm">${required
        ? '<span class="text-red-600 dark:text-red-400 font-medium">required</span>'
        : '<span class="text-gray-400">optional</span>'}</td>
      <td class="py-2 px-3 text-sm text-gray-700 dark:text-gray-300">${escapeHtml(description)}${
        defaultVal ? ` <span class="text-gray-400">(default: <code class="text-xs">${escapeHtml(defaultVal)}</code>)</span>` : ""
      }${constraints.length ? ` <span class="text-gray-400">[${constraints.join(", ")}]</span>` : ""}</td>
    </tr>`;
}

function renderParametersTable(params: Record<string, unknown>): string {
  const properties = (params.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((params.required ?? []) as string[]);

  if (Object.keys(properties).length === 0) {
    return '<p class="text-sm text-gray-400 italic">No parameters</p>';
  }

  const rows = Object.entries(properties)
    .map(([name, prop]) => renderParameterRow(name, prop, required.has(name)))
    .join("");

  return `
    <table class="w-full text-left">
      <thead>
        <tr class="border-b-2 border-gray-300 dark:border-gray-600">
          <th class="py-2 px-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Name</th>
          <th class="py-2 px-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Type</th>
          <th class="py-2 px-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Required</th>
          <th class="py-2 px-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Description</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function statusBadge(status: string): string {
  if (status === "stable") {
    return '<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">stable</span>';
  }
  return '<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300">experimental</span>';
}

function annotationBadges(annotations: ToolDocEntry["annotations"]): string {
  const badges: string[] = [];
  if (annotations.destructiveHint) {
    badges.push('<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300">destructive</span>');
  }
  if (annotations.readOnlyHint) {
    badges.push('<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300">read-only</span>');
  }
  if (annotations.openWorldHint) {
    badges.push('<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300">open-world</span>');
  }
  return badges.join(" ");
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderToolCard(tool: ToolDocEntry): string {
  const schema = tool.parameters as Record<string, unknown>;
  const innerSchema =
    ((schema.definitions as Record<string, unknown> | undefined)?.[tool.name] as Record<string, unknown>) ??
    schema;

  return `
    <div id="tool-${tool.name}" class="tool-card bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6 mb-4">
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100 font-mono">${tool.name}</h3>
        <div class="flex gap-1">
          ${statusBadge(tool.status)}
          ${annotationBadges(tool.annotations)}
        </div>
      </div>
      ${tool.title !== tool.name ? `<p class="text-sm text-gray-500 dark:text-gray-400 mb-2">${escapeHtml(tool.title)}</p>` : ""}
      <p class="text-sm text-gray-700 dark:text-gray-300 mb-4">${escapeHtml(tool.description)}</p>
      <div class="overflow-x-auto">
        ${renderParametersTable(innerSchema)}
      </div>
    </div>`;
}

function renderPromptCard(prompt: PromptDocEntry): string {
  const argsHtml = prompt.arguments
    ? renderParametersTable(
        ((prompt.arguments as Record<string, unknown>).definitions as Record<string, Record<string, unknown>> | undefined)?.[prompt.name] ??
        prompt.arguments as Record<string, unknown>
      )
    : '<p class="text-sm text-gray-400 italic">No arguments</p>';

  return `
    <div class="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6 mb-4">
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100 font-mono">${prompt.name}</h3>
        ${statusBadge(prompt.status)}
      </div>
      ${prompt.title !== prompt.name ? `<p class="text-sm text-gray-500 dark:text-gray-400 mb-2">${escapeHtml(prompt.title)}</p>` : ""}
      <p class="text-sm text-gray-700 dark:text-gray-300 mb-4">${escapeHtml(prompt.description)}</p>
      <div class="overflow-x-auto">${argsHtml}</div>
    </div>`;
}

function renderResourceCard(resource: ResourceDocEntry): string {
  return `
    <div class="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6 mb-4">
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100 font-mono">${resource.name}</h3>
      </div>
      ${resource.title !== resource.name ? `<p class="text-sm text-gray-500 dark:text-gray-400 mb-1">${escapeHtml(resource.title)}</p>` : ""}
      <p class="text-sm font-mono text-blue-600 dark:text-blue-400 mb-2">${escapeHtml(resource.uriTemplate)}</p>
      <p class="text-sm text-gray-700 dark:text-gray-300">${escapeHtml(resource.description)}</p>
    </div>`;
}

function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function generateHtml(data: DocOutput): string {
  const categoryNav = toolManifest
    .map(
      ({ category, tools }) =>
        `<a href="#cat-${slugify(category)}" class="block px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors">
          ${escapeHtml(category)} <span class="text-gray-400">(${tools.length})</span>
        </a>`
    )
    .join("");

  const toolSections = toolManifest
    .map(({ category }) => {
      const tools = data.tools.filter((t) => t.category === category);
      if (tools.length === 0) return "";
      return `
        <section id="cat-${slugify(category)}" class="mb-8">
          <h2 class="text-xl font-bold text-gray-900 dark:text-gray-100 mb-4 border-b border-gray-200 dark:border-gray-700 pb-2">${escapeHtml(category)}</h2>
          ${tools.map(renderToolCard).join("")}
        </section>`;
    })
    .join("");

  const stableCount = data.tools.filter((t) => t.status === "stable").length;
  const experimentalCount = data.tools.filter((t) => t.status === "experimental").length;

  return `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Blockbench MCP Plugin — API Reference</title>
  <link rel="stylesheet" href="style.css" />
  <script>
    if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.classList.add('dark');
    }
  </script>
</head>
<body class="bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 min-h-screen">
  <div class="flex">
    <!-- Sidebar -->
    <nav class="hidden lg:block w-64 shrink-0 h-screen sticky top-0 overflow-y-auto border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
      <div class="mb-6">
        <h1 class="text-lg font-bold">Blockbench MCP</h1>
        <p class="text-xs text-gray-500 dark:text-gray-400">v${version} — API Reference</p>
      </div>

      <div class="mb-4">
        <input id="search" type="text" placeholder="Search tools..."
          class="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500" />
      </div>

      <div class="mb-4">
        <p class="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase mb-2">Overview</p>
        <a href="#tools" class="block px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">Tools <span class="text-gray-400">(${data.tools.length})</span></a>
        <a href="#prompts" class="block px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">Prompts <span class="text-gray-400">(${data.prompts.length})</span></a>
        <a href="#resources" class="block px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">Resources <span class="text-gray-400">(${data.resources.length})</span></a>
      </div>

      <div>
        <p class="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase mb-2">Categories</p>
        ${categoryNav}
      </div>

      <div class="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
        <button id="theme-toggle" class="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">Toggle theme</button>
      </div>
    </nav>

    <!-- Main Content -->
    <main class="flex-1 max-w-4xl mx-auto px-6 py-8">
      <header class="mb-8">
        <h1 class="text-3xl font-bold mb-2">Blockbench MCP Plugin</h1>
        <p class="text-gray-600 dark:text-gray-400 mb-4">API Reference — v${version}</p>
        <div class="flex gap-4 text-sm">
          <span class="text-gray-600 dark:text-gray-400"><strong>${data.tools.length}</strong> tools (${stableCount} stable, ${experimentalCount} experimental)</span>
          <span class="text-gray-600 dark:text-gray-400"><strong>${data.prompts.length}</strong> prompts</span>
          <span class="text-gray-600 dark:text-gray-400"><strong>${data.resources.length}</strong> resources</span>
        </div>
      </header>

      <section id="tools" class="mb-12">
        <h2 class="text-2xl font-bold mb-6 border-b-2 border-gray-300 dark:border-gray-600 pb-2">Tools</h2>
        ${toolSections}
      </section>

      <section id="prompts" class="mb-12">
        <h2 class="text-2xl font-bold mb-6 border-b-2 border-gray-300 dark:border-gray-600 pb-2">Prompts</h2>
        ${data.prompts.map(renderPromptCard).join("")}
      </section>

      <section id="resources" class="mb-12">
        <h2 class="text-2xl font-bold mb-6 border-b-2 border-gray-300 dark:border-gray-600 pb-2">Resources</h2>
        ${data.resources.map(renderResourceCard).join("")}
      </section>

      <footer class="text-center text-xs text-gray-400 dark:text-gray-500 py-8 border-t border-gray-200 dark:border-gray-700">
        Generated ${data.generatedAt} from Zod schemas
      </footer>
    </main>
  </div>

  <script>
    // Theme toggle
    document.getElementById('theme-toggle')?.addEventListener('click', () => {
      document.documentElement.classList.toggle('dark');
      localStorage.theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    });

    // Search
    document.getElementById('search')?.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      document.querySelectorAll('.tool-card').forEach((card) => {
        const text = card.textContent?.toLowerCase() ?? '';
        card.style.display = text.includes(query) ? '' : 'none';
      });
    });
  </script>
</body>
</html>`;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  log.header("Blockbench MCP Documentation Generator");

  log.step("Collecting tool specs...");
  const tools: ToolDocEntry[] = [];
  for (const { category, tools: specs } of toolManifest) {
    for (const spec of specs) {
      tools.push(convertToolSpec(spec, category));
    }
  }
  log.info(`  ${tools.length} tools across ${toolManifest.length} categories`);

  log.step("Collecting prompt specs...");
  const prompts = promptDocs.map(convertPromptSpec);
  log.info(`  ${prompts.length} prompts`);

  log.step("Collecting resource specs...");
  const resources = resourceDocs.map(convertResourceSpec);
  log.info(`  ${resources.length} resources`);

  const output: DocOutput = {
    version,
    generatedAt: new Date().toISOString(),
    tools,
    prompts,
    resources,
  };

  // Resolve docs directory relative to this script's location
  const docsDir = import.meta.dir + "/../docs";

  // Write JSON
  log.step("Writing docs/api.json...");
  const jsonPath = docsDir + "/api.json";
  await Bun.write(jsonPath, JSON.stringify(output, null, 2));
  log.info(`  ${jsonPath}`);

  // Write HTML
  log.step("Writing docs/index.html...");
  const htmlPath = docsDir + "/index.html";
  await Bun.write(htmlPath, generateHtml(output));
  log.info(`  ${htmlPath}`);

  // Write Tailwind CSS source
  log.step("Writing docs/style.css...");
  const cssPath = docsDir + "/style.css";
  await Bun.write(cssPath, `@import "tailwindcss";\n`);
  log.info(`  ${cssPath}`);

  log.success(
    `Documentation generated: ${tools.length} tools, ${prompts.length} prompts, ${resources.length} resources`
  );
}

main().catch((err) => {
  log.error(`Documentation generation failed: ${err}`);
  process.exit(1);
});
