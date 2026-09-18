import { createHash } from "node:crypto";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { supportsApi } from "./jev.ts";

type Messages = ContextEvent["messages"];
export type ControlMessage = Extract<Messages[number], { role: "custom" }>;

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
}

export function sameToolNames(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

/** Context transforms are not persisted by Pi. Replay controls at their original
 * message boundaries, not as a replacement suffix. This makes successive model
 * contexts append-only while leaving ordinary Pi prompts/session history intact.
 * Compaction/rewrites must stop the run rather than misplace historical controls.
 */
export class AppendOnlyControls {
  private baseHashes: string[] = [];
  private controls: { after: number; message: ControlMessage }[] = [];

  project(messages: Messages): Messages {
    if (messages.length < this.baseHashes.length ||
        this.baseHashes.some((hash, i) => fingerprint(messages[i]) !== hash)) {
      throw new Error("Conversation prefix changed during JevCoder. Restart after compaction or history transforms.");
    }
    const result: Messages = [];
    let from = 0;
    for (const control of this.controls) {
      result.push(...messages.slice(from, control.after), structuredClone(control.message));
      from = control.after;
    }
    result.push(...messages.slice(from));
    return result;
  }

  append(messages: Messages, message: ControlMessage): Messages {
    const result = this.project(messages);
    this.baseHashes = messages.map(fingerprint);
    this.controls.push({ after: messages.length, message: structuredClone(message) });
    return [...result, structuredClone(message)];
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function toolName(value: unknown, api: string): string | undefined {
  const tool = object(value);
  const name = api === "openai-completions" ? object(tool?.function)?.name : tool?.name;
  if (tool?.type === "namespace" || tool?.defer_loading === true) return undefined;
  return typeof name === "string" ? name : undefined;
}

function leadingInstructions(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const result: unknown[] = [];
  for (const message of value) {
    const role = object(message)?.role;
    if (role !== "system" && role !== "developer") break;
    result.push(message);
  }
  return result;
}

/** Keep native schemas (including their order and cache annotations) untouched.
 * Never replay a saved tool definition: that could undo another policy's revocation.
 * Validate the prefix, set constant call options, and enforce selection in tool_call.
 */
export class StableToolPrefix {
  private hash?: string;

  get sha256(): string | undefined { return this.hash; }

  prepare(payload: unknown, api: string, expectedTools: readonly string[]): Record<string, unknown> {
    if (!supportsApi(api)) throw new Error(`Unsupported Pi model API: ${api}`);
    const request = object(payload);
    if (!request) throw new Error("Unexpected provider payload.");
    if (request.tools !== undefined && !Array.isArray(request.tools)) throw new Error("Unexpected provider tool schemas.");
    const tools = (request.tools ?? []) as unknown[];
    const names = tools.map(tool => toolName(tool, api));
    if (names.some(name => name === undefined) || !sameToolNames(names as string[], expectedTools)) {
      throw new Error("Provider tool schemas do not match the run's active tools. Missing, added, namespaced, or deferred tools are unsupported.");
    }
    if (tools.length && request.tool_choice !== undefined && request.tool_choice !== "auto" && object(request.tool_choice)?.type !== "auto") {
      throw new Error("Conflicting provider tool_choice policy. JevCoder will not broaden another policy's restrictions.");
    }
    const choice = request.tool_choice ?? (tools.length ? (api === "anthropic-messages" ? { type: "auto" } : "auto") : undefined);
    const hash = fingerprint({ api, model: request.model, tools: request.tools, toolChoice: choice,
      system: request.system, instructions: request.instructions,
      messages: leadingInstructions(request.messages), input: leadingInstructions(request.input) });
    if (this.hash !== undefined && this.hash !== hash) {
      throw new Error("Provider tool/system prefix changed during JevCoder. Restart with a stable configuration.");
    }
    this.hash = hash;
    if (!tools.length) return request; // Native no-tool request; don't invent provider options.
    return { ...request,
      // Always auto, even on finish. Changing choices/tool sets is not needed for
      // execution safety, and the LLM must be able to explain missing context.
      tool_choice: choice,
      ...(api === "anthropic-messages" ? {} : { parallel_tool_calls: false }),
    };
  }
}
