import assert from "node:assert/strict";
import { test } from "node:test";
import { AppendOnlyControls, StableToolPrefix, type ControlMessage } from "../../extensions/cache.ts";

const names = ["read", "bash", "edit", "write"];
const user = { role: "user" as const, content: "Task", timestamp: 1 };
const control = (content: string): ControlMessage => ({ role: "custom", customType: "jevcoder-control", content, display: false, timestamp: 2 });

for (const api of ["openai-completions", "openai-responses", "openai-codex-responses", "anthropic-messages"]) {
  test(`${api}: schemas/order/cache annotations remain identical across turns`, () => {
    const tools = names.map(name => api === "openai-completions"
      ? { type: "function", function: { name, parameters: { type: "object" } } }
      : { type: "function", name, parameters: { type: "object" }, cache_control: { type: "ephemeral" } });
    const payload = { model: "test", tools, messages: [{ role: "system", content: "Stable system" }, { role: "user", content: "Task" }],
      prompt_cache_key: "keep-this-key", temperature: 0.2 };
    const prefix = new StableToolPrefix();
    const first = prefix.prepare(payload, api, names);
    const hash = prefix.sha256;
    const second = prefix.prepare({ ...payload, messages: [...payload.messages, { role: "assistant", content: "New observation" }] }, api, names);
    assert.equal(first.tools, tools);
    assert.equal(second.tools, tools);
    assert.deepEqual(first.tool_choice, api === "anthropic-messages" ? { type: "auto" } : "auto");
    assert.deepEqual(second.tool_choice, first.tool_choice);
    assert.equal(prefix.sha256, hash);
    assert.equal(first.prompt_cache_key, "keep-this-key");
    assert.equal(first.temperature, 0.2);
    assert.equal(payload.tools.length, 4);
    assert.ok(!("parallel_tool_calls" in payload));
    assert.throws(() => prefix.prepare({ ...payload, tools: tools.slice(1) }, api, names), /do not match/);
    assert.throws(() => prefix.prepare({ ...payload, tools: [...tools].reverse() }, api, names), /prefix changed/);
  });
}

test("model, system instructions, tool schema, and unknown tool changes are rejected", () => {
  const payload = { model: "test", instructions: "Stable", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] };
  const prefix = new StableToolPrefix();
  prefix.prepare(payload, "openai-responses", ["read"]);
  for (const changed of [
    { ...payload, model: "other" }, { ...payload, instructions: "Changed" },
    { ...payload, tools: [{ ...payload.tools[0], parameters: { type: "object", properties: { new: { type: "string" } } } }] },
  ]) assert.throws(() => prefix.prepare(changed, "openai-responses", ["read"]), /prefix changed/);
  assert.throws(() => prefix.prepare({ ...payload, tools: [...payload.tools, { type: "function", name: "write" }] }, "openai-responses", ["read"]), /do not match/);
  assert.throws(() => prefix.prepare(payload, "google-generative-ai", ["read"]), /Unsupported/);
  assert.throws(() => new StableToolPrefix().prepare({ tools: [{ type: "namespace", name: "read" }] }, "openai-responses", ["read"]), /do not match/);
  assert.throws(() => new StableToolPrefix().prepare({ tools: [{ name: "read", defer_loading: true }] }, "anthropic-messages", ["read"]), /do not match/);
});

test("restrictive upstream tool-choice policies are not broadened", () => {
  const payload = { model: "test", tools: [{ name: "read" }] };
  for (const tool_choice of ["none", "required", { type: "function", name: "read" }]) {
    assert.throws(() => new StableToolPrefix().prepare({ ...payload, tool_choice }, "openai-responses", ["read"]), /will not broaden/);
  }
  const choice = { type: "auto", disable_parallel_tool_use: true };
  const result = new StableToolPrefix().prepare({ ...payload, tool_choice: choice }, "anthropic-messages", ["read"]);
  assert.equal(result.tool_choice, choice);
});

test("native requests without tools are preserved", () => {
  const payload = { model: "test", input: [{ role: "user", content: "Task" }] };
  assert.equal(new StableToolPrefix().prepare(payload, "openai-responses", []), payload);
});

test("context grows append-only with controls anchored between native messages", () => {
  const history = new AppendOnlyControls();
  const first = history.append([user], control("read"));
  const result = { role: "toolResult" as const, content: [{ type: "text" as const, text: "Code" }], toolName: "read", toolCallId: "r1", isError: false, timestamp: 3 };
  const second = history.append([user, result], control("edit"));
  assert.deepEqual(second.slice(0, first.length), first);
  assert.deepEqual(second, [user, control("read"), result, control("edit")]);
  assert.deepEqual(history.project([user, result]), second);
  const retry = history.append([user, result], control("read again"));
  assert.deepEqual(retry.slice(0, second.length), second);
  assert.throws(() => history.append([user], control("misplaced")), /prefix changed/);
  assert.throws(() => history.project([{ ...user, content: "Rewritten" }, result]), /prefix changed/);
});

test("downstream message mutations cannot rewrite stored controls", () => {
  const history = new AppendOnlyControls();
  const c = control("read");
  const first = history.append([user], c);
  c.content = "mutated caller";
  (first[1] as ControlMessage).content = "mutated downstream";
  assert.equal((history.project([user])[1] as ControlMessage).content, "read");
});
