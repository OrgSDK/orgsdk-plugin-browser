// Maintained in OrgSDK/plugins/scripts/plugin-ci-templates. Sync with sync-plugin-ci.mjs.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const root = resolve(
	process.argv.find((arg) => arg.startsWith("--root="))?.slice(7) ??
		process.cwd(),
);
const batch = process.argv.includes("--batch");
const repositories = batch
	? (await readdir(root))
			.filter((name) => name.startsWith("orgsdk-plugin-"))
			.sort()
			.map((name) => join(root, name))
	: [root];
const temporary = await mkdtemp(join(tmpdir(), "orgsdk-plugin-registration-"));
let server;
let exited;
let output = "";
try {
	const releases = [];
	for (const repository of repositories) {
		const catalog = JSON.parse(
			await readFile(join(repository, "dist/npm/plugin.catalog.json"), "utf8"),
		)[0];
		const fixtureDirectory = join(temporary, catalog.slug);
		await mkdir(fixtureDirectory);
		const fixture = await (
			await import(
				pathToFileURL(join(repository, "tests/executor-fixture.mjs")).href
			)
		).default({ temporary: fixtureDirectory });
		try {
			releases.push({
				catalog,
				configuration: fixture.configuration ?? {},
				provider: fixture.provider,
				secret: fixture.secret,
			});
		} finally {
			await fixture.close?.();
		}
	}
	const catalogPath = join(temporary, "catalog.json");
	await writeFile(
		catalogPath,
		JSON.stringify(releases.map(({ catalog }) => catalog)),
	);
	// Install the released host from npm, never a sibling source checkout.
	const installed = join(temporary, "installed");
	await mkdir(installed);
	execFileSync(
		"npm",
		[
			"install",
			"--prefix",
			installed,
			"--registry=https://registry.npmjs.org/",
			"--no-audit",
			"--no-fund",
			"--omit=dev",
			"@orgsdk/cli@0.1.0",
		],
		{ cwd: temporary, encoding: "utf8", timeout: 180_000, stdio: "pipe" },
	);
	const listener = createServer();
	await new Promise((done, reject) => {
		listener.once("error", reject);
		listener.listen(0, "127.0.0.1", done);
	});
	const port = listener.address().port;
	await new Promise((done) => listener.close(done));
	const origin = `http://127.0.0.1:${port}`;
	const runtimePath = join(temporary, "bin");
	await mkdir(runtimePath);
	await symlink(process.execPath, join(runtimePath, "node"));
	const cli = join(installed, "node_modules/@orgsdk/cli/bin/orgsdk.mjs");
	server = spawn(process.execPath, [cli, "start"], {
		cwd: temporary,
		env: {
			PATH: runtimePath,
			HOME: temporary,
			ORGSDK_DATA_DIR: join(temporary, "data"),
			HOST: "127.0.0.1",
			PORT: String(port),
			PLUGIN_CATALOG_PATH: catalogPath,
			PLUGIN_MARKETPLACE_URL: "",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	for (const stream of [server.stdout, server.stderr])
		stream.on("data", (chunk) => {
			output = (output + chunk).slice(-16000);
		});
	exited = new Promise((done, reject) => {
		server.once("error", reject);
		server.once("close", done);
	});
	let ready = false;
	for (let attempt = 0; attempt < 150; attempt++) {
		assert.equal(server.exitCode, null, output);
		try {
			if (
				(
					await fetch(`${origin}/trpc/system.health`, {
						signal: AbortSignal.timeout(1000),
					})
				).ok
			) {
				ready = true;
				break;
			}
		} catch {
			/* Wait for isolated host startup. */
		}
		await pause(100);
	}
	assert(ready, output);
	const cookies = new Map();
	async function rpc(procedure, input, mutation = false) {
		const query =
			!mutation && input !== undefined
				? `?input=${encodeURIComponent(JSON.stringify(input))}`
				: "";
		const response = await fetch(`${origin}/trpc/${procedure}${query}`, {
			method: mutation ? "POST" : "GET",
			headers: {
				"Content-Type": "application/json",
				Origin: origin,
				Cookie: [...cookies]
					.map(([key, value]) => `${key}=${value}`)
					.join("; "),
				"X-CSRFToken": cookies.get("csrftoken") ?? "",
			},
			...(mutation ? { body: JSON.stringify(input) } : {}),
			signal: AbortSignal.timeout(15000),
		});
		for (const cookie of response.headers.getSetCookie()) {
			const pair = cookie.split(";")[0];
			const index = pair.indexOf("=");
			cookies.set(pair.slice(0, index), pair.slice(index + 1));
		}
		const payload = await response.json();
		assert(
			response.ok,
			`${procedure}${input?.slug ? ` (${input.slug})` : ""}: ${JSON.stringify(payload)}`,
		);
		return payload.result.data;
	}
	await rpc("auth.setupStatus");
	const password = "Synthetic-registration-test-password-123";
	await rpc(
		"auth.setup",
		{
			domain: "127.0.0.1",
			workspace_name: "Plugin registration test",
			username: "test-owner",
			email: "owner@example.invalid",
			password1: password,
			password2: password,
			project_name: "Plugin test",
		},
		true,
	);
	await rpc("auth.login", { email: "owner@example.invalid", password }, true);
	const project = (await rpc("projects.list")).results[0];
	assert(project);
	for (const { catalog, configuration, provider, secret } of releases) {
		const credential = provider
			? await rpc(
					"credentials.create",
					{ name: `test-${catalog.slug}`, provider, secret },
					true,
				)
			: null;
		const plugin = await rpc(
			"plugins.create",
			{
				project: project.id,
				slug: catalog.slug,
				version: catalog.version,
				distribution: "external",
				configuration,
				credential: credential?.id ?? null,
			},
			true,
		);
		assert.equal(plugin.digest, catalog.digest);
		assert.equal(plugin.version, catalog.version);
		assert.equal(plugin.package_url, catalog.package_url);
	}
	// Prove the real host strips client/refresh secrets before executor delivery.
	const nativeProviders = [
		...new Set(
			releases
				.map(({ provider }) => provider)
				.filter((provider) =>
					[
						"google-oauth",
						"twitter-oauth",
						"linkedin-oauth",
						"facebook-oauth",
					].includes(provider),
				),
		),
	];
	if (nativeProviders.length) {
		const project = await rpc(
			"projects.create",
			{ name: "Native credential boundary" },
			true,
		);
		for (const provider of nativeProviders) {
			const credential = await rpc(
				"credentials.create",
				{
					name: provider,
					provider,
					secret: {
						source: "byo",
						secret_clientId: "synthetic-client",
						secret_clientSecret: "synthetic-client-secret",
						secret_refreshToken: "synthetic-refresh",
						secret_accessToken: "synthetic-access",
						expires_at: Math.floor(Date.now() / 1000) + 3600,
					},
				},
				true,
			);
			const slug = provider.split("-")[0];
			await rpc(
				"plugins.create",
				{
					project: project.id,
					slug,
					version: "1.0.0",
					distribution: "inline",
					credential: credential.id,
					source:
						'export default { safeFunctions: [{name: "inspectShape", parameters: [], calling: "named", handler: (secret) => ({keys: Object.keys(secret).sort(), isByo: secret.source === "byo"})}] };',
				},
				true,
			);
		}
		const source = `return {${nativeProviders
			.map((provider) => {
				const slug = provider.split("-")[0];
				return `${slug}: await ${slug}.inspectShape({})`;
			})
			.join(",")}};`;
		const queued = await rpc(
			"runs.create",
			{
				project: project.id,
				operation: "code",
				source,
				inputs: {},
				idempotency_key: randomUUID(),
			},
			true,
		);
		let completed = false;
		for (let attempt = 0; attempt < 200; attempt++) {
			const run = await rpc("runs.get", { id: queued.id });
			if (
				["succeeded", "failed", "cancelled", "timed_out"].includes(run.status)
			) {
				assert.equal(run.status, "succeeded", JSON.stringify(run.error));
				for (const shape of Object.values(run.output.result))
					assert.deepEqual(shape, {
						keys: ["secret_accessToken", "source"],
						isByo: true,
					});
				completed = true;
				break;
			}
			await pause(100);
		}
		assert(completed, "Native credential boundary run did not complete");
	}
	console.log(
		JSON.stringify({
			host: "@orgsdk/cli@0.1.0",
			registeredPlugins: releases.length,
			nativeCredentialProbes: nativeProviders.length,
			freshInstallation: true,
			registry: "npm",
			runtime: "node",
			providerMode: "synthetic-only",
		}),
	);
} finally {
	if (server && server.exitCode === null && server.signalCode === null) {
		server.kill("SIGTERM");
		const timeout = setTimeout(() => server.kill("SIGKILL"), 15000);
		try {
			await exited;
		} finally {
			clearTimeout(timeout);
		}
	}
	await rm(temporary, { recursive: true, force: true });
}
