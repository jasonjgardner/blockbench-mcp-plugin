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
    // @ts-ignore Deep type instantiation
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

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

function statusBadge(status: string): string {
  const cls = status === "stable" ? "badge-stable" : "badge-experimental";
  return `<span class="badge ${cls}">${status}</span>`;
}

function annotationBadges(annotations: ToolDocEntry["annotations"]): string {
  const badges: string[] = [];
  if (annotations.destructiveHint) {
    badges.push('<span class="badge badge-destructive">destructive</span>');
  }
  if (annotations.readOnlyHint) {
    badges.push('<span class="badge badge-readonly">read-only</span>');
  }
  if (annotations.openWorldHint) {
    badges.push('<span class="badge badge-openworld">open-world</span>');
  }
  return badges.join("");
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

  const reqSpan = required
    ? '<span class="param-required">required</span>'
    : '<span class="param-optional">optional</span>';

  const meta = [
    defaultVal ? `(default: <code>${escapeHtml(defaultVal)}</code>)` : "",
    constraints.length ? `[${constraints.join(", ")}]` : "",
  ].filter(Boolean).join(" ");

  return `<tr>
      <td class="col-name">${name}</td>
      <td class="col-type">${escapeHtml(typeLabel)}</td>
      <td>${reqSpan}</td>
      <td class="col-desc">${escapeHtml(description)}${meta ? ` <span class="param-meta">${meta}</span>` : ""}</td>
    </tr>`;
}

function renderParametersTable(params: Record<string, unknown>): string {
  const properties = (params.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((params.required ?? []) as string[]);

  if (Object.keys(properties).length === 0) {
    return '<p class="empty-params">No parameters</p>';
  }

  const rows = Object.entries(properties)
    .map(([name, prop]) => renderParameterRow(name, prop, required.has(name)))
    .join("");

  return `<table class="param-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Type</th>
          <th>Required</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderToolCard(tool: ToolDocEntry): string {
  const schema = tool.parameters as Record<string, unknown>;
  const innerSchema =
    ((schema.definitions as Record<string, unknown> | undefined)?.[tool.name] as Record<string, unknown>) ??
    schema;

  return `<div id="tool-${tool.name}" class="card tool-card">
      <div class="card-header">
        <h3 class="card-name">${tool.name}</h3>
        <div class="card-badges">
          ${statusBadge(tool.status)}
          ${annotationBadges(tool.annotations)}
        </div>
      </div>
      ${tool.title !== tool.name ? `<p class="card-title">${escapeHtml(tool.title)}</p>` : ""}
      <p class="card-desc">${escapeHtml(tool.description)}</p>
      <div class="overflow-x">
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
    : '<p class="empty-params">No arguments</p>';

  return `<div class="card">
      <div class="card-header">
        <h3 class="card-name">${prompt.name}</h3>
        <div class="card-badges">${statusBadge(prompt.status)}</div>
      </div>
      ${prompt.title !== prompt.name ? `<p class="card-title">${escapeHtml(prompt.title)}</p>` : ""}
      <p class="card-desc">${escapeHtml(prompt.description)}</p>
      <div class="overflow-x">${argsHtml}</div>
    </div>`;
}

function renderResourceCard(resource: ResourceDocEntry): string {
  return `<div class="card">
      <div class="card-header">
        <h3 class="card-name">${resource.name}</h3>
      </div>
      ${resource.title !== resource.name ? `<p class="card-title">${escapeHtml(resource.title)}</p>` : ""}
      <p class="uri-template">${escapeHtml(resource.uriTemplate)}</p>
      <p class="card-desc">${escapeHtml(resource.description)}</p>
    </div>`;
}

async function generateHtml(data: DocOutput): Promise<string> {
  const categoryNav = toolManifest
    .map(
      ({ category, tools }) =>
        `<a href="#cat-${slugify(category)}" class="nav-link">${escapeHtml(category)} <span class="count">(${tools.length})</span></a>`
    )
    .join("\n        ");

  const toolSections = toolManifest
    .map(({ category }) => {
      const tools = data.tools.filter((t) => t.category === category);
      if (tools.length === 0) return "";
      return `<section id="cat-${slugify(category)}" class="category-section">
          <h3 class="category-title">${escapeHtml(category)}</h3>
          ${tools.map(renderToolCard).join("\n")}
        </section>`;
    })
    .join("\n");

  const stableCount = data.tools.filter((t) => t.status === "stable").length;
  const experimentalCount = data.tools.filter((t) => t.status === "experimental").length;

  const installationInstructionsFile = await Bun.file(import.meta.dir + "/../docs/llms/install.md").text();
  const installationInstructions = Bun.markdown.html(installationInstructionsFile);

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Blockbench MCP Plugin — API Reference</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <div class="layout">
    <nav class="sidebar">
      <div class="sidebar-brand">
        <h1>Blockbench MCP</h1>
        <p>v${version} — API Reference</p>
      </div>

      <input id="search" type="text" placeholder="Search tools..." class="search-input" />

      <div class="nav-group">
        <p class="nav-heading">Overview</p>
        <a href="#tools" class="nav-link">Tools <span class="count">(${data.tools.length})</span></a>
        <a href="#prompts" class="nav-link">Prompts <span class="count">(${data.prompts.length})</span></a>
        <a href="#resources" class="nav-link">Resources <span class="count">(${data.resources.length})</span></a>
      </div>

      <div class="nav-group">
        <p class="nav-heading">Categories</p>
        ${categoryNav}
      </div>
    </nav>

    <main class="main">
      <header class="page-header">
        <h1>Blockbench MCP Plugin</h1>
        <p class="subtitle">API Reference — v${version}</p>
        <nav class="stats">
          <a href="#tools"><strong>${data.tools.length}</strong> tools (${stableCount} stable, ${experimentalCount} experimental)</a>
          <a href="#prompts"><strong>${data.prompts.length}</strong> prompts</a>
          <a href="#resources"><strong>${data.resources.length}</strong> resources</a>
        </nav>
      </header>

      <section id="install" class="doc-section">
        ${installationInstructions}
      </section>

      <section id="tools" class="doc-section">
        <h2 class="section-title">Tools</h2>
        ${toolSections}
      </section>

      <section id="prompts" class="doc-section">
        <h2 class="section-title">Prompts</h2>
        ${data.prompts.map(renderPromptCard).join("\n")}
      </section>

      <section id="resources" class="doc-section">
        <h2 class="section-title">Resources</h2>
        ${data.resources.map(renderResourceCard).join("\n")}
      </section>

      <footer class="page-footer">
        Generated ${data.generatedAt} from Zod schemas
      </footer>
    </main>
  </div>

  <script>
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
  const htmlContent = await generateHtml(output);
  await Bun.write(htmlPath, htmlContent);
  log.info(`  ${htmlPath}`);

  log.success(
    `Documentation generated: ${tools.length} tools, ${prompts.length} prompts, ${resources.length} resources`
  );
}

main().catch((err) => {
  log.error(`Documentation generation failed: ${err}`);
  process.exit(1);
});
