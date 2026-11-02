# Release & catalog promotion

Historical hosted-catalogue investigation. For the current restricted npm
payload and real executor/headless test, read [npm distribution](npm-distribution.md).

## Publishing model: not yet opted in

This repository is configured for automatic catalog publication via the shared
reusable workflow in [OrgSDK/plugins](https://github.com/OrgSDK/plugins), but
**publication is disabled** until the platform-side dependency-archive
fallback path is verified end-to-end against a production daemon image.

The `publish-catalog.yml` workflow runs on push to `main` for `plugin/**` and
`package.json` paths, but it short-circuits at the job level when
`ORGSDK_ENABLE_CATALOG_PUBLISH != 'true'`. The repo does not set that
variable yet. Pushes still produce a fully-validated build + dry-run preview
(no `POST` to the catalog, no secrets accessed).

Phase 3 (catalog publication) is the next milestone after this Phase 2
extraction lands.

## Required repository settings (when publication is enabled)

| Setting | Where | Value |
|---|---|---|
| `ORGSDK_ENABLE_CATALOG_PUBLISH` | Settings → Secrets and variables → **Variables** | `true` |
| `ORGSDK_CATALOG_URL` | Settings → Secrets and variables → **Variables** | `https://app.orgsdk.ai` |
| `ORGSDK_PUBLISH_TOKEN` | repository secret **or** `catalog-publish` environment secret | scoped catalog publisher token (secret) |
| `catalog-publish` environment | Settings → Environments | deployment branches restricted to `main` |

The token is sourced independently via the platform's deployed signing-root
process — never copied from another plugin repository.

## Runtime dependency + packaging contract

`browser` is the only official plugin with a runtime dependency that defeats
static bundling. The full pipeline:

```
                    publish time  (platform resolvePluginDeps)
                                  │
            ┌─────────────────────┴──────────────────────┐
            │  stage source + playwright@1.60.0           │
            │  bun install                                │
            │  Bun.build(entry, external=[zod]) ──────────┼── fails
            │           │                                 │   (chromium-bidi dynamic import)
            │           └── catch ──► tar czf node_modules │
            │                                  │ base64   │
            │                                  ▼          │
            │                       __deps.tar.b64 (<15MB)│
            └─────────────────────┬──────────────────────┘
                                  │
                                  ▼  catalog artifact (source-native, no bundle)
                    boot time     │
                    (daemon writePluginFolder)
                                  │
            ┌─────────────────────┴──────────────────────┐
            │  detect __deps.tar.b64 in plugin files     │
            │  base64-decode → tar xzf → <plugin>/node_modules │
            │  lazy import("playwright") resolves local  │
            └────────────────────────────────────────────┘
```

The Chromium browser binary is NOT shipped with the plugin — the daemon image
provides it at `PLAYWRIGHT_BROWSERS_PATH`. The plugin only ships the
Playwright JS driver closure (~3–5 MB base64).

## Test gates

- **Default CI** (`ci.yml` → reusable workflow): every push/PR runs the mocked
  test suite + `orgsdk-plugin validate` + `package`. No browser binary
  required. Fast and deterministic.
- **Integration CI** (`ci.yml` → `integration` job): opt in via
  `RUN_BROWSER_INTEGRATION == 'true'` repo variable, or trigger via
  `workflow_dispatch`. Installs the Playwright-matched Chromium build,
  sets `BROWSER_INTEGRATION=1`, and runs the real-Chromium suite. The
  integration renders data:-only documents — every incidental external
  request is intercepted+aborted by the route handler, so no network egress
  and no network trap is hit.

## Version policy

- **Current version:** `1.1.1`.
- The manifest version (`plugin/.plugin.json` → `version`) is the source of
  truth for the catalog. `package.json` → `version` is kept in sync (enforced
  by the CI version guard).
- Bump on **every** publishable content change. The version guard fails a
  PR/commit if publishable content changed but the manifest version did not.
- Versions are write-once in the catalog: re-publishing the same
  `(slug, version)` with identical content is idempotent; different content is
  rejected with HTTP 409.

## The artifact

`bun run package` produces:

```
dist/
├── browser/                          # staged plugin folder (slug-named)
│   ├── .plugin.json
│   ├── package.json                  # generated: name, version, type, dependencies.playwright@1.60.0
│   ├── pdf-functions.ts
│   ├── browser-renderer.ts
│   └── docs/overview.md
├── browser-1.1.1.manifest.json       # file list + SHA-256 checksums (sorted)
└── browser-1.1.1.tgz                 # tarball of the plugin folder
```

Packaging is deterministic: `dist/` is fully removed and recreated on every
run. The generated `package.json` carries
`"dependencies": { "playwright": "1.60.0" }` (the only runtime dependency)
and no `@orgsdk/plugins` (type-only imports are erased).

The `__deps.tar.b64` archive is NOT produced by `orgsdk-plugin package` — it
is produced by the platform's `resolvePluginDeps` at publish time, after
`Bun.build` fails. `tests/deps-archive.test.ts` simulates that pipeline
locally so the contract is verifiable without standing up the platform.

## Manual dry-run / recovery

Run `Publish to Catalog` → `Run workflow` with `dry_run = true` (default).
This packages, validates, and prints the payload **without** POSTing. It does
not require `ORGSDK_PUBLISH_TOKEN`. Select `dry_run = false` to force a real
publish manually (requires the token AND `ORGSDK_ENABLE_CATALOG_PUBLISH=true`).
