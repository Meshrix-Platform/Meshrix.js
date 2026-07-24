import http from "node:http";

function writeJson(response, status, payload = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload)}\n`);
}

function parseJsonBuffer(buffer) {
  try {
    return JSON.parse(Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer || "{}"));
  } catch {
    return {};
  }
}

async function collectRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}

export async function createMaintenancePlannerGateway(plan) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const requestBody = await collectRequestBody(request);
    requests.push({
      method: request.method,
      url: request.url,
      body: parseJsonBuffer(requestBody)
    });
    writeJson(response, 200, {
      id: "maintenance-planner-stub",
      model: "maintenance-planner-stub",
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify(plan)
          }
        }
      ]
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

export function createMaintenanceStubControllers(events = []) {
  return {
    system: {
      async handleHealthz({ response }) {
        writeJson(response, 200, { ok: true, service: "health" });
      },
      async handleGetRuntimeInfo({ response }) {
        writeJson(response, 200, { profile: "verify", edition: "standard" });
      },
      async handleGetStorageSummary({ response }) {
        writeJson(response, 200, { objects: 0, bytes: 0 });
      },
      async handleStorageDoctor({ response }) {
        writeJson(response, 200, { ok: true, findings: [] });
      },
      async handleStorageReconcile({ request, requestBody, response }) {
        const input = parseJsonBuffer(requestBody);
        events.push({
          type: "storage.reconcile",
          input,
          headers: request?.headers || {}
        });
        writeJson(response, 200, {
          ok: true,
          applied: input.apply === true,
          confirmed: input.confirm === true && input.safetyConfirm === true
        });
      },
      async handleFailedJobsReview({ response }) {
        writeJson(response, 200, { failedCount: 0, suggestions: [] });
      }
    },
    jobs: {
      async handleListJobs({ response }) {
        writeJson(response, 200, { items: [] });
      }
    }
  };
}

export const maintenanceVerifierLogger = Object.freeze({
  info() {},
  debug() {},
  warn() {},
  error() {}
});
