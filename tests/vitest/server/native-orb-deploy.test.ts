import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  NATIVE_ORB_DEPLOYMENT_STAGE_SCRIPTS,
  loadNativeOrbDeploymentStageScript,
  parseNativeOrbDeploymentArgs,
  resolveServiceNodeExecutable,
  runNativeOrbDeploymentStageScripts,
} from "../../../tools/server-scripts/native-orb-deploy.ts";

describe("native OrbStack deployment", () : any => {
  it("requires an explicit machine and one-origin address", () : any => {
    expect(parseNativeOrbDeploymentArgs([
      "--machine",
      "meshrix-vm",
      "--origin",
      "http://meshrix-vm.internal.example:7228",
    ])).toEqual({
      machine: "meshrix-vm",
      publicOrigin: "http://meshrix-vm.internal.example:7228",
    });
    expect(() : any => parseNativeOrbDeploymentArgs([]))
      .toThrow(/OrbStack machine/);
    expect(() : any => parseNativeOrbDeploymentArgs([
      "--machine",
      "meshrix-vm",
      "--origin",
      "http://meshrix-vm.internal.example:7229",
    ])).toThrow(/port 7228/);
  });

  it("rejects credentials, paths, and unknown arguments", () : any => {
    const credentialOrigin: any = new URL("http://meshrix-vm.internal.example:7228");
    credentialOrigin.username = "owner";
    credentialOrigin.password = "secret";
    expect(() : any => parseNativeOrbDeploymentArgs([
      "--machine",
      "meshrix-vm",
      "--origin",
      credentialOrigin.toString(),
    ])).toThrow(/without credentials/);
    expect(() : any => parseNativeOrbDeploymentArgs([
      "--machine",
      "meshrix-vm",
      "--origin",
      "http://meshrix-vm.internal.example:7228/api",
    ])).toThrow(/without credentials/);
    expect(() : any => parseNativeOrbDeploymentArgs([
      "--machine",
      "meshrix-vm",
      "--origin",
      "http://meshrix-vm.internal.example:7228",
      "--fallback",
    ])).toThrow(/--machine and --origin/);
  });

  it("binds deployment work to the Node executable owned by the service", () : any => {
    expect(resolveServiceNodeExecutable(
      "{ path=/opt/meshrix/node/bin/node ; argv[]=/opt/meshrix/node/bin/node --conditions=source tools/server-scripts/start-server.ts ; }",
    )).toBe("/opt/meshrix/node/bin/node");
    expect(() : any => resolveServiceNodeExecutable(
      "{ path=/usr/bin/npm ; argv[]=/usr/bin/npm run start:console ; }",
    )).toThrow(/absolute Node.js executable/);
    expect(() : any => resolveServiceNodeExecutable("node tools/server-scripts/start-server.ts"))
      .toThrow(/absolute Node.js executable/);
  });

  it("activates one explicit ordered list of independent stage scripts", async () : Promise<any> => {
    expect(NATIVE_ORB_DEPLOYMENT_STAGE_SCRIPTS.map((stage?: any) : any => stage.id)).toEqual([
      "runtime",
      "candidate",
      "transfer",
      "dependencies",
      "build",
      "native-runtime",
      "configure",
      "activate",
      "verify",
    ]);
    expect(new Set(NATIVE_ORB_DEPLOYMENT_STAGE_SCRIPTS.map((stage?: any) : any => stage.script)).size).toBe(9);
    expect(NATIVE_ORB_DEPLOYMENT_STAGE_SCRIPTS.every((stage?: any) : any => (
      stage.script.startsWith("./stages/") && stage.script.endsWith(".ts")
    ))).toBe(true);
    expect(JSON.stringify(NATIVE_ORB_DEPLOYMENT_STAGE_SCRIPTS))
      .not.toMatch(/format-convert|skill-hub|model-gateway|plugin/u);
    const loadedStages: any[] = await Promise.all(
      NATIVE_ORB_DEPLOYMENT_STAGE_SCRIPTS.map(loadNativeOrbDeploymentStageScript),
    );
    expect(loadedStages.every((loaded?: any) : any => (
      typeof loaded.runNativeOrbDeploymentStage === "function"
    ))).toBe(true);

    const activated: any[] = [];
    const results: any = await runNativeOrbDeploymentStageScripts({
      context: {},
      loadStage: async (stage?: any) : Promise<any> => ({
        runNativeOrbDeploymentStage: async () : Promise<any> => {
          activated.push(stage.id);
          return { id: stage.id, status: stage.id === "candidate" ? "resumed" : "completed" };
        },
      }),
    });
    expect(activated).toEqual(NATIVE_ORB_DEPLOYMENT_STAGE_SCRIPTS.map((stage?: any) : any => stage.id));
    expect(results).toHaveLength(9);
  });

  it("keeps the Core-only deployment decision linked from repository agent rules", () : any => {
    const repoRoot: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const design: any = fs.readFileSync(path.join(repoRoot, "tools/server-scripts/README.md"), "utf8");
    const agentRules: any = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
    expect(design).toContain("Meshrix.js deployment scripts close only the capabilities owned by the");
    expect(design).toContain("Optional integration workflows");
    expect(agentRules).toContain("tools/server-scripts/README.md");
    expect(agentRules).toContain("Deployment scripts must close only Meshrix.js Core platform capabilities.");
  });
});
