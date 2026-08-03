import type { Ref } from "vue";
import { probeModel } from "../lib/agent-settings-client";
import type {
  AgentModelConfig,
  AgentSettings,
  ModelProbeResponse,
} from "../lib/types";

type ReadonlyRef<T> = {
  readonly value: T;
};

type ConsoleModelProbeControllerOptions = {
  clearBusy: (key: string) => void;
  error: Ref<string>;
  modelEntryConfigured: (entry: AgentModelConfig) => boolean;
  modelEntryStatusKey: (entry: AgentModelConfig) => string;
  modelProbeResults: Ref<Record<string, ModelProbeResponse>>;
  setBusy: (key: string) => void;
  settingsPayloadForSave: () => AgentSettings;
  visibleModelEntries: ReadonlyRef<AgentModelConfig[]>;
};

export function createConsoleModelProbeController(
  options: ConsoleModelProbeControllerOptions,
) : any {
  function modelProbeFailureResult(entry: AgentModelConfig, message: string): ModelProbeResponse {
    return {
      ok: false,
      configured: options.modelEntryConfigured(entry),
      provider: entry.provider,
      model: String(entry.model || entry.engine || ""),
      statusCode: 0,
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
      message,
    };
  }

  function modelProbeSettingsForEntry(entry: AgentModelConfig) : any {
    void entry;
    return options.settingsPayloadForSave();
  }

  async function runModelEntryProbe(entry: AgentModelConfig): Promise<ModelProbeResponse> {
    if (!options.modelEntryConfigured(entry)) {
      return modelProbeFailureResult(entry, "模型配置不完整，未执行远程探测。");
    }
    return probeModel({
      provider: entry.provider,
      modelAlias: options.modelEntryStatusKey(entry),
      settings: modelProbeSettingsForEntry(entry),
    });
  }

  async function probeModelEntry(entry: AgentModelConfig) : Promise<any> {
    const key: any = options.modelEntryStatusKey(entry);
    options.setBusy(`model-probe:${key}`);
    options.error.value = "";
    try {
      const result: any = await runModelEntryProbe(entry);
      options.modelProbeResults.value = {
        ...options.modelProbeResults.value,
        [key]: result,
      };
    } catch (nextError: any) {
      const message: any = nextError instanceof Error ? nextError.message : "模型探测失败。";
      options.modelProbeResults.value = {
        ...options.modelProbeResults.value,
        [key]: modelProbeFailureResult(entry, message),
      };
      options.error.value = message;
    } finally {
      options.clearBusy(`model-probe:${key}`);
    }
  }

  async function probeModelLibraryBeforeSave() : Promise<any> {
    const failures: Array<{ entry: AgentModelConfig; result: ModelProbeResponse }> = [];
    const nextResults: Record<string, ModelProbeResponse> = {};
    for (const entry of options.visibleModelEntries.value) {
      const key: any = options.modelEntryStatusKey(entry);
      try {
        const result: any = await runModelEntryProbe(entry);
        nextResults[key] = result;
        if (!result.ok) {
          failures.push({ entry, result });
        }
      } catch (nextError: any) {
        const message: any = nextError instanceof Error ? nextError.message : "模型探测失败。";
        const result: any = modelProbeFailureResult(entry, message);
        nextResults[key] = result;
        failures.push({ entry, result });
      }
    }
    options.modelProbeResults.value = {
      ...options.modelProbeResults.value,
      ...nextResults,
    };
    return failures;
  }

  function modelEntryProbeResult(entry: AgentModelConfig) : any {
    return options.modelProbeResults.value[options.modelEntryStatusKey(entry)] || null;
  }

  function modelEntryProbeStatusLabel(entry: AgentModelConfig) : any {
    const probe: any = modelEntryProbeResult(entry);
    if (!probe) {
      return "";
    }
    return probe.ok ? "探测通过" : "探测失败";
  }

  function modelEntryProbeStatusTone(entry: AgentModelConfig) : any {
    const probe: any = modelEntryProbeResult(entry);
    if (!probe) {
      return "neutral";
    }
    return probe.ok ? "success" : "danger";
  }

  function modelEntryStatusLabel(entry: AgentModelConfig) : any {
    const probe: any = options.modelProbeResults.value[options.modelEntryStatusKey(entry)];
    if (probe) {
      return probe.ok ? "探测通过" : "探测失败";
    }
    return options.modelEntryConfigured(entry) ? "已配置" : "未配置";
  }

  function modelEntryStatusTone(entry: AgentModelConfig) : any {
    const probe: any = options.modelProbeResults.value[options.modelEntryStatusKey(entry)];
    if (probe) {
      return probe.ok ? "success" : "danger";
    }
    return options.modelEntryConfigured(entry) ? "neutral" : "muted";
  }

  return {
    modelEntryProbeResult,
    modelEntryProbeStatusLabel,
    modelEntryProbeStatusTone,
    modelEntryStatusLabel,
    modelEntryStatusTone,
    modelProbeFailureResult,
    modelProbeSettingsForEntry,
    probeModelEntry,
    probeModelLibraryBeforeSave,
    runModelEntryProbe,
  };
}
