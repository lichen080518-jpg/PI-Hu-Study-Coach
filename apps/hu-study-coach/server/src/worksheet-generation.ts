import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Tutor } from "./ai.ts";
import { analyze, shanghaiDate } from "./analytics.ts";
import { SUBJECT_LABELS, type PracticeDraft, type PracticeTarget, type Subject, type Worksheet, type Wrong } from "./contracts.ts";
import { HttpError } from "./http.ts";
import { materializePractice, PRACTICE_BATCH_SIZE, selectPracticeTargets } from "./practice.ts";
import type { Store } from "./store.ts";
import { TutorError } from "./tutor-error.ts";

interface WorksheetSchedule {
	key: string;
	dueBy: Date;
}

type WorksheetSource = WorksheetSchedule | { wrongIds: readonly string[] };

const generationBatchTimeoutMs = 150_000;

export function createWorksheetGeneration(store: Store, getTutor: () => Tutor, logger: FastifyBaseLogger) {
	const shutdown = new AbortController();
	let active: Promise<Worksheet | null> | null = null;

	async function generate(
		subject: Subject, mode: Worksheet["mode"], cancellation: AbortSignal, source?: WorksheetSource,
	): Promise<Worksheet | null> {
		if (active) throw new HttpError(429, "正在生成另一份练习卷，请稍后再试。");
		active = generateWorksheet(subject, mode, cancellation, source).finally(() => { active = null; });
		return active;
	}

	async function generateWorksheet(
		subject: Subject, mode: Worksheet["mode"], cancellation: AbortSignal, source: WorksheetSource | undefined,
	): Promise<Worksheet | null> {
		const signal = AbortSignal.any([shutdown.signal, cancellation]);
		checkGenerationActive(signal);
		const schedule = source && "key" in source ? source : undefined;
		if (schedule && store.hasScheduledWorksheet(schedule.key)) return null;

		const now = new Date();
		const records = store.listWorksheets();
		const { wrong } = mode === "review" ? analyze(store.listExams(), records) : { wrong: [] };
		const selected = source && "wrongIds" in source ? selectWrong(wrong, subject, source.wrongIds) : undefined;
		const dueBy = schedule?.dueBy.toISOString();
		const targets = selectPracticeTargets({
			subject, mode, now, worksheets: records.map(({ worksheet }) => worksheet),
			wrong: dueBy ? wrong.filter(({ dueAt }) => dueAt !== null && dueAt <= dueBy) : wrong, selectedWrong: selected,
		});
		if (targets.length === 0) return null;
		const tutor = getTutor();
		if (!tutor.available) throw new HttpError(503, "请先在模型设置中配置可用的出题模型。");

		const drafts = await generateBatches(tutor, subject, mode, targets, signal);
		checkGenerationActive(signal);

		const latest = store.listWorksheets();
		if (mode === "review") assertSourcesCurrent(analyze(store.listExams(), latest).wrong, subject, targets, selected);
		let questions: Worksheet["questions"];
		try {
			questions = materializePractice(targets, drafts, latest.map(({ worksheet }) => worksheet));
		} catch (error) {
			if (!(error instanceof TutorError)) throw error;
			throw new HttpError(502, error.message);
		}

		const worksheet: Worksheet = {
			id: randomUUID(), subject, mode, createdAt: now.toISOString(),
			title: `${SUBJECT_LABELS[subject]}${mode === "assessment" ? "独立短测" : "错题复练"} · ${shanghaiDate(now)}`,
			questions, uncoveredSkillIds: [],
		};
		return store.addWorksheet(worksheet, schedule?.key ?? null) ? worksheet : null;
	}

	async function generateBatches(tutor: Tutor, subject: Subject, mode: Worksheet["mode"], targets: PracticeTarget[],
		signal: AbortSignal): Promise<PracticeDraft[]> {
		const drafts: PracticeDraft[] = [];
		const byId = new Map(targets.map((target) => [target.id, target]));
		for (let offset = 0; offset < targets.length; offset += PRACTICE_BATCH_SIZE) {
			const batch = targets.slice(offset, offset + PRACTICE_BATCH_SIZE).map((target) => {
				const recent = drafts.filter((draft) => byId.get(draft.targetId)?.skillId === target.skillId).slice(-3);
				return { ...target, avoidPrompts: [...recent.map(({ prompt }) => prompt), ...(target.avoidPrompts ?? [])].slice(0, 3) };
			});
			const deadline = AbortSignal.timeout(generationBatchTimeoutMs);
			const batchSignal = AbortSignal.any([signal, deadline]);
			checkGenerationActive(batchSignal, deadline);
			let generated: PracticeDraft[];
			try {
				generated = await tutor.generatePractice({ subject, mode, targets: batch }, batchSignal);
			} catch (error) {
				checkGenerationActive(batchSignal, deadline);
				logger.warn({ subject, mode, reason: error instanceof Error ? error.name : "provider" }, "Worksheet model request failed");
				throw new HttpError(502, error instanceof TutorError ? error.message : "模型暂时无法生成练习卷，请稍后重试。");
			}
			checkGenerationActive(batchSignal, deadline);
			drafts.push(...generated);
		}
		return drafts;
	}

	return {
		generate,
		async stop() {
			shutdown.abort();
			await active?.catch(() => {});
		},
	};
}

export type WorksheetGeneration = ReturnType<typeof createWorksheetGeneration>;

function checkGenerationActive(signal: AbortSignal, deadline?: AbortSignal): void {
	if (deadline?.aborted) throw new HttpError(504, "练习卷生成超时，请稍后重试。");
	if (signal.aborted) throw new HttpError(503, "练习卷生成已中止，可以重试。");
}

function selectWrong(wrong: readonly Wrong[], subject: Subject, ids: readonly string[]): Wrong[] {
	const byId = new Map(wrong.map((item) => [wrongId(item), item]));
	return ids.map((id) => {
		const item = byId.get(id);
		if (!item) throw new HttpError(409, "所选错题已更新，请刷新后重新选择。");
		if (item.subject !== subject) throw new HttpError(422, "请选择当前科目的错题。");
		return item;
	});
}

function assertSourcesCurrent(wrong: readonly Wrong[], subject: Subject, targets: readonly PracticeTarget[],
	selected: readonly Wrong[] | undefined): void {
	if (selected) {
		const current = selectWrong(wrong, subject, selected.map(wrongId));
		if (selected.some((item, index) => item.prompt !== current[index].prompt || item.errorCause !== current[index].errorCause
			|| item.difficulty !== current[index].difficulty || item.skillId !== current[index].skillId)) {
			throw new HttpError(409, "出题所用的错题记录已更新，请重新生成练习卷。");
		}
		return;
	}
	const current = wrong.filter((item) => item.subject === subject && !item.mastered);
	for (const { source, difficulty } of targets) {
		if (!source) continue;
		const available = current.some((item) => item.prompt === source.prompt && item.errorCause === source.errorCause
			&& item.difficulty === difficulty);
		if (!available) throw new HttpError(409, "出题所用的错题记录已更新，请重新生成练习卷。");
	}
}

function wrongId({ examId, worksheetId, itemId }: Wrong): string {
	return `${examId ?? worksheetId}:${itemId}`;
}
