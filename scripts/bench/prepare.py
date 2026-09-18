"""Fetch the fixed example and snapshot model prices; no inference requests."""
import json
from pathlib import Path
import subprocess
import urllib.request

root = Path(__file__).resolve().parents[2]
control = root / ".jevcoder/bench/astropy-12907"
control.mkdir(parents=True, exist_ok=True)
instance_file = control / "instance.json"
if not instance_file.exists():
    url = "https://datasets-server.huggingface.co/rows?dataset=princeton-nlp%2FSWE-bench_Verified&config=default&split=test&offset=0&length=1"
    with urllib.request.urlopen(url, timeout=60) as response:
        row = json.load(response)["rows"][0]["row"]
    if row["instance_id"] != "astropy__astropy-12907":
        raise RuntimeError("Dataset ordering changed; refusing to silently select another example.")
    instance_file.write_text(json.dumps(row, indent=2), encoding="utf-8")
row = json.loads(instance_file.read_text(encoding="utf-8"))
(control / "instances.json").write_text(json.dumps([row]), encoding="utf-8")
if not (control / "pricing.json").exists():
    script = """
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
const runtime = await ModelRuntime.create({ allowModelNetwork: false });
const m = runtime.getModel('github-copilot', 'gpt-6-astra');
if (!m) throw new Error('GPT-6 Astra is missing from the cached Pi catalog.');
console.log(JSON.stringify({ capturedAt:new Date().toISOString(), provider:m.provider, model:m.id,
  api:m.api, costPerMillionTokens:m.cost,
  source:'https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing',
  jev:{model:'jev-1.13.0',inputPerMillionTokens:0.042,outputPerMillionTokens:0,
       source:'https://docs.typesafe.ai/models'} }, null, 2));
"""
    result = subprocess.run(["node", "--input-type=module", "-e", script], cwd=root, capture_output=True, check=True)
    (control / "pricing.json").write_bytes(result.stdout)
print("Prepared", row["instance_id"], "under", control)
print("Evaluation-only metadata is stored here; never mount this directory into an agent worker.")
