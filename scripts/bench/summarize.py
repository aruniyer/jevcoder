"""Aggregate finalized usage once, cross-check Pi costs, and attach official grading."""
import json
import math

TOKEN_KEYS = ("input", "output", "cacheRead", "cacheWrite")


def model_cost(usage, prices):
    if any(type(usage.get(k)) not in (int, float) or not math.isfinite(usage[k]) or usage[k] < 0 for k in TOKEN_KEYS):
        raise ValueError("Missing or invalid token usage")
    prompt_tokens = sum(usage[k] for k in ("input", "cacheRead", "cacheWrite"))
    tier = prices
    for candidate in sorted(prices.get("tiers", []), key=lambda t: t["inputTokensAbove"]):
        if prompt_tokens > candidate["inputTokensAbove"]:
            tier = candidate
    # Reasoning tokens are already included in output, not an additional charge.
    return sum(usage[k] * tier[k] for k in TOKEN_KEYS) / 1_000_000


def summarize_arm(root, arm, pricing, instance_id, report_path=None):
    directory = root / arm
    events, parse_errors = [], []
    event_file = directory / "events.jsonl"
    if event_file.exists():
        for number, line in enumerate(event_file.read_text(encoding="utf-8").splitlines(), 1):
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                parse_errors.append({"kind": "trace", "line": number, "reason": "incomplete_or_invalid_json"})
    audit = [e["entry"]["data"] for e in events if e["type"] == "entry_appended" and e["entry"].get("customType") == "benchmark"]
    messages = [e["message"] for e in events if e["type"] == "message_end" and e["message"].get("role") == "assistant"]
    jev = [e["data"] for e in audit if e["kind"] == "jev_request_end"]
    totals = {k: 0 for k in (*TOKEN_KEYS, "reasoning", "totalTokens")}
    unknown = parse_errors.copy()
    costs = []
    for i, message in enumerate(messages, 1):
        usage = message.get("usage")
        if not usage or not sum(usage.get(k, 0) for k in TOKEN_KEYS):
            unknown.append({"kind": "llm", "response": i, "reason": "no_reported_usage"})
            continue
        amount = model_cost(usage, pricing["costPerMillionTokens"])
        assert math.isclose(amount, usage["cost"]["total"], abs_tol=1e-9), "Pi price mismatch"
        costs.append(amount)
        for key in totals:
            totals[key] += usage.get(key, 0)
    jev_input = jev_output = 0
    for call in jev:
        usage = call.get("usage")
        if not usage or not isinstance(usage.get("input_tokens"), int):
            unknown.append({"kind": "jev", "id": call["id"], "reason": "no_reported_usage"})
        else:
            jev_input += usage["input_tokens"]
            jev_output += usage.get("output_tokens", 0)
    starts = [e for e in audit if e["kind"] == "jev_request_start"]
    ended = {e["id"] for e in jev}
    unknown += [{"kind": "jev", "id": e["data"]["id"], "reason": "no_completion_record"} for e in starts if e["data"]["id"] not in ended]
    llm_starts = sum(e["kind"] == "llm_request_start" for e in audit)
    if llm_starts != len(messages):
        unknown.append({"kind": "llm", "reason": "request_response_count_mismatch", "starts": llm_starts, "responses": len(messages)})
    statuses = [e["data"]["status"] for e in audit if e["kind"] == "llm_response"]
    if any(s < 200 or s >= 300 for s in statuses):
        unknown.append({"kind": "llm", "reason": "non_success_http_responses", "statuses": statuses})
    llm_cost = sum(costs)
    jev_cost = jev_input * pricing["jev"]["inputPerMillionTokens"] / 1_000_000
    evaluation = json.loads(report_path.read_text())[instance_id] if report_path is not None and report_path.exists() else {"resolved": None, "status": "not_evaluated"}
    run_file = directory / "run.json"
    run = json.loads(run_file.read_text()) if run_file.exists() else {"status": "not_started"}
    return {
        "arm": arm, "resolved": evaluation["resolved"], "evaluation": evaluation,
        "instance_id": instance_id, "generation_status": run.get("status", "completed"),
        "generation_error": run.get("error"), "exit_code": run.get("exit_code"), "timed_out": run.get("timed_out", False),
        "budget_stops": [e["data"] for e in audit if e["kind"] == "budget_stop"],
        "elapsed_seconds": run.get("elapsed_seconds"), "llm_requests": llm_starts,
        "llm_http_statuses": statuses, "llm_tokens": totals,
        "llm_cost_usd": llm_cost, "jev_requests": len(starts),
        "jev_tokens": {"input": jev_input, "output": jev_output},
        "jev_cost_usd": jev_cost, "estimated_total_cost_usd": llm_cost + jev_cost,
        "jev_latency_ms": sum(e["elapsedMs"] for e in jev),
        "unaccounted_usage": unknown,
        "tool_calls": [e["toolName"] for e in events if e["type"] == "tool_execution_start"],
        "jev_actions": [e["entry"]["data"]["data"]["action"] for e in events if e["type"] == "entry_appended" and e["entry"].get("customType") == "jevcoder" and e["entry"]["data"].get("kind") == "decision"],
        "patch_sha256": run.get("patch_sha256"), "prompt_sha256": run.get("prompt_sha256"), "image_id": run.get("image_id"),
    }


if __name__ == "__main__":
    raise SystemExit("Use python scripts/bench/batch.py report to summarize a batch.")
