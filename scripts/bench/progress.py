"""Inspect local batch progress without exposing prompts, keys, or model reasoning."""
import json
import os
from pathlib import Path

root = Path(__file__).resolve().parents[2] / ".jevcoder/bench" / os.environ.get("BENCH_BATCH_ID", "verified-10-cache-v1-20260917")
manifest = json.loads((root / "manifest.json").read_text())
total = 0.0
for case in manifest["cases"]:
    parts = []
    for arm in ("baseline", "jevcoder"):
        directory = root / "cases" / case["instance_id"] / arm
        run_file = directory / "run.json"
        state = json.loads(run_file.read_text()) if run_file.exists() else {}
        cost, requests, jev_input = 0.0, 0, 0
        events = directory / "events.jsonl"
        if events.exists():
            for line in events.read_text(encoding="utf-8").splitlines():
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("type") == "message_end" and event.get("message", {}).get("role") == "assistant":
                    requests += 1
                    cost += event["message"].get("usage", {}).get("cost", {}).get("total", 0)
                if event.get("type") == "entry_appended" and event["entry"].get("customType") == "benchmark":
                    data = event["entry"]["data"]
                    if data.get("kind") == "jev_request_end":
                        jev_input += (data["data"].get("usage") or {}).get("input_tokens", 0)
        cost += jev_input * 0.042 / 1_000_000
        total += cost
        status = state.get("status", "running" if state.get("inference_started") else "pending")
        parts.append(f"{arm}={status}, responses={requests}, observed=${cost:.4f}")
    print(case["instance_id"], " | ".join(parts))
print(f"Observed consumption so far: ${total:.4f} (partial; unreported usage is not included)")
status = root / "status.json"
if status.exists():
    print(status.read_text())
error = root / "driver-error.json"
if error.exists():
    print("DRIVER ERROR:", error.read_text())
