// Maintained in OrgSDK/plugins/scripts/plugin-ci-templates. Sync with sync-plugin-ci.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

// Exercise the runner's actual pack/validation/extraction boundary without
// importing the executor or invoking provider fixtures. Only process I/O is fake.
const localRunner = new URL("../scripts/test-executor.mjs", import.meta.url);
const runner = existsSync(localRunner)
	? localRunner
	: new URL("./test-executor.mjs", import.meta.url);
const source = await readFile(process.env.NPM_PACK_RUNNER ?? runner, "utf8");
const start = source.indexOf("// Test the actual npm payload after extraction");
const end = source.indexOf("\tconst packaged = ", start);
assert(start >= 0 && end > start, "Cannot find runner pack boundary");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const pack = new AsyncFunction(
	"execFileSync",
	"readFile",
	"root",
	"temporary",
	"assert",
	"join",
	"createHash",
	`${source.slice(start, end)}\nreturn packed;`,
);
const archive = Buffer.from("synthetic npm archive bytes");
const expected = { name: "@orgsdk/plugin-fixture", version: "1.2.3" };
const entry = {
	...expected,
	filename: "orgsdk-plugin-fixture-1.2.3.tgz",
	integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
	files: [{ path: "plugin.mjs" }],
};
async function parse(output, observed = { extractions: 0 }) {
	const result = await pack(
		(command) => {
			if (command === "npm") return JSON.stringify(output);
			assert.equal(command, "tar");
			observed.extractions++;
		},
		async (path) =>
			path.endsWith("package.json") ? JSON.stringify(expected) : archive,
		"/fixture",
		"/temporary",
		assert,
		join,
		createHash,
	);
	assert.equal(observed.extractions, 1);
	return result;
}

test("runner matches the canonical toolkit template (sync both runner and regression)", () => {
	assert.equal(
		createHash("sha256").update(source).digest("hex"),
		"d0c8a759e80822702d89eacc7d48be254304cbb4655922cf51090dfa24c0a1f3",
	);
});

test("accepts the npm array pack result", async () => {
	assert.deepEqual(await parse([entry]), [entry]);
});

test("accepts the npm 12 package-name-keyed pack result", async () => {
	assert.deepEqual(await parse({ [expected.name]: entry }), [entry]);
});

for (const [name, output] of [
	["missing array entry", []],
	["missing object entry", {}],
	["ambiguous array entries", [entry, entry]],
	["ambiguous object entries", { [expected.name]: entry, other: entry }],
	["unexpected object key", { other: entry }],
	["null result", null],
	["primitive result", "invalid"],
	["missing name", [{ ...entry, name: undefined }]],
	["unexpected name", [{ ...entry, name: "@orgsdk/other" }]],
	["unexpected version", [{ ...entry, version: "9.9.9" }]],
	["missing filename", [{ ...entry, filename: undefined }]],
	["path traversal filename", [{ ...entry, filename: "../outside.tgz" }]],
	["unexpected filename", [{ ...entry, filename: "other.tgz" }]],
	["missing integrity", [{ ...entry, integrity: undefined }]],
	["malformed integrity", [{ ...entry, integrity: "sha512-invalid" }]],
	[
		"mismatched archive integrity",
		[{ ...entry, integrity: `sha512-${"A".repeat(86)}==` }],
	],
]) {
	test(`rejects ${name} before extraction`, async () => {
		const observed = { extractions: 0 };
		await assert.rejects(parse(output, observed));
		assert.equal(observed.extractions, 0);
	});
}
