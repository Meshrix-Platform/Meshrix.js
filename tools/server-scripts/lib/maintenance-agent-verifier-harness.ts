import http from "node:http";

function writeJson(response?: any, status?: any, payload: Record<string, any> = {}) : any {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload)}\n`);
}

function parseJsonBuffer(buffer?: any) : any {
  try {
    return JSON.parse(Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer || "{}"));
  } catch {
    return {};
  }
}

async function collectRequestBody(request?: any) : Promise<any> {
  const chunks: any[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}

export async function createMaintenancePlannerGateway(plan?: any) : Promise<any> {
  const requests: any[] = [];
  const server: any = http.createServer(async (request?: any, response?: any) : Promise<any> => {
    const requestBody: any = await collectRequestBody(request);
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
  await new Promise((resolve?: any, reject?: any) : any => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address: any = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () : any => new Promise((resolve?: any, reject?: any) : any => server.close((error?: any) : any => error ? reject(error) : resolve()))
  };
}

export function createMaintenanceStubControllers(events: any = []) : any {
  return {
    system: {
      async handleHealthz({ response }: Record<string, any>) : Promise<any> {
        writeJson(response, 200, { ok: true, service: "health" });
      },
      async handleGetRuntimeInfo({ response }: Record<string, any>) : Promise<any> {
        writeJson(response, 200, { profile: "verify", edition: "standard" });
      },
      async handleGetStorageSummary({ response }: Record<string, any>) : Promise<any> {
        writeJson(response, 200, { objects: 0, bytes: 0 });
      },
      async handleStorageDoctor({ response }: Record<string, any>) : Promise<any> {
        writeJson(response, 200, { ok: true, findings: [] });
      },
      async handleStorageReconcile({ request, requestBody, response }: Record<string, any>) : Promise<any> {
        const input: any = parseJsonBuffer(requestBody);
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
      async handleFailedJobsReview({ response }: Record<string, any>) : Promise<any> {
        writeJson(response, 200, { failedCount: 0, suggestions: [] });
      }
    },
    jobs: {
      async handleListJobs({ response }: Record<string, any>) : Promise<any> {
        writeJson(response, 200, { items: [] });
      }
    }
  };
}

export const maintenanceVerifierLogger: Readonly<Record<string, any>> = Object.freeze({
  info() : any {},
  debug() : any {},
  warn() : any {},
  error() : any {}
});
