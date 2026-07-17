# Browser

Render HTML to PDF using headless Chromium. No credentials required — every
function is callable out of the box.

## What it does

The `browser` plugin gives agent workflows the ability to produce
print-ready documents: invoices, reports, receipts, and any structured output
that benefits from real CSS layout. It spins up headless Chromium, renders the
supplied HTML, and returns base64-encoded PDF bytes.

Typical uses:

- **Invoice generation** — render a styled invoice from extracted data and
  attach it to an email (compose with the `gmail` plugin).
- **Report export** — turn a workflow's structured output into a PDF summary.
- **Receipts** — generate branded receipts after a completed action.

## Functions

| Function | Purpose |
|---|---|
| `generatePdf` | Render full HTML (with CSS, tables, images as data URIs) to base64-encoded PDF bytes. |

The full function signature (parameters, return type) is available via the
`plugins:info` command in the dashboard.

## Credentials

**None.** This plugin has no auth block and no `requiredCredentials` — it runs
entirely within the sandbox. Every function is immediately callable once the
plugin is enabled on an agent.

## Using it in a workflow

```typescript
const pdf = await generatePdf({
  html: `
    <html>
      <body style="font-family: sans-serif;">
        <h1>Invoice #1042</h1>
        <table>
          <tr><td>Consulting</td><td>$1,200.00</td></tr>
          <tr><td><strong>Total</strong></td><td><strong>$1,200.00</strong></td></tr>
        </table>
      </body>
    </html>
  `,
});

// `pdf` is base64 bytes — attach to an email (gmail plugin) or store as an
// artifact. Images must be embedded as data URIs; external URLs are not fetched.
```

## Security model (v1.1.0)

The renderer is hardened against agent-authored HTML:

- **JavaScript is disabled.** A Content-Security-Policy
  (`script-src 'none'`) is injected into the document head, so `<script>`
  tags and inline event handlers never execute.
- **All external/resource requests are blocked.** Every subresource request is
  intercepted and aborted unless it uses a safe scheme (`data:`, `blob:`,
  `about:`). This blocks `http`/`https` (external and private-network), `file`,
  `ftp`, and `ws` — no exfiltration, no SSRF, no local-file reads.
- **Renders are serialized** — at most one Chromium render runs per daemon
  process at a time.
- **Hard ceilings:** 10 MB HTML input, 50 MB PDF output, and a 30 s render
  timeout (launch + render + pdf).
- **Guaranteed cleanup:** the page and browser are closed in `finally`.
- **Sanitized errors:** thrown messages never include HTML content, file paths,
  or secrets.

The Chromium browser binary is provided by the daemon image
(`PLAYWRIGHT_BROWSERS_PATH`); the Playwright JS package is self-contained in
the plugin's own `node_modules` and is **not** shared across the daemon's
runtime pool.

## Notes

- Images and fonts must be **embedded as data URIs** — external resources are
  blocked (see Security model).
- The returned bytes are base64-encoded; decode before writing to a file or
  pass directly to an email attachment function.
- No `guides/` reference yet; agent usage patterns can be added later.
