import unittest
import json
import tempfile
from pathlib import Path
from scripts.bench.summarize import model_cost, summarize_arm

PRICES = {"input": 10, "output": 50, "cacheRead": 1, "cacheWrite": 12.5,
          "tiers": [{"inputTokensAbove": 272000, "input": 20, "output": 75, "cacheRead": 2, "cacheWrite": 25}]}


class CostTests(unittest.TestCase):
    def test_distinct_token_categories_and_reasoning_not_double_counted(self):
        usage = {"input": 1000, "output": 2000, "cacheRead": 3000, "cacheWrite": 4000, "reasoning": 1500}
        self.assertAlmostEqual(model_cost(usage, PRICES), 0.01 + 0.1 + 0.003 + 0.05)

    def test_long_context_threshold_includes_cached_input(self):
        normal = {"input": 1000, "output": 100, "cacheRead": 270000, "cacheWrite": 1000}
        self.assertAlmostEqual(model_cost(normal, PRICES), (10000 + 5000 + 270000 + 12500) / 1e6)
        large = {**normal, "cacheRead": 270001}
        self.assertAlmostEqual(model_cost(large, PRICES), (20000 + 7500 + 540002 + 25000) / 1e6)

    def test_tiers_are_per_request_not_cumulative_run_tokens(self):
        usage = {"input": 200000, "output": 0, "cacheRead": 0, "cacheWrite": 0}
        self.assertEqual(model_cost(usage, PRICES) + model_cost(usage, PRICES), 4)

    def test_missing_invalid_usage_is_not_free(self):
        for usage in [{}, {"input": -1, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                      {"input": float("nan"), "output": 0, "cacheRead": 0, "cacheWrite": 0}]:
            with self.assertRaises(ValueError):
                model_cost(usage, PRICES)


class SummaryTests(unittest.TestCase):
    def test_missing_run_remains_unevaluated(self):
        with tempfile.TemporaryDirectory() as directory:
            result = summarize_arm(Path(directory), "baseline", {"costPerMillionTokens": PRICES, "jev": {"inputPerMillionTokens": 0.042}}, "example__repo-1")
            self.assertIsNone(result["resolved"])
            self.assertEqual(result["generation_status"], "not_started")
            self.assertEqual(result["llm_requests"], 0)

    def test_partial_trace_and_missing_usage_are_flagged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            arm = root / "jevcoder"
            arm.mkdir()
            records = [
                {"type": "entry_appended", "entry": {"customType": "benchmark", "data": {"kind": "llm_request_start", "data": {"request": 1}}}},
                {"type": "entry_appended", "entry": {"customType": "benchmark", "data": {"kind": "jev_request_start", "data": {"id": "pending"}}}},
                {"type": "message_end", "message": {"role": "assistant", "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}},
            ]
            (arm / "events.jsonl").write_text("\n".join(json.dumps(e) for e in records) + '\n{"type":', encoding="utf-8")
            result = summarize_arm(root, "jevcoder", {"costPerMillionTokens": PRICES, "jev": {"inputPerMillionTokens": 0.042}}, "example__repo-1")
            reasons = {item["reason"] for item in result["unaccounted_usage"]}
            self.assertEqual(reasons, {"no_reported_usage", "no_completion_record", "incomplete_or_invalid_json"})
            self.assertIsNone(result["resolved"])


if __name__ == "__main__":
    unittest.main()
