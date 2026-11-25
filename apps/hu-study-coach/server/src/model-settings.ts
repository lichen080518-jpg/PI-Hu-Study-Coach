import type { CredentialStore, ThinkingLevel } from "@earendil-works/pi-ai";
import { THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createTutor, defaultCodexModelId, listCodexModels, type Tutor } from "./ai.ts";
import type { ModelProvider, ModelSettings } from "./contracts.ts";
import { HttpError, parse } from "./http.ts";
import type { Security } from "./security.ts";
import type { Store } from "./store.ts";
import { pickReasoningLevel } from "./tutor-models.ts";

type CodexAuthState = "ready" | "required";

const reasoningLevelSchema = z.enum(THINKING_LEVELS);
const selectionSchema = z.strictObject({
	provider: z.enum(["local", "openai-codex"]),
	modelId: z.string().trim().min(1).max(200).regex(/^[^\s\u0000-\u001f\u007f]+$/u),
	reasoningLevel: reasoningLevelSchema.optional(),
});

export function createModelSettings(store: Store, env: NodeJS.ProcessEnv, credentials: CredentialStore, injectedTutor?: Tutor) {
	const catalog = listCodexModels();
	const defaultId = defaultCodexModelId();
	const codexModels = new Map(catalog.map((model) => [model.id, model]));
	const configuredCodexId = env.TUTOR_CODEX_MODEL?.trim() || defaultId;
	const configuredModel = codexModels.get(configuredCodexId);
	if (!configuredModel) {
		throw new Error("TUTOR_CODEX_MODEL 需为支持图像输入的 OpenAI Codex 模型标识。");
	}
	const localId = env.TUTOR_MODEL?.trim() || "";
	const saved = store.getModelSettings();
	const rawLevel = env.TUTOR_CODEX_REASONING_LEVEL?.trim();
	const configuredLevel = reasoningLevelSchema.safeParse(rawLevel);
	if (!saved && rawLevel && (!configuredLevel.success || !configuredModel.reasoningLevels.includes(configuredLevel.data))) {
		throw new Error("TUTOR_CODEX_REASONING_LEVEL 需为所选 OpenAI Codex 模型支持的推理级别。");
	}
	let settings: ModelSettings = saved ?? {
		provider: env.TUTOR_MODEL_PROVIDER === "openai-codex" ? "openai-codex" : "local",
		localModelId: localId,
		codexModelId: configuredCodexId,
		codexReasoningLevel: pickReasoningLevel(configuredModel.reasoningLevels, configuredLevel.data) ?? "low",
	};
	let cachedCodex: { modelId: string; reasoningLevel: ThinkingLevel | undefined; tutor: Tutor } | undefined;
	let probe: { expires: number; until: number; result: Promise<CodexAuthState> } | undefined;
	let current = createSelection(settings);

	function createSelection(settings: ModelSettings) {
		const useCodex = settings.provider === "openai-codex";
		const modelId = useCodex ? settings.codexModelId : settings.localModelId;
		const reasoningLevel = useCodex ? codexLevel(settings) : undefined;
		const tutor = injectedTutor ?? (useCodex
			? codexTutor(modelId, reasoningLevel)
			: createTutor(env, { active: { provider: "local", modelId }, credentials }));
		return { provider: settings.provider, modelId, reasoningLevel: reasoningLevel ?? null, tutor };
	}

	function codexLevel(settings: ModelSettings): ThinkingLevel | undefined {
		return pickReasoningLevel(codexModels.get(settings.codexModelId)?.reasoningLevels ?? [], settings.codexReasoningLevel);
	}

	function codexTutor(modelId: string, reasoningLevel: ThinkingLevel | undefined): Tutor {
		if (!cachedCodex || cachedCodex.modelId !== modelId || cachedCodex.reasoningLevel !== reasoningLevel) {
			const tutor = createTutor(env, { active: { provider: "openai-codex", modelId, reasoningLevel }, credentials });
			cachedCodex = { modelId, reasoningLevel, tutor };
		}
		return cachedCodex.tutor;
	}

	async function codexAuth(): Promise<CodexAuthState> {
		try {
			const credential = await credentials.read("openai-codex");
			if (credential?.type !== "oauth") return "required";
			if (probe?.expires === credential.expires && Date.now() < probe.until) return probe.result;
			const tutor = injectedTutor ?? codexTutor(settings.codexModelId, codexLevel(settings));
			const result = tutor.checkReady
				? tutor.checkReady(AbortSignal.timeout(5_000)).then<CodexAuthState, CodexAuthState>(() => "ready", () => "required")
				: Promise.resolve<CodexAuthState>(credential.expires > Date.now() ? "ready" : "required");
			probe = { expires: credential.expires, until: Date.now() + 10_000, result };
			return result;
		} catch {
			return "required";
		}
	}

	async function describe() {
		const selected = current;
		const activeSettings = settings;
		const accountState = await codexAuth();
		return { provider: selected.provider, modelId: selected.modelId, reasoningLevel: selected.reasoningLevel,
			localModelId: activeSettings.localModelId, codexModelId: activeSettings.codexModelId,
			codexReasoningLevel: codexLevel(activeSettings) ?? activeSettings.codexReasoningLevel,
			codexModels: catalog, codexDefaultModelId: defaultId,
			codexAuth: accountState, visionAvailable: selected.tutor.visionAvailable &&
				(selected.provider === "local" || accountState === "ready") };
	}

	return {
		current: () => current,
		codexAuth,
		describe,
		async configure(provider: ModelProvider, modelId: string, reasoningLevel?: ThinkingLevel) {
			let updated: ModelSettings;
			if (provider === "openai-codex") {
				const model = codexModels.get(modelId);
				if (!model) throw new HttpError(422, "请选择支持图像输入的 OpenAI Codex 模型。");
				if (reasoningLevel && !model.reasoningLevels.includes(reasoningLevel)) {
					throw new HttpError(422, "当前模型不支持所选的推理级别。");
				}
				updated = { ...settings, provider, codexModelId: modelId,
					codexReasoningLevel: reasoningLevel ?? pickReasoningLevel(model.reasoningLevels, settings.codexReasoningLevel)
						?? settings.codexReasoningLevel };
			} else {
				if (reasoningLevel) throw new HttpError(422, "当前本地模型配置不支持设置推理级别。");
				updated = { ...settings, provider, localModelId: modelId };
			}
			const selection = createSelection(updated);
			store.saveModelSettings(updated);
			settings = updated;
			current = selection;
			return describe();
		},
	};
}

export type ModelSettingsController = ReturnType<typeof createModelSettings>;

export function registerModelSettingsRoutes(app: FastifyInstance, auth: Security, models: ModelSettingsController): void {
	app.get("/api/model-settings", async (request) => {
		auth.requireRole(request, "reviewer");
		return models.describe();
	});
	app.put("/api/model-settings", async (request) => {
		auth.requireRole(request, "reviewer");
		const { provider, modelId, reasoningLevel } = parse(selectionSchema, request.body, "请选择有效的模型来源、型号和推理级别。");
		return models.configure(provider, modelId, reasoningLevel);
	});
}
