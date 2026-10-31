/**
 * Packaging tests — determinism, stale-output removal, and generated
 * package.json in the staged artifact.
 *
 * browser declares playwright@1.64.1 as a runtime dependency. The catalog's
 * resolvePluginDeps step cannot statically bundle Playwright (chromium-bidi
 * has a dynamic import that defeats Bun.build), so the platform falls back to
 * shipping the dependency tree as a __deps.tar.b64 archive at publish time.
 * That fallback is exercised by deps-archive.test.ts; this file only asserts
 * the local `orgsdk-plugin package` output is deterministic and carries the
 * declared runtime dep in the generated package.json.
 */
import { describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $ } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const DIST_DIR = join(ROOT, "dist");

interface ManifestInfo {
	name: string;
	version: string;
}

async function readManifestInfo(): Promise<ManifestInfo> {
	const raw = await readFile(join(ROOT, "plugin", ".plugin.json"), "utf-8");
	return JSON.parse(raw) as ManifestInfo;
}

async function manifestPath(): Promise<string> {
	const { name, version } = await readManifestInfo();
	return join(DIST_DIR, `${name}-${version}.manifest.json`);
}

describe("packaging", () => {
	it("removes stale files from dist/ before staging", async () => {
		await rm(DIST_DIR, { recursive: true, force: true });
		await mkdir(DIST_DIR, { recursive: true });
		const sentinel = join(DIST_DIR, "STALE_SENTINEL.txt");
		await writeFile(sentinel, "this should not survive packaging");

		await $`bun run package`.cwd(ROOT).quiet();

		await expect(stat(sentinel)).rejects.toThrow();
	});

	it("produces deterministic output across runs", async () => {
		await $`bun run package`.cwd(ROOT).quiet();
		const first = await readFile(await manifestPath(), "utf-8");

		await $`bun run package`.cwd(ROOT).quiet();
		const second = await readFile(await manifestPath(), "utf-8");

		expect(second).toBe(first);
	});

	it("manifest entries are sorted by path", async () => {
		await $`bun run package`.cwd(ROOT).quiet();
		const raw = await readFile(await manifestPath(), "utf-8");
		const parsed = JSON.parse(raw) as {
			files: Array<{ path: string }>;
		};
		const paths = parsed.files.map((f) => f.path);
		const sorted = [...paths].sort((a, b) => a.localeCompare(b));
		expect(paths).toEqual(sorted);
	});

	it("generated package.json in artifact carries playwright@1.64.1 as the only runtime dep", async () => {
		const { name, version } = await readManifestInfo();
		await $`bun run package`.cwd(ROOT).quiet();
		const pkgPath = join(DIST_DIR, name, "package.json");
		const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as Record<
			string,
			unknown
		>;

		expect(pkg.name).toBe("@orgsdk/plugin-browser");
		expect(pkg.version).toBe(version);
		expect(pkg.type).toBe("module");
		// playwright IS the runtime dependency (defaultLauncher.launch imports it).
		const deps = pkg.dependencies as Record<string, string> | undefined;
		expect(deps).toBeDefined();
		expect(deps?.playwright).toBe("1.64.1");
		// The authoring SDK must NOT be a runtime dependency (type-only).
		expect(deps?.["@orgsdk/plugins"]).toBeUndefined();
		expect(Object.keys(deps ?? {}).sort()).toEqual(["playwright"]);
		expect(pkg.devDependencies).toBeUndefined();
		expect(pkg.scripts).toBeUndefined();
		expect(pkg.private).toBeUndefined();
	});

	it("manifest includes the generated package.json entry", async () => {
		await $`bun run package`.cwd(ROOT).quiet();
		const raw = await readFile(await manifestPath(), "utf-8");
		const parsed = JSON.parse(raw) as {
			files: Array<{ path: string }>;
		};
		const paths = parsed.files.map((f) => f.path);
		expect(paths).toContain("package.json");
	});

	it("artifact contains only expected files (source + docs + generated)", async () => {
		await $`bun run package`.cwd(ROOT).quiet();
		const raw = await readFile(await manifestPath(), "utf-8");
		const parsed = JSON.parse(raw) as {
			files: Array<{ path: string }>;
		};
		const paths = parsed.files.map((f) => f.path);
		// Every shipped source file must be present.
		const expectedSources = [
			".plugin.json",
			"package.json",
			"pdf-functions.ts",
			"browser-renderer.ts",
			"docs/overview.md",
		];
		for (const p of expectedSources) {
			expect(paths).toContain(p);
		}
		// No tests, no workflows, no node_modules leaked into the artifact.
		for (const p of paths) {
			expect(p.startsWith("tests/")).toBe(false);
			expect(p.startsWith(".github/")).toBe(false);
			expect(p.startsWith("node_modules/")).toBe(false);
		}
	});
});
