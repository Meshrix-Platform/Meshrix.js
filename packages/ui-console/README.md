# `@meshrix/ui-console`

`@meshrix/ui-console` is the browser-side Vue component and helper package used by Meshrix.js consoles. Its package exports provide ESM modules, TypeScript declarations, and one stylesheet asset. It does not contain server executors or depend on server-runtime.

## Requirements

- Vue 3.5 or later in the `3.x` line.
- Element Plus 2.13 or later in the `2.x` line. `OptionBar` imports `ElSelect` and `ElOption` directly, so the host does not need to register those components globally.
- The host application must load Element Plus' stylesheet and provide the Meshrix console CSS custom properties used by these components.

Install the package with its peers, then load styles once from the host entry point:

```ts
import "element-plus/dist/index.css";
import "@meshrix/ui-console/styles.css";
```

The component stylesheet uses host-provided tokens including `--bg-surface`, `--bg-subtle`, `--border-subtle`, `--border-strong`, `--brand`, `--brand-muted`, `--brand-subtle`, `--brand-strong`, `--danger`, `--danger-border`, `--danger-surface`, `--info`, `--info-border`, `--info-surface`, `--success`, `--success-border`, `--success-surface`, `--warning-border`, `--warning-surface`, `--warning-text`, `--text-primary`, `--text-secondary`, `--text-muted`, `--text-on-brand`, `--text-xs`, `--text-sm`, `--text-md`, `--font-medium`, `--font-semibold`, `--leading-tight`, `--radius-xs`, `--radius-sm`, `--radius-full`, `--space-1`, `--space-1-5`, `--space-2`, `--space-2-5`, `--space-3`, `--dur-fast`, `--dur-base`, `--ease-std`, and `--ease-emphasized`.

## Public modules

The package exposes `binary-checkbox`, `option-bar`, `status-pill`, `bridge-http`, `browser-downloads`, `browser-window`, `console-client-display-utils`, `console-format-utils`, `error-message`, `page-refresh`, `rpc-client`, and `workspaces-view-context`. Existing PascalCase component subpaths remain equivalent entry points. Every JavaScript entry publishes browser ESM and generated declarations. The `styles.css` subpath is a CSS asset and should be imported through a browser bundler.

Option bar consumers can import its public option and event types:

```ts
import OptionBar from "@meshrix/ui-console/option-bar";
import type { OptionBarEmits, OptionBarOption, OptionBarProps } from "@meshrix/ui-console/option-bar";
```

The view-context helpers carry a host-owned type and do not import Console implementation details:

```ts
provideWorkspacesView<WorkspaceContext>(context);
const view = useWorkspacesViewContext<WorkspaceContext>();
```

When using the workspace directly, the `source` export condition selects TypeScript and Vue sources for the Console development build. Published consumer exports use the built ESM and declarations.

## Package checks

```bash
npm run build --workspace @meshrix/ui-console
npm run typecheck --workspace @meshrix/ui-console
npm run console:verify
```
