import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { subjectSchema, worksheetModeSchema, type Attempt } from "./contracts.ts";
import { HttpError, parse, setFileHeaders } from "./http.ts";
import { renderWorksheetPdf } from "./pdf.ts";
import { isAcceptedAnswer, MAX_WORKSHEET_QUESTIONS } from "./practice.ts";
import type { Security } from "./security.ts";
import type { Store, WorksheetRecord } from "./store.ts";
import type { WorksheetGeneration } from "./worksheet-generation.ts";

const wrongIdSchema = z.templateLiteral([z.uuid(), ":", z.union([z.uuid(), z.string().regex(/^[0-9a-f]{64}$/iu)])])
	.transform((id) => id.toLowerCase());
const createSchema = z.object({ subject: subjectSchema, mode: worksheetModeSchema,
	wrongIds: z.array(wrongIdSchema).min(1).max(MAX_WORKSHEET_QUESTIONS)
		.refine((ids) => new Set(ids).size === ids.length).optional(),
}).refine(({ mode, wrongIds }) => mode === "review" || wrongIds === undefined);
const submitSchema = z.object({ responses: z.array(z.object({ questionId: z.string().min(1).max(160),
	response: z.string().trim().max(8_000) })).min(1).max(MAX_WORKSHEET_QUESTIONS), assisted: z.boolean() });
const gradeSchema = z.object({ items: z.array(z.object({ questionId: z.string().min(1).max(160),
	score: z.number().min(0), feedback: z.string().trim().max(6_000) })).min(1).max(MAX_WORKSHEET_QUESTIONS) });

export function registerWorksheetRoutes(app: FastifyInstance, store: Store, auth: Security, generation: WorksheetGeneration): void {
	app.post("/api/worksheets", async (request, reply) => {
		auth.requireRole(request);
		const { subject, mode, wrongIds } = parse(createSchema, request.body);
		const disconnected = new AbortController();
		const abort = () => disconnected.abort();
		reply.raw.once("close", abort);
		try {
			const worksheet = await generation.generate(subject, mode, disconnected.signal, wrongIds ? { wrongIds } : undefined);
			if (!worksheet) throw new HttpError(409, "本科目暂时没有可供复练的错题。请先批改并确认错题。");
			return reply.code(201).send(worksheetSummary({ worksheet, attempt: null }));
		} finally {
			reply.raw.off("close", abort);
		}
	});
	app.get<{ Params: { id: string } }>("/api/worksheets/:id", async (request) => {
		auth.requireRole(request);
		const record = requireWorksheet(store, request.params.id);
		const paper = store.findPaperExam(record.worksheet.id);
		return { ...worksheetDetail(record), paperExam: paper ? { id: paper.id, status: paper.status,
			hasPublishedResult: paper.hasPublishedResult } : null };
	});
	app.delete<{ Params: { id: string } }>("/api/worksheets/:id", async (request, reply) => {
		auth.requireRole(request, "reviewer");
		if (!store.deleteWorksheet(parse(z.uuid(), request.params.id))) throw new HttpError(404, "找不到该练习卷。");
		return reply.code(204).send();
	});
	app.get<{ Params: { id: string; variant: string } }>("/api/worksheets/:id/pdf/:variant", async (request, reply) => {
		const role = auth.requireRole(request);
		const record = requireWorksheet(store, request.params.id);
		const variant = parse(z.enum(["student", "solutions"]), request.params.variant);
		if (variant === "solutions" && role !== "reviewer" && !record.attempt
			&& !store.findPaperExam(record.worksheet.id)?.hasPublishedResult) {
			throw new HttpError(403, "提交练习或纸卷批改发布后即可查看答案。");
		}
		const { download } = parse(z.object({ download: z.literal("1").optional() }), request.query);
		try {
			const pdf = await renderWorksheetPdf(record.worksheet, variant);
			const title = `${record.worksheet.title}${variant === "solutions" ? " · 答案详解" : ""}.pdf`;
			setFileHeaders(reply, "application/pdf", title, download === "1" ? "attachment" : "inline");
			return reply.send(pdf);
		} catch (error) {
			request.log.warn({ reason: error instanceof Error ? error.name : "renderer" }, "Could not render worksheet PDF");
			throw new HttpError(503, "PDF 暂时无法生成，请检查主机的 Chromium 浏览器配置。");
		}
	});
	app.post<{ Params: { id: string } }>("/api/worksheets/:id/attempts", async (request) => {
		const role = auth.requireRole(request);
		const record = requireWorksheet(store, request.params.id);
		const { responses, assisted } = parse(submitSchema, request.body);
		if (record.attempt || store.findPaperExam(record.worksheet.id)) throw new HttpError(409, "本卷已有作答记录，请刷新查看。");
		const byQuestion = new Map(responses.map(({ questionId, response }) => [questionId, response]));
		if (byQuestion.size !== responses.length || byQuestion.size !== record.worksheet.questions.length) {
			throw new HttpError(422, "请提交完整的题目列表，可将未作答的题目留空。");
		}
		const attempt: Attempt = { createdAt: new Date().toISOString(), assisted: assisted || role === "reviewer",
			items: record.worksheet.questions.map((question) => {
				const response = byQuestion.get(question.id);
				if (response === undefined) throw new HttpError(422, "答案与当前试卷题目不匹配。");
				if (!response) return { questionId: question.id, response, score: 0, feedback: "未作答。" };
				if (question.responseType === "review") {
					return { questionId: question.id, response, score: null, feedback: "待复核人按评分依据确认。" };
				}
				const correct = isAcceptedAnswer(question, response);
				return { questionId: question.id, response, score: correct ? question.maxScore : 0,
					feedback: correct ? "作答正确。" : question.solution };
			}) };
		if (!store.submitAttempt(record.worksheet.id, attempt)) throw new HttpError(409, "本卷已经提交，请刷新查看结果。");
		return worksheetDetail({ worksheet: record.worksheet, attempt });
	});
	app.put<{ Params: { id: string } }>("/api/worksheets/:id/attempts/grade", async (request) => {
		auth.requireRole(request, "reviewer");
		const record = requireWorksheet(store, request.params.id);
		if (!record.attempt) throw new HttpError(409, "请先提交练习。");
		const { items } = parse(gradeSchema, request.body);
		const changes = new Map(items.map((item) => [item.questionId, item]));
		if (changes.size !== items.length) throw new HttpError(422, "同一题目只能提交一次评分。");
		const questions = new Map(record.worksheet.questions.map((question) => [question.id, question]));
		for (const [id, change] of changes) {
			const question = questions.get(id);
			if (!question || change.score > question.maxScore) throw new HttpError(422, "题目或分值无效。");
		}
		const next: Attempt = { ...record.attempt, items: record.attempt.items.map((item) => ({ ...item, ...changes.get(item.questionId) })) };
		if (!store.updateAttempt(record.worksheet.id, record.attempt, next)) {
			throw new HttpError(409, "其他终端已修改评分，请刷新重试。");
		}
		return worksheetDetail({ worksheet: record.worksheet, attempt: next });
	});
}

export function worksheetSummary({ worksheet, attempt }: WorksheetRecord) {
	const { id, subject, title, createdAt, mode, uncoveredSkillIds, questions } = worksheet;
	return { id, subject, title, createdAt, mode, uncoveredSkillIds, questionCount: questions.length, submitted: Boolean(attempt) };
}

function requireWorksheet(store: Store, id: string): WorksheetRecord {
	const record = store.getWorksheet(parse(z.uuid(), id));
	if (!record) throw new HttpError(404, "找不到该练习卷。");
	return record;
}

function worksheetDetail(record: WorksheetRecord) {
	const { worksheet, attempt } = record;
	const byId = new Map(worksheet.questions.map((question) => [question.id, question]));
	return {
		...worksheetSummary(record),
		questions: worksheet.questions.map(({ id, skillId, difficulty, prompt, maxScore, responseType }) =>
			({ id, skillId, difficulty, prompt, maxScore, responseType })),
		attempt: attempt ? { ...attempt, items: attempt.items.map((item) => {
			const question = byId.get(item.questionId);
			return { ...item, referenceAnswer: question?.acceptedAnswers.join(" / ") || question?.solution || "",
				rubric: question?.rubric ?? "" };
		}) } : null,
	};
}
