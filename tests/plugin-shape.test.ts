/**
 * Plugin shape / contract tests.
 *
 * browser is a flat-module plugin (no factory): pdf-functions.ts is the
 * manifest entry and exports `safeFunctions` + `moduleDescription` directly.
 * The daemon loader (packages/daemon/src/plugins/loader.ts) handles both
 * shapes — flat-module is the legacy-but-supported form, preserved here
 * exactly to keep the artifact byte-stable against the v1.1.0 prerequisite.
 *
 * Parity invariants asserted (vs monorepo b99c239):
 *  - exactly one safe function: `generatePdf`
 *  - returnType: "Promise<{ base64: string; sizeBytes: number; filename: string }>"
 *  - metadata.category === "browser"
 *  - metadata.tags includes "io"
 *  - no requiredCredentials (no auth)
 *  - moduleDescription is a non-empty string
 *  - two parameters declared: html (string), options (object)
 *
 * We import the module directly (no daemon, no DB) and assert the public
 * surface — the handler body itself is exercised by browser-renderer.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ENTRY_PATH = resolve(import.meta.dir, "..", "plugin", "pdf-functions.ts");

async function loadEntry(): Promise<typeof import("../plugin/pdf-functions")> {
	return import("../plugin/pdf-functions");
}

describe("plugin shape (flat-module)", () => {
	it("entry module exports safeFunctions as a non-empty array", async () => {
		const mod = await loadEntry();
		expect(Array.isArray(mod.safeFunctions)).toBe(true);
		expect(mod.safeFunctions.length).toBe(1);
	});

	it("entry module exports a non-empty moduleDescription", async () => {
		const mod = await loadEntry();
		expect(typeof mod.moduleDescription).toBe("string");
		expect(mod.moduleDescription.length).toBeGreaterThan(0);
	});

	it("exposes exactly one safe function named generatePdf", async () => {
		const mod = await loadEntry();
		const fn = mod.safeFunctions[0];
		expect(fn.name).toBe("generatePdf");
	});

	it("generatePdf preserves the exact public return type string", async () => {
		const mod = await loadEntry();
		const fn = mod.safeFunctions[0];
		expect(fn.returnType).toBe(
			"Promise<{ base64: string; sizeBytes: number; filename: string }>",
		);
	});

	it("generatePdf is categorized under browser", async () => {
		const mod = await loadEntry();
		const fn = mod.safeFunctions[0];
		expect(fn.metadata?.category).toBe("browser");
	});

	it("generatePdf is tagged io (read-only rendering, no destructive op)", async () => {
		const mod = await loadEntry();
		const fn = mod.safeFunctions[0];
		expect(fn.metadata?.tags).toContain("io");
	});

	it("generatePdf carries metadata.version matching the manifest", async () => {
		const mod = await loadEntry();
		const fn = mod.safeFunctions[0];
		expect(fn.metadata?.version).toBe("1.1.2");
	});

	it("generatePdf declares requiredCredentials as undefined (no auth)", async () => {
		const mod = await loadEntry();
		const fn = mod.safeFunctions[0];
		expect(fn.requiredCredentials).toBeUndefined();
	});

	it("generatePdf declares two parameters (html, options) with stable types", async () => {
		const mod = await loadEntry();
		const fn = mod.safeFunctions[0];
		expect(fn.parameters?.length).toBe(2);
		const htmlParam = fn.parameters?.[0];
		expect(htmlParam?.name).toBe("html");
		expect(htmlParam?.type).toBe("string");
		const optionsParam = fn.parameters?.[1];
		expect(optionsParam?.name).toBe("options");
		// The options type string embeds format/landscape/margin/filename — pin
		// the structure so a future drift is caught.
		expect(optionsParam?.type).toMatch(/format\?.*"A4".*"Letter"/);
		expect(optionsParam?.type).toMatch(/landscape\?/);
		expect(optionsParam?.type).toMatch(/margin\?/);
		expect(optionsParam?.type).toMatch(/filename\?/);
	});

	it("generatePdf has a non-empty description", async () => {
		const mod = await loadEntry();
		const fn = mod.safeFunctions[0];
		expect(typeof fn.description).toBe("string");
		expect((fn.description ?? "").length).toBeGreaterThan(0);
		expect(fn.description ?? "").toMatch(/PDF/i);
	});

	it("generatePdf docs block carries the security caveats", async () => {
		const mod = await loadEntry();
		const fn = mod.safeFunctions[0];
		const caveats = fn.docs?.caveats ?? [];
		expect(caveats.length).toBeGreaterThanOrEqual(3);
		const joined = caveats.join("\n");
		expect(joined).toMatch(/JavaScript is disabled/);
		expect(joined).toMatch(/external.*blocked/i);
		expect(joined).toMatch(/serialized/);
	});

	it("generatePdf docs list exactly two parameters matching the top-level shape", async () => {
		const mod = await loadEntry();
		const fn = mod.safeFunctions[0];
		const params = fn.docs?.parameters ?? [];
		expect(params.length).toBe(2);
		expect(params[0].name).toBe("html");
		expect(params[0].type).toBe("string");
		expect(params[1].name).toBe("options");
		expect(params[1].type).toBe("object");
	});

	it("entry source is a flat module (no default factory export)", async () => {
		// Pin the flat-module shape: pdf-functions.ts must NOT have a default
		// export. The daemon loader's factory path is for index.ts entries;
		// browser deliberately uses the legacy flat shape to match v1.1.0.
		const src = await readFile(ENTRY_PATH, "utf-8");
		expect(src).not.toMatch(/export\s+default\s+/);
		expect(src).toMatch(/export\s+const\s+safeFunctions/);
	});
});
