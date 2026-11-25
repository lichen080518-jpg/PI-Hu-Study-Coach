import type { Difficulty, Exam, Subject, TrendPoint, Wrong } from "./contracts.ts";
import { reviewSkillId } from "./practice.ts";
import type { WorksheetRecord } from "./store.ts";

interface Observation {
	date: string;
	subject: Subject;
	skillId: string;
	difficulty: Difficulty;
}

interface WrongObservation {
	date: string;
	wrong: Omit<Wrong, "occurrences" | "dueAt" | "mastered">;
}

const dayInShanghai = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" });
const dayMs = 86_400_000;

export function shanghaiDate(date: Date): string {
	return dayInShanghai.format(date);
}

export function analyze(exams: Exam[], records: WorksheetRecord[]): { wrong: Wrong[]; trend: TrendPoint[] } {
	const misses = originalMisses(exams);
	const passes: Observation[] = [];
	const trend: TrendPoint[] = [];
	const firstIssued = new Map<string, string>();
	for (const { worksheet } of [...records].reverse()) {
		for (const question of worksheet.questions) {
			if (!firstIssued.has(question.id)) firstIssued.set(question.id, worksheet.id);
		}
	}
	const trendByDate = new Map<string, TrendPoint>();
	for (const { worksheet, attempt } of records) {
		if (!attempt) continue;
		const answers = new Map(attempt.items.map((item) => [item.questionId, item]));
		let correct = 0;
		let comparable = 0;
		for (const [index, question] of worksheet.questions.entries()) {
			const item = answers.get(question.id);
			if (!item || item.score === null) continue;
			const passed = item.score === question.maxScore;
			const independent = !attempt.assisted && firstIssued.get(question.id) === worksheet.id;
			if (independent) {
				comparable++;
				if (passed) {
					correct++;
					passes.push({ date: attempt.createdAt, subject: worksheet.subject, skillId: question.skillId,
						difficulty: question.difficulty });
				}
			}
			if (!passed) {
				misses.push({ date: attempt.createdAt, wrong: { examId: null, worksheetId: worksheet.id,
					itemId: question.id, subject: worksheet.subject, number: String(index + 1), prompt: question.prompt,
					feedback: item.feedback, skillId: question.skillId, difficulty: question.difficulty,
					errorCause: "复练未达评分点", sourcePage: null, hasScreenshot: false } });
			}
		}
		if (worksheet.mode === "assessment" && comparable === worksheet.questions.length && comparable > 0) {
			const date = shanghaiDate(new Date(attempt.createdAt));
			const key = `${worksheet.subject}:${date}`;
			const point = trendByDate.get(key);
			if (point) {
				point.correct += correct;
				point.total += comparable;
				point.worksheetIds.push(worksheet.id);
			} else {
				trendByDate.set(key, { subject: worksheet.subject, date, correct, total: comparable, worksheetIds: [worksheet.id] });
			}
		}
	}
	trend.push(...trendByDate.values());
	trend.sort((a, b) => a.date.localeCompare(b.date));
	return { wrong: reviewProgress(misses, passes), trend };
}

function originalMisses(exams: Exam[]): WrongObservation[] {
	return exams.flatMap((exam) => {
		if (!exam.hasPublishedResult && exam.status !== "published") return [];
		return exam.items.flatMap((item) => {
			if (item.verdict !== "incorrect" || item.ignored) return [];
			const sourcePage = exam.attachments.length ? item.page : null;
			return [{ date: exam.createdAt, wrong: { examId: exam.id, worksheetId: exam.worksheetId, itemId: item.id,
				subject: exam.subject, number: item.number, prompt: item.prompt, feedback: item.feedback,
				skillId: item.skillId, difficulty: item.difficulty, errorCause: item.errorCause,
				sourcePage, hasScreenshot: sourcePage !== null && item.imageRegion !== undefined } }];
		});
	});
}

function reviewProgress(misses: WrongObservation[], passes: Observation[]): Wrong[] {
	misses.sort((a, b) => b.date.localeCompare(a.date));
	const groups = new Map<string, { latest: WrongObservation; count: number; days: Set<string> }>();
	for (const miss of misses) {
		const key = wrongGroup(miss.wrong);
		const group = groups.get(key);
		if (group) group.count++;
		else groups.set(key, { latest: miss, count: 1, days: new Set() });
	}
	for (const pass of passes) {
		const group = groups.get(`${pass.subject}:${pass.skillId}:${pass.difficulty}`);
		const date = shanghaiDate(new Date(pass.date));
		if (group && date > shanghaiDate(new Date(group.latest.date))) group.days.add(date);
	}
	const progress = new Map<string, { occurrences: number; dueAt: string; mastered: boolean }>();
	for (const [key, group] of groups) {
		const successfulDays = [...group.days].sort();
		const latest = successfulDays.at(-1);
		const delay = [1, 3, 7, 14][Math.min(successfulDays.length, 3)];
		const base = latest ? new Date(`${latest}T00:00:00+08:00`) : new Date(group.latest.date);
		const dueAt = new Date(base.getTime() + delay * dayMs).toISOString();
		const mastered = successfulDays.length >= 4;
		progress.set(key, { occurrences: group.count, dueAt, mastered });
	}
	return misses.map(({ wrong }) => ({ ...wrong, ...(progress.get(wrongGroup(wrong))
		?? { occurrences: 1, dueAt: null, mastered: false }) }));
}

function wrongGroup(wrong: WrongObservation["wrong"]): string {
	return `${wrong.subject}:${reviewSkillId(wrong)}:${wrong.difficulty}`;
}
