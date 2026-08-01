import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const AUTH_RULES: any[] = [];
const ORIGINAL_FETCH: any = globalThis.fetch.bind(globalThis);
let fetchInstalled: any = false;

function cookieHeaderFrom(response?: any) : any {
  const setCookies: any =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : String(response.headers.get("set-cookie") || "")
          .split(/,(?=\s*meshrix_)/)
          .filter(Boolean);
  return setCookies.map((cookie?: any) : any => cookie.split(";")[0]).join("; ");
}

async function loginOwner(server?: any) : Promise<any> {
  const credentials: any = await readInitialOwnerCredentials(server);
  assert.ok(credentials.password, "test auth helper requires a newly created server owner password");
  const response: any = await ORIGINAL_FETCH(`${server.url}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: credentials.username,
      password: credentials.password
    })
  });
  const payload: any = await response.json();
  assert.equal(response.status, 200);
  return {
    cookie: cookieHeaderFrom(response),
    csrf: payload.csrfToken
  };
}

function parseInitialCredentials(content?: any) : any {
  const username: any = content.match(/^Username\s*:\s*(.+)$/m)?.[1]?.trim() || "owner";
  const password: any = content.match(/^Password\s*:\s*(.+)$/m)?.[1]?.trim() || "";
  return {
    username,
    password
  };
}

export async function readInitialOwnerCredentials(server?: any) : Promise<any> {
  const inlinePassword: any = server.initialOwner?.password || "";
  if (inlinePassword) {
    return {
      username: server.initialOwner?.username || "owner",
      password: inlinePassword,
      credentialsPath: ""
    };
  }

  const credentialsPath: any =
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

  const content: any = await fs.readFile(credentialsPath, "utf8").catch(() : any => "");
  return {
    ...parseInitialCredentials(content),
    credentialsPath
  };
}

function ensureFetchInstalled() : any {
  if (fetchInstalled) {
    return;
  }
  fetchInstalled = true;
  globalThis.fetch = async (input?: any, init: Record<string, any> = {}) : Promise<any> => {
    const url: any = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    );
    const rule: any = AUTH_RULES.find((item?: any) : any => item.origin === url.origin);
    if (!rule || url.pathname === "/api/auth/login") {
      return ORIGINAL_FETCH(input, init);
    }

    const headers: any = new Headers(init.headers || {});
    if (!headers.has("Cookie")) {
      headers.set("Cookie", rule.auth.cookie);
    }

    const method: any = String(init.method || input?.method || "GET").toUpperCase();
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

export async function installAuthenticatedFetch(server?: any, options: Record<string, any> = {}) : Promise<any> {
  const auth: any = options.auth || await loginOwner(server);
  const origin: any = new URL(server.url).origin;
  const existing: any = AUTH_RULES.find((item?: any) : any => item.origin === origin);
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

export function installedAuthFor(serverOrUrl?: any) : any {
  const value: any = typeof serverOrUrl === "string" ? serverOrUrl : serverOrUrl?.url;
  if (!value) {
    return null;
  }
  const origin: any = new URL(value).origin;
  return AUTH_RULES.find((item?: any) : any => item.origin === origin)?.auth || null;
}

export function authHeaders(auth?: any, { safetyConfirm = true, method = "GET" }: Record<string, any> = {}) : any {
  const headers: Record<string, any> = {
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
