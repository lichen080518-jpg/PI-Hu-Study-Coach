import type { ExamItem, MarkingItem, Worksheet } from "./contracts.ts";

export function matchWorksheetItem(item: MarkingItem, worksheet: Worksheet): MarkingItem {
	const number = item.number.normalize("NFKC").match(/^(?:第\s*)?(\d+)\s*(?:题)?[.、:]?$/u)?.[1];
	const question = number ? worksheet.questions[Number(number) - 1] : undefined;
	if (!question || compactPrompt(question.prompt) !== compactPrompt(item.prompt)) return item;
	// A matching worksheet names the skill and difficulty, but points must still come from the uploaded image.
	const maxScore = item.maxScore === question.maxScore ? item.maxScore : null;
	return { ...item, number: String(Number(number)), prompt: question.prompt, skillId: question.skillId,
		difficulty: question.difficulty, maxScore, score: maxScore === null ? null : item.score };
}

export function confirmedScore(item: MarkingItem): number | null {
	const { verdict, score, maxScore } = item;
	if (score === null || maxScore === null || verdict === "uncertain") return null;
	return (verdict === "correct" ? score === maxScore : score < maxScore) ? score : null;
}

export function examScores(items: ExamItem[]): { obtained: number | null; possible: number | null } {
	let obtained = 0;
	let possible = 0;
	for (const item of items) {
		const score = confirmedScore(item);
		if (score !== null && item.maxScore !== null) {
			obtained += score;
			possible += item.maxScore;
		}
	}
	if (!possible) return { obtained: null, possible: null };
	return { obtained: Math.round(obtained * 100) / 100, possible: Math.round(possible * 100) / 100 };
}

function compactPrompt(prompt: string): string {
	return prompt.normalize("NFKC").replace(/\s+/gu, "").replace(/[。.]+$/u, "");
}
