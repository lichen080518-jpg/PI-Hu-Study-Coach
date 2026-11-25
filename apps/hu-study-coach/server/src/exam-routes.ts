import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { subjectSchema, verdictSchema, type Exam, type ExamItem, type StoredAttachment, type Verdict } from "./contracts.ts";
import { examScores } from "./exam-results.ts";
import { examDetail, examSummary, HttpError, openEventStream, parse, setFileHeaders, writeEvent } from "./http.ts";
import type { ModelSettingsController } from "./model-settings.ts";
import type { Security } from "./security.ts";
import type { Store } from "./store.ts";
import { collectUpload, discardUpload } from "./uploads.ts";

const idSchema = z.uuid();
const uploadSchema = z.object({ title: z.string().trim().min(1).max(120), subject: subjectSchema,
	referenceText: z.string().trim().max(24_000).default(""), worksheetId: z.union([idSchema, z.literal("")]).optional() });
const correctionSchema = z.strictObject({ id: idSchema, verdict: verdictSchema.optional(), ignored: z.boolean().optional() })
	.refine(({ verdict, ignored }) => verdict !== undefined || ignored !== undefined);
const gradeSchema = z.strictObject({ items: z.array(correctionSchema).min(1).max(120),
	revision: z.number().int().nonnegative() });
const retrySchema = z.strictObject({ confirmPublished: z.boolean().optional() });

const correctedFeedback: Record<Verdict, string> = {
	correct: "复核人已判为正确。",
	incorrect: "复核人已判为错误。",
	uncertain: "此题暂无法判定。",
};

export function registerExamRoutes(app: FastifyInstance, store: Store, auth: Security, attachmentsDir: string,
	wake: () => void, models: ModelSettingsController): void {
	app.post("/api/exams", async (request, reply) => {
		auth.requireRole(request);
		const requestKey = parse(idSchema, request.headers["idempotency-key"] ?? randomUUID(), "上传编号格式有误。");
		const existing = store.findExamByRequest(requestKey);
		if (existing) {
			request.raw.resume();
			return reply.code(202).send(examSummary(existing));
		}
		const attachments: StoredAttachment[] = [];
		let committed = false;
		try {
			const fields = parse(uploadSchema, await collectUpload(request, attachmentsDir, attachments));
			const worksheetId = fields.worksheetId || null;
			const linked = worksheetId ? store.getWorksheet(worksheetId) : null;
			if (worksheetId && (!linked || linked.worksheet.subject !== fields.subject)) {
				throw new HttpError(400, "关联练习卷不存在，或科目不一致。");
			}
			if (worksheetId && (linked?.attempt || store.findPaperExam(worksheetId))) {
				throw new HttpError(409, "本卷已有网页作答或纸卷记录，请打开原记录查看。");
			}
			const now = new Date().toISOString();
			const generatedReference = linked?.worksheet.questions.map((q, index) =>
				`${index + 1}. ${q.prompt}\n参考答案：${q.acceptedAnswers.join(" / ") || q.solution}\n评分细则：${q.rubric}\n满分：${q.maxScore}`).join("\n\n");
			const exam: Exam = {
				id: randomUUID(), title: fields.title, subject: fields.subject, worksheetId,
				referenceText: generatedReference ?? fields.referenceText, attachments, items: [],
				status: "queued", error: null, createdAt: now, updatedAt: now, revision: 0, obtained: null, possible: null,
			};
			committed = store.createExam(exam, requestKey);
			if (committed) wake();
			const saved = committed ? exam : store.findExamByRequest(requestKey);
			if (!saved) {
				if (worksheetId && !store.getWorksheet(worksheetId)) throw new HttpError(409, "关联练习卷已删除，请刷新后重试。");
				throw new HttpError(409, "本卷已有作答记录，请刷新查看。");
			}
			return reply.code(202).send(examSummary(saved));
		} finally {
			if (!committed) await discardUpload(attachmentsDir, attachments);
		}
	});

	app.get<{ Params: { id: string } }>("/api/exams/:id", async (request) => {
		const role = auth.requireRole(request);
		const exam = requireExam(store, request.params.id);
		return examDetail(exam, role, store.getExamRegrade(exam.id, exam.revision));
	});

	app.delete<{ Params: { id: string } }>("/api/exams/:id", async (request, reply) => {
		auth.requireRole(request, "reviewer");
		const result = store.deleteExam(parse(idSchema, request.params.id));
		if (result.kind === "missing") throw new HttpError(404, "找不到该试卷。");
		if (result.kind === "processing") throw new HttpError(409, "这份作业正在批改，请完成后再删除。");
		const failures = await discardUpload(attachmentsDir, result.attachments);
		if (failures) request.log.warn({ failures }, "Could not remove deleted exam attachments");
		return reply.code(204).send();
	});

	app.get<{ Params: { id: string; attachmentId: string } }>("/api/exams/:id/attachments/:attachmentId", async (request, reply) => {
		auth.requireRole(request);
		const exam = requireExam(store, request.params.id);
		const attachment = exam.attachments.find(({ id }) => id === request.params.attachmentId);
		if (!attachment) throw new HttpError(404, "找不到该原卷附件。");
		setFileHeaders(reply, attachment.mimeType, attachment.name);
		return reply.send(createReadStream(join(attachmentsDir, attachment.path)));
	});

	app.get<{ Params: { id: string } }>("/api/exams/:id/events", async (request, reply) => {
		auth.requireRole(request);
		const initial = requireExam(store, request.params.id);
		openEventStream(reply);
		writeEvent(reply, "status", examSummary(initial));
		if (initial.status !== "queued" && initial.status !== "processing") {
			reply.raw.end();
			return;
		}
		let previous = initial.updatedAt;
		const interval = setInterval(() => {
			const exam = store.getExam(initial.id);
			if (!exam || !auth.roleFor(request)) {
				reply.raw.end();
				return;
			}
			if (exam.updatedAt !== previous || exam.status !== "processing" && exam.status !== "queued") {
				previous = exam.updatedAt;
				writeEvent(reply, "status", examSummary(exam));
			}
			if (exam.status !== "queued" && exam.status !== "processing") reply.raw.end();
		}, 700);
		const deadline = setTimeout(() => reply.raw.end(), 90_000);
		reply.raw.on("close", () => { clearInterval(interval); clearTimeout(deadline); });
	});

	app.put<{ Params: { id: string } }>("/api/exams/:id/grade", async (request) => {
		const role = auth.requireRole(request, "reviewer");
		const exam = requireExam(store, request.params.id);
		const grade = parse(gradeSchema, request.body, "请选择需修改的题目及判定或忽略设置。");
		if (grade.revision !== exam.revision || exam.status === "queued" || exam.status === "processing") {
			throw new HttpError(409, "批改记录已变化，请刷新后重试。");
		}
		const changes = new Map(grade.items.map((change) => [change.id, change]));
		if (changes.size !== grade.items.length) throw new HttpError(422, "同一题目只能提交一次判定结果。");
		const items = exam.items.map((item): ExamItem => {
			const change = changes.get(item.id);
			if (!change) return item;
			changes.delete(item.id);
			const verdict = change.verdict ?? item.verdict;
			const ignored = change.ignored ?? item.ignored;
			if (verdict === item.verdict) return ignored === item.ignored ? item : { ...item, ignored };
			return { ...item, verdict, ignored, score: null, requiresReview: verdict === "uncertain",
				feedback: correctedFeedback[verdict], errorCause: "" };
		});
		if (changes.size) throw new HttpError(409, "找不到要更正的题目，请刷新后重试。");
		const saved = store.saveGrade(exam, {
			status: "published", referenceText: exam.referenceText, items, ...examScores(items),
		});
		if (!saved) throw new HttpError(409, "其他终端已更新批改记录，请刷新。");
		const updated = requireExam(store, exam.id);
		return examDetail(updated, role, store.getExamRegrade(updated.id, updated.revision));
	});

	app.post<{ Params: { id: string } }>("/api/exams/:id/retry", async (request, reply) => {
		auth.requireRole(request, "reviewer");
		const { confirmPublished } = parse(retrySchema, request.body ?? {});
		const exam = requireExam(store, request.params.id);
		if (!exam.attachments.length) throw new HttpError(409, "没有可重新批改的原卷附件。");
		if (exam.status === "queued" || exam.status === "processing") throw new HttpError(409, "这份作业正在批改，请稍候查看结果。");
		if (exam.hasPublishedResult && !confirmPublished) {
			return reply.code(409).send({ code: "REGRADE_CONFIRMATION_REQUIRED", message: "请确认重新批改这份已有结果的作业。" });
		}
		const { provider, tutor } = models.current();
		if (provider === "openai-codex" && await models.codexAuth() !== "ready") {
			return reply.code(409).send({ code: "CODEX_AUTH_REQUIRED", message: "请在模型配置中连接 OpenAI Codex 后重新批改。" });
		}
		if (!tutor.visionAvailable) {
			return reply.code(409).send({ code: "MODEL_UNAVAILABLE", message: "请在模型配置中设置支持图片输入的模型。" });
		}
		if (!store.queueExam(exam.id, exam.revision)) throw new HttpError(409, "批改记录已变化，请刷新后重试。");
		wake();
		return examSummary(requireExam(store, exam.id));
	});
}

export function requireExam(store: Store, id: string): Exam {
	const exam = store.getExam(parse(idSchema, id));
	if (!exam) throw new HttpError(404, "找不到该试卷。");
	return exam;
}
