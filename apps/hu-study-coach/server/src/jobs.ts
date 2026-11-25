import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { gradingPageTimeoutMs, type Tutor } from "./ai.ts";
import { shanghaiDate } from "./analytics.ts";
import type { Subject } from "./contracts.ts";
import { MAX_PAGES } from "./exam-pages.ts";
import { compareRegrade } from "./exam-regrade.ts";
import { confirmedScore, examScores, matchWorksheetItem } from "./exam-results.ts";
import { HttpError } from "./http.ts";
import { getSkills } from "./practice.ts";
import type { Store } from "./store.ts";
import { TutorError } from "./tutor-error.ts";
import type { WorksheetGeneration } from "./worksheet-generation.ts";

const subjects: Subject[] = ["chinese", "math", "english"];
const dayMs = 86_400_000;
const gradingPageOverheadMs = 60_000;
const leaseHeartbeatMs = 60_000;
const weeklyCheckMs = 5 * 60_000;

export function createJobs(store: Store, getTutor: () => Tutor, logger: FastifyBaseLogger, attachmentsDir: string,
	weekly: WorksheetGeneration | null) {
	const shutdown = new AbortController();
	let active: Promise<void> | null = null;
	let scheduled: Promise<void> | null = null;
	let timer: ReturnType<typeof setInterval> | undefined;
	let nextScheduleCheck = 0;

	async function tick(): Promise<void> {
		while (!shutdown.signal.aborted) {
			const claimed = store.claimExam(new Date());
			if (!claimed) break;
			const { exam, leaseId } = claimed;
			const tutor = getTutor();
			if (!tutor.visionAvailable) {
				store.finishExam(exam.id, leaseId, { status: "review", items: exam.items,
					error: "自动批改需要支持图片输入的模型。模型配置完成后可以重新批改。" });
				continue;
			}
			// A PDF can contain multiple pages even when it is the only uploaded file.
			const pageBudget = exam.attachments.some(({ mimeType }) => mimeType === "application/pdf")
				? MAX_PAGES : Math.min(MAX_PAGES, Math.max(1, exam.attachments.length));
			// Allow time for authorization, rendering and saving in addition to model requests.
			const deadline = AbortSignal.timeout((gradingPageTimeoutMs + gradingPageOverheadMs) * pageBudget);
			const leaseLost = new AbortController();
			const heartbeat = setInterval(() => {
				try {
					if (store.renewExamLease(exam.id, leaseId, new Date())) return;
				} catch {
					logger.warn({ examId: exam.id }, "Could not renew grading lease");
				}
				clearInterval(heartbeat);
				leaseLost.abort();
			}, leaseHeartbeatMs);
			heartbeat.unref();
			const signal = AbortSignal.any([shutdown.signal, deadline, leaseLost.signal]);
			try {
				const drafts = await tutor.mark({ ...exam, attachments: exam.attachments.map((attachment) => ({ ...attachment,
					path: join(attachmentsDir, attachment.path) })) }, signal);
				signal.throwIfAborted();
				const skills = new Set(getSkills(exam.subject).map(({ id }) => id));
				const worksheet = exam.worksheetId ? store.getWorksheet(exam.worksheetId)?.worksheet : undefined;
				const items = drafts.map((draft) => {
					const item = worksheet ? matchWorksheetItem(draft, worksheet) : draft;
					return { ...item, id: randomUUID(), score: confirmedScore(item), requiresReview: item.verdict === "uncertain",
						imageSource: item.imageRegion ? "automatic" as const : undefined,
						skillId: item.skillId && (item !== draft || skills.has(item.skillId)) ? item.skillId : null };
				});
				if (exam.hasPublishedResult) {
					const { items: merged, ...regrade } = compareRegrade(exam.items, items);
					store.finishExam(exam.id, leaseId, { status: "published", items: merged, error: null, ...examScores(merged), regrade });
				} else if (items.length) {
					store.finishExam(exam.id, leaseId, { status: "published", items, error: null, ...examScores(items) });
				} else {
					store.finishExam(exam.id, leaseId, { status: "failed", error: "没有识别到可批改的题目，请核对原图后重试。" });
				}
			} catch (error) {
				if (leaseLost.signal.aborted) continue;
				if (shutdown.signal.aborted) {
					store.finishExam(exam.id, leaseId, { status: "queued", error: null });
				} else {
					logger.warn({ examId: exam.id, reason: error instanceof Error ? error.name : "provider" }, "Marking stopped");
					const message = deadline.aborted ? "自动批改超时。可分批上传，或稍后重试。"
						: error instanceof TutorError ? error.message : "自动批改失败，请重试。";
					store.finishExam(exam.id, leaseId, { status: "failed", error: message });
				}
			} finally {
				clearInterval(heartbeat);
			}
		}
	}

	function wake(): void {
		if (shutdown.signal.aborted) return;
		if (!active) active = tick().catch(() => logger.error("Could not process tutor jobs")).finally(() => { active = null; });
		if (!weekly || scheduled || Date.now() < nextScheduleCheck) return;
		scheduled = fillWeeklyWorksheets(weekly, new Date(), shutdown.signal, logger)
			.catch(() => logger.error("Could not schedule weekly worksheets"))
			.finally(() => {
				nextScheduleCheck = Date.now() + weeklyCheckMs;
				scheduled = null;
			});
	}

	return {
		start() {
			timer = setInterval(wake, 1_000);
			timer.unref();
			wake();
		},
		wake,
		async stop() {
			shutdown.abort();
			clearInterval(timer);
			await Promise.all([active, scheduled]);
		},
	};
}

async function fillWeeklyWorksheets(weekly: WorksheetGeneration, now: Date, signal: AbortSignal, logger: FastifyBaseLogger): Promise<void> {
	const localToday = shanghaiDate(now);
	const afternoon = new Date(`${localToday}T19:00:00+08:00`);
	const weekday = new Date(`${localToday}T00:00:00Z`).getUTCDay();
	const daysSince = weekday === 0 && now < afternoon ? 7 : weekday;
	const dueBy = new Date(afternoon.getTime() - daysSince * dayMs);
	const period = shanghaiDate(dueBy);
	for (const subject of subjects) {
		if (signal.aborted) return;
		try {
			await weekly.generate(subject, "review", signal, { key: `${subject}:${period}`, dueBy });
		} catch (error) {
			if (signal.aborted || error instanceof HttpError && error.statusCode === 429) return;
			logger.warn({ subject, code: error instanceof HttpError ? error.statusCode : 500 }, "Weekly worksheet generation failed");
		}
	}
}
