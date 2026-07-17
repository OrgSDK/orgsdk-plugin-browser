# Changelog

All notable releases of `@orgsdk/plugin-browser` are documented here.

The catalog treats versions as **write-once**: a given `(slug, version)` may be
re-published only with identical artifact content; differing content is
rejected with HTTP 409. Every entry below is therefore forward-only.

## [1.1.1] — standalone repository extraction (forward patch)

A forward-only patch release that migrates the `browser` plugin from the
OrgSDK monorepo (`packages/plugins/src/browser/`, commit `b99c239`) into this
standalone repository. **No plugin source behavior changed** — the
`generatePdf` function signature, return type, hardened renderer controls, the
flat-module entry shape, and the `playwright@1.60.0` runtime dependency are
byte-identical to the monorepo `1.1.0`.

### Why 1.1.1 (not 1.1.0)

The repository/package/schema additions alter the immutable publishable content
of the staged artifact:

- manifest `$schema` (`https://orgsdk.ai/schemas/plugin-manifest.v1.json`)
- `marketplace.links.sourceRepo` provenance link
- type-only import specifier migration `orgsdk/plugins` → `@orgsdk/plugins`
- the generated artifact `package.json` carrying the `playwright@1.60.0`
  runtime dependency
- metadata.version bump inside the `generatePdf` safe-function (`1.1.0` →
  `1.1.1`) so the function-level version tracks the manifest version

Because catalog versions are write-once, the existing `1.1.0` artifact cannot
be re-published with this changed content — it would differ and be rejected
with HTTP 409. Rather than mutate the published history of `1.1.0`, the new
artifact lands as a fresh `1.1.1` entry.

### Changed

- Bump `plugin/.plugin.json` version `1.1.0` → `1.1.1` (catalog source of
  truth).
- Bump `package.json` version `1.1.0` → `1.1.1` (kept in sync; enforced by the
  CI version guard).
- Add manifest `$schema` and `marketplace.links.sourceRepo`.
- Update type-only import specifier `orgsdk/plugins` → `@orgsdk/plugins`.
- Bump `generatePdf` metadata.version `1.1.0` → `1.1.1`.

### Frozen (unchanged from monorepo b99c239)

- The `generatePdf` safe function — name, parameters, return type, description,
  docs block, caveats, seeAlso.
- The flat-module entry shape (`entry: pdf-functions.ts`, no factory default
  export — exports `safeFunctions` + `moduleDescription` directly).
- The hardened renderer (`browser-renderer.ts`) — every control preserved:
  CSP injection (`script-src 'none'`), route interception (only
  `data:`/`blob:`/`about:` continue), `domcontentloaded`, 30 s render cap,
  module-level mutex (max-1 concurrency), 10 MB HTML / 50 MB PDF ceilings,
  guaranteed `finally` cleanup of page + browser, sanitized errors (no HTML /
  path / secret leak).
- The lazy `await import("playwright")` in `defaultLauncher.launch` (the
  contract that lets unit tests run without the Playwright package installed).
- The `playwright@1.60.0` exact-pin runtime dependency.
- `plugin/docs/overview.md` — verbatim.

### Runtime dependency + packaging contract

`playwright@1.60.0` is the single runtime dependency. The Chromium binary
itself is NOT part of the npm package — it is provided by the daemon image at
`PLAYWRIGHT_BROWSERS_PATH`. The Playwright JS closure is ~3–5 MB and is
shipped **self-contained** in the plugin's own `node_modules` via the
catalog's `__deps.tar.b64` fallback path:

1. **Publish time:** `resolvePluginDeps` (in `packages/platform/src/plugins/`)
   attempts `Bun.build` to inline Playwright into `__bundle.js`. Playwright's
   transitive `chromium-bidi` uses a dynamic import that defeats static
   bundling, so the build fails. The platform catches the failure and falls
   back to `tar czf node_modules | base64` → ships the archive as a
   `PluginFile` under the reserved `__deps.tar.b64` path. The 15 MB soft
   ceiling (`MAX_ARCHIVE_BYTES`) is never approached.
2. **Boot time:** `writePluginFolder` (in `packages/daemon/src/plugins/`)
   detects the reserved path, base64-decodes, and `tar xzf`-extracts into
   `<plugin>/node_modules`. The plugin's lazy `import("playwright")` then
   resolves from that local folder — never from the daemon image's shared
   `node_modules` pool.

`tests/deps-archive.test.ts` verifies this pipeline end-to-end: staging,
archive size below the ceiling, lossless extraction round-trip, and Playwright
resolution from the extracted location only.

### Server-process assumptions

- **Publish time:** `resolvePluginDeps` runs `bun install` + attempts
  `Bun.build` in a temp staging dir. Requires network access to resolve
  `playwright` from npm. Bundling fails (expected) → falls back to the
  `__deps.tar.b64` archive.
- **Daemon runtime:** `writePluginFolder` extracts the archive to
  `<plugin>/node_modules`. The Chromium browser binary is expected at
  `PLAYWRIGHT_BROWSERS_PATH` (set by the daemon Docker image — the binary is
  NOT shipped with the plugin). No network access at runtime — every
  subresource request from the rendered document is intercepted and aborted
  unless it uses a safe scheme.

### Test coverage (vs monorepo)

Ported verbatim from `tests/plugins/browser-renderer.test.ts` (commit
`b99c239`):

- `browser-renderer.test.ts` — every hardening control asserted with a mock
  launcher (CSP injection, route interception, byte ceilings, mutex,
  cleanup, sanitized errors). The import path is the only change.

New tests added by the extraction:

- `manifest.test.ts` — v1.1.1 manifest contract (slug, version, $schema,
  entry, no auth, sourceRepo, preserved marketplace metadata).
- `purity.test.ts` — no private `@orgsdk/*` runtime imports, type-only SDK
  imports, playwright is lazy-imported, exactly one runtime dependency.
- `plugin-shape.test.ts` — flat-module entry, exactly one safe function,
  preserved return type, preserved parameter shape, preserved category.
- `packaging.test.ts` — deterministic `orgsdk-plugin package` output, stale
  removal, generated package.json carries only `playwright@1.60.0`.
- `deps-archive.test.ts` — the dependency-archive fallback pipeline
  (publish-time bundling failure → archive → boot-time extraction →
  local-only resolution).
- `chromium-integration.test.ts` — env-gated real-Chromium verification
  (`BROWSER_INTEGRATION=1`); default test runs skip it (no browser binary
  required).

### Deferred to Phase 3 / later work

- Catalog publication is not yet enabled (`ORGSDK_ENABLE_CATALOG_PUBLISH`
  remains unset on this repository). Phase 3 enables publication after
  platform-side verification of the dependency-archive fallback path.
- The daemon image's Chromium binary version compatibility with Playwright
  1.60.0 is a deploy-time concern (see `docs/goals.md` in the monorepo);
  not in scope for this extraction.
