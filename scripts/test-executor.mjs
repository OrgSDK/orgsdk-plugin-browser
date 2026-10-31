// Maintained in OrgSDK/plugins/scripts/plugin-ci-templates. Sync with sync-plugin-ci.mjs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@orgsdk/executor/dist/client.js";
import { pluginSchema } from "@orgsdk/executor/dist/contract.js";
import { slugToNamespace } from "@orgsdk/executor/dist/engine/plugins/namespace.js";
import { SandboxExecutor } from "@orgsdk/executor/dist/engine/sandbox/executor.js";
import { loadPlugins } from "@orgsdk/executor/dist/plugins.js";

const root = resolve(process.cwd());
const temporary = await mkdtemp(join(tmpdir(), "orgsdk-executor-test-"));
const previousData = process.env.EXECUTOR_DATA_DIR;
const previousAgent = process.env.EXECUTOR_AGENT_DIR;
const realFetch = globalThis.fetch;
const realHttp = http.request;
const realHttps = https.request;
const realHttpGet = http.get;
const realHttpsGet = https.get;
const covered = new Set();
const cases = new Map();
let credentialMode = "valid";
let credentialRequests = 0;
let artifactDownloads = 0;
let negativeCases = 0;
let providerMode = "valid";
let activeCase;
const networkCases = new Map();
let fixture;
let providerRequests = 0;
process.env.EXECUTOR_DATA_DIR = join(temporary, "executor");
delete process.env.EXECUTOR_AGENT_DIR;

try {
	// Test the actual npm payload after extraction, away from the source tree.
	const packed = JSON.parse(
		execFileSync(
			"npm",
			[
				"pack",
				"./dist/npm",
				"--ignore-scripts",
				"--json",
				"--pack-destination",
				temporary,
			],
			{ cwd: root, encoding: "utf8" },
		),
	);
	assert.equal(packed.length, 1);
	assert(
		packed[0].files.every(
			({ path }) =>
				!path.startsWith("node_modules/") && !path.startsWith("plugin/"),
		),
	);
	execFileSync("tar", [
		"-xzf",
		join(temporary, packed[0].filename),
		"-C",
		temporary,
	]);
	const packaged = join(temporary, "package");
	const metadata = JSON.parse(
		await readFile(join(packaged, "plugin.manifest.json"), "utf8"),
	);
	const bundle = join(packaged, "plugin.mjs");
	assert.equal(
		createHash("sha256")
			.update(await readFile(bundle))
			.digest("hex"),
		metadata.digest,
	);
	const createFixture = (
		await import(pathToFileURL(join(root, "tests/executor-fixture.mjs")).href)
	).default;
	fixture = await createFixture({ temporary });
	const nativeOAuth = [
		"google-oauth",
		"twitter-oauth",
		"linkedin-oauth",
		"facebook-oauth",
	].includes(fixture.provider);
	if (nativeOAuth) {
		assert.deepEqual(Object.keys(fixture.secret).sort(), [
			"secret_accessToken",
			"source",
		]);
		assert.equal(fixture.secret.source, "byo");
		assert.equal(typeof fixture.secret.secret_accessToken, "string");
	}
	const npmMetadata = JSON.parse(
		await readFile(join(packaged, "package.json"), "utf8"),
	);
	assert.equal(npmMetadata.license, "Apache-2.0");
	assert.equal(npmMetadata.publishConfig.access, "public");
	assert.equal(npmMetadata.publishConfig.provenance, true);
	assert.equal(metadata.release_metadata.package_url, metadata.package_url);
	assert.equal(
		metadata.package_url,
		`https://cdn.jsdelivr.net/npm/${packed[0].name}@${packed[0].version}/plugin.mjs`,
	);
	const bundleBytes = await readFile(bundle);
	globalThis.fetch = async (input, init = {}) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.href === metadata.package_url) {
			artifactDownloads++;
			return new Response(bundleBytes, {
				headers: { "content-type": "text/javascript" },
			});
		}
		if (url.origin === "https://executor.invalid") {
			assert.equal(
				url.pathname,
				"/internal/execution/v1/credentials/test-credential/",
			);
			assert.equal(request.method, "GET");
			credentialRequests++;
			assert.equal(
				request.headers.get("authorization"),
				"Bearer synthetic-capability",
			);
			if (credentialMode === "denied")
				return Response.json(
					{ error: "Credential is outside this run capability." },
					{ status: 403 },
				);
			return Response.json({ secret: fixture.secret });
		}
		if (fixture.allowedOrigins?.includes(url.origin))
			return realFetch(input, init);
		providerRequests++;
		if (activeCase) networkCases.set(activeCase.name, activeCase.args);
		if (providerMode === "error")
			return new Response("synthetic-secret-response", { status: 500 });
		if (providerMode === "oversized")
			return new Response("{}", { headers: { "content-length": "2000001" } });
		assert(
			fixture.fetch,
			`Unexpected network request: ${request.method} ${url}`,
		);
		try {
			return await fixture.fetch(request);
		} catch (error) {
			console.error(
				"Synthetic fixture rejected request:",
				request.method,
				url.origin,
				url.pathname,
				error.message,
			);
			throw error;
		}
	};
	const guardRequest = (original, protocol) =>
		function (input, ...args) {
			const url =
				typeof input === "string" || input instanceof URL
					? new URL(input)
					: new URL(
							`${input.protocol ?? protocol}//${input.hostname ?? input.host}:${input.port ?? (protocol === "https:" ? 443 : 80)}`,
						);
			assert(
				fixture.allowedOrigins?.includes(url.origin),
				`Unexpected native network request: ${url.origin}`,
			);
			return original.call(this, input, ...args);
		};
	if (!fixture.nativeNetworkMock) {
		http.request = guardRequest(realHttp, "http:");
		https.request = guardRequest(realHttps, "https:");
		http.get = guardRequest(realHttpGet, "http:");
		https.get = guardRequest(realHttpsGet, "https:");
	}
	syncBuiltinESMExports();
	const plugin = pluginSchema.parse({
		...metadata,
		configuration: fixture.configuration ?? {},
		credential_id: fixture.provider ? "test-credential" : null,
		credential_provider: fixture.provider ?? null,
	});

	const functions = await loadPlugins(
		[plugin],
		new Client("https://executor.invalid", "synthetic-capability"),
		"headless-test",
	);
	const catalog = JSON.parse(
		await readFile(join(packaged, "plugin.catalog.json"), "utf8"),
	)[0];
	assert.deepEqual(
		functions.map((tool) => tool.name).sort(),
		catalog.tools.map((tool) => tool.name).sort(),
	);
	assert(functions.length > 0);
	assert(functions.every((tool) => tool.calling === "named"));
	const executor = new SandboxExecutor();
	executor.registerMultiple(functions);
	const namespace = slugToNamespace(plugin.slug);
	const call = async (name, args = {}) => {
		assert(
			functions.some((tool) => tool.name === name),
			`Unknown function ${name}`,
		);
		// Source expressions allow fixtures to exercise sandbox-native Zod schemas.
		const argumentSource =
			typeof args === "string" ? args : JSON.stringify(args);
		let execution;
		activeCase = { name, args };
		try {
			execution = await executor.execute(
				`return await ${namespace}.${name}(${argumentSource});`,
				{},
				{ timeout: 15_000 },
			);
		} catch (error) {
			throw new Error(
				`${plugin.slug}.${name} failed through the executor: ${error.message}`,
				{ cause: error },
			);
		}
		assert(
			execution.steps.some((step) => step.error === undefined),
			`${name} did not execute`,
		);
		covered.add(name);
		if (!cases.has(name)) cases.set(name, args);
		return execution.result === undefined
			? undefined
			: JSON.parse(JSON.stringify(execution.result));
	};
	await fixture.run(call);
	assert.deepEqual(
		[...covered].sort(),
		functions.map((tool) => tool.name).sort(),
		"Every advertised function must have a successful executor case",
	);
	assert.equal(
		artifactDownloads,
		1,
		"The executor must download the versioned npm entry into its empty store",
	);
	if (fixture.provider) {
		assert.equal(credentialRequests, 1);
		const credentialTool =
			functions.find((tool) => tool.requiredCredentials?.length) ??
			functions[0];
		credentialMode = "denied";
		await assert.rejects(
			loadPlugins(
				[plugin],
				new Client("https://executor.invalid", "synthetic-capability"),
				"headless-test",
			),
		);
		negativeCases++;
		credentialMode = "valid";
		const missing = await loadPlugins(
			[{ ...plugin, credential_id: null, credential_provider: null }],
			new Client("https://executor.invalid", "synthetic-capability"),
			"headless-test",
		);
		const missingExecutor = new SandboxExecutor();
		missingExecutor.registerMultiple(missing);
		const before = providerRequests + (fixture.nativeRequests ?? 0);
		const args = cases.get(credentialTool.name);
		const source = typeof args === "string" ? args : JSON.stringify(args);
		if (fixture.optionalCredential) {
			const execution = await missingExecutor.execute(
				`return await ${namespace}.${credentialTool.name}(${source});`,
				{},
				{ timeout: 15_000 },
			);
			assert(
				Array.isArray(execution.result),
				"Unauthenticated loopback CDP discovery is explicitly supported",
			);
		} else {
			await assert.rejects(
				missingExecutor.execute(
					`return await ${namespace}.${credentialTool.name}(${source});`,
					{},
					{ timeout: 15_000 },
				),
			);
		}
		assert.equal(
			providerRequests + (fixture.nativeRequests ?? 0),
			before,
			fixture.optionalCredential
				? "Optional CDP credentials permit loopback discovery"
				: "Missing credentials must fail before provider I/O",
		);
		negativeCases++;
	}
	if (
		["data", "llm", "serper", "twitter", "facebook", "linkedin"].includes(
			plugin.slug,
		)
	) {
		const [name, args] = networkCases.entries().next().value;
		for (const mode of ["error", "oversized"]) {
			providerMode = mode;
			await assert.rejects(call(name, args), (error) => {
				assert.equal(
					error.message.includes("synthetic-secret-response"),
					false,
				);
				assert.match(
					error.message,
					mode === "error" ? /UPSTREAM_HTTP_500/ : /RESPONSE_TOO_LARGE/,
				);
				return true;
			});
			negativeCases++;
		}
		providerMode = "valid";
	}
	if (fixture.negative) {
		await fixture.negative(call);
		negativeCases++;
	}
	if (process.env.NPM_TEST_ARTIFACT_DIR) {
		const artifacts = resolve(process.env.NPM_TEST_ARTIFACT_DIR);
		await mkdir(artifacts, { recursive: true });
		await copyFile(
			join(temporary, packed[0].filename),
			join(artifacts, packed[0].filename),
		);
	}
	console.log(
		JSON.stringify({
			package: packed[0].name,
			version: packed[0].version,
			executor: "@orgsdk/executor@0.1.0",
			loadedFunctions: functions.length,
			executedFunctions: covered.size,
			negativeCases,
			credentialRequests,
			artifactDownloads,
			credentialFormat: nativeOAuth
				? "native-access-token-snapshot"
				: "stored-provider-secret",
			providerRequests: providerRequests + (fixture.nativeRequests ?? 0),
			providerMode: "synthetic-only",
			npmTarball: true,
		}),
	);
} finally {
	globalThis.fetch = realFetch;
	http.request = realHttp;
	https.request = realHttps;
	http.get = realHttpGet;
	https.get = realHttpsGet;
	syncBuiltinESMExports();
	await fixture?.close?.();
	if (previousData === undefined) delete process.env.EXECUTOR_DATA_DIR;
	else process.env.EXECUTOR_DATA_DIR = previousData;
	if (previousAgent === undefined) delete process.env.EXECUTOR_AGENT_DIR;
	else process.env.EXECUTOR_AGENT_DIR = previousAgent;
	await rm(temporary, { recursive: true, force: true });
}
