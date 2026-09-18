import assert from "node:assert/strict";
import { test } from "node:test";
import { buildActions, chooseAction, routingMessages, type JevConfig } from "../../extensions/jev.ts";

const tools = ["read", "bash", "edit", "write", "custom_lookup"].map(name => ({ name, description: name }));
const config: JevConfig = { key: "fake-test-key", endpoint: "https://example.test/v1/systemone", model: "jev-latest", maxSteps: 20 };
const response = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

test("actions group only active editing tools and preserve custom tools", () => {
  const actions = buildActions(tools);
  assert.deepEqual(actions.map(a => a.name), ["tool:read", "tool:bash", "tool:custom_lookup", "code_editing", "finish"]);
  assert.deepEqual(actions.find(a => a.name === "code_editing")?.tools, ["edit", "write"]);
  assert.deepEqual(buildActions([tools[0]!]).map(a => a.name), ["tool:read", "finish"]);
  assert.deepEqual(buildActions([]).map(a => a.name), ["finish"]);
});

test("routing context excludes thinking, images, signatures, hidden shell output, and details", () => {
  const messages = routingMessages([
    { role: "user", content: "task" },
    { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "plan" },
      { type: "toolCall", id: "id", name: "read", arguments: { path: "a" }, thoughtSignature: "signature" }] },
    { role: "toolResult", toolName: "read", content: [{ type: "image", data: "base64-secret" }, { type: "text", text: "code" }], details: { secret: "details" } },
    { role: "bashExecution", command: "hidden", output: "excluded", excludeFromContext: true },
    { role: "compactionSummary", summary: "retained summary" },
  ]);
  const text = JSON.stringify(messages);
  for (const excluded of ["private", "signature", "base64-secret", "details", "hidden", "excluded"]) assert.ok(!text.includes(excluded));
  for (const included of ["task", "plan", "read", "code", "retained summary"]) assert.ok(text.includes(included));
});

test("Jev request uses documented choice API; key is not in body; usage retained", async () => {
  const actions = buildActions([tools[0]!]);
  let captured: any;
  const result = await chooseAction(config, { task: "task", accidentalKey: config.key }, actions, undefined,
    (async (url, init) => {
      assert.equal(url, config.endpoint);
      captured = JSON.parse(init!.body as string);
      assert.equal((init!.headers as Record<string, string>).Authorization, `Bearer ${config.key}`);
      assert.ok(!(init!.body as string).includes(config.key));
      return new Response(JSON.stringify({ answers: { next_action: { choice: "tool:read", confidence: 0.8,
        probabilities: { "tool:read": 0.9, finish: 0.1 } } }, usage: { input_tokens: 12 } }));
    }) as typeof fetch);
  assert.equal(captured.questions.next_action.type, "choice");
  assert.deepEqual(Object.keys(captured.questions.next_action.criteria), ["tool:read", "finish"]);
  assert.equal(result.action, "tool:read");
  assert.equal(result.confidence, 0.8);
  assert.deepEqual(result.usage, { input_tokens: 12 });
});

test("invalid choices, confidence, probabilities, and HTTP errors reject", async () => {
  const actions = buildActions([]);
  for (const answer of [
    { choice: "unknown", confidence: 1, probabilities: { finish: 1 } },
    { choice: "finish", confidence: 2, probabilities: { finish: 1 } },
    { choice: "finish", confidence: 1, probabilities: { finish: -1 } },
    { choice: "finish", confidence: 1 },
  ]) await assert.rejects(chooseAction(config, {}, actions, undefined, response({ answers: { next_action: answer } })));
  await assert.rejects(chooseAction(config, {}, actions, undefined, response({ secret: "not echoed" }, 401)), /HTTP 401/);
});

test("oversized context is rejected before network access", async () => {
  let calls = 0;
  await assert.rejects(chooseAction(config, { text: "x".repeat(160_000) }, buildActions([]), undefined,
    (async () => { calls++; throw new Error("Unexpected network"); }) as typeof fetch), /context exceeds/);
  assert.equal(calls, 0);
});

test("routing passes cancellation to fetch", async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(chooseAction(config, {}, buildActions([]), abort.signal,
    (async (_url, init) => { init!.signal!.throwIfAborted(); throw new Error("Expected abort"); }) as typeof fetch), { name: "AbortError" });
});
