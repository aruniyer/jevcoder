# One SWE-bench Verified instance: Pi vs JevCoder

## Result

Instance: **`astropy__astropy-12907`** (first row of the Verified test split).
Issue: nested compound models produce incorrect separability matrices.

Both generated patches **resolved the instance under the official SWE-bench 4.1.0 harness**:

- FAIL_TO_PASS: **2/2 passed** for each patch.
- PASS_TO_PASS: **13/13 passed** for each patch.
- Negative control (a harmless added text file, no source fix): **0/2 FAIL_TO_PASS**, **13/13 PASS_TO_PASS**, unresolved.

| Metric | Plain Pi | Pi + `/jevcoder` |
| --- | ---: | ---: |
| GPT-6 Astra requests | 10 | 3 |
| Jev requests | 0 | 3 |
| Astra noncached input tokens | 30 | 9 |
| Astra cache-read tokens | 84,276 | 0 |
| Astra cache-write tokens | 24,025 | 13,791 |
| Astra output tokens | 1,507 | 878 |
| Reasoning tokens (already included in output) | 171 | 91 |
| Jev input tokens | 0 | 17,347 |
| Jev output tokens (free) | 0 | 163 |
| Estimated Astra cost | **$0.4602385** | **$0.2163775** |
| Estimated Jev cost | $0 | $0.000728574 |
| **Estimated total** | **$0.4602385** | **$0.217106074** |
| Agent-run wall time | **90.55 seconds** | **31.56 seconds** |

Observed cost reduction: **52.83%**. Observed wall-time reduction: **65.14%**.
Total model consumption for the two arms: approximately **$0.67734** at published rates.

These are consumption estimates, **not incremental charges on the user's Copilot bill**. Subscription allowances, Docker/evaluator infrastructure, and setup time are excluded. Agent wall time includes model calls, Jev, tool execution, and Pi startup/shutdown; it excludes container preparation and post-run official evaluation. All observed model/Jev requests returned usage, with no observed failed provider requests or missing usage. Completely unreported provider-internal attempts cannot be excluded from client logs.

## Important interpretation

**This is not yet evidence that strict Jev-controlled editing is cheaper.**

The actual Jev sequence was:

```text
tool:bash → tool:bash → finish
```

The first shell call inspected source/tests. The second generated regression tests, ran them against the original implementation, edited the implementation through a Python script, ran the focused tests again, and checked the diff. Jev **never selected `code_editing`**. Tool-name gating worked, but an unrestricted shell is a much coarser action than one read or one edit.

Plain Pi used 10 model turns and 9 tool calls: 5 shell calls and 4 edits. It also did more verification work: a broad modeling-suite run and an original-implementation comparison after finding failures. JevCoder only ran focused separability tests. Both were subsequently graded with identical official tests, but the agents' own verification effort was not equal.

Additional limitations:

- One public issue, one generation per arm, baseline first. No repeated trials, statistical significance, or protection against prior model familiarity with this issue.
- Both arms used the same Docker-backed standard tool implementations. The adapter was based on Pi's AgentTool wrappers and did **not** retain optional built-in system-prompt snippets/guidelines. This is not an exact stock local-tool Pi prompt. Preserve that metadata in a subsequent benchmark revision.
- Provider caching differed materially: baseline had cache reads, JevCoder had none. Fresh Pi sessions do not prove independently controlled remote cache state.
- The full modeling suite was not clean in the baseline run (36 failures/26 errors after the fix, 38 failures/26 errors with its fix reverted). The official task-specific evaluation passed for both patches; no claim is made that all Astropy tests pass in this image.

The next useful experiment is to preserve native tool prompt metadata and define whether a selected shell action may also edit code. Do not silently rerun this sample and replace these results; retain it as an exploratory measurement of v0.

## Protocol

- Dataset: `princeton-nlp/SWE-bench_Verified`, `test`, row offset 0.
- Repository: `astropy/astropy`.
- Base commit: `d16bfe05a744909de4b27f5875fe0d4ed41ce607`.
- Pi: `0.85.1`, provider `github-copilot`, model `gpt-6-astra`, thinking **medium**.
- Router: pinned **`jev-1.13.0`**.
- Tools: `read`, `bash`, `edit`, `write`, delegated through Pi's documented operations interfaces to separate Docker containers.
- Image: `swebench/sweb.eval.x86_64.astropy_1776_astropy-12907:latest`, immutable image ID recorded in `results.json`.
- Each worker: no network, no host bind mounts or Docker socket, 4 CPUs, 6 GB memory. Model/auth HTTP requests occurred in the host Pi process, outside the worker.
- Each repository reset to the exact base commit and checked clean before its run. Prebuilt ignored build artifacts/dependencies were retained.
- Fresh Pi sessions, same issue prompt (SHA-256 equality checked), no user/global context files, skills, or unrelated extensions.
- Both arms: at most 40 model requests, $5 soft observed-LLM-cost ceiling, 900-second wall-time limit; compaction stops the run. No budget was reached.
- Agents received the issue description, not `patch`, `test_patch`, FAIL_TO_PASS, PASS_TO_PASS, or another arm's transcript/patch.
- After both agents finished, exported patches were evaluated in fresh containers using the official harness and held-out test patch. No agent was called again after seeing evaluation results.

The first evaluator dependency install hit a Docker/PyPI TLS handshake error. Dependencies were installed through the configured Microsoft package-feed proxy without disabling TLS verification. This setup work was outside both timed/model-billed runs. The evaluator's installed package versions and setup logs are saved with the raw artifacts.

## Pricing and accounting

All Astra calls stayed below the 272K-input long-context threshold. Rates per million tokens:

- Input: $10; cached input: $1; cache write: $12.50; output: $50.
- Above 272K input per request: $20 / $2 / $25 / $75 respectively.
- Jev: $0.042 per million input tokens; output free.

Rates were snapshotted from Pi and checked against [GitHub pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing) and [TypeSafe pricing](https://docs.typesafe.ai/models). Per-response costs were independently recalculated and checked against Pi's reported estimates. Reasoning was not double-counted. Each final assistant usage record was counted once, not once per streaming update or duplicated audit entry.

## Artifacts

- [`results.json`](results.json): tokens, prices, costs, HTTP statuses, timings, hashes, grading, and limitations.
- [`baseline.patch`](baseline.patch), [`jevcoder.patch`](jevcoder.patch): exact generated patches.
- Private/local raw artifacts: `.jevcoder/bench/astropy-12907/` (Git-ignored), including native JSON event streams, Pi session files, per-arm run manifests, evaluation reports/logs, and the evaluator-only dataset snapshot.
- Runner/backend/accounting code: `scripts/bench/`. The exact old adapter is preserved as [`docker-tools-v0.ts`](docker-tools-v0.ts); the current shared adapter has since been corrected for the separate 10-instance batch.

Regenerate the summary from retained raw artifacts:

```bash
python scripts/bench/summarize.py
```
