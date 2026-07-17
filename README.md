# @orgsdk/plugin-browser

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

Playwright (`playwright@1.60.0` exactly — pinned to the driver the hardening
was qualified against). The Chromium binary itself is provided by the daemon
image at `PLAYWRIGHT_BROWSERS_PATH`; the Playwright JS package is shipped
**self-contained** in the plugin's own `node_modules` via the catalog's
`__deps.tar.b64` fallback (Playwright's `chromium-bidi` dynamic import defeats
`Bun.build`, so the platform's `resolvePluginDeps` falls back to shipping the
dependency tree as an archive). The daemon's `writePluginFolder` extracts the
archive into `<plugin>/node_modules` at boot — Playwright never pollutes the
daemon image's shared `node_modules` pool.

See [docs/release.md](docs/release.md) for the full packaging + fallback story.

## Repository layout

```
orgsdk-plugin-browser/
├── .github/workflows/
│   ├── ci.yml                 # reusable CI (mocked) + opt-in real-Chromium job
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

Apache-2.0 (matches the OrgSDK plugin authoring SDK).
