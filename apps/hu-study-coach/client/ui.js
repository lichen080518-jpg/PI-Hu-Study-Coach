import { read } from "./api.js";

export const subjects = { chinese: "语文", math: "数学", english: "英语" };
export const difficulties = { basic: "基础", standard: "常规", transfer: "迁移" };
export const modes = { review: "错题复练", assessment: "独立短测" };
export const verdictLabels = { correct: "正确", incorrect: "错误", uncertain: "待确认" };

const dateFormatter = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", timeZone: "Asia/Shanghai" });
const scoreFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const examStatuses = {
	queued: ["待处理", "pending"],
	processing: ["批改中", "pending"],
	review: ["等待批改", "pending"],
	published: ["已批改", "good"],
	failed: ["批改失败", "error"],
};
const verdictColors = { correct: "good", incorrect: "error", uncertain: "pending" };
const recordDeletion = {
	exams: { label: "试卷", impact: "原卷附件、批改结果和对应错题会一并删除。" },
	worksheets: { label: "练习卷", impact: "本卷的在线作答会一并删除。如有关联纸卷，会解除关联。" },
};

export function escape(value) {
	return String(value ?? "").replace(/[&<>"']/g, (character) => ({
		"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
	})[character]);
}

export function dateLabel(date) {
	return date ? dateFormatter.format(new Date(date)) : "—";
}

export function scoreLabel(score) {
	return score == null ? "—" : scoreFormatter.format(score);
}

export function subjectOptions(selected, includeAll = false) {
	return `${includeAll ? '<option value="">全部科目</option>' : ""}${Object.entries(subjects).map(([id, label]) => option(id, label, selected)).join("")}`;
}

export function option(id, label, selected) {
	return `<option value="${escape(id)}"${id === selected ? " selected" : ""}>${escape(label)}</option>`;
}

export function examStatus(status) {
	const [label, color] = examStatuses[status] ?? ["待处理", "pending"];
	return `<span class="status ${color}">${label}</span>`;
}

export function examCounts({ correctCount, incorrectCount, uncertainCount }) {
	if (!(correctCount || incorrectCount || uncertainCount)) return "";
	return `<span class="row">${verdictStatus("correct", correctCount)}${verdictStatus("incorrect", incorrectCount)}${uncertainCount ? verdictStatus("uncertain", uncertainCount) : ""}</span>`;
}

export function verdictStatus(verdict, count) {
	const label = verdictLabels[verdict] ?? verdictLabels.uncertain;
	return `<span class="status ${verdictColors[verdict] ?? verdictColors.uncertain}">${label}${count == null ? "" : ` ${escape(count)} 题`}</span>`;
}

export function pageHeader(title, description = "", actions = "") {
	return `<header class="page-head"><div><h1>${escape(title)}</h1>${description ? `<p>${escape(description)}</p>` : ""}</div>${actions}</header>`;
}

export function empty(message) {
	return `<p class="state">${escape(message)}</p>`;
}

export function table(columns, rows, message) {
	if (!rows.length) return empty(message);
	return `<div class="table-wrap" tabindex="0"><table><thead><tr>${columns.map((column) => `<th scope="col">${escape(column)}</th>`).join("")}</tr></thead>
		<tbody>${rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

export function deleteRecordButton(type, record) {
	const { label } = recordDeletion[type];
	const processing = type === "exams" && record.status === "processing";
	return `<button type="button" class="button destructive" data-delete-record="${escape(record.id)}" data-record-title="${escape(record.title)}"
		aria-label="删除${label} ${escape(record.title)}"${processing ? ' disabled title="批改完成后可删除"' : ""}>删除</button>`;
}

export function bindRecordDeletion(container, type, notice, onDeleted) {
	const { label, impact } = recordDeletion[type];
	const buttons = [...container.querySelectorAll("[data-delete-record]")];
	for (const button of buttons) {
		button.addEventListener("click", async () => {
			const { deleteRecord: id, recordTitle } = button.dataset;
			if (button.disabled || !window.confirm(`永久删除《${recordTitle}》？${impact}`)) return;
			const available = buttons.filter((entry) => !entry.disabled);
			for (const entry of available) entry.disabled = true;
			button.textContent = "删除中…";
			try {
				await read(`/${type}/${encodeURIComponent(id)}`, { method: "DELETE" });
				if (button.isConnected) {
					notice(`${label}已删除。`);
					await onDeleted();
				}
			} catch (error) {
				if (button.isConnected) notice(error.message);
			} finally {
				for (const entry of available) entry.disabled = false;
				button.textContent = "删除";
			}
		});
	}
}

export function bindForm(container, selector, handler) {
	const form = container.querySelector(selector);
	form?.addEventListener("submit", async (event) => {
		event.preventDefault();
		const buttons = Array.from(form.querySelectorAll('button[type="submit"]')).filter((button) => !button.disabled);
		const feedback = form.querySelector(".form-error");
		if (feedback) feedback.textContent = "";
		for (const button of buttons) button.disabled = true;
		form.setAttribute("aria-busy", "true");
		try {
			await handler(new FormData(form), event.submitter);
		} catch (error) {
			if (feedback) feedback.textContent = error.message;
		} finally {
			for (const button of buttons) button.disabled = false;
			form.removeAttribute("aria-busy");
		}
	});
}
