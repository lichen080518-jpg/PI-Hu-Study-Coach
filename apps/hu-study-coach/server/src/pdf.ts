import { statSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { SUBJECT_LABELS, type PracticeQuestion, type Worksheet } from "./contracts.ts";

type WorksheetVariant = "student" | "solutions";

export async function renderWorksheetPdf(worksheet: Worksheet, variant: WorksheetVariant): Promise<Buffer> {
	const browser = await chromium.launch({ executablePath: findChromium(), headless: true, timeout: 20_000 });
	try {
		const page = await browser.newPage({ javaScriptEnabled: false });
		await page.route("**/*", (route) => route.abort());
		await page.setContent(worksheetHtml(worksheet, variant), { waitUntil: "load" });
		await page.evaluate("document.fonts.ready.then(() => undefined)");
		return await page.pdf({ preferCSSPageSize: true, printBackground: true, tagged: true });
	} finally {
		await browser.close();
	}
}

function findChromium(): string {
	const configured = process.env.TUTOR_CHROMIUM_PATH;
	if (configured) {
		if (statSync(configured, { throwIfNoEntry: false })?.isFile()) return configured;
		throw new Error("TUTOR_CHROMIUM_PATH 指定的浏览器文件不存在。");
	}
	const candidates = [chromium.executablePath()];
	if (process.platform === "win32") {
		const programFiles = process.env.ProgramFiles ?? "C:/Program Files";
		const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)";
		const roots = [programFiles, programFilesX86, process.env.LOCALAPPDATA].filter((root) => root !== undefined);
		for (const root of roots) {
			candidates.push(
				join(root, "Microsoft/Edge/Application/msedge.exe"),
				join(root, "Google/Chrome/Application/chrome.exe"),
			);
		}
	} else if (process.platform === "darwin") {
		candidates.push(
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		);
	} else {
		candidates.push(
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/usr/bin/google-chrome",
			"/usr/bin/microsoft-edge",
		);
	}
	const executable = candidates.find((candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile());
	if (!executable) throw new Error("请安装 Chromium、Edge 或 Chrome，或用 TUTOR_CHROMIUM_PATH 指定浏览器路径。");
	return executable;
}

const PRINT_STYLES = `
	@page {
		size: A4;
		margin: 14mm 18mm 17mm;
		@bottom-left { content: "沪学伴"; color: #52645f; font-size: 8pt; }
		@bottom-right { content: counter(page) " / " counter(pages); color: #52645f; font-size: 8pt; }
	}
	* { box-sizing: border-box; }
	html { font: 10.5pt/1.64 "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", "SimSun", sans-serif; color: #17241f; }
	body { margin: 0; }
	header { border-top: 2.5mm solid #285749; padding: 6mm 0 4mm; margin-bottom: 4mm; border-bottom: 0.25mm solid #a7b9b2; }
	.kicker { margin: 0 0 1.5mm; font-size: 9pt; font-weight: 700; color: #2d594d; }
	h1 { font-size: 22pt; line-height: 1.25; margin: 0 0 3mm; overflow-wrap: anywhere; }
	.metadata { display: flex; flex-wrap: wrap; gap: 1mm 5mm; padding: 0; margin: 0; list-style: none; font-size: 9pt; color: #3c5049; }
	.identifier { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
	.student-fields { display: flex; align-items: center; gap: 4mm; margin-top: 4mm; font-size: 9pt; }
	.field-line { flex: 0 1 30mm; height: 5mm; border-bottom: 0.2mm solid #50635a; }
	.instruction { margin: 0 0 4mm; font-size: 9pt; color: #3c5049; }
	.question { break-inside: avoid; border-bottom: 0.2mm solid #c2cfc9; padding: 1.5mm 0 4mm; margin: 0 0 3mm; }
	.question:last-child { border-bottom: 0; margin-bottom: 0; }
	h2 { margin: 0 0 1mm; font-size: 10pt; }
	.points { margin-left: 3mm; color: #52645f; font-weight: 400; }
	.prompt, .answer-text, .rubric-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
	.lines { list-style: none; padding: 0; margin: 1.5mm 0 0; }
	.lines li { min-height: 7mm; border-bottom: 0.2mm solid #c2cfc9; }
	.solution { margin-top: 2mm; border-left: 0.7mm solid #588372; padding: 1.8mm 3mm; background: #f1f5f2; }
	h3 { font-size: 9pt; margin: 0 0 0.5mm; }
	.rubric-text { margin-top: 1.5mm; color: #3c5049; }
`;

function worksheetHtml(worksheet: Worksheet, variant: WorksheetVariant): string {
	const isStudent = variant === "student";
	const edition = isStudent ? "学生卷" : "答案详解";
	const format = worksheet.mode === "assessment" ? "独立短测" : "错题复练";
	const points = worksheet.questions.reduce((total, question) => total + question.maxScore, 0);
	const date = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeZone: "Asia/Shanghai" }).format(
		new Date(worksheet.createdAt),
	);
	const renderedQuestions = worksheet.questions.map((question, index) => questionHtml(question, index, variant));
	return `<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
	<title>${escapeHtml(worksheet.title)} · ${edition}</title>
	<style>${PRINT_STYLES}</style>
</head>
<body>
	<header>
		<p class="kicker">沪学伴　/　${SUBJECT_LABELS[worksheet.subject]}　/　${edition}</p>
		<h1>${escapeHtml(worksheet.title)}</h1>
		<ul class="metadata">
			<li>${format}</li><li>${worksheet.questions.length} 道题</li><li>满分 ${points}</li><li>${escapeHtml(date)}</li>
			<li class="identifier">试卷编号 ${escapeHtml(worksheet.id)}</li>
		</ul>
		${isStudent ? '<div class="student-fields">姓名 <span class="field-line"></span> 作答日期 <span class="field-line"></span></div>' : ""}
	</header>
	<main>
		${isStudent ? `<p class="instruction">${worksheet.mode === "assessment" ? "请独立完成。" : "请先作答，完成后再核对答案。"} 作答后可用试卷编号提交练习记录。</p>` : ""}
		${renderedQuestions.join("\n")}
	</main>
</body>
</html>`;
}

function questionHtml(question: PracticeQuestion, index: number, variant: WorksheetVariant): string {
	const answerArea =
		variant === "student"
			? `<ul class="lines" aria-hidden="true">${"<li></li>".repeat(question.responseType === "review" ? 3 : 1)}</ul>`
			: `<div class="solution"><h3>参考解答</h3><p class="answer-text">${escapeHtml(question.solution)}</p><p class="rubric-text">${escapeHtml(question.rubric)}</p></div>`;
	return `<section class="question">
		<h2>第 ${index + 1} 题<span class="points">${question.maxScore} 分</span></h2>
		<p class="prompt">${escapeHtml(question.prompt)}</p>
		${answerArea}
	</section>`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
