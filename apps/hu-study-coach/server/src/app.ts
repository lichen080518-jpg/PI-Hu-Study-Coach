import multipart from "@fastify/multipart";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastify, { type FastifyError } from "fastify";
import type { Tutor } from "./ai.ts";
import { analyze } from "./analytics.ts";
import { createCodexCredentials } from "./codex-auth.ts";
import { registerCodexLoginRoutes } from "./codex-login.ts";
import { registerExamRoutes } from "./exam-routes.ts";
import { examSummary, HttpError } from "./http.ts";
import { createJobs } from "./jobs.ts";
import { createModelSettings, registerModelSettingsRoutes } from "./model-settings.ts";
import { getSkills } from "./practice.ts";
import { registerQuestionImageRoutes } from "./question-images.ts";
import { registerSecurity } from "./security.ts";
import { Store } from "./store.ts";
import { registerTutorRoutes } from "./tutor-routes.ts";
import { MAX_FILE_BYTES, MAX_FILES } from "./uploads.ts";
import { createWorksheetGeneration } from "./worksheet-generation.ts";
import { registerWorksheetRoutes, worksheetSummary } from "./worksheet-routes.ts";

const clientDirectory = new URL("../../client/", import.meta.url);
const assets = ["api.js", "app.js", "dashboard.js", "model-settings.js", "papers.js", "question-image.js", "tutor.js", "ui.js", "worksheets.js", "styles.css"];

export async function buildApp(options: { env?: NodeJS.ProcessEnv; tutor?: Tutor; logger?: boolean } = {}) {
	const env = options.env ?? process.env;
	const reviewer = env.TUTOR_REVIEWER_PASSCODE ?? "";
	const student = env.TUTOR_STUDENT_PASSCODE ?? "";
	if (reviewer.length < 12 || student.length < 12 || reviewer === student || reviewer.length > 200 || student.length > 200) {
		throw new Error("请在 .env 中设置两个不同且至少 12 字符的口令 TUTOR_REVIEWER_PASSCODE 和 TUTOR_STUDENT_PASSCODE。");
	}
	const publicOrigin = env.TUTOR_PUBLIC_ORIGIN ? new URL(env.TUTOR_PUBLIC_ORIGIN) : null;
	if (publicOrigin && (publicOrigin.protocol !== "https:" || publicOrigin.href !== `${publicOrigin.origin}/`)) {
		throw new Error("TUTOR_PUBLIC_ORIGIN 需填受信任的 HTTPS 地址，包含主机名及可选端口。");
	}
	const dataDirectory = resolve(env.TUTOR_DATA_DIR || fileURLToPath(new URL("../data", import.meta.url)));
	const attachmentsDir = join(dataDirectory, "attachments");
	await mkdir(attachmentsDir, { recursive: true, mode: 0o700 });
	const store = new Store(join(dataDirectory, "study.sqlite"));
	const credentials = createCodexCredentials(dataDirectory, env);
	const modelSettings = createModelSettings(store, env, credentials, options.tutor);
	const app = fastify({ logger: options.logger ?? true, bodyLimit: 2 * 1024 * 1024, requestTimeout: 180_000,
		forceCloseConnections: true });
	app.setErrorHandler<FastifyError>((error, request, reply) => {
		if (error instanceof HttpError) return reply.code(error.statusCode).send({ message: error.message });
		const status = error.statusCode ?? 500;
		if (status === 413) return reply.code(413).send({ message: "上传超出文件大小、页数或表单限制。" });
		if (status >= 400 && status < 500) return reply.code(status).send({ message: "请求格式不受支持。" });
		request.log.error({ code: error.code ?? error.name }, "Request failed");
		return reply.code(500).send({ message: "服务暂时无法完成请求。" });
	});
	app.setNotFoundHandler((_request, reply) => reply.code(404).send({ message: "找不到请求的内容。" }));
	await app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES, fields: 4,
		parts: MAX_FILES + 5, fieldSize: 80_000 } });
	const auth = registerSecurity(app, store, modelSettings, { passcodes: { reviewer, student }, publicOrigin, secure: Boolean(publicOrigin) });
	const getTutor = () => modelSettings.current().tutor;
	const generation = createWorksheetGeneration(store, getTutor, app.log);
	const jobs = createJobs(store, getTutor, app.log, attachmentsDir, env.TUTOR_WEEKLY_ENABLED === "0" ? null : generation);
	app.addHook("onReady", async () => { jobs.start(); });
	app.addHook("preClose", async () => { await Promise.all([jobs.stop(), generation.stop()]); });
	app.addHook("onClose", async () => { store.close(); });
	registerModelSettingsRoutes(app, auth, modelSettings);
	registerCodexLoginRoutes(app, auth, credentials);
	registerExamRoutes(app, store, auth, attachmentsDir, jobs.wake, modelSettings);
	registerQuestionImageRoutes(app, store, auth, attachmentsDir);
	registerWorksheetRoutes(app, store, auth, generation);
	registerTutorRoutes(app, store, auth, getTutor);
	app.get("/api/skills", async (request) => {
		auth.requireRole(request);
		return { skills: [...getSkills("chinese"), ...getSkills("math"), ...getSkills("english")] };
	});
	app.get("/api/dashboard", async (request) => {
		const role = auth.requireRole(request);
		const exams = store.listExams();
		const worksheets = store.listWorksheets();
		const { wrong, trend } = analyze(exams, worksheets);
		return { exams: exams.map(examSummary), wrong, trend, worksheets: worksheets.map(worksheetSummary),
			reviewCount: role === "reviewer" ? exams.filter((exam) => exam.status === "review" || exam.status === "failed").length
				+ worksheets.filter(({ attempt }) => attempt?.items.some(({ score }) => score === null)).length : 0 };
	});
	app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(await readFile(new URL("index.html", clientDirectory))));
	for (const asset of assets) {
		const type = asset.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
		app.get(`/${asset}`, async (_request, reply) => reply.type(type).send(await readFile(new URL(asset, clientDirectory))));
	}
	return app;
}
