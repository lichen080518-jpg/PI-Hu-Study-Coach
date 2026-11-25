import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import type { ImageContent } from "@earendil-works/pi-ai";
import { getDocument, type PDFDocumentProxy, type PDFPageProxy, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import sharp from "sharp";
import type { StoredAttachment } from "./contracts.ts";
import { TutorError } from "./tutor-error.ts";

export const MAX_PAGES = 12;
const PAGE_LIMIT_MESSAGE = `单次自动识卷最多处理 ${MAX_PAGES} 页。请分批上传。`;
const MAX_IMAGE_PIXELS = 45_000_000;
const PAGE_EDGE = 2_300;
const PDF_ASSETS = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));

/** Renders uploaded pages in order and strips file metadata before local inference. */
export async function prepareExamPages(attachments: StoredAttachment[], signal: AbortSignal): Promise<ImageContent[]> {
	const pages: ImageContent[] = [];
	for (const attachment of attachments) {
		signal.throwIfAborted();
		if (pages.length >= MAX_PAGES) throw new TutorError(PAGE_LIMIT_MESSAGE);
		if (attachment.mimeType === "application/pdf") {
			await withPdf(attachment.path, signal, async (pdf) => {
				if (pdf.numPages + pages.length > MAX_PAGES) throw new TutorError(PAGE_LIMIT_MESSAGE);
				for (let index = 1; index <= pdf.numPages; index += 1) {
					const image = await readPdfPage(pdf, index, signal);
					pages.push({ type: "image", mimeType: "image/jpeg", data: image.toString("base64") });
				}
			});
		} else {
			const image = await readExamImage(attachment.path, signal);
			pages.push({ type: "image", mimeType: "image/jpeg", data: image.toString("base64") });
		}
	}
	return pages;
}

/** Renders one expanded page using the same orientation and scale as grading. */
export async function prepareExamPage(attachments: readonly StoredAttachment[], page: number, signal: AbortSignal): Promise<Buffer | null> {
	if (page < 1 || page > MAX_PAGES) return null;
	let remaining = page;
	for (const attachment of attachments) {
		signal.throwIfAborted();
		if (attachment.mimeType === "application/pdf") {
			const selection = await withPdf(attachment.path, signal, async (pdf) => remaining <= pdf.numPages
				? { image: await readPdfPage(pdf, remaining, signal) }
				: { nextPage: remaining - pdf.numPages });
			if (selection.image) return selection.image;
			remaining = selection.nextPage;
		} else if (remaining === 1) {
			return readExamImage(attachment.path, signal);
		} else {
			remaining--;
		}
	}
	return null;
}

async function readExamImage(path: string, signal: AbortSignal): Promise<Buffer> {
	try {
		const data = await readFile(path, { signal });
		return await sharp(data, { limitInputPixels: MAX_IMAGE_PIXELS })
			.autoOrient()
			.resize(PAGE_EDGE, PAGE_EDGE, { fit: "inside", withoutEnlargement: true })
			.flatten({ background: "#fff" })
			.jpeg({ quality: 90 })
			.toBuffer();
	} catch {
		signal.throwIfAborted();
		throw new TutorError("试卷照片无法读取。请检查图片格式，再拍摄或重新导出 JPG、PNG 或 WebP。");
	}
}

async function withPdf<T>(path: string, signal: AbortSignal, read: (pdf: PDFDocumentProxy) => Promise<T>): Promise<T> {
	const bytes = await readFile(path, { signal }).catch(() => {
		signal.throwIfAborted();
		throw new TutorError("原卷 PDF 附件无法读取，请重新上传。");
	});
	signal.throwIfAborted();
	const loading = getDocument({
		data: new Uint8Array(bytes),
		cMapUrl: `${PDF_ASSETS}/cmaps/`,
		standardFontDataUrl: `${PDF_ASSETS}/standard_fonts/`,
		wasmUrl: `${PDF_ASSETS}/wasm/`,
		useSystemFonts: true,
		useWorkerFetch: false,
		stopAtErrors: true,
		maxImageSize: MAX_IMAGE_PIXELS,
		verbosity: VerbosityLevel.ERRORS,
	});
	try {
		const pdf = await loading.promise.catch(() => {
			throw new TutorError("PDF 无法读取。请检查文件是否损坏或加密，再导出一个可打开的版本。");
		});
		signal.throwIfAborted();
		return await read(pdf);
	} finally {
		await loading.destroy();
	}
}

async function readPdfPage(pdf: PDFDocumentProxy, index: number, signal: AbortSignal): Promise<Buffer> {
	signal.throwIfAborted();
	try {
		const page = await pdf.getPage(index);
		return await renderPdfPage(page, signal);
	} catch {
		signal.throwIfAborted();
		throw new TutorError(`PDF 的第 ${index} 页无法转换。请重新导出，或上传该页的照片。`);
	}
}

async function renderPdfPage(page: PDFPageProxy, signal: AbortSignal): Promise<Buffer> {
	const size = page.getViewport({ scale: 1 });
	const longestEdge = Math.max(size.width, size.height);
	if (!Number.isFinite(longestEdge) || longestEdge <= 0) throw new Error("PDF 页面尺寸无效。");
	const viewport = page.getViewport({ scale: Math.min(4, PAGE_EDGE / longestEdge) });
	const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
	signal.throwIfAborted();
	// PDF.js uses this same native canvas implementation in its Node canvas factory.
	const canvasForPdf = canvas as unknown as Parameters<PDFPageProxy["render"]>[0]["canvas"];
	const render = page.render({ canvas: canvasForPdf, viewport, background: "#fff" });
	const cancel = () => render.cancel();
	signal.addEventListener("abort", cancel, { once: true });
	try {
		await render.promise;
		signal.throwIfAborted();
		return canvas.toBuffer("image/jpeg", 92);
	} finally {
		signal.removeEventListener("abort", cancel);
		page.cleanup();
		canvas.width = 1;
		canvas.height = 1;
	}
}
