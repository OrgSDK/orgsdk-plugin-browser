/**
 * Source purity guard — ensures the plugin has no runtime dependency on
 * private OrgSDK packages, @orgsdk/plugins is imported type-only, and
 * playwright is the single runtime dependency (declared, not statically
 * imported).
 *
 * browser is a thin repo: two source files (browser-renderer.ts +
 * pdf-functions.ts) joined by sibling (`./`) imports. The only runtime
 * dependency is `playwright@1.60.0`, resolved lazily inside
 * defaultLauncher.launch via `await import("playwright")` (the lazy import is
 * the contract that lets unit tests run without the playwright package
 * installed).
 */
import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const PLUGIN_DIR = resolve(import.meta.dir, "..", "plugin");
const ROOT_DIR = resolve(import.meta.dir, "..");

/** Any import from a private @orgsdk/* or orgsdk/* package. */
const FORBIDDEN_SPECIFIER =
	/(?:^|\n)\s*import\b[^;]*?from\s+["']((?:@orgsdk\/|orgsdk\/)[^"']+)["']/g;

/**
 * A value (non-type) import from @orgsdk/plugins — forbidden because the
 * SDK is dev-only; the runtime artifact must not depend on it.
 */
const SDK_VALUE_IMPORT =
	/(?:^|\n)\s*import\s+(?!type\b)\{[^}]*\}\s+from\s+["']@orgsdk\/plugins["']/;

async function collectTsFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...(await collectTsFiles(abs)));
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			out.push(abs);
		}
	}
	return out;
}

describe("source purity", () => {
	it("no plugin source imports a private @orgsdk/* or orgsdk/* package", async () => {
		const files = await collectTsFiles(PLUGIN_DIR);
		expect(files.length).toBeGreaterThan(0);

		const offenders: Array<{ file: string; specifier: string }> = [];
		for (const file of files) {
			const src = await readFile(file, "utf-8");
			for (const match of src.matchAll(FORBIDDEN_SPECIFIER)) {
				const spec = match[1];
				// Allow @orgsdk/plugins (checked separately below).
				if (spec === "@orgsdk/plugins" || spec.startsWith("@orgsdk/plugins/")) {
					continue;
				}
				offenders.push({
					file: relative(PLUGIN_DIR, file),
					specifier: spec,
				});
			}
		}

		expect(offenders).toEqual([]);
	});

	it("@orgsdk/plugins is imported type-only everywhere (no runtime value imports)", async () => {
		const files = await collectTsFiles(PLUGIN_DIR);
		const offenders: string[] = [];

		for (const file of files) {
			const src = await readFile(file, "utf-8");
			if (SDK_VALUE_IMPORT.test(src)) {
				offenders.push(relative(PLUGIN_DIR, file));
			}
		}

		expect(offenders).toEqual([]);
	});

	it("no cross-plugin or relative parent imports (only sibling ./ allowed)", async () => {
		const files = await collectTsFiles(PLUGIN_DIR);
		const offenders: string[] = [];

		for (const file of files) {
			const src = await readFile(file, "utf-8");
			const parentImport = /from\s+["']\.\.[/"']/;
			if (parentImport.test(src)) {
				offenders.push(relative(PLUGIN_DIR, file));
			}
		}

		expect(offenders).toEqual([]);
	});

	it("playwright is imported lazily via dynamic import() (never a static import)", async () => {
		// The lazy `await import("playwright")` inside defaultLauncher.launch is
		// the contract that keeps playwright OUT of the module-load path. A
		// static `import ... from "playwright"` would force every consumer of
		// browser-renderer to install the playwright package, breaking unit
		// tests and bundling. Pin the lazy form.
		const src = await readFile(
			join(PLUGIN_DIR, "browser-renderer.ts"),
			"utf-8",
		);
		expect(src).toMatch(/await\s+import\(["']playwright["']\)/);
		expect(src).not.toMatch(
			/(?:^|\n)\s*import\s+[^;]*?from\s+["']playwright["']/,
		);
	});

	it("package.json declares playwright@1.60.0 as the only runtime dependency", async () => {
		const pkg = JSON.parse(
			await readFile(join(ROOT_DIR, "package.json"), "utf-8"),
		) as Record<string, unknown>;
		const deps = pkg.dependencies as Record<string, string> | undefined;
		expect(deps).toBeDefined();
		expect(deps?.playwright).toBe("1.60.0");
		expect(Object.keys(deps ?? {}).sort()).toEqual(["playwright"]);
		// @orgsdk/plugins must be dev-only, never runtime.
		expect(deps?.["@orgsdk/plugins"]).toBeUndefined();
	});

	it("package.json declares @orgsdk/plugins as a devDependency (type-only SDK)", async () => {
		const pkg = JSON.parse(
			await readFile(join(ROOT_DIR, "package.json"), "utf-8"),
		) as Record<string, unknown>;
		const devDeps = pkg.devDependencies as Record<string, string> | undefined;
		expect(devDeps?.["@orgsdk/plugins"]).toBe("0.2.2");
	});
});
