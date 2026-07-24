import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_DICTIONARY_PATH = path.resolve(__dirname, "../../config/default-import-file-types.json");
const ENV_DICTIONARY_PATH = "MESHRIX_IMPORT_FILE_TYPES_PATH";

let cachedRegistry = null;
let cachedPath = "";
let cachedMtimeMs = -1;

function dictionaryPath() {
  return path.resolve(process.env[ENV_DICTIONARY_PATH] || DEFAULT_DICTIONARY_PATH);
}

function readDictionary(filePath) {
  return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
}

function normalizeExtension(value = "") {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith(".") ? trimmed.toLowerCase() : `.${trimmed.toLowerCase()}`;
}

function normalizeFileName(value = "") {
  return String(value || "").trim().toLowerCase();
}

function normalizeRouteTarget(value = {}, fallback = {}) {
  const mountName = String(value?.mountName || value?.mount || fallback.mountName || "").trim();
  const action = String(value?.action || value?.capability || fallback.action || "forwardObject").trim();
  if (!mountName) {
    return null;
  }
  return {
    mountName,
    action: action || "forwardObject"
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return value === true || value === "true" || value === "1" || value === "yes";
}

function normalizeEntry({ group = {}, entry = {} }) {
  const route = normalizeRouteTarget(entry.route, normalizeRouteTarget(group.route) || {});
  const kind = String(entry.kind || group.kind || "document").trim() || "document";
  const mediaType = String(entry.mediaType || group.mediaType || "").trim().toLowerCase();
  return {
    groupId: String(group.id || "").trim(),
    groupLabel: String(group.label || "").trim(),
    label: String(entry.label || group.label || "").trim(),
    kind,
    mediaType,
    mediaTypes: [...new Set([
      ...asArray(group.mediaTypes),
      ...asArray(entry.mediaTypes)
    ].map((value) =>
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

function normalizeHexBytes(value = "") {
  const normalized = String(value || "").replace(/[^a-fA-F0-9]/g, "").toLowerCase();
  if (!normalized || normalized.length % 2 !== 0) {
    return [];
  }
  const bytes = [];
  for (let index = 0; index < normalized.length; index += 2) {
    bytes.push(Number.parseInt(normalized.slice(index, index + 2), 16));
  }
  return bytes;
}

function compileRegexRule(rule = {}) {
  const pattern = String(rule.pattern || "").trim();
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

function normalizeDictionary(raw = {}, configPath = "") {
  const extensionMap = new Map();
  const fileNameMap = new Map();
  const mediaTypeMap = new Map();
  const mediaTypeDescriptorMap = new Map();
  const extensionRoutes = {};
  const kindRoutes = {};
  const mediaTypeRoutes = {};

  for (const group of asArray(raw.groups)) {
    for (const entry of asArray(group.entries)) {
      const normalized = normalizeEntry({ group, entry });
      for (const extension of normalized.extensions) {
        const descriptor = { ...normalized, extension };
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
        const descriptor = { ...normalized, fileName };
        fileNameMap.set(fileName, descriptor);
      }
    }
  }

  for (const [kind, route] of Object.entries(raw.kindRoutes || {})) {
    const normalizedRoute = normalizeRouteTarget(route);
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
      .map((entry) => ({
        extension: normalizeExtension(entry.extension),
        bytes: normalizeHexBytes(entry.bytesHex)
      }))
      .filter((entry) => entry.extension && entry.bytes.length > 0),
    zipContainerDetectors: asArray(raw.zipContainerDetectors)
      .map((entry) => ({
        extension: normalizeExtension(entry.extension),
        contains: String(entry.contains || "").trim()
      }))
      .filter((entry) => entry.extension && entry.contains),
    textSniffingRules: asArray(raw.textSniffingRules)
      .map(compileRegexRule)
      .filter(Boolean)
  };
}

export function loadImportFileTypeRegistry({ force = false } = {}) {
  const filePath = dictionaryPath();
  const stat = fsSync.statSync(filePath);
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

export function reloadImportFileTypeRegistry() {
  return loadImportFileTypeRegistry({ force: true });
}

export function importFileTypeConfigPath() {
  return loadImportFileTypeRegistry().configPath;
}

function cloneRouteMap(value = {}) {
  return Object.fromEntries(
    Object.entries(value || {}).map(([key, route]) => [
      key,
      {
        mountName: String(route?.mountName || "").trim(),
        action: String(route?.action || "extractDocument").trim() || "extractDocument"
      }
    ])
  );
}

export function getImportDefaultRoutingTable() {
  const registry = loadImportFileTypeRegistry();
  return {
    kindRoutes: cloneRouteMap(registry.kindRoutes),
    extensionRoutes: cloneRouteMap(registry.extensionRoutes),
    mediaTypeRoutes: cloneRouteMap(registry.mediaTypeRoutes)
  };
}

export function normalizeImportExtension(value = "") {
  return normalizeExtension(value);
}

export function importFileDescriptorForPath(filePath = "") {
  const registry = loadImportFileTypeRegistry();
  const fileName = normalizeFileName(path.basename(String(filePath || "")));
  const extension = normalizeExtension(path.extname(String(filePath || "")));
  return registry.fileNameMap.get(fileName) || registry.extensionMap.get(extension) || null;
}

export function importFileDescriptorForExtension(extension = "") {
  return loadImportFileTypeRegistry().extensionMap.get(normalizeExtension(extension)) || null;
}

export function importFileDescriptorForMediaType(mediaType = "") {
  return loadImportFileTypeRegistry().mediaTypeDescriptorMap.get(
    String(mediaType || "").trim().toLowerCase()
  ) || null;
}

export function isImportFilePathSupported(filePath = "") {
  return Boolean(importFileDescriptorForPath(filePath));
}

export function isImportExtensionSupported(extension = "") {
  return Boolean(importFileDescriptorForExtension(extension));
}

export function isImportTextDescriptor(descriptor = null) {
  return String(descriptor?.kind || "") === "text";
}

export function isImportImageDescriptor(descriptor = null) {
  return String(descriptor?.kind || "") === "image";
}

export function isImportArchiveDescriptor(descriptor = null) {
  return String(descriptor?.kind || "") === "archive";
}

export function mediaTypeForImportPath(filePath = "") {
  const descriptor = importFileDescriptorForPath(filePath);
  return descriptor?.mediaType || "";
}

export function mediaTypeForImportExtension(extension = "") {
  return importFileDescriptorForExtension(extension)?.mediaType || "";
}

export function getImportKindRoutes() {
  return getImportDefaultRoutingTable().kindRoutes;
}

export function getImportExtensionRoutes() {
  return getImportDefaultRoutingTable().extensionRoutes;
}

export function getImportMediaTypeRoutes() {
  return getImportDefaultRoutingTable().mediaTypeRoutes;
}

export function detectExtensionBySignature(buffer) {
  if (!buffer || buffer.length === 0) {
    return "";
  }
  for (const signature of loadImportFileTypeRegistry().binarySignatures) {
    if (signature.bytes.every((byte, index) => buffer[index] === byte)) {
      return signature.extension;
    }
  }
  return "";
}

export function inferZipContainerExtension(entryNames = "") {
  const haystack = String(entryNames || "");
  const match = loadImportFileTypeRegistry().zipContainerDetectors.find((entry) =>
    haystack.includes(entry.contains)
  );
  return match?.extension || "";
}

export function sniffTextExtension(text = "") {
  const match = loadImportFileTypeRegistry().textSniffingRules.find((rule) =>
    rule.regex.test(String(text || ""))
  );
  return match?.extension || "";
}

export function importPlainTextFallbackExtension() {
  return loadImportFileTypeRegistry().plainTextFallbackExtension;
}

export function importReadableTextDetection() {
  return { ...loadImportFileTypeRegistry().readableTextDetection };
}

export function shouldIncludeUnknownReadableText() {
  return loadImportFileTypeRegistry().includeUnknownReadableText;
}
