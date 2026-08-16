export const TAG_TREE_PROTOCOL_VERSION = "v0.0.1:authorization:tag-tree-1";
const ACTIVE_STATUS = "active";

export interface TagRecord { tagId: string; parentTagId: string; kind: string; status: string; enabled: boolean; scopePrerequisites: string[]; }
export interface TagRecordInput { tagId?: unknown; id?: unknown; parentTagId?: unknown; parentId?: unknown; kind?: unknown; status?: unknown; enabled?: unknown; scopePrerequisites?: unknown; scopesRequired?: unknown; }
export interface TagLookup { getTag(tagId: string): TagRecordInput | null | undefined; }
export interface TagTreeOptions { includeSelf?: boolean; activeOnly?: boolean; rootFirst?: boolean; }
export interface TagTree {
  activeTag(tagId?: unknown): TagRecord | null;
  lineageOf(tagId?: unknown, options?: TagTreeOptions): TagRecord[];
  ancestorsOf(tagId?: unknown, options?: TagTreeOptions): string[];
  assertParentAllowed(tagId?: unknown, parentTagId?: unknown): true;
  scopePrerequisitesFor(tagId?: unknown): string[];
  effectiveTagsFor(tagIds?: unknown): string[];
}

function normalizeId(value?: unknown): string { return String(value || "").trim(); }
function uniqueStrings(values: unknown = []): string[] {
  const input = Array.isArray(values) ? values : [values];
  return [...new Set(input.map(normalizeId).filter(Boolean))];
}
function normalizeTagRecord(tagId?: unknown, tag: unknown = null): TagRecord | null {
  if (!tag || typeof tag !== "object" || Array.isArray(tag)) return null;
  const input = tag as TagRecordInput;
  const normalized: TagRecord = {
    tagId: normalizeId(input.tagId || input.id || tagId), parentTagId: normalizeId(input.parentTagId || input.parentId),
    kind: normalizeId(input.kind || "custom"), status: normalizeId(input.status || ACTIVE_STATUS), enabled: input.enabled !== false,
    scopePrerequisites: uniqueStrings(input.scopePrerequisites || input.scopesRequired || [])
  };
  return normalized.tagId ? normalized : null;
}
function activeTagFromStore(store: TagLookup | null | undefined, tagId?: unknown): TagRecord | null {
  const normalizedTagId = normalizeId(tagId);
  const normalized = normalizeTagRecord(normalizedTagId, store?.getTag(normalizedTagId));
  return !normalized || !normalized.enabled || normalized.status === "archived" ? null : normalized;
}
function tagFromGetTag(getTag: TagLookup["getTag"], tagId?: unknown, { activeOnly = true }: TagTreeOptions = {}): TagRecord | null {
  const normalizedTagId = normalizeId(tagId);
  return activeOnly ? activeTagFromStore({ getTag }, normalizedTagId) : normalizeTagRecord(normalizedTagId, getTag(normalizedTagId));
}

export function createTagTree({ getTag }: Partial<TagLookup> = {}): TagTree {
  if (typeof getTag !== "function") throw new Error("createTagTree requires a getTag(tagId) function.");
  const lookup: TagLookup["getTag"] = getTag;
  function lineageOf(tagId?: unknown, { includeSelf = true, activeOnly = true, rootFirst = false }: TagTreeOptions = {}): TagRecord[] {
    const output: TagRecord[] = []; const seen = new Set<string>(); const requestedTagId = normalizeId(tagId); let cursorId = requestedTagId;
    while (cursorId && !seen.has(cursorId)) {
      seen.add(cursorId); const tag = tagFromGetTag(lookup, cursorId, { activeOnly }); if (!tag) break;
      if (includeSelf || tag.tagId !== requestedTagId) output.push(tag); cursorId = tag.parentTagId;
    }
    return rootFirst ? output.reverse() : output;
  }
  function ancestorsOf(tagId?: unknown, options: TagTreeOptions = {}): string[] {
    const tagIdText = normalizeId(tagId); const includeSelf = options.includeSelf === true;
    return lineageOf(tagIdText, { ...options, includeSelf }).filter((tag) => includeSelf || tag.tagId !== tagIdText).map((tag) => tag.tagId);
  }
  function assertParentAllowed(tagId?: unknown, parentTagId?: unknown): true {
    const normalizedTagId = normalizeId(tagId); const normalizedParentTagId = normalizeId(parentTagId);
    if (!normalizedParentTagId) return true;
    if (normalizedParentTagId === normalizedTagId) throw new Error("Tag cannot parent itself.");
    if (!tagFromGetTag(lookup, normalizedParentTagId, { activeOnly: false })) throw new Error(`Unknown parent tag: ${normalizedParentTagId}`);
    const seen = new Set([normalizedTagId]);
    for (const tag of lineageOf(normalizedParentTagId, { includeSelf: true, activeOnly: false })) {
      if (seen.has(tag.tagId)) throw new Error("Tag hierarchy cannot contain cycles."); seen.add(tag.tagId);
    }
    return true;
  }
  function scopePrerequisitesFor(tagId?: unknown): string[] {
    return uniqueStrings(lineageOf(tagId, { includeSelf: true, activeOnly: false, rootFirst: true }).flatMap((tag) => tag.scopePrerequisites));
  }
  return {
    activeTag: (tagId) => activeTagFromStore({ getTag: lookup }, tagId), lineageOf, ancestorsOf, assertParentAllowed, scopePrerequisitesFor,
    effectiveTagsFor: (tagIds = []) => uniqueStrings(uniqueStrings(tagIds).flatMap((tagId) => ancestorsOf(tagId, { includeSelf: true })))
  };
}
export function assertTagParentChangeAllowed({ getTag, tagId, parentTagId }: Partial<TagLookup> & { tagId?: unknown; parentTagId?: unknown } = {}): true {
  return createTagTree({ getTag }).assertParentAllowed(tagId, parentTagId);
}
export function effectiveScopePrerequisitesForTag({ getTag, tagId }: Partial<TagLookup> & { tagId?: unknown } = {}): string[] {
  return createTagTree({ getTag }).scopePrerequisitesFor(tagId);
}
export function createTagTreeFromStore(store: TagLookup | null = null): TagTree {
  return createTagTree({ getTag: (tagId) => store?.getTag(tagId) ?? null });
}
