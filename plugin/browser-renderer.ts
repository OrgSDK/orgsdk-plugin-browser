/**
 * Hardened HTML→PDF renderer (browser plugin v1.1.0).
 *
 * Security model (see docs/goals.md §3; sandbox + security-review skills):
 *  - Agent-authored HTML reaches a real Chromium process. The adversary is a
 *    workflow author. Capabilities at stake: network egress (SSRF / exfil),
 *    filesystem read (file://), resource exhaustion, process leaks.
 *  - JavaScript is DISABLED: a Content-Security-Policy meta is injected into
 *    <head> (`script-src 'none'`) so no inline/external script or event
 *    handler executes. Defense in depth: every subresource request is also
 *    intercepted and aborted unless it uses a safe scheme.
 *  - Only safe inline/data/blob/about resources load. http(s)/file/ftp/ws
 *    requests are aborted — this blocks external AND private-network AND
 *    local-file access from inside the rendered document.
 *  - `domcontentloaded` is used, never `networkidle` (the latter would wait
 *    on, and thus be held hostage by, network activity).
 *  - Max one concurrent render per process (module-level mutex).
 *  - Hard ceilings: HTML bytes, PDF bytes, render timeout.
 *  - Guaranteed cleanup: page + browser are closed in `finally`.
 *  - Errors are sanitized — no URL, path, HTML content, or secret is ever
 *    surfaced in a thrown message or log.
 *
 * The Playwright dependency is resolved lazily and is injectable so unit
 * tests can pass a mock launcher without importing Playwright.
 */

export type PdfPageFormat = "A4" | "Letter";

export interface PdfMargin {
	top?: string;
	right?: string;
	bottom?: string;
	left?: string;
}

export interface RenderOptions {
	format?: PdfPageFormat;
	landscape?: boolean;
	margin?: PdfMargin;
}

export interface RenderResult {
	/** Raw PDF bytes (Uint8Array, not base64 — the caller encodes). */
	bytes: Uint8Array;
	sizeBytes: number;
}

/**
 * Minimal structural interface over Playwright's Page — mockable in tests.
 *
 * `route` returns `Promise<unknown>` (not `Promise<void>`) because Playwright
 * 1.60's `Page.route()` returns `Promise<Disposable>`. The renderer awaits the
 * call and discards the result, so the broader return type is exact — zero
 * runtime behavior change. The handler itself is still `=> Promise<void>`.
 */
export interface RenderPage {
	setContent(
		html: string,
		opts: { waitUntil: "domcontentloaded" },
	): Promise<void>;
	route(
		url: string,
		handler: (route: InterceptedRoute) => Promise<void>,
	): Promise<unknown>;
	pdf(opts: {
		format?: PdfPageFormat;
		landscape?: boolean;
		margin?: PdfMargin;
		printBackground?: boolean;
	}): Promise<Uint8Array>;
	close(): Promise<void>;
}

export interface InterceptedRoute {
	request(): { url(): string };
	abort(): Promise<void>;
	continue(): Promise<void>;
}

/** Minimal structural interface over Playwright's Browser — mockable. */
export interface RenderBrowser {
	newPage(): Promise<RenderPage>;
	close(): Promise<void>;
}

export interface ChromiumLauncher {
	launch(): Promise<RenderBrowser>;
}

const MAX_HTML_BYTES = 10 * 1024 * 1024;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
export const RENDER_TIMEOUT_MS = 30_000;

/**
 * CSP injected into <head>. Blocks all script execution (inline + external +
 * event handlers) and every default network resource. Only inline styles and
 * data:/blob:/about: images/fonts are permitted — exactly what a
 * self-contained printable document needs.
 */
const CSP_META =
	'<meta http-equiv="Content-Security-Policy" ' +
	"content=\"default-src 'none'; style-src 'unsafe-inline'; " +
	"img-src data: blob: about:; font-src data:; script-src 'none'\">";

/** Schemes that may load inside the rendered document. Everything else aborts. */
const SAFE_URL = /^(data:|blob:|about:)/i;

/**
 * Default launcher: lazy-imports Playwright from the plugin-local
 * node_modules. Playwright's `Browser` structurally satisfies `RenderBrowser`
 * (every method's return type is assignable — `Buffer` is a `Uint8Array`
 * subtype; `Promise<Disposable>` widens to `Promise<unknown>`).
 */
const defaultLauncher: ChromiumLauncher = {
	async launch(): Promise<RenderBrowser> {
		const { chromium } = await import("playwright");
		return chromium.launch({
			headless: true,
			// The browser binary is provided by the daemon image at
			// PLAYWRIGHT_BROWSERS_PATH; no sandbox arg is set here so Playwright
			// applies its own root-detection defaults.
		});
	},
};

// Max-1 concurrent render per process (module-level mutex via promise chain).
let renderChain: Promise<unknown> = Promise.resolve();

function injectCsp(html: string): string {
	const meta = CSP_META;
	if (/<head[^>]*>/i.test(html)) {
		return html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`);
	}
	if (/<html[^>]*>/i.test(html)) {
		return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${meta}</head>`);
	}
	return `<head>${meta}</head>${html}`;
}

async function withTimeout<T>(
	label: string,
	work: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`generatePdf: ${label} timed out`)),
			timeoutMs,
		);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Intercept every subresource request; abort anything not on a safe scheme. */
async function lockDownNetwork(page: RenderPage): Promise<void> {
	await page.route("**/*", async (route) => {
		const url = route.request().url();
		if (SAFE_URL.test(url)) {
			await route.continue();
			return;
		}
		await route.abort();
	});
}

async function renderOnce(
	html: string,
	options: RenderOptions | undefined,
	launcher: ChromiumLauncher,
	timeoutMs: number,
): Promise<RenderResult> {
	const browser = await withTimeout("launch", launcher.launch(), timeoutMs);
	const page = await browser.newPage();
	try {
		await lockDownNetwork(page);
		await withTimeout(
			"render",
			page.setContent(injectCsp(html), { waitUntil: "domcontentloaded" }),
			timeoutMs,
		);
		const pdfBytes = await withTimeout(
			"pdf",
			page.pdf({
				format: options?.format ?? "A4",
				landscape: options?.landscape ?? false,
				margin: options?.margin ?? {
					top: "20mm",
					right: "15mm",
					bottom: "20mm",
					left: "15mm",
				},
				printBackground: true,
			}),
			timeoutMs,
		);
		if (pdfBytes.byteLength > MAX_PDF_BYTES) {
			throw new Error("generatePdf: rendered PDF exceeds size limit");
		}
		return { bytes: pdfBytes, sizeBytes: pdfBytes.byteLength };
	} finally {
		await page.close().catch(() => {});
		await browser.close().catch(() => {});
	}
}

/**
 * Render HTML to PDF bytes. Enforces every hardening control and serializes
 * renders (max one in flight per process). Throws sanitized errors only —
 * messages authored here (`generatePdf:` prefix) are preserved; any other
 * thrown error is replaced with a generic `render failed` so agent-authored
 * HTML, file paths, or secrets never surface in errors or logs.
 *
 * `timeoutMs` is configurable for tests (defaults to the production 30s cap).
 */
export async function renderHtmlToPdf(
	html: string,
	options: RenderOptions | undefined,
	launcher: ChromiumLauncher = defaultLauncher,
	timeoutMs: number = RENDER_TIMEOUT_MS,
): Promise<RenderResult> {
	if (typeof html !== "string" || html.trim().length === 0) {
		throw new Error("generatePdf: html content is required");
	}
	if (Buffer.byteLength(html, "utf-8") > MAX_HTML_BYTES) {
		throw new Error("generatePdf: html content exceeds size limit");
	}

	const run = renderChain.then(
		() => renderOnce(html, options, launcher, timeoutMs),
		() => renderOnce(html, options, launcher, timeoutMs),
	);
	renderChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run.catch((err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.startsWith("generatePdf:")) throw err;
		// Unexpected error (e.g. from Playwright internals) — do not propagate
		// the raw message; it could carry HTML content, file paths, or secrets.
		throw new Error("generatePdf: render failed");
	});
}
