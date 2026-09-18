import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildActions, chooseAction, constrainPayload, loadConfig, routingMessages, supportsApi,
  type Action, type JevConfig } from "./jev.ts";

interface Run {
  id: string;
  sessionId: string;
  task: string;
  config: JevConfig;
  controller: AbortController;
  toolNames: string[];
  step: number;
  selected?: Action;
  used: boolean;
  stopped: boolean;
  outcome?: string;
  started: boolean;
  signalStarted: () => void;
}

export default function jevcoder(pi: ExtensionAPI): void {
  let run: Run | undefined;
  const owns = (ctx: ExtensionContext): Run | undefined =>
    run?.sessionId === ctx.sessionManager.getSessionId() ? run : undefined;
  const record = (current: Run, kind: string, data: unknown) =>
    pi.appendEntry("jevcoder", { runId: current.id, step: current.step, kind, data });

  function stop(current: Run, ctx: ExtensionContext, reason: string): void {
    if (current.stopped) return;
    current.stopped = true;
    current.outcome = reason;
    current.selected = undefined;
    current.controller.abort();
    current.signalStarted();
    ctx.abort(); // Hook exceptions alone do NOT stop Pi; explicitly abort and retain the gate.
    record(current, "stopped", { reason });
    ctx.ui.setStatus("jevcoder", undefined);
    ctx.ui.notify(`JevCoder: ${reason}`, "warning");
  }

  pi.registerCommand("jevcoder", {
    description: "Run a task with Jev routing and the currently selected Pi model",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /jevcoder <prompt>\nCancel with Escape or /jevcoder-stop.", "info");
        return;
      }
      if (run || !ctx.isIdle()) {
        ctx.ui.notify("Finish/cancel the current run before starting JevCoder.", "warning");
        return;
      }
      if (!ctx.model || !supportsApi(ctx.model.api)) {
        ctx.ui.notify("Select a model using OpenAI Chat/Responses or Anthropic Messages (including supported Copilot models).", "error");
        return;
      }
      try {
        const config = await loadConfig();
        // Re-check after async key loading; a second command must not replace an active run.
        if (run || !ctx.isIdle()) return;
        let signalStarted!: () => void;
        const started = new Promise<void>(resolve => { signalStarted = resolve; });
        const current: Run = {
          id: crypto.randomUUID(), sessionId: ctx.sessionManager.getSessionId(), task: args.trim(), config,
          controller: new AbortController(), toolNames: pi.getActiveTools(), step: 0, used: false, stopped: false,
          started: false, signalStarted,
        };
        run = current;
        record(current, "start", { model: `${ctx.model.provider}/${ctx.model.id}`, jevModel: config.model, maxSteps: config.maxSteps });
        ctx.ui.notify("JevCoder active. Text context goes to Jev; Pi keeps its model, tools, and permission policies.", "info");
        // sendUserMessage is fire-and-forget. Wait for startup then idle so print/JSON
        // mode cannot dispose the extension while the native run is still starting.
        const timer = setTimeout(() => {
          if (run === current && !current.started) stop(current, ctx, "Pi did not start within 30 seconds. Check model authentication and input extensions.");
        }, 30_000);
        try {
          pi.sendUserMessage(current.task);
          await started;
          if (run === current && !current.stopped) await ctx.waitForIdle();
          if (run === current && !current.started) run = undefined;
        } finally { clearTimeout(timer); }
      } catch (error) {
        run = undefined;
        ctx.ui.notify(error instanceof Error ? error.message : "Could not start JevCoder.", "error");
      }
    },
  });

  pi.registerCommand("jevcoder-stop", {
    description: "Stop the current JevCoder run",
    handler: async (_args, ctx) => {
      const current = owns(ctx);
      if (!current) { ctx.ui.notify("JevCoder is not running.", "info"); return; }
      stop(current, ctx, "Cancelled by user. Changes already made are not rolled back.");
      if (ctx.isIdle()) run = undefined;
    },
  });

  pi.on("agent_start", (_event, ctx) => {
    const current = owns(ctx);
    if (current) { current.started = true; current.signalStarted(); }
  });

  pi.on("session_before_compact", (_event, ctx) => {
    const current = owns(ctx);
    if (!current) return;
    stop(current, ctx, "Compaction requested. Compact outside JevCoder, then restart the task.");
    return { cancel: true };
  });

  pi.on("context", async (event, ctx) => {
    const current = owns(ctx);
    if (!current || current.stopped) return;
    current.selected = undefined;
    current.used = false;
    try {
      if (++current.step > current.config.maxSteps) throw new Error(`Step limit (${current.config.maxSteps}) reached; task may be incomplete.`);
      if (!ctx.model || !supportsApi(ctx.model.api)) throw new Error("Current model uses an unsupported API.");
      const active = new Set(pi.getActiveTools());
      const tools = pi.getAllTools().filter(t => current.toolNames.includes(t.name) && active.has(t.name));
      const actions = buildActions(tools);
      ctx.ui.setStatus("jevcoder", `JevCoder ${current.step}: routing…`);
      const started = Date.now();
      const signal = AbortSignal.any([current.controller.signal, ...(ctx.signal ? [ctx.signal] : [])]);
      const decision = await chooseAction(current.config, {
        task: current.task, cwd: ctx.cwd, instructions: ctx.getSystemPrompt(), messages: routingMessages(event.messages),
      }, actions, signal);
      signal.throwIfAborted();
      if (run !== current) return;
      current.selected = actions.find(a => a.name === decision.action)!;
      record(current, "decision", { ...decision, elapsedMs: Date.now() - started });
      ctx.ui.setStatus("jevcoder", `JevCoder ${current.step}: ${decision.action} (${decision.confidence.toFixed(2)})`);
      const instruction = decision.action === "finish"
        ? "Jev selected finish. Give the final answer or explain blockers/ask for clarification. Do not call tools. Distinguish tested facts from assumptions."
        : `Jev selected ${decision.action}. Make at most ONE tool call, using only: ${current.selected.tools.join(", ")}. ` +
          "Use accumulated context to fill its arguments. Do not call other tools or hide unrelated actions in a shell command. " +
          "If more context is needed or the action cannot safely proceed, explain that briefly in text instead of guessing. The router will reconsider next turn.";
      // Transient control instruction: does not pollute future normal Pi turns or persisted history.
      return { messages: [...event.messages, { role: "custom" as const, customType: "jevcoder-control",
        content: instruction, display: false, timestamp: Date.now() }] };
    } catch (error) {
      stop(current, ctx, current.controller.signal.aborted || ctx.signal?.aborted
        ? "Cancelled. Changes already made are not rolled back."
        : error instanceof Error ? error.message : "Routing failed.");
    }
  });

  pi.on("before_provider_request", (event, ctx) => {
    const current = owns(ctx);
    if (!current) return;
    try {
      if (current.stopped || !current.selected) throw new Error("No valid Jev decision; refusing model execution.");
      return constrainPayload(event.payload, ctx.model!.api, current.selected.tools);
    } catch (error) {
      stop(current, ctx, error instanceof Error ? error.message : "Could not constrain provider request.");
      // The request signal is aborted; also remove schemas rather than fail open if another hook continues.
      return { ...(event.payload as object), tools: [] };
    }
  });

  pi.on("tool_call", (event, ctx) => {
    const current = owns(ctx);
    if (!current) return;
    let reason: string | undefined;
    if (current.stopped || ctx.signal?.aborted || !current.selected) reason = "No active Jev decision.";
    else if (!current.selected.tools.includes(event.toolName)) reason = `Jev selected ${current.selected.name}, not ${event.toolName}.`;
    else if (current.used) reason = "Only one tool call is permitted per Jev decision.";
    else if (!pi.getActiveTools().includes(event.toolName)) reason = "Tool was disabled during the run.";
    else if ("path" in event.input && typeof event.input.path === "string" &&
      /(?:^|[/\\])(?:[^/\\]*_key\.txt|\.env(?:\.[^/\\]*)?|auth\.json)$/i.test(event.input.path))
      reason = "Credential file access is blocked by JevCoder. Shell tools are not a sandbox.";
    if (reason) {
      record(current, "blocked", { tool: event.toolName, reason });
      return { block: true, reason, terminate: current.stopped };
    }
    current.used = true;
  });

  pi.on("turn_end", (event, ctx) => {
    const current = owns(ctx);
    if (!current || current.stopped) return;
    if (event.message.role !== "assistant" || ["error", "aborted", "length"].includes(event.message.stopReason)) return;
    if (current.selected?.name === "finish" && event.toolResults.length === 0) {
      record(current, "end", { reason: "finish", independentlyVerified: false });
      current.controller.abort();
      run = undefined;
      ctx.ui.setStatus("jevcoder", undefined);
      return;
    }
    if (event.toolResults.length === 0) {
      // Native Pi stops on prose. Re-enter its loop so Jev can react to missing-context explanations.
      pi.sendMessage({ customType: "jevcoder-continue", display: false,
        content: "The selected action produced no tool result. Reconsider the next action using the latest explanation." },
      { deliverAs: "steer", triggerTurn: true });
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    const current = owns(ctx);
    if (!current) return;
    record(current, "end", { reason: current.outcome ?? "Pi settled before Jev finish; review results." });
    current.controller.abort();
    run = undefined;
    ctx.ui.setStatus("jevcoder", undefined);
  });
  pi.on("session_shutdown", () => { run?.controller.abort(); run?.signalStarted(); run = undefined; });
}
