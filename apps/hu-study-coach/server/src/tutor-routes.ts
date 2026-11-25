import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Tutor } from "./ai.ts";
import { subjectSchema, type MarkingItem } from "./contracts.ts";
import { requireExam } from "./exam-routes.ts";
import { HttpError, openEventStream, parse, writeEvent } from "./http.ts";
import type { Security } from "./security.ts";
import type { Store } from "./store.ts";
import { TutorError } from "./tutor-error.ts";

const dialogSchema = z.object({
	subject: subjectSchema,
	examId: z.uuid().optional(),
	itemId: z.uuid().optional(),
	messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(6_000) }))
		.min(1).max(20),
});

export function registerTutorRoutes(app: FastifyInstance, store: Store, auth: Security, getTutor: () => Tutor): void {
	let inFlight = 0;
	app.post("/api/tutor", async (request, reply) => {
		const role = auth.requireRole(request);
		const tutor = getTutor();
		if (!tutor.available) throw new HttpError(503, "主机尚未配置辅导模型。");
		if (inFlight >= 2) throw new HttpError(429, "正在处理其他提问，请稍后再试。");
		const { subject, examId, itemId, messages } = parse(dialogSchema, request.body);
		if (messages.at(-1)?.role !== "user") throw new HttpError(400, "请发送一个新的问题。");
		let item: MarkingItem | null = null;
		if (examId && itemId) {
			const exam = requireExam(store, examId);
			if (exam.subject !== subject || role === "student" && !exam.hasPublishedResult) {
				throw new HttpError(403, "当前题目尚不可用于辅导。");
			}
			item = exam.items.find(({ id }) => id === itemId) ?? null;
			if (!item) throw new HttpError(404, "找不到该题目。");
		} else if (examId || itemId) {
			throw new HttpError(400, "按题辅导需要同时提供试卷和题目编号。");
		}
		const controller = new AbortController();
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
		reply.raw.once("close", () => controller.abort());
		openEventStream(reply);
		inFlight++;
		try {
			await tutor.talk({ subject, item, messages }, (text) => {
				if (reply.raw.writableLength > 256_000) {
					controller.abort();
					return;
				}
				writeEvent(reply, "delta", { text });
			}, signal);
			if (!signal.aborted) writeEvent(reply, "done", {});
			else if (!controller.signal.aborted) writeEvent(reply, "fault", { message: "辅导请求已超时，请重试。" });
		} catch (error) {
			if (!controller.signal.aborted) {
				request.log.warn({ reason: error instanceof Error ? error.name : "provider" }, "Tutoring request did not complete");
				writeEvent(reply, "fault", { message: error instanceof TutorError ? error.message : "辅导回复暂时中断，请稍后重试。" });
			}
		} finally {
			inFlight--;
			reply.raw.end();
		}
	});
}
