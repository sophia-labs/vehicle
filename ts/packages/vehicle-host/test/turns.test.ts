import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { contextText, createSession, gate, type Harness, held, startHost } from "./harness.ts";

describe("steer and follow-up during a running turn", () => {
	let harness: Harness;
	before(async () => {
		harness = await startHost();
	});
	after(async () => harness.cleanup());

	it("maps steer and follow_up onto pi's queues: steer before the next model call, follow-up after the run's work, cancel takes one back", async () => {
		const hold = gate();
		const seen: string[] = [];
		harness.faux.setResponses([
			async (context, options) => {
				seen.push(contextText(context));
				await held(hold, options);
				return fauxAssistantMessage("first answer");
			},
			(context) => {
				seen.push(contextText(context));
				return fauxAssistantMessage("answer after the steer");
			},
			(context) => {
				seen.push(contextText(context));
				return fauxAssistantMessage("answer after the follow-up");
			},
		]);
		const sessionId = await createSession(harness);
		const send = (requestId: string, op: string, text?: string, extra: Record<string, unknown> = {}) =>
			harness.call("POST", `/sessions/${sessionId}/commands`, { requestId, op, ...(text ? { text } : {}), ...extra });

		const started = await send("prompt-1", "prompt", "Start the long task");
		assert.equal(started.body.value.command.disposition, "started");
		await harness.waitFor(sessionId, (event) => event.type === "run.started");

		const steer = await send("steer-1", "steer", "Focus on the second item");
		const followUp = await send("follow-1", "follow_up", "Then summarise it");
		const doomed = await send("follow-2", "follow_up", "Drop me before I run");
		for (const reply of [steer, followUp, doomed]) {
			assert.equal(reply.status, 200, JSON.stringify(reply.body));
			assert.equal(reply.body.value.command.status, "queued");
			assert.equal(reply.body.value.command.disposition, "queued");
		}
		const cancel = await send("cancel-1", "cancel", undefined, { commandId: "follow-2" });
		assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
		assert.equal(cancel.body.value.command.status, "cancelled");
		const late = await send("cancel-2", "cancel", undefined, { commandId: "prompt-1" });
		assert.equal(late.status, 409);
		assert.equal(late.body.code, "not_cancellable");

		hold.open();
		await harness.waitFor(sessionId, (event) => event.type === "run.settled");

		assert.equal(harness.faux.state.callCount, 3);
		assert.match(seen[1] ?? "", /Focus on the second item/);
		assert.doesNotMatch(seen[1] ?? "", /Then summarise it/);
		assert.match(seen[2] ?? "", /Then summarise it/);
		assert.doesNotMatch(seen.join("\n"), /Drop me before I run/);

		const snapshot = await harness.call("GET", `/sessions/${sessionId}`);
		const status = Object.fromEntries(
			(snapshot.body.value.commands as { commandId: string; status: string }[]).map((command) => [command.commandId, command.status]),
		);
		assert.deepEqual(status, {
			"prompt-1": "completed",
			"steer-1": "completed",
			"follow-1": "completed",
			"follow-2": "cancelled",
		});
		const users = (snapshot.body.value.transcript as { role: string; text: string }[]).filter((item) => item.role === "user").map((item) => item.text);
		assert.deepEqual(users, ["Start the long task", "Focus on the second item", "Then summarise it"]);
	});

	it("queues a prompt sent while busy as pi's follow-up, and abort stops the run and drops its queue", async () => {
		const hold = gate();
		harness.faux.setResponses([
			async (_context, options) => {
				await held(hold, options);
				return fauxAssistantMessage("never seen");
			},
			fauxAssistantMessage("must not run"),
		]);
		const sessionId = await createSession(harness);
		const send = (requestId: string, op: string, text?: string) =>
			harness.call("POST", `/sessions/${sessionId}/commands`, { requestId, op, ...(text ? { text } : {}) });
		await send("p-1", "prompt", "Work");
		await harness.waitFor(sessionId, (event) => event.type === "run.started");
		const busy = await send("p-2", "prompt", "And then this");
		assert.equal(busy.body.value.command.status, "queued");
		const abort = await send("a-1", "abort");
		assert.equal(abort.status, 200, JSON.stringify(abort.body));
		assert.equal(abort.body.value.command.result.abortedRun, true);
		hold.open();
		const settled = await harness.waitFor(sessionId, (event) => event.type === "run.settled");
		assert.equal(settled.payload.aborted, true);
		const snapshot = await harness.call("GET", `/sessions/${sessionId}`);
		const status = Object.fromEntries(
			(snapshot.body.value.commands as { commandId: string; status: string }[]).map((command) => [command.commandId, command.status]),
		);
		assert.equal(status["p-1"], "aborted");
		assert.equal(status["p-2"], "cancelled");
	});
});

describe("watch", () => {
	let harness: Harness;
	before(async () => {
		harness = await startHost();
	});
	after(async () => harness.cleanup());

	it("resumes from `since` after a disconnect, with no gap, by long-poll and by SSE", async () => {
		harness.faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		const sessionId = await createSession(harness);
		const cursor = (await harness.events(sessionId)).at(-1)?.seq ?? 0;

		// A watcher waits, then drops its connection before anything happens.
		const dropped = new AbortController();
		const pending = harness.call("GET", `/sessions/${sessionId}/events?since=${cursor}&waitMs=30000`, undefined, undefined, dropped.signal).catch((error: Error) => error);
		await new Promise((resolve) => setTimeout(resolve, 100));
		dropped.abort();
		assert.ok((await pending) instanceof Error);

		// Work happens while nobody watches.
		await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-1", op: "prompt", text: "Say first" });
		await harness.waitFor(sessionId, (event) => event.type === "run.settled");

		// Resuming from the old cursor returns everything after it, in order, without a gap.
		const resumed = await harness.events(sessionId, cursor);
		assert.equal(resumed[0]?.seq, cursor + 1);
		resumed.forEach((event, index) => assert.equal(event.seq, cursor + 1 + index));
		const types = resumed.map((event) => event.type);
		for (const type of ["command.accepted", "run.started", "command.delivered", "message.completed", "command.completed", "run.settled"]) {
			assert.ok(types.includes(type), `missing ${type} in ${types.join(",")}`);
		}

		// A long-poll at the head wakes on the next event instead of waiting out waitMs.
		const head = resumed.at(-1)?.seq ?? cursor;
		const startedAt = Date.now();
		const waiting = harness.call("GET", `/sessions/${sessionId}/events?since=${head}&waitMs=30000`);
		await new Promise((resolve) => setTimeout(resolve, 150));
		await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-2", op: "prompt", text: "Say second" });
		const woke = await waiting;
		assert.ok(Date.now() - startedAt < 10_000);
		assert.equal(woke.body.value.events[0].seq, head + 1);
		await harness.waitFor(sessionId, (event) => event.type === "run.settled" && event.seq > head);

		// SSE resumes from Last-Event-ID.
		const controller = new AbortController();
		const response = await fetch(`${harness.url}/sessions/${sessionId}/events`, {
			headers: {
				accept: "text/event-stream",
				"last-event-id": String(cursor),
				"x-internal-service": "test-secret-0123456789abcdef",
				"x-user-id": "carol",
				"x-sophia-caller-role": "owner",
				"x-graph-id": "test-graph",
				"x-sophia-graph-role": "owner",
				"x-vehicle-client-id": "sse-client",
			},
			signal: controller.signal,
		});
		assert.equal(response.headers.get("content-type"), "text/event-stream");
		const reader = response.body!.getReader();
		const ids: number[] = [];
		let buffer = "";
		const last = (await harness.events(sessionId)).at(-1)?.seq ?? 0;
		while (!ids.includes(last)) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += new TextDecoder().decode(value);
			for (const match of buffer.matchAll(/^id: (\d+)$/gm)) {
				const id = Number(match[1]);
				if (!ids.includes(id)) ids.push(id);
			}
		}
		controller.abort();
		assert.equal(ids[0], cursor + 1);
		assert.deepEqual(ids, Array.from({ length: last - cursor }, (_, index) => cursor + 1 + index));
	});
});

describe("revival after a host restart", () => {
	it("revives the session from disk: transcript, lease, and pi's context; an in-flight command is reported interrupted", async () => {
		const first = await startHost();
		const sessionId = await createSession(first);
		first.faux.setResponses([fauxAssistantMessage("Noted: the code word is heliotrope.")]);
		await first.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-1", op: "prompt", text: "Remember the code word heliotrope." });
		await first.waitFor(sessionId, (event) => event.type === "run.settled");
		const piFile = first.host.piFileOf(sessionId);
		assert.ok(piFile);

		// A second command is mid-turn when the host stops.
		const hold = gate();
		first.faux.setResponses([
			async (_context, options) => {
				await held(hold, options);
				return fauxAssistantMessage("cut off");
			},
		]);
		await first.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-2", op: "follow_up", text: "Count to a thousand." });
		await first.waitFor(sessionId, (event) => event.type === "run.started" && event.seq > 10);
		await first.stop();
		hold.open();

		const second = await startHost({ dataDir: first.dataDir });
		try {
			const snapshot = await second.call("GET", `/sessions/${sessionId}`);
			assert.equal(snapshot.status, 200);
			assert.equal(snapshot.body.value.session.status, "dormant");
			assert.equal(snapshot.body.value.session.lease.clientId, "chat-tab-1");
			const commands = Object.fromEntries(
				(snapshot.body.value.commands as { commandId: string; status: string }[]).map((command) => [command.commandId, command.status]),
			);
			assert.equal(commands["p-1"], "completed");
			assert.equal(commands["p-2"], "interrupted");
			const texts = (snapshot.body.value.transcript as { role: string; text: string }[]).map((item) => `${item.role}:${item.text}`);
			assert.ok(texts.includes("user:Remember the code word heliotrope."));
			assert.ok(texts.includes("assistant:Noted: the code word is heliotrope."));

			let seen = "";
			second.faux.setResponses([
				(context) => {
					seen = contextText(context);
					return fauxAssistantMessage("The code word was heliotrope.");
				},
			]);
			// The lease survived the restart: the same client drives without claiming again.
			const asked = await second.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-3", op: "prompt", text: "What was the code word?" });
			assert.equal(asked.status, 200, JSON.stringify(asked.body));
			const settled = await second.waitFor(sessionId, (event) => event.type === "run.settled" && event.seq > (snapshot.body.value.session.cursor as number));
			assert.equal(settled.payload.aborted, false);
			assert.match(seen, /Remember the code word heliotrope\./);
			assert.match(seen, /Noted: the code word is heliotrope\./);
			const events = await second.events(sessionId);
			assert.ok(events.some((event) => event.type === "session.revived"));
			assert.ok(events.some((event) => event.type === "body.materialized" && event.payload.resumedFromFile === true));
			// The same pi session file, appended: pi's own persistence is the body's memory.
			assert.equal(second.host.piFileOf(sessionId), piFile);
			assert.equal(readdirSync(join(second.dataDir, "sessions", sessionId, "pi")).length, 1);
		} finally {
			await second.cleanup();
		}
	});
});

describe("the budget guard", () => {
	it("stops a run at max turns before its next model request", async () => {
		const harness = await startHost({ budget: { maxTurns: 2 } });
		try {
			const loop = () => fauxAssistantMessage(fauxToolCall("get_workspace", {}), { stopReason: "toolUse" });
			harness.faux.setResponses([loop(), loop(), loop(), loop(), fauxAssistantMessage("never")]);
			const sessionId = await createSession(harness);
			await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-1", op: "prompt", text: "Loop forever" });
			const settled = await harness.waitFor(sessionId, (event) => event.type === "run.settled");
			assert.equal(settled.payload.aborted, true);
			assert.equal((settled.payload.budget as { reason: string }).reason, "max_turns");
			assert.equal(harness.faux.state.callCount, 2);
			const events = await harness.events(sessionId);
			assert.ok(events.some((event) => event.type === "budget.exceeded"));
			assert.ok(events.some((event) => event.type === "command.aborted" && event.payload.commandId === "p-1"));
		} finally {
			await harness.cleanup();
		}
	});

	it("stops a run at max cost, priced from the model when the provider reports none", async () => {
		const harness = await startHost({
			models: [{ id: "faux-priced", cost: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 } }],
			budget: { maxCostUsd: 0.001 },
		});
		try {
			const loop = () => fauxAssistantMessage(fauxToolCall("get_workspace", {}), { stopReason: "toolUse" });
			harness.faux.setResponses([loop(), loop(), loop()]);
			const sessionId = await createSession(harness);
			await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-1", op: "prompt", text: "Spend" });
			const settled = await harness.waitFor(sessionId, (event) => event.type === "run.settled");
			assert.equal(settled.payload.aborted, true);
			assert.equal((settled.payload.budget as { reason: string }).reason, "max_cost");
			assert.equal(harness.faux.state.callCount, 1);
		} finally {
			await harness.cleanup();
		}
	});
});

describe("the chat profile", () => {
	it("has no read, bash, edit or write tool: calls to them fail and touch nothing", async () => {
		const harness = await startHost();
		try {
			harness.faux.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("bash", { command: "touch pwned" }),
						fauxToolCall("write", { path: "pwned.txt", content: "x" }),
						fauxToolCall("edit", { path: "pwned.txt", edits: [] }),
						fauxToolCall("read", { path: "/etc/hosts" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			const sessionId = await createSession(harness);
			await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-1", op: "prompt", text: "Run a shell command" });
			await harness.waitFor(sessionId, (event) => event.type === "run.settled");
			const events = await harness.events(sessionId);
			const started = events.find((event) => event.type === "run.started");
			const tools = started?.payload.tools as string[];
			for (const builtin of ["read", "bash", "edit", "write", "grep", "find", "ls"]) assert.ok(!tools.includes(builtin), `${builtin} is active`);
			const results = events.filter((event) => event.type === "tool.result");
			assert.equal(results.length, 4);
			for (const result of results) {
				assert.equal(result.payload.isError, true);
				assert.match(String(result.payload.text), /not found/i);
			}
			assert.deepEqual(readdirSync(join(harness.dataDir, "sessions", sessionId, "work")), []);
		} finally {
			await harness.cleanup();
		}
	});
});

describe("fork and clone", () => {
	it("clone copies the active branch; fork starts a new session from before a user message, with pi's own files", async () => {
		const harness = await startHost();
		try {
			harness.faux.setResponses([fauxAssistantMessage("answer one"), fauxAssistantMessage("answer two")]);
			const sessionId = await createSession(harness);
			for (const [requestId, text] of [
				["p-1", "First question"],
				["p-2", "Second question"],
			] as const) {
				await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId, op: "prompt", text });
				await harness.waitFor(sessionId, (event) => event.type === "command.completed" && event.payload.commandId === requestId);
			}
			const source = await harness.call("GET", `/sessions/${sessionId}`);
			const second = (source.body.value.transcript as { entryId: string; role: string; text: string }[]).find((item) => item.text === "Second question");
			assert.ok(second);

			const clone = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "c-1", op: "clone" });
			assert.equal(clone.status, 200, JSON.stringify(clone.body));
			const cloneId = clone.body.value.session.sessionId as string;
			assert.equal(clone.body.value.session.parent.kind, "clone");
			const cloned = await harness.call("GET", `/sessions/${cloneId}`);
			assert.deepEqual(
				(cloned.body.value.transcript as { text: string }[]).map((item) => item.text),
				["First question", "answer one", "Second question", "answer two"],
			);

			const fork = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "f-1", op: "fork", entryId: second.entryId });
			assert.equal(fork.status, 200, JSON.stringify(fork.body));
			assert.equal(fork.body.value.selectedText, "Second question");
			const forkId = fork.body.value.session.sessionId as string;
			assert.equal(fork.body.value.session.lease.clientId, "chat-tab-1");
			let seen = "";
			harness.faux.setResponses([
				(context) => {
					seen = contextText(context);
					return fauxAssistantMessage("a different second answer");
				},
			]);
			await harness.call("POST", `/sessions/${forkId}/commands`, { requestId: "p-3", op: "prompt", text: "Another second question" });
			await harness.waitFor(forkId, (event) => event.type === "run.settled");
			assert.match(seen, /First question/);
			assert.doesNotMatch(seen, /Second question/);
			// The source is untouched.
			const after = await harness.call("GET", `/sessions/${sessionId}`);
			assert.equal((after.body.value.transcript as unknown[]).length, 4);
		} finally {
			await harness.cleanup();
		}
	});

	it("a fork before the first message starts empty, with that message's words handed back", async () => {
		// pi writes a branch only once its path holds a conversation; the host read the file it never wrote (500).
		const harness = await startHost();
		try {
			harness.faux.setResponses([fauxAssistantMessage("answer one")]);
			const sessionId = await createSession(harness);
			await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-1", op: "prompt", text: "First question" });
			await harness.waitFor(sessionId, (event) => event.type === "command.completed" && event.payload.commandId === "p-1");
			const source = await harness.call("GET", `/sessions/${sessionId}`);
			const first = (source.body.value.transcript as { entryId: string; role: string; text: string }[]).find((item) => item.role === "user");
			assert.ok(first);

			const fork = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "f-0", op: "fork", entryId: first.entryId });
			assert.equal(fork.status, 200, JSON.stringify(fork.body));
			assert.equal(fork.body.value.selectedText, "First question");
			assert.deepEqual(fork.body.value.session.parent, { sessionId, kind: "fork", entryId: first.entryId });
			const forkId = fork.body.value.session.sessionId as string;
			const empty = await harness.call("GET", `/sessions/${forkId}`);
			assert.deepEqual(empty.body.value.transcript, []);

			let seen = "";
			harness.faux.setResponses([
				(context) => {
					seen = contextText(context);
					return fauxAssistantMessage("a fresh first answer");
				},
			]);
			await harness.call("POST", `/sessions/${forkId}/commands`, { requestId: "p-2", op: "prompt", text: "A different first question" });
			await harness.waitFor(forkId, (event) => event.type === "run.settled");
			assert.doesNotMatch(seen, /First question/);
			const answered = await harness.call("GET", `/sessions/${forkId}`);
			assert.deepEqual(
				(answered.body.value.transcript as { text: string }[]).map((item) => item.text),
				["A different first question", "a fresh first answer"],
			);
			const listed = await harness.call("GET", "/sessions");
			assert.equal((listed.body.value.sessions as { sessionId: string; preview?: string }[]).find((row) => row.sessionId === forkId)?.preview, "A different first question");
		} finally {
			await harness.cleanup();
		}
	});
});
