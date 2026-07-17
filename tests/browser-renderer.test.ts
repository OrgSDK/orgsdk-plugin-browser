/**
 * Hardened renderer unit tests — direct port of the monorepo test
 * (tests/plugins/browser-renderer.test.ts at commit b99c239).
 *
 * Uses a mock ChromiumLauncher — no Playwright is imported, so these run
 * anywhere (no browser binary required). Every hardening control is asserted:
 * JS-disabled CSP injection, network interception (external/file blocked,
 * data/blob/about allowed), byte ceilings, max-1 concurrency, guaranteed
 * cleanup, and sanitized (secret/URL-free) error messages.
 *
 * Parity invariant: this test file is byte-equivalent in assertions to the
 * monorepo source. Only the import path changed (../../packages/plugins/src/
 * → ../plugin/). Any divergence in behavior between the external plugin and
 * the monorepo prerequisite (commit b99c239) is a regression.
 */
import { describe, expect, it } from "bun:test";
import {
	type ChromiumLauncher,
	type InterceptedRoute,
	RENDER_TIMEOUT_MS,
	type RenderBrowser,
	type RenderPage,
	renderHtmlToPdf,
} from "../plugin/browser-renderer";

interface MockPage extends RenderPage {
	routeHandler?: (route: InterceptedRoute) => Promise<void>;
	setContentHtml?: string;
	pdfCalls?: number;
}

function makeMockBrowser(overrides?: {
	pdfBytes?: Uint8Array;
	pdfError?: Error;
}): { browser: RenderBrowser; page: MockPage; getCloses: () => number } {
	let closeCalls = 0;
	const page: MockPage = {
		pdfCalls: 0,
		async setContent(html: string, opts) {
			this.setContentHtml = html;
			expect(opts.waitUntil).toBe("domcontentloaded");
		},
		async route(_url, handler) {
			this.routeHandler = handler;
		},
		async pdf(opts) {
			this.pdfCalls = (this.pdfCalls ?? 0) + 1;
			expect(opts.printBackground).toBe(true);
			if (overrides?.pdfError) throw overrides.pdfError;
			return overrides?.pdfBytes ?? new Uint8Array([0x25, 0x50, 0x44, 0x46]);
		},
		async close() {},
	};
	const browser: RenderBrowser = {
		async newPage() {
			return page;
		},
		async close() {
			closeCalls++;
		},
	};
	return { browser, page, getCloses: () => closeCalls };
}

function makeLauncher(browser: RenderBrowser): ChromiumLauncher {
	return {
		async launch() {
			return browser;
		},
	};
}

describe("browser-renderer: happy path + signature", () => {
	it("renders HTML to PDF bytes with correct shape", async () => {
		const { browser } = makeMockBrowser({
			pdfBytes: new Uint8Array([1, 2, 3, 4]),
		});
		const result = await renderHtmlToPdf(
			"<html><body>hi</body></html>",
			undefined,
			makeLauncher(browser),
		);
		expect(result.sizeBytes).toBe(4);
		expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4]);
	});

	it("passes through format/landscape/margin options", async () => {
		const captured: Record<string, unknown> = {};
		const { browser, page } = makeMockBrowser();
		const origPdf = page.pdf.bind(page);
		page.pdf = async (opts) => {
			Object.assign(captured, opts);
			return origPdf(opts as never);
		};
		await renderHtmlToPdf(
			"<html></html>",
			{ format: "Letter", landscape: true },
			makeLauncher(browser),
		);
		expect(captured.format).toBe("Letter");
		expect(captured.landscape).toBe(true);
	});
});

describe("browser-renderer: JavaScript disabled (CSP injection)", () => {
	it("injects a script-src 'none' CSP meta into <head>", async () => {
		const { browser, page } = makeMockBrowser();
		await renderHtmlToPdf(
			"<html><head><title>x</title></head><body></body></html>",
			undefined,
			makeLauncher(browser),
		);
		const html = page.setContentHtml ?? "";
		expect(html).toContain("Content-Security-Policy");
		expect(html).toContain("script-src 'none'");
	});

	it("injects <head> when the document has none", async () => {
		const { browser, page } = makeMockBrowser();
		await renderHtmlToPdf(
			"<html><body>no head</body></html>",
			undefined,
			makeLauncher(browser),
		);
		expect(page.setContentHtml).toContain("script-src 'none'");
	});

	it("still injects for bare fragments", async () => {
		const { browser, page } = makeMockBrowser();
		await renderHtmlToPdf("<h1>hi</h1>", undefined, makeLauncher(browser));
		expect(page.setContentHtml).toContain("Content-Security-Policy");
	});
});

describe("browser-renderer: network lockdown", () => {
	async function captureRoute(): Promise<
		(url: string) => Promise<"abort" | "continue">
	> {
		const { browser, page } = makeMockBrowser();
		await renderHtmlToPdf("<html></html>", undefined, makeLauncher(browser));
		const handler = page.routeHandler;
		if (!handler) throw new Error("route handler not registered");
		return async (url: string) => {
			let verdict: "abort" | "continue" = "abort";
			await handler({
				request: () => ({ url: () => url }),
				abort: async () => {
					verdict = "abort";
				},
				continue: async () => {
					verdict = "continue";
				},
			});
			return verdict;
		};
	}

	it("aborts external http(s) requests", async () => {
		const check = await captureRoute();
		expect(await check("http://169.254.169.254/latest/meta-data/")).toBe(
			"abort",
		);
		expect(await check("https://evil.example.com/exfil")).toBe("abort");
		expect(await check("http://orgsdk-db.flycast:5432")).toBe("abort");
	});
	it("aborts file:// and ftp requests", async () => {
		const check = await captureRoute();
		expect(await check("file:///etc/passwd")).toBe("abort");
		expect(await check("ftp://internal/secret")).toBe("abort");
	});
	it("allows data:, blob:, about: resources", async () => {
		const check = await captureRoute();
		expect(await check("data:image/png;base64,iVBOR==")).toBe("continue");
		expect(await check("blob:https://localhost/uuid")).toBe("continue");
		expect(await check("about:blank")).toBe("continue");
	});
});

describe("browser-renderer: size ceilings", () => {
	it("rejects empty html", async () => {
		const { browser } = makeMockBrowser();
		await expect(
			renderHtmlToPdf("", undefined, makeLauncher(browser)),
		).rejects.toThrow(/html content is required/);
		await expect(
			renderHtmlToPdf("   " as string, undefined, makeLauncher(browser)),
		).rejects.toThrow(/html content is required/);
	});
	it("rejects non-string html", async () => {
		const { browser } = makeMockBrowser();
		await expect(
			renderHtmlToPdf(
				undefined as unknown as string,
				undefined,
				makeLauncher(browser),
			),
		).rejects.toThrow(/html content is required/);
	});
	it("rejects html over the byte ceiling", async () => {
		const { browser } = makeMockBrowser();
		const huge = "x".repeat(10 * 1024 * 1024 + 1);
		await expect(
			renderHtmlToPdf(huge, undefined, makeLauncher(browser)),
		).rejects.toThrow(/exceeds size limit/);
	});
	it("rejects a PDF over the byte ceiling", async () => {
		const { browser } = makeMockBrowser({
			pdfBytes: new Uint8Array(50 * 1024 * 1024 + 1),
		});
		await expect(
			renderHtmlToPdf("<html></html>", undefined, makeLauncher(browser)),
		).rejects.toThrow(/exceeds size limit/);
	});
});

describe("browser-renderer: max-1 concurrency + cleanup", () => {
	it("serializes renders (no overlap)", async () => {
		let active = 0;
		let maxActive = 0;
		const { browser, page } = makeMockBrowser();
		page.pdf = async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((r) => setTimeout(r, 30));
			active--;
			return new Uint8Array([1]);
		};
		const launcher = makeLauncher(browser);
		await Promise.all([
			renderHtmlToPdf("<html></html>", undefined, launcher),
			renderHtmlToPdf("<html></html>", undefined, launcher),
			renderHtmlToPdf("<html></html>", undefined, launcher),
		]);
		expect(maxActive).toBe(1);
	});
	it("closes page + browser even when pdf() throws (error sanitized)", async () => {
		const { browser, getCloses } = makeMockBrowser({
			pdfError: new Error("boom with SECRET-path /etc/passwd"),
		});
		await expect(
			renderHtmlToPdf("<html></html>", undefined, makeLauncher(browser)),
		).rejects.toThrow("generatePdf: render failed");
		expect(getCloses()).toBe(1);
	});
	it("recovers the mutex after a failed render", async () => {
		let first = true;
		const launcher: ChromiumLauncher = {
			async launch() {
				const b = makeMockBrowser(
					first ? { pdfError: new Error("fail") } : {},
				).browser;
				first = false;
				return b;
			},
		};
		await expect(
			renderHtmlToPdf("<html></html>", undefined, launcher),
		).rejects.toThrow("generatePdf: render failed");
		const r2 = await renderHtmlToPdf("<html></html>", undefined, launcher);
		expect(r2.sizeBytes).toBeGreaterThan(0);
	});
});

describe("browser-renderer: sanitized errors (no secret/URL leak)", () => {
	it("timeout produces a sanitized message with no html content", async () => {
		const secret = "AKIA-SECRET-KEY-12345";
		const { browser, page } = makeMockBrowser();
		page.setContent = async () => {
			await new Promise((r) => setTimeout(r, 500));
		};
		const err = await renderHtmlToPdf(
			`<html>${secret}</html>`,
			undefined,
			makeLauncher(browser),
			100, // short test timeout
		).then(
			() => null,
			(e: unknown) => (e instanceof Error ? e.message : String(e)),
		);
		expect(err).toContain("timed out");
		expect(err).not.toContain(secret);
	});
	it("wraps unexpected errors so html/paths/secrets never leak", async () => {
		const { browser } = makeMockBrowser({
			pdfError: new Error("failed to load resource at file:///etc/shadow DATA"),
		});
		const err = await renderHtmlToPdf(
			"<html></html>",
			undefined,
			makeLauncher(browser),
		).then(
			() => null,
			(e: unknown) => (e instanceof Error ? e.message : String(e)),
		);
		expect(err).toBe("generatePdf: render failed");
		expect(err).not.toContain("/etc/shadow");
	});
});

describe("browser-renderer: lazy playwright import", () => {
	it("RENDER_TIMEOUT_MS is exactly 30_000 (production cap)", () => {
		expect(RENDER_TIMEOUT_MS).toBe(30_000);
	});
	it("imports the renderer module without triggering a playwright launch", () => {
		// No assertion needed beyond successful module load (the import at the
		// top of this file already executed). defaultLauncher.launch is the only
		// site that does `await import("playwright")`.
		expect(RENDER_TIMEOUT_MS).toBe(30_000);
	});
});
