import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import sharp from "sharp";
import { createTutor, type Tutor } from "../src/ai.ts";
import { buildApp } from "../src/app.ts";
import { type Exam, type ExamRegrade, type ExamStatus, type MarkingItem, type PracticeQuestion, UNRECOGNIZED_PAGE_PROMPT } from "../src/contracts.ts";
import { verifyArithmetic } from "../src/homework-arithmetic.ts";
import { generateVerifiedPractice } from "../src/practice-generation.ts";
import { Store } from "../src/store.ts";

const item: MarkingItem = {
	number: "1", prompt: "解方程 2x=6。", response: "x=2", verdict: "incorrect", maxScore: null, score: null,
	referenceAnswer: "x=3", rubric: "", feedback: "把答案代回等式左边检查。",
	skillId: "math.linear-equation", errorCause: "除法计算错误", page: 1, evidence: "答题第 1 行",
	difficulty: "standard", requiresReview: false,
};

const untaggedItem: MarkingItem = {
	...item, skillId: null, prompt: "把长 5 cm 的线段 AB 向右平移 4 cm。平移后线段长多少厘米？",
	response: "9", referenceAnswer: "5", feedback: "平移前后线段长度相等。", errorCause: "把平移距离加到线段原长",
};
const automaticRegion = { x: 100, y: 100, width: 500, height: 400 };
const geometryVariant = {
	prompt: "把长 7 cm 的线段 PQ 向上平移 3 cm。平移后线段长多少厘米？只填数值。",
	answer: "7", solution: "平移只改变位置，不改变线段长度，长度仍是 7 cm。",
};
const assessmentExamples = new Map([
	["math.signed-numbers", { prompt: "计算 (−4) × 3 + 7。", answer: "-5", solution: "−12 + 7 = −5。" }],
	["math.linear-equation", { prompt: "解方程 4(x − 3) = 20，只填 x 的值。", answer: "8", solution: "等式两边除以 4，得 x − 3 = 5，所以 x = 8。" }],
	["math.rational-equation", { prompt: "解方程 6/(x − 1) = 3，只填 x 的值。", answer: "3", solution: "限制 x ≠ 1。去分母得 6 = 3(x − 1)，解得 x = 3，符合限制。" }],
	["math.linear-function", { prompt: "一次函数 y = 3x + 2，当 x = 5 时 y 等于多少？", answer: "17", solution: "代入得 y = 3 × 5 + 2 = 17。" }],
]);

const tutor: Tutor = {
	available: true, visionAvailable: true,
	async mark({ attachments }) {
		assert.equal(attachments.length, 1);
		assert.ok(attachments[0].path.endsWith(".png"));
		return [
			{ ...untaggedItem, imageRegion: automaticRegion },
			{ ...item, number: "2", prompt: "计算 8−3。", response: "5", verdict: "correct", referenceAnswer: "5", errorCause: "" },
			{ ...item, number: "3", prompt: "补写等式右边。", response: "", verdict: "uncertain", requiresReview: true,
				referenceAnswer: "", errorCause: "", feedback: "右侧答题区不清楚。", imageRegion: automaticRegion },
		];
	},
	async generatePractice({ subject, mode, targets }) {
		assert.equal(subject, "math");
		if (mode === "review") {
			assert.deepEqual(targets.map(({ source }) => source), [
				{ prompt: untaggedItem.prompt, errorCause: untaggedItem.errorCause },
			]);
		} else {
			assert.ok(targets.every(({ source }) => source === undefined));
			assert.deepEqual(targets.map(({ skillId }) => skillId), [...assessmentExamples.keys()]);
			assert.ok(targets.every(({ difficulty, maxScore, responseType }) => difficulty === "standard" && maxScore === 1 && responseType === "exact"));
		}
		return targets.map(({ id, skillId, maxScore, responseType }) => {
			const example = mode === "review" ? geometryVariant : assessmentExamples.get(skillId);
			assert.ok(example);
			return { targetId: id, prompt: example.prompt, acceptedAnswers: responseType === "exact" ? [example.answer] : [],
				solution: example.solution, rubric: `答案正确得 ${maxScore} 分。` };
		});
	},
	async talk({ item: selected }, onText) {
		assert.equal(selected?.prompt, untaggedItem.prompt);
		onText("先比较平移前后线段的长度。");
	},
};

test("a clear arithmetic answer is checked independently of the model verdict", () => {
	const wrong = verifyArithmetic({ ...item, prompt: "计算 7 + 8。", response: "14", verdict: "correct",
		evidence: "学生作答：14", feedback: "7+8=15，学生答14错误" });
	assert.equal(wrong.verdict, "incorrect");
	assert.equal(wrong.score, null);
	assert.equal(wrong.maxScore, null);
	const correct = verifyArithmetic({ ...item, prompt: "计算 9 − 4。", response: "5", verdict: "incorrect",
		evidence: "学生作答：5" });
	assert.equal(correct.verdict, "correct");
	assert.equal(correct.score, null);
});

test("practice verification sees the question without the draft answer and rejects a disagreement", async () => {
	const source = { prompt: untaggedItem.prompt, errorCause: untaggedItem.errorCause, response: untaggedItem.response };
	const payloads: string[] = [];
	const generated = generateVerifiedPractice({ subject: "math", mode: "review", targets: [{
		id: "private-target", skillId: "math.private-skill", difficulty: "standard", maxScore: 1, responseType: "exact", source,
	}] }, async (_instructions, data) => {
		payloads.push(data);
		return payloads.length === 1
			? JSON.stringify({ questions: [{ targetId: "1", prompt: geometryVariant.prompt, acceptedAnswers: ["7"] }] })
			: JSON.stringify({ checks: [{ targetId: "1", valid: true, acceptedAnswers: ["10"],
				solution: "长度为 10 cm。", rubric: "答案正确得 1 分。" }] });
	});
	await assert.rejects(generated, /答案未通过独立核验/);
	const target = { targetId: "1", difficulty: "standard", maxScore: 1, grading: "固定答案",
		source: { prompt: source.prompt, errorCause: source.errorCause } };
	assert.deepEqual(payloads.map((payload) => JSON.parse(payload)), [
		{ subject: "数学", worksheetType: "错题复练", targets: [target] },
		{ subject: "数学", worksheetType: "错题复练", targets: [{ ...target, question: geometryVariant.prompt }] },
	]);
});

test("practice verification retains equivalent numeric answers and assignments", async () => {
	const responses = [
		{ questions: [{ targetId: "1", prompt: "解方程 2x = 3，只填写 x 的值。", acceptedAnswers: ["x = 3/2"] }] },
		{ checks: [{ targetId: "1", valid: true, solution: "两边除以 2，得 x = 1.5。",
			rubric: "答案正确得 1 分。", acceptedAnswers: ["1.5"] }] },
	];
	const [question] = await generateVerifiedPractice({ subject: "math", mode: "assessment", targets: [{
		id: "linear-equation", skillId: "math.linear-equation", difficulty: "standard", maxScore: 1, responseType: "exact",
	}] }, async () => JSON.stringify(responses.shift()));
	assert.deepEqual(question.acceptedAnswers, ["x = 3/2", "1.5"]);
});

test("configured reasoning level is sent in the Codex request", async (context) => {
	const claim = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake-account" } })).toString("base64");
	const credential = { type: "oauth" as const, access: `e30.${claim}.test`, refresh: "synthetic", expires: Date.now() + 3_600_000 };
	const credentials = {
		async read() { return credential; },
		async list() { return []; },
		async modify() { throw new Error("Unexpected token refresh"); },
		async delete() {},
	};
	const observed: string[] = [];
	context.mock.method(globalThis, "fetch", async (...args: Parameters<typeof fetch>) => {
		const request = new Request(...args);
		assert.equal(request.url, "https://chatgpt.com/backend-api/codex/responses");
		const bytes = Buffer.from(await request.arrayBuffer());
		const json = request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes;
		const body = JSON.parse(json.toString("utf8")) as { reasoning: { effort: string } };
		observed.push(body.reasoning.effort);
		return new Response('{"error":{"message":"synthetic response"}}', { status: 400, headers: { "Content-Type": "application/json" } });
	});
	const configuredTutor = createTutor({}, { credentials,
		active: { provider: "openai-codex", modelId: "gpt-6.1-sol", reasoningLevel: "high" } });
	await assert.rejects(configuredTutor.talk({ subject: "math", item: null,
		messages: [{ role: "user", content: "测试推理级别" }] }, () => {}, AbortSignal.timeout(5_000)));
	assert.deepEqual(observed, ["high"]);
});

test("each grading page has six minutes within the whole-paper deadline", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "hu-grading-timeout-test-"));
	const env = { TUTOR_DATA_DIR: directory, TUTOR_REVIEWER_PASSCODE: "test-reviewer-123",
		TUTOR_STUDENT_PASSCODE: "test-student-123", TUTOR_WEEKLY_ENABLED: "0", TUTOR_MODEL: "test-local",
		TUTOR_MODEL_VISION: "1", TUTOR_MODEL_STRUCTURED_GRADING: "1" };
	const app = await buildApp({ env, logger: false });
	const timeout = context.mock.method(AbortSignal, "timeout");
	const content = JSON.stringify({ items: [{ ...item, answerState: "present" }] });
	const chunk = JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] });
	const model = context.mock.method(globalThis, "fetch", async (...args: Parameters<typeof fetch>) => {
		assert.equal(new Request(...args).url, "http://127.0.0.1:11434/v1/chat/completions");
		return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
	});
	try {
		const login = await app.inject({ method: "POST", url: "/api/login",
			payload: { role: "student", passcode: env.TUTOR_STUDENT_PASSCODE } });
		assert.equal(login.statusCode, 200);
		const { name, value } = login.cookies[0];
		const headers = { cookie: `${name}=${value}` };
		const image = await sharp({ create: { width: 30, height: 30, channels: 3, background: "white" } }).png().toBuffer();
		const form = uploadForm([image, image]);
		const uploaded = await app.inject({ method: "POST", url: "/api/exams", payload: form.payload,
			headers: { ...headers, "content-type": form.type } });
		assert.equal(uploaded.statusCode, 202, uploaded.body);
		const url = `/api/exams/${uploaded.json<Exam>().id}`;
		const graded = await waitForPublished(async () => (await app.inject({ url, headers })).json<Exam>());
		assert.deepEqual(graded.items.map(({ page }) => page), [1, 2]);
		assert.equal(model.mock.callCount(), 2);
		assert.deepEqual(timeout.mock.calls.map(({ arguments: [ms] }) => ms), [840_000, 360_000, 360_000]);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("unscored homework is automatically marked and only confirmed incorrect work goes into the wrong book", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hu-study-test-"));
	const env = { TUTOR_DATA_DIR: directory, TUTOR_REVIEWER_PASSCODE: "test-reviewer-123",
		TUTOR_STUDENT_PASSCODE: "test-student-123", TUTOR_WEEKLY_ENABLED: "0", TUTOR_CODEX_AUTH_FILE: join(directory, "auth.json") };
	const app = await buildApp({ env, tutor, logger: false });
	try {
		const anonymous = await app.inject({ url: "/api/dashboard" });
		assert.equal(anonymous.statusCode, 401);
		const homepage = await app.inject({ url: "/" });
		assert.equal(homepage.statusCode, 200);
		assert.match(homepage.body, /沪学伴/);
		const reviewerLogin = await app.inject({ method: "POST", url: "/api/login",
			payload: { role: "reviewer", passcode: env.TUTOR_REVIEWER_PASSCODE } });
		const studentLogin = await app.inject({ method: "POST", url: "/api/login",
			payload: { role: "student", passcode: env.TUTOR_STUDENT_PASSCODE } });
		assert.equal(reviewerLogin.statusCode, 200);
		assert.equal(studentLogin.statusCode, 200);
		const reviewer = { cookie: reviewerLogin.cookies[0].name + "=" + reviewerLogin.cookies[0].value };
		const student = { cookie: studentLogin.cookies[0].name + "=" + studentLogin.cookies[0].value };
		const image = await sharp({ create: { width: 30, height: 30, channels: 3, background: "white" } }).png().toBuffer();
		const form = uploadForm([image]);
		const requestId = randomUUID();
		const upload = () => app.inject({ method: "POST", url: "/api/exams", payload: form.payload,
			headers: { ...student, "content-type": form.type, "idempotency-key": requestId } });
		const submitted = await upload();
		assert.equal(submitted.statusCode, 202, submitted.body);
		const { id } = submitted.json<Exam>();
		assert.equal((await upload()).json<Exam>().id, id);
		const base = `/api/exams/${id}`;
		const readExam = async (path: string) => (await app.inject({ url: path, headers: student })).json<Exam>();
		const marked = await waitForPublished(() => readExam(base));
		assert.deepEqual(marked.items.map(({ verdict }) => verdict), ["incorrect", "correct", "uncertain"]);
		assert.equal(marked.obtained, null);
		assert.equal(marked.possible, null);
		assert.ok(marked.items.every(({ score, maxScore }) => score === null && maxScore === null));
		assert.equal(marked.referenceText, "");
		const wrongItem = marked.items[0];
		const correctVerdict = (headers: typeof student, verdict: MarkingItem["verdict"], revision: number) => app.inject({
			method: "PUT", url: `${base}/grade`, headers, payload: { revision, items: [{ id: wrongItem.id, verdict }] },
		});
		assert.equal((await correctVerdict(student, "correct", marked.revision)).statusCode, 403);
		const dashboard = await app.inject({ url: "/api/dashboard", headers: student });
		assert.equal(dashboard.json().wrong.length, 1);
		assert.equal(dashboard.json().wrong[0].itemId, wrongItem.id);
		assert.equal(dashboard.json().wrong[0].sourcePage, 1);
		assert.equal(dashboard.json().wrong[0].hasScreenshot, true);
		const imageUrl = `${base}/items/${wrongItem.id}/image`;
		assert.equal((await app.inject({ url: imageUrl })).statusCode, 401);
		const screenshot = await app.inject({ url: imageUrl, headers: student });
		assert.equal(screenshot.statusCode, 200, screenshot.statusCode === 200 ? "" : screenshot.body);
		assert.equal(screenshot.headers["content-type"], "image/jpeg");
		const { width, height } = await sharp(screenshot.rawPayload).metadata();
		assert.deepEqual({ width, height }, { width: 15, height: 12 });
		assert.equal(dashboard.json().wrong[0].skillId, null);
		assert.equal(dashboard.json().exams.length, 1);
		assert.equal(dashboard.json().exams[0].correctCount, 1);
		assert.equal(dashboard.json().exams[0].incorrectCount, 1);
		assert.equal(dashboard.json().exams[0].uncertainCount, 1);
		assert.deepEqual(dashboard.json().trend, []);
		const generateReview = () => app.inject({ method: "POST", url: "/api/worksheets", headers: student,
			payload: { subject: "math", mode: "review" } });
		const paper = await generateReview();
		assert.equal(paper.statusCode, 201, paper.body);
		const corrected = await correctVerdict(reviewer, "correct", marked.revision);
		assert.equal(corrected.statusCode, 200, corrected.body);
		assert.deepEqual((await app.inject({ url: "/api/dashboard", headers: student })).json().wrong, []);
		assert.equal((await generateReview()).statusCode, 409);
		assert.equal((await correctVerdict(reviewer, "incorrect", marked.revision)).statusCode, 409);
		assert.equal((await correctVerdict(reviewer, "incorrect", corrected.json<Exam>().revision)).statusCode, 200);
		const crop = { page: 1, region: { x: 200, y: 300, width: 400, height: 300 } };
		const saveCrop = (headers: typeof student, payload = crop) => app.inject({ method: "PUT", url: imageUrl, headers, payload });
		assert.equal((await saveCrop(student)).statusCode, 403);
		assert.equal((await saveCrop(reviewer, { ...crop, region: { ...crop.region, x: 900 } })).statusCode, 400);
		const savedCrop = await saveCrop(reviewer);
		assert.equal(savedCrop.statusCode, 200, savedCrop.body);
		assert.deepEqual(savedCrop.json(), { page: 1, hasScreenshot: true });
		const manual = await app.inject({ url: imageUrl, headers: student });
		const manualSize = await sharp(manual.rawPayload).metadata();
		assert.deepEqual({ width: manualSize.width, height: manualSize.height }, { width: 12, height: 9 });
		const renderedPage = await app.inject({ url: `${imageUrl}?view=page`, headers: student });
		const pageSize = await sharp(renderedPage.rawPayload).metadata();
		assert.deepEqual({ width: pageSize.width, height: pageSize.height }, { width: 30, height: 30 });
		const [, correctItem, uncertainItem] = marked.items;
		const uncertainImageUrl = `${base}/items/${uncertainItem.id}/image`;
		assert.equal((await app.inject({ url: `${uncertainImageUrl}?view=page` })).statusCode, 401);
		const uncertainImage = await app.inject({ url: uncertainImageUrl, headers: student });
		assert.equal(uncertainImage.statusCode, 200);
		assert.equal(uncertainImage.headers["content-type"], "image/jpeg");
		const uncertainSize = await sharp(uncertainImage.rawPayload).metadata();
		assert.deepEqual({ width: uncertainSize.width, height: uncertainSize.height }, { width: 15, height: 12 });
		const uncertainPage = await app.inject({ url: `${uncertainImageUrl}?view=page`, headers: reviewer });
		assert.equal(uncertainPage.statusCode, 200);
		assert.deepEqual(uncertainPage.rawPayload, renderedPage.rawPayload);
		assert.equal((await app.inject({ method: "PUT", url: uncertainImageUrl, headers: reviewer, payload: crop })).statusCode, 404);
		assert.equal((await app.inject({ url: `${base}/items/${correctItem.id}/image?view=page`, headers: reviewer })).statusCode, 404);
		const chat = await app.inject({ method: "POST", url: "/api/tutor", headers: student, payload: {
			subject: "math", examId: id, itemId: wrongItem.id, messages: [{ role: "user", content: "我错在哪里？" }],
		} });
		assert.equal(chat.statusCode, 200);
		assert.match(chat.body, /event: delta\ndata: .*平移前后/);
		assert.match(chat.body, /event: done/);
		const practice = await app.inject({ method: "POST", url: "/api/worksheets", headers: student,
			payload: { subject: "math", mode: "assessment" } });
		assert.equal(practice.statusCode, 201, practice.body);
		const worksheet = `/api/worksheets/${practice.json().id}`;
		assert.equal((await app.inject({ url: `${worksheet}/pdf/solutions`, headers: student })).statusCode, 403);
		const pdf = await app.inject({ url: `${worksheet}/pdf/student`, headers: student });
		assert.equal(pdf.statusCode, 200, pdf.statusCode === 200 ? "" : pdf.body);
		assert.equal(pdf.rawPayload.subarray(0, 5).toString(), "%PDF-");
		assert.match(String(pdf.headers["content-disposition"]), /^inline;/);
		const { questions } = (await app.inject({ url: worksheet, headers: student })).json<{ questions: PracticeQuestion[] }>();
		assert.equal(questions.length, assessmentExamples.size);
		assert.equal("acceptedAnswers" in questions[0], false);
		const attempt = () => app.inject({ method: "POST", url: `${worksheet}/attempts`, headers: student, payload: {
			assisted: false, responses: questions.map((q) => ({ questionId: q.id, response: "" })),
		} });
		assert.equal((await attempt()).statusCode, 200);
		assert.equal((await attempt()).statusCode, 409);
		const result = (await app.inject({ url: "/api/dashboard", headers: student })).json();
		assert.equal(result.trend[0].total, questions.length);
		assert.equal(result.trend[0].correct, 0);
		assert.equal((await app.inject({ url: `${worksheet}/pdf/solutions`, headers: student })).statusCode, 200);
		const { id: paperId, title: paperTitle } = paper.json<{ id: string; title: string }>();
		const paperPath = `/api/worksheets/${paperId}`;
		const reviewDetail = (await app.inject({ url: paperPath, headers: student })).json<{ questions: PracticeQuestion[] }>();
		assert.deepEqual(reviewDetail.questions.map(({ prompt }) => prompt), [geometryVariant.prompt]);
		assert.equal((await app.inject({ url: `${paperPath}/pdf/solutions`, headers: student })).statusCode, 403);
		assert.equal((await app.inject({ url: `${paperPath}/pdf/solutions?download=1`, headers: student })).statusCode, 403);
		const download = await app.inject({ url: `${paperPath}/pdf/student?download=1`, headers: student });
		assert.equal(download.statusCode, 200, download.statusCode === 200 ? "" : download.body);
		assert.equal(download.headers["content-type"], "application/pdf");
		assert.equal(download.headers["content-disposition"], `attachment; filename*=UTF-8''${encodeURIComponent(`${paperTitle}.pdf`)}`);
		assert.equal(download.rawPayload.subarray(0, 5).toString(), "%PDF-");
		const paperForm = uploadForm([image], paperId);
		const paperUpload = await app.inject({ method: "POST", url: "/api/exams", payload: paperForm.payload,
			headers: { ...student, "content-type": paperForm.type } });
		assert.equal(paperUpload.statusCode, 202, paperUpload.body);
		const linked = (await app.inject({ url: paperPath, headers: student })).json();
		assert.equal(linked.paperExam.id, paperUpload.json().id);
		assert.equal((await app.inject({ method: "POST", url: `${paperPath}/attempts`, headers: student,
			payload: { assisted: false, responses: linked.questions.map((q: PracticeQuestion) => ({ questionId: q.id, response: "" })) },
		})).statusCode, 409);
		await waitForPublished(() => readExam(`/api/exams/${linked.paperExam.id}`));
		assert.equal((await app.inject({ url: `${paperPath}/pdf/solutions`, headers: student })).statusCode, 200);
		const duplicatePaper = await app.inject({ method: "POST", url: "/api/exams", payload: paperForm.payload,
			headers: { ...student, "content-type": paperForm.type } });
		assert.equal(duplicatePaper.statusCode, 409);

		const deleteRecord = (url: string, headers: typeof student) => app.inject({ method: "DELETE", url, headers });
		assert.equal((await deleteRecord(base, student)).statusCode, 403);
		assert.equal((await deleteRecord(paperPath, student)).statusCode, 403);
		assert.equal((await deleteRecord(paperPath, reviewer)).statusCode, 204);
		assert.equal((await app.inject({ url: `${paperPath}/pdf/student`, headers: student })).statusCode, 404);
		const detached = await readExam(`/api/exams/${linked.paperExam.id}`);
		assert.equal(detached.worksheetId, null);
		assert.equal(detached.status, "published");
		assert.equal((await deleteRecord(worksheet, reviewer)).statusCode, 204);
		const attachment = marked.attachments[0].id;
		assert.equal((await deleteRecord(base, reviewer)).statusCode, 204);
		assert.equal((await deleteRecord(base, reviewer)).statusCode, 404);
		assert.equal((await app.inject({ url: `${base}/attachments/${attachment}`, headers: student })).statusCode, 404);
		assert.ok((await readdir(join(directory, "attachments"))).every((name) => !name.startsWith(attachment)));
		const afterDelete = (await app.inject({ url: "/api/dashboard", headers: student })).json();
		assert.deepEqual(afterDelete.exams.map(({ id }: { id: string }) => id), [detached.id]);
		assert.ok(afterDelete.wrong.every(({ examId }: { examId: string }) => examId === detached.id));
		assert.deepEqual(afterDelete.trend, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("reviewer can regrade original attachments and publish partial results with differences", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hu-regrade-test-"));
	const env = { TUTOR_DATA_DIR: directory, TUTOR_REVIEWER_PASSCODE: "test-reviewer-123",
		TUTOR_STUDENT_PASSCODE: "test-student-123", TUTOR_WEEKLY_ENABLED: "0", TUTOR_CODEX_AUTH_FILE: join(directory, "auth.json"),
		TUTOR_MODEL: "test-local" };
	let markCalls = 0;
	const regrade = Promise.withResolvers<void>();
	const previous = { ...item, number: "23(2)", maxScore: 2, score: 0 };
	const retained = { ...item, number: "24", page: 2, prompt: "计算 3 + 4。", response: "7", verdict: "correct" as const };
	const pageIssue = "模型返回的批改结果不完整。";
	const offlineTutor: Tutor = { ...tutor, async mark({ attachments }) {
		assert.equal(attachments.length, 1);
		assert.ok(attachments[0].path.endsWith(".png"));
		markCalls++;
		if (markCalls === 1) throw new Error("Temporary provider failure");
		if (markCalls === 2) return [previous, retained];
		await regrade.promise;
		return [
			{ ...previous, number: "23.2", verdict: "uncertain", score: null, requiresReview: true },
			{ ...item, number: "25", prompt: "解方程 5x=20。", response: "x=2", referenceAnswer: "x=4" },
			{ ...item, number: "第 2 页", page: 2, prompt: UNRECOGNIZED_PAGE_PROMPT, verdict: "uncertain",
				response: "", feedback: pageIssue, requiresReview: true },
		];
	} };
	const app = await buildApp({ env, tutor: offlineTutor, logger: false });
	try {
		const login = async (role: "student" | "reviewer", passcode: string) => {
			const response = await app.inject({ method: "POST", url: "/api/login", payload: { role, passcode } });
			assert.equal(response.statusCode, 200);
			const { name, value } = response.cookies[0];
			return { cookie: `${name}=${value}` };
		};
		const reviewer = await login("reviewer", env.TUTOR_REVIEWER_PASSCODE);
		const student = await login("student", env.TUTOR_STUDENT_PASSCODE);
		const configuration = "/api/model-settings";
		assert.equal((await app.inject({ url: configuration, headers: student })).statusCode, 403);
		assert.equal((await app.inject({ method: "PUT", url: configuration, headers: student,
			payload: { provider: "local", modelId: "another-model" } })).statusCode, 403);
		const initial = (await app.inject({ url: configuration, headers: reviewer })).json();
		assert.equal(initial.provider, "local");
		assert.equal(initial.modelId, "test-local");
		assert.equal(initial.codexAuth, "required");
		assert.equal(initial.reasoningLevel, null);
		assert.equal(initial.codexReasoningLevel, "low");
		assert.ok(initial.codexModels.find(({ id }: { id: string }) => id === initial.codexDefaultModelId).reasoningLevels.includes("high"));
		const image = await sharp({ create: { width: 30, height: 30, channels: 3, background: "white" } }).png().toBuffer();
		const form = uploadForm([image]);
		const uploaded = await app.inject({ method: "POST", url: "/api/exams", payload: form.payload,
			headers: { ...student, "content-type": form.type } });
		assert.equal(uploaded.statusCode, 202, uploaded.body);
		const url = `/api/exams/${uploaded.json<Exam>().id}`;
		const readExam = async () => (await app.inject({ url, headers: student })).json<Exam & { regrade: ExamRegrade | null }>();
		const failed = await waitForStatus(readExam, "failed");
		assert.equal(failed.hasPublishedResult, false);
		const badModel = await app.inject({ method: "PUT", url: configuration, headers: reviewer,
			payload: { provider: "openai-codex", modelId: "unknown-codex-model" } });
		assert.equal(badModel.statusCode, 422);
		const codexSelection = await app.inject({ method: "PUT", url: configuration, headers: reviewer,
			payload: { provider: "openai-codex", modelId: initial.codexDefaultModelId, reasoningLevel: "high" } });
		assert.equal(codexSelection.statusCode, 200, codexSelection.body);
		assert.equal(codexSelection.json().reasoningLevel, "high");
		assert.equal(codexSelection.json().visionAvailable, false);
		assert.equal((await app.inject({ method: "PUT", url: configuration, headers: reviewer,
			payload: { provider: "openai-codex", modelId: initial.codexDefaultModelId, reasoningLevel: "unsupported" } })).statusCode, 400);
		const needsAuth = await app.inject({ method: "POST", url: `${url}/retry`, headers: reviewer });
		assert.equal(needsAuth.statusCode, 409);
		assert.equal(needsAuth.json().code, "CODEX_AUTH_REQUIRED");
		const localSelection = await app.inject({ method: "PUT", url: configuration, headers: reviewer,
			payload: { provider: "local", modelId: "updated-model" } });
		assert.equal(localSelection.statusCode, 200, localSelection.body);
		assert.equal(localSelection.json().modelId, "updated-model");
		assert.equal(localSelection.json().reasoningLevel, null);
		assert.equal(localSelection.json().codexReasoningLevel, "high");
		const persisted = new Store(join(directory, "study.sqlite"));
		try {
			assert.equal(persisted.getModelSettings()?.localModelId, "updated-model");
			assert.equal(persisted.getModelSettings()?.provider, "local");
			assert.equal(persisted.getModelSettings()?.codexReasoningLevel, "high");
		} finally {
			persisted.close();
		}
		assert.equal((await app.inject({ method: "POST", url: `${url}/retry`, headers: student })).statusCode, 403);
		assert.equal((await app.inject({ method: "POST", url: `${url}/retry`, headers: reviewer })).statusCode, 200);
		const published = await waitForPublished(readExam);
		assert.equal(published.possible, 2);
		assert.deepEqual(published.attachments, failed.attachments);
		const ignore = await app.inject({ method: "PUT", url: `${url}/grade`, headers: reviewer,
			payload: { revision: published.revision, items: [{ id: published.items[0].id, ignored: true }] } });
		assert.equal(ignore.statusCode, 200, ignore.body);
		const ignored = ignore.json<Exam>();
		const unconfirmed = await app.inject({ method: "POST", url: `${url}/retry`, headers: reviewer });
		assert.equal(unconfirmed.statusCode, 409);
		assert.equal(unconfirmed.json().code, "REGRADE_CONFIRMATION_REQUIRED");
		const retry = () => app.inject({ method: "POST", url: `${url}/retry`, headers: reviewer,
			payload: { confirmPublished: true } });
		assert.equal((await retry()).statusCode, 200);
		assert.equal((await retry()).statusCode, 409);
		const inProgress = await readExam();
		assert.equal(inProgress.hasPublishedResult, true);
		assert.deepEqual(inProgress.items, ignored.items);
		assert.equal((await app.inject({ method: "DELETE", url, headers: reviewer })).statusCode, 409);
		regrade.resolve();
		await waitForPublished(readExam);
		const updated = await readExam();
		assert.equal(updated.error, null);
		assert.equal(updated.possible, null);
		assert.deepEqual(updated.items.map(({ number, verdict }) => ({ number, verdict })), [
			{ number: "23.2", verdict: "uncertain" },
			{ number: "25", verdict: "incorrect" },
			{ number: "24", verdict: "correct" },
		]);
		assert.equal(updated.items[0].id, published.items[0].id);
		assert.equal(updated.items[0].ignored, true);
		assert.deepEqual(updated.items[2], published.items[1]);
		const diff = updated.regrade;
		assert.ok(diff);
		assert.equal(diff.newItemCount, 2);
		assert.equal(diff.retainedItemCount, 1);
		assert.deepEqual(diff.pageIssues, [{ page: 2, message: pageIssue }]);
		assert.deepEqual(diff.changes.map(({ kind }) => kind), ["changed", "added", "retained"]);
		const [change] = diff.changes;
		assert.equal(change.kind, "changed");
		assert.deepEqual(change.before, { verdict: "incorrect", score: 0, maxScore: 2 });
		assert.deepEqual(change.after, { verdict: "uncertain", score: null, maxScore: 2 });
		const history = new Store(join(directory, "study.sqlite"));
		try {
			assert.deepEqual(history.getExamRegrade(updated.id), diff);
		} finally {
			history.close();
		}
		const dashboard = (await app.inject({ url: "/api/dashboard", headers: student })).json();
		assert.deepEqual(dashboard.wrong.map(({ itemId }: { itemId: string }) => itemId), [updated.items[1].id]);
	} finally {
		regrade.resolve();
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("reviewer can ignore and restore a wrong answer without changing its grade", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hu-ignore-test-"));
	const env = { TUTOR_DATA_DIR: directory, TUTOR_REVIEWER_PASSCODE: "test-reviewer-123",
		TUTOR_STUDENT_PASSCODE: "test-student-123", TUTOR_WEEKLY_ENABLED: "0", TUTOR_CODEX_AUTH_FILE: join(directory, "auth.json") };
	const now = new Date().toISOString();
	const exam: Exam = { id: randomUUID(), title: "忽略错题样例", subject: "math", status: "review", error: null,
		createdAt: now, updatedAt: now, obtained: null, possible: null, worksheetId: null,
		revision: 0, referenceText: "", attachments: [], items: [] };
	const wrong = { ...untaggedItem, id: randomUUID(), score: 0, maxScore: 2 };
	const app = await buildApp({ env, tutor, logger: false });
	try {
		const store = new Store(join(directory, "study.sqlite"));
		try {
			assert.ok(store.createExam(exam, randomUUID()));
			assert.ok(store.saveGrade(exam, { status: "published", referenceText: "", items: [wrong], obtained: 0, possible: 2 }));
		} finally {
			store.close();
		}
		const login = async (role: "student" | "reviewer", passcode: string) => {
			const response = await app.inject({ method: "POST", url: "/api/login", payload: { role, passcode } });
			assert.equal(response.statusCode, 200);
			const { name, value } = response.cookies[0];
			return { cookie: `${name}=${value}` };
		};
		const reviewer = await login("reviewer", env.TUTOR_REVIEWER_PASSCODE);
		const student = await login("student", env.TUTOR_STUDENT_PASSCODE);
		const url = `/api/exams/${exam.id}`;
		const published = (await app.inject({ url, headers: reviewer })).json<Exam>();
		const update = (headers: typeof reviewer, revision: number, change: { ignored: boolean; verdict?: MarkingItem["verdict"] }) =>
			app.inject({ method: "PUT", url: `${url}/grade`, headers,
				payload: { revision, items: [{ id: wrong.id, ...change }] } });
		const readWrongIds = async () => (await app.inject({ url: "/api/dashboard", headers: student }))
			.json<{ wrong: { itemId: string }[] }>().wrong.map(({ itemId }) => itemId);
		const generateReview = (wrongIds?: string[]) => app.inject({ method: "POST", url: "/api/worksheets", headers: student,
			payload: { subject: "math", mode: "review", wrongIds } });
		assert.deepEqual(await readWrongIds(), [wrong.id]);
		assert.equal((await update(student, published.revision, { ignored: true })).statusCode, 403);
		const ignored = await update(reviewer, published.revision, { ignored: true });
		assert.equal(ignored.statusCode, 200, ignored.body);
		const ignoredExam = ignored.json<Exam>();
		assert.deepEqual(ignoredExam.items, [{ ...wrong, ignored: true }]);
		assert.equal(ignoredExam.obtained, 0);
		assert.equal(ignoredExam.possible, 2);
		assert.deepEqual(await readWrongIds(), []);
		assert.equal((await generateReview()).statusCode, 409);
		const selection = [`${exam.id}:${wrong.id}`];
		assert.equal((await generateReview(selection)).statusCode, 409);
		const restored = await update(reviewer, ignoredExam.revision, { verdict: "incorrect", ignored: false });
		assert.equal(restored.statusCode, 200, restored.body);
		assert.equal(restored.json<Exam>().items[0].score, 0);
		assert.deepEqual(await readWrongIds(), [wrong.id]);
		const worksheet = await generateReview(selection);
		assert.equal(worksheet.statusCode, 201, worksheet.body);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("an incomplete model result is never published and generation can be retried", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hu-generation-test-"));
	const env = { TUTOR_DATA_DIR: directory, TUTOR_REVIEWER_PASSCODE: "test-reviewer-123",
		TUTOR_STUDENT_PASSCODE: "test-student-123", TUTOR_WEEKLY_ENABLED: "0", TUTOR_CODEX_AUTH_FILE: join(directory, "auth.json") };
	let complete = false;
	const failingTutor: Tutor = { ...tutor, generatePractice: async (input, signal) => complete ? tutor.generatePractice(input, signal) : [] };
	const app = await buildApp({ env, tutor: failingTutor, logger: false });
	try {
		const login = await app.inject({ method: "POST", url: "/api/login",
			payload: { role: "student", passcode: env.TUTOR_STUDENT_PASSCODE } });
		const { name, value } = login.cookies[0];
		const headers = { cookie: `${name}=${value}` };
		const generate = () => app.inject({ method: "POST", url: "/api/worksheets", headers,
			payload: { subject: "math", mode: "assessment" } });
		const broken = await generate();
		assert.equal(broken.statusCode, 502, broken.body);
		assert.deepEqual((await app.inject({ url: "/api/dashboard", headers })).json().worksheets, []);
		complete = true;
		const retried = await generate();
		assert.equal(retried.statusCode, 201, retried.body);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("manual review uses all eleven selected records in order across model batches", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hu-review-selection-test-"));
	const env = { TUTOR_DATA_DIR: directory, TUTOR_REVIEWER_PASSCODE: "test-reviewer-123",
		TUTOR_STUDENT_PASSCODE: "test-student-123", TUTOR_WEEKLY_ENABLED: "0", TUTOR_CODEX_AUTH_FILE: join(directory, "auth.json") };
	const now = new Date().toISOString();
	const exam: Exam = { id: randomUUID(), title: "错题选择样例", subject: "math", status: "review", error: null,
		createdAt: now, updatedAt: now, obtained: null, possible: null, worksheetId: null,
		revision: 0, referenceText: "", attachments: [], items: [] };
	const items = Array.from({ length: 11 }, (_, index) => ({ ...untaggedItem, id: randomUUID(), number: String(index + 1),
		prompt: `把边长 ${Math.max(1, index)} cm 的线段向右平移 4 cm，求平移后的长度。` }));
	const batchSizes: number[] = [];
	const sourcePrompts: string[] = [];
	const selectionTutor: Tutor = { ...tutor, async generatePractice({ subject, mode, targets }) {
		assert.equal(subject, "math");
		assert.equal(mode, "review");
		batchSizes.push(targets.length);
		return targets.map(({ id, source }) => {
			assert.ok(source);
			sourcePrompts.push(source.prompt);
			return { targetId: id, prompt: `将长 ${sourcePrompts.length + 20} cm 的线段向上平移后，线段长度是多少？`,
				acceptedAnswers: [], solution: "平移保持长度。", rubric: "正确说明长度及原因。" };
		});
	} };
	const app = await buildApp({ env, tutor: selectionTutor, logger: false });
	try {
		const store = new Store(join(directory, "study.sqlite"));
		try {
			assert.ok(store.createExam(exam, randomUUID()));
			assert.ok(store.saveGrade(exam, { status: "published", referenceText: "", items, obtained: null, possible: null }));
		} finally {
			store.close();
		}
		const login = await app.inject({ method: "POST", url: "/api/login",
			payload: { role: "student", passcode: env.TUTOR_STUDENT_PASSCODE } });
		const { name, value } = login.cookies[0];
		const headers = { cookie: `${name}=${value}` };
		const selected = items.toReversed();
		const wrongIds = selected.map(({ id }) => `${exam.id}:${id}`);
		const request = (ids: string[], mode = "review") => app.inject({ method: "POST", url: "/api/worksheets", headers,
			payload: { subject: "math", mode, wrongIds: ids } });
		assert.equal((await request([])).statusCode, 400);
		assert.equal((await request([wrongIds[0], wrongIds[0]])).statusCode, 400);
		assert.equal((await request(wrongIds, "assessment")).statusCode, 400);
		const sheet = await request(wrongIds);
		assert.equal(sheet.statusCode, 201, sheet.body);
		assert.equal(sheet.json().questionCount, 11);
		assert.deepEqual(batchSizes, [6, 5]);
		assert.deepEqual(sourcePrompts, selected.map(({ prompt }) => prompt));
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("due weekly worksheet is generated once across a service restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hu-weekly-test-"));
	const env = { TUTOR_DATA_DIR: directory, TUTOR_REVIEWER_PASSCODE: "test-reviewer-123",
		TUTOR_STUDENT_PASSCODE: "test-student-123", TUTOR_CODEX_AUTH_FILE: join(directory, "auth.json") };
	let generationCalls = 0;
	const weeklyTutor: Tutor = { ...tutor, async generatePractice(input, signal) {
		generationCalls++;
		return tutor.generatePractice(input, signal);
	} };
	try {
		const store = new Store(join(directory, "study.sqlite"));
		try {
			const createdAt = new Date(Date.now() - 16 * 86_400_000).toISOString();
			const exam: Exam = { id: randomUUID(), title: "较早的批改", subject: "math", status: "review",
				error: null, createdAt, updatedAt: createdAt, obtained: null, possible: null, worksheetId: null,
				revision: 0, referenceText: "", attachments: [], items: [] };
			assert.ok(store.createExam(exam, randomUUID()));
			assert.ok(store.saveGrade(exam, { status: "published", referenceText: exam.referenceText,
				items: [{ ...untaggedItem, id: randomUUID() }], obtained: null, possible: null }));
		} finally {
			store.close();
		}
		let generatedId: string | undefined;
		for (let boot = 0; boot < 2; boot++) {
			const app = await buildApp({ env, tutor: weeklyTutor, logger: false });
			try {
				const login = await app.inject({ method: "POST", url: "/api/login",
					payload: { role: "student", passcode: env.TUTOR_STUDENT_PASSCODE } });
				const { name, value } = login.cookies[0];
				const readWorksheets = async () => (await app.inject({ url: "/api/dashboard", headers: { cookie: `${name}=${value}` } }))
					.json<{ worksheets: { id: string; mode: string }[] }>().worksheets;
				let worksheets = await readWorksheets();
				for (let iteration = 0; !worksheets.length && iteration < 50; iteration++) {
					await delay(40);
					worksheets = await readWorksheets();
				}
				assert.equal(worksheets.length, 1);
				assert.equal(worksheets[0].mode, "review");
				if (generatedId) assert.equal(worksheets[0].id, generatedId);
				generatedId = worksheets[0].id;
			} finally {
				await app.close();
			}
		}
		assert.equal(generationCalls, 1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

function uploadForm(images: Buffer[], worksheetId?: string): { payload: Buffer; type: string } {
	const boundary = `form-${randomUUID()}`;
	const fields = { subject: "math", title: "数学批改样例",
		...(worksheetId ? { worksheetId } : {}) };
	const text = Object.entries(fields).map(([key, value]) =>
		`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`).join("");
	const files = images.flatMap((image, index) => [
		Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="scan-${index + 1}.png"\r\nContent-Type: image/png\r\n\r\n`),
		image, Buffer.from("\r\n"),
	]);
	return { type: `multipart/form-data; boundary=${boundary}`, payload: Buffer.concat([
		Buffer.from(text), ...files, Buffer.from(`--${boundary}--\r\n`),
	]) };
}

function waitForPublished(readExam: () => Promise<Exam>): Promise<Exam> {
	return waitForStatus(readExam, "published");
}

async function waitForStatus(readExam: () => Promise<Exam>, status: ExamStatus): Promise<Exam> {
	for (let iteration = 0; iteration < 25; iteration++) {
		const exam = await readExam();
		if (exam.status === status) return exam;
		assert.notEqual(exam.status, "failed", exam.error ?? "");
		await delay(40);
	}
	throw new Error(`Automatic marking did not enter ${status}.`);
}
