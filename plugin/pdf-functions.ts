import type { SafeFunction } from "@orgsdk/plugins";
import {
	type PdfMargin,
	type PdfPageFormat,
	renderHtmlToPdf,
} from "./browser-renderer";

export const moduleDescription = "Generate PDF documents from HTML content";

export interface GeneratePdfOptions {
	format?: PdfPageFormat;
	landscape?: boolean;
	margin?: PdfMargin;
	filename?: string;
}

export interface GeneratePdfResult {
	base64: string;
	sizeBytes: number;
	filename: string;
}

function encodeBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

export const safeFunctions: SafeFunction[] = [
	{
		name: "generatePdf",
		handler: async ({
			html,
			options,
		}: {
			html: string;
			options?: GeneratePdfOptions;
		}): Promise<GeneratePdfResult> => {
			const { bytes, sizeBytes } = await renderHtmlToPdf(html, options);
			return {
				base64: encodeBase64(bytes),
				sizeBytes,
				filename: options?.filename ?? `document-${Date.now()}.pdf`,
			};
		},
		description:
			"Generate a PDF from HTML content using headless Chromium. Returns base64-encoded PDF bytes.",
		returnType:
			"Promise<{ base64: string; sizeBytes: number; filename: string }>",
		parameters: [
			{ name: "html", type: "string" },
			{
				name: "options",
				type: '{ format?: "A4" | "Letter"; landscape?: boolean; margin?: { top?: string; right?: string; bottom?: string; left?: string }; filename?: string }',
			},
		],
		metadata: {
			category: "browser",
			tags: ["io"],
			version: "1.1.2",
			relatedTo: ["parsePdf", "sendMessageWithAttachment", "upsertArtifact"],
		},
		docs: {
			summary:
				"Generate a PDF document from HTML content. Uses headless Chromium via Playwright to render the HTML and produce a PDF. Returns base64-encoded bytes suitable for storing as an artifact or attaching to an email. JavaScript is disabled and all external/resource requests are blocked — only inline styles and data:/blob: images load.",
			parameters: [
				{
					name: "html",
					type: "string",
					description:
						"Full HTML content to render as a PDF. Inline CSS and tables are supported; images must be embedded as data URIs.",
					example:
						'"<html><body><h1>Invoice #1001</h1><table>...</table></body></html>"',
				},
				{
					name: "options",
					type: "object",
					description: "Optional PDF generation settings.",
					example:
						'{ format: "A4", landscape: false, filename: "invoice-1001.pdf" }',
				},
			],
			returns: {
				type: "Promise<{ base64: string; sizeBytes: number; filename: string }>",
				description:
					"Base64-encoded PDF bytes, file size in bytes, and the filename (auto-generated if not provided).",
				example:
					'{ base64: "JVBERi0xLjQK...", sizeBytes: 45230, filename: "invoice-1001.pdf" }',
			},
			examples: [
				{
					title: "Generate an invoice PDF and email it",
					code: `const html = \`<html>
<head><style>table { width: 100%; border-collapse: collapse; } td, th { border: 1px solid #ddd; padding: 8px; }</style></head>
<body>
  <h1>Invoice #1001</h1>
  <table><tr><th>Item</th><th>Amount</th></tr><tr><td>Consulting</td><td>$500</td></tr></table>
</body></html>\`;

const pdf = await generatePdf({ html, options: { format: "A4", filename: "invoice-1001.pdf" } });
await upsertArtifact("report", { base64: pdf.base64, filename: pdf.filename }, { name: "invoice-1001", tags: ["invoice"] });
await sendMessageWithAttachment("client@example.com", "Invoice #1001", "Please find your invoice attached.", [{ filename: pdf.filename, mimeType: "application/pdf", base64Data: pdf.base64 }]);`,
					description:
						"Generate an invoice PDF from HTML, store it as an artifact, and email it",
				},
			],
			caveats: [
				"JavaScript is disabled — <script> tags and inline event handlers do not execute.",
				"All external resource requests (http, https, file, fonts, remote images) are blocked. Embed images and fonts as data URIs.",
				"Renders are serialized (one at a time per process) and capped at a 30s render timeout.",
			],
			seeAlso: ["parsePdf", "sendMessageWithAttachment", "upsertArtifact"],
		},
	},
];
