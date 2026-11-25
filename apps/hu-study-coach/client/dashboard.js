import { createQuestionImages } from "./question-image.js";
import { dateLabel, empty, escape, examCounts, examStatus, pageHeader, scoreLabel, subjectOptions, subjects, table } from "./ui.js";

export function renderOverview(container, dashboard, session) {
	const { exams, wrong, worksheets, trend, reviewCount } = dashboard;
	const finished = exams.filter((exam) => exam.status === "published");
	const recent = exams.slice(0, 5);
	const paperIds = new Set(exams.map((exam) => exam.worksheetId));
	const unfinished = worksheets.filter((sheet) => !sheet.submitted && !paperIds.has(sheet.id)).slice(0, 5);
	const subject = trend.at(-1)?.subject ?? "math";
	container.innerHTML = `<div class="page">
		${pageHeader("学习总览", "查看批改结果、常见错因和独立短测的变化。")}
		<section class="hero"><div><h2>上传作业自动批改</h2><p>查看逐题对错和错因，错题自动收录。</p></div><a class="button primary" href="#exams/upload">上传试卷</a></section>
		<div class="metrics"><div class="metric"><b>${finished.length}</b><span>已批改试卷</span></div><div class="metric"><b>${wrong.filter((item) => !item.mastered).length}</b><span>待巩固错题</span></div><div class="metric"><b>${session.role === "reviewer" ? reviewCount : exams.filter((exam) => exam.status === "review").length}</b><span>待处理批改</span></div></div>
		<div class="two-column">
			<section class="panel"><div class="panel-head"><div><h2>独立短测趋势</h2><p>按照同一科目的固定题型结构比较</p></div><div class="row"><label class="row">科目 <select id="trend-subject" aria-label="趋势科目">${subjectOptions(subject)}</select></label><label class="row">指标 <select id="trend-measure" aria-label="趋势指标"><option value="correct">正确率</option><option value="missed">失分题率</option></select></label></div></div>
				<div id="trend-view" class="stack"></div>
			</section>
			<section class="panel"><div class="panel-head"><h2>待做练习</h2><a class="button plain" href="#practice">查看全部</a></div>
				${unfinished.length ? `<div class="list">${unfinished.map((sheet) => `<div class="list-row"><div><a href="#practice/${encodeURIComponent(sheet.id)}">${escape(sheet.title)}</a><p class="muted small">${subjects[sheet.subject]} · ${sheet.questionCount} 题</p></div></div>`).join("")}</div>` : empty("暂无待做练习。可以在复练卷页生成练习。")}
			</section>
		</div>
		<section class="panel"><div class="panel-head"><h2>最近试卷</h2><a class="button plain" href="#exams">全部试卷</a></div>${examTable(recent)}</section>
	</div>`;
	const selector = container.querySelector("#trend-subject");
	const measure = container.querySelector("#trend-measure");
	const trendView = container.querySelector("#trend-view");
	let observer;
	function updateTrend() {
		observer?.disconnect();
		observer = renderTrend(trendView, trend.filter((point) => point.subject === selector.value).sort((a, b) => a.date.localeCompare(b.date)), measure.value);
	}
	selector.addEventListener("change", updateTrend);
	measure.addEventListener("change", updateTrend);
	updateTrend();
	return () => observer?.disconnect();
}

export function examTable(exams, rowAction) {
	return table(["试卷", "科目", "上传日期", "状态", "批改结果", ...(rowAction ? ["操作"] : [])], exams.map((exam) => [
		`<a href="#exams/${encodeURIComponent(exam.id)}">${escape(exam.title)}</a>`,
		subjects[exam.subject], dateLabel(exam.createdAt), examStatus(exam.status),
		examCounts(exam) || "—",
		...(rowAction ? [rowAction(exam)] : []),
	]), "暂无试卷。上传照片或 PDF 后可在这里查看进度。");
}

function renderTrend(container, points, measure) {
	if (!points.length) {
		container.innerHTML = empty("暂无短测数据。提交独立短测并确认评分后，曲线会在这里出现。");
		return;
	}
	const recent = points.slice(-12);
	const last = recent.at(-1);
	const previous = recent.at(-2);
	const missed = measure === "missed";
	const metricLabel = missed ? "失分题率" : "正确率";
	const fraction = (point) => (missed ? point.total - point.correct : point.correct) / point.total;
	const difference = previous ? (fraction(last) - fraction(previous)) * 100 : null;
	const change = difference == null ? "待观察。需至少两个有完整短测记录的日期。" : `与上一个短测日相比，${metricLabel}${difference > 0 ? "上升" : difference < 0 ? "下降" : "持平"}${difference ? ` ${scoreLabel(Math.abs(difference))} 个百分点` : ""}`;
	const links = recent.some((point) => point.worksheetIds?.length);
	const columns = ["日期", `${missed ? "失分题数" : "正确题数"} / 已确认题数`, metricLabel];
	if (links) columns.push("短测记录");
	container.innerHTML = `<p class="small ${(missed ? difference > 0 : difference < 0) ? "danger" : "muted"}">${escape(change)}</p>
		<div class="chart-frame"><canvas role="img" aria-label="独立短测${metricLabel}折线，明细见下方表格"></canvas></div>
		${table(columns, [...recent].reverse().map((point) => {
			const cells = [dateLabel(point.date), `<span class="num">${missed ? point.total - point.correct : point.correct} / ${point.total}</span>`, `${scoreLabel(fraction(point) * 100)}%`];
			if (links) cells.push(point.worksheetIds?.map((id, index) => `<a href="#practice/${encodeURIComponent(id)}">第 ${index + 1} 份</a>`).join(" · ") || "—");
			return cells;
		}), "")}`;
	const canvas = container.querySelector("canvas");
	const observations = recent.map((point) => ({ date: point.date, value: fraction(point) }));
	const observer = new ResizeObserver(() => drawChart(canvas, observations, missed ? "#a33439" : "#156a52"));
	observer.observe(canvas);
	return observer;
}

function drawChart(canvas, points, color) {
	const { width, height } = canvas.getBoundingClientRect();
	if (!width) return;
	const scale = window.devicePixelRatio || 1;
	canvas.width = Math.round(width * scale);
	canvas.height = Math.round(height * scale);
	const ctx = canvas.getContext("2d");
	ctx.scale(scale, scale);
	const left = 40;
	const right = width - 17;
	const top = 14;
	const bottom = height - 27;
	const positions = points.map((point) => Date.parse(point.date));
	const firstDay = positions[0];
	const span = positions.at(-1) - firstDay;
	ctx.font = '11px "Microsoft YaHei UI", sans-serif';
	for (let percent = 0; percent <= 100; percent += 25) {
		const y = bottom - (bottom - top) * percent / 100;
		ctx.beginPath();
		ctx.strokeStyle = "#dce7e1";
		ctx.moveTo(left, y);
		ctx.lineTo(right, y);
		ctx.stroke();
		ctx.fillStyle = "#4e665e";
		ctx.textAlign = "right";
		ctx.fillText(`${percent}%`, left - 6, y + 4);
	}
	const coordinates = points.map((point, index) => ({
		x: span ? left + (right - left) * (positions[index] - firstDay) / span : (left + right) / 2,
		y: bottom - (bottom - top) * point.value,
	}));
	ctx.beginPath();
	ctx.strokeStyle = color;
	ctx.lineWidth = 2.5;
	for (const [index, { x, y }] of coordinates.entries()) {
		if (index) ctx.lineTo(x, y);
		else ctx.moveTo(x, y);
	}
	ctx.stroke();
	ctx.textAlign = "center";
	let lastLabel = -Infinity;
	for (const [index, { x, y }] of coordinates.entries()) {
		ctx.beginPath();
		ctx.fillStyle = color;
		ctx.arc(x, y, 4, 0, 2 * Math.PI);
		ctx.fill();
		if (x - lastLabel < 57 || (index !== points.length - 1 && index && coordinates.at(-1).x - x < 57)) continue;
		lastLabel = x;
		ctx.fillStyle = "#4e665e";
		ctx.fillText(points[index].date.slice(5), Math.min(x, width - 19), height - 7);
	}
}

export function renderWrong(container, { wrong, exams, worksheets }, skills, session, notice) {
	container.innerHTML = `<div class="page">${pageHeader("错题本", "按科目查看已确认的错题、复发次数和到期复练。")}
		<section class="panel"><div class="panel-head"><h2>错题记录</h2><label class="row">科目 <select id="wrong-subject" aria-label="错题科目">${subjectOptions("", true)}</select></label></div><div id="wrong-list"></div></section>
	</div>`;
	const selector = container.querySelector("#wrong-subject");
	const list = container.querySelector("#wrong-list");
	const questionImage = createQuestionImages(container, list, session.role === "reviewer", notice);
	const labels = new Map(skills.map((skill) => [skill.id, skill.label]));
	const titles = new Map([...exams, ...worksheets].map(({ id, title }) => [id, title]));
	function update() {
		const items = wrong.filter((item) => !selector.value || item.subject === selector.value);
		list.innerHTML = items.length ? `<div class="stack">${items.map((item) => {
			const exam = item.examId ? encodeURIComponent(item.examId) : null;
			const worksheet = item.worksheetId ? encodeURIComponent(item.worksheetId) : null;
			const id = encodeURIComponent(item.itemId);
			const label = labels.get(item.skillId);
			const source = titles.get(item.examId ?? item.worksheetId);
			return `<details class="details-card"><summary>${subjects[item.subject]} · ${escape(label ?? "待归类")} · ${escape(item.number)}题</summary><div class="stack">
				${source ? `<p class="muted small">${escape(source)}</p>` : ""}
				<p class="text-wrap">${escape(item.prompt)}</p>${questionImage(item)}
				<dl class="facts"><dt>错因</dt><dd class="text-wrap">${escape(item.errorCause || "待诊断")}</dd><dt>批改说明</dt><dd class="text-wrap">${escape(item.feedback || "—")}</dd><dt>出现次数</dt><dd>${item.occurrences}</dd><dt>复练</dt><dd>${item.mastered ? "已巩固" : dateLabel(item.dueAt)}</dd></dl>
				<div class="row">${exam ? `<a class="button secondary" href="#exams/${exam}?item=${id}">查看原卷</a><a class="button primary" href="#tutor?exam=${exam}&item=${id}&subject=${item.subject}">问这道题</a>` : worksheet ? `<a class="button secondary" href="#practice/${worksheet}">查看练习卷</a>` : ""}</div></div></details>`;
		}).join("")}</div>` : empty("当前科目暂无错题。判错的题目会自动收录。");
	}
	selector.addEventListener("change", update);
	update();
}
