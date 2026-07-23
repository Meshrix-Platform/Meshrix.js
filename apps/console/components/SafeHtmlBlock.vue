<script setup lang="ts">
import { computed } from "vue";
import { sanitizeHtmlContent, safeMediaSrc, safeLinkHref } from "../lib/rendering";

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    html: string;
    source: "markdownToSafeHtml" | "renderEvidenceReadableHtml";
    tag?: string;
  }>(),
  {
    tag: "div",
  },
);

const markdownSafeTags = new Set(["a", "article", "aside", "b", "blockquote", "br", "caption", "code", "col", "colgroup", "dd", "del", "div", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre", "section", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul", "iframe"]);

const markdownSafeAttributes = new Set([
  "alt",
  "colspan",
  "height",
  "id",
  "loading",
  "rowspan",
  "src",
  "target",
  "title",
  "class",
  "rel",
  "sandbox",
  "referrerpolicy",
  "srcdoc",
  "width",
  "href"
]);

function normalizeIframeElement(element: Element) {
  if (element.tagName.toLowerCase() !== "iframe") {
    return;
  }
  const generatedEmailFrame = element.classList.contains("rendered-email-frame");
  if (!generatedEmailFrame || !element.getAttribute("srcdoc")) {
    element.remove();
    return;
  }
  element.removeAttribute("src");
  element.setAttribute("referrerpolicy", "no-referrer");
  element.setAttribute("sandbox", "allow-popups");
}

function sanitizeEvidenceHtml(rawHtml: string) {
  if (typeof DOMParser !== "function") {
    return rawHtml || "";
  }
  const template = document.createElement("template");
  template.innerHTML = rawHtml || "";

  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    const tagName = element.tagName.toLowerCase();
    if (!markdownSafeTags.has(tagName)) {
      element.remove();
      continue;
    }

    for (const attribute of Array.from(element.attributes)) {
      const attrName = attribute.name.toLowerCase();
      const attrValue = attribute.value || "";
      if (!markdownSafeAttributes.has(attrName) || attrName.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (attrName === "href") {
        const safeHref = safeLinkHref(attrValue);
        safeHref ? element.setAttribute(attribute.name, safeHref) : element.removeAttribute(attribute.name);
        continue;
      }
      if (attrName === "src") {
        if (tagName === "iframe") {
          element.removeAttribute(attribute.name);
          continue;
        }
        const safe = safeMediaSrc(attrValue);
        if (safe) {
          element.setAttribute(attribute.name, safe);
        } else {
          element.removeAttribute(attribute.name);
        }
        continue;
      }
      if (attrName === "srcdoc" && tagName !== "iframe") {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (attrName === "sandbox" && tagName !== "iframe") {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (attrName === "width" || attrName === "height") {
        if (/^\d+(?:\.\d+)?%?$/.test(attrValue.trim())) {
          continue;
        }
        element.removeAttribute(attribute.name);
        continue;
      }
    }

    if (tagName === "img" && !element.getAttribute("alt")) {
      element.setAttribute("alt", "");
    }

    if (tagName === "img" && !element.getAttribute("loading")) {
      element.setAttribute("loading", "lazy");
    }

    if (tagName === "a" && element.getAttribute("href")) {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noreferrer noopener");
    }
    normalizeIframeElement(element);
  }

  return template.innerHTML;
}

const sanitizedHtml = computed(() => (
  props.source === "markdownToSafeHtml"
    ? sanitizeHtmlContent(props.html)
    : sanitizeEvidenceHtml(props.html)
));
</script>

<template>
  <component
    :is="props.tag"
    v-bind="$attrs"
    :data-safe-html-source="props.source"
    v-html="sanitizedHtml"
  ></component>
</template>
