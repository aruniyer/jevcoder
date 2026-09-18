// Pure serialization regression: real Pi/OpenAI Responses converters, no auth or network.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { convertResponsesMessages, convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { convertToLlm, createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition,
  type ContextEvent } from "@earendil-works/pi-coding-agent";
import { AppendOnlyControls, StableToolPrefix, type ControlMessage } from "../../extensions/cache.ts";

test("actual Responses input and tool schemas keep their prefix through read -> edit -> finish", () => {
  const model: Model<"openai-responses"> = { id: "cache-test", name: "Cache test", api: "openai-responses",
    provider: "github-copilot", baseUrl: "https://example.invalid", reasoning: true, input: ["text"],
    contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const tools = [createReadToolDefinition("/testbed"), createEditToolDefinition("/testbed"), createWriteToolDefinition("/testbed")];
  const controls = new AppendOnlyControls(), prefix = new StableToolPrefix();
  const native: ContextEvent["messages"] = [{ role: "user", content: "Fix the function", timestamp: 1 }];
  let previousInput: unknown[] = [], previousTools = "", previousHash: string | undefined;
  for (const [step, action] of ["read", "edit", "finish"].entries()) {
    const control: ControlMessage = { role: "custom", customType: "jevcoder-control",
      content: `Decision ${step + 1}: ${action}; next response only`, display: false, timestamp: step + 2 };
    const projected = controls.append(native, control);
    const context = { systemPrompt: "Stable coding instructions", messages: convertToLlm(projected), tools };
    const input = convertResponsesMessages(model, context, new Set(["github-copilot"]));
    const payload = prefix.prepare({ model: model.id, input, tools: convertResponsesTools(tools),
      prompt_cache_key: "stable-test-session" }, model.api, tools.map(t => t.name));
    assert.deepEqual(input.slice(0, previousInput.length), previousInput);
    assert.equal(payload.tool_choice, "auto"); // finish does not remove schemas/change choice
    if (step > 0) {
      assert.equal(JSON.stringify(payload.tools), previousTools);
      assert.equal(prefix.sha256, previousHash);
    }
    previousInput = structuredClone(input);
    previousTools = JSON.stringify(payload.tools);
    previousHash = prefix.sha256;
    if (action === "finish") break;
    const callId = `call_${step}|fc_${step}`;
    const assistant: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: 10 + step, stopReason: "toolUse", content: [
        { type: "text", text: "Performing selected action" },
        { type: "toolCall", id: callId, name: action, arguments: { path: "main.py" } },
      ], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    native.push(assistant, { role: "toolResult", toolCallId: callId, toolName: action,
      content: [{ type: "text", text: action === "read" ? "Source code" : "Edit applied" }], isError: false, timestamp: 20 + step });
  }
  const serialized = JSON.stringify(previousInput);
  assert.ok(serialized.includes("Decision 1") && serialized.includes("Decision 2") && serialized.includes("Decision 3"));
  assert.equal(previousTools, JSON.stringify(convertResponsesTools(tools)));
  assert.ok(!JSON.stringify(native).includes("Decision")); // No stale mode instructions in native history.
});
