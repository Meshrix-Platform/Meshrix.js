export function createMount() {
  return {
    id: "test/mock-source-code-agent-parser",
    kind: "sourceCodeAgent",
    enabled: true,
    async extractDocument({ buffer, fileName = "", mediaTypeHint = "", sourceKind = "" }) {
      const text = buffer.toString("utf8");
      return {
        parserId: "test/mock-source-code-agent-parser",
        text: `[agent-code] ${fileName || sourceKind || "source"}\n${text}`.trim(),
        metadata: {
          "Content-Type": mediaTypeHint || "text/x-script",
          "X-Agent-Route": "source-code"
        },
        embeddedDocuments: []
      };
    },
    async extractText(input) {
      const result = await this.extractDocument(input);
      return result.text;
    },
    async close() {}
  };
}
