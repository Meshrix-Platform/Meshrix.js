import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { normalizeBaseUrl, option } from "./basic-utils.js";
import { HTTP_TIMEOUT_MS, packageJson } from "./constants.js";
import { authHeaders } from "./discovery.js";
import { processIdentityHeaders } from "./process-identity-request.js";
import { resolveProxyCredentials } from "./proxy-command.js";
// Mirrors the 2 GiB artifact limit enforced by the gateway artifact download
// route (see docs/functionality/GATEWAY.md).
export const MCP_FETCH_MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const ARTIFACT_ROUTE_PATTERN = /^\/api\/gateway\/v1\/artifacts\/[^/]+$/u;
const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9._~-]+$/u;
function redactOutputPath(value) {
    const text = String(value || "");
    if (path.isAbsolute(text)) {
        return `<local-path>/${path.basename(text) || "artifact.bin"}`;
    }
    return text;
}
export function resolveArtifactUrl(options = {}, identity = null) {
    const raw = String(option(options, "artifact", "")).trim();
    if (!raw) {
        throw new Error("Missing artifact. Pass --artifact <url-or-id> and --out <path>.");
    }
    const storedBaseUrl = normalizeBaseUrl(identity?.baseUrl || "");
    let candidate = raw;
    if (!/^https?:\/\//iu.test(candidate)) {
        if (!ARTIFACT_ID_PATTERN.test(candidate)) {
            throw new Error("Artifact id is invalid.");
        }
        if (!storedBaseUrl) {
            throw new Error("A bare artifact id requires the stored credential server URL; pass the full artifact URL instead.");
        }
        candidate = `${storedBaseUrl}/api/gateway/v1/artifacts/${encodeURIComponent(candidate)}`;
    }
    let parsed;
    try {
        parsed = new URL(candidate);
    }
    catch {
        throw new Error("Artifact URL is invalid.");
    }
    if (!ARTIFACT_ROUTE_PATTERN.test(parsed.pathname)) {
        throw new Error("Artifact URL must target /api/gateway/v1/artifacts/<id>.");
    }
    if (storedBaseUrl) {
        let issuerOrigin;
        try {
            issuerOrigin = new URL(storedBaseUrl).origin;
        }
        catch {
            issuerOrigin = "";
        }
        if (issuerOrigin && parsed.origin !== issuerOrigin) {
            throw new Error("Artifact URL origin does not match the stored credential issuer.");
        }
    }
    let artifactId = "";
    try {
        artifactId = decodeURIComponent(parsed.pathname.split("/").pop() || "");
    }
    catch {
        artifactId = parsed.pathname.split("/").pop() || "";
    }
    return { url: parsed.toString(), artifactId };
}
function requiredOutputPath(options = {}) {
    const outputPath = String(option(options, "out", "")).trim();
    if (!outputPath) {
        throw new Error("Missing output path. Pass --out <path>.");
    }
    return path.resolve(outputPath);
}
function digestHeaderSha256(headers) {
    const raw = String(headers?.get?.("digest") || headers?.get?.("repr-digest") || "");
    const match = /sha-256\s*=\s*"?(:?[A-Za-z0-9+/=_-]+:?)"?/iu.exec(raw);
    if (!match) {
        return "";
    }
    const value = match[1].replace(/:/gu, "").trim();
    if (/^[a-f0-9]{64}$/iu.test(value)) {
        return value.toLowerCase();
    }
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 ? decoded.toString("hex") : "";
}
async function responseErrorReason(response) {
    const detail = (await response.text().catch(() => "")).slice(0, 512);
    try {
        const payload = JSON.parse(detail);
        return String(payload?.error?.message || payload?.error || `HTTP ${response.status}`);
    }
    catch {
        return `HTTP ${response.status}`;
    }
}
async function commitTemporaryFile(temporaryPath, outputPath) {
    try {
        await fsp.link(temporaryPath, outputPath);
    }
    catch (error) {
        await fsp.rm(temporaryPath, { force: true });
        if (error?.code === "EEXIST") {
            throw new Error("Output path already exists.");
        }
        throw error;
    }
    await fsp.rm(temporaryPath, { force: true });
}
async function streamResponseToFile(response, outputPath) {
    const temporaryPath = `${outputPath}.part-${randomBytes(6).toString("hex")}`;
    const hash = createHash("sha256");
    let byteLength = 0;
    const fileStream = fs.createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 });
    try {
        await pipeline(Readable.fromWeb(response.body), new Transform({
            transform(chunk, _encoding, callback) {
                byteLength += chunk.length;
                if (byteLength > MCP_FETCH_MAX_ARTIFACT_BYTES) {
                    callback(new Error("Artifact exceeds the 2 GiB gateway artifact limit."));
                    return;
                }
                hash.update(chunk);
                callback(null, chunk);
            }
        }), fileStream);
    }
    catch (error) {
        fileStream.destroy();
        await fsp.rm(temporaryPath, { force: true });
        throw error;
    }
    return {
        temporaryPath,
        byteLength,
        sha256: hash.digest("hex")
    };
}
export async function fetchCommand(options = {}) {
    const { target, token, identity } = await resolveProxyCredentials(options);
    const { url, artifactId } = resolveArtifactUrl(options, identity);
    const outputPath = requiredOutputPath(options);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
        const error = new Error(`HTTP request timed out after ${HTTP_TIMEOUT_MS} ms.`);
        error.name = "TimeoutError";
        controller.abort(error);
    }, HTTP_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            method: "GET",
            redirect: "error",
            signal: controller.signal,
            headers: {
                ...authHeaders(token, target),
                ...processIdentityHeaders({
                    method: "GET",
                    url: new URL(url),
                    body: "",
                    identity
                })
            }
        });
        if (!response.ok) {
            const reason = await responseErrorReason(response);
            throw new Error(`Meshrix artifact fetch failed: ${reason}`);
        }
        const contentLength = Number(response.headers.get("content-length") || "");
        if (Number.isSafeInteger(contentLength) && contentLength > MCP_FETCH_MAX_ARTIFACT_BYTES) {
            response.body?.cancel().catch(() => { });
            throw new Error("Artifact exceeds the 2 GiB gateway artifact limit.");
        }
        const expectedDigest = digestHeaderSha256(response.headers);
        const streamed = await streamResponseToFile(response, outputPath);
        if (expectedDigest && streamed.sha256 !== expectedDigest) {
            await fsp.rm(streamed.temporaryPath, { force: true });
            throw new Error("Meshrix artifact fetch failed: response Digest header did not match the downloaded bytes.");
        }
        await commitTemporaryFile(streamed.temporaryPath, outputPath);
        return {
            ok: true,
            packageName: packageJson.name,
            packageVersion: packageJson.version,
            target,
            artifactId,
            outputPath: redactOutputPath(outputPath),
            byteLength: streamed.byteLength,
            sha256: streamed.sha256,
            digestVerified: Boolean(expectedDigest)
        };
    }
    finally {
        clearTimeout(timeout);
    }
}
//# sourceMappingURL=fetch-command.js.map