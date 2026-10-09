# Entry identity, custody, pairing and recovery

`@meshrix/entry` is the UI-agnostic state/model layer for the installed macOS
and Windows GUI entry product. It owns:

- `src/identity/` — device key custody adapters (macOS Keychain via `security`,
  Windows DPAPI via `ProtectedData`, encrypted file fallback) behind one narrow
  `CustodyAdapter` interface, plus device identity generation.
- `src/recovery/` — the single user-held recovery key (chunked base32 text),
  HKDF-SHA-256 purpose-separated derivation (recovery signing, backup
  encryption, vault writer), AES-256-GCM snapshot sealing, the recovery-vault
  CAS client, snapshot freshness enforcement and the fresh-device recovery /
  staged rotation state machines.
- `src/pairing/` — the out-of-band pairing invite payload schema and the
  pairing state machine that produces contract-shaped `EndpointTrustBinding`
  material and secret-free enrolled device records.

Wire shapes are consumed from `@meshrix/contracts/private-relay`; this package
defines no protocol surface of its own. No secret material ever serializes into
exported state objects.
