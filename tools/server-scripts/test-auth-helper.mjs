import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const AUTH_RULES = [];
const ORIGINAL_FETCH = globalThis.fetch.bind(globalThis);
let fetchInstalled = false;

function cookieHeaderFrom(response) {
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : String(response.headers.get("set-cookie") || "")
          .split(/,(?=\s*meshrix_)/)
          .filter(Boolean);
  return setCookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function loginOwner(server) {
  const credentials = await readInitialOwnerCredentials(server);
  assert.ok(credentials.password, "test auth helper requires a newly created server owner password");
  const response = await ORIGINAL_FETCH(`${server.url}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: credentials.username,
      password: credentials.password
    })
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  return {
    cookie: cookieHeaderFrom(response),
    csrf: payload.csrfToken
  };
}

function parseInitialCredentials(content) {
  const username = content.match(/^Username\s*:\s*(.+)$/m)?.[1]?.trim() || "owner";
  const password = content.match(/^Password\s*:\s*(.+)$/m)?.[1]?.trim() || "";
  return {
    username,
    password
  };
}

export async function readInitialOwnerCredentials(server) {
  const inlinePassword = server.initialOwner?.password || "";
  if (inlinePassword) {
    return {
      username: server.initialOwner?.username || "owner",
      password: inlinePassword,
      credentialsPath: ""
    };
  }

  const credentialsPath =
    server.initialOwner?.credentialsPath ||
    server.initialCredentialsPath ||
    (server.userDataPath ? path.join(server.userDataPath, "auth", "initial-credentials.txt") : "");
  if (!credentialsPath) {
    return {
      username: server.initialOwner?.username || "owner",
      password: "",
      credentialsPath: ""
    };
  }

  const content = await fs.readFile(credentialsPath, "utf8").catch(() => "");
  return {
    ...parseInitialCredentials(content),
    credentialsPath
  };
}

function ensureFetchInstalled() {
  if (fetchInstalled) {
    return;
  }
  fetchInstalled = true;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    );
    const rule = AUTH_RULES.find((item) => item.origin === url.origin);
    if (!rule || url.pathname === "/api/auth/login") {
      return ORIGINAL_FETCH(input, init);
    }

    const headers = new Headers(init.headers || {});
    if (!headers.has("Cookie")) {
      headers.set("Cookie", rule.auth.cookie);
    }

    const method = String(init.method || input?.method || "GET").toUpperCase();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      if (!headers.has("x-meshrix-csrf")) {
        headers.set("x-meshrix-csrf", rule.auth.csrf);
      }
      if (rule.safetyConfirm && !headers.has("x-meshrix-safety-confirm")) {
        headers.set("x-meshrix-safety-confirm", "true");
      }
    }

    return ORIGINAL_FETCH(input, {
      ...init,
      headers
    });
  };
}

export async function installAuthenticatedFetch(server, options = {}) {
  const auth = options.auth || await loginOwner(server);
  const origin = new URL(server.url).origin;
  const existing = AUTH_RULES.find((item) => item.origin === origin);
  if (existing) {
    existing.auth = auth;
    existing.safetyConfirm = options.safetyConfirm !== false;
  } else {
    AUTH_RULES.push({
      origin,
      auth,
      safetyConfirm: options.safetyConfirm !== false
    });
  }

  ensureFetchInstalled();
  if (options.setProcessEnv !== false) {
    process.env.MESHRIX_CONSOLE_COOKIE = auth.cookie;
    process.env.MESHRIX_CONSOLE_CSRF = auth.csrf;
    process.env.MESHRIX_SAFETY_CONFIRM = options.safetyConfirm === false ? "" : "1";
  }
  return auth;
}

export function installedAuthFor(serverOrUrl) {
  const value = typeof serverOrUrl === "string" ? serverOrUrl : serverOrUrl?.url;
  if (!value) {
    return null;
  }
  const origin = new URL(value).origin;
  return AUTH_RULES.find((item) => item.origin === origin)?.auth || null;
}

export function authHeaders(auth, { safetyConfirm = true, method = "GET" } = {}) {
  const headers = {
    Cookie: auth.cookie
  };
  if (!["GET", "HEAD", "OPTIONS"].includes(String(method || "GET").toUpperCase())) {
    headers["x-meshrix-csrf"] = auth.csrf;
    if (safetyConfirm) {
      headers["x-meshrix-safety-confirm"] = "true";
    }
  }
  return headers;
}
