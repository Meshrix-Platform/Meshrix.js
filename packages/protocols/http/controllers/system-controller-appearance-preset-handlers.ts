import { sendJson } from "#meshrix/http-utils";

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

function errorPayload(error?: any) : any {
  if (isAppearancePresetConfigError(error)) {
    return {
      ok: false,
      error: error.message,
      errors: error.errors
    };
  }
  return {
    ok: false,
    error: error instanceof Error ? error.message : "Appearance preset import failed."
  };
}

function assertAppearancePresetCatalog(appearancePresetCatalog?: any) : any {
  if (
    !appearancePresetCatalog ||
    typeof appearancePresetCatalog.listServerAppearancePresetConfigs !== "function" ||
    typeof appearancePresetCatalog.importServerAppearancePresetConfig !== "function" ||
    typeof appearancePresetCatalog.parseAppearancePresetConfigText !== "function"
  ) {
    throw new Error("Appearance preset catalog service is unavailable.");
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
          directory: result.directory,
          configs: result.configs,
          presets: result.configs,
          errors: result.errors
        });
      } catch (error: any) {
        sendJson(response, 503, errorPayload(error));
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
          directory: result.directory,
          fileName: result.fileName,
          config: result.config,
          configs: result.configs,
          presets: result.configs,
          errors: result.errors
        });
      } catch (error: any) {
        const status: any = error?.message === "Appearance preset catalog service is unavailable." ? 503 : 400;
        sendJson(response, status, errorPayload(error));
      }
    }
  };
}
