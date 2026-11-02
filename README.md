# @orgsdk/plugin-browser

## Current npm distribution and execution checks

Updated **31 October 2026**. This public-release candidate uses `@orgsdk/plugins@0.2.2`
and `@orgsdk/executor@0.1.0` (with the tracked packaging compatibility patch).
`bun run build:npm` creates a public Apache-2.0 npm payload; `bun run test:executor`
downloads the extracted npm entry into an empty executor store and executes every exported function headlessly.
`bun run test:registration` verifies fresh-project registration using the npm host.
See [npm distribution, CI activation and verification](docs/npm-distribution.md)
for prerequisites, commands, fixtures and release settings. Publication remains
an explicit release operation; source-root `private: true` is retained.

## Current installation and credential contract

Configure the generated `dist/npm/plugin.catalog.json` as an OrgSDK release
catalogue, then add its pinned external release to a project. Installing npm files
alone does not register the plugin. Its package URL addresses the immutable npm
version through jsDelivr; that URL becomes available only after publication.
The catalogue retains the bundle's SHA256 digest. No release is published by
building or testing locally.

Native Google, Twitter, LinkedIn and Facebook OAuth connections are owned by the
OrgSDK host. Plugins receive only `{source: "byo", secret_accessToken}` under
their provider key. Client and refresh secrets stay on the host. The retired
first-party relay is unsupported. Generic token providers receive their stored
secret record. See [the current distribution guide](docs/npm-distribution.md).

## Historical author-source and hosted-catalogue reference

The material below preserves the original extraction and legacy authoring
workflows. Its callback/relay, source-archive publication and private-licence
claims describe the former host. The current npm, authentication and licensing
contract above supersedes those claims.


Official OrgSDK plugin for hardened HTML→PDF rendering. Spins up headless
Chromium with JavaScript disabled and every external/resource request blocked,
then returns base64-encoded PDF bytes. No credentials required — every
function is callable out of the box.

[![CI](https://github.com/OrgSDK/orgsdk-plugin-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/OrgSDK/orgsdk-plugin-browser/actions/workflows/ci.yml)

## What it does

`generatePdf({ html, options })` renders a full HTML document (inline CSS,
tables, images as data URIs) to a PDF via headless Chromium. The result is
base64-encoded bytes suitable for storing as an artifact, attaching to an
email, or returning from a workflow.

## Security model (v1.1.x)

The renderer is hardened against agent-authored HTML. The adversary is the
workflow author; the capabilities at stake are network egress (SSRF / exfil),
filesystem read (`file://`), resource exhaustion, and process leaks. Controls:

- **JavaScript is disabled.** A Content-Security-Policy
  (`script-src 'none'`) is injected into the document head — `<script>` tags
  and inline event handlers never execute.
- **All external/resource requests are blocked.** Every subresource request is
  intercepted and aborted unless it uses a safe scheme (`data:`, `blob:`,
  `about:`). This blocks `http`/`https` (external AND private-network),
  `file`, `ftp`, `ws` — no exfiltration, no SSRF, no local-file reads.
- **`domcontentloaded` only.** Never `networkidle` (the latter would wait on,
  and thus be held hostage by, network activity).
- **Renders are serialized** — at most one Chromium render runs per daemon
  process at a time (module-level mutex via promise chain).
- **Hard ceilings:** 10 MB HTML input, 50 MB PDF output, 30 s render timeout
  (launch + render + pdf, each separately capped).
- **Guaranteed cleanup:** page and browser are closed in `finally`.
- **Sanitized errors:** thrown messages never include HTML content, file
  paths, or secrets. Authored messages (`generatePdf:` prefix) are preserved;
  any unexpected error is replaced with `generatePdf: render failed`.

## Runtime dependency

Playwright is pinned to **1.64.1**. The executor packager embeds its JavaScript
closure in the npm bundle. Install the matching Chromium build and OS libraries
before execution; CI uses `playwright install --with-deps chromium`. A real
headless render of the extracted npm package is required by the executor test.

See [npm distribution](docs/npm-distribution.md) for current packaging and tests.
[docs/release.md](docs/release.md) retains the historical hosted-catalogue archive
investigation; it does not describe the current executor capsule.

## Repository layout

```
orgsdk-plugin-browser/
├── .github/workflows/
│   ├── ci.yml                 # author checks + headless npm executor tests
│   └── publish-catalog.yml    # reusable publish workflow (opt-in; manual dry-run)
├── plugin/                    # the publishable plugin folder
│   ├── .plugin.json           # manifest (slug, version, marketplace, sourceRepo)
│   ├── pdf-functions.ts       # entry — flat module exporting safeFunctions
│   ├── browser-renderer.ts    # hardened renderer + lazy Playwright launcher
│   └── docs/overview.md       # plugin-local docs
├── tests/                     # bun:test — manifest, purity, shape, renderer, packaging, deps-archive, chromium-integration
├── docs/                      # release/promotion contract
├── package.json
├── tsconfig.json
├── biome.json
└── README.md
```

## Local development

Requires [Bun](https://bun.sh) ≥ 1.3.x.

```bash
# Install (frozen lockfile in CI; dev: generates one)
bun install

# Lint + format check
bun run check

# Typecheck (no emit)
bun run typecheck

# Run tests (mocked — no Chromium binary needed)
bun run test

# Validate manifest + source purity (orgsdk-plugin validate)
bun run validate

# Stage distributable artifact into dist/ (orgsdk-plugin package)
bun run package

# Full build pipeline (typecheck → validate → package)
bun run build
```

### Real-Chromium integration (optional)

Default tests use a mock launcher — fast, deterministic, no browser binary
required. To exercise the real Chromium path (the daemon-image execution
contract):

```bash
# 1. Install the driver-matched Chromium build once.
bunx playwright install chromium

# 2. Run the integration suite.
bun run test:integration        # sets BROWSER_INTEGRATION=1 under the hood
```

The integration renders data:-only documents, so every incidental external
request is intercepted and aborted by the route handler — no network egress,
no network trap is hit.

## Functions

| Function | Purpose | Category |
|---|---|---|
| `generatePdf` | Render full HTML to base64-encoded PDF bytes | `browser` |

```typescript
const pdf = await generatePdf({
  html: `<html><body><h1>Invoice #1042</h1>...</body></html>`,
  options: { format: "A4", filename: "invoice-1042.pdf" },
});
// → { base64: "JVBERi0xLjQK...", sizeBytes: 45230, filename: "invoice-1042.pdf" }
```

See [plugin/docs/overview.md](plugin/docs/overview.md) for the full security
model and usage notes.

## Versioning

The manifest version (`plugin/.plugin.json` → `version`) is the source of
truth for the catalog. `package.json` → `version` is kept in sync (enforced by
the CI version guard). Catalog versions are write-once: a given `(slug,
version)` may be re-published only with identical artifact content; differing
content is rejected with HTTP 409.

## License

Apache-2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE) and [TRADEMARKS.md](TRADEMARKS.md).
