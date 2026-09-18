# Prospective 10-instance SWE-bench Verified comparison

**Status: complete. The cost-halving hypothesis did not hold.** All 20 generations and official evaluations completed; both arms resolved the same **8/10** cases. The Jev arm cost **64.37% more from reported usage**, while using **30.43% fewer LLM requests** and **33.44% less summed agent time**. There are unreported error/cancelled requests in three hybrid runs, so its cost is an observed-usage estimate rather than an exact billed total.

## Aggregate results

| Metric | Plain Pi | Pi + `/jevcoder` |
| --- | ---: | ---: |
| Officially resolved | **8/10** | **8/10** |
| Astra request starts | 138 | 96 |
| Jev requests | 0 | 97 |
| Estimated Astra cost from reported usage | $5.137642 | $8.409861 |
| Estimated Jev cost from reported usage | $0 | $0.03477264 |
| **Total recorded-usage cost** | **$5.137642** | **$8.44463364** |
| Total spending / resolved issue (includes failures) | $0.642205 | $1.055579 |
| Summed agent wall time | 1,193.24 s | 794.25 s |
| Input tokens served as cache reads | 91.95% | 1.56% |
| Runs with unknown usage | 0 | 3 |

Combined recorded model consumption: **$13.58227564**. Jev itself accounts for only **$0.03477**, about **0.41%** of the hybrid total. All failures are included in totals; no case was replaced, excluded, or regenerated after grading. "Completed" in a process manifest does not mean the task was solved: correctness comes from the official evaluator.

### Per-instance results

Costs include Jev where applicable. An asterisk marks an arm with unknown error/cancelled-request usage; the displayed amount includes only returned usage.

| Instance | Plain Pi cost | JevCoder cost | Pi / Jev solved | Astra requests Pi / Jev |
| --- | ---: | ---: | --- | ---: |
| astropy__astropy-13398 | $2.03405 | $2.58118* | No / No | 30 / 13 |
| django__django-11964 | $0.26111 | $0.59864 | Yes / Yes | 12 / 10 |
| django__django-13590 | $0.25082 | $0.18637 | Yes / Yes | 11 / 4 |
| django__django-13925 | $0.25212 | $0.91906 | Yes / Yes | 10 / 14 |
| django__django-14539 | $0.30362 | $0.42419 | Yes / Yes | 9 / 7 |
| matplotlib__matplotlib-26342 | $0.26201 | $1.46165* | Yes / Yes | 10 / 12 |
| pydata__xarray-6992 | $0.26984 | $0.40513* | No / No | 10 / 8 |
| pytest-dev__pytest-5809 | $0.17113 | $0.25018 | Yes / Yes | 9 / 7 |
| sphinx-doc__sphinx-10673 | $1.09743 | $0.60065 | Yes / Yes | 24 / 6 |
| sympy__sympy-16450 | $0.23551 | $1.01760 | Yes / Yes | 13 / 15 |

JevCoder was cheaper on **2/10**, more expensive on **8/10**, with identical per-instance solve outcomes. All 20 patches applied successfully in official evaluation. Unresolved Astropy and Xarray candidates had test failures; they were not silently counted as successes based on the agent's final text.

## What the accounting shows

Astra rates for these requests were $10/M input, $1/M cache read, $12.50/M cache write, $50/M output. Long-context pricing was accounted for per request but not triggered in this batch.

| Astra tokens / cost component | Plain Pi | JevCoder |
| --- | ---: | ---: |
| Noncached input tokens | 414 | 282 |
| Cache-read tokens | 1,876,752 | 9,841 |
| Cache-write tokens | 163,948 | 621,960 |
| Output tokens | 24,148 | 12,454 |
| Reasoning tokens (included in output) | 4,720 | 1,899 |
| Input cost | $0.004140 | $0.002820 |
| Cache-read cost | $1.876752 | $0.009841 |
| Cache-write cost | $2.049350 | $7.774500 |
| Output cost | $1.207400 | $0.622700 |

The hybrid used fewer total input/output tokens, but **cache writes dominated its bill estimate**. A cache-write token costs 12.5 times a cache-read token at this tier. This more than offset the lower output and request counts.

**Working explanation, not a controlled causal finding:** JevCoder changes the offered tool schema set at each turn and injects a transient routing instruction. That can destabilize provider prompt caching. The cache-token measurements are direct evidence; attributing the entire difference to a particular payload change needs a separate experiment.

A sensible next iteration is to preserve the stable system/tool prefix, append routing control in a cache-friendly way, and enforce allowed execution through the existing gate and compatible tool-choice controls. Then run a new versioned paired experiment. Do not revise this batch into a positive savings story after changing the implementation.

### Error and action accounting

- The Astropy hybrid run ended after a **Jev HTTP 400** with no usage returned. Pi emitted an additional synthetic zero-usage abort message without a corresponding Astra request; the conservative report flags this mismatch rather than manufacturing a billed request.
- Matplotlib and Xarray hybrid runs each encountered a **503 upstream-provider error**. Pi's normal retry recovered and continued. Both failed calls lack token usage and remain marked unknown. No paid full-run replay was performed.
- Astra request counts are request-start hook events, not the number of assistant messages; there are 97 assistant messages for the hybrid but 96 request starts because of the synthetic abort.
- Of 97 Jev requests, 96 returned valid decisions: **39 bash**, **29 read**, **19 code_editing**, **9 finish**. Unlike the pilot, editing mode was exercised. Shell writes still occurred in five hybrid runs (Astropy, Django 13590 and 14539, Matplotlib, Xarray), so this is not strict fine-grained edit routing.
- No request-count, $5 soft-cost, or whole-run wall-time limit was reached. The Astropy router failure is retained, and its partial patch was graded without another agent run.

All experiment/evaluation containers were removed. Downloaded SWE-bench images remain cached; unrelated Docker containers/images were not pruned.

Machine-readable costs, unknown-usage flags, per-test official grading, pricing, and hashes are in [`results.json`](results.json). All 20 generated patches are under [`patches/`](patches/).

## Fixed selection

Seed **20260917**; sample 10 rows without replacement from Verified test offsets 1–499, excluding the pilot at offset 0. Selected offsets: **3, 67, 122, 134, 159, 285, 316, 336, 386, 454**. The manifest was saved before any model calls. No replacement, outcome-based filtering, or paid retries of completed runs.

| Instance | First arm |
| --- | --- |
| astropy__astropy-13398 | Plain Pi |
| django__django-11964 | JevCoder |
| django__django-13590 | Plain Pi |
| django__django-13925 | JevCoder |
| django__django-14539 | Plain Pi |
| matplotlib__matplotlib-26342 | JevCoder |
| pydata__xarray-6992 | Plain Pi |
| pytest-dev__pytest-5809 | JevCoder |
| sphinx-doc__sphinx-10673 | Plain Pi |
| sympy__sympy-16450 | JevCoder |

Full base commits, source hashes, sample method, and settings: [`manifest.json`](manifest.json).

## Protocol

- Copilot **GPT-6 Astra**, thinking **medium**, in both arms.
- **Jev 1.13.0** pinned for routing.
- Fresh Pi sessions and fresh Docker containers at each instance's exact base commit.
- The same issue prompt and `read`, `bash`, `edit`, `write` tool schemas/implementations in both arms, with the Jev-specific routing restrictions only in the hybrid arm.
- Native tool prompt snippets/guidelines are now preserved by the shared adapter. This intentionally corrects the pilot's adapter omission; absolute costs should not be compared directly with that pilot.
- A model can read only the repository/container or known temporary output files generated by its own shell tool—not arbitrary host paths. No Docker socket, host credentials, evaluation snapshot, or other arm's artifacts are mounted in workers.
- Network disabled in each worker; model/auth HTTP requests occur in the host Pi process.
- 4 CPUs / 6 GB per worker; two pairs run concurrently, with sequential arms within each pair and alternating arm order.
- Per-arm limits: 40 model requests, 900 seconds, $5 soft observed-LLM-cost cap. The cap is checked between requests, so it is not a hard billing ceiling.
- Jev's existing 160,000-character routing-request limit remains part of v0; hitting it counts against the hybrid result. Compaction stops both modes in this experiment.
- Shell bundling remains allowed in both arms and will be reported. This is a comparison of the current implementation, not a guarantee that the `code_editing` branch performs every edit.
- Agents get the public issue description, not gold/test patches or evaluator test lists. All generation precedes official evaluation; no agent is rerun after evaluator feedback.
- Official **SWE-bench harness 4.1.0** evaluates each candidate on held-out tests in fresh containers. Missing/failed runs remain in the 10-instance denominator and their observed spending remains in the cost total.

## Preregistered interpretation

Primary metrics:

1. **Aggregate estimated cost** across all 10 instances, including failed runs and Jev requests.
2. **Resolved / 10** for each arm, plus per-instance outcomes.
3. **Aggregate spending / resolved issues**, which includes spending on failures.

A halving of aggregate cost with a lower solve rate is not automatically a saving at equivalent quality. The report separately checks whether cost is at most half **and** the Jev arm has no lower solve count. Even a positive result is a small-sample signal, not a full-benchmark or statistical proof.

Costs use reported token categories and snapshotted per-million-token pricing. Reasoning is included in output, not charged twice. Missing usage is marked unknown rather than free. Subscription allowances, invoice adjustments, container infrastructure, and setup time are excluded. Completely hidden provider-internal attempts cannot be observed. Remote cache state is not independently controlled; cache tokens and execution order are retained.

## Local progress and artifacts

```bash
python scripts/bench/progress.py
```

Private/raw artifact root (Git-ignored): `.jevcoder/bench/verified-10-20260917/`.

- `selection.json`, `manifest.json`, `pricing.json`: prospective sample/configuration.
- `source-snapshot/`: copies of the exact benchmark/extension implementation.
- `cases/<instance>/<arm>/`: prompts, native event/session logs, run manifests, generated patches.
- `instances.json`: **evaluation-only** dataset snapshot; never expose to agents.
- `logs/run_evaluation/`: official reports and logs after generation.
- `driver.log`, `status.json`: orchestration progress.

The runner is `scripts/bench/batch.py`; it refuses to replay existing arm directories. `python scripts/bench/batch.py report` regenerates the report from existing artifacts without model calls. The original pilot remains separately preserved, including its old Docker adapter.
