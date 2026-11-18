import { runOrb } from "../../native-orb-deployment/support.ts";

export async function runNativeOrbBootstrapStage(context?: any) : Promise<any> {
  context.activationStarted = true;
  runOrb({ machine: context.parsed.machine, args: ["systemctl", "--user", "daemon-reload"] });
  runOrb({ machine: context.parsed.machine, args: ["systemctl", "--user", "enable", "meshrix-js.service"] });
  runOrb({ machine: context.parsed.machine, args: ["systemctl", "--user", "start", "meshrix-js.service"], code: "native_orb_bootstrap_activation_failed" });
  return Object.freeze({ id: "activate", status: "completed" });
}
