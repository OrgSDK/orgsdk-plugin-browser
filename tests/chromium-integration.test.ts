/**
 * Real-Chromium integration test — env-gated.
 *
 * Default `bun run test` SKIPS this file entirely: it requires a real
 * Chromium binary installed via `bunx playwright install chromium` (or
 * provided by the daemon image at PLAYWRIGHT_BROWSERS_PATH). Enable with
 * `BROWSER_INTEGRATION=1` (the npm script `test:integration` does this).
 *
 * The hardening model is the contract under test. The integration must:
 *  - actually launch headless Chromium via the default launcher (the same
 *    code path the daemon uses at runtime);
 *  - render a data:-only HTML document to a real PDF (asserts %PDF- magic
 *    bytes and a non-trivial byte count);
 *  - complete within the 30s render cap (RENDER_TIMEOUT_MS);
 *  - leave no orphan browser process behind (module mutex + finally cleanup).
 *
 * Network trap avoidance: the route handler aborts every non-safe scheme, so
 * any incidental external request Chromium might make (e.g. favicon, font
 * fallback, OCSP) is intercepted and aborted — never sent. The rendered
 * document itself contains ONLY data: URLs, so there is nothing legitimate
 * to fetch either. The integration can run in a network-isolated CI environment.
 */
import { describe, expect, it } from "bun:test";
import { RENDER_TIMEOUT_MS, renderHtmlToPdf } from "../plugin/browser-renderer";

const ENABLED = process.env.BROWSER_INTEGRATION === "1";

const describeIntegration = ENABLED ? describe : describe.skip;

describeIntegration("real-Chromium integration (BROWSER_INTEGRATION=1)", () => {
	it("renders a data:-only HTML document to a real PDF", async () => {
		// A small red square as a data URI — the only subresource the document
		// references. Everything else is inline CSS.
		const redSquare =
			"data:image/svg+xml;base64," +
			Buffer.from(
				'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">' +
					'<rect width="40" height="40" fill="#dc2626"/></svg>',
			).toString("base64");

		const html = `<html>
  <head>
    <style>
      body { font-family: sans-serif; padding: 24px; }
      h1 { color: #111827; }
      .badge { display: inline-block; padding: 4px 12px; background: #f3f4f6; }
    </style>
  </head>
  <body>
    <h1>Integration Fixture</h1>
    <p class="badge">rendered by headless Chromium</p>
    <p><img src="${redSquare}" alt="red square" width="40" height="40"/></p>
    <table>
      <tr><th>Item</th><th>Amount</th></tr>
      <tr><td>Fixture</td><td>$0.00</td></tr>
    </table>
  </body>
</html>`;

		const t0 = Date.now();
		const result = await renderHtmlToPdf(html, {
			format: "A4",
			margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
		});
		const elapsedMs = Date.now() - t0;

		expect(result.sizeBytes).toBeGreaterThan(1000);
		expect(result.sizeBytes).toBeLessThan(50 * 1024 * 1024);
		// Real PDF bytes start with %PDF-. Uint8Array byte access stays clean.
		expect(result.bytes[0]).toBe(0x25); // %
		expect(result.bytes[1]).toBe(0x44); // D
		expect(result.bytes[2]).toBe(0x50); // P
		expect(result.bytes[3]).toBe(0x46); // F
		expect(result.bytes[4]).toBe(0x2d); // -
		// Must finish inside the production render cap.
		expect(elapsedMs).toBeLessThan(RENDER_TIMEOUT_MS);
	});

	it("renders successfully even when the HTML attempts external requests (route handler aborts them)", async () => {
		// The document references an external image. The plugin's route handler
		// must abort the request (no network egress) and the render must still
		// succeed — the missing image is a broken-img, not a fatal error.
		const html = `<html>
  <body>
    <h1>Network-Trap Fixture</h1>
    <p>This document tries to load an external resource:</p>
    <img src="http://169.254.169.254/latest/meta-data/iam/security-credentials/role"
         alt="should be blocked" width="1" height="1"/>
    <p>End of document.</p>
  </body>
</html>`;

		const result = await renderHtmlToPdf(html, { format: "A4" });
		expect(result.sizeBytes).toBeGreaterThan(500);
		expect(result.bytes[0]).toBe(0x25); // %PDF-
	});

	it("serializes concurrent renders through the module mutex", async () => {
		// Three concurrent renders must all succeed; the module-level mutex
		// ensures only one Chromium is active at a time.
		const doc = "<html><body><h1>concurrent</h1></body></html>";
		const results = await Promise.all([
			renderHtmlToPdf(doc, undefined),
			renderHtmlToPdf(doc, undefined),
			renderHtmlToPdf(doc, undefined),
		]);
		for (const r of results) {
			expect(r.sizeBytes).toBeGreaterThan(0);
			expect(r.bytes[0]).toBe(0x25); // %PDF-
		}
	});
});

// Always-on sanity: confirms whether the integration suite is active in this
// run. Visible in test output so a maintainer doesn't have to grep for skips.
describe("integration gating", () => {
	it(`BROWSER_INTEGRATION is ${ENABLED ? "ENABLED" : "disabled (set =1 to run real-Chromium tests)"}`, () => {
		// No assertion — informational.
		expect(true).toBe(true);
	});
});
