# Blockbench model-quality benchmarks

A Bun/TypeScript harness that runs AI modeling agents through the Blockbench MCP
plugin, using the official **Replicate Node.js package** for every provider.
This measures asset quality and task completion, not plugin unit-test coverage.

The default matrix has **162 trials**: nine models × six assets × three starting
conditions × one repetition. All trials and reviewer calls run sequentially.

## Start locally

```sh
bun run benchmark:typecheck
bun run benchmark:test
bun run benchmark:plan
```

These commands do not call Replicate or connect to your Blockbench instance. Tests
use mocked predictions and an in-process MCP server on loopback. `plan` snapshots
the configuration, expanded prompts, Project guidance and source hashes under
`benchmarks/results/<timestamp>--plan--<id>/`. Plan output is not quality data.

The Project checkout defaults to the sibling
`../blockbench-mcp-project/blockbench-mcp-project`, resolving on this workstation to
`D:\Web Development\GitHub\blockbench-mcp-project\blockbench-mcp-project`.
Override it with `--project-root <path>` or `BLOCKBENCH_PROJECT_ROOT`.

## Local CLI agents

`suite.cli.json` runs agent CLIs installed on this machine instead of paying per
token on Replicate: `claude`, `codex` and `gemini` use your existing accounts, and
Ollama models run as Claude Code agents against Ollama's local API. No
`REPLICATE_API_TOKEN` is needed.

```sh
bun run benchmark:plan --suite benchmarks/suite.cli.json
bun run benchmark:run --suite benchmarks/suite.cli.json --models claude-sonnet --cases minecraft-lantern
```

Each CLI runs as its own agent, using its native tool calling. It does not connect
to Blockbench directly. For each trial the harness starts a loopback MCP proxy,
and the CLI's only MCP server is that proxy. The proxy:

- lists only tools the benchmark policy allows, plus `read_guidance` for the
  snapshotted skills;
- checks each call the same way as the Replicate track: no paths or project
  overrides, camera calls must target the evidence view, and the assigned
  project must still be active before and after every call;
- archives every request and result, and returns text-only observations, so
  screenshots are evidence for reviewers rather than model input;
- optionally limits each stage to `limits.toolCallsPerStage` tool calls (`0`,
  the `suite.cli.json` default, means no limit); past a limit, calls fail with a
  message telling the agent to summarize, and the trial is `budget-exhausted`;
- notifies the CLI when Blockbench enables or disables tools.

Each stage is one CLI run, and later stages resume the same session. A stage that
passes `limits.stageTimeoutMs` is killed along with its child processes and
recorded as `budget-exhausted`. A usage or rate-limit refusal stops the run as
`rate-limited`.

The CLIs are isolated from your personal setup. Each runs in an empty
temporary folder outside the repository.

| CLI      | Isolation                                                                                                                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude` | `--tools ""` (no built-in tools), `--strict-mcp-config` (only the proxy), `--setting-sources ""` (no personal settings, hooks, plugins or `CLAUDE.md`). Ollama models also use `--bare`.           |
| `codex`  | Shell, apps, browser, computer-use, plugin and similar features disabled; every MCP server in `~/.codex/config.toml` switched off for the run; read-only sandbox. Your config file is not changed. |
| `gemini` | A generated system settings file (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`) sets the proxy and allows no built-in tools; `--allowed-mcp-server-names` excludes your other servers.                        |

Set `model` to `default` to use a CLI's configured model; the model it reports is
recorded. Token counts are recorded per trial but not priced, since subscriptions
and local models are not billed per token. Results measure the CLI and model
together: each CLI adds its own system prompt and agent loop.

Before a run, `run` checks each CLI with `--version` and each Ollama model with
`ollama show`, and records models that fail as `skipped-unavailable`. Gemini needs
a one-time `gemini` sign-in, or `GEMINI_API_KEY`.

## Live execution

Use a dedicated Blockbench instance with the MCP plugin enabled and no personal
projects open. Keep its version, installed plugins, enabled tools, rendering
settings and hardware fixed across comparisons. The runner discovers the live
tools and records capabilities. It requires project-file resources and offscreen
view tools from the current plugin. Save your own work before using this instance.

Set `REPLICATE_API_TOKEN` in your shell environment. Do not put it in suite.json or
commit it. `BLOCKBENCH_MCP_URL` defaults to `http://localhost:3000/bb-mcp`.

Start with a selected cell:

```sh
bun run benchmark:plan --models gpt-5-mini --cases utah-teapot --conditions empty
bun run benchmark:run --models gpt-5-mini --cases utah-teapot --conditions empty
```

Run a matched subset or the full matrix explicitly:

```sh
bun run benchmark:run --models gpt-5,claude-sonnet-4-5 --cases utah-teapot,creeper-mob --repeat 3
bun run benchmark:run
```

Live runs incur Replicate charges and modify Blockbench. The default full matrix
allows up to **32,400 predictions**, including advisory subagents. Limits are in
`suite.json`; use `--suite <path>` for a separately versioned configuration.

### Cost ceiling and cap

Add `pricing` to a model in `suite.json` to price it. Copy the prices from the
model's Replicate page and record where and when you read them:

```json
"pricing": {
  "inputPerMillionUsd": 3,
  "outputPerMillionUsd": 15,
  "source": "https://replicate.com/anthropic/claude-4.5-sonnet",
  "checkedAt": "2026-09-18"
}
```

`plan` then prints a worst-case dollar ceiling per model and in total, and writes
it to `cost-projection.json`. The ceiling assumes every trial uses all
`predictionsPerTrial` predictions, each at the `contextCharacters` cap (about 3
characters per token, which overestimates) and the full `outputTokens` cap. Real
runs cost less, because prompts start small and trials finish early. The ceiling
is a bound, not a forecast.

Pass `--max-cost <USD>` to `run` to cap total spend:

```sh
bun run benchmark:plan --models gpt-5-mini --max-cost 5
bun run benchmark:run --models gpt-5-mini --max-cost 5
```

- Before each prediction, including reviewer predictions, the runner adds that
  prediction's worst case (the whole prompt as input plus the full output cap) to
  the money spent so far. If the total would pass the cap, it does not send the
  prediction.
- The current trial is recorded as `cost-capped`. Its partial project and
  screenshots are saved, and remaining trials are recorded as
  `not-run-after-stop`.
- A capped run refuses to start unless every selected model has `pricing`.
- A suite can set its own `maxCostUsd`. It applies without the flag, and
  `--max-cost` can lower it but not raise it.

Spend comes from the `input_token_count` and `output_token_count` that Replicate
reports for each prediction. When a count is missing, the runner substitutes a
conservative estimate (about 3 characters per token for input, the full output
cap for output) and counts it in `estimatedPredictions`. A failed prediction is
charged its worst case, because Replicate may still have billed it. Because of
these substitutions, recorded cost errs high. `costs.json` holds running
per-model totals, and `summary.md` shows each trial's cost.

Cost tracking covers token-priced models only. Replicate bills some models by
GPU time, and Replicate prices change over time. Check the dashboard for actual
charges.

### Budget suite

`suite.budget.json` is a small version of the matrix with a built-in $20 cap. It
keeps one lower-cost model per provider, two cases (`minecraft-lantern`, and
`creeper-mob` for animation), the `empty` condition and one repetition: 14 trials
in total. It also uses tighter limits:

| Limit                   | Full suite | Budget suite |
| ----------------------- | ---------: | -----------: |
| `predictionsPerTrial`   |        200 |          120 |
| `turnsPerStage`         |         45 |           30 |
| `reviewerTurns`         |         12 |            8 |
| `contextCharacters`     |    180,000 |       60,000 |
| `observationCharacters` |     24,000 |        8,000 |
| `outputTokens`          |      4,096 |        2,048 |

```sh
bun run benchmark:plan --suite benchmarks/suite.budget.json
# Check one cheap trial before spending the rest of the budget:
bun run benchmark:run --suite benchmarks/suite.budget.json --models gpt-5-mini --cases minecraft-lantern
bun run benchmark:run --suite benchmarks/suite.budget.json
```

The step limits give each trial room to finish its four stages, so the matrix's
worst case (about $37) is above the cap. Real runs usually cost far less. If
spend reaches $20, the run stops before the next prediction: that trial is
recorded as `cost-capped` and the rest as `not-run-after-stop`. Trials run case
by case, so the second case is the one most likely to be cut short. Any single
trial's worst case fits under the cap.

Budget results show whether each model can drive the MCP tools. With two cases,
they are not a stable quality ranking. If many trials end `budget-exhausted`, the
limits are too tight to measure quality; raise them and pay for fewer trials rather
than comparing incomplete work.

The system prompt lists tool names only, not descriptions, for every suite. The
full descriptions of about 140 tools would add about 33,000 characters to every
prediction. The agent loads a description and schema with `describe_tool` when it
needs one.

### Rate limits

Replicate allows 600 prediction creations and 3,000 other requests per minute.
Accounts low on credit get stricter limits, and an account with granted credit
but no payment method is limited to 1 request per second and 6 per minute. Keep
the balance above about $20, as Replicate recommends, so a run is not slowed or
stopped.

The runner keeps its request count low and recovers from throttling:

- Each prediction is created with `Prefer: wait=30`, so most replies arrive in
  the create response and need no status polling. Longer predictions are polled
  at 1, 2, 4 and then every 8 seconds.
- `limits.minRequestIntervalMs` sets a minimum gap between Replicate requests.
  The budget suite uses 1000 (at most 60 per minute).
- A 429 response is waited out using its `Retry-After` header or its reset hint
  (`resets in ~30s`), then the request is sent again. This includes prediction
  creation: a 429 means no prediction was created, so nothing is billed twice.
  Each wait is recorded as a `rate-limited` event.
- After 6 throttled attempts at one request, the trial is recorded as
  `rate-limited` and the run stops. Remaining trials are recorded as
  `not-run-after-stop`; rerun them after the limit resets.

Each trial opens a new MCP client and project, captures evidence, terminates its
server session and closes the client in `finally`. Projects remain open for
inspection because the plugin has no dedicated close-project tool. Close archived
benchmark tabs manually between runs; larger matrices can consume substantial
Blockbench memory. The harness never uses arbitrary eval to close tabs.

One fixed loopback listener on port **47392** excludes concurrent runners across
local checkouts. Do not change this port, launch several controller machines
against one Blockbench instance, or interact with the instance during a run.
Project UUID checks stop execution if the active project changes. Transport
timeouts, unconfirmed prediction creation/cancellation and cleanup failures stop
the matrix; remaining trials are recorded as not run. Ctrl+C cancels inference
where possible, attempts cleanup, and preserves partial evidence. A hard kill may
leave the last prediction or view alive; inspect both services before resuming.

## Model registry

The initial registry is a set of established comparison baselines, not a claim
that these are each provider's newest or best model:

| Provider    | Replicate models                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI      | [GPT-5](https://replicate.com/openai/gpt-5), [GPT-5 mini](https://replicate.com/openai/gpt-5-mini)                                           |
| Anthropic   | [Claude Sonnet 4.5](https://replicate.com/anthropic/claude-4.5-sonnet), [Claude Haiku 4.5](https://replicate.com/anthropic/claude-4.5-haiku) |
| Google      | [Gemini 3 Pro](https://replicate.com/google/gemini-3-pro)                                                                                    |
| Meta        | [Llama 4 Maverick](https://replicate.com/meta/llama-4-maverick-instruct)                                                                     |
| Qwen        | [Qwen3 235B Instruct 2507](https://replicate.com/qwen/qwen3-235b-a22b-instruct-2507)                                                         |
| DeepSeek AI | [DeepSeek V3.1](https://replicate.com/deepseek-ai/deepseek-v3.1)                                                                             |
| Moonshot AI | [Kimi K2 Thinking](https://replicate.com/moonshotai/kimi-k2-thinking)                                                                        |

Before paid inference, the runner uses `replicate.models.get` to resolve each
selected endpoint and archive its OpenAPI schema. It requires a string `prompt`
input and a supported output-cap field (`max_output_tokens`, `max_tokens`, or
`max_new_tokens`). It records the effective generation parameters, applying a zero
temperature where the schema permits it. Unsupported schemas or unavailable
endpoints produce explicit skipped rows rather than fabricated provider coverage.
This implementation was validated locally; account access and these endpoint
schemas have not been tested with authenticated live requests.

Set a model entry's optional `version` to request a pinned Replicate version.
Community aliases use the resolved version. Official aliases remain aliases unless
explicitly pinned; schema IDs and returned prediction versions are retained, but
an upstream proprietary model may still change. Treat those comparisons as dated
observations, not bitwise-reproducible runs.

The SDK's HTTP retry wrapper is prevented from resending a logical transport
request by memoizing its response promise. There are no hidden paid retries. A
network error after creation may leave a prediction running without a confirmed
ID; the runner stops and records that uncertainty. Prediction IDs, outputs,
parameters and returned timing metrics are saved; API headers are never saved.

API references: [Replicate JavaScript SDK](https://github.com/replicate/replicate-javascript),
[Replicate language-model collection](https://replicate.com/collections/language-models).

## Tasks and project conditions

| Asset                    | Format       | Main quality concerns                                       |
| ------------------------ | ------------ | ----------------------------------------------------------- |
| Utah Teapot              | `free`       | Silhouette, spout opening, handle hole, material mapping    |
| Stanford Bunny           | `free`       | Seated proportions, ears, surface quality, ceramic material |
| Animated Stanford Dragon | `free`       | Coiled anatomy, rig, breathing, head/tail motion, loop seam |
| Minecraft lantern        | `java_block` | Block bounds, restrained cube budget, 32×32 pixel art       |
| Creeper-style moss golem | `bedrock`    | Familiar silhouette, 64×64 atlas, diagonal walk cycle       |
| Hinged treasure chest    | `bedrock`    | Hollow interior, hinge/latch behavior, opening cycle        |

The Stanford subjects and teapot are authored studies, not imported canonical
datasets or numerical reconstruction benchmarks. No downloaded scan is needed.
Each brief specifies target, scale, geometry budget, material requirements and
acceptance criteria, resolving the Project skills' usual preference questions.

Every asset is crossed with:

- **empty**: a fresh project without elements;
- **scaffold**: the same named two-cube blockout from the case definition;
- **repair**: that blockout with its second cube displaced by `[6, 4, 0]`.

Every model gets the same four prompts: geometry/hierarchy, materials/UVs,
animation or structural refinement, and acceptance audit/export. Models may take
different actions, but prompts and budgets never vary by provider. Repetitions
start fresh; earlier outputs are never fed into later trials. Failures remain in
the dataset, and there is no automatic resume or successful-only rerun policy.

## Skills, subagents and the comparison track

`context.json` freezes the canonical Project `AGENTS.md`, `skills/**/*.md`, and
`.codex/agents/*.toml`. File hashes make changes visible even in dirty checkouts.
The primary agent receives `blockbench-use` automatically and can request domain
skills and reference files through `read_context`; unknown paths are rejected.
All models receive the same context snapshot for a run.

Project subagent definitions become callable same-model advisors. The current
physical-accuracy reviewer runs in its own conversation, sequentially, with only
tools annotated read-only. No nested delegation is allowed. Up to two reviews per
trial share the primary agent's prediction budget. These are Replicate inference
sessions guided by the Project definitions, not spawned Codex or Claude processes.
Advisor feedback is evidence for the modeling agent, not an independent grade.

The initial track uses **text observations and dedicated MCP tools**. A common
JSON action protocol works on endpoints without native function calling. Tool
schemas are retrieved on demand; invalid actions and tool errors consume budget
and remain in the trace. Full histories are preserved until the explicit common
context-character limit; overflow fails rather than silently trimming history.

Screenshots are saved for human review. Image bytes are **not** sent to models,
so neither primary agents nor advisors can claim visual inspection. Geometry,
UVs, material and animation data remain inspectable. Web browsing, external image
generation, arbitrary eval, generic UI actions, project switching, filesystem
exports and shared settings changes are excluded. Some Project skill/reviewer
workflows therefore have documented capability limits. Tool filtering is a
benchmark policy, not an OS security sandbox; use a dedicated local instance.
Do not compare these scores with a future vision/native-tool/eval-enabled track
without labeling the different capabilities.

## Results and quality review

`results/` is git-ignored: evidence stays on this machine and never enters the
repository (only `results/README.md` is tracked). The runner writes files but
never stages or commits, and it skips empty files. To keep or share a run,
archive its folder or copy it elsewhere. Do not force-add it. Coding agents are
told not to search or read `results/` unless asked about a specific file.

```text
results/<run-id>/
  manifest.json                 # configuration, environment and source hashes
  context.json                  # frozen Project guidance and subagent instructions
  plan.json                     # exact matrix and stage prompts
  models/<id>.json              # live schema/version/parameter preflight
  summary.json / summary.md     # every attempt, including skipped and failed
  trials/<case--condition--model--repetition>/
    trial.json / tools.json / capabilities-before.json
    events/00001.json ...       # ordered predictions, actions, errors and results
    initial.bbmodel / final.bbmodel
    stages/1.json / 1.bbmodel ...
    final-structure.json       # counts and animation metadata, not a quality score
    artifacts/                 # extracted MCP images and binary exports
    views/                     # screenshot references by angle and animation time
    result.json / review.json
```

The final model is read as a complete live `.bbmodel` resource with embedded
textures, not a truncated export preview. Standard evidence includes front, side,
top and perspective screenshots, plus 0%, 25%, 50%, 75% and 100% animation poses.
Five sampled poses are not proof of continuous motion quality: inspect playback
and loop transitions in Blockbench before grading. Runtime exports requested by
the agent are retained in tool-result events; binary exports are extracted.

`completed` means the agent finished all four stages and evidence collection; it
does not mean it met the brief. Reviewers should inspect partial/failed assets too.
Open each `review.json`, set `status` to `reviewed`, supply `reviewer` and ISO UTC
`reviewedAt`, score every applicable dimension from 0–4, and attach relative
evidence paths and notes to every criterion. Assess:

- silhouette and proportions;
- geometry and physical structure;
- texture and UV quality;
- compliance with the brief;
- delivery and editability;
- rig/motion and timing/loop quality for animated tasks.

Use 0 for missing/unusable, 1 for major defects, 2 for recognizable but substantially
flawed, 3 for meeting the brief with minor defects, and 4 for polished work. Prefer
blinded review and multiple human raters for published comparisons. Do not use the
model's own claims or tool success counts as visual scores.

```sh
bun run benchmark:report benchmarks/results/<run-id>
```

The report validates attributed reviews and produces `quality.json`/`quality.md`.
Unreviewed attempts stay null. Compare matched case/condition/repetition rows;
report completion and review coverage alongside quality. No overall ranking is
generated from unequal subsets. No real model-quality results are included yet.
