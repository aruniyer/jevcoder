import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import jevcoder from "../../extensions/jevcoder.ts";

function harness(t: TestContext, steps = "20") {
  const savedFetch = globalThis.fetch;
  const env = { key: process.env.TYPESAFE_API_KEY, steps: process.env.JEV_MAX_STEPS };
  process.env.TYPESAFE_API_KEY = "fake-test-key";
  process.env.JEV_MAX_STEPS = steps;
  t.after(() => {
    globalThis.fetch = savedFetch;
    for (const [name, value] of [["TYPESAFE_API_KEY", env.key], ["JEV_MAX_STEPS", env.steps]])
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
  });
  let action = "tool:read";
  let status = 200;
  const requests: any[] = [];
  globalThis.fetch = (async (_url, init) => {
    init?.signal?.throwIfAborted();
    const body = JSON.parse(init!.body as string); requests.push(body);
    return new Response(JSON.stringify({ answers: { next_action: { choice: action, confidence: 1,
      probabilities: Object.fromEntries(Object.keys(body.questions.next_action.criteria).map(k => [k, k === action ? 1 : 0])) } } }), { status });
  }) as typeof fetch;
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const entries: any[] = [];
  const notifications: string[] = [];
  const sent: any[] = [];
  const controller = new AbortController();
  let aborts = 0;
  const active = ["read", "edit", "write", "bash"];
  const ctx: any = {
    model: { api: "openai-completions", id: "copilot-test", provider: "github-copilot" },
    cwd: "/test", signal: controller.signal, hasUI: false, mode: "json",
    sessionManager: { getSessionId: () => "session" },
    getSystemPrompt: () => "Keep user instructions.",
    isIdle: () => true, waitForIdle: async () => {},
    abort: () => { aborts++; controller.abort(); },
    ui: { notify: (s: string) => notifications.push(s), setStatus: () => {} },
  };
  const pi = {
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    appendEntry: (_type: string, data: unknown) => entries.push(data),
    getActiveTools: () => [...active],
    getAllTools: () => active.map(name => ({ name, description: name })),
    sendUserMessage: (text: string) => { sent.push(text); handlers.get("agent_start")!({}, ctx); },
    sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
  };
  jevcoder(pi as unknown as ExtensionAPI);
  return {
    ctx, entries, notifications, sent, active, requests, aborts: () => aborts,
    choose: (next: string) => { action = next; }, http: (code: number) => { status = code; },
    start: (task = "Fix the bug") => commands.get("jevcoder").handler(task, ctx),
    stop: () => commands.get("jevcoder-stop").handler("", ctx),
    emit: (name: string, event: unknown = {}, context = ctx) => handlers.get(name)!(event, context),
  };
}
const user = { role: "user", content: "task", timestamp: 0 };
const assistant = (stopReason = "stop") => ({ role: "assistant", stopReason, content: [{ type: "text", text: "Need more context" }] });
const payload = { tools: ["read", "edit", "write", "bash"].map(name => ({ type: "function", function: { name } })) };

test("ordinary Pi prompts and other sessions are untouched", async t => {
  const h = harness(t);
  assert.equal(await h.emit("context", { messages: [user] }), undefined);
  assert.equal(h.emit("before_provider_request", { payload }), undefined);
  assert.equal(h.emit("tool_call", { toolName: "bash", input: { command: "echo hello" } }), undefined);
  assert.equal(h.requests.length, 0);
  await h.start();
  assert.equal(await h.emit("context", { messages: [user] }, { ...h.ctx, sessionManager: { getSessionId: () => "child" } }), undefined);
  assert.equal(h.requests.length, 0);
});

test("full tool schemas stay visible but only one selected call is admitted", async t => {
  const h = harness(t); await h.start();
  const transformed = await h.emit("context", { messages: [user] });
  assert.match(transformed.messages.at(-1).content, /tool:read/);
  const prepared = h.emit("before_provider_request", { payload });
  assert.equal(prepared.tools, payload.tools);
  assert.equal(prepared.tool_choice, "auto");
  assert.equal(prepared.parallel_tool_calls, false);
  assert.equal(h.emit("tool_call", { toolName: "edit", input: {} }).block, true);
  assert.equal(h.emit("tool_call", { toolName: "read", input: { path: "main.cs" } }), undefined);
  assert.equal(h.emit("tool_call", { toolName: "read", input: { path: "other.cs" } }).block, true);
  assert.deepEqual(h.active, ["read", "edit", "write", "bash"]); // no persistent tool changes
  assert.ok(!JSON.stringify(h.entries).includes("fake-test-key"));
});

test("code_editing authorizes only available edit/write without adding disabled tools", async t => {
  const h = harness(t); h.active.splice(h.active.indexOf("write"), 1);
  await h.start(); h.choose("code_editing");
  await h.emit("context", { messages: [user] });
  const nativePayload = { tools: payload.tools.filter(t => t.function.name !== "write") };
  assert.equal(h.emit("before_provider_request", { payload: nativePayload }).tools, nativePayload.tools);
  assert.equal(h.emit("tool_call", { toolName: "bash", input: {} }).block, true);
  assert.equal(h.emit("tool_call", { toolName: "write", input: {} }).block, true);
  assert.equal(h.emit("tool_call", { toolName: "edit", input: { path: "main.cs" } }), undefined);
});

test("observations feed subsequent routing; finish removes the gate", async t => {
  const h = harness(t); await h.start();
  await h.emit("context", { messages: [user] });
  h.choose("finish");
  await h.emit("context", { messages: [user, { role: "toolResult", content: [{ type: "text", text: "code observation" }] }] });
  assert.ok(JSON.stringify(h.requests.at(-1).state).includes("code observation"));
  assert.equal(h.emit("before_provider_request", { payload }).tools, payload.tools);
  assert.equal(h.emit("tool_call", { toolName: "read", input: {} }).block, true);
  h.emit("turn_end", { message: assistant(), toolResults: [] });
  assert.equal(h.entries.at(-1).data.reason, "finish");
  assert.equal(await h.emit("context", { messages: [user] }), undefined);
  assert.equal(h.emit("before_provider_request", { payload }), undefined);
});

test("missing-context prose continues; provider error/abort does not enqueue a continuation", async t => {
  const h = harness(t); await h.start();
  await h.emit("context", { messages: [user] });
  h.emit("turn_end", { message: assistant(), toolResults: [] });
  assert.equal(h.sent.at(-1).options.deliverAs, "steer");
  const count = h.sent.length;
  for (const reason of ["error", "aborted", "length"]) h.emit("turn_end", { message: assistant(reason), toolResults: [] });
  assert.equal(h.sent.length, count);
});

for (const failure of ["http", "limit", "payload"]) {
  test(`${failure} failure aborts and retains tool gate until settled`, async t => {
    const h = harness(t, "1"); await h.start();
    if (failure === "http") h.http(401);
    await h.emit("context", { messages: [user] });
    if (failure === "limit") await h.emit("context", { messages: [user] });
    if (failure === "payload") h.emit("before_provider_request", { payload: { tools: [] } });
    assert.equal(h.aborts(), 1);
    assert.equal(h.emit("tool_call", { toolName: "bash", input: {} }).block, true);
    assert.ok(h.entries.some(e => e.kind === "stopped"));
    h.emit("agent_settled");
    assert.equal(h.emit("tool_call", { toolName: "bash", input: {} }), undefined);
  });
}

test("cancellation, shutdown and compaction have explicit lifecycle handling", async t => {
  const h = harness(t); await h.start(); await h.emit("context", { messages: [user] });
  assert.deepEqual(h.emit("session_before_compact"), { cancel: true });
  assert.equal(h.aborts(), 1);
  h.emit("session_shutdown");
  assert.equal(h.emit("before_provider_request", { payload }), undefined);
});

test("explicit stop aborts routing/tool execution", async t => {
  const h = harness(t); await h.start(); await h.emit("context", { messages: [user] });
  // Real Pi is busy during a run; prevent the stop command's idle cleanup branch.
  h.ctx.isIdle = () => false;
  await h.stop();
  assert.equal(h.aborts(), 1);
  assert.equal(h.emit("tool_call", { toolName: "read", input: {} }).terminate, true);
});

test("credential paths are blocked without granting extra tool calls", async t => {
  const h = harness(t); await h.start(); await h.emit("context", { messages: [user] });
  for (const path of ["jev_key.txt", "C:\\repo\\together_key.txt", ".env", ".env.local", "/home/.pi/agent/auth.json"])
    assert.equal(h.emit("tool_call", { toolName: "read", input: { path } }).block, true);
  assert.equal(h.emit("tool_call", { toolName: "read", input: { path: "main.cs" } }), undefined);
});

test("routing controls are retained at original positions across action changes and retries", async t => {
  const h = harness(t); await h.start();
  const first = await h.emit("context", { messages: [user] });
  const firstRequest = h.emit("before_provider_request", { payload });
  const observation = { role: "toolResult", content: [{ type: "text", text: "read result" }] };
  const native = [user, assistant("toolUse"), observation];
  h.choose("code_editing");
  const second = await h.emit("context", { messages: native });
  const secondRequest = h.emit("before_provider_request", { payload });
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
  assert.deepEqual(second.messages.slice(first.messages.length, -1), native.slice(1));
  assert.match(second.messages.at(-1).content, /code_editing/);
  assert.deepEqual(firstRequest, secondRequest);
  // Simulate an upstream retry before any new native message was retained.
  const retry = await h.emit("context", { messages: native });
  assert.deepEqual(retry.messages.slice(0, second.messages.length), second.messages);
  assert.equal(retry.messages.filter((m: any) => m.customType === "jevcoder-control").length, 3);
  const hashes = h.entries.filter(e => e.kind === "cache_prefix").map(e => e.data.sha256);
  assert.equal(new Set(hashes).size, 1);
  assert.ok(h.entries.filter(e => e.kind === "decision").every(e => e.data.control.message.content));
});

for (const change of ["model", "active-tools", "history", "tool-schema", "system-prefix"]) {
  test(`${change} changes stop the run without restoring stale state`, async t => {
    const h = harness(t); await h.start(); await h.emit("context", { messages: [user] });
    h.emit("before_provider_request", { payload });
    if (change === "model") h.ctx.model = { ...h.ctx.model, id: "other-model" };
    if (change === "active-tools") h.active.splice(h.active.indexOf("read"), 1);
    if (change === "tool-schema") {
      const changed = structuredClone(payload);
      (changed.tools[0]!.function as any).description = "Changed definition";
      h.emit("before_provider_request", { payload: changed });
    } else if (change === "system-prefix") {
      h.emit("before_provider_request", { payload: { ...payload, messages: [{ role: "system", content: "Changed instructions" }] } });
    } else {
      await h.emit("context", { messages: change === "history" ? [{ ...user, content: "Rewritten history" }] : [user] });
      assert.equal(h.requests.length, 1); // Rejected before another paid Jev call.
    }
    assert.equal(h.aborts(), 1);
    assert.equal(h.emit("tool_call", { toolName: "bash", input: {} }).block, true);
    if (change === "active-tools") assert.ok(!h.active.includes("read"));
  });
}

test("tool revocation while Jev is in flight stops before model execution", async t => {
  const h = harness(t); await h.start();
  const respond = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await respond(input, init);
    h.active.splice(h.active.indexOf("read"), 1);
    return response;
  };
  await h.emit("context", { messages: [user] });
  assert.equal(h.aborts(), 1);
  assert.ok(!h.active.includes("read"));
  assert.equal(h.emit("tool_call", { toolName: "read", input: {} }).block, true);
  assert.equal(h.entries.filter(e => e.kind === "cache_prefix").length, 0);
});

test("new runs do not replay old routing controls", async t => {
  const h = harness(t); await h.start();
  h.choose("finish");
  await h.emit("context", { messages: [user] });
  h.emit("turn_end", { message: assistant(), toolResults: [] });
  await h.start("New task");
  h.choose("tool:read");
  const next = await h.emit("context", { messages: [user, assistant(), { ...user, content: "New task" }] });
  assert.equal(next.messages.filter((m: any) => m.customType === "jevcoder-control").length, 1);
  assert.match(next.messages.at(-1).content, /decision 1/);
});

test("empty/busy/unsupported commands do not start a run", async t => {
  const h = harness(t); await h.start(" ");
  h.ctx.model.api = "google-generative-ai"; await h.start();
  h.ctx.model.api = "openai-completions"; h.ctx.isIdle = () => false; await h.start();
  assert.equal(h.sent.length, 0);
});
