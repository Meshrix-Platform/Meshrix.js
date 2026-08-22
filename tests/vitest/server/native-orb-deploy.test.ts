import { describe, expect, it } from "vitest";

import {
  parseNativeOrbDeploymentArgs,
  resolveServiceNodeExecutable,
} from "../../../tools/server-scripts/native-orb-deploy.ts";

describe("native OrbStack deployment", () : any => {
  it("requires an explicit machine and one-origin address", () : any => {
    expect(parseNativeOrbDeploymentArgs([
      "--machine",
      "meshrix-vm",
      "--origin",
      "http://meshrix-vm.orb.local:7228",
    ])).toEqual({
      machine: "meshrix-vm",
      publicOrigin: "http://meshrix-vm.orb.local:7228",
    });
    expect(() : any => parseNativeOrbDeploymentArgs([]))
      .toThrow(/OrbStack machine/);
    expect(() : any => parseNativeOrbDeploymentArgs([
      "--machine",
      "meshrix-vm",
      "--origin",
      "http://meshrix-vm.orb.local:7229",
    ])).toThrow(/port 7228/);
  });

  it("rejects credentials, paths, and unknown arguments", () : any => {
    const credentialOrigin: any = new URL("http://meshrix-vm.orb.local:7228");
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
      "http://meshrix-vm.orb.local:7228/api",
    ])).toThrow(/without credentials/);
    expect(() : any => parseNativeOrbDeploymentArgs([
      "--machine",
      "meshrix-vm",
      "--origin",
      "http://meshrix-vm.orb.local:7228",
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
});
