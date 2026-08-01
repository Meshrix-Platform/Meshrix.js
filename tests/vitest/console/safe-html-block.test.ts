// @vitest-environment jsdom
import { mount, VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import SafeHtmlBlock from "../../../apps/console/components/SafeHtmlBlock.vue";

const mounted: VueWrapper[] = [];

function mountBlock(props: Record<string, unknown>) : any {
  const wrapper: any = mount(SafeHtmlBlock, {
    attachTo: document.body,
    attrs: {
      class: "safe-html-test",
      "data-extra": "kept",
    },
    props: {
      html: "",
      source: "markdownToSafeHtml",
      ...props,
    },
  });
  mounted.push(wrapper);
  return wrapper;
}

afterEach(() : any => {
  while (mounted.length) {
    mounted.pop()?.unmount();
  }
  document.body.innerHTML = "";
});

describe("SafeHtmlBlock", () : any => {
  it("uses markdown sanitizer, custom tags and forwarded attrs", () : any => {
    const wrapper: any = mountBlock({
      tag: "article",
      source: "markdownToSafeHtml",
      html: `
        <a href="javascript:alert(1)" onclick="bad()">bad link</a>
        <a href="/safe">safe link</a>
        <img src="javascript:alert(1)" onerror="bad()" alt="bad image">
        <img src="data:image/png;base64,AAAA" alt="inline image">
        <iframe src="https://example.test"></iframe>
        <script>alert(1)</script>
      `,
    });

    expect(wrapper.element.tagName.toLowerCase()).toBe("article");
    expect(wrapper.attributes("data-safe-html-source")).toBe("markdownToSafeHtml");
    expect(wrapper.attributes("data-extra")).toBe("kept");
    expect(wrapper.find("script").exists()).toBe(false);
    expect(wrapper.find("iframe").exists()).toBe(false);

    const links: any = wrapper.findAll("a");
    expect(links).toHaveLength(2);
    expect(links[0].attributes("href")).toBeUndefined();
    expect(links[0].attributes("onclick")).toBeUndefined();
    expect(links[1].attributes("href")).toBe("/safe");
    expect(links[1].attributes("target")).toBe("_blank");
    expect(links[1].attributes("rel")).toBe("noreferrer noopener");

    const images: any = wrapper.findAll("img");
    expect(images).toHaveLength(2);
    expect(images[0].attributes("src")).toBeUndefined();
    expect(images[0].attributes("onerror")).toBeUndefined();
    expect(images[1].attributes("src")).toBe("data:image/png;base64,AAAA");
    expect(images[1].attributes("loading")).toBe("lazy");
  });

  it("sanitizes evidence html while allowing normalized iframe, links and images", () : any => {
    const wrapper: any = mountBlock({
      source: "renderEvidenceReadableHtml",
      html: `
        <section onclick="bad()">
          <a href="https://example.test/doc" style="color:red">doc</a>
          <a href="//evil.test/doc">evil</a>
          <img src="/asset.png" width="120" height="bad">
          <img src="javascript:alert(1)">
          <iframe
            class="rendered-email-frame"
            src="https://example.test/embed"
            srcdoc="<p>Frame</p>"
            sandbox="allow-scripts allow-same-origin allow-popups-to-escape-sandbox"
            referrerpolicy="origin"
            width="100%"
            height="240"
          ></iframe>
          <custom-element data-x="bad">removed</custom-element>
        </section>
      `,
    });

    const section: any = wrapper.find("section");
    expect(section.exists()).toBe(true);
    expect(section.attributes("onclick")).toBeUndefined();
    expect(wrapper.text()).not.toContain("removed");

    const links: any = wrapper.findAll("a");
    expect(links[0].attributes("href")).toBe("https://example.test/doc");
    expect(links[0].attributes("style")).toBeUndefined();
    expect(links[0].attributes("target")).toBe("_blank");
    expect(links[0].attributes("rel")).toBe("noreferrer noopener");
    expect(links[1].attributes("href")).toBeUndefined();

    const images: any = wrapper.findAll("img");
    expect(images[0].attributes("src")).toBe("/asset.png");
    expect(images[0].attributes("width")).toBe("120");
    expect(images[0].attributes("height")).toBeUndefined();
    expect(images[0].attributes("alt")).toBe("");
    expect(images[0].attributes("loading")).toBe("lazy");
    expect(images[1].attributes("src")).toBeUndefined();

    const iframe: any = wrapper.get("iframe");
    expect(iframe.attributes("src")).toBeUndefined();
    expect(iframe.attributes("srcdoc")).toContain("Frame");
    expect(iframe.attributes("referrerpolicy")).toBe("no-referrer");
    expect(iframe.attributes("sandbox")).toBe("allow-popups");
    expect(iframe.attributes("width")).toBe("100%");
    expect(iframe.attributes("height")).toBe("240");
  });

  it("reacts when html or sanitizer source props change", async () : Promise<any> => {
    const wrapper: any = mountBlock({
      source: "renderEvidenceReadableHtml",
      html: "<iframe class=\"rendered-email-frame\" srcdoc=\"<p>Frame</p>\"></iframe>",
    });

    expect(wrapper.find("iframe").exists()).toBe(true);

    await wrapper.setProps({
      source: "markdownToSafeHtml",
    });
    expect(wrapper.find("iframe").exists()).toBe(false);

    await wrapper.setProps({
      html: "<p>Hello <strong>world</strong></p>",
    });
    expect(wrapper.text()).toBe("Hello world");
    expect(wrapper.find("strong").exists()).toBe(true);
  });
});
