import type { AuthOperationOptions, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";

const provider = "openai-codex";
const documentSchema = z.record(z.string(), z.unknown());
const credentialSchema = z.looseObject({
	type: z.literal("oauth"), access: z.string().min(1), refresh: z.string().min(1), expires: z.number(),
});

/** Uses the host's Pi sign-in when present, or an isolated store for a new installation. */
export function createCodexCredentials(dataDirectory: string, env: NodeJS.ProcessEnv): CredentialStore {
	const piFile = join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "auth.json");
	const path = resolve(env.TUTOR_CODEX_AUTH_FILE || (existsSync(piFile) ? piFile : join(dataDirectory, "codex-auth.json")));
	return new CodexCredentials(path);
}

class CodexCredentials implements CredentialStore {
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		if (providerId !== provider) return undefined;
		const document = await readDocument(this.path);
		options?.signal?.throwIfAborted();
		return readCredential(document);
	}

	async list(options?: AuthOperationOptions) {
		return await this.read(provider, options) ? [{ providerId: provider, type: "oauth" as const }] : [];
	}

	async modify(providerId: string, update: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions): Promise<Credential | undefined> {
		if (providerId !== provider) throw new Error("Unsupported credentials provider");
		return this.withLock(options, async (document, path) => {
			const current = readCredential(document);
			const next = await update(current);
			options?.signal?.throwIfAborted();
			if (!next) return current;
			await saveDocument(path, { ...document, [provider]: credentialSchema.parse(next) });
			return next;
		});
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		if (providerId !== provider) return;
		await this.withLock(options, async (document, path) => {
			if (!Object.hasOwn(document, provider)) return;
			delete document[provider];
			await saveDocument(path, document);
		});
	}

	private async withLock<T>(options: AuthOperationOptions | undefined,
		action: (document: Record<string, unknown>, path: string) => Promise<T>): Promise<T> {
		options?.signal?.throwIfAborted();
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		try { await writeFile(this.path, "{}\n", { flag: "wx", mode: 0o600 }); } catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
		}
		const path = await realpath(this.path);
		// Pi also locks the resolved auth.json path during token rotation.
		const unlock = await lockfile.lock(path, { stale: 30_000, retries: { retries: 8, minTimeout: 30, maxTimeout: 400 } });
		try {
			options?.signal?.throwIfAborted();
			return await action(await readDocument(path), path);
		} finally {
			await unlock();
		}
	}
}

async function readDocument(path: string): Promise<Record<string, unknown>> {
	let contents: string;
	try { contents = await readFile(path, "utf8"); } catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
	return documentSchema.parse(JSON.parse(contents.replace(/^\uFEFF/, "")));
}

function readCredential(document: Record<string, unknown>): Credential | undefined {
	const result = credentialSchema.safeParse(document[provider]);
	return result.success ? result.data : undefined;
}

async function saveDocument(path: string, document: Record<string, unknown>): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch(() => {});
	}
}
