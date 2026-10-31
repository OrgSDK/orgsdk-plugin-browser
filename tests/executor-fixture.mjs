import assert from "node:assert/strict";

export default async function createFixture() {
	return {
		async run(call) {
			const pdf = await call("generatePdf", {
				html: "<!doctype html><html><body><h1>Headless executor fixture</h1></body></html>",
				options: { filename: "fixture.pdf" },
			});
			assert.equal(pdf.filename, "fixture.pdf");
			assert(pdf.sizeBytes > 100);
			assert.equal(
				Buffer.from(pdf.base64, "base64").subarray(0, 4).toString(),
				"%PDF",
			);
		},
	};
}
