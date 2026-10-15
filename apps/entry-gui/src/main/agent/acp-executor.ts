import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";

import { client, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { RequestPermissionRequest, SessionUpdate } from "@agentclientprotocol/sdk";
import type {
  AcpAgentSummary,
  AcpPermissionPrompt,
  PeerApplicationAgentExecutor,
  PeerApplicationExecution,
  PeerApplicationExecutionHandlers,
  PeerApplicationExecutionResult
} from "@meshrix/peer-client";

import type { AcpAgentDefinition, AcpAgentSecretResolver } from "./agent-registry.ts";

function publicPermission(request: RequestPermissionRequest): AcpPermissionPrompt {
  const text = request.toolCall.content?.flatMap((item) => {
    if (item.type === "content" && item.content.type === "text") return [{ type: "text", text: item.content.text }];
    if (item.type === "diff") {
      const before = item.oldText === null || item.oldText === undefined ? "(new file)" : item.oldText;
      return [{ type: "diff", text: `${item.path}\n${before}\n→\n${item.newText}` }];
    }
    if (item.type === "terminal") return [{ type: "terminal", text: `Terminal: ${item.terminalId}` }];
    return [];
  }) ?? [];
  return Object.freeze({
    sessionId: request.sessionId,
    toolCall: Object.freeze({
      toolCallId: request.toolCall.toolCallId,
      title: request.toolCall.title ?? request.toolCall.name ?? "Agent action",
      name: request.toolCall.name ?? null,
      kind: request.toolCall.kind ?? null,
      status: request.toolCall.status ?? null,
      content: Object.freeze(text.map((item) => Object.freeze(item))),
      rawInput: request.toolCall.rawInput ?? null,
      locations: Object.freeze((request.toolCall.locations ?? []).map((location) => Object.freeze({
        path: location.path,
        line: location.line ?? null
      })))
    }),
    options: Object.freeze(request.options.map((option) => Object.freeze({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind
    })))
  });
}

function progress(update: SessionUpdate): { readonly kind: "message" | "tool" | "plan" | "state"; readonly text: string } | null {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return update.content.type === "text" ? { kind: "message", text: update.content.text } : null;
    case "tool_call":
    case "tool_call_update":
      return { kind: "tool", text: "Agent is working with a tool." };
    case "plan":
    case "plan_update":
    case "plan_removed":
      return { kind: "plan", text: "Agent updated its plan." };
    default:
      return null;
  }
}

function runtimeEnvironment(configured: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  const allowed = ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "SystemRoot", "ComSpec", "PATHEXT"];
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) inherited[key] = value;
  }
  return Object.assign(inherited, configured);
}

async function resolveEnvironment(
  definition: AcpAgentDefinition,
  secretResolver: AcpAgentSecretResolver
): Promise<NodeJS.ProcessEnv> {
  const resolved: Record<string, string> = {};
  for (const [name, source] of Object.entries(definition.environment)) {
    const value = source.kind === "host_environment"
      ? process.env[source.variable] ?? null
      : await secretResolver.resolve(source.reference);
    if (value === null) throw new Error("A configured Agent environment source is unavailable.");
    resolved[name] = value;
  }
  return runtimeEnvironment(resolved);
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  if (error instanceof Error && error.name) return error.name;
  return "agent_execution_failed";
}

/** Executes one registered local ACP command over the official ACP v1 SDK. */
export class AcpSubprocessExecutor implements PeerApplicationAgentExecutor {
  readonly definition: AcpAgentDefinition;
  readonly summary: AcpAgentSummary;
  readonly #secretResolver: AcpAgentSecretResolver;

  constructor(definition: AcpAgentDefinition, secretResolver: AcpAgentSecretResolver) {
    this.definition = definition;
    this.summary = Object.freeze({
      id: definition.id,
      displayName: definition.displayName,
      description: definition.description,
      enabled: definition.enabled
    });
    this.#secretResolver = secretResolver;
  }

  start(
    input: { readonly operationId: string; readonly prompt: string },
    handlers: PeerApplicationExecutionHandlers
  ): PeerApplicationExecution {
    let child: ChildProcess | null = null;
    let clientContext: { notify(method: string, params?: unknown): Promise<void> } | null = null;
    let sessionId: string | null = null;
    let cancelRequested = false;
    let terminated = false;

    const terminate = (): void => {
      if (terminated) return;
      terminated = true;
      if (child && child.exitCode === null && !child.killed) child.kill();
    };

    const run = async (runHandlers: PeerApplicationExecutionHandlers): Promise<PeerApplicationExecutionResult> => {
      let accumulatedText = "";
      const env = await resolveEnvironment(this.definition, this.#secretResolver);
      child = spawn(this.definition.command, [...this.definition.args], {
        cwd: this.definition.cwd,
        env,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        shell: process.platform === "win32"
      });
      const processHandle = child;
      if (!processHandle.stdin || !processHandle.stdout) {
        throw new Error("The local ACP process did not provide its standard input and output streams.");
      }
      const exit = new Promise<never>((_resolve, reject) => {
        processHandle.once("error", reject);
        processHandle.once("close", (code, signal) => {
          const error = new Error("The local ACP process closed before the session completed.");
          Object.assign(error, { code: signal ? `process_${signal}` : `process_exit_${String(code)}` });
          reject(error);
        });
      });
      const stream = ndJsonStream(
        Writable.toWeb(processHandle.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(processHandle.stdout) as ReadableStream<Uint8Array>
      );
      const acpClient = client({ name: "Meshrix" }).onRequest(
        methods.client.session.requestPermission,
        async ({ params }) => {
          const decision = await runHandlers.requestPermission(publicPermission(params));
          return {
            outcome: decision.outcome === "cancelled"
              ? { outcome: "cancelled" as const }
              : { outcome: "selected" as const, optionId: decision.optionId }
          };
        }
      );

      try {
        const result = await Promise.race([
          acpClient.connectWith(stream, async (context) => {
            clientContext = context;
            const initialized = await context.request(methods.agent.initialize, {
              protocolVersion: PROTOCOL_VERSION,
              clientCapabilities: {},
              clientInfo: { name: "Meshrix", version: "0.1.0" }
            });
            if (initialized.protocolVersion !== PROTOCOL_VERSION) throw new Error("The ACP agent negotiated an unsupported protocol version.");
            return context.buildSession(this.definition.cwd).withSession(async (session) => {
              sessionId = session.sessionId;
              if (cancelRequested) await context.notify(methods.agent.session.cancel, { sessionId });
              await runHandlers.beforePrompt();
              const promptFailure = session.prompt(input.prompt).then(
                () => new Promise<never>(() => {}),
                (error: unknown) => Promise.reject(error)
              );
              for (;;) {
                const message = await Promise.race([
                  session.nextUpdate(),
                  promptFailure
                ]);
                if (message.kind === "stop") return message.response;
                const item = progress(message.update);
                if (item) {
                  if (item.kind === "message") accumulatedText += item.text;
                  await runHandlers.onProgress(item);
                }
              }
            });
          }),
          exit
        ]);
        return Object.freeze({ stopReason: result.stopReason, text: accumulatedText });
      } finally {
        terminate();
      }
    };

    const result = run(handlers).catch((error: unknown) => {
      terminate();
      const safe = new Error("The local ACP process could not complete the operation.");
      Object.assign(safe, { code: safeErrorCode(error) });
      throw safe;
    });

    return Object.freeze({
      result,
      async cancel() {
        cancelRequested = true;
        if (clientContext && sessionId) await clientContext.notify(methods.agent.session.cancel, { sessionId });
      }
    });
  }
}
