import { buildApp } from "./app.ts";

const port = Number(process.env.TUTOR_PORT || "8787");
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("TUTOR_PORT 需为 1 至 65535 的整数。");
const app = await buildApp();

try {
	await app.listen({ host: "127.0.0.1", port });
} catch (error) {
	await app.close();
	throw error;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => { void app.close().catch(() => { process.exitCode = 1; }); });
}
