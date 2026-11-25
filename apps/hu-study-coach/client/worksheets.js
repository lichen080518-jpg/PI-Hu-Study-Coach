import { send } from "./api.js";
import { bindForm, bindRecordDeletion, dateLabel, deleteRecordButton, difficulties, empty, escape, examStatus, modes, option, pageHeader, scoreLabel, subjectOptions, subjects, table } from "./ui.js";

const maxSelectedWrong = 40;

export function renderWorksheets(container, { worksheets, wrong, exams }, session, { notice, reload }) {
	const reviewSubject = wrong.find((item) => !item.mastered)?.subject;
	const mode = reviewSubject ? "review" : "assessment";
	const paperBySheet = new Map(exams.map((exam) => [exam.worksheetId, exam.status]));
	const reviewer = session.role === "reviewer";
	container.innerHTML = `<div class="page">${pageHeader("复练卷", "根据错因安排复练，用独立短测观察变化。")}
		<div class="two-column"><section class="panel"><h2>练习卷</h2>
			${table(["试卷", "类型", "题量", "生成日期", "状态", ...(reviewer ? ["操作"] : [])], worksheets.map((sheet) => {
				const id = encodeURIComponent(sheet.id);
				return [
					`<a href="#practice/${id}">${escape(sheet.title)}</a><div><a class="button plain" href="/api/worksheets/${id}/pdf/student?download=1">导出 PDF</a></div>`,
					modes[sheet.mode], sheet.questionCount, dateLabel(sheet.createdAt),
					sheet.submitted ? '<span class="status good">已提交</span>' : paperBySheet.has(sheet.id) ? examStatus(paperBySheet.get(sheet.id)) : '<span class="status pending">待作答</span>',
					...(reviewer ? [deleteRecordButton("worksheets", sheet)] : []),
				];
			}), "暂无练习卷。可按科目手动生成。")}</section>
			<section class="panel"><h2>生成练习</h2><form id="generate" class="stack"><fieldset class="plain-fieldset stack">
			<label class="field">科目<select name="subject" aria-label="科目">${subjectOptions(reviewSubject ?? "math")}</select></label>
			<label class="field">类型<select name="mode" aria-label="类型">${Object.entries(modes).map(([id, label]) => option(id, label, mode)).join("")}</select></label>
			<label class="field" id="review-selection">选题方式<select name="selection"><option value="auto">自动选题</option><option value="manual">手动勾选错题</option></select></label>
			<p class="muted small" id="generation-help"></p>
			<fieldset id="wrong-selection" class="plain-fieldset stack" hidden><legend>原错题</legend>
				<div class="row between"><p class="muted small" id="wrong-selection-count" aria-live="polite"></p><div class="row">
					<button class="button plain" type="button" id="select-all-wrong">全选</button><button class="button plain" type="button" id="clear-wrong-selection">清空</button>
				</div></div><div class="wrong-choices" id="wrong-choices"></div>
			</fieldset></fieldset>
			<p class="form-error" role="alert"></p><div><button class="button primary" type="submit">生成练习卷</button></div></form></section></div></div>`;
	if (reviewer) bindRecordDeletion(container, "worksheets", notice, reload);
	const form = container.querySelector("#generate");
	const controls = form.querySelector("fieldset");
	bindWrongSelection(form, wrong, exams, worksheets);
	bindForm(container, "#generate", async (data) => {
		const subject = data.get("subject");
		const mode = data.get("mode");
		const payload = { subject, mode };
		if (mode === "review" && data.get("selection") === "manual") {
			const wrongIds = data.getAll("wrongIds");
			if (!wrongIds.length) throw new Error("请至少勾选一道同科目的错题。");
			payload.wrongIds = wrongIds;
		}
		const button = form.querySelector('button[type="submit"]');
		const label = button.textContent;
		button.textContent = "正在生成练习卷…";
		controls.disabled = true;
		try {
			const worksheet = await send("/worksheets", "POST", payload);
			if (form.isConnected) location.hash = `practice/${encodeURIComponent(worksheet.id)}`;
		} finally {
			controls.disabled = false;
			button.textContent = label;
		}
	});
}

function bindWrongSelection(form, wrong, exams, worksheets) {
	const titles = new Map([...exams, ...worksheets].map(({ id, title }) => [id, title]));
	const { subject, mode, selection } = form.elements;
	const method = form.querySelector("#review-selection");
	const picker = form.querySelector("#wrong-selection");
	const list = form.querySelector("#wrong-choices");
	const count = form.querySelector("#wrong-selection-count");
	const selectAll = form.querySelector("#select-all-wrong");
	const clear = form.querySelector("#clear-wrong-selection");
	const help = form.querySelector("#generation-help");
	let choices = [];

	function updateCount() {
		const selected = choices.filter((choice) => choice.checked).length;
		count.textContent = `已选 ${selected} 道 · 共 ${choices.length} 道${choices.length > maxSelectedWrong ? ` · 每卷最多 ${maxSelectedWrong} 道` : ""}`;
		selectAll.textContent = choices.length > maxSelectedWrong ? `选前 ${maxSelectedWrong} 道` : "全选";
		selectAll.disabled = selected === Math.min(choices.length, maxSelectedWrong);
		clear.disabled = selected === 0;
		for (const choice of choices) choice.disabled = !choice.checked && selected >= maxSelectedWrong;
	}

	function updateSubject() {
		const items = wrong.filter((item) => item.subject === subject.value && (item.examId || item.worksheetId));
		list.innerHTML = items.length ? items.map((item) => {
			const sourceId = item.examId ?? item.worksheetId;
			const source = titles.get(sourceId) || (item.examId ? "原卷" : "练习卷");
			const page = item.sourcePage == null ? "" : ` · 第 ${item.sourcePage} 页`;
			return `<label class="wrong-choice"><input type="checkbox" name="wrongIds" value="${escape(`${sourceId}:${item.itemId}`)}" />
				<span><span class="muted small">${escape(`${source}${page} · ${item.number} 题`)}</span>
				<span class="text-wrap">${escape(item.prompt)}</span></span></label>`;
		}).join("") : empty("这个科目暂无错题。");
		choices = [...list.querySelectorAll('input[type="checkbox"]')];
		updateCount();
	}

	function updateMode() {
		const review = mode.value === "review";
		const manual = review && selection.value === "manual";
		method.hidden = !review;
		picker.hidden = !manual;
		help.textContent = !review ? "独立短测按固定考点、难度和分值出新题。" : manual
			? "每道勾选的错题对应一道新练习题。"
			: "自动选题优先安排到期错题，每卷最多 6 题。";
	}

	subject.addEventListener("change", updateSubject);
	mode.addEventListener("change", updateMode);
	selection.addEventListener("change", updateMode);
	list.addEventListener("change", updateCount);
	selectAll.addEventListener("click", () => {
		for (const [index, choice] of choices.entries()) choice.checked = index < maxSelectedWrong;
		updateCount();
	});
	clear.addEventListener("click", () => {
		for (const choice of choices) choice.checked = false;
		updateCount();
	});
	updateSubject();
	updateMode();
}

export function renderWorksheet(container, sheet, session, skills, options) {
	const id = encodeURIComponent(sheet.id);
	const submitted = sheet.attempt !== null;
	const reviewer = session.role === "reviewer";
	const canGrade = submitted && reviewer;
	const paper = sheet.paperExam;
	const paperPublished = paper?.hasPublishedResult ?? (paper?.status === "published");
	const skillLabels = new Map(skills.map((skill) => [skill.id, skill.label]));
	const uncovered = sheet.uncoveredSkillIds.map((skill) => skillLabels.get(skill) ?? skill);
	container.innerHTML = `<div class="page">
		${pageHeader(sheet.title, `${subjects[sheet.subject]} · ${modes[sheet.mode]} · ${sheet.questionCount} 题`,
			`<div class="row"><a class="button secondary" href="#practice">返回练习列表</a>${reviewer ? deleteRecordButton("worksheets", sheet) : ""}</div>`)}
		<div class="row">
			<a class="button primary" href="/api/worksheets/${id}/pdf/student?download=1">导出学生卷 PDF</a>
			<a class="button secondary" href="/api/worksheets/${id}/pdf/student" target="_blank" rel="noopener">预览学生卷 PDF</a>
			${submitted || paperPublished || session.role === "reviewer" ? `<a class="button secondary" href="/api/worksheets/${id}/pdf/solutions" target="_blank" rel="noopener">答案与解析 PDF</a>` : ""}
			${submitted || paper ? "" : `<a class="button secondary" href="#exams/upload?worksheet=${id}">上传纸面作答</a>`}
		</div>
		${uncovered.length ? `<p class="notice">这份练习卷未覆盖 ${escape(uncovered.join("、"))}。</p>` : ""}
		${paper ? `<section class="panel"><div class="panel-head"><h2>纸面作答</h2>${examStatus(paper.status)}</div><div><a class="button secondary" href="#exams/${encodeURIComponent(paper.id)}">查看纸卷批改</a></div></section>` : ""}
		<section class="panel"><h2>${submitted ? "作答结果" : "在线作答"}</h2>
			${submitted ? results(sheet, canGrade) : paper ? empty("本卷已回传纸面作答。可另生成一份独立短测进行在线测验。") : attemptForm(sheet, session.role)}
		</section>
	</div>`;
	if (reviewer) bindRecordDeletion(container, "worksheets", options.notice, () => { location.hash = "practice"; });
	bindForm(container, "#worksheet-attempt", async (data) => {
		const responses = sheet.questions.map((question) => ({ questionId: question.id, response: data.get(question.id)?.trim() ?? "" }));
		await send(`/worksheets/${id}/attempts`, "POST", { responses, assisted: data.has("assisted") });
		options.notice("作答已提交。");
		await options.reload();
	});
	bindForm(container, "#grade-attempt", async (data) => {
		const items = sheet.attempt.items.flatMap((item) => {
			const { questionId } = item;
			const value = data.get(`score-${questionId}`);
			if (value === null || value === "") return [];
			const score = Number(value);
			const feedback = data.get(`feedback-${questionId}`).trim();
			return score === item.score && feedback === item.feedback ? [] : [{ questionId, score, feedback }];
		});
		if (!items.length) throw new Error("请录入或修改至少一道题的评分。");
		await send(`/worksheets/${id}/attempts/grade`, "PUT", { items });
		options.notice("复核评分已保存。");
		await options.reload();
	});
}

function attemptForm(sheet, role) {
	if (!sheet.questions.length) return empty("这份卷没有可用题目。");
	return `<form id="worksheet-attempt" class="stack">
		${sheet.questions.map((question, index) => `<div class="details-card"><div class="stack"><h3>第 ${index + 1} 题 · ${escape(difficulties[question.difficulty])} · ${scoreLabel(question.maxScore)} 分</h3>
			<p class="text-wrap">${escape(question.prompt)}</p><label class="field">你的作答<textarea name="${escape(question.id)}" rows="3" maxlength="8000"></textarea></label>
		</div></div>`).join("")}
		<label class="row"><input type="checkbox" name="assisted" />做题时看过提示、答案或得到帮助</label>
		<p class="muted small">${role === "reviewer" ? "学生账号独立完成的有效短测才计入独立短测趋势。" : "提交后保留本次作答记录，开放题可能需要复核。"}</p>
		<p class="form-error" role="alert"></p><div><button type="submit" class="button primary">提交作答</button></div>
	</form>`;
}

function results(sheet, canGrade) {
	const attempts = new Map(sheet.attempt.items.map((item) => [item.questionId, item]));
	const questions = sheet.questions.map((question, index) => {
		const item = attempts.get(question.id);
		const id = escape(question.id);
		const adjustment = canGrade && `<label class="field">复核得分<input type="number" name="score-${id}" min="0" max="${question.maxScore}" step="any" value="${escape(item?.score)}" /></label><label class="field">复核反馈<textarea name="feedback-${id}" rows="2" maxlength="6000">${escape(item?.feedback)}</textarea></label>`;
		return `<div class="details-card"><div class="stack"><div class="row between"><h3>第 ${index + 1} 题</h3>${item?.score == null ? '<span class="status pending">待复核</span>' : `<span class="status good">${scoreLabel(item.score)} / ${scoreLabel(question.maxScore)} 分</span>`}</div>
			<p class="text-wrap">${escape(question.prompt)}</p><dl class="facts"><dt>作答</dt><dd class="text-wrap">${escape(item?.response || "（空白）")}</dd>
			${item?.referenceAnswer ? `<dt>参考答案</dt><dd class="text-wrap">${escape(item.referenceAnswer)}</dd>` : ""}${item?.rubric ? `<dt>评分细则</dt><dd class="text-wrap">${escape(item.rubric)}</dd>` : ""}${item?.feedback ? `<dt>反馈</dt><dd class="text-wrap">${escape(item.feedback)}</dd>` : ""}</dl>
			${adjustment ? `<details${item?.score == null ? " open" : ""}><summary>复核评分</summary><div class="stack">${adjustment}</div></details>` : ""}</div></div>`;
	}).join("");
	if (!canGrade) return questions;
	return `<form class="stack" id="grade-attempt">${questions}<p class="form-error" role="alert"></p><div><button type="submit" class="button primary">保存复核评分</button></div></form>`;
}
