# Benchmark suite guidance

This directory measures AI modeling quality through the real Blockbench MCP server.
Unit tests validate the harness; they are not model-quality results.

- Run every trial, prediction, tool call, and reviewer sequentially. Never parallelize
  benchmarks: Blockbench has one active project. Keep the runner's process lock.
- Each matrix cell/repetition creates and closes its own MCP client connection.
  Use a dedicated Blockbench instance with no personal projects open. New projects
  isolate model content; editor settings/plugins are shared and must remain fixed.
- Use the same case prompts, stage order, context snapshot, budgets, tool policy,
  and conditions for every model. Never improve a prompt for just one provider.
- Load skills and agent definitions from BLOCKBENCH_PROJECT_ROOT (the sibling
  blockbench-mcp-project checkout by default). Snapshot their contents and hashes.
  Run supported reviewers as sequential same-model subagents, never concurrently.
- Preserve failed, skipped, budget-exhausted, and interrupted attempts. Do not
  silently retry paid requests, discard bad outputs, or report partial work as success.
- Results under results/ are local evidence and are git-ignored (only
  results/README.md is tracked). Never stage, commit or force-add them. Do not
  search, read or summarize results/ unless the user points to a specific file
  there; it holds large traces, snapshots and images. Never commit empty files.
- Keep REPLICATE_API_TOKEN in the environment. Never record credentials or raw
  request headers. Do not auto-stage the whole repository or auto-commit results.
- Live runs cost money and change Blockbench. Use explicit `run`; `plan` and Bun
  harness tests must work without credentials or an open Blockbench instance.
- Human visual scores require evidence, a named reviewer, and the common rubric.
  Structural metrics and self-reviews are not substitutes for visual assessment.
- Use strict TypeScript, documented exports, Bun APIs and bun:test. Keep Replicate
  out of the shipped plugin bundle. Preserve unrelated working-tree changes.
