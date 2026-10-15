import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { ensurePrivateDir, writePrivateFileAtomic } from "@meshrix/foundation/storage/private-file-atomic";
import type {
  AcpAgentSummary,
  PeerApplicationAgentDirectory,
  PeerApplicationAgentExecutor
} from "@meshrix/peer-client";

import { AcpSubprocessExecutor } from "./acp-executor.ts";

export type AcpEnvironmentSource =
  | { readonly kind: "host_environment"; readonly variable: string }
  | { readonly kind: "secret_reference"; readonly reference: string };

/** Local-only execution authority. Remote MCP input can select only this id. */
export interface AcpAgentDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Environment values are resolved at launch and are never written here. */
  readonly environment: Readonly<Record<string, AcpEnvironmentSource>>;
  readonly permissionPolicy: "ask";
  readonly enabled: boolean;
}

export type AcpAgentDefinitionInput = Omit<AcpAgentDefinition, "id" | "enabled"> & {
  readonly id?: string;
  readonly enabled?: boolean;
};

export type AcpAgentDefinitionUpdate = Partial<Omit<AcpAgentDefinition, "id">>;

export interface AcpAgentSecretResolver {
  resolve(reference: string): Promise<string | null>;
}

interface RegistryDocument {
  readonly version: 1;
  readonly agents: Readonly<Record<string, AcpAgentDefinition>>;
}

interface RegistryMutation<T> {
  readonly document: RegistryDocument | null;
  readonly value: T;
}

const EMPTY_REGISTRY: RegistryDocument = Object.freeze({ version: 1, agents: Object.freeze({}) });
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function validateDefinition(input: AcpAgentDefinitionInput, existingId?: string): AcpAgentDefinition {
  const id = existingId ?? input.id ?? `agent.${randomUUID()}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u.test(id)) throw new Error("Agent id is invalid.");
  if (typeof input.displayName !== "string" || input.displayName.trim().length === 0 || Buffer.byteLength(input.displayName, "utf8") > 256) {
    throw new Error("Agent display name is invalid.");
  }
  if (input.description !== null && (typeof input.description !== "string" || Buffer.byteLength(input.description, "utf8") > 2048)) {
    throw new Error("Agent description is invalid.");
  }
  if (typeof input.command !== "string" || input.command.trim().length === 0 || Buffer.byteLength(input.command, "utf8") > 2048) {
    throw new Error("Agent command is invalid.");
  }
  if (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== "string" || Buffer.byteLength(arg, "utf8") > 8192)) {
    throw new Error("Agent command arguments are invalid.");
  }
  if (typeof input.cwd !== "string" || !path.isAbsolute(input.cwd)) throw new Error("Agent working directory must be absolute.");
  if (input.permissionPolicy !== "ask") throw new Error("Agent permission policy must require explicit approval.");
  const environment: Record<string, AcpEnvironmentSource> = {};
  for (const [name, source] of Object.entries(input.environment)) {
    if (!ENV_NAME.test(name) || typeof source !== "object" || source === null) throw new Error("Agent environment mapping is invalid.");
    if (source.kind === "host_environment" && ENV_NAME.test(source.variable)) {
      environment[name] = Object.freeze({ kind: "host_environment", variable: source.variable });
    } else if (source.kind === "secret_reference" && /^[A-Za-z0-9][A-Za-z0-9._:-]{1,250}$/u.test(source.reference)) {
      environment[name] = Object.freeze({ kind: "secret_reference", reference: source.reference });
    } else {
      throw new Error("Agent environment source is invalid.");
    }
  }
  return Object.freeze({
    id,
    displayName: input.displayName.trim(),
    description: input.description?.trim() || null,
    command: input.command,
    args: Object.freeze([...input.args]),
    cwd: path.resolve(input.cwd),
    environment: Object.freeze(environment),
    permissionPolicy: "ask",
    enabled: input.enabled ?? true
  });
}

function summaryOf(definition: AcpAgentDefinition): AcpAgentSummary {
  return Object.freeze({
    id: definition.id,
    displayName: definition.displayName,
    description: definition.description,
    enabled: definition.enabled
  });
}

/** Owner-only command registry and generic ACP subprocess directory. */
export class FileAcpAgentRegistry implements PeerApplicationAgentDirectory {
  readonly #filePath: string;
  readonly #secretResolver: AcpAgentSecretResolver;
  readonly #executors = new Map<string, AcpSubprocessExecutor>();
  #document: RegistryDocument | null = null;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(options: { readonly filePath: string; readonly secretResolver: AcpAgentSecretResolver }) {
    if (typeof options.filePath !== "string" || options.filePath.length === 0) throw new Error("An agent registry file is required.");
    this.#filePath = path.resolve(options.filePath);
    this.#secretResolver = options.secretResolver;
    ensurePrivateDir(path.dirname(this.#filePath));
  }

  async #load(): Promise<RegistryDocument> {
    if (this.#document !== null) return this.#document;
    let text: string;
    try {
      text = await readFile(this.#filePath, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.#document = EMPTY_REGISTRY;
        return EMPTY_REGISTRY;
      }
      throw error;
    }
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Agent registry document is malformed.");
    const document = value as Record<string, unknown>;
    if (document.version !== 1 || typeof document.agents !== "object" || document.agents === null || Array.isArray(document.agents)) {
      throw new Error("Agent registry document is unsupported.");
    }
    const agents: Record<string, AcpAgentDefinition> = {};
    for (const [id, candidate] of Object.entries(document.agents)) {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) throw new Error("Agent registry entry is malformed.");
      agents[id] = validateDefinition(candidate as AcpAgentDefinitionInput, id);
    }
    this.#document = Object.freeze({ version: 1, agents: Object.freeze(agents) });
    return this.#document;
  }

  async #mutate<T>(operation: (document: RegistryDocument) => RegistryMutation<T>): Promise<T> {
    const current = this.#writeTail.then(async () => {
      const { document, value } = operation(await this.#load());
      if (document !== null) {
        await writePrivateFileAtomic(this.#filePath, `${JSON.stringify(document)}\n`);
        this.#document = document;
      }
      return value;
    });
    this.#writeTail = current.then(() => undefined, () => undefined);
    return current;
  }

  async register(input: AcpAgentDefinitionInput): Promise<AcpAgentSummary> {
    const definition = validateDefinition(input);
    return this.#mutate((document) => {
      if (document.agents[definition.id]) throw new Error("An Agent with this id already exists.");
      return {
        document: Object.freeze({ version: 1, agents: Object.freeze({ ...document.agents, [definition.id]: definition }) }),
        value: summaryOf(definition)
      };
    }).then((summary) => {
      this.#executors.delete(definition.id);
      return summary;
    });
  }

  async update(id: string, patch: AcpAgentDefinitionUpdate): Promise<AcpAgentSummary> {
    return this.#mutate((document) => {
      const previous = document.agents[id];
      if (!previous) throw new Error("The local Agent does not exist.");
      const definition = validateDefinition({ ...previous, ...patch, id }, id);
      return {
        document: Object.freeze({ version: 1, agents: Object.freeze({ ...document.agents, [id]: definition }) }),
        value: summaryOf(definition)
      };
    }).then((summary) => {
      this.#executors.delete(id);
      return summary;
    });
  }

  async remove(id: string): Promise<boolean> {
    const removed = await this.#mutate((document) => {
      if (!document.agents[id]) return { document: null, value: false };
      const agents = { ...document.agents };
      delete agents[id];
      return {
        document: Object.freeze({ version: 1, agents: Object.freeze(agents) }),
        value: true
      };
    });
    if (removed) this.#executors.delete(id);
    return removed;
  }

  async list(): Promise<readonly AcpAgentSummary[]> {
    const document = await this.#load();
    return Object.freeze(Object.values(document.agents).map(summaryOf));
  }

  get(agentId: string): PeerApplicationAgentExecutor | null {
    const definition = this.#document?.agents[agentId];
    if (!definition?.enabled) return null;
    let executor = this.#executors.get(agentId);
    if (!executor || executor.definition !== definition) {
      executor = new AcpSubprocessExecutor(definition, this.#secretResolver);
      this.#executors.set(agentId, executor);
    }
    return executor;
  }

  async resolveDefinition(agentId: string): Promise<AcpAgentDefinition | null> {
    return (await this.#load()).agents[agentId] ?? null;
  }
}
