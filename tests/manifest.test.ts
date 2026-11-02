/**
 * Manifest tests — assert the v1.1.2 forward-patch changes and preserved
 * marketplace metadata.
 *
 * browser has no auth (no credential provider, no callback) — the manifest
 * must not declare an auth block. The plugin's contract is the single
 * generatePdf safe function.
 */
import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const MANIFEST_PATH = resolve(import.meta.dir, "..", "plugin", ".plugin.json");

async function readManifest() {
	const raw = await readFile(MANIFEST_PATH, "utf-8");
	return JSON.parse(raw) as Record<string, unknown>;
}

describe("manifest", () => {
	it("has the expected slug (name)", async () => {
		const m = await readManifest();
		expect(m.name).toBe("browser");
	});

	it("has the bumped version 1.1.2 (forward patch)", async () => {
		const m = await readManifest();
		expect(m.version).toBe("1.1.2");
	});

	it("declares the canonical $schema", async () => {
		const m = await readManifest();
		expect(m.$schema).toBe("https://orgsdk.ai/schemas/plugin-manifest.v1.json");
	});

	it("has a non-empty description", async () => {
		const m = await readManifest();
		expect(typeof m.description).toBe("string");
		expect((m.description as string).length).toBeGreaterThan(0);
	});

	it("declares entry as pdf-functions.ts (flat-module shape preserved)", async () => {
		const m = await readManifest();
		expect(m.entry).toBe("pdf-functions.ts");
	});

	it("declares NO auth (no credentials, no OAuth flow)", async () => {
		const m = await readManifest();
		expect(m.auth).toBeUndefined();
	});

	it("preserves marketplace displayName/category/tagline", async () => {
		const m = await readManifest();
		const mp = m.marketplace as Record<string, unknown>;
		expect(mp.displayName).toBe("Browser");
		expect(mp.category).toBe("Documents & Output");
		expect(mp.tagline).toMatch(/JavaScript disabled/i);
		expect(Array.isArray(mp.tags)).toBe(true);
		expect(Array.isArray(mp.useCases)).toBe(true);
		expect(typeof mp.permissionsSummary).toBe("string");
	});

	it("declares the source-repo provenance link", async () => {
		const m = await readManifest();
		const mp = m.marketplace as Record<string, unknown>;
		const links = mp.links as Record<string, string>;
		expect(links.sourceRepo).toBe(
			"https://github.com/OrgSDK/orgsdk-plugin-browser",
		);
	});

	it("permissionsSummary documents the hardening model", async () => {
		const m = await readManifest();
		const mp = m.marketplace as Record<string, unknown>;
		const summary = mp.permissionsSummary as string;
		expect(summary).toMatch(/JavaScript is disabled/i);
		expect(summary).toMatch(/external.*requests.*blocked/i);
	});
});
