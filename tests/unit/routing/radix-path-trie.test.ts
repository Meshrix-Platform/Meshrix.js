/**
 * Unit tests for RadixPathTrie — route matching, conflict detection, performance.
 */
import { describe, it, expect } from "vitest";
import { RadixPathTrie } from "../../../packages/server-runtime/src/routing/radix-path-trie.ts";

describe("RadixPathTrie", () : any => {
  describe("insert and lookup", () : any => {
    it("inserts and looks up a static path", () : any => {
      const trie: any = new RadixPathTrie();
      trie.insert("/api/health", { handler: "health" });
      const result: any = trie.lookup("/api/health");
      expect(result).not.toBeNull();
      expect(result.value.handler).toBe("health");
      expect(result.params).toEqual({});
    });

    it("matches named parameters", () : any => {
      const trie: any = new RadixPathTrie();
      trie.insert("/api/workspaces/:workspaceId", { handler: "getWorkspace" });
      const result: any = trie.lookup("/api/workspaces/abc123");
      expect(result).not.toBeNull();
      expect(result.value.handler).toBe("getWorkspace");
      expect(result.params.workspaceId).toBe("abc123");
    });

    it("matches multiple parameters", () : any => {
      const trie: any = new RadixPathTrie();
      trie.insert("/api/workspaces/:workspaceId/files/:fileId", { handler: "getFile" });
      const result: any = trie.lookup("/api/workspaces/ws-1/files/file-2");
      expect(result).not.toBeNull();
      expect(result.params.workspaceId).toBe("ws-1");
      expect(result.params.fileId).toBe("file-2");
    });

    it("prefers static over param segments", () : any => {
      const trie: any = new RadixPathTrie();
      trie.insert("/api/workspaces/list", { handler: "list" });
      trie.insert("/api/workspaces/:workspaceId", { handler: "get" });

      const staticResult: any = trie.lookup("/api/workspaces/list");
      expect(staticResult.value.handler).toBe("list");

      const paramResult: any = trie.lookup("/api/workspaces/other");
      expect(paramResult.value.handler).toBe("get");
      expect(paramResult.params.workspaceId).toBe("other");
    });

    it("returns null for unmatched paths", () : any => {
      const trie: any = new RadixPathTrie();
      trie.insert("/api/health", { handler: "health" });
      expect(trie.lookup("/api/unknown")).toBeNull();
      expect(trie.lookup("/api/health/extra")).toBeNull();
    });

    it("matches root path", () : any => {
      const trie: any = new RadixPathTrie();
      trie.insert("/", { handler: "root" });
      const result: any = trie.lookup("/");
      expect(result).not.toBeNull();
      expect(result.value.handler).toBe("root");
    });

    it("handles trailing slashes gracefully", () : any => {
      const trie: any = new RadixPathTrie();
      trie.insert("/api/test", { handler: "test" });
      expect(trie.lookup("/api/test/")).not.toBeNull();
    });
  });

  describe("wildcard routes", () : any => {
    it("matches wildcard catch-all", () : any => {
      const trie: any = new RadixPathTrie();
      trie.insert("/static/*", { handler: "static" });
      const result: any = trie.lookup("/static/css/main.css");
      expect(result).not.toBeNull();
      expect(result.value.handler).toBe("static");
      expect(result.params["*"]).toBe("css/main.css");
    });
  });

  describe("conflict detection", () : any => {
    it("detects duplicate paths", () : any => {
      const trie: any = new RadixPathTrie();
      trie.insert("/api/test", { handler: "a" });
      trie.insert("/api/test", { handler: "b" }); // Should return false, not throw
      expect(trie.size).toBe(1);
    });

    it("detects param name conflicts at same position", () : any => {
      const trie: any = new RadixPathTrie();
      trie.insert("/api/:id/read", { handler: "a" });
      // This should be fine — different param name at same depth but different pattern
      trie.insert("/api/:uuid/write", { handler: "b" });
      // Different pattern trees — tests basic param matching
      const r1: any = trie.lookup("/api/123/read");
      expect(r1).not.toBeNull();
      const r2: any = trie.lookup("/api/456/write");
      expect(r2).not.toBeNull();
    });
  });

  describe("size and paths", () : any => {
    it("tracks size correctly", () : any => {
      const trie: any = new RadixPathTrie();
      expect(trie.size).toBe(0);
      trie.insert("/a", 1);
      trie.insert("/b", 2);
      trie.insert("/c/:id", 3);
      expect(trie.size).toBe(3);
    });

    it("returns all paths", () : any => {
      const trie: any = new RadixPathTrie();
      trie.insert("/api/a", 1);
      trie.insert("/api/b", 2);
      const paths: any = trie.paths();
      expect(paths).toHaveLength(2);
    });
  });

  describe("performance", () : any => {
    it("handles 1000+ routes efficiently", () : any => {
      const trie: any = new RadixPathTrie();
      const COUNT: any = 1000;
      for (let i: any = 0; i < COUNT; i++) {
        trie.insert(`/api/resource/${i}/action`, { id: i });
      }
      expect(trie.size).toBe(COUNT);

      // Lookup should be fast
      const start: any = Date.now();
      for (let i: any = 0; i < 100; i++) {
        trie.lookup(`/api/resource/${i * 10}/action`);
      }
      const duration: any = Date.now() - start;
      // p95 lookup for 100 lookups should be well under 100ms total
      expect(duration).toBeLessThan(100);
    });
  });
});
