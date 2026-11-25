import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { type Exam, type QuestionRegion, questionRegionSchema } from "./contracts.ts";
import { MAX_PAGES, prepareExamPage } from "./exam-pages.ts";
import { requireExam } from "./exam-routes.ts";
import { HttpError, parse, setFileHeaders } from "./http.ts";
import type { Security } from "./security.ts";
import type { Store } from "./store.ts";
import { TutorError } from "./tutor-error.ts";

interface QuestionImageParams {
	id: string;
	itemId: string;
}

const viewSchema = z.object({ view: z.literal("page").optional() });
const regionSchema = z.strictObject({ page: z.number().int().min(1).max(MAX_PAGES), region: questionRegionSchema });

/** Serves original images for published incorrect or uncertain items, and saves crops for incorrect items. */
export function registerQuestionImageRoutes(app: FastifyInstance, store: Store, auth: Security, attachmentsDir: string): void {
	const path = "/api/exams/:id/items/:itemId/image";
	app.get<{ Params: QuestionImageParams }>(path, async (request, reply) => {
		auth.requireRole(request);
		const { exam, item, page } = requireQuestionSource(store, request.params);
		const { view } = parse(viewSchema, request.query);
		const region = view === "page" ? undefined : item.imageRegion;
		if (view !== "page" && !region) throw new HttpError(404, "本题尚未保存截图。");
		const image = await readQuestionPage(exam, page, attachmentsDir, request.signal);
		const jpeg = region ? await cropPage(image, region) : image;
		setFileHeaders(reply, "image/jpeg", region ? "原题截图.jpg" : "原卷页面.jpg");
		return reply.send(jpeg);
	});

	app.put<{ Params: QuestionImageParams }>(path, async (request) => {
		auth.requireRole(request, "reviewer");
		const { exam, item, page } = requireQuestionSource(store, request.params);
		if (item.verdict !== "incorrect") throw new HttpError(404, "没有找到该错题的原卷页。");
		const { page: sourcePage, region } = parse(regionSchema, request.body, "请选择原卷内的截图区域。");
		if (sourcePage !== page || exam.status === "queued" || exam.status === "processing") {
			throw new HttpError(409, "原卷定位已变化或正在批改，请刷新错题后重试。");
		}
		await readQuestionPage(exam, page, attachmentsDir, request.signal);
		if (!store.saveExamItemRegion(exam, item.id, region)) {
			throw new HttpError(409, "错题记录已变化，请刷新后重试。");
		}
		return { page, hasScreenshot: true };
	});
}

function requireQuestionSource(store: Store, { id, itemId }: QuestionImageParams) {
	const exam = requireExam(store, id);
	const requestedId = parse(z.uuid(), itemId);
	const item = exam.items.find((entry) => entry.id === requestedId && entry.verdict !== "correct");
	if (!exam.hasPublishedResult || !item || item.page === null || item.page > MAX_PAGES) {
		throw new HttpError(404, "没有找到该题的原卷页。");
	}
	return { exam, item, page: item.page };
}

async function readQuestionPage(exam: Exam, page: number, attachmentsDir: string, disconnected: AbortSignal): Promise<Buffer> {
	const deadline = AbortSignal.timeout(20_000);
	const signal = AbortSignal.any([disconnected, deadline]);
	const attachments = exam.attachments.map((attachment) => ({ ...attachment, path: join(attachmentsDir, attachment.path) }));
	try {
		const image = await prepareExamPage(attachments, page, signal);
		signal.throwIfAborted();
		if (!image) throw new HttpError(404, "没有找到该题的原卷页。");
		return image;
	} catch (error) {
		if (deadline.aborted) throw new HttpError(504, "原卷页面转换超时，请稍后重试。");
		if (disconnected.aborted) throw new HttpError(408, "原卷页面请求已中断。");
		if (error instanceof TutorError) throw new HttpError(422, error.message);
		throw error;
	}
}

async function cropPage(image: Buffer, region: QuestionRegion): Promise<Buffer> {
	const page = sharp(image);
	const { width, height } = await page.metadata();
	const left = Math.floor(width * region.x / 1_000);
	const top = Math.floor(height * region.y / 1_000);
	const right = Math.ceil(width * (region.x + region.width) / 1_000);
	const bottom = Math.ceil(height * (region.y + region.height) / 1_000);
	return page.extract({ left, top, width: right - left, height: bottom - top }).jpeg({ quality: 90 }).toBuffer();
}
