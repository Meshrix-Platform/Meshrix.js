export function verifierTerminationExitCode(signal: any = "") : any {
  return signal === "SIGINT" ? 130 : 143;
}

export function registerVerifierTerminationSignals(onSignal?: any, signalSource: any = process) : any {
  signalSource.once("SIGTERM", () : any => onSignal("SIGTERM"));
  signalSource.once("SIGINT", () : any => onSignal("SIGINT"));
}
