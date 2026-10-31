// Maintained in OrgSDK/plugins/scripts/plugin-ci-templates. Sync with sync-plugin-ci.mjs.
import assert from "node:assert/strict";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packagePlugin } from "@orgsdk/executor/dist/package-plugin.js";

const root = resolve(process.cwd());
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(
	await readFile(join(root, "plugin/.plugin.json"), "utf8"),
);
assert.equal(
	pkg.version,
	manifest.version,
	"Package and plugin versions must match",
);
const temporary = await mkdtemp(join(tmpdir(), "orgsdk-npm-build-"));
const output = join(root, "dist/npm");

try {
	const readme = await readFile(join(root, "README.md"), "utf8");
	const license = await readFile(join(root, "LICENSE"), "utf8");
	assert.equal(pkg.license, "Apache-2.0");
	const notice = await readFile(join(root, "NOTICE"), "utf8");
	const licenseFile = join(temporary, "LICENSE");
	await writeFile(licenseFile, `${license}\n\n${notice}`);
	// Preserve package assets and CommonJS dependencies through the executor's
	// supported dependency capsule rather than a different bundler in this repo.
	await packagePlugin(
		root,
		temporary,
		Object.keys(pkg.dependencies ?? {}),
		licenseFile,
	);
	await rm(output, { recursive: true, force: true });
	await mkdir(output, { recursive: true });
	for (const suffix of [
		"mjs",
		"manifest.json",
		"catalog.json",
		"notices.txt",
	]) {
		await copyFile(
			join(temporary, `${manifest.name}.${suffix}`),
			join(output, `plugin.${suffix}`),
		);
	}
	// npm CDN URL addresses the versioned npm entry, not a source checkout.
	const packageUrl = `https://cdn.jsdelivr.net/npm/${pkg.name}@${pkg.version}/plugin.mjs`;
	const catalogPath = join(output, "plugin.catalog.json");
	const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
	catalog[0].package_url = packageUrl;
	await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
	const manifestPath = join(output, "plugin.manifest.json");
	const release = JSON.parse(await readFile(manifestPath, "utf8"));
	release.package_url = packageUrl;
	release.release_metadata = catalog[0];
	await writeFile(manifestPath, `${JSON.stringify(release, null, 2)}\n`);
	for (const file of ["NOTICE", "TRADEMARKS.md"])
		await copyFile(join(root, file), join(output, file));
	const distribution = {
		name: pkg.name,
		version: pkg.version,
		description: pkg.description,
		repository: pkg.repository,
		bugs: pkg.bugs,
		homepage: pkg.homepage,
		author: pkg.author,
		type: "module",
		license: "Apache-2.0",
		main: "./plugin.mjs",
		exports: {
			".": "./plugin.mjs",
			"./manifest": "./plugin.manifest.json",
			"./catalog": "./plugin.catalog.json",
		},
		files: [
			"plugin.mjs",
			"plugin.manifest.json",
			"plugin.catalog.json",
			"plugin.notices.txt",
			"LICENSE",
			"README.md",
			"NOTICE",
			"TRADEMARKS.md",
		],
		engines: { node: ">=22.22.0" },
		publishConfig: {
			access: "public",
			registry: "https://registry.npmjs.org/",
			provenance: true,
		},
	};
	await writeFile(
		join(output, "package.json"),
		`${JSON.stringify(distribution, null, 2)}\n`,
	);
	await writeFile(join(output, "LICENSE"), license);
	await writeFile(join(output, "README.md"), readme);
	console.log(`Built npm distribution ${pkg.name}@${pkg.version} in dist/npm`);
} finally {
	await rm(temporary, { recursive: true, force: true });
}
