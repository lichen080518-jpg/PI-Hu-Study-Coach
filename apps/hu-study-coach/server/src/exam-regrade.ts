import { type ExamItem, type ExamRegrade, type RegradeChange, type RegradeField, type RegradeSnapshot,
	UNRECOGNIZED_PAGE_PROMPT } from "./contracts.ts";

interface ComparedItem {
	item: ExamItem;
	change?: RegradeChange;
}

export function compareRegrade(previous: readonly ExamItem[], fresh: readonly ExamItem[]) {
	const previousItems = previous.filter((item) => unrecognizedPage(item) === undefined);
	const currentItems: ExamItem[] = [];
	const pageIssues = new Map<number, ExamRegrade["pageIssues"][number]>();
	for (const item of fresh) {
		const page = unrecognizedPage(item);
		if (page === undefined) currentItems.push(item);
		else pageIssues.set(page, { page, message: item.feedback });
	}

	const previousPositions = questionPositions(previousItems);
	const currentPositions = questionPositions(currentItems);
	const matched = new Set<ExamItem>();
	const compared: ComparedItem[] = [];
	for (const current of currentItems) {
		const position = questionPosition(current);
		const prior = position && currentPositions.get(position) ? previousPositions.get(position) : undefined;
		if (!prior) {
			compared.push({ item: current, change: { kind: "added", itemId: current.id, page: current.page,
				number: current.number, after: snapshot(current) } });
			continue;
		}
		matched.add(prior);
		const keepRegion = prior.imageRegion && (prior.imageSource === "manual" || !current.imageRegion);
		const item = { ...current, id: prior.id, ignored: prior.ignored,
			...(keepRegion ? { imageRegion: prior.imageRegion, imageSource: prior.imageSource } : {}) };
		const fields = changedFields(prior, item);
		compared.push({ item, change: fields.length ? { kind: "changed", itemId: item.id, page: item.page,
			number: item.number, before: snapshot(prior), after: snapshot(item), fields } : undefined });
	}
	for (const prior of previousItems) {
		if (matched.has(prior)) continue;
		compared.push({ item: prior, change: { kind: "retained", itemId: prior.id, page: prior.page,
			number: prior.number, before: snapshot(prior) } });
	}

	// Keep the order from the fresh recognition within each page and put carried items back on their page.
	compared.sort((a, b) => (a.item.page ?? Number.MAX_SAFE_INTEGER) - (b.item.page ?? Number.MAX_SAFE_INTEGER));
	return {
		items: compared.map(({ item }) => item),
		changes: compared.flatMap(({ change }) => change ? [change] : []),
		pageIssues: [...pageIssues.values()].sort((a, b) => a.page - b.page),
		newItemCount: currentItems.length,
		retainedItemCount: previousItems.length - matched.size,
	};
}

function unrecognizedPage(item: ExamItem): number | undefined {
	const { page, number, prompt, verdict } = item;
	if (page !== null && number === `第 ${page} 页` && prompt === UNRECOGNIZED_PAGE_PROMPT && verdict === "uncertain") return page;
	return undefined;
}

function questionPositions(items: readonly ExamItem[]): Map<string, ExamItem | null> {
	const positions = new Map<string, ExamItem | null>();
	for (const item of items) {
		const position = questionPosition(item);
		// A repeated key cannot establish a one-to-one match even if the other batch has only one candidate.
		if (position) positions.set(position, positions.has(position) ? null : item);
	}
	return positions;
}

function questionPosition({ page, number, prompt }: ExamItem): string | undefined {
	const label = number.normalize("NFKC").replace(/\s+/gu, "").replace(/^第/u, "").replace(/[题.、:]+$/u, "");
	if (!label) return undefined;
	const subparts = /^(\d+)题?((?:\(\d+\)|\.\d+)+)$/u.exec(label);
	const normalized = subparts ? `${subparts[1]}${subparts[2].replace(/\.(\d+)/gu, "($1)")}` : label;
	// The stem supplies additional evidence when neither result identified a page.
	return page === null ? JSON.stringify([null, normalized, comparableText(prompt)]) : `${page}:${normalized}`;
}

function comparableText(text: string): string {
	return text.normalize("NFC").trim().replace(/\s+/gu, " ");
}

function changedFields(before: ExamItem, after: ExamItem): RegradeField[] {
	const changed: RegradeField[] = [];
	if (before.verdict !== after.verdict) changed.push("verdict");
	if (before.score !== after.score || before.maxScore !== after.maxScore) changed.push("score");
	for (const field of ["prompt", "response", "referenceAnswer"] as const) {
		if (comparableText(before[field]) !== comparableText(after[field])) changed.push(field);
	}
	return changed;
}

function snapshot({ verdict, score, maxScore }: ExamItem): RegradeSnapshot {
	return { verdict, score, maxScore };
}
