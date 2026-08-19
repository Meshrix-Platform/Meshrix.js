export const AUTHORIZED_VENDORED_PACKAGE_ROOT = "vendor";
export const AUTHORIZED_VENDORED_TARBALL_PATTERN: RegExp =
  /^vendor\/pactium-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz$/u;

export const SOURCE_PACKAGE_ROOTS: readonly string[] = Object.freeze([
  "packages",
  "plugins",
  AUTHORIZED_VENDORED_PACKAGE_ROOT,
  "apps/server",
  "apps/console",
  "content",
  "tools",
  "docs/README.md",
  "docs/RUNBOOK.md",
  "docs/COMPATIBILITY.md",
  "docs/ENTITY-CONFIG-LAYOUT.md",
  "docs/architecture-overview.svg",
  "docs/banner.svg",
  "docs/logo.svg",
  "docs/architecture",
  "docs/adrs",
  "docs/examples",
  "docs/functionality",
  "docs/protocols"
]);

export const ROOT_SOURCE_FILES: readonly string[] = Object.freeze([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.node.json",
  "vite.config.ts",
  "vitest.config.ts",
  "Dockerfile",
  "docker-compose.yml",
  ".dockerignore",
  ".env.example",
  ".gitattributes",
  ".gitignore",
  "README.md",
  "README.zh-CN.md",
  "PRODUCT.md",
  "LICENSE",
  "CHANGELOG.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md"
]);

export const INTERNAL_SOURCE_PACKAGE_EXCLUDED_PATHS: readonly string[] = Object.freeze([
  "docs/plans",
  "docs/reports"
]);
