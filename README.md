# JevCoder for Pi

A small **Pi coding-agent extension** that separates action selection from argument generation:

```text
/jevcoder <prompt>
        ↓
Jev selects the next action from the current conversation
        ↓
Your selected Pi model fills arguments / writes code
        ↓
Pi executes its existing tools and records the results
        ↓
Repeat until Jev selects finish
```

**No separate LLM client, authentication flow, tool implementations, or child agent.** Use your existing Pi models—including GitHub Copilot—and keep Pi's streaming UI, session history, tool backends, and permission extensions. The extension is TypeScript because that is Pi's native extension format.

## Supply your Jev key

Set **`TYPESAFE_API_KEY`** in the shell before launching Pi. This is the extension's only credential input; it does not load key files, `.env` files, or alternative key variables.

For our local experiments, load the Git-ignored `jev_key.txt` into the environment without printing it:

PowerShell (from this repository):

```powershell
$env:TYPESAFE_API_KEY = (Get-Content -Raw .\jev_key.txt).Trim()
pi
```

Bash:

```bash
export TYPESAFE_API_KEY="$(<jev_key.txt)"
pi
```

Other users can supply `TYPESAFE_API_KEY` through their shell or secret manager; no `jev_key.txt` file is required. If Pi is already running, restart it from the configured shell—`/reload` cannot import changes from a parent shell's environment.

## Use in this repository

The entry point is auto-discovered at `.pi/extensions/jevcoder.ts` once this project is trusted. After launching Pi with the key configured:

```text
/reload
/model
/jevcoder Explain the main entry point without changing files
```

Choose your preferred Copilot model in `/model`. If not already authenticated, use `/login` and select GitHub Copilot first. The extension never reads or stores your Copilot tokens.

Then try an editing task:

```text
/jevcoder Fix the parser's off-by-one error, then run the relevant tests
```

Cancel with **Escape** or **`/jevcoder-stop`**. Starting a second run while Pi is busy is rejected. After completion/cancellation, ordinary prompts use normal Pi execution again.

### Use from other repositories

Install this local package globally:

```powershell
pi install C:/Users/ariy.FAREAST/Documents/jevcoder
```

This points Pi at the existing files, without copying credentials. Restart Pi or `/reload`. Do not separately install both the shim and implementation as two extensions.

For a temporary test instead of installation:

```powershell
pi -e C:/Users/ariy.FAREAST/Documents/jevcoder/.pi/extensions/jevcoder.ts
```

Set `TYPESAFE_API_KEY` in the launching shell regardless of the extension's installation location or target workspace.

## Configuration

| Variable | Default |
| --- | --- |
| `TYPESAFE_API_KEY` | Required; surrounding whitespace is trimmed |
| `JEV_MODEL` | `jev-latest` |
| `JEV_ENDPOINT` | `https://api.typesafe.ai/v1/systemone` (HTTPS required) |
| `JEV_MAX_STEPS` | `20`; integer from 1 to 500 |

No `.env` loading. Select the **LLM and thinking level through Pi**, not through `LLM_MODEL` or Together configuration.

Pi integration targets **0.85.1**. JevCoder **0.2.0** uses the `stable-prefix-v1` strategy described below. The request-prefix guard supports `openai-completions`, `openai-responses`, `openai-codex-responses`, and `anthropic-messages`. This covers the Copilot models tested below. Other APIs and namespaced/deferred tool schemas are rejected rather than silently running without restrictions.

## Action contract

- Each active non-editing tool becomes a Jev choice (`tool:read`, `tool:bash`, custom tools, etc.). Tools that were disabled at command start are never added.
- **`code_editing`** authorizes only the available `edit`/`write` tools. The LLM uses accumulated context to produce one native Pi edit or write call. There is no nested editor loop.
- **`finish`** authorizes no tool execution and asks the Pi model for its final answer, verification summary, or clarification/blocker.
- **All initially active tool schemas stay visible and unchanged**, including on `finish`. Schema visibility is not permission to execute: the latest Jev decision and `tool_call` gate determine that.
- Only **one tool call per Jev decision** is admitted by the `tool_call` gate, even if a model emits multiple calls.
- If the selected action lacks enough context, the LLM may explain that in text instead of inventing arguments. The extension re-enters Pi's loop so Jev can reconsider.

Jev is called from the `context` hook. The independent `tool_call` gate enforces execution restrictions; no tool is recreated or invoked outside Pi's normal execution path. Provider tool choice stays `auto` throughout the run, even on `finish`, and OpenAI parallel tool calls are disabled. The LLM can explain missing context instead of fabricating arguments. Conflicting upstream tool-choice policies stop the run rather than being broadened.

## Cache-stable routing

The earlier implementation replaced `tools` with the chosen subset and replaced its transient control message each turn. Version 0.2.0 does neither:

1. **Stable schemas/system prefix.** Keep the complete native `tools` array unchanged: same definitions, order, and cache annotations. A fingerprint of the provider's tool/system prefix is checked and recorded on each request.
2. **Append-only model context.** Retain each injected decision at its original message boundary, then append the next decision after new observations. Earlier decisions explicitly apply only to their own next assistant response, not to later turns.
3. **Unchanged execution gate.** Unselected tools, multiple calls, and calls on `finish` remain blocked even though their schemas are visible.

```text
Request 1: system + all tools + task + decision 1
Request 2: system + all tools + task + decision 1 + response/results 1 + decision 2
Request 3: system + all tools + task + decision 1 + response/results 1 + decision 2 + response/results 2 + decision 3
```

Pi's `context` hook is non-persistent. JevCoder therefore keeps a run-local list of decision/message boundaries and reconstructs this append-only projection for each request. Control text/boundaries are saved in decision trace entries for inspection, but aren't inserted as permanent mode instructions in native session history. Normal prompts and new runs don't replay old controls.

A model change, active-tool change, tool-schema/system-prefix change, or rewrite of earlier conversation messages stops the run. JevCoder never restores old schemas over a revocation. Restart after intentional configuration changes or compaction.

Regression tests cover byte-identical serialized tool arrays and append-only inputs through Pi's actual OpenAI Responses converters (`read → edit → finish`), plus gates, retries, and lifecycle cleanup. **This removes identified sources of prefix churn; it does not guarantee cache hits or cost savings.** Provider thresholds, TTL, cache keys, request serialization, and later-loaded extensions can still affect caching. The retained [paired 10-instance comparison](experiments/verified-10-cache-v1-20260917/README.md) measured 87.4% cache-read input for JevCoder: both modes solved the same 8/10 cases, with 38% lower recorded-usage cost for the cache-stable version. See the qualifications below.

## Traces and limits

Jev decisions, probability distributions, confidence, usage, latency, blocks, and run outcomes are saved as **`jevcoder` custom entries in Pi's session**. Native assistant/tool messages already record execution and LLM usage. Jev token usage is in the custom entries, not added to Pi's LLM billing totals. Decision entries include the exact injected control and its native-message boundary; `cache_prefix` entries include the prefix fingerprint. These are diagnostic metadata, not permanent mode instructions.

- Each Jev request has a 30-second timeout and a 160,000-character request limit. This is not a token-window guarantee.
- Jev failures abort the run; no silent LLM-routing fallback or automatic Jev retries.
- Pi's existing provider retry behavior remains in effect, within the routing-step budget.
- **Compaction stops this run.** Compact outside JevCoder, then restart the task. This avoids applying tool restrictions to Pi's independent summarization requests. Seamless mid-run compaction is a follow-up improvement.
- There is no resume of an active Jev run after reload, session replacement, or exit. Existing edits are not rolled back.
- `finish` means the conversation ended, not that task correctness is independently established. Pi's CLI exit code is not a task-success grading API; inspect the result and trace.

## Safety and privacy

`/jevcoder` sends the current system instructions and textual conversation/tool observations to **TypeSafe/Jev**, in addition to the selected Pi model's normal context. Private thinking blocks, image bytes, provider signatures, and raw tool details are omitted from the Jev projection. The configured Jev key is redacted from its request body. This is **not a general-purpose secret scrubber**; previously read source, logs, and conversation text may contain private data.

The extension does not replace or directly invoke Pi tools. Existing tool-call permission handlers and remote/container backends remain in the execution path. **Pi does not provide approval prompts by default**—use your permission extension or an isolated workspace. JevCoder does not add approval dialogs of its own.

During a Jev run, direct file-path calls targeting `*_key.txt`, `.env*`, or `auth.json` are blocked. This is only a convenience guard: shell commands, search results, aliases, custom tools, and filesystem races are not a security boundary. Shell commands inherit Pi's environment and may access `TYPESAFE_API_KEY`. Shell actions may still edit files. Use Pi's tool allowlist for inspection-only tasks:

```powershell
pi --tools read,grep,find,ls
```

Other extensions can alter payloads and tool arguments too. The gate composes with ordinary permission policies, but arbitrary extension interactions are not universally validated. Extensions are trusted code, not a sandbox.

## Validation

```bash
npm install --ignore-scripts
npm test
npm run typecheck
```

Runtime loading through Pi needs no separate build. Tests use Node's TypeScript stripping (Node 24 recommended); they make no paid API calls. `npm pack --dry-run` verifies the package allowlist excludes credentials and traces.

## Layout

```text
.pi/extensions/jevcoder.ts   Auto-discovery/package entry point
extensions/jevcoder.ts      Slash commands, routing hooks, tool gate, lifecycle
extensions/jev.ts           Jev HTTP client, action mapping, routing-context helpers
extensions/cache.ts         Append-only controls and stable provider-prefix validation
tests/pi/                   Dependency-free tests and mocked extension harness
scripts/bench/              Optional Docker experiment runner and cost accounting
experiments/                Results, generated patches, and frozen benchmark source snapshots
```

## Latest 10-instance experiment

Only the latest cache-stable experiment is retained in this repository. The [paired comparison](experiments/verified-10-cache-v1-20260917/README.md) used the same fixed dataset snapshot with fresh generations in both arms. Both solved the same **8/10** cases. Total recorded-usage estimates, including failed cases and Jev, were **$4.76 for plain Pi vs $2.95 for JevCoder (38% lower, not halved)**. Hybrid cache-read input rose to **87.4%**, versus 91.1% for its fresh baseline.

One hybrid run ended after a Jev HTTP 400 with unknown usage. Much of the dollar difference came from that unresolved Astropy case; on the eight mutually solved cases alone, spending was **22.5% lower**. These are small-sample consumption estimates on a known development sample, not exact bills or a full-benchmark savings guarantee. All generated patches, source/configuration hashes, token/cost breakdowns, and official grading are retained in the report.

The retained batch includes a `source-snapshot/` directory whose inference-source hashes match its manifest. This archive preserves the code actually used even as the current implementation evolves. API keys, full private session traces, and evaluator-only dataset snapshots are deliberately excluded from Git.

## Next experiments

1. Diagnose the remaining router HTTP 400 on larger contexts without concealing or dropping failed runs.
2. Validate the cache-stable design on a larger, previously unused sample, with repeated trials and all costs/failures included. Use a new experiment ID rather than overwriting the retained results.
3. Measure routing failures separately from argument/edit failures and verification failures.
4. Consider `analyze`, confidence-gated fallback, bounded editor delegation, and compaction only after understanding the measured bottlenecks.

Jev contract: <https://docs.typesafe.ai/api>. Pi integration follows its documented extension hooks; no Pi source changes are required.
