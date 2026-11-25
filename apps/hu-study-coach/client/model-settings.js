import { read, send } from "./api.js";
import { bindForm, escape, option, pageHeader } from "./ui.js";

const codexProvider = "openai-codex";
const loginPath = "/model-settings/codex/login";
const providers = { local: "本地模型", [codexProvider]: "OpenAI Codex" };
const reasoningLabels = {
	minimal: "最低（minimal）", low: "低（low）", medium: "中（medium）", high: "高（high）",
	xhigh: "超高（xhigh）", max: "最高（max）",
};

export function renderModelSettings(container, settings, { examId, notice, refreshSession }) {
	const back = examId ? `#exams/${encodeURIComponent(examId)}` : "#overview";
	const codexModelId = settings.codexModelId || (settings.provider === codexProvider ? settings.modelId : settings.codexDefaultModelId);
	const localModelId = settings.provider === "local" ? settings.modelId : settings.localModelId;
	container.innerHTML = `<div class="page">${pageHeader("模型设置", "配置批改、出题和辅导使用的模型。",
		`<a class="button secondary" href="${back}">${examId ? "返回试卷" : "返回总览"}</a>`)}
		<section class="panel"><div class="panel-head"><div><h2>当前模型</h2><p id="active-model" class="text-wrap"></p></div><span id="model-readiness" role="status"></span></div></section>
		<section class="panel"><form id="model-settings-form" class="stack">
			<div class="form-grid"><label class="field">模型来源<select name="provider">${Object.entries(providers).map(([id, name]) => option(id, name, settings.provider)).join("")}</select></label>
				<label class="field" id="local-model-field">本地模型名称<input name="modelId" maxlength="200" value="${escape(localModelId)}" required /></label>
				<label class="field" id="codex-model-field">Codex 模型<select name="modelId" required>${settings.codexModels.map(({ id, label }) => option(id, label, codexModelId)).join("")}</select></label>
				<label class="field" id="reasoning-level-field" hidden>推理级别<select name="reasoningLevel" required disabled></select></label></div>
			<p class="notice" id="codex-upload-notice" hidden>使用 OpenAI Codex 批改时，试卷图片将发送给 OpenAI 处理。</p>
			<p class="form-error" role="alert"></p><div><button class="button primary" type="submit">保存模型设置</button></div>
		</form></section>
		<section id="codex-authorization" class="panel" hidden><div class="panel-head"><h2>OpenAI Codex 授权</h2><span id="codex-auth-status" role="status"></span></div>
			<div id="codex-auth-actions" class="row"><button id="codex-sign-in" class="button secondary" type="button">授权 OpenAI Codex</button>
			<a id="codex-auth-link" class="button primary" target="_blank" rel="noopener noreferrer" hidden>打开 OpenAI 授权页面</a></div>
			<p id="codex-auth-feedback" class="form-error text-wrap" role="alert"></p>
			<form id="codex-redirect" class="stack" hidden><p class="muted small">如果浏览器跳转后未能完成授权，请复制地址栏中的完整回调地址。</p>
				<label class="field">授权回调地址<input name="url" type="url" autocomplete="off" placeholder="http://localhost:1455/auth/callback…" required /></label>
				<p class="form-error" role="alert"></p><div><button type="submit" class="button secondary">完成授权</button></div></form>
		</section></div>`;

	const provider = container.querySelector('[name="provider"]');
	const localField = container.querySelector("#local-model-field");
	const codexField = container.querySelector("#codex-model-field");
	const codexModel = codexField.querySelector("select");
	const reasoningField = container.querySelector("#reasoning-level-field");
	const reasoning = reasoningField.querySelector("select");
	const authPanel = container.querySelector("#codex-authorization");
	const activeModel = container.querySelector("#active-model");
	const modelReadiness = container.querySelector("#model-readiness");
	const uploadNotice = container.querySelector("#codex-upload-notice");
	const authActions = container.querySelector("#codex-auth-actions");
	const signIn = container.querySelector("#codex-sign-in");
	const authLink = container.querySelector("#codex-auth-link");
	const authStatus = container.querySelector("#codex-auth-status");
	const authFeedback = container.querySelector("#codex-auth-feedback");
	const redirectForm = container.querySelector("#codex-redirect");
	const controller = new AbortController();
	let login;
	let pollTimer;

	function showActiveModel() {
		const level = settings.reasoningLevel;
		activeModel.textContent = [providers[settings.provider], settings.modelId,
			level && `推理级别 ${reasoningLabels[level] ?? level}`].filter(Boolean).join(" · ");
		modelReadiness.className = `status ${settings.visionAvailable ? "good" : "pending"}`;
		modelReadiness.textContent = settings.visionAvailable ? "视觉批改可用" : "视觉批改未就绪";
	}

	function showAuthorization() {
		const ready = settings.codexAuth === "ready";
		const pending = login?.state === "pending";
		const url = pending ? trustedAuthorizationUrl(login.authorizationUrl) : null;
		authStatus.className = `status ${ready ? "good" : "pending"}`;
		authStatus.textContent = ready ? "已授权" : pending ? "等待授权" : "需要授权";
		signIn.hidden = ready || pending;
		authLink.hidden = !url;
		authActions.hidden = signIn.hidden && authLink.hidden;
		if (url) authLink.href = url;
		else authLink.removeAttribute("href");
		redirectForm.hidden = !pending || !login.needsRedirect;
		authFeedback.textContent = ready ? "" : login?.message ?? "";
	}

	function showFields() {
		const useCodex = provider.value === codexProvider;
		localField.hidden = useCodex;
		localField.querySelector("input").disabled = useCodex;
		codexField.hidden = !useCodex;
		codexModel.disabled = !useCodex;
		uploadNotice.hidden = !useCodex;
		authPanel.hidden = !useCodex;
		showReasoningLevels();
	}

	function showReasoningLevels() {
		const levels = settings.codexModels.find(({ id }) => id === codexModel.value)?.reasoningLevels ?? [];
		reasoningField.hidden = provider.value !== codexProvider || levels.length === 0;
		reasoning.disabled = reasoningField.hidden;
		if (reasoning.disabled) return;
		const level = [reasoning.value, settings.codexReasoningLevel, "low"].find((value) => levels.includes(value)) ?? levels[0];
		reasoning.innerHTML = levels.map((value) => option(value, reasoningLabels[value] ?? value, level)).join("");
	}

	async function updateLogin(next) {
		if (controller.signal.aborted || (login?.id === next.id && login.state !== "pending" && next.state === "pending")) return;
		const completed = login?.id === next.id && login.state === "ready";
		login = next;
		window.clearTimeout(pollTimer);
		if (next.state === "ready") settings = { ...settings, codexAuth: "ready" };
		showAuthorization();
		if (next.state === "pending") pollTimer = window.setTimeout(pollLogin, 1600);
		if (next.state === "ready" && !completed) {
			settings = await read("/model-settings", { signal: controller.signal });
			showActiveModel();
			showAuthorization();
			await refreshSession();
			if (!controller.signal.aborted) notice("OpenAI Codex 已授权。");
		}
	}

	async function pollLogin() {
		try {
			const status = await read(`${loginPath}/${encodeURIComponent(login.id)}`, { signal: controller.signal });
			await updateLogin(status);
		} catch (error) {
			if (controller.signal.aborted) return;
			if (error.status === 404 || error.status === 410) {
				login = { ...login, state: "failed", message: "授权已失效，请重新授权。" };
				showAuthorization();
			} else {
				authFeedback.textContent = error.message;
				if (login.state === "pending") pollTimer = window.setTimeout(pollLogin, 3000);
			}
		}
	}

	provider.addEventListener("change", showFields);
	codexModel.addEventListener("change", showReasoningLevels);
	signIn.addEventListener("click", async () => {
		signIn.disabled = true;
		authFeedback.textContent = "";
		try {
			await updateLogin(await send(loginPath, "POST", {}));
		} catch (error) {
			if (!controller.signal.aborted) authFeedback.textContent = error.message;
		} finally { signIn.disabled = false; }
	});
	bindForm(container, "#codex-redirect", async (data) => {
		const url = new URL(data.get("url"));
		if (url.origin !== "http://localhost:1455" || url.pathname !== "/auth/callback") throw new Error("请输入 OpenAI 授权后的完整回调地址。");
		await updateLogin(await send(`${loginPath}/${encodeURIComponent(login.id)}/redirect`, "POST", { url: url.href }));
	});
	bindForm(container, "#model-settings-form", async (data) => {
		const level = data.get("reasoningLevel");
		settings = await send("/model-settings", "PUT", { provider: data.get("provider"), modelId: data.get("modelId").trim(),
			...(level ? { reasoningLevel: level } : {}) });
		showActiveModel();
		showAuthorization();
		await refreshSession();
		if (!controller.signal.aborted) notice("模型设置已保存。");
	});
	showActiveModel();
	showAuthorization();
	showFields();
	return () => {
		controller.abort();
		window.clearTimeout(pollTimer);
	};
}

function trustedAuthorizationUrl(value) {
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.origin === "https://auth.openai.com" && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}
