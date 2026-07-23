export function verifierTerminationExitCode(signal = "") {
  return signal === "SIGINT" ? 130 : 143;
}

export function registerVerifierTerminationSignals(onSignal, signalSource = process) {
  signalSource.once("SIGTERM", () => onSignal("SIGTERM"));
  signalSource.once("SIGINT", () => onSignal("SIGINT"));
}
