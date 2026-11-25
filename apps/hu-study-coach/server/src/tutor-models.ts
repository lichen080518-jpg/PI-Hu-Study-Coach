import { createModels, createProvider, getSupportedThinkingLevels, type Api, type CredentialStore, type Model,
	type ThinkingLevel } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { TutorError } from "./tutor-error.ts";

export type TutorModelSelection =
	| { provider: "local"; modelId: string }
	| { provider: "openai-codex"; modelId: string; reasoningLevel?: ThinkingLevel };

export interface TutorOptions {
	credentials?: CredentialStore;
	active?: TutorModelSelection;
}

export interface TutorRuntime {
	model: Model<Api>;
	models: ReturnType<typeof createModels>;
	kind: "local" | "compatible-remote" | "openai-codex";
	structuredGrading: boolean;
	reasoningLevel?: ThinkingLevel;
}

const codexCatalog = openaiCodexProvider().getModels().filter((model) => model.input.includes("image"));

/** Returns the Pi-installed Codex models that accept grading images. */
export function listCodexModels() {
	return codexCatalog.map((model) => ({ id: model.id, label: model.name, reasoningLevels: codexReasoningLevels(model) }));
}

/** Keeps the preferred level when available, then falls back to low or the first supported level. */
export function pickReasoningLevel(levels: readonly ThinkingLevel[], preferred: ThinkingLevel = "low"): ThinkingLevel | undefined {
	return levels.includes(preferred) ? preferred : levels.includes("low") ? "low" : levels[0];
}

function codexReasoningLevels(model: Model<Api>): ThinkingLevel[] {
	// In the SDK's simple transport, off omits reasoning effort instead of setting it explicitly.
	return getSupportedThinkingLevels(model).filter((level) => level !== "off");
}

/** Selects a general-purpose vision model from the installed Codex catalog. */
export function defaultCodexModelId(): string {
	const model = codexCatalog.find(({ id }) => id === "gpt-6.1-sol") ?? codexCatalog[0];
	if (!model) throw new TutorError("当前安装的 Pi 版本没有支持图片的 Codex 模型。");
	return model.id;
}

/** Resolves an explicit Codex profile or the configured OpenAI-compatible deployment. */
export function modelRuntime(env: NodeJS.ProcessEnv, options: TutorOptions): TutorRuntime | undefined {
	const { active } = options;
	if (active?.provider === "openai-codex") {
		const model = codexCatalog.find(({ id }) => id === active.modelId);
		if (!model) throw new TutorError("请从模型设置中选择支持图片的 OpenAI Codex 模型。");
		const levels = codexReasoningLevels(model);
		if (active.reasoningLevel && !levels.includes(active.reasoningLevel)) {
			throw new TutorError("当前模型不支持所选的推理级别。");
		}
		const models = createModels({ credentials: options.credentials });
		models.setProvider(openaiCodexProvider());
		return { model, models, kind: "openai-codex", structuredGrading: false,
			reasoningLevel: active.reasoningLevel ?? pickReasoningLevel(levels) };
	}

	const id = (active?.modelId ?? env.TUTOR_MODEL)?.trim();
	if (!id) return undefined;
	let url: URL;
	try {
		url = new URL(env.TUTOR_MODEL_BASE_URL?.trim() || "http://127.0.0.1:11434/v1");
	} catch {
		throw new Error("TUTOR_MODEL_BASE_URL 须为完整的模型 API 地址。");
	}
	const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
	if (url.username || url.password || url.search || url.hash) {
		throw new Error("模型地址应为 API 基础地址，认证密钥请使用 TUTOR_MODEL_API_KEY 配置。");
	}
	if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
		throw new Error("外部模型地址须使用 HTTPS。");
	}
	if (!local && env.TUTOR_ALLOW_CLOUD !== "1") {
		throw new Error("启用外部模型需明确设置 TUTOR_ALLOW_CLOUD=1。");
	}
	const apiKey = env.TUTOR_MODEL_API_KEY?.trim() || (local ? "local" : undefined);
	if (!apiKey) throw new Error("请设置外部模型的 TUTOR_MODEL_API_KEY。");
	const model: Model<"openai-completions"> = {
		id,
		name: id,
		api: "openai-completions",
		provider: "hu-study-coach",
		baseUrl: url.href.replace(/\/+$/, ""),
		input: local && env.TUTOR_MODEL_VISION === "1" ? ["text", "image"] : ["text"],
		reasoning: false,
		contextWindow: 32_768,
		maxTokens: 8_192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsUsageInStreaming: false,
			maxTokensField: "max_tokens",
		},
	};
	const models = createModels();
	models.setProvider(createProvider({
		id: model.provider,
		name: "沪学伴",
		auth: { apiKey: { name: "辅导模型", resolve: async () => ({ auth: { apiKey } }) } },
		models: [model],
		api: openAICompletionsApi(),
	}));
	return { model, models, kind: local ? "local" : "compatible-remote",
		structuredGrading: local && env.TUTOR_MODEL_STRUCTURED_GRADING === "1" };
}

/** Resolves the active OAuth account, refreshing via Pi when necessary. */
export async function checkCodexReady(runtime: TutorRuntime, signal: AbortSignal): Promise<void> {
	try {
		const auth = await runtime.models.getAuth(runtime.model, { signal });
		if (auth?.auth.apiKey) return;
	} catch {
		signal.throwIfAborted();
		throw new TutorError("暂时无法完成 OpenAI Codex 授权。请检查网络或重新登录后重试。");
	}
	throw new TutorError("请先在模型设置登录 OpenAI Codex，再重试。");
}

/** Blocks redirects and prevents Codex grading images from reaching a different endpoint. */
export function codexFetch(request: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> {
	// Fetch is the SDK's outbound request boundary.
	const url = new URL(request instanceof Request ? request.url : request);
	if (url.href !== "https://chatgpt.com/backend-api/codex/responses") {
		throw new TutorError("OpenAI Codex 请求地址不受支持，请检查服务设置。");
	}
	return fetch(request, { ...options, redirect: "error" });
}

/** Converts provider outcomes into messages that can be shown without leaking response bodies. */
export function codexRequestError(status?: number, providerError = ""): TutorError {
	if (status === 401 || /OAuth refresh failed|No API key for provider|token[_ ]expired|invalid[_ ]grant/iu.test(providerError)) {
		return new TutorError("OpenAI Codex 登录已失效。请重新登录后重试。");
	}
	if (status === 402 || status === 429 || /quota|rate.?limit|usage limit|billing/iu.test(providerError)) {
		return new TutorError("OpenAI Codex 已达到请求频率或账号用量限制。请稍后重试或更换模型。");
	}
	if (status === 403 || status === 404 || /model[_ ]not[_ ]found|model.+not.+available/iu.test(providerError)) {
		return new TutorError("当前 OpenAI Codex 账号无法使用所选模型。请检查授权或切换模型。");
	}
	if (status === 413) return new TutorError("OpenAI Codex 接收的图片过大。请缩小原图后重新上传。");
	return new TutorError("OpenAI Codex 暂时未能完成请求。请检查网络和所选模型后重试。");
}
