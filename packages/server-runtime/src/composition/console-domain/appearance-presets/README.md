# Appearance Presets Console Catalog

This directory owns the optional server-side catalog for Web GUI appearance presets.

`apps/console/` remains the owner of built-in preset JSON, frontend validation, token resolution, and DOM application. This server-side Console domain service only validates imported preset JSON and persists it under the Meshrix server data directory so generated Web GUI presets can be shared across browser sessions through the Console API.

This module is application-layer code. It must not move into `core/environment-compatibility`, because appearance presets are a Web GUI display contract rather than an OS or host-runtime compatibility concern.
