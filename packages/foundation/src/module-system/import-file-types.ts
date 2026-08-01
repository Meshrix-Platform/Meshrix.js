import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename: any = fileURLToPath(import.meta.url);
const __dirname: any = path.dirname(__filename);
const DEFAULT_DICTIONARY_PATH: any = path.resolve(__dirname, "../../config/default-import-file-types.json");
const ENV_DICTIONARY_PATH: any = "MESHRIX_IMPORT_FILE_TYPES_PATH";

let cachedRegistry: any = null;
let cachedPath: any = "";
let cachedMtimeMs: any = -1;

function dictionaryPath() : any {
  return path.resolve(process.env[ENV_DICTIONARY_PATH] || DEFAULT_DICTIONARY_PATH);
}

function readDictionary(filePath?: any) : any {
  return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
}

function normalizeExtension(value: any = "") : any {
  const trimmed: any = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith(".") ? trimmed.toLowerCase() : `.${trimmed.toLowerCase()}`;
}

function normalizeFileName(value: any = "") : any {
  return String(value || "").trim().toLowerCase();
}

function normalizeRouteTarget(value: Record<string, any> = {}, fallback: Record<string, any> = {}) : any {
  const mountName: any = String(value?.mountName || value?.mount || fallback.mountName || "").trim();
  const action: any = String(value?.action || value?.capability || fallback.action || "forwardObject").trim();
  if (!mountName) {
    return null;
  }
  return {
    mountName,
    action: action || "forwardObject"
  };
}

function asArray(value?: any) : any {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function toBoolean(value?: any, fallback: any = false) : any {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return value === true || value === "true" || value === "1" || value === "yes";
}

function normalizeEntry({ group = {}, entry = {} }: Record<string, any>) : any {
  const route: any = normalizeRouteTarget(entry.route, normalizeRouteTarget(group.route) || {});
  const kind: any = String(entry.kind || group.kind || "document").trim() || "document";
  const mediaType: any = String(entry.mediaType || group.mediaType || "").trim().toLowerCase();
  return {
    groupId: String(group.id || "").trim(),
    groupLabel: String(group.label || "").trim(),
    label: String(entry.label || group.label || "").trim(),
    kind,
    mediaType,
    mediaTypes: [...new Set<any>([
      ...asArray(group.mediaTypes),
      ...asArray(entry.mediaTypes)
    ].map((value?: any) : any =>
      String(value || "").trim().toLowerCase()
    ).filter(Boolean))],
    route,
    preserveSourceMaterial: toBoolean(
      entry.preserveSourceMaterial,
      toBoolean(group.preserveSourceMaterial, false)
    ),
    normalizedAdapter: String(entry.normalizedAdapter || group.normalizedAdapter || "").trim(),
    extensions: asArray(entry.extensions).map(normalizeExtension).filter(Boolean),
    fileNames: asArray(entry.fileNames).map(normalizeFileName).filter(Boolean)
  };
}

function normalizeHexBytes(value: any = "") : any {
  const normalized: any = String(value || "").replace(/[^a-fA-F0-9]/g, "").toLowerCase();
  if (!normalized || normalized.length % 2 !== 0) {
    return [];
  }
  const bytes: any[] = [];
  for (let index: any = 0; index < normalized.length; index += 2) {
    bytes.push(Number.parseInt(normalized.slice(index, index + 2), 16));
  }
  return bytes;
}

function compileRegexRule(rule: Record<string, any> = {}) : any {
  const pattern: any = String(rule.pattern || "").trim();
  if (!pattern) {
    return null;
  }
  try {
    return {
      extension: normalizeExtension(rule.extension),
      regex: new RegExp(pattern, String(rule.flags || ""))
    };
  } catch {
    return null;
  }
}

function normalizeDictionary(raw: Record<string, any> = {}, configPath: any = "") : any {
  const extensionMap: any = new Map<any, any>();
  const fileNameMap: any = new Map<any, any>();
  const mediaTypeMap: any = new Map<any, any>();
  const mediaTypeDescriptorMap: any = new Map<any, any>();
  const extensionRoutes: Record<string, any> = {};
  const kindRoutes: Record<string, any> = {};
  const mediaTypeRoutes: Record<string, any> = {};

  for (const group of asArray(raw.groups)) {
    for (const entry of asArray(group.entries)) {
      const normalized: any = normalizeEntry({ group, entry });
      for (const extension of normalized.extensions) {
        const descriptor: Record<string, any> = { ...normalized, extension };
        extensionMap.set(extension, descriptor);
        if (descriptor.route) {
          extensionRoutes[extension] = descriptor.route;
        }
        if (descriptor.mediaType) {
          mediaTypeMap.set(extension, descriptor.mediaType);
          mediaTypeDescriptorMap.set(descriptor.mediaType, descriptor);
        }
        for (const mediaType of descriptor.mediaTypes) {
          mediaTypeDescriptorMap.set(mediaType, descriptor);
          if (descriptor.route) {
            mediaTypeRoutes[mediaType] = descriptor.route;
          }
        }
      }
      for (const fileName of normalized.fileNames) {
        const descriptor: Record<string, any> = { ...normalized, fileName };
        fileNameMap.set(fileName, descriptor);
      }
    }
  }

  for (const [kind, route] of (Object.entries(raw.kindRoutes || {}) as [string, any][])) {
    const normalizedRoute: any = normalizeRouteTarget(route);
    if (kind && normalizedRoute) {
      kindRoutes[String(kind).trim()] = normalizedRoute;
    }
  }

  return {
    schemaVersion: String(raw.schemaVersion || "v0.0.1:schema:definition-1"),
    configPath,
    includeUnknownReadableText: raw.includeUnknownReadableText !== false,
    plainTextFallbackExtension: normalizeExtension(raw.plainTextFallbackExtension),
    readableTextDetection: {
      sampleBytes: Math.max(256, Math.min(Number(raw.readableTextDetection?.sampleBytes || 4096), 1_048_576)),
      maxControlRatio: Math.max(0, Math.min(Number(raw.readableTextDetection?.maxControlRatio || 0.02), 1))
    },
    extensionMap,
    fileNameMap,
    mediaTypeMap,
    mediaTypeDescriptorMap,
    extensionRoutes,
    kindRoutes,
    mediaTypeRoutes,
    binarySignatures: asArray(raw.binarySignatures)
      .map((entry?: any) : any => ({
        extension: normalizeExtension(entry.extension),
        bytes: normalizeHexBytes(entry.bytesHex)
      }))
      .filter((entry?: any) : any => entry.extension && entry.bytes.length > 0),
    zipContainerDetectors: asArray(raw.zipContainerDetectors)
      .map((entry?: any) : any => ({
        extension: normalizeExtension(entry.extension),
        contains: String(entry.contains || "").trim()
      }))
      .filter((entry?: any) : any => entry.extension && entry.contains),
    textSniffingRules: asArray(raw.textSniffingRules)
      .map(compileRegexRule)
      .filter(Boolean)
  };
}

export function loadImportFileTypeRegistry({ force = false }: Record<string, any> = {}) : any {
  const filePath: any = dictionaryPath();
  const stat: any = fsSync.statSync(filePath);
  if (
    !force &&
    cachedRegistry &&
    cachedPath === filePath &&
    cachedMtimeMs === stat.mtimeMs
  ) {
    return cachedRegistry;
  }
  cachedPath = filePath;
  cachedMtimeMs = stat.mtimeMs;
  cachedRegistry = normalizeDictionary(readDictionary(filePath), filePath);
  return cachedRegistry;
}

export function reloadImportFileTypeRegistry() : any {
  return loadImportFileTypeRegistry({ force: true });
}

export function importFileTypeConfigPath() : any {
  return loadImportFileTypeRegistry().configPath;
}

function cloneRouteMap(value: Record<string, any> = {}) : any {
  return Object.fromEntries(
    (Object.entries(value || {}) as [string, any][]).map(([key, route]: any[]) : any => [
      key,
      {
        mountName: String(route?.mountName || "").trim(),
        action: String(route?.action || "extractDocument").trim() || "extractDocument"
      }
    ])
  );
}

export function getImportDefaultRoutingTable() : any {
  const registry: any = loadImportFileTypeRegistry();
  return {
    kindRoutes: cloneRouteMap(registry.kindRoutes),
    extensionRoutes: cloneRouteMap(registry.extensionRoutes),
    mediaTypeRoutes: cloneRouteMap(registry.mediaTypeRoutes)
  };
}

export function normalizeImportExtension(value: any = "") : any {
  return normalizeExtension(value);
}

export function importFileDescriptorForPath(filePath: any = "") : any {
  const registry: any = loadImportFileTypeRegistry();
  const fileName: any = normalizeFileName(path.basename(String(filePath || "")));
  const extension: any = normalizeExtension(path.extname(String(filePath || "")));
  return registry.fileNameMap.get(fileName) || registry.extensionMap.get(extension) || null;
}

export function importFileDescriptorForExtension(extension: any = "") : any {
  return loadImportFileTypeRegistry().extensionMap.get(normalizeExtension(extension)) || null;
}

export function importFileDescriptorForMediaType(mediaType: any = "") : any {
  return loadImportFileTypeRegistry().mediaTypeDescriptorMap.get(
    String(mediaType || "").trim().toLowerCase()
  ) || null;
}

export function isImportFilePathSupported(filePath: any = "") : any {
  return Boolean(importFileDescriptorForPath(filePath));
}

export function isImportExtensionSupported(extension: any = "") : any {
  return Boolean(importFileDescriptorForExtension(extension));
}

export function isImportTextDescriptor(descriptor: any = null) : any {
  return String(descriptor?.kind || "") === "text";
}

export function isImportImageDescriptor(descriptor: any = null) : any {
  return String(descriptor?.kind || "") === "image";
}

export function isImportArchiveDescriptor(descriptor: any = null) : any {
  return String(descriptor?.kind || "") === "archive";
}

export function mediaTypeForImportPath(filePath: any = "") : any {
  const descriptor: any = importFileDescriptorForPath(filePath);
  return descriptor?.mediaType || "";
}

export function mediaTypeForImportExtension(extension: any = "") : any {
  return importFileDescriptorForExtension(extension)?.mediaType || "";
}

export function getImportKindRoutes() : any {
  return getImportDefaultRoutingTable().kindRoutes;
}

export function getImportExtensionRoutes() : any {
  return getImportDefaultRoutingTable().extensionRoutes;
}

export function getImportMediaTypeRoutes() : any {
  return getImportDefaultRoutingTable().mediaTypeRoutes;
}

export function detectExtensionBySignature(buffer?: any) : any {
  if (!buffer || buffer.length === 0) {
    return "";
  }
  for (const signature of loadImportFileTypeRegistry().binarySignatures) {
    if (signature.bytes.every((byte?: any, index?: any) : any => buffer[index] === byte)) {
      return signature.extension;
    }
  }
  return "";
}

export function inferZipContainerExtension(entryNames: any = "") : any {
  const haystack: any = String(entryNames || "");
  const match: any = loadImportFileTypeRegistry().zipContainerDetectors.find((entry?: any) : any =>
    haystack.includes(entry.contains)
  );
  return match?.extension || "";
}

export function sniffTextExtension(text: any = "") : any {
  const match: any = loadImportFileTypeRegistry().textSniffingRules.find((rule?: any) : any =>
    rule.regex.test(String(text || ""))
  );
  return match?.extension || "";
}

export function importPlainTextFallbackExtension() : any {
  return loadImportFileTypeRegistry().plainTextFallbackExtension;
}

export function importReadableTextDetection() : any {
  return { ...loadImportFileTypeRegistry().readableTextDetection };
}

export function shouldIncludeUnknownReadableText() : any {
  return loadImportFileTypeRegistry().includeUnknownReadableText;
}
