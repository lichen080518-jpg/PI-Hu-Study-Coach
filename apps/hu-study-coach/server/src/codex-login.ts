import { createModels, type AuthPrompt, type CredentialStore } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, parse } from "./http.ts";
import type { Security } from "./security.ts";

interface LoginAttempt {
	id: string;
	state: "pending" | "ready" | "failed";
	controller: AbortController;
	authorization: URL | null;
	submitRedirect: ((url: string) => void) | null;
	message: string | null;
}

const redirectSchema = z.strictObject({ url: z.url().max(4_096) });

/** Gives the reviewer a browser sign-in without handling their OpenAI password. */
export function registerCodexLoginRoutes(app: FastifyInstance, auth: Security, credentials: CredentialStore): void {
	const models = createModels({ credentials });
	models.setProvider(openaiCodexProvider());
	let active: LoginAttempt | undefined;

	function requireAttempt(id: string): LoginAttempt {
		if (active?.id !== parse(z.uuid(), id)) throw new HttpError(404, "找不到该授权请求，请重新发起。");
		return active;
	}

	app.post("/api/model-settings/codex/login", async (request, reply) => {
		auth.requireRole(request, "reviewer");
		if (active?.state === "pending") return reply.code(202).send(loginStatus(active));
		const attempt: LoginAttempt = { id: randomUUID(), state: "pending", controller: new AbortController(),
			authorization: null, submitRedirect: null, message: null };
		active = attempt;
		const signal = AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(5 * 60_000)]);
		void models.login("openai-codex", "oauth", {
			signal,
			prompt: (prompt) => promptForLogin(attempt, prompt, signal),
			notify(event) {
				if (event.type !== "auth_url") return;
				const authorization = new URL(event.url);
				if (authorization.origin !== "https://auth.openai.com") throw new Error("Unexpected OAuth origin");
				attempt.authorization = authorization;
			},
		}).then(() => {
			attempt.state = "ready";
		}, () => {
			attempt.state = "failed";
			attempt.message = signal.aborted ? "授权已超时，请重新发起。" : "OpenAI 授权未完成，请重新发起。";
		}).finally(() => {
			attempt.authorization = null;
			attempt.submitRedirect = null;
		});
		return reply.code(202).send(loginStatus(attempt));
	});

	app.get<{ Params: { id: string } }>("/api/model-settings/codex/login/:id", async (request) => {
		auth.requireRole(request, "reviewer");
		return loginStatus(requireAttempt(request.params.id));
	});

	app.post<{ Params: { id: string } }>("/api/model-settings/codex/login/:id/redirect", async (request) => {
		auth.requireRole(request, "reviewer");
		const attempt = requireAttempt(request.params.id);
		const { url } = parse(redirectSchema, request.body, "请粘贴完整的授权回调地址。");
		if (!attempt.submitRedirect || !attempt.authorization) throw new HttpError(409, "当前授权已结束或仍在准备中。");
		const redirect = new URL(url);
		const state = attempt.authorization.searchParams.get("state");
		if (redirect.origin !== "http://localhost:1455" || redirect.pathname !== "/auth/callback" || !state
			|| redirect.searchParams.get("state") !== state || !redirect.searchParams.get("code")) {
			throw new HttpError(422, "回调地址与本次授权不匹配，请核对完整地址。");
		}
		attempt.submitRedirect(redirect.href);
		return loginStatus(attempt);
	});

	app.addHook("preClose", async () => { active?.controller.abort(); });
}

function promptForLogin(attempt: LoginAttempt, prompt: AuthPrompt, signal: AbortSignal): Promise<string> {
	if (prompt.type === "select") {
		const browser = prompt.options.find(({ id }) => id === "browser");
		if (browser) return Promise.resolve(browser.id);
	}
	if (prompt.type !== "manual_code") return Promise.reject(new Error("Unexpected OAuth prompt"));
	const promptSignal = prompt.signal ?? signal;
	return new Promise((resolve, reject) => {
		function clear() {
			attempt.submitRedirect = null;
			promptSignal.removeEventListener("abort", abort);
		}
		function abort() { clear(); reject(promptSignal.reason); }
		if (promptSignal.aborted) { abort(); return; }
		attempt.submitRedirect = (url) => { clear(); resolve(url); };
		promptSignal.addEventListener("abort", abort, { once: true });
	});
}

function loginStatus(attempt: LoginAttempt) {
	return { id: attempt.id, state: attempt.state, authorizationUrl: attempt.authorization?.href ?? null,
		needsRedirect: attempt.submitRedirect !== null, message: attempt.message };
}
