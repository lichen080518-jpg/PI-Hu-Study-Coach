import { send } from "./api.js";
import { escape } from "./ui.js";

const pageScale = 1000;
const minSide = 10;
const maxArea = 980000;

export function createQuestionImages(container, list, canCrop, notice) {
	const revisions = new Map();
	const openViewer = createQuestionImageViewer(container, (group) => {
		const revision = Date.now();
		revisions.set(group.dataset.imagePath, revision);
		group.dataset.imageAvailable = "true";
		group.dataset.imageRevision = revision;
		showScreenshot(group);
		notice("已保存错题截图。");
	});

	list.addEventListener("toggle", ({ target }) => {
		if (!target.open) return;
		const group = target.querySelector("[data-image-path]");
		if (group?.dataset.imageAvailable === "true") showScreenshot(group);
	}, true);
	list.addEventListener("click", ({ target }) => {
		const action = target.closest("[data-image-action]");
		if (action) openViewer(action.closest("[data-image-path]"), action.dataset.imageAction);
	});
	list.addEventListener("error", ({ target }) => {
		const figure = target.closest("[data-screenshot]");
		if (!figure) return;
		target.hidden = true;
		figure.querySelector("[data-screenshot-error]").hidden = false;
	}, true);

	return ({ examId, itemId, sourcePage, hasScreenshot }) => {
		if (!examId || sourcePage == null) return "";
		const path = `/exams/${encodeURIComponent(examId)}/items/${encodeURIComponent(itemId)}/image`;
		const revision = revisions.get(path) ?? "";
		return `<div class="stack" data-image-path="${escape(path)}" data-image-page="${escape(sourcePage)}"
			data-image-available="${hasScreenshot || revisions.has(path)}" data-image-revision="${revision}">
			<figure class="question-screenshot" data-screenshot hidden><figcaption class="small">原错题截图</figcaption>
				<img alt="原错题截图" /><p class="muted small" data-screenshot-error hidden>截图加载失败，请查看原卷对应页。</p>
			</figure>
			<div class="row">
				<button class="button secondary" type="button" data-image-action="preview">查看原卷第 ${escape(sourcePage)} 页</button>
				${canCrop ? '<button class="button plain" type="button" data-image-action="crop">裁剪错题截图</button>' : ""}
			</div>
		</div>`;
	};
}

function showScreenshot(group) {
	const figure = group.querySelector("[data-screenshot]");
	const image = figure.querySelector("img");
	const { imagePath, imageRevision } = group.dataset;
	const url = `/api${imagePath}${imageRevision ? `?rev=${imageRevision}` : ""}`;
	figure.hidden = false;
	if (image.getAttribute("src") === url && !image.hidden) return;
	figure.querySelector("[data-screenshot-error]").hidden = true;
	image.hidden = false;
	image.src = url;
}

/** Opens a question's screenshot, full page, or crop editor in the shared preview dialog. */
export function createQuestionImageViewer(container, onSave) {
	const dialog = document.createElement("dialog");
	dialog.className = "question-image-dialog";
	dialog.setAttribute("aria-labelledby", "question-image-title");
	dialog.innerHTML = `<div class="stack">
		<h2 id="question-image-title"></h2>
		<p class="muted small" data-crop-help hidden>在原卷上拖动框选，或依次点选截图区域的两个对角。</p>
		<p class="muted small" data-image-status role="status"></p>
		<div class="question-image-stage" hidden><img draggable="false" alt="原卷页面" /><div class="question-image-box" aria-hidden="true" hidden></div></div>
		<p class="form-error" role="alert"></p>
		<div class="row"><button class="button primary" type="button" data-save-crop hidden disabled>保存截图</button>
			<button class="button secondary" type="button" data-view-page hidden>查看整页</button>
			<form method="dialog"><button class="button secondary" type="submit" autofocus>关闭</button></form></div>
	</div>`;
	container.append(dialog);
	const stage = dialog.querySelector(".question-image-stage");
	const image = stage.querySelector("img");
	const box = stage.querySelector(".question-image-box");
	const save = dialog.querySelector("[data-save-crop]");
	const fullPage = dialog.querySelector("[data-view-page]");
	const close = dialog.querySelector('form[method="dialog"] button');
	const title = dialog.querySelector("h2");
	const help = dialog.querySelector("[data-crop-help]");
	const status = dialog.querySelector("[data-image-status]");
	const error = dialog.querySelector(".form-error");
	let view;
	let start;
	let corner;
	let region;

	function draw(value) {
		box.hidden = !value?.width || !value?.height;
		if (box.hidden) return;
		box.style.left = `${value.x / 10}%`;
		box.style.top = `${value.y / 10}%`;
		box.style.width = `${value.width / 10}%`;
		box.style.height = `${value.height / 10}%`;
	}

	function select(value) {
		region = value;
		save.disabled = !value;
		draw(value);
	}

	function loadImage(mode) {
		const { group, page } = view;
		view.mode = mode;
		const screenshot = mode === "screenshot";
		const label = screenshot ? group.dataset.imageLabel : `原卷第 ${page} 页`;
		title.textContent = mode === "crop" ? `裁剪${label}` : label;
		image.alt = label;
		fullPage.hidden = !screenshot;
		stage.hidden = true;
		status.textContent = `正在加载${label}…`;
		image.src = `/api${group.dataset.imagePath}${screenshot ? "" : "?view=page"}`;
	}

	image.addEventListener("load", () => {
		status.textContent = "";
		stage.hidden = false;
	});
	image.addEventListener("error", () => {
		if (view?.mode === "screenshot") {
			loadImage("preview");
			return;
		}
		status.textContent = "原卷页面加载失败。";
		stage.hidden = true;
	});
	fullPage.addEventListener("click", () => {
		loadImage("preview");
		close.focus();
	});
	stage.addEventListener("pointerdown", (event) => {
		if (view?.mode !== "crop" || view.saving || !event.isPrimary || event.button !== 0) return;
		start = pagePoint(event, image);
		stage.setPointerCapture(event.pointerId);
	});
	stage.addEventListener("pointermove", (event) => {
		if (start && event.isPrimary) draw(bounds(start, pagePoint(event, image)));
	});
	stage.addEventListener("pointercancel", () => {
		start = undefined;
		draw(region);
	});
	stage.addEventListener("pointerup", (event) => {
		if (!start || !event.isPrimary) return;
		const end = pagePoint(event, image);
		const dragged = Math.hypot(start.x - end.x, start.y - end.y) >= minSide;
		const first = dragged ? start : corner;
		start = undefined;
		error.textContent = "";
		if (!first) {
			corner = end;
			select(undefined);
			status.textContent = "已选第一个角，请点选对角。";
			return;
		}
		corner = undefined;
		const value = bounds(first, end);
		const valid = value.width >= minSide && value.height >= minSide && value.width * value.height <= maxArea;
		select(valid ? value : undefined);
		status.textContent = valid ? "已选定截图区域。" : "请框选能包含完整题目的区域。";
	});
	save.addEventListener("click", async () => {
		if (!view || !region || view.saving) return;
		const active = view;
		active.saving = true;
		save.disabled = true;
		error.textContent = "";
		try {
			await send(active.group.dataset.imagePath, "PUT", { page: active.page, region });
			onSave?.(active.group);
			if (view === active) dialog.close();
		} catch (failure) {
			if (view === active) error.textContent = failure.message;
		} finally {
			active.saving = false;
			if (view === active) save.disabled = !region;
		}
	});
	dialog.addEventListener("close", () => {
		if (dialog.open) return;
		view = undefined;
		image.removeAttribute("src");
	});

	return (group, mode) => {
		const crop = mode === "crop";
		view = { group, page: Number(group.dataset.imagePage), mode };
		help.hidden = !crop;
		save.hidden = !crop;
		stage.toggleAttribute("data-cropping", crop);
		error.textContent = "";
		start = undefined;
		corner = undefined;
		select(undefined);
		loadImage(mode);
		dialog.showModal();
	};
}

function pagePoint({ clientX, clientY }, image) {
	const frame = image.getBoundingClientRect();
	const unit = (value) => Math.round(Math.min(1, Math.max(0, value)) * pageScale);
	return { x: unit((clientX - frame.left) / frame.width), y: unit((clientY - frame.top) / frame.height) };
}

function bounds(a, b) {
	return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}
