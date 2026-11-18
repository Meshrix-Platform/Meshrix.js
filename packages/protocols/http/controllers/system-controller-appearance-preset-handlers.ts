import { sendJson } from "#meshrix/http-utils";

const APPEARANCE_PRESET_DIRECTORY_LABEL = "appearance-presets";

function parseBody(parseJsonBody?: any, requestBody?: any) : any {
  return requestBody?.length > 0 ? parseJsonBody(requestBody) : {};
}

function configFromImportPayload(payload?: any, appearancePresetCatalog?: any) : any {
  if (typeof payload?.text === "string") {
    return appearancePresetCatalog.parseAppearancePresetConfigText(payload.text);
  }
  if (payload?.config) {
    return payload.config;
  }
  return payload;
}

function isAppearancePresetConfigError(error?: any) : any {
  return error?.name === "AppearancePresetConfigError" && Array.isArray(error.errors);
}

function errorPayload(error?: any, fallbackCode = "appearance_preset_operation_failed") : any {
  if (isAppearancePresetConfigError(error)) {
    return {
      ok: false,
      code: "appearance_preset_invalid",
      error: "外观预设配置无效。",
      errors: error.errors
    };
  }
  return {
    ok: false,
    code: fallbackCode,
    error: "外观预设操作暂时无法完成。"
  };
}

function assertAppearancePresetCatalog(appearancePresetCatalog?: any) : any {
  if (
    !appearancePresetCatalog ||
    typeof appearancePresetCatalog.listServerAppearancePresetConfigs !== "function" ||
    typeof appearancePresetCatalog.importServerAppearancePresetConfig !== "function" ||
    typeof appearancePresetCatalog.parseAppearancePresetConfigText !== "function"
  ) {
    throw Object.assign(new Error("Appearance preset catalog service is unavailable."), {
      code: "appearance_preset_service_unavailable"
    });
  }
}

export function createSystemControllerAppearancePresetHandlers({
  parseJsonBody,
  userDataPath,
  appearancePresetCatalog = null
}: Record<string, any>) : any {
  return {
    async handleAppearancePresets({ response }: Record<string, any>) : Promise<any> {
      try {
        assertAppearancePresetCatalog(appearancePresetCatalog);
        const result: any = await appearancePresetCatalog.listServerAppearancePresetConfigs({ userDataPath });
        sendJson(response, 200, {
          ok: true,
          directory: APPEARANCE_PRESET_DIRECTORY_LABEL,
          configs: result.configs,
          presets: result.configs,
          errors: result.errors
        });
      } catch (error: any) {
        sendJson(response, 503, errorPayload(error, "appearance_preset_list_failed"));
      }
    },

    async handleImportAppearancePreset({ requestBody, response }: Record<string, any>) : Promise<any> {
      try {
        assertAppearancePresetCatalog(appearancePresetCatalog);
        const payload: any = parseBody(parseJsonBody, requestBody);
        const result: any = await appearancePresetCatalog.importServerAppearancePresetConfig({
          userDataPath,
          config: configFromImportPayload(payload, appearancePresetCatalog)
        });
        sendJson(response, 200, {
          ok: true,
          directory: APPEARANCE_PRESET_DIRECTORY_LABEL,
          fileName: result.fileName,
          config: result.config,
          configs: result.configs,
          presets: result.configs,
          errors: result.errors
        });
      } catch (error: any) {
        const validationError = isAppearancePresetConfigError(error);
        const serviceUnavailable = error?.code === "appearance_preset_service_unavailable";
        const status = validationError ? 400 : serviceUnavailable ? 503 : 500;
        sendJson(response, status, errorPayload(
          error,
          serviceUnavailable ? "appearance_preset_service_unavailable" : "appearance_preset_import_failed"
        ));
      }
    }
  };
}
