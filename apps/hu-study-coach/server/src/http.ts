import type { FastifyReply } from "fastify";
import type { ZodType } from "zod";
import type { Exam, ExamRegrade, ExamSummary, Role } from "./contracts.ts";

export class HttpError extends Error {
	readonly statusCode: number;

	constructor(statusCode: number, message: string) {
		super(message);
		this.statusCode = statusCode;
	}
}

export function parse<T>(schema: ZodType<T>, value: unknown, message = "请求内容格式有误。"): T {
	const result = schema.safeParse(value);
	if (!result.success) throw new HttpError(400, message);
	return result.data;
}

export function examSummary(exam: Exam): ExamSummary {
	const { id, title, subject, status, error, createdAt, obtained, possible, worksheetId } = exam;
	const counts = { correct: 0, incorrect: 0, uncertain: 0 };
	const hasPublishedResult = exam.hasPublishedResult ?? status === "published";
	const retryAvailable = exam.attachments.length > 0 && status !== "queued" && status !== "processing";
	if (hasPublishedResult) {
		for (const { verdict } of exam.items) counts[verdict]++;
	}
	return { id, title, subject, status, error, createdAt, obtained, possible, worksheetId, hasPublishedResult, retryAvailable,
		correctCount: counts.correct, incorrectCount: counts.incorrect, uncertainCount: counts.uncertain };
}

export function examDetail(exam: Exam, role: Role, regrade: ExamRegrade | null) {
	const canReview = role === "reviewer";
	return {
		...examSummary(exam),
		revision: exam.revision,
		referenceText: canReview ? exam.referenceText : "",
		attachments: exam.attachments.map(({ id, name, mimeType }) => ({ id, name, mimeType,
			url: `/api/exams/${exam.id}/attachments/${id}` })),
		items: canReview || exam.hasPublishedResult ? exam.items : [],
		regrade: exam.hasPublishedResult ? regrade : null,
	};
}

export function setFileHeaders(reply: FastifyReply, type: string, name: string, disposition: "inline" | "attachment" = "inline"): void {
	const encoded = encodeURIComponent(name.toWellFormed()).replace(/['()*]/g, (value) => `%${value.charCodeAt(0).toString(16)}`);
	reply.type(type).header("Content-Disposition", `${disposition}; filename*=UTF-8''${encoded}`);
	if (type === "application/pdf") reply.header("X-Frame-Options", "SAMEORIGIN")
		.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'self'");
}

export function openEventStream(reply: FastifyReply): void {
	reply.hijack();
	for (const [key, value] of Object.entries(reply.getHeaders())) {
		if (value !== undefined && key !== "content-length") reply.raw.setHeader(key, value);
	}
	reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
	reply.raw.setHeader("X-Accel-Buffering", "no");
	reply.raw.writeHead(200);
	reply.raw.flushHeaders();
}

export function writeEvent(reply: FastifyReply, event: "status" | "delta" | "done" | "fault", data: unknown): void {
	if (!reply.raw.destroyed && !reply.raw.writableEnded) {
		reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	}
}
