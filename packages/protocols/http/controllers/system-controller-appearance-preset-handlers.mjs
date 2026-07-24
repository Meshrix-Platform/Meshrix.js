import { sendJson } from "#meshrix/http-utils";

function parseBody(parseJsonBody, requestBody) {
  return requestBody?.length > 0 ? parseJsonBody(requestBody) : {};
}

function configFromImportPayload(payload, appearancePresetCatalog) {
  if (typeof payload?.text === "string") {
    return appearancePresetCatalog.parseAppearancePresetConfigText(payload.text);
  }
  if (payload?.config) {
    return payload.config;
  }
  return payload;
}

function isAppearancePresetConfigError(error) {
  return error?.name === "AppearancePresetConfigError" && Array.isArray(error.errors);
}

function errorPayload(error) {
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

function assertAppearancePresetCatalog(appearancePresetCatalog) {
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
}) {
  return {
    async handleAppearancePresets({ response }) {
      try {
        assertAppearancePresetCatalog(appearancePresetCatalog);
        const result = await appearancePresetCatalog.listServerAppearancePresetConfigs({ userDataPath });
        sendJson(response, 200, {
          ok: true,
          directory: result.directory,
          configs: result.configs,
          presets: result.configs,
          errors: result.errors
        });
      } catch (error) {
        sendJson(response, 503, errorPayload(error));
      }
    },

    async handleImportAppearancePreset({ requestBody, response }) {
      try {
        assertAppearancePresetCatalog(appearancePresetCatalog);
        const payload = parseBody(parseJsonBody, requestBody);
        const result = await appearancePresetCatalog.importServerAppearancePresetConfig({
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
      } catch (error) {
        const status = error?.message === "Appearance preset catalog service is unavailable." ? 503 : 400;
        sendJson(response, status, errorPayload(error));
      }
    }
  };
}
