# Meshrix Console Application

`apps/console` is the Meshrix Vue 3 server console (`@meshrix/console`). It provides the operator-facing console workspace: views, components, composables, routing, i18n, and appearance presets that drive the governed server console UI.

## Responsibilities

- Console workspace UI for operating the Meshrix server.
- Console routing, event routing, and admin surface composition.
- Appearance presets and localized console copy.

## Boundaries

- Console behavior reaches the server only through governed operations; no direct storage or privilege bypass lives here.
- The server executable and HTTP runtime belong to `apps/server`.
- Shared contracts and schemas belong to `packages/contracts/`.
- Console layout follows the repository [Change Rules](../../CONTRIBUTING.md#change-rules), including the shared-height contract for sibling controls in a horizontal action group.

## Verification

```bash
npm test
```
