import { createHash } from "node:crypto";
import type { PracticeDraft, PracticeQuestion, PracticeTarget, Skill, Subject, Worksheet, Wrong } from "./contracts.ts";
import { TutorError } from "./tutor-error.ts";

type AssessmentTarget = Pick<PracticeTarget, "skillId" | "maxScore" | "responseType"> & { skillLabel: string };

// Keep the same assessed skills, difficulty and scoring weights across short tests.
const ASSESSMENT_STRUCTURE: Record<Subject, readonly AssessmentTarget[]> = {
	chinese: [
		{ skillId: "chinese.context-vocabulary", skillLabel: "结合语境理解词义", maxScore: 1, responseType: "exact" },
		{ skillId: "chinese.reading-evidence", skillLabel: "用原文证据支撑阅读判断", maxScore: 2, responseType: "review" },
		{ skillId: "chinese.main-idea", skillLabel: "概括段落主旨", maxScore: 1, responseType: "exact" },
		{ skillId: "chinese.writing-detail", skillLabel: "用细节表现人物和情境", maxScore: 3, responseType: "review" },
	],
	math: [
		{ skillId: "math.signed-numbers", skillLabel: "有理数运算", maxScore: 1, responseType: "exact" },
		{ skillId: "math.linear-equation", skillLabel: "一元一次方程", maxScore: 1, responseType: "exact" },
		{ skillId: "math.rational-equation", skillLabel: "分式方程与验根", maxScore: 1, responseType: "exact" },
		{ skillId: "math.linear-function", skillLabel: "一次函数", maxScore: 1, responseType: "exact" },
	],
	english: [
		{ skillId: "english.subject-verb", skillLabel: "主语与谓语一致", maxScore: 1, responseType: "exact" },
		{ skillId: "english.simple-past", skillLabel: "一般过去时", maxScore: 1, responseType: "exact" },
		{ skillId: "english.reading-detail", skillLabel: "阅读定位具体信息", maxScore: 1, responseType: "exact" },
		{ skillId: "english.sentence-rewrite", skillLabel: "按要求改写句子", maxScore: 1, responseType: "exact" },
	],
};

export const PRACTICE_BATCH_SIZE = 6;
export const MAX_WORKSHEET_QUESTIONS = 40;

export function getSkills(subject: Subject): Skill[] {
	return ASSESSMENT_STRUCTURE[subject].map(({ skillId, skillLabel }) => ({ id: skillId, label: skillLabel, subject }));
}

export function selectPracticeTargets(input: {
	subject: Subject;
	mode: Worksheet["mode"];
	wrong: readonly Wrong[];
	worksheets: readonly Worksheet[];
	now: Date;
	selectedWrong?: readonly Wrong[];
}): PracticeTarget[] {
	const structure = ASSESSMENT_STRUCTURE[input.subject];
	const history = input.worksheets.filter(({ subject }) => subject === input.subject);
	if (input.mode === "assessment") {
		return structure.map((target, index) => ({ ...target, id: String(index + 1), difficulty: "standard",
			avoidPrompts: recentPrompts(history, target.skillId, "standard") }));
	}

	const sources = input.selectedWrong ?? prioritizeWrong(input.wrong, input.subject, history, input.now);
	return sources.map((item, index) => {
		const known = structure.find(({ skillId }) => skillId === item.skillId);
		const sourceKey = practiceSourceKey(item);
		const skillId = item.skillId ?? sourceKey;
		return {
			id: String(index + 1), skillId, skillLabel: known?.skillLabel, difficulty: item.difficulty,
			maxScore: known?.maxScore ?? 2, responseType: known?.responseType ?? "review",
			source: { prompt: item.prompt, errorCause: item.errorCause }, sourceKey,
			avoidPrompts: recentPrompts(history, skillId, item.difficulty),
		};
	});
}

function prioritizeWrong(wrong: readonly Wrong[], subject: Subject, history: readonly Worksheet[], now: Date): Wrong[] {
	const lastIssued = new Map<string, string>();
	for (const sheet of history) {
		for (const { sourceKey } of sheet.questions) {
			if (sourceKey && sheet.createdAt > (lastIssued.get(sourceKey) ?? "")) lastIssued.set(sourceKey, sheet.createdAt);
		}
	}

	const date = now.toISOString();
	const due = ({ dueAt }: Wrong) => dueAt !== null && dueAt <= date;
	const unique = new Map<string, Wrong>();
	for (const item of wrong) {
		if (item.subject !== subject || item.mastered) continue;
		const key = practiceSourceKey(item);
		if (!unique.has(key)) unique.set(key, item);
	}
	const prioritized = [...unique].sort(([keyA, a], [keyB, b]) =>
		Number(due(b)) - Number(due(a)) ||
		(lastIssued.get(keyA) ?? "").localeCompare(lastIssued.get(keyB) ?? "") ||
		b.occurrences - a.occurrences || (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));

	return prioritized.slice(0, PRACTICE_BATCH_SIZE).map(([, item]) => item);
}

export function materializePractice(targets: readonly PracticeTarget[], drafts: readonly PracticeDraft[],
	worksheets: readonly Worksheet[]): PracticeQuestion[] {
	const byTarget = new Map(drafts.map(({ targetId, ...draft }) => [targetId, draft]));
	const usedPrompts = new Set(worksheets.flatMap(({ questions }) => questions.map(({ prompt }) => normalizePrompt(prompt))));
	if (drafts.length !== targets.length || byTarget.size !== targets.length) {
		throw new TutorError("模型返回的题目数量不符，请重新生成练习卷。");
	}
	for (const { source } of targets) {
		if (source) usedPrompts.add(normalizePrompt(source.prompt));
	}
	return targets.map(({ id, skillId, sourceKey, difficulty, maxScore, responseType }) => {
		const draft = byTarget.get(id);
		if (!draft) throw new TutorError("模型没有完整覆盖本次练习的考点，请重新生成练习卷。");
		const prompt = normalizePrompt(draft.prompt);
		if (usedPrompts.has(prompt)) throw new TutorError("模型生成了已练过或重复的题目，请重新生成练习卷。");
		usedPrompts.add(prompt);
		return { ...draft, id: hash(JSON.stringify([skillId, difficulty, draft.prompt])), familyId: `${skillId}/${difficulty}`,
			skillId, sourceKey, difficulty, maxScore, responseType };
	});
}

export function reviewSkillId(item: Pick<Wrong, "skillId" | "subject" | "prompt">): string {
	return item.skillId ?? practiceSourceKey(item);
}

function practiceSourceKey({ subject, prompt }: Pick<Wrong, "subject" | "prompt">): string {
	return `${subject}.source.${hash(normalizePrompt(prompt))}`;
}

function recentPrompts(history: readonly Worksheet[], skillId: string, difficulty: PracticeTarget["difficulty"]): string[] {
	return history.flatMap(({ questions }) => questions.filter((question) => question.skillId === skillId && question.difficulty === difficulty))
		.slice(0, 3).map(({ prompt }) => prompt);
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function normalizePrompt(prompt: string): string {
	return prompt.normalize("NFC").trim().replace(/\s+/gu, " ");
}

export function isAcceptedAnswer(question: Pick<PracticeQuestion, "responseType" | "skillId" | "acceptedAnswers">, response: string): boolean {
	if (question.responseType === "review") return false;
	const normalized = normalizeResponse(response);
	if (question.skillId.startsWith("math.")) {
		const value = parseRational(normalized);
		return question.acceptedAnswers.some((answer) => {
			const expected = normalizeResponse(answer);
			if (normalized === expected) return true;
			const target = parseRational(expected);
			return (
				value !== undefined &&
				target !== undefined &&
				value.variable === target.variable &&
				value.numerator * target.denominator === target.numerator * value.denominator
			);
		});
	}
	return question.acceptedAnswers.some((answer) => normalized === normalizeResponse(answer));
}

function normalizeResponse(response: string): string {
	return response
		.normalize("NFKC")
		.trim()
		.toLowerCase()
		.replaceAll("’", "'")
		.replaceAll("−", "-")
		.replace(/\s+/g, " ")
		.replace(/[.。]$/, "")
		.trimEnd();
}

function parseRational(response: string) {
	const compact = response.replace(/\s*([=/])\s*/g, "$1");
	const match = /^(?:(x|y)=)?([+-]?\d{1,16})(?:(?:\.(\d{1,12}))|\/(\d{1,16}))?$/.exec(compact);
	if (!match) return undefined;
	const [, variable, whole, decimals, fraction] = match;
	if (decimals) {
		const sign = whole.startsWith("-") ? -1n : 1n;
		const denominator = 10n ** BigInt(decimals.length);
		return { variable, numerator: BigInt(whole) * denominator + sign * BigInt(decimals), denominator };
	}
	const denominator = fraction ? BigInt(fraction) : 1n;
	if (denominator === 0n) return undefined;
	return { variable, numerator: BigInt(whole), denominator };
}
