import { runOrb } from "../support.ts";

export async function runNativeOrbDeploymentStage(context?: any) : Promise<any> {
  const { machine } = context.parsed;
  context.activationStarted = true;
  runOrb({ machine, args: ["systemctl", "--user", "daemon-reload"] });
  runOrb({ machine, args: ["systemctl", "--user", "enable", context.unit] });
  runOrb({
    machine,
    args: ["systemctl", "--user", "restart", context.unit],
    code: "native_orb_activation_failed",
  });
  return Object.freeze({ id: "activate", status: "completed" });
}
