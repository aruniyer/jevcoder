# SWE-bench experiment tooling

These helpers are **not loaded or shipped with the Pi extension**. The repository retains only the [latest cache-stable 10-instance comparison](../../experiments/verified-10-cache-v1-20260917/README.md), including its reports, patches, manifest, and exact inference-source snapshot.

## Read the retained results

- Public artifacts: `experiments/verified-10-cache-v1-20260917/`.
- Local/private raw artifacts: `.jevcoder/bench/verified-10-cache-v1-20260917/` (Git-ignored and not included in a clone).
- `python scripts/bench/progress.py` defaults to this batch and requires the local raw artifacts.
- `python scripts/bench/batch.py report` regenerates a report without model calls, but also requires its raw events and official evaluation reports. On a fresh clone, read the committed `results.json` instead.

The frozen `source-snapshot/` preserves the implementation actually used for the published result. Current helper code can evolve; do not overwrite that snapshot or silently replay paid runs.

## Run a new batch

Requirements: Python 3.10+, Node/Pi dependencies (`npm install --ignore-scripts`), Docker with Linux containers, existing Pi Copilot authentication with GPT-6 Astra access, and a Jev key.

Use a **new** experiment ID:

```powershell
$env:BENCH_BATCH_ID = "verified-10-new-experiment"
$env:TYPESAFE_API_KEY = (Get-Content -Raw .\jev_key.txt).Trim()
python scripts/bench/batch.py prepare
python scripts/bench/batch.py run
python scripts/bench/progress.py
```

Preparation fixes ten seeded samples, alternating arm order, source hashes, prices, and budgets before inference. It fetches evaluator-only dataset metadata and snapshots cached Pi pricing; check published rates before a new run. Optionally set `BENCH_SOURCE_BATCH` to another **locally available raw batch** to reuse its exact dataset snapshot. A fresh clone does not contain such snapshots, so normally leave it unset.

`run` executes two pairs concurrently, then performs official evaluation in a separate trusted Docker helper. Each arm uses GPT-6 Astra at medium thinking; Jev 1.13.0 is pinned for the hybrid. Limits are 40 requests, 900 seconds, and a $5 soft observed-LLM-cost ceiling per arm. The ceiling is checked between requests, not a hard billing limit.

Existing arm directories are skipped rather than replayed. Published experiment IDs cannot be reused for fresh preparation. Infrastructure failures and missing patches remain in the report; no sample is replaced based on its outcome. Do not modify the frozen implementation during a batch.

## Execution and evaluation boundaries

Each arm gets a fresh container and Pi session at the exact base commit. Only the issue description is supplied to the agent. No host credentials, Docker socket, evaluation snapshot, or other arm's artifacts are mounted in workers. Network is disabled in the worker, with 4 CPUs and 6 GB memory; model/auth HTTP requests occur in the host Pi process.

The tools retain Pi's native read/edit/write/bash implementations and prompt metadata through pluggable Docker operations. Known full-output files produced by the shell tool can be read locally; arbitrary host paths cannot. Shell commands can still bundle editing/testing, so this is container isolation, not a proof of fine-grained action semantics.

The trusted evaluator receives the Docker socket and private artifact directory. It installs `swebench==4.1.0` through the verified Microsoft package-feed mirror used in this environment. These mounts are never passed to agent workers. All generation precedes evaluation, and no agent is rerun after receiving grading feedback. Worker/evaluator containers are removed afterward; images remain cached.

Use `python scripts/bench/batch.py evaluate` to rerun only the official evaluator on existing predictions. No Python packages are required for the host runner or summarizer.

## Accounting and tests

The report counts each finalized assistant usage record once, applies cache/long-context rates per request, cross-checks Pi's cost estimates, and adds Jev input cost. Missing/aborted usage is flagged as unknown, not free. The audit extension records Jev usage before decision validation. Client logs cannot reveal completely hidden provider-internal attempts or replace billing receipts.

```bash
python -m unittest discover -s tests/bench -v
npm test
npm run typecheck
```

No keys, private transcripts, reference patches, or test patches are copied into the committed experiment artifacts. Metadata provenance fields in the retained manifest/results and frozen code are kept unchanged for auditability.
