"""Prospective, seeded 10-instance paired experiment. No outcome-based selection."""
import concurrent.futures
import datetime
import hashlib
import json
import os
from pathlib import Path
import random
import re
import shutil
import subprocess
import sys
import time
import urllib.request

from run import ROOT, docker, image_name, run_arm, source_hashes
from summarize import summarize_arm

BATCH = os.environ.get("BENCH_BATCH_ID", "verified-10-20260917")
SOURCE_BATCH = os.environ.get("BENCH_SOURCE_BATCH")
for name in (BATCH, SOURCE_BATCH):
    if name is not None and not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", name):
        raise ValueError("Batch IDs must be lowercase alphanumeric slugs")
if SOURCE_BATCH == BATCH:
    raise ValueError("Use a new batch ID; never overwrite the source experiment")
CONTROL = ROOT / ".jevcoder/bench" / BATCH
OUTPUT = ROOT / "experiments" / BATCH
SEED = 20260917
HELPER = "jevcoder-bench-evaluator-" + BATCH


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, indent=2), encoding="utf-8")
    temporary.replace(path)


def prepare():
    CONTROL.mkdir(parents=True, exist_ok=True)
    if (CONTROL / "manifest.json").exists():
        return json.loads((CONTROL / "manifest.json").read_text())
    offsets = sorted(random.Random(SEED).sample(range(1, 500), 10))
    save(CONTROL / "selection.json", {"seed": SEED, "offsets": offsets,
        "method": "sample 10 without replacement from Verified row offsets 1..499; exclude pilot offset 0; sort offsets"})
    rows, cases = [], []
    source_rows = None
    source_sha = None
    if SOURCE_BATCH:
        source_root = ROOT / ".jevcoder/bench" / SOURCE_BATCH
        previous = json.loads((source_root / "manifest.json").read_text())
        source_bytes = (source_root / "instances.json").read_bytes()
        source_sha = hashlib.sha256(source_bytes).hexdigest()
        assert source_sha == previous["dataset_snapshot_sha256"]
        assert previous["offsets"] == offsets
        source_rows = json.loads(source_bytes)
        assert len(source_rows) == 10
        assert [r["instance_id"] for r in source_rows] == [c["instance_id"] for c in previous["cases"]]
    for i, offset in enumerate(offsets):
        if source_rows is not None:
            row = source_rows[i]
        else:
            url = f"https://datasets-server.huggingface.co/rows?dataset=princeton-nlp%2FSWE-bench_Verified&config=default&split=test&offset={offset}&length=1"
            with urllib.request.urlopen(url, timeout=60) as response:
                payload = json.load(response)
            if payload.get("num_rows_total") != 500:
                raise RuntimeError("Dataset size changed; stop rather than alter the sample")
            row = payload["rows"][0]["row"]
        rows.append(row)
        save(CONTROL / "cases" / row["instance_id"] / "instance.json", row)
        order = ["baseline", "jevcoder"] if i % 2 == 0 else ["jevcoder", "baseline"]
        cases.append({"offset": offset, "instance_id": row["instance_id"], "repo": row["repo"],
                      "base_commit": row["base_commit"], "image": image_name(row), "order": order})
        print("Selected:", row["instance_id"], row["repo"], "order", order, flush=True)
    save(CONTROL / "instances.json", rows)
    script = """
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
const r = await ModelRuntime.create({ allowModelNetwork: false });
const m = r.getModel('github-copilot','gpt-6-astra');
if (!m) throw new Error('Model unavailable');
console.log(JSON.stringify({capturedAt:new Date().toISOString(),provider:m.provider,model:m.id,
api:m.api,costPerMillionTokens:m.cost,source:'https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing',
jev:{model:'jev-1.13.0',inputPerMillionTokens:0.042,outputPerMillionTokens:0,source:'https://docs.typesafe.ai/models'}},null,2));
"""
    result = subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, capture_output=True, check=True)
    pricing = json.loads(result.stdout)
    save(CONTROL / "pricing.json", pricing)
    version = json.loads((ROOT / "node_modules/@earendil-works/pi-coding-agent/package.json").read_text())["version"]
    manifest = {"batch": BATCH, "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "dataset": "princeton-nlp/SWE-bench_Verified", "split": "test", "seed": SEED,
                "offsets": offsets, "pilot_excluded": "astropy__astropy-12907", "cases": cases,
                "dataset_snapshot_sha256": hashlib.sha256((CONTROL / "instances.json").read_bytes()).hexdigest(),
                "source_batch": SOURCE_BATCH, "source_dataset_snapshot_sha256": source_sha,
                "extension_version": json.loads((ROOT / "package.json").read_text())["version"],
                "cache_strategy": "stable-prefix-v1" if (ROOT / "extensions/cache.ts").exists() else "legacy-filtered-tools",
                "implementation_sha256": source_hashes(), "pi_version": version, "harness_version": "4.1.0",
                "model": "github-copilot/gpt-6-astra", "thinking": "medium", "pair_concurrency": 2,
                "max_requests_per_arm": 40, "wall_time_limit_seconds_per_arm": 900,
                "soft_llm_cost_limit_usd_per_arm": 5, "shell_bundling": "allowed in both arms",
                "native_tool_prompt_metadata": "preserved", "worker_network": "none", "worker_cpus": 4, "worker_memory": "6g",
                "primary_metrics": ["total estimated cost including all failed runs and Jev", "resolved / 10 per arm", "total cost / resolved issues"],
                "no_replacement_or_paid_retries": True}
    save(CONTROL / "manifest.json", manifest)
    save(OUTPUT / "manifest.json", manifest)
    return manifest


def run_case(case, rows, hashes):
    root = CONTROL / "cases" / case["instance_id"]
    try:
        if docker("image", "inspect", case["image"], check=False).returncode:
            with (root / "image-pull.log").open("wb") as out:
                result = subprocess.run(["docker", "pull", case["image"]], stdout=out, stderr=subprocess.STDOUT, timeout=900)
            if result.returncode:
                raise RuntimeError("Image pull failed; see image-pull.log")
        for arm in case["order"]:
            if (root / arm).exists():
                print(case["instance_id"], arm, "retained; no paid replay", flush=True)
                continue
            run_arm(arm, root, rows[case["instance_id"]], expected_hashes=hashes)
    except Exception as error:
        save(root / "infrastructure-error.json", {"error": str(error)})
        print(case["instance_id"], "INFRASTRUCTURE ERROR:", error, flush=True)
    return case["instance_id"]


def evaluate(manifest):
    for arm in ("baseline", "jevcoder"):
        predictions = []
        for case in manifest["cases"]:
            file = CONTROL / "cases" / case["instance_id"] / arm / "predictions.jsonl"
            predictions.append(json.loads(file.read_text(encoding="utf-8")) if file.exists() else {
                "instance_id": case["instance_id"], "model_name_or_path": arm, "model_patch": ""})
        (CONTROL / f"predictions-{arm}.jsonl").write_text("".join(json.dumps(p) + "\n" for p in predictions), encoding="utf-8")
    try:
        docker("run", "-d", "--name", HELPER,
               "--mount", f"type=bind,source={CONTROL},target=/control",
               "--mount", "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
               "-w", "/control", "python:3.10-slim", "sleep", "infinity")
        with (CONTROL / "harness-install.log").open("wb") as out:
            result = subprocess.run(["docker", "exec", HELPER, "pip", "install", "--index-url",
                "https://packagefeedproxy.microsoft.io/pypi/simple/", "swebench==4.1.0"], stdout=out, stderr=subprocess.STDOUT, timeout=600)
        if result.returncode:
            raise RuntimeError("Evaluator install failed; see harness-install.log")
        (CONTROL / "evaluator-requirements.txt").write_bytes(docker("exec", HELPER, "pip", "freeze").stdout)
        for arm in ("baseline", "jevcoder"):
            print("Official evaluation:", arm, flush=True)
            with (CONTROL / f"evaluation-{arm}.log").open("wb") as out:
                result = subprocess.run(["docker", "exec", HELPER, "python", "-m", "swebench.harness.run_evaluation",
                    "--dataset_name", "/control/instances.json", "--predictions_path", f"/control/predictions-{arm}.jsonl",
                    "--max_workers", "2", "--timeout", "600", "--cache_level", "instance", "--clean", "false",
                    "--run_id", f"{BATCH}-{arm}"], stdout=out, stderr=subprocess.STDOUT, timeout=3700)
            save(CONTROL / f"evaluation-{arm}-status.json", {"exit_code": result.returncode})
    finally:
        docker("rm", "-f", HELPER, check=False)


def report(manifest):
    pricing = json.loads((CONTROL / "pricing.json").read_text())
    runs = []
    for case in manifest["cases"]:
        root = CONTROL / "cases" / case["instance_id"]
        pair = []
        for arm in ("baseline", "jevcoder"):
            grading = CONTROL / "logs/run_evaluation" / f"{BATCH}-{arm}" / arm / case["instance_id"] / "report.json"
            run = summarize_arm(root, arm, pricing, case["instance_id"], grading)
            run["order_position"] = case["order"].index(arm) + 1
            pair.append(run)
            patch = root / arm / "prediction.patch"
            if patch.exists():
                destination = OUTPUT / "patches" / case["instance_id"]
                destination.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(patch, destination / f"{arm}.patch")
        if all(r["prompt_sha256"] is not None for r in pair):
            assert pair[0]["prompt_sha256"] == pair[1]["prompt_sha256"]
        if all(r["image_id"] is not None for r in pair):
            assert pair[0]["image_id"] == pair[1]["image_id"]
        runs.extend(pair)
    totals = {}
    for arm in ("baseline", "jevcoder"):
        selected = [r for r in runs if r["arm"] == arm]
        cost = sum(r["estimated_total_cost_usd"] for r in selected)
        resolved = sum(r["resolved"] is True for r in selected)
        token_keys = ("input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens")
        tokens = {k: sum(r["llm_tokens"].get(k, 0) for r in selected) for k in token_keys}
        input_total = sum(tokens[k] for k in ("input", "cacheRead", "cacheWrite"))
        totals[arm] = {"instances": len(selected), "evaluated": sum(r["resolved"] is not None for r in selected),
                       "llm_tokens": tokens, "cache_read_fraction_of_input": tokens["cacheRead"] / input_total if input_total else None,
                       "jev_input_tokens": sum(r["jev_tokens"]["input"] for r in selected),
                       "jev_output_tokens": sum(r["jev_tokens"]["output"] for r in selected),
                       "cost_basis": "reported usage only; unreported error/cancelled usage remains unknown", 
                       "resolved": resolved, "llm_requests": sum(r["llm_requests"] for r in selected),
                       "jev_requests": sum(r["jev_requests"] for r in selected),
                       "llm_cost_usd": sum(r["llm_cost_usd"] for r in selected),
                       "jev_cost_usd": sum(r["jev_cost_usd"] for r in selected),
                       "estimated_total_cost_usd": cost, "cost_per_resolved_usd": cost / resolved if resolved else None,
                       "summed_agent_seconds": sum(r["elapsed_seconds"] or 0 for r in selected),
                       "runs_with_unaccounted_usage": sum(bool(r["unaccounted_usage"]) for r in selected)}
    b, j = totals["baseline"], totals["jevcoder"]
    ratio = j["estimated_total_cost_usd"] / b["estimated_total_cost_usd"] if b["estimated_total_cost_usd"] else None
    complete = b["evaluated"] == j["evaluated"] == 10
    known = b["runs_with_unaccounted_usage"] == j["runs_with_unaccounted_usage"] == 0
    result = {"manifest": manifest, "pricing": pricing, "runs": runs, "totals": totals,
              "complete_official_evaluation": complete, "observed_usage_complete": known,
              "inference_replayed_for_this_report": False,
              "report_implementation_sha256": {f: hashlib.sha256((ROOT / f).read_bytes()).hexdigest() for f in
                  ("scripts/bench/batch.py", "scripts/bench/summarize.py")},
              "paired_outcomes": {"both_resolved": sum(all(r["resolved"] is True for r in runs if r["instance_id"] == c["instance_id"]) for c in manifest["cases"]),
                                  "both_unresolved": sum(all(r["resolved"] is False for r in runs if r["instance_id"] == c["instance_id"]) for c in manifest["cases"])},
              "cost_ratio_jevcoder_over_baseline": ratio, "estimated_cost_reduction_percent": (1 - ratio) * 100 if ratio is not None else None,
              "halved_cost_at_no_lower_solve_count": bool(complete and known and ratio is not None and ratio <= 0.5 and j["resolved"] >= b["resolved"]),
              "caveats": ["Ten seeded examples, one generation per arm; not a full benchmark or statistical proof.",
                          "Shell bundling remains allowed; inspect action traces before attributing savings to fine-grained routing.",
                          "Costs include failed runs and Jev, but exclude infrastructure and subscription allowances; not billing receipts.",
                          "Missing usage is unknown, not free; completely hidden provider-internal attempts cannot be observed.",
                          "Provider cache state is not controlled; arm order alternates across cases.",
                          "JevCoder retains its v0 routing-context limit; budget/context failures count against its solve rate.",
                          "See the frozen manifest for the implementation/cache strategy; compare against the fresh baseline in this batch, not only previous runs."]}
    save(OUTPUT / "results.json", result)
    save(CONTROL / "results.json", result)
    print(json.dumps({"totals": totals, "cost_reduction_percent": result["estimated_cost_reduction_percent"],
                      "complete": complete, "usage_complete": known}, indent=2), flush=True)
    return result


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "run"
    manifest = prepare()
    if mode == "prepare":
        return
    if mode == "report":
        report(manifest); return
    if mode not in ("run", "evaluate"):
        raise SystemExit("Use prepare, run, evaluate, or report")
    if mode == "run":
        if source_hashes() != manifest["implementation_sha256"]:
            raise RuntimeError("Source changed since preregistration; do not mix implementations within a batch")
        rows = {r["instance_id"]: r for r in json.loads((CONTROL / "instances.json").read_text(encoding="utf-8"))}
        done = []
        save(CONTROL / "status.json", {"phase": "generation", "completed_pairs": done})
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(run_case, case, rows, manifest["implementation_sha256"]) for case in manifest["cases"]]
            for future in concurrent.futures.as_completed(futures):
                done.append(future.result())
                save(CONTROL / "status.json", {"phase": "generation", "completed_pairs": done})
    save(CONTROL / "status.json", {"phase": "evaluation"})
    evaluate(manifest)
    report(manifest)
    save(CONTROL / "status.json", {"phase": "complete"})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        save(CONTROL / "driver-error.json", {"error": str(error), "at": datetime.datetime.now(datetime.timezone.utc).isoformat()})
        raise
