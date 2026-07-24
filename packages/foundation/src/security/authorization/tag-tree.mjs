const ACTIVE_STATUS = "active";

function normalizeId(value) {
  return String(value || "").trim();
}

function uniqueStrings(values = []) {
  const input = Array.isArray(values) ? values : [values];
  return [...new Set(input.map(normalizeId).filter(Boolean))];
}

function normalizeTagRecord(tagId, tag = null) {
  if (!tag || typeof tag !== "object" || Array.isArray(tag)) {
    return null;
  }
  const normalized = {
    tagId: normalizeId(tag.tagId || tag.id || tagId),
    parentTagId: normalizeId(tag.parentTagId || tag.parentId),
    kind: normalizeId(tag.kind || "custom"),
    status: normalizeId(tag.status || ACTIVE_STATUS),
    enabled: tag.enabled !== false,
    scopePrerequisites: uniqueStrings(tag.scopePrerequisites || tag.scopesRequired || [])
  };
  return normalized.tagId ? normalized : null;
}

function activeTagFromStore(store, tagId) {
  const normalizedTagId = normalizeId(tagId);
  const tag = typeof store?.getTag === "function" ? store.getTag(normalizedTagId) : null;
  const normalized = normalizeTagRecord(normalizedTagId, tag);
  if (!normalized || normalized.enabled === false || normalized.status === "archived") {
    return null;
  }
  return normalized;
}

function tagFromGetTag(getTag, tagId, { activeOnly = true } = {}) {
  const normalizedTagId = normalizeId(tagId);
  const tag = typeof getTag === "function" ? getTag(normalizedTagId) : null;
  if (activeOnly) {
    return activeTagFromStore({ getTag }, normalizedTagId);
  }
  return normalizeTagRecord(normalizedTagId, tag);
}

export function createTagTree({ getTag } = {}) {
  if (typeof getTag !== "function") {
    throw new Error("createTagTree requires a getTag(tagId) function.");
  }

  function activeTag(tagId) {
    return activeTagFromStore({ getTag }, tagId);
  }

  function lineageOf(tagId, { includeSelf = true, activeOnly = true, rootFirst = false } = {}) {
    const output = [];
    const seen = new Set();
    let cursorId = normalizeId(tagId);
    while (cursorId && !seen.has(cursorId)) {
      seen.add(cursorId);
      const tag = tagFromGetTag(getTag, cursorId, { activeOnly });
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

  function ancestorsOf(tagId, options = {}) {
    const tagIdText = normalizeId(tagId);
    const includeSelf = options.includeSelf === true;
    const output = lineageOf(tagIdText, { ...options, includeSelf });
    if (includeSelf) {
      return output.map((tag) => tag.tagId);
    }
    return output
      .filter((tag) => tag.tagId !== tagIdText)
      .map((tag) => tag.tagId);
  }

  function assertParentAllowed(tagId, parentTagId) {
    const normalizedTagId = normalizeId(tagId);
    const normalizedParentTagId = normalizeId(parentTagId);
    if (!normalizedParentTagId) return true;
    if (normalizedParentTagId === normalizedTagId) {
      throw new Error("Tag cannot parent itself.");
    }
    const parent = tagFromGetTag(getTag, normalizedParentTagId, { activeOnly: false });
    if (!parent) {
      throw new Error(`Unknown parent tag: ${normalizedParentTagId}`);
    }
    const seen = new Set([normalizedTagId]);
    for (const tag of lineageOf(normalizedParentTagId, { includeSelf: true, activeOnly: false })) {
      if (seen.has(tag.tagId)) {
        throw new Error("Tag hierarchy cannot contain cycles.");
      }
      seen.add(tag.tagId);
    }
    return true;
  }

  function scopePrerequisitesFor(tagId) {
    return uniqueStrings(lineageOf(tagId, { includeSelf: true, activeOnly: false, rootFirst: true })
      .flatMap((tag) => uniqueStrings(tag.scopePrerequisites || tag.scopesRequired || [])));
  }

  function effectiveTagsFor(tagIds = []) {
    return uniqueStrings(uniqueStrings(tagIds).flatMap((tagId) => ancestorsOf(tagId, { includeSelf: true })));
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

export function assertTagParentChangeAllowed({ getTag, tagId, parentTagId } = {}) {
  return createTagTree({ getTag }).assertParentAllowed(tagId, parentTagId);
}

export function effectiveScopePrerequisitesForTag({ getTag, tagId } = {}) {
  return createTagTree({ getTag }).scopePrerequisitesFor(tagId);
}

export function createTagTreeFromStore(store = null) {
  return createTagTree({
    getTag: (tagId) => (typeof store?.getTag === "function" ? store.getTag(tagId) : null)
  });
}

export const TAG_TREE_PROTOCOL_VERSION = "v0.0.1:authorization:tag-tree-1";
