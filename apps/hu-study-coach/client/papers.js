import { read, send, submissionKey } from "./api.js";
import { examTable } from "./dashboard.js";
import { createQuestionImageViewer } from "./question-image.js";
import { bindForm, bindRecordDeletion, deleteRecordButton, empty, escape, examCounts, examStatus, option, pageHeader, scoreLabel, subjectOptions, subjects, verdictLabels, verdictStatus } from "./ui.js";

const fileTypes = "image/jpeg,image/png,image/webp,application/pdf";
const maxFileBytes = 12 * 1024 * 1024;
const maxTotalBytes = 48 * 1024 * 1024;
const maxFiles = 12;
const regradeTime = new Intl.DateTimeFormat("zh-CN", {
	year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai",
});
const regradeFields = { prompt: "题干", response: "作答识别", referenceAnswer: "参考答案" };

export function renderExams(container, exams, session, { notice, reload }) {
	const action = session.role === "reviewer" ? (exam) => deleteRecordButton("exams", exam) : undefined;
	container.innerHTML = `<div class="page">${pageHeader("试卷批改", "查看逐题对错与批改进度。", '<a class="button primary" href="#exams/upload">上传试卷</a>')}
		<section class="panel"><h2>全部试卷</h2>${examTable(exams, action)}</section></div>`;
	if (action) bindRecordDeletion(container, "exams", notice, reload);
}

export function renderUpload(container, session, worksheet, subject) {
	const back = worksheet ? `<a class="button secondary" href="#practice/${encodeURIComponent(worksheet.id)}">返回练习卷</a>` : '<a class="button secondary" href="#exams">返回试卷列表</a>';
	const modelSettings = session.role === "reviewer" ? '<a href="#settings">模型设置</a>' : "";
	container.innerHTML = `<div class="page">${pageHeader(worksheet ? "回传练习卷" : "上传试卷", "含题干和作答的页面请按顺序添加。", back)}
		<section class="panel"><form id="upload-form" class="stack">
			<div class="form-grid"><label class="field">试卷名称<input name="title" value="${worksheet ? `${escape(worksheet.title)} · 纸面作答` : ""}" maxlength="120" required /></label>
				${worksheet ? `<div class="field"><b>科目</b><p>${subjects[worksheet.subject]}</p></div>` : `<label class="field">科目<select name="subject" aria-label="科目">${subjectOptions(subject)}</select></label>`}</div>
			<div class="dropzone"><label for="upload-files">添加文件</label><input id="upload-files" type="file" accept="${fileTypes}" multiple />
				<label for="upload-photo" class="small">拍摄一页</label><input id="upload-photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" />
				<p class="muted small">支持 JPG、PNG、WebP 和 PDF。最多 12 个文件，单个文件最多 12 MiB，合计最多 48 MiB。</p></div>
			<div id="upload-list" aria-live="polite"></div>
			${worksheet ? '<p class="muted small">批改时会使用此练习卷的参考答案。</p>' : '<details class="details-card"><summary>附参考答案（可选）</summary><div><label class="field">参考答案<textarea name="referenceText" rows="4" maxlength="24000"></textarea></label></div></details>'}
			${session.modelProvider === "openai-codex" ? '<p class="notice">使用 OpenAI Codex 批改时，试卷图片将发送给 OpenAI 处理。</p>' : ""}
			${session.visionAvailable ? "" : `<p class="notice">视觉批改暂不可用。现在上传的原卷会保留，可以稍后重新批改。${modelSettings}</p>`}
			<p class="form-error" role="alert"></p><div class="row"><button class="button primary" type="submit">提交批改</button></div>
		</form></section>
	</div>`;
	const form = container.querySelector("#upload-form");
	const list = form.querySelector("#upload-list");
	const files = [];
	let key = submissionKey();
	function showFiles() {
		key = submissionKey();
		list.innerHTML = files.length ? `<ol class="files">${files.map((file, index) => `<li class="list-row"><span>${index + 1}. ${escape(file.name)}</span><div class="row"><button class="button plain small" type="button" data-move="${index}"${index ? "" : " disabled"}>上移</button><button class="button plain small" type="button" data-remove="${index}" aria-label="移除 ${escape(file.name)}">移除</button></div></li>`).join("")}</ol>` : empty("尚未添加页面。");
	}
	function addFiles(selection) {
		const feedback = form.querySelector(".form-error");
		feedback.textContent = "";
		let total = files.reduce((bytes, file) => bytes + file.size, 0);
		for (const file of selection) {
			if (files.length === maxFiles) {
				feedback.textContent = "已达到 12 个文件的上限。";
				break;
			}
			if (file.size > maxFileBytes || !fileTypes.split(",").includes(file.type)) {
				feedback.textContent = `无法添加 ${file.name}，请检查格式和大小。`;
				continue;
			}
			if (total + file.size > maxTotalBytes) {
				feedback.textContent = `添加 ${file.name} 会超出 48 MiB 的总大小限制。`;
				continue;
			}
			total += file.size;
			files.push(file);
		}
		showFiles();
	}
	for (const input of form.querySelectorAll('input[type="file"]')) {
		input.addEventListener("change", () => {
			addFiles(input.files);
			input.value = "";
		});
	}
	const dropzone = form.querySelector(".dropzone");
	dropzone.addEventListener("dragover", (event) => {
		event.preventDefault();
		dropzone.classList.add("dragging");
	});
	dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragging"));
	dropzone.addEventListener("drop", (event) => {
		event.preventDefault();
		dropzone.classList.remove("dragging");
		addFiles(event.dataTransfer.files);
	});
	list.addEventListener("click", (event) => {
		const { move, remove } = event.target.dataset;
		if (remove !== undefined) files.splice(Number(remove), 1);
		else if (Number(move) > 0) {
			const index = Number(move);
			const [file] = files.splice(index, 1);
			files.splice(index - 1, 0, file);
		} else return;
		showFiles();
	});
	form.addEventListener("input", () => { key = submissionKey(); });
	showFiles();
	bindForm(container, "#upload-form", async (data) => {
		if (!files.length) throw new Error("请先添加试卷文件。");
		if (worksheet) {
			data.set("worksheetId", worksheet.id);
			data.set("subject", worksheet.subject);
		}
		for (const file of files) data.append("files", file);
		const exam = await read("/exams", { method: "POST", body: data, headers: { "Idempotency-Key": key } });
		location.hash = `exams/${encodeURIComponent(exam.id)}`;
	});
}

export function renderExam(container, exam, session, skills, options) {
	const id = encodeURIComponent(exam.id);
	const waiting = exam.status === "queued" || exam.status === "processing";
	const reviewer = session.role === "reviewer";
	const canCorrect = reviewer && !waiting;
	const retryable = canCorrect && exam.retryAvailable;
	const cloud = session.modelProvider === "openai-codex";
	const requestedItem = exam.items.findIndex((item) => item.id === options.item);
	const firstWrong = exam.items.findIndex((item) => item.verdict === "incorrect" && !item.ignored);
	const target = requestedItem >= 0 ? requestedItem : Math.max(0, firstWrong);
	const skillLabels = new Map(skills.filter((skill) => skill.subject === exam.subject).map((skill) => [skill.id, skill.label]));
	const retained = new Map(exam.regrade?.changes.filter(({ kind }) => kind === "retained").map(({ itemId, before }) => [itemId, before]));
	const counts = examCounts(exam);
	const points = exam.obtained != null && exam.possible != null
		? `<span class="muted small">有分值的题目 ${scoreLabel(exam.obtained)} / ${scoreLabel(exam.possible)} 分</span>` : "";
	const retryActions = retryable ? `<a id="retry-model-settings" class="button plain" href="#settings?exam=${id}"${session.visionAvailable ? " hidden" : ""}>模型设置</a><button class="button ${exam.status === "failed" ? "primary" : "secondary"}" id="retry-exam" type="button">重新批改</button>` : "";
	const actions = `<div class="row"><a class="button secondary" href="#exams">返回试卷列表</a>${retryActions}${reviewer ? deleteRecordButton("exams", exam) : ""}</div>`;
	container.innerHTML = `<div class="page">${pageHeader(exam.title, subjects[exam.subject], actions)}
		<div class="row"><span id="paper-status" role="status">${examStatus(exam.status)}</span>${counts}${points}</div>
		${exam.error ? `<p class="notice text-wrap">${escape(exam.error)}</p>` : ""}
		${retryable ? `<p class="muted small">重新批改会使用已上传的原卷。${cloud ? "当前模型会将试卷图片发送给 OpenAI 处理。" : ""}</p>` : ""}
		<p id="retry-feedback" class="form-error" role="alert"></p>
		${waiting ? '<p class="state" role="status">后台正在处理。稍后返回本页可继续查看。</p>' : ""}
		<div class="review-layout">
			<section class="panel" aria-labelledby="original-paper"><h2 id="original-paper" tabindex="-1">原卷</h2>${attachments(exam.attachments)}</section>
			<section class="panel" id="exam-results"><h2>批改结果</h2>
				${exam.regrade ? regradeReport(exam.regrade, id, waiting || exam.status === "failed") : ""}
				${firstWrong >= 0 ? '<p class="muted small">可在<a href="#errors">错题本</a>查看已收录的题目。</p>' : ""}
				${exam.items.length ? `<div class="stack">${exam.items.map((item, index) => readItem(exam, item, skillLabels, { index, open: index === target, canCorrect, canTutor: session.modelAvailable, prior: retained.get(item.id) })).join("")}</div>` : exam.error || waiting ? "" : empty("暂无批改结果。")}
			</section>
		</div>
	</div>`;
	if (reviewer) bindRecordDeletion(container, "exams", options.notice, () => { location.hash = "exams"; });
	bindAttachments(container, exam.attachments, exam.items[target]?.page);
	let showOriginal;
	container.querySelector("#exam-results").addEventListener("click", ({ target: clicked }) => {
		const button = clicked.closest("[data-question-preview]");
		if (!button) return;
		if (!button.dataset.imagePath) {
			container.querySelector("#original-paper").focus();
			return;
		}
		showOriginal ??= createQuestionImageViewer(container);
		showOriginal(button, button.dataset.imageAvailable === "true" ? "screenshot" : "preview");
	});
	if (requestedItem >= 0) {
		const summary = container.querySelector(`#exam-item-${requestedItem} > summary`);
		window.requestAnimationFrame(() => {
			if (summary?.isConnected) summary.focus();
		});
	}
	if (canCorrect) {
		for (const [index, item] of exam.items.entries()) {
			bindForm(container, `#correct-verdict-${index}`, async (data) => {
				const choice = data.get("verdict");
				const ignored = choice === "ignore";
				if (ignored ? item.ignored : !item.ignored && choice === item.verdict) return;
				const update = ignored ? { id: item.id, ignored } : { id: item.id, verdict: choice, ignored };
				await send(`/exams/${id}/grade`, "PUT", { items: [update], revision: exam.revision });
				options.notice(ignored ? "已忽略此题。" : item.ignored && choice === item.verdict ? "已取消忽略。" : "判定已更新。");
				await options.reload();
			});
		}
	}
	const retryButton = container.querySelector("#retry-exam");
	const retryFeedback = container.querySelector("#retry-feedback");
	const retrySettings = container.querySelector("#retry-model-settings");
	retryButton?.addEventListener("click", async () => {
		if (exam.hasPublishedResult && !window.confirm(`成功后会更新现有批改结果。${cloud ? "试卷图片会发送给 OpenAI 处理。" : ""}继续重新批改吗？`)) return;
		retryButton.disabled = true;
		retryFeedback.textContent = "";
		try {
			if (exam.hasPublishedResult) await send(`/exams/${id}/retry`, "POST", { confirmPublished: true });
			else await read(`/exams/${id}/retry`, { method: "POST" });
			options.notice("已提交重新批改。");
			await options.reload();
		} catch (error) {
			retryFeedback.textContent = error.message;
			if (error.code === "MODEL_UNAVAILABLE" || error.code === "CODEX_AUTH_REQUIRED") retrySettings.hidden = false;
		} finally {
			retryButton.disabled = false;
		}
	});
	if (waiting) return watchExam(container, exam, options.reload);
}

function attachments(files) {
	if (!files.length) return empty("没有可查看的原卷附件。");
	return `<label class="field">页面或文件<select id="attachment-picker" aria-label="原卷页面或文件">${files.map((file, index) => option(file.id, `${index + 1}. ${file.name}`, files[0].id)).join("")}</select></label><div id="attachment-view" class="stack"></div>`;
}

function bindAttachments(container, files, page) {
	const picker = container.querySelector("#attachment-picker");
	const view = container.querySelector("#attachment-view");
	if (!picker) return;
	if (page && files[page - 1] && files.every((file) => file.mimeType.startsWith("image/"))) picker.selectedIndex = page - 1;
	function show() {
		const file = files.find((entry) => entry.id === picker.value);
		const url = new URL(file.url, location.origin);
		if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return;
		if (page && files.length === 1 && file.mimeType === "application/pdf") url.hash = `page=${page}`;
		const source = escape(url.href);
		const fileName = escape(file.name);
		view.innerHTML = `${file.mimeType === "application/pdf" ? `<iframe class="original pdf" src="${source}" title="${fileName}"></iframe>` : `<img class="original" src="${source}" alt="试卷附件 ${fileName}" />`}
			<div><a class="button secondary" href="${source}" target="_blank" rel="noopener">打开原件</a></div>`;
	}
	picker.addEventListener("change", show);
	show();
}

function regradeReport(report, examId, previous) {
	const { completedAt, changes, pageIssues, newItemCount, retainedItemCount } = report;
	const changed = changes.filter(({ kind }) => kind === "changed").length;
	const added = changes.filter(({ kind }) => kind === "added").length;
	const summary = [newItemCount ? `本轮识别 ${newItemCount} 题` : "本轮未识别出题目",
		changed ? `变更 ${changed} 题` : "", added ? `新增 ${added} 题` : "",
		retainedItemCount ? `沿用 ${retainedItemCount} 题` : "", pageIssues.length ? `${pageIssues.length} 页需检查` : ""]
		.filter(Boolean).join(" · ");
	return `<details class="details-card"><summary>${previous ? "上一次重新批改对比" : "重新批改对比"} <span class="muted small">${escape(summary)}</span></summary>
		<div class="stack"><p class="muted small">完成于 <time datetime="${escape(completedAt)}">${escape(regradeTime.format(new Date(completedAt)))}</time></p>
		${pageIssues.map(({ page, message }) => `<p class="notice text-wrap">第 ${escape(page)} 页 · ${escape(message)}</p>`).join("")}
		${changes.length ? `<ul class="list regrade-list">${changes.map((change) => regradeRow(change, examId)).join("")}</ul>` : "<p>逐题结果与上一版一致。</p>"}</div></details>`;
}

function regradeRow(change, examId) {
	const { itemId, page, number } = change;
	const title = `${page == null ? "" : `第 ${page} 页 · `}第 ${number} 题`;
	const link = `<a class="text-wrap" href="#exams/${examId}?item=${encodeURIComponent(itemId)}">${escape(title)}</a>`;
	let result;
	if (change.kind === "changed") {
		const { before, after, fields } = change;
		const withScore = before.maxScore != null || after.maxScore != null;
		const edits = fields.filter((field) => Object.hasOwn(regradeFields, field)).map((field) => regradeFields[field]);
		result = `<p class="row small"><span>上一版</span> ${regradeVerdict(before, withScore)} <span aria-hidden="true">→</span>
			<span>本轮</span> ${regradeVerdict(after, withScore)}</p>${edits.length ? `<p class="muted small">${edits.join("、")}已更新</p>` : ""}`;
	} else if (change.kind === "added") {
		result = `<p class="row small"><span>本轮新增</span> ${regradeVerdict(change.after, change.after.maxScore != null)}</p>`;
	} else {
		result = `<p class="row small"><span>本轮未匹配，沿用上一版</span> ${regradeVerdict(change.before, change.before.maxScore != null)}</p>`;
	}
	return `<li class="list-row"><div>${link}${result}</div></li>`;
}

function regradeVerdict(result, withScore) {
	const points = withScore ? `<span class="muted">${result.maxScore == null ? "未记录分值" : scoreText(result)}</span>` : "";
	return `${verdictStatus(result.verdict)}${points}`;
}

function scoreText({ score, maxScore }) {
	return score == null ? `原题 ${scoreLabel(maxScore)} 分` : `${scoreLabel(score)} / ${scoreLabel(maxScore)} 分`;
}

function readItem(exam, item, skillLabels, { index, open, canCorrect, canTutor, prior }) {
	const tutor = `#tutor?exam=${encodeURIComponent(exam.id)}&item=${encodeURIComponent(item.id)}&subject=${exam.subject}`;
	const points = item.maxScore == null ? "" : `<span class="muted small">${scoreText(item)}</span>`;
	const verdict = item.verdict ?? "uncertain";
	const selected = item.ignored ? "ignore" : verdict;
	const ignored = item.ignored ? '<span class="status">已忽略</span>' : "";
	const carriedOver = prior && verdict === prior.verdict && item.score === prior.score && item.maxScore === prior.maxScore
		? '<span class="status pending">沿用上一版</span>' : "";
	const correction = canCorrect ? `<details class="details-card"><summary>改判</summary><div><form id="correct-verdict-${index}" class="stack">
		<label class="row">判定<select name="verdict">${Object.entries(verdictLabels).map(([key, label]) => option(key, label, selected)).join("")}${option("ignore", "忽略", selected)}</select></label>
		<p class="muted small">${item.ignored ? "选择「错误」可恢复收录到错题本。" : "忽略后，错题本和复练选题会跳过本题。"}</p>
		<p class="form-error" role="alert"></p><div><button class="button secondary" type="submit">保存改判</button></div></form></div></details>` : "";
	const details = `<details class="details-card" id="exam-item-${index}"${open ? " open" : ""}><summary>第 ${escape(item.number)} 题 ${verdictStatus(verdict)} ${points} ${ignored} ${carriedOver}</summary><div class="stack">
		<p class="text-wrap">${escape(item.prompt)}</p>
		<dl class="facts">${fact("作答", item.response)}${fact("知识点", skillLabels.get(item.skillId))}${fact("参考答案", item.referenceAnswer)}${fact("批改说明", item.feedback)}${fact("错因", verdict === "incorrect" ? item.errorCause : "")}${fact("原卷依据", [item.page == null ? "" : `第 ${item.page} 页`, item.evidence].filter(Boolean).join(" · "))}${fact("评分细则", item.maxScore == null ? "" : item.rubric)}</dl>
		${canTutor ? `<div><a class="button secondary" href="${tutor}">问这道题</a></div>` : ""}${correction}</div></details>`;
	if (verdict === "correct" || !exam.attachments.length) return details;
	const label = `第 ${escape(item.number)} 题`;
	const imagePath = `/exams/${encodeURIComponent(exam.id)}/items/${encodeURIComponent(item.id)}/image`;
	const source = exam.hasPublishedResult && item.page != null
		? ` data-image-path="${escape(imagePath)}" data-image-page="${escape(item.page)}" data-image-available="${Boolean(item.imageRegion)}" data-image-label="${label} · 原题截图"` : "";
	return `<div class="exam-item-source"><button class="button plain small" type="button" data-question-preview${source}
		aria-label="查看原题 · ${label}"${source ? ' aria-haspopup="dialog"' : ""}>查看原题</button>${details}</div>`;
}

function fact(label, value) {
	return value ? `<dt>${label}</dt><dd class="text-wrap">${escape(value)}</dd>` : "";
}

function watchExam(container, exam, reload) {
	const id = encodeURIComponent(exam.id);
	const source = new EventSource(`/api/exams/${id}/events`);
	const status = container.querySelector("#paper-status");
	function show(summary) {
		if (summary.status === "queued" || summary.status === "processing") status.innerHTML = examStatus(summary.status);
		else reload();
	}
	source.addEventListener("status", (event) => show(JSON.parse(event.data)));
	const check = window.setInterval(() => read(`/exams/${id}`).then(show).catch(() => {}), 12000);
	return () => {
		source.close();
		window.clearInterval(check);
	};
}
