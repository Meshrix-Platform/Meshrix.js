import { SelfMaintenanceRuntime } from "../internal/runtime.mjs";

const runtime = new SelfMaintenanceRuntime();
await runtime.start();
