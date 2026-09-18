"""Run isolated SWE-bench arms with Pi; evaluate exported patches separately."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
MODEL = "github-copilot/gpt-6-astra"
CLI = ROOT / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"


def docker(*args, check=True, timeout=120):
    result = subprocess.run(["docker", *args], capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace"))
    return result


def image_name(instance):
    return "swebench/sweb.eval.x86_64." + instance["instance_id"].replace("__", "_1776_").lower() + ":latest"


def source_hashes():
    files = ["extensions/jev.ts", "extensions/cache.ts", "extensions/jevcoder.ts", "scripts/bench/docker-tools.ts", "scripts/bench/accounting.ts", "scripts/bench/run.py"]
    return {f: hashlib.sha256((ROOT / f).read_bytes()).hexdigest() for f in files}


def run_arm(arm, control, instance, expected_hashes=None):
    control = Path(control)
    directory = control / arm
    directory.mkdir(parents=True, exist_ok=False)  # Never silently replay a paid run.
    workspace = Path(tempfile.mkdtemp(prefix="jevcoder-bench-workspace-"))
    container = "jevcoder-bench-" + arm + "-" + uuid.uuid4().hex[:12]
    base, image = instance["base_commit"], image_name(instance)
    if len(base) != 40 or any(c not in "0123456789abcdef" for c in base):
        raise ValueError("Invalid base commit")
    prompt = "Fix the following repository issue. Inspect the existing code, make a minimal correct fix, add appropriate regression coverage, and run relevant tests. Leave changes in the working tree; do not commit.\n\n" + instance["problem_statement"]
    env = os.environ.copy()
    env.update(BENCH_CONTAINER=container, PI_OFFLINE="1", JEV_MODEL="jev-1.13.0", JEV_MAX_STEPS="40")
    if arm == "jevcoder":
        env["TYPESAFE_API_KEY"] = env.get("TYPESAFE_API_KEY") or (ROOT / "jev_key.txt").read_text(encoding="utf-8-sig").strip()
    else:
        env.pop("TYPESAFE_API_KEY", None)
    argv = ["node", str(CLI), "--no-extensions", "-e", str(ROOT / "scripts/bench/docker-tools.ts"),
            "-e", str(ROOT / "scripts/bench/accounting.ts")]
    if arm == "jevcoder":
        argv += ["-e", str(ROOT / ".pi/extensions/jevcoder.ts")]
    argv += ["--no-context-files", "--no-skills", "--no-prompt-templates", "--tools", "read,bash,edit,write",
             "--model", MODEL, "--thinking", "medium", "--session-dir", str(directory / "sessions"),
             "--mode", "json", "--", ("/jevcoder " if arm == "jevcoder" else "") + prompt]
    metadata = {"arm": arm, "instance_id": instance["instance_id"], "base_commit": base, "image": image,
                "model": MODEL, "thinking": "medium", "max_requests": 40, "soft_llm_cost_limit_usd": 5,
                "wall_time_limit_seconds": 900, "network": "none", "cpus": 4, "memory": "6g",
                "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(), "command": argv,
                "implementation_sha256": source_hashes(), "inference_started": False,
                "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    (directory / "prompt.txt").write_text(prompt, encoding="utf-8")
    def save():
        (directory / "run.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    save()
    process = None
    started = None
    print(instance["instance_id"], arm, "starting", flush=True)
    try:
        if expected_hashes is not None and source_hashes() != expected_hashes:
            raise RuntimeError("Implementation changed after batch preregistration")
        docker("run", "-d", "--name", container, "--network", "none", "--cpus", "4", "--memory", "6g", image, "sleep", "infinity")
        metadata["image_id"] = docker("inspect", container, "--format", "{{.Image}}").stdout.decode().strip()
        setup = docker("exec", "-w", "/testbed", container, "bash", "-lc",
                       f"git reset --hard {base} && git clean -fd && git config core.fileMode false && "
                       "source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed && "
                       "python --version && git status --porcelain", check=False)
        (directory / "setup.log").write_bytes(setup.stdout + setup.stderr)
        if setup.returncode:
            raise RuntimeError("Container setup failed; see setup.log")
        metadata["actual_head"] = docker("exec", container, "git", "-C", "/testbed", "rev-parse", "HEAD").stdout.decode().strip()
        assert metadata["actual_head"] == base
        assert not docker("exec", container, "git", "-C", "/testbed", "status", "--porcelain").stdout.strip()
        started = time.monotonic()
        with (directory / "events.jsonl").open("wb") as out, (directory / "stderr.log").open("wb") as err:
            process = subprocess.Popen(argv, cwd=workspace, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err)
            metadata.update(inference_started=True, process_id=process.pid, container=container)
            save()
            try:
                metadata["exit_code"] = process.wait(timeout=900)
                metadata["timed_out"] = False
            except subprocess.TimeoutExpired:
                process.kill(); process.wait()
                docker("stop", "--time", "1", container, check=False)
                metadata["exit_code"] = process.returncode
                metadata["timed_out"] = True
        metadata["elapsed_seconds"] = time.monotonic() - started
        if metadata["timed_out"]:
            docker("start", container)
        docker("exec", container, "git", "-C", "/testbed", "add", "-N", ".")
        patch = docker("exec", container, "git", "-C", "/testbed", "diff", "--binary", base).stdout.decode("utf-8")
        (directory / "prediction.patch").write_text(patch, encoding="utf-8", newline="\n")
        (directory / "predictions.jsonl").write_text(json.dumps({"instance_id": instance["instance_id"],
             "model_name_or_path": arm, "model_patch": patch}) + "\n", encoding="utf-8")
        metadata.update(patch_sha256=hashlib.sha256(patch.encode()).hexdigest(), status="timed_out" if metadata["timed_out"] else "completed")
    except Exception as error:
        metadata.update(status="run_error" if metadata["inference_started"] else "setup_error", error=str(error))
        if started is not None:
            metadata["elapsed_seconds"] = time.monotonic() - started
    finally:
        if process is not None and process.poll() is None:
            process.kill(); process.wait()
        metadata["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        save()
        docker("rm", "-f", container, check=False)
        if not any(workspace.iterdir()):
            workspace.rmdir()
    print(instance["instance_id"], arm, metadata["status"], "seconds", round(metadata.get("elapsed_seconds", 0), 2), flush=True)
    return metadata


if __name__ == "__main__":
    raise SystemExit("Use python scripts/bench/batch.py run to execute a batch.")
