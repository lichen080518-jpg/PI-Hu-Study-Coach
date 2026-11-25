import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FastifyRequest } from "fastify";
import type {} from "@fastify/multipart";
import sharp from "sharp";
import type { StoredAttachment } from "./contracts.ts";
import { HttpError } from "./http.ts";

export const MAX_FILE_BYTES = 12 * 1024 * 1024;
export const MAX_FILES = 12;
const imageFormats: ReadonlyMap<string, "jpeg" | "png" | "webp"> = new Map([
	["image/jpeg", "jpeg"], ["image/png", "png"], ["image/webp", "webp"],
]);

export async function collectUpload(request: FastifyRequest, directory: string, attachments: StoredAttachment[]) {
	if (!request.isMultipart()) throw new HttpError(415, "请使用文件上传表单。");
	const fields: Record<string, string> = Object.create(null);
	let size = 0;
	for await (const part of request.parts()) {
		if (part.type === "field") {
			if (part.fieldnameTruncated || part.valueTruncated || typeof part.value !== "string") {
				throw new HttpError(413, "试卷信息超出长度限制。");
			}
			if (Object.hasOwn(fields, part.fieldname)) throw new HttpError(400, "上传表单字段重复。");
			fields[part.fieldname] = part.value;
			continue;
		}
		if (part.fieldname !== "files") throw new HttpError(400, "上传文件字段有误。");
		const content = await part.toBuffer();
		size += content.length;
		if (size > 48 * 1024 * 1024) throw new HttpError(413, "单次上传总大小上限为 48 MiB。");
		const id = randomUUID();
		const { bytes, mimeType, extension } = await normalize(content, part.mimetype);
		const name = basename(part.filename.replaceAll("\\", "/")).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160);
		const path = `${id}.${extension}`;
		await writeFile(join(directory, path), bytes, { flag: "wx", mode: 0o600 });
		attachments.push({ id, name: name || `原卷.${extension}`, mimeType, path });
	}
	if (!attachments.length) throw new HttpError(400, "请上传至少一张试卷照片或 PDF。");
	return fields;
}

export async function discardUpload(directory: string, attachments: readonly StoredAttachment[]): Promise<number> {
	const removed = await Promise.allSettled(attachments.map(async ({ path }) => {
		if (!path || path === "." || path === ".." || basename(path) !== path) throw new Error("Invalid attachment path");
		try {
			await unlink(join(directory, path));
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}));
	return removed.filter(({ status }) => status === "rejected").length;
}

async function normalize(content: Buffer, mimeType: string): Promise<{ bytes: Buffer; mimeType: string; extension: string }> {
	if (mimeType === "application/pdf" && content.subarray(0, 5).toString() === "%PDF-") {
		return { bytes: content, mimeType, extension: "pdf" };
	}
	const extension = imageFormats.get(mimeType);
	if (!extension) throw new HttpError(415, "请上传 JPEG、PNG、WebP 或 PDF。");
	try {
		const image = sharp(content, { limitInputPixels: 45_000_000, failOn: "error" });
		const metadata = await image.metadata();
		if (metadata.format !== extension || (metadata.pages ?? 1) > 1) throw new Error("unsupported image");
		const bytes = await image.rotate().toFormat(extension, { quality: 95 }).toBuffer();
		return { bytes, mimeType, extension };
	} catch {
		throw new HttpError(422, "照片无法读取，或者图片尺寸超出限制。");
	}
}
