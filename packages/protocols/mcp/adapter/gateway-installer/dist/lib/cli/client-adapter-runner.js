import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MCP_CLIENT_ADAPTER_PROTOCOL, mcpClientAdapterForTarget } from "../../mcp-release-targets.js";
import { INSTALL_COMMAND_TIMEOUT_MS } from "./constants.js";
import { connectorLaunchSpec, runInstallCommand, runWithInput } from "./connector-process.js";
import { readJson, writeJson } from "./device-discovery-registry.js";
import { redactSensitiveText } from "./installer-output-safety.js";
export const CLIENT_ADAPTER_DESCRIPTOR_SCHEMA = "v0.0.1:meshrix:client-adapter-descriptor-1";
export const CLIENT_ADAPTER_MAX_MESSAGE_BYTES = 256 * 1024;
const CLIENT_ADAPTER_ACTIONS = new Set(["describe", "scan", "install", "verify", "uninstall"]);
function adapterError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}
function safeTargetPathPart(value) {
    const text = String(value || "");
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(text)) {
        throw adapterError("CLIENT_ADAPTER_TARGET_INVALID", "Client adapter target is invalid.");
    }
    return text;
}
function packageDirectory(root, packageName) {
    const segments = String(packageName || "").split("/").filter(Boolean);
    if (segments.length === 0 || segments.some((segment) => !/^@?[A-Za-z0-9._-]+$/u.test(segment))) {
        throw adapterError("CLIENT_ADAPTER_PACKAGE_INVALID", "Client adapter package coordinate is invalid.");
    }
    return path.join(root, "node_modules", ...segments);
}
export function defaultClientAdapterCacheRoot() {
    return path.join(os.homedir(), ".meshrix", "mcp", "client-adapters");
}
function cachePaths(cacheRoot, target, version) {
    const safeTarget = safeTargetPathPart(target);
    if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(String(version || ""))) {
        throw adapterError("CLIENT_ADAPTER_VERSION_INVALID", "Client adapter version is invalid.");
    }
    const root = path.join(path.resolve(cacheRoot), safeTarget, String(version));
    return {
        root,
        tree: path.join(root, "tree"),
        metadata: path.join(root, "cache.json")
    };
}
async function collectTreeEntries(root, current = root) {
    const entries = [];
    for (const item of await fs.readdir(current, { withFileTypes: true })) {
        const absolute = path.join(current, item.name);
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        if (item.isDirectory()) {
            entries.push({ type: "directory", relative });
            entries.push(...await collectTreeEntries(root, absolute));
        }
        else if (item.isFile()) {
            entries.push({ type: "file", relative, absolute });
        }
        else if (item.isSymbolicLink()) {
            entries.push({ type: "symlink", relative, target: await fs.readlink(absolute) });
        }
        else {
            throw adapterError("CLIENT_ADAPTER_CACHE_INVALID", "Client adapter cache contains an unsupported file type.");
        }
    }
    return entries.sort((left, right) => left.relative.localeCompare(right.relative));
}
export async function digestClientAdapterTree(root) {
    const hash = createHash("sha256");
    for (const entry of await collectTreeEntries(root)) {
        hash.update(`${entry.type}\0${entry.relative}\0`);
        if (entry.type === "file")
            hash.update(await fs.readFile(entry.absolute));
        if (entry.type === "symlink")
            hash.update(entry.target);
        hash.update("\0");
    }
    return hash.digest("hex");
}
async function validateInstalledPackage(tree, adapter) {
    const packageRoot = packageDirectory(tree, adapter.packageName);
    const manifest = await readJson(path.join(packageRoot, "package.json"), null);
    if (manifest?.name !== adapter.packageName || manifest?.version !== adapter.version) {
        throw adapterError("CLIENT_ADAPTER_PACKAGE_MISMATCH", "Installed client adapter package identity does not match the trusted coordinate.");
    }
    const entrypoint = path.resolve(packageRoot, adapter.entrypoint);
    if (!entrypoint.startsWith(`${path.resolve(packageRoot)}${path.sep}`)) {
        throw adapterError("CLIENT_ADAPTER_ENTRYPOINT_INVALID", "Client adapter entrypoint escapes its package root.");
    }
    const stat = await fs.stat(entrypoint).catch(() => null);
    if (!stat?.isFile()) {
        throw adapterError("CLIENT_ADAPTER_ENTRYPOINT_MISSING", "Client adapter entrypoint is missing.");
    }
    return { packageRoot, entrypoint };
}
async function readVerifiedCache(paths, adapter) {
    const metadata = await readJson(paths.metadata, null);
    if (metadata?.schemaVersion !== "v0.0.1:meshrix:client-adapter-cache-1" ||
        metadata?.target !== adapter.target ||
        metadata?.coordinate !== adapter.coordinate ||
        !/^[a-f0-9]{64}$/u.test(String(metadata?.sha256 || ""))) {
        return null;
    }
    const installed = await validateInstalledPackage(paths.tree, adapter).catch(() => null);
    if (!installed)
        return null;
    const digest = await digestClientAdapterTree(paths.tree).catch(() => "");
    if (digest !== metadata.sha256)
        return null;
    return { ...installed, sha256: digest, cacheHit: true };
}
async function installNpmPackage(adapter, tree) {
    if (adapter.integrity) {
        const viewed = await runInstallCommand(process.env.NPM_CLI_PATH || "npm", [
            "view", adapter.coordinate, "dist.integrity", "--json"
        ]);
        let publishedIntegrity = "";
        try {
            publishedIntegrity = JSON.parse(String(viewed.stdout || "").trim());
        }
        catch { }
        if (publishedIntegrity !== adapter.integrity) {
            throw adapterError("CLIENT_ADAPTER_INTEGRITY_MISMATCH", "Client adapter package integrity does not match the trusted release index.");
        }
    }
    await fs.mkdir(tree, { recursive: true, mode: 0o700 });
    await runInstallCommand(process.env.NPM_CLI_PATH || "npm", [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--omit=dev",
        "--no-save",
        "--package-lock=false",
        "--prefix",
        tree,
        adapter.coordinate
    ]);
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function acquireCacheLock(paths, adapter) {
    const lockPath = `${paths.root}.lock`;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
            await fs.mkdir(lockPath, { recursive: false, mode: 0o700 });
            return { lockPath, cached: null };
        }
        catch (error) {
            if (error?.code !== "EEXIST")
                throw error;
            const cached = await readVerifiedCache(paths, adapter);
            if (cached)
                return { lockPath: "", cached };
            await delay(100);
        }
    }
    throw adapterError("CLIENT_ADAPTER_CACHE_BUSY", "Client adapter cache is busy.");
}
export async function acquireClientAdapter({ target, cacheRoot = defaultClientAdapterCacheRoot(), installPackage = installNpmPackage } = {}) {
    const trusted = mcpClientAdapterForTarget(target);
    if (!trusted) {
        throw adapterError("CLIENT_ADAPTER_TARGET_UNSUPPORTED", "Client adapter target is not trusted by this connector release.");
    }
    const adapter = { ...trusted, target };
    const paths = cachePaths(cacheRoot, target, adapter.version);
    const cached = await readVerifiedCache(paths, adapter);
    if (cached)
        return { ...cached, adapter };
    await fs.mkdir(path.dirname(paths.root), { recursive: true, mode: 0o700 });
    const lock = await acquireCacheLock(paths, adapter);
    if (lock.cached)
        return { ...lock.cached, adapter };
    const cachedAfterLock = await readVerifiedCache(paths, adapter);
    if (cachedAfterLock) {
        await fs.rm(lock.lockPath, { recursive: true, force: true });
        return { ...cachedAfterLock, adapter };
    }
    const stagingRoot = `${paths.root}.staging-${process.pid}-${randomUUID()}`;
    const stagingTree = path.join(stagingRoot, "tree");
    try {
        await installPackage(adapter, stagingTree);
        const installed = await validateInstalledPackage(stagingTree, adapter);
        const sha256 = await digestClientAdapterTree(stagingTree);
        await writeJson(path.join(stagingRoot, "cache.json"), {
            schemaVersion: "v0.0.1:meshrix:client-adapter-cache-1",
            target,
            coordinate: adapter.coordinate,
            sha256
        });
        await fs.rm(paths.root, { recursive: true, force: true });
        await fs.rename(stagingRoot, paths.root);
        return {
            packageRoot: installed.packageRoot.replace(stagingTree, paths.tree),
            entrypoint: installed.entrypoint.replace(stagingTree, paths.tree),
            sha256,
            cacheHit: false,
            adapter
        };
    }
    catch (error) {
        await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => { });
        throw error;
    }
    finally {
        await fs.rm(lock.lockPath, { recursive: true, force: true }).catch(() => { });
    }
}
function assertSecretFreeRequest(value, pathParts = []) {
    if (Array.isArray(value)) {
        value.forEach((child, index) => assertSecretFreeRequest(child, [...pathParts, String(index)]));
        return;
    }
    if (!value || typeof value !== "object")
        return;
    for (const [key, child] of Object.entries(value)) {
        const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
        const allowedReference = normalized === "tokenenv" || normalized.endsWith("ref");
        if (!allowedReference && /(token|secret|password|privatekey|authorization|apikey)/u.test(normalized)) {
            throw adapterError("CLIENT_ADAPTER_SECRET_REJECTED", `Client adapter request field ${[...pathParts, key].join(".")} is not allowed.`);
        }
        assertSecretFreeRequest(child, [...pathParts, key]);
    }
}
function parseAdapterResponse(output) {
    if (Buffer.byteLength(output) > CLIENT_ADAPTER_MAX_MESSAGE_BYTES) {
        throw adapterError("CLIENT_ADAPTER_RESPONSE_TOO_LARGE", "Client adapter response exceeded the protocol limit.");
    }
    let response;
    try {
        response = JSON.parse(String(output || "").trim());
    }
    catch {
        throw adapterError("CLIENT_ADAPTER_RESPONSE_INVALID", "Client adapter returned invalid JSON.");
    }
    if (response?.schemaVersion !== MCP_CLIENT_ADAPTER_PROTOCOL || typeof response?.ok !== "boolean") {
        throw adapterError("CLIENT_ADAPTER_RESPONSE_INVALID", "Client adapter response does not match the protocol schema.");
    }
    if (response.ok !== true) {
        throw adapterError(String(response?.error?.code || "CLIENT_ADAPTER_FAILED"), redactSensitiveText(response?.error?.message || "Client adapter operation failed."));
    }
    if (!response.result || typeof response.result !== "object" || Array.isArray(response.result)) {
        throw adapterError("CLIENT_ADAPTER_RESPONSE_INVALID", "Client adapter response result is missing.");
    }
    return response.result;
}
export async function runClientAdapter({ target, action, request = {}, cacheRoot = defaultClientAdapterCacheRoot(), installPackage } = {}) {
    if (!CLIENT_ADAPTER_ACTIONS.has(action)) {
        throw adapterError("CLIENT_ADAPTER_ACTION_INVALID", "Client adapter action is invalid.");
    }
    const payload = { schemaVersion: MCP_CLIENT_ADAPTER_PROTOCOL, ...request };
    assertSecretFreeRequest(payload);
    const input = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(input) > CLIENT_ADAPTER_MAX_MESSAGE_BYTES) {
        throw adapterError("CLIENT_ADAPTER_REQUEST_TOO_LARGE", "Client adapter request exceeded the protocol limit.");
    }
    const acquired = await acquireClientAdapter({ target, cacheRoot, installPackage });
    const executed = await runWithInput(process.execPath, [acquired.entrypoint, action], input, {
        allowFailure: true,
        cleanEnv: true,
        timeoutMs: INSTALL_COMMAND_TIMEOUT_MS
    });
    if (!executed.ok) {
        throw adapterError("CLIENT_ADAPTER_PROCESS_FAILED", redactSensitiveText(executed.stderr || "Client adapter process failed."));
    }
    return {
        result: parseAdapterResponse(executed.stdout),
        cache: { hit: acquired.cacheHit, sha256: acquired.sha256 },
        adapter: acquired.adapter
    };
}
export function clientAdapterConnectorRequest({ baseUrl, tokenEnv, client = {} } = {}) {
    const connector = connectorLaunchSpec();
    return {
        baseUrl,
        tokenEnv,
        connector: {
            command: connector.command,
            args: [...connector.args]
        },
        client
    };
}
export async function describeClientAdapter(options = {}) {
    const executed = await runClientAdapter({ ...options, action: "describe", request: {} });
    const descriptor = executed.result;
    if (descriptor.schemaVersion !== CLIENT_ADAPTER_DESCRIPTOR_SCHEMA ||
        descriptor.protocol !== MCP_CLIENT_ADAPTER_PROTOCOL ||
        descriptor.target !== options.target ||
        descriptor.packageName !== executed.adapter.packageName ||
        descriptor.version !== executed.adapter.version ||
        !Array.isArray(descriptor.commandNames) ||
        !Array.isArray(descriptor.actions) ||
        ![...CLIENT_ADAPTER_ACTIONS].every((action) => descriptor.actions.includes(action)) ||
        JSON.stringify(descriptor.locations) !== JSON.stringify(["local"])) {
        throw adapterError("CLIENT_ADAPTER_DESCRIPTOR_MISMATCH", "Client adapter descriptor does not match its trusted target identity.");
    }
    return executed;
}
//# sourceMappingURL=client-adapter-runner.js.map