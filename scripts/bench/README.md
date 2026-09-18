# SWE-bench experiment tooling

These helpers are **not loaded or shipped with the Pi extension**. The [pilot report](../../experiments/astropy-12907-2026-09-17/README.md) preserves the original single-instance results and [old Docker adapter](../../experiments/astropy-12907-2026-09-17/docker-tools-v0.ts). The current adapter preserves native tool prompt metadata and allows reading known full-output files produced by its own shell tool. A new run with this adapter is a new experiment, not an exact replay of the pilot. Shell calls can still bundle editing/testing.

## Prospective 10-instance batch

```bash
python scripts/bench/batch.py prepare
python scripts/bench/batch.py run
python scripts/bench/progress.py
```

Preparation fixes ten seeded samples (excluding the pilot), alternating arm order, source hashes, prices, and budgets before inference. `run` executes two pairs concurrently, then performs official evaluation in a separate trusted Docker helper and produces a report. It skips existing arm directories rather than repeating paid runs; infrastructure failures and missing patches are retained, not replaced with another sample. Do not modify the frozen implementation during a batch.

The per-arm limits remain 40 requests, 900 seconds, and a $5 soft observed-cost ceiling. Both arms use GPT-6 Astra at medium thinking with the same Docker-backed tools; Jev 1.13.0 is pinned. No expected savings are assumed. See the [batch manifest/report](../../experiments/verified-10-20260917/README.md) for the full protocol.

Raw artifacts: `.jevcoder/bench/verified-10-20260917/`. Public summaries and patches: `experiments/verified-10-20260917/`. Use `python scripts/bench/batch.py report` to regenerate the report without model calls, or `evaluate` to rerun only the official evaluator on existing patches. The evaluator installs SWE-bench 4.1.0 through the verified Microsoft package-feed mirror used in this environment. No credentials or evaluator data are mounted into worker containers.

Requirements: Python 3.10+, Node/Pi dependencies (`npm install --ignore-scripts`), Docker with Linux containers, existing Pi Copilot authentication with GPT-6 Astra access, and a Jev key. No Python packages are required for the host runner or summarizer. The official evaluator uses `swebench==4.1.0` in a separate Python container.

## Prepare and generate

From the repository root:

```powershell
python scripts/bench/prepare.py
docker pull swebench/sweb.eval.x86_64.astropy_1776_astropy-12907:latest
$env:TYPESAFE_API_KEY = (Get-Content -Raw .\jev_key.txt).Trim()
python scripts/bench/run.py
```

The local runner also sets the environment from this repository's ignored `jev_key.txt` if `TYPESAFE_API_KEY` is unset; this convenience is **only in the experiment launcher**, not the extension. The variable is not passed into worker containers.

`prepare.py` fetches the first Verified row, asserts the expected instance ID, and saves an evaluator-only snapshot. It snapshots cached Pi pricing and the pinned Jev price; verify published prices before a new experiment. The source snapshot contains withheld patches/tests and must never be exposed to the agents.

`run.py` executes baseline then JevCoder, or accepts one arm (`baseline` / `jevcoder`). It refuses to overwrite an existing arm directory. Archive the existing `.jevcoder/bench/astropy-12907/` directory before a fresh repetition. Do not replace the checked-in September 17 report with a later run under the same name.

Each arm gets a fresh container and Pi session. Only the problem statement is sent as the task; no artifact directory is mounted in a worker. The tools retain Pi's read/edit/write/bash implementations through pluggable Docker operations. The snapshot's base commit and a clean worktree are checked before inference; prebuilt ignored build artifacts are retained. The generated diff, native JSON events, session, timings, and process outcome are captured. Worker containers are removed afterward.

The normal tools can access the container filesystem; this is container isolation, not a per-command proof of safety. Agent commands run without network or a host socket/mount. The host-side trusted backend necessarily invokes Docker itself. Shell timeout is enforced remotely, and the runner stops the worker on a whole-run timeout.

## Evaluate separately

Create a trusted evaluator with the raw artifact directory mounted at `/control` and the Docker socket mounted at `/var/run/docker.sock`. **Never give these mounts to the agents.** Install `swebench==4.1.0` (using your organization's verified package mirror if required). Run from `/control`, once per arm:

```bash
python -m swebench.harness.run_evaluation \
  --dataset_name /control/instances.json \
  --predictions_path /control/baseline/predictions.jsonl \
  --instance_ids astropy__astropy-12907 \
  --max_workers 1 --timeout 300 \
  --cache_level instance --clean false \
  --run_id jevcoder-comparison-baseline
```

Repeat with `jevcoder/predictions.jsonl` and run ID `jevcoder-comparison-jevcoder`. This uses the existing SWE-bench image and copies patches into fresh evaluation containers; the evaluator's `/control` mount is not passed to them. Evaluation reports go under `/control/logs/run_evaluation/`.

For a negative control, submit a patch that only adds an inert text file, with `model_name_or_path: "negative-control"`, using run ID `jevcoder-comparison-negative-control`. The source-code bug should remain unresolved. The retained run includes this control and the exact evaluator dependency versions. Remove the evaluator container after saving results; keep the cached base image.

## Summarize and test

```bash
python scripts/bench/summarize.py
python -m unittest discover -s tests/bench -v
npm test
npm run typecheck
```

The summarizer is intentionally specific to this retained sample/report path. It counts finalized assistant messages once, prices each request separately (including long-context tiers and cache writes), cross-checks Pi estimates, and adds Jev input cost. The audit extension records Jev usage before decision validation, so a malformed decision with returned usage is not silently omitted. Missing/aborted usage is marked unknown rather than free. Client logs cannot reveal completely hidden provider-internal attempts or replace billing receipts.

Pricing snapshots and raw artifacts stay under `.jevcoder/bench/astropy-12907/`; only summaries and model-generated patches are copied into `experiments/`. No reference patch or test patch is copied into public experiment artifacts.
