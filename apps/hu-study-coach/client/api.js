export async function request(path, options) {
	let response;
	try {
		response = await fetch(`/api${path}`, options);
	} catch (error) {
		if (error.name === "AbortError") throw error;
		throw new Error("连接中断，请确认能访问局域网服务后重试。", { cause: error });
	}
	if (!response.ok) {
		const error = await response.json().catch(() => null);
		const failure = new Error(error?.message ?? `请求失败（${response.status}）`);
		failure.status = response.status;
		failure.code = error?.code;
		if (response.status === 401 && path !== "/login") window.dispatchEvent(new Event("study-session-expired"));
		throw failure;
	}
	return response;
}

export async function read(path, options) {
	const response = await request(path, options);
	return response.status === 204 ? null : response.json();
}

export function send(path, method, data) {
	return read(path, {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(data),
	});
}

export async function* events(response) {
	const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			buffer += value;
			for (let separator = /\r?\n\r?\n/.exec(buffer); separator; separator = /\r?\n\r?\n/.exec(buffer)) {
				const fields = buffer.slice(0, separator.index).split(/\r?\n/);
				buffer = buffer.slice(separator.index + separator[0].length);
				const name = fields.find((line) => line.startsWith("event:"))?.slice(6).trim();
				const data = fields.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
				if (data.length) yield { name, data: JSON.parse(data.join("\n")) };
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export function submissionKey() {
	// getRandomValues also works during same-machine HTTP development.
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 15) | 64;
	bytes[8] = (bytes[8] & 63) | 128;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
