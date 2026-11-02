import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("real Chromium integration retains a manual non-publishing workflow", async () => {
	const workflow = await readFile(
		new URL("../.github/workflows/browser-integration.yml", import.meta.url),
		"utf8",
	).catch(() => "");
	assert.match(workflow, /workflow_dispatch:/);
	assert.doesNotMatch(workflow, /^ {2}(push|pull_request):/m);
	assert.match(workflow, /contents: read/);
	assert.match(workflow, /bun run test:integration/);
	assert.match(workflow, /PLAYWRIGHT_BROWSERS_PATH:/);
	assert.match(workflow, /playwright install --with-deps chromium/);
	assert.doesNotMatch(workflow, /npm publish|publish:catalog|id-token: write/);
	for (const match of workflow.matchAll(/uses: ([^\s]+)/g))
		assert.match(match[1], /@[a-f0-9]{40}$/);
});
