import { events, request } from "./api.js";
import { bindForm, empty, escape, pageHeader, subjectOptions, subjects } from "./ui.js";

export function renderTutor(container, session, chats, options) {
	const { examId, itemId, itemNumber, examTitle } = options;
	const attached = Boolean(examId && itemId);
	const subject = Object.hasOwn(subjects, options.subject) ? options.subject : "math";
	container.innerHTML = `<div class="page">${pageHeader("一对一辅导", "描述你已尝试的步骤，沪学伴会先给一个提示。")}
		<section class="panel"><div class="panel-head"><h2>${attached ? `${escape(examTitle)} · ${escape(itemNumber)}题` : "辅导对话"}</h2>
			${attached ? `<a class="button secondary" href="#exams/${encodeURIComponent(examId)}?item=${encodeURIComponent(itemId)}">查看对应试卷</a>` : `<label class="row">科目 <select id="chat-subject" aria-label="辅导科目">${subjectOptions(subject)}</select></label>`}</div>
			${session.modelAvailable ? "" : '<p class="notice">辅导模型暂未配置。配置成功后即可发送问题。</p>'}
			<div id="chat-messages" class="chat-messages" role="log" aria-label="辅导对话记录" aria-live="polite"></div>
			<form id="chat-form" class="stack"><label class="field">你的问题<textarea name="question" rows="3" maxlength="5000" required${session.modelAvailable ? "" : " disabled"}></textarea></label>
				<p class="form-error" role="alert"></p><div class="row"><button class="button primary" type="submit"${session.modelAvailable ? "" : " disabled"}>发送</button><button id="stop-chat" class="button secondary" type="button" hidden>停止生成</button></div></form>
		</section></div>`;
	const list = container.querySelector("#chat-messages");
	const selector = container.querySelector("#chat-subject");
	const stop = container.querySelector("#stop-chat");
	const question = container.querySelector('[name="question"]');
	const getSubject = () => selector?.value ?? subject;
	const getKey = () => attached ? `item:${examId}:${itemId}` : `subject:${getSubject()}`;
	let active;
	let disposed = false;
	function showChat() {
		list.replaceChildren();
		const messages = chats.get(getKey());
		if (!messages?.length) list.innerHTML = empty(attached ? "可以从「我这一步哪里有问题？」开始。" : "暂无对话。可以发送一道题或你的解题思路。");
		for (const message of messages ?? []) addMessage(list, message.role, message.content);
	}
	selector?.addEventListener("change", showChat);
	stop.addEventListener("click", () => active?.abort());
	showChat();
	bindForm(container, "#chat-form", async (data) => {
		const content = data.get("question").trim();
		if (!content) throw new Error("请输入你的问题。");
		const key = getKey();
		const messages = chats.get(key) ?? [];
		const user = { role: "user", content };
		list.querySelector(".state")?.remove();
		addMessage(list, "user", content);
		const answer = addMessage(list, "assistant", "正在生成…");
		const controller = new AbortController();
		active = controller;
		stop.hidden = false;
		if (selector) selector.disabled = true;
		question.value = "";
		let reply = "";
		try {
			const context = messages.slice(-18).map((message) => ({ ...message, content: message.content.slice(0, 6000) }));
			reply = await streamReply({ subject: getSubject(), ...(attached ? { examId, itemId } : {}), messages: [...context, user] }, controller.signal, (text) => {
				reply += text;
				answer.textContent = reply;
				list.scrollTop = list.scrollHeight;
			});
		} catch (error) {
			if (error.name !== "AbortError") throw error;
		} finally {
			if (!disposed) {
				if (reply) chats.set(key, [...messages, user, { role: "assistant", content: reply }]);
				else {
					showChat();
					question.value = content;
				}
				if (selector) selector.disabled = false;
				stop.hidden = true;
			}
			active = undefined;
		}
	});
	return () => {
		disposed = true;
		active?.abort();
	};
}

async function streamReply(data, signal, onDelta) {
	const response = await request("/tutor", {
		method: "POST", signal, headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(data),
	});
	let reply = "";
	for await (const event of events(response)) {
		if (event.name === "fault") throw new Error(event.data.message);
		if (event.name === "done" && reply) return reply;
		if (event.name === "delta") {
			reply += event.data.text;
			onDelta(event.data.text);
		}
	}
	throw new Error(reply ? "辅导回复中断。" : "没有收到辅导回复，请重试。");
}

function addMessage(list, role, text) {
	const message = document.createElement("div");
	message.className = role === "user" ? "message from-user" : "message";
	const author = document.createElement("p");
	author.textContent = role === "user" ? "你" : "沪学伴";
	const body = document.createElement("p");
	body.textContent = text;
	message.append(author, body);
	list.append(message);
	list.scrollTop = list.scrollHeight;
	return body;
}
