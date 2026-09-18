// Experiment-only recorder, loaded identically for both arms. Does not record
// request bodies, headers, or credentials. Provider usage is not a billing receipt.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let requests = 0, cost = 0;
  const record = (kind: string, data: unknown) => pi.appendEntry("benchmark", { kind, at: new Date().toISOString(), data });
  const originalFetch = globalThis.fetch;
  const endpoint = process.env.JEV_ENDPOINT || "https://api.typesafe.ai/v1/systemone";
  const wrapped: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== endpoint) return originalFetch(input, init);
    const id = crypto.randomUUID(), started = Date.now();
    record("jev_request_start", { id });
    try {
      const response = await originalFetch(input, init);
      let data: any;
      try { data = await response.clone().json(); } catch { /* Missing usage stays unknown. */ }
      record("jev_request_end", { id, httpStatus: response.status, elapsedMs: Date.now() - started,
        model: data?.model, usage: data?.usage ?? null });
      return response;
    } catch (error) {
      record("jev_request_end", { id, elapsedMs: Date.now() - started, usage: null,
        error: error instanceof Error ? error.name : "fetch_error" });
      throw error;
    }
  };
  globalThis.fetch = wrapped;
  pi.on("session_start", (_event, ctx) => record("config", {
    provider: ctx.model?.provider, model: ctx.model?.id, api: ctx.model?.api,
    thinking: ctx.thinkingLevel, prices: ctx.model?.cost, maxRequests: 40, softCostLimitUsd: 5,
  }));
  pi.on("context", (_event, ctx) => {
    if (requests >= 40 || cost >= 5) {
      record("budget_stop", { requests, observedLlmCostUsd: cost });
      ctx.abort();
    }
  });
  pi.on("before_provider_request", (_event, ctx) => record("llm_request_start", {
    request: ++requests, provider: ctx.model?.provider, model: ctx.model?.id,
  }));
  pi.on("after_provider_response", event => record("llm_response", { request: requests, status: event.status }));
  pi.on("message_end", event => {
    if (event.message.role !== "assistant") return;
    cost += event.message.usage.cost.total;
    record("llm_usage", { request: requests, model: event.message.model,
      stopReason: event.message.stopReason, usage: event.message.usage });
  });
  pi.on("session_before_compact", (_event, ctx) => {
    record("budget_stop", { reason: "compaction_requested" }); ctx.abort(); return { cancel: true };
  });
  pi.on("session_shutdown", () => { if (globalThis.fetch === wrapped) globalThis.fetch = originalFetch; });
}
