import type { MarkingItem } from "./contracts.ts";

interface Rational {
	numerator: bigint;
	denominator: bigint;
}

const precedence = new Map([["+", 1], ["-", 1], ["*", 2], ["/", 2]]);
const decimalPattern = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u;

/** Checks a standalone numeric calculation against the recognized numeric answer. */
export function verifyArithmetic(item: MarkingItem): MarkingItem {
	if (item.verdict === "uncertain" || !item.evidence.trim()
		|| /看不清|模糊|不确定|疑似|无法确认|无法辨认|难以辨认/u.test(item.evidence)) return item;
	const prompt = normalizeSymbols(item.prompt).trim()
		.replace(/^(?:计算|口算|直接写出得数)\s*[:：]?\s*/u, "")
		.replace(/[。?？]$/u, "")
		.replace(/=\s*(?:\(\s*\)|_+|□)?\s*$/u, "");
	const expected = calculate(prompt);
	const answer = readAnswer(normalizeSymbols(item.response).trim());
	if (!expected || !answer) return item;
	const correct = expected.numerator * answer.denominator === answer.numerator * expected.denominator;
	const verdict = correct ? "correct" : "incorrect";
	const referenceAnswer = formatAnswer(expected);
	// An incorrect final answer alone does not establish a particular partial score.
	const score = item.maxScore === null || item.score === null ? null
		: correct ? item.maxScore : item.score < item.maxScore ? item.score : null;
	return { ...item, verdict, score, referenceAnswer, requiresReview: false,
		feedback: correct ? `计算结果 ${referenceAnswer} 正确。` : `正确结果是 ${referenceAnswer}，作答是 ${item.response}。`,
		errorCause: correct ? "" : item.verdict === "incorrect" ? item.errorCause : "计算结果错误" };
}

function normalizeSymbols(value: string): string {
	// Normalize only full-width digits and arithmetic glyphs. For example, 2² must not become 22.
	return value.replace(/[０-９＋－＊／（）＝．]/gu, (character) => character.normalize("NFKC"))
		.replace(/−/gu, "-").replace(/×/gu, "*").replace(/÷/gu, "/");
}

function calculate(prompt: string): Rational | null {
	if (prompt.length > 160 || /[\d.]\s+[\d.]/u.test(prompt)) return null;
	const tokens = prompt.match(/\d+(?:\.\d+)?|\.\d+|[()+\-*/]/gu) ?? [];
	if (tokens.length > 60 || tokens.join("") !== prompt.replace(/\s+/gu, "")) return null;
	let next = 0;
	let binary = false;

	function readExpression(minPrecedence: number): Rational | null {
		let left = readOperand();
		while (left) {
			const operator = tokens[next];
			const priority = precedence.get(operator);
			if (priority === undefined || priority < minPrecedence) return left;
			next++;
			const right = readExpression(priority + 1);
			if (!right) return null;
			binary = true;
			left = combine(left, operator, right);
		}
		return null;
	}

	function readOperand(): Rational | null {
		const token = tokens[next++];
		if (token === undefined) return null;
		if (token === "+" || token === "-") {
			const value = readOperand();
			return value && token === "-" ? { ...value, numerator: -value.numerator } : value;
		}
		if (token === "(") {
			const value = readExpression(1);
			return tokens[next++] === ")" ? value : null;
		}
		return decimalPattern.test(token) ? decimal(token) : null;
	}

	const result = readExpression(1);
	return binary && next === tokens.length ? result : null;
}

function combine(left: Rational, operator: string, right: Rational): Rational | null {
	const { numerator: a, denominator: b } = left;
	const { numerator: c, denominator: d } = right;
	switch (operator) {
		case "+": return { numerator: a * d + c * b, denominator: b * d };
		case "-": return { numerator: a * d - c * b, denominator: b * d };
		case "*": return { numerator: a * c, denominator: b * d };
		case "/": {
			if (c === 0n) return null;
			return c > 0n ? { numerator: a * d, denominator: b * c } : { numerator: -a * d, denominator: -b * c };
		}
		default: return null;
	}
}

function readAnswer(response: string): Rational | null {
	if (response.length > 80) return null;
	if (decimalPattern.test(response)) return decimal(response);
	const match = response.match(/^([+-]?\d+)\s*\/\s*(\d+)$/u);
	if (!match) return null;
	const denominator = BigInt(match[2]);
	return denominator === 0n ? null : { numerator: BigInt(match[1]), denominator };
}

function decimal(value: string): Rational {
	const [integer, fraction = ""] = value.split(".");
	return { numerator: BigInt(integer + fraction), denominator: 10n ** BigInt(fraction.length) };
}

function formatAnswer({ numerator, denominator }: Rational): string {
	if (numerator % denominator === 0n) return String(numerator / denominator);
	let a = numerator < 0n ? -numerator : numerator;
	let b = denominator;
	while (b) [a, b] = [b, a % b];
	return `${numerator / a}/${denominator / a}`;
}
