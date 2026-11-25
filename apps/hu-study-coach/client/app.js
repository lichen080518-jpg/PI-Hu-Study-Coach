import { read, send } from "./api.js";
import { renderOverview, renderWrong } from "./dashboard.js";
import { renderModelSettings } from "./model-settings.js";
import { renderExam, renderExams, renderUpload } from "./papers.js";
import { renderTutor } from "./tutor.js";
import { bindForm, empty, pageHeader, subjects } from "./ui.js";
import { renderWorksheet, renderWorksheets } from "./worksheets.js";

const main = document.querySelector("#main");
const navigation = document.querySelector("#navigation");
const account = document.querySelector("#account");
const notices = document.querySelector("#notices");
const chats = new Map();
const sections = new Set(["overview", "exams", "errors", "practice", "tutor", "settings"]);
let session;
let skills;
let version = 0;
let cleanup;
let noticeTimer;

function notice(message) {
	const content = document.createElement("p");
	content.textContent = message;
	notices.replaceChildren(content);
	window.clearTimeout(noticeTimer);
	noticeTimer = window.setTimeout(() => notices.replaceChildren(), 3800);
}

function route() {
	const [locationPath, query = ""] = location.hash.slice(1).split("?");
	const [section, key] = locationPath.split("/");
	let id;
	try { id = key ? decodeURIComponent(key) : undefined; } catch { id = undefined; }
	return { section: sections.has(section) ? section : "overview", id, query: new URLSearchParams(query) };
}

async function renderRoute(focus = false) {
	if (!session?.role) return;
	const { section, id, query } = route();
	if (section === "settings" && session.role !== "reviewer") {
		location.replace("#overview");
		return;
	}
	const currentVersion = ++version;
	for (const link of navigation.querySelectorAll("[data-section]")) {
		if (link.dataset.section === section) link.setAttribute("aria-current", "page");
		else link.removeAttribute("aria-current");
	}
	cleanup?.();
	cleanup = undefined;
	main.setAttribute("aria-busy", "true");
	if (focus) main.innerHTML = '<p class="state" role="status">正在加载…</p>';
	const examId = query.get("exam");
	const itemId = query.get("item");
	const worksheetId = query.get("worksheet");
	const dashboardNeeded = section === "overview" || section === "errors" || ((section === "practice" || section === "exams") && !id);
	let detailRequest;
	if (section === "exams" && id && id !== "upload") detailRequest = read(`/exams/${encodeURIComponent(id)}`);
	if (section === "exams" && id === "upload" && worksheetId) detailRequest = read(`/worksheets/${encodeURIComponent(worksheetId)}`);
	if (section === "practice" && id) detailRequest = read(`/worksheets/${encodeURIComponent(id)}`);
	if (section === "tutor" && examId && itemId) detailRequest = read(`/exams/${encodeURIComponent(examId)}`);
	if (section === "settings") detailRequest = read("/model-settings");
	const sessionNeeded = section === "tutor" || (section === "exams" && id);
	try {
		const [dashboard, detail, access] = await Promise.all([
			dashboardNeeded ? read("/dashboard") : null,
			detailRequest,
			sessionNeeded ? read("/session") : null,
		]);
		if (version !== currentVersion) return;
		if (access && !access.role) return showLogin("登录已过期，请重新登录。");
		if (access) session = access;
		const options = { notice, reload: () => version === currentVersion ? renderRoute() : undefined };
		switch (section) {
			case "overview": cleanup = renderOverview(main, dashboard, session); break;
			case "errors": renderWrong(main, dashboard, skills, session, options.notice); break;
			case "exams":
				if (id === "upload") {
					const subject = query.get("subject");
					renderUpload(main, session, detail, Object.hasOwn(subjects, subject) ? subject : "math");
				} else if (id) cleanup = renderExam(main, detail, session, skills, { ...options, item: itemId });
				else renderExams(main, dashboard.exams, session, options);
				break;
			case "practice":
				if (id) renderWorksheet(main, detail, session, skills, options);
				else renderWorksheets(main, dashboard, session, options);
				break;
			case "settings":
				cleanup = renderModelSettings(main, detail, { ...options, examId, refreshSession: async () => {
					const access = await read("/session");
					if (version !== currentVersion) return;
					if (!access.role) showLogin("登录已过期，请重新登录。");
					else session = access;
				} });
				break;
			case "tutor": {
				const item = detail?.items.find((entry) => entry.id === itemId);
				cleanup = renderTutor(main, session, chats, {
					subject: detail?.subject ?? query.get("subject"), examId: item ? examId : undefined,
					itemId: item?.id, itemNumber: item?.number, examTitle: detail?.title,
				});
				break;
			}
		}
		if (focus) {
			main.focus({ preventScroll: true });
			window.scrollTo(0, 0);
		}
	} catch (error) {
		if (version !== currentVersion) return;
		if (error.status === 401) showLogin();
		else renderFailure(error, () => renderRoute());
	} finally {
		if (version === currentVersion) main.setAttribute("aria-busy", "false");
	}
}

function showLogin(message = "") {
	version += 1;
	session = null;
	skills = null;
	chats.clear();
	cleanup?.();
	cleanup = undefined;
	navigation.hidden = true;
	account.hidden = true;
	main.setAttribute("aria-busy", "false");
	main.innerHTML = `<section class="panel sign-in">${pageHeader("进入沪学伴", "上海中学生一对一学习助手")}
		<form id="sign-in" class="stack">
		<label class="field">身份<select name="role" aria-label="身份"><option value="student">学生</option><option value="reviewer">复核人</option></select></label>
		<label class="field">访问口令<input name="passcode" type="password" maxlength="200" required autocomplete="current-password" /></label>
		<p class="form-error" role="alert"></p><div><button class="button primary" type="submit">登录</button></div>
		</form></section>`;
	main.querySelector(".form-error").textContent = message;
	bindForm(main, "#sign-in", async (data) => {
		const access = await send("/login", "POST", Object.fromEntries(data));
		await showApp(access);
	});
}

async function showApp(access) {
	const catalog = await read("/skills");
	session = access;
	skills = catalog.skills;
	navigation.querySelector('[data-section="settings"]').hidden = session.role !== "reviewer";
	navigation.hidden = false;
	account.innerHTML = `<span class="small">${session.role === "reviewer" ? "复核人" : "学生"}</span><button type="button" class="button plain small">退出</button>`;
	account.hidden = false;
	account.querySelector("button").addEventListener("click", async (event) => {
		const button = event.currentTarget;
		button.disabled = true;
		try {
			await read("/logout", { method: "POST" });
			showLogin();
		} catch (error) { notice(error.message); }
		finally { button.disabled = false; }
	});
	await renderRoute(true);
}

function renderFailure(error, retry) {
	main.setAttribute("aria-busy", "false");
	main.innerHTML = `<section class="panel">${pageHeader("页面加载失败")}${empty(error.message)}<div><button type="button" class="button secondary">重试</button></div></section>`;
	main.querySelector("button").addEventListener("click", retry);
}

async function connect() {
	try {
		const access = await read("/session");
		if (access.role) await showApp(access);
		else showLogin();
	} catch (error) {
		renderFailure(error, connect);
	}
}

window.addEventListener("hashchange", () => renderRoute(true));
window.addEventListener("study-session-expired", () => showLogin("登录已过期，请重新登录。"));
document.querySelector(".skip-link").addEventListener("click", (event) => {
	event.preventDefault();
	main.focus();
});
await connect();
