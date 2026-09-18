import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadConfig } from "../../extensions/jev.ts";

function isolateEnvironment(t: TestContext): void {
  const names = ["TYPESAFE_API_KEY", "JEV_API_KEY", "JEV_KEY_FILE", "JEV_MODEL", "JEV_ENDPOINT", "JEV_MAX_STEPS"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
}

test("configuration uses TYPESAFE_API_KEY and trims surrounding whitespace", async t => {
  isolateEnvironment(t);
  process.env.TYPESAFE_API_KEY = "  fake-env-key\r\n";
  assert.deepEqual(await loadConfig(), {
    key: "fake-env-key",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    maxSteps: 20,
  });
});

test("missing or blank TYPESAFE_API_KEY rejects even when legacy credentials are configured", async t => {
  isolateEnvironment(t);
  const directory = await mkdtemp(join(tmpdir(), "jevcoder-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyFile = join(directory, "jev_key.txt");
  await writeFile(keyFile, "fake-file-key");
  process.env.JEV_API_KEY = "fake-legacy-key";
  process.env.JEV_KEY_FILE = keyFile;
  await assert.rejects(loadConfig(), /Set TYPESAFE_API_KEY/);
  for (const value of ["", " \t\r\n"]) {
    process.env.TYPESAFE_API_KEY = value;
    await assert.rejects(loadConfig(), /Set TYPESAFE_API_KEY/);
  }
});

test("non-credential model, endpoint, and budget settings still work", async t => {
  isolateEnvironment(t);
  process.env.TYPESAFE_API_KEY = "fake-env-key";
  process.env.JEV_MODEL = "jev-test";
  process.env.JEV_ENDPOINT = "https://example.test/v1/systemone";
  process.env.JEV_MAX_STEPS = "8";
  const config = await loadConfig();
  assert.equal(config.model, "jev-test");
  assert.equal(config.endpoint, "https://example.test/v1/systemone");
  assert.equal(config.maxSteps, 8);
  process.env.JEV_MAX_STEPS = "0";
  await assert.rejects(loadConfig(), /JEV_MAX_STEPS/);
  process.env.JEV_MAX_STEPS = "8";
  process.env.JEV_ENDPOINT = "http://example.test";
  await assert.rejects(loadConfig(), /HTTPS/);
});
