import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { roleSchema, type Role } from "./contracts.ts";
import { HttpError, parse } from "./http.ts";
import type { ModelSettingsController } from "./model-settings.ts";
import type { Store } from "./store.ts";

const cookieName = "hu-study-session";
const sessionSeconds = 12 * 60 * 60;
const loginSchema = z.object({ role: roleSchema, passcode: z.string().min(1).max(200) });

export function registerSecurity(app: FastifyInstance, store: Store, models: ModelSettingsController, options: {
	passcodes: Record<Role, string>;
	publicOrigin: URL | null;
	secure: boolean;
}) {
	const credentials = { reviewer: digest(options.passcodes.reviewer), student: digest(options.passcodes.student) };
	const rateLimit = new Map<string, { count: number; until: number }>();
	const secure = options.secure ? "; Secure" : "";
	const cookieAttributes = `Path=/; HttpOnly; SameSite=Strict${secure}`;
	const sessionResponse = async (role: Role | null) => {
		const { provider, tutor } = models.current();
		const enabled = provider === "local" || role !== null && await models.codexAuth() === "ready";
		return { role, modelProvider: provider, modelAvailable: tutor.available && enabled, visionAvailable: tutor.visionAvailable && enabled };
	};

	function roleFor(request: FastifyRequest): Role | null {
		const token = sessionToken(request);
		return token ? store.getSession(digest(token).toString("hex")) : null;
	}

	app.addHook("onRequest", async (request, reply) => {
		reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff")
			.header("X-Frame-Options", "DENY").header("Referrer-Policy", "no-referrer")
			.header("Content-Security-Policy", "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:");
		const host = request.headers.host ?? "";
		const expectedHost = options.publicOrigin?.host;
		if (expectedHost ? host !== expectedHost : !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) {
			throw new HttpError(421, "请使用配置的服务地址访问。");
		}
		const origin = request.headers.origin;
		const allowedOrigin = options.publicOrigin?.origin ?? `${request.protocol}://${host}`;
		if (origin && origin !== allowedOrigin && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
			throw new HttpError(403, "请求来源不匹配。");
		}
	});

	app.get("/api/session", async (request) => sessionResponse(roleFor(request)));
	app.post("/api/login", async (request, reply) => {
		const { role, passcode } = parse(loginSchema, request.body);
		const now = Date.now();
		for (const [address, limit] of rateLimit) {
			if (limit.until <= now) rateLimit.delete(address);
		}
		const roleAddress = `${request.ip}:${role}`;
		const previous = rateLimit.get(roleAddress);
		if (previous && previous.count >= 10) throw new HttpError(429, "尝试次数过多，请稍后重试。");
		if (!timingSafeEqual(credentials[role], digest(passcode))) {
			if (previous) previous.count++;
			else if (rateLimit.size < 1_000) rateLimit.set(roleAddress, { count: 1, until: now + 5 * 60_000 });
			throw new HttpError(401, "口令有误。");
		}
		const old = sessionToken(request);
		if (old) store.removeSession(digest(old).toString("hex"));
		rateLimit.delete(roleAddress);
		const token = randomBytes(32).toString("base64url");
		store.addSession(digest(token).toString("hex"), role, new Date(now + sessionSeconds * 1_000).toISOString());
		reply.header("Set-Cookie", `${cookieName}=${token}; ${cookieAttributes}; Max-Age=${sessionSeconds}`);
		return sessionResponse(role);
	});
	app.post("/api/logout", async (request, reply) => {
		const token = sessionToken(request);
		if (token) store.removeSession(digest(token).toString("hex"));
		return reply.header("Set-Cookie", `${cookieName}=; ${cookieAttributes}; Max-Age=0`).code(204).send();
	});

	return {
		roleFor,
		requireRole(request: FastifyRequest, required?: Role): Role {
			const role = roleFor(request);
			if (!role) throw new HttpError(401, "请先登录。");
			if (required && role !== required) throw new HttpError(403, "需要复核人权限。");
			return role;
		},
	};
}

export type Security = ReturnType<typeof registerSecurity>;

function sessionToken(request: FastifyRequest): string | undefined {
	return request.headers.cookie?.match(/(?:^|;\s*)hu-study-session=([A-Za-z0-9_-]{43})(?=;|$)/)?.[1];
}

function digest(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}
