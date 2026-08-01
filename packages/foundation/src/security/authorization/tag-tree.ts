const ACTIVE_STATUS: any = "active";

function normalizeId(value?: any) : any {
  return String(value || "").trim();
}

function uniqueStrings(values: any = []) : any {
  const input: any = Array.isArray(values) ? values : [values];
  return [...new Set<any>(input.map(normalizeId).filter(Boolean))];
}

function normalizeTagRecord(tagId?: any, tag: any = null) : any {
  if (!tag || typeof tag !== "object" || Array.isArray(tag)) {
    return null;
  }
  const normalized: Record<string, any> = {
    tagId: normalizeId(tag.tagId || tag.id || tagId),
    parentTagId: normalizeId(tag.parentTagId || tag.parentId),
    kind: normalizeId(tag.kind || "custom"),
    status: normalizeId(tag.status || ACTIVE_STATUS),
    enabled: tag.enabled !== false,
    scopePrerequisites: uniqueStrings(tag.scopePrerequisites || tag.scopesRequired || [])
  };
  return normalized.tagId ? normalized : null;
}

function activeTagFromStore(store?: any, tagId?: any) : any {
  const normalizedTagId: any = normalizeId(tagId);
  const tag: any = typeof store?.getTag === "function" ? store.getTag(normalizedTagId) : null;
  const normalized: any = normalizeTagRecord(normalizedTagId, tag);
  if (!normalized || normalized.enabled === false || normalized.status === "archived") {
    return null;
  }
  return normalized;
}

function tagFromGetTag(getTag?: any, tagId?: any, { activeOnly = true }: Record<string, any> = {}) : any {
  const normalizedTagId: any = normalizeId(tagId);
  const tag: any = typeof getTag === "function" ? getTag(normalizedTagId) : null;
  if (activeOnly) {
    return activeTagFromStore({ getTag }, normalizedTagId);
  }
  return normalizeTagRecord(normalizedTagId, tag);
}

export function createTagTree({ getTag }: Record<string, any> = {}) : any {
  if (typeof getTag !== "function") {
    throw new Error("createTagTree requires a getTag(tagId) function.");
  }

  function activeTag(tagId?: any) : any {
    return activeTagFromStore({ getTag }, tagId);
  }

  function lineageOf(tagId?: any, { includeSelf = true, activeOnly = true, rootFirst = false }: Record<string, any> = {}) : any {
    const output: any[] = [];
    const seen: any = new Set<any>();
    let cursorId: any = normalizeId(tagId);
    while (cursorId && !seen.has(cursorId)) {
      seen.add(cursorId);
      const tag: any = tagFromGetTag(getTag, cursorId, { activeOnly });
      if (!tag) {
        break;
      }
      if (includeSelf || tag.tagId !== normalizeId(tagId)) {
        output.push(tag);
      }
      cursorId = tag.parentTagId;
    }
    return rootFirst ? output.reverse() : output;
  }

  function ancestorsOf(tagId?: any, options: Record<string, any> = {}) : any {
    const tagIdText: any = normalizeId(tagId);
    const includeSelf: any = options.includeSelf === true;
    const output: any = lineageOf(tagIdText, { ...options, includeSelf });
    if (includeSelf) {
      return output.map((tag?: any) : any => tag.tagId);
    }
    return output
      .filter((tag?: any) : any => tag.tagId !== tagIdText)
      .map((tag?: any) : any => tag.tagId);
  }

  function assertParentAllowed(tagId?: any, parentTagId?: any) : any {
    const normalizedTagId: any = normalizeId(tagId);
    const normalizedParentTagId: any = normalizeId(parentTagId);
    if (!normalizedParentTagId) return true;
    if (normalizedParentTagId === normalizedTagId) {
      throw new Error("Tag cannot parent itself.");
    }
    const parent: any = tagFromGetTag(getTag, normalizedParentTagId, { activeOnly: false });
    if (!parent) {
      throw new Error(`Unknown parent tag: ${normalizedParentTagId}`);
    }
    const seen: any = new Set<any>([normalizedTagId]);
    for (const tag of lineageOf(normalizedParentTagId, { includeSelf: true, activeOnly: false })) {
      if (seen.has(tag.tagId)) {
        throw new Error("Tag hierarchy cannot contain cycles.");
      }
      seen.add(tag.tagId);
    }
    return true;
  }

  function scopePrerequisitesFor(tagId?: any) : any {
    return uniqueStrings(lineageOf(tagId, { includeSelf: true, activeOnly: false, rootFirst: true })
      .flatMap((tag?: any) : any => uniqueStrings(tag.scopePrerequisites || tag.scopesRequired || [])));
  }

  function effectiveTagsFor(tagIds: any = []) : any {
    return uniqueStrings(uniqueStrings(tagIds).flatMap((tagId?: any) : any => ancestorsOf(tagId, { includeSelf: true })));
  }

  return {
    activeTag,
    lineageOf,
    ancestorsOf,
    assertParentAllowed,
    scopePrerequisitesFor,
    effectiveTagsFor
  };
}

export function assertTagParentChangeAllowed({ getTag, tagId, parentTagId }: Record<string, any> = {}) : any {
  return createTagTree({ getTag }).assertParentAllowed(tagId, parentTagId);
}

export function effectiveScopePrerequisitesForTag({ getTag, tagId }: Record<string, any> = {}) : any {
  return createTagTree({ getTag }).scopePrerequisitesFor(tagId);
}

export function createTagTreeFromStore(store: any = null) : any {
  return createTagTree({
    getTag: (tagId?: any) : any => (typeof store?.getTag === "function" ? store.getTag(tagId) : null)
  });
}

export const TAG_TREE_PROTOCOL_VERSION: any = "v0.0.1:authorization:tag-tree-1";
