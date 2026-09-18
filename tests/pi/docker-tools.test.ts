import assert from "node:assert/strict";
import { test } from "node:test";
import { createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition, createBashToolDefinition,
  type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import dockerTools from "../../scripts/bench/docker-tools.ts";

test("benchmark backend retains native tool schemas and prompt metadata", t => {
  const old = process.env.BENCH_CONTAINER;
  process.env.BENCH_CONTAINER = "jevcoder-bench-test-only";
  t.after(() => { if (old === undefined) delete process.env.BENCH_CONTAINER; else process.env.BENCH_CONTAINER = old; });
  const tools: any[] = [];
  dockerTools({ registerTool: (tool: unknown) => tools.push(tool), on: () => {} } as unknown as ExtensionAPI);
  const native = [createReadToolDefinition(process.cwd()), createEditToolDefinition(process.cwd()),
    createWriteToolDefinition(process.cwd()), createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false })];
  for (const expected of native) {
    const actual = tools.find(tool => tool.name === expected.name);
    assert.ok(actual);
    assert.deepEqual(actual.parameters, expected.parameters);
    assert.equal(actual.promptSnippet, expected.promptSnippet);
    assert.deepEqual(actual.promptGuidelines, expected.promptGuidelines);
  }
});
