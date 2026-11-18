import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  registerVerifierTerminationSignals,
  verifierTerminationExitCode
} from "../../../tools/server-scripts/lib/verifier-termination-signals.ts";

describe("verifier termination signals", () : any => {
  it("maps interrupt and termination signals to conventional exit codes", () : any => {
    expect(verifierTerminationExitCode("SIGINT")).toBe(130);
    expect(verifierTerminationExitCode("SIGTERM")).toBe(143);
    expect(verifierTerminationExitCode("SIGHUP")).toBe(143);
  });

  it("registers one-shot handlers for each supported termination signal", () : any => {
    const signalSource: any = new EventEmitter();
    const onSignal: any = vi.fn();

    registerVerifierTerminationSignals(onSignal, signalSource);
    signalSource.emit("SIGTERM");
    signalSource.emit("SIGTERM");
    signalSource.emit("SIGINT");
    signalSource.emit("SIGINT");

    expect(onSignal.mock.calls).toEqual([["SIGTERM"], ["SIGINT"]]);
  });
});
