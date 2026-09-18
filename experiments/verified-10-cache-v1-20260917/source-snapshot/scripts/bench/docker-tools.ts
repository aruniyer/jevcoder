// Experiment-only Pi tool backend. No host filesystem or Docker socket is mounted
// in the worker; all four standard tool implementations delegate to docker exec.
import { spawn } from "node:child_process";
import path from "node:path";
import { access, readFile } from "node:fs/promises";
import { createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition, createBashToolDefinition,
  type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const container = process.env.BENCH_CONTAINER;
  if (!container || !/^jevcoder-bench-[a-z0-9-]+$/.test(container)) throw new Error("Invalid benchmark container name.");
  const cwd = process.cwd();
  // Native bash truncates to a host temp file. Only files returned by this tool
  // may be read locally; arbitrary host paths remain inaccessible to agents.
  const outputFiles = new Set<string>();
  const remote = (file: string): string => {
    const normalized = file.replaceAll("\\", "/");
    if (/^(?:[A-Za-z]:)?\/testbed(?:\/|$)/.test(normalized)) return normalized.replace(/^[A-Za-z]:/, "");
    const rel = path.relative(cwd, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("File tools are restricted to /testbed.");
    return path.posix.join("/testbed", rel.replaceAll("\\", "/"));
  };
  function exec(args: string[], input?: string, onData?: (data: Buffer) => void, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn("docker", ["exec", "-i", "-w", "/testbed", container!, ...args], { stdio: ["pipe", "pipe", "pipe"] });
      const chunks: Buffer[] = [], errors: Buffer[] = [];
      child.stdout.on("data", data => onData ? onData(data) : chunks.push(data));
      child.stderr.on("data", data => onData ? onData(data) : errors.push(data));
      const abort = () => { child.kill(); };
      signal?.addEventListener("abort", abort, { once: true });
      child.on("error", reject);
      child.stdin.on("error", () => {});
      child.on("close", code => {
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) reject(new Error("aborted"));
        else if (code !== 0) reject(new Error(`Docker command exited ${code}: ${Buffer.concat(errors).toString()}`));
        else resolve(Buffer.concat(chunks));
      });
      child.stdin.end(input);
    });
  }
  const read = {
    readFile: (p: string) => outputFiles.has(p) ? readFile(p) : exec(["python", "-c", "import pathlib,sys; sys.stdout.buffer.write(pathlib.Path(sys.argv[1]).read_bytes())", remote(p)]),
    access: async (p: string) => { if (outputFiles.has(p)) await access(p); else await exec(["test", "-r", remote(p)]); },
    detectImageMimeType: async () => null,
  };
  const write = {
    writeFile: async (p: string, text: string) => { await exec(["python", "-c", "import pathlib,sys; pathlib.Path(sys.argv[1]).write_bytes(sys.stdin.buffer.read())", remote(p)], text); },
    mkdir: async (p: string) => { await exec(["mkdir", "-p", remote(p)]); },
  };
  pi.registerTool(createReadToolDefinition(cwd, { operations: read }));
  pi.registerTool(createEditToolDefinition(cwd, { operations: { ...read, ...write } }));
  pi.registerTool(createWriteToolDefinition(cwd, { operations: write }));
  const bash = createBashToolDefinition(cwd, { exposeSessionEnvironment: false, operations: {
    exec: async (command, _cwd, { onData, signal, timeout }) => {
      // Return the inner shell's status without making ordinary test failures backend errors.
      const seconds = Math.min(timeout ?? 120, 180);
      const marker = `__BENCH_EXIT_${crypto.randomUUID()}__`;
      let tail = Buffer.alloc(0);
      await exec(["bash", "-c", `timeout --kill-after=5s ${seconds}s bash -lc "$1"; code=$?; printf '\\n${marker}%s\\n' "$code"`, "--",
        "source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed && cd /testbed\n" + command], undefined, data => {
        tail = Buffer.concat([tail, data]);
        // Preserve UTF-8 bytes across chunks while withholding the private marker.
        if (tail.length > 256) { onData(tail.subarray(0, -256)); tail = tail.subarray(-256); }
      }, signal);
      const markerBytes = Buffer.from(`\n${marker}`);
      const index = tail.lastIndexOf(markerBytes);
      const status = index < 0 ? "" : tail.subarray(index + markerBytes.length).toString().trim();
      if (!/^\d+$/.test(status)) throw new Error("Missing shell exit status.");
      onData(tail.subarray(0, index));
      return { exitCode: Number(status) };
    },
  } });
  pi.registerTool({ ...bash, async execute(id, params, signal, update, ctx) {
    const result = await bash.execute(id, params, signal, update, ctx);
    if (result.details?.fullOutputPath) outputFiles.add(path.resolve(result.details.fullOutputPath));
    return result;
  } });
  pi.on("before_agent_start", event => ({ systemPrompt: event.systemPrompt.replaceAll(cwd, "/testbed") +
    "\n\nBenchmark environment: all read/edit/write/bash tools operate inside an isolated Linux container at /testbed. " +
    "Use repository-relative paths (not host paths). Bash activates the preinstalled conda environment 'testbed'. " +
    "The container has no network. Use existing dependencies and the project's existing test runner. " +
    "Do not search for external solutions, manipulate Git history, or access evaluation artifacts. " +
    "Fix the requested issue and leave your changes in the working tree; do not commit them." }));
}
