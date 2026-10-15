/**
 * The delegation token gardend hands with a caller's graph-scoped requests (`x-sophia-delegated-token`,
 * garden `docs/local-service-hosting.md`): the host keeps the newest one per session, of the session's owner on
 * its graph only, in memory only. It never reaches a file, an event, the capsule, a listing or a transcript, and
 * a revived session has none until its owner's next request. With gardend configured, a body never starts
 * without one (it would have no graph tools for its whole life). Model: pi's faux provider.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createSession, DRIVER, STRANGER, startHost, TEST_GRAPH } from "./harness.ts";

const token = (digit: string) => `sophia-dlg-${digit.repeat(64)}`;
const withToken = (value: string) => ({ ...DRIVER, extra: { "x-sophia-delegated-token": value } });

function filesUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? filesUnder(path) : [path];
	});
}

describe("the delegation token", () => {
	it("is kept per session, from its owner on its graph only, and written nowhere", async () => {
		const harness = await startHost();
		try {
			const first = token("a");
			const second = token("b");
			harness.faux.setResponses([fauxAssistantMessage("hello"), fauxAssistantMessage("again")]);
			const sessionId = await createSession(harness, {}, withToken(first));
			const session = harness.host.sessions.get(sessionId);
			assert.equal(session?.hasDelegatedToken, true, "the creating request's token");

			const prompt = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-1", op: "prompt", text: "hi" }, withToken(first));
			assert.equal(prompt.status, 200, JSON.stringify(prompt.body));
			await harness.waitFor(sessionId, (event) => event.type === "run.settled");
			// A watch, an inspect and a capsule refresh it too (every request of the owner on the graph).
			for (const path of [`/sessions/${sessionId}/events?since=0`, `/sessions/${sessionId}`, `/sessions/${sessionId}/capsule`]) {
				const reply = await harness.call("GET", path, undefined, withToken(second));
				assert.equal(reply.status, 200, path);
				assert.ok(!JSON.stringify(reply.body).includes("sophia-dlg-"), `${path} shows a token`);
			}
			const listed = await harness.call("GET", "/sessions", undefined, withToken(second));
			assert.ok(!JSON.stringify(listed.body).includes("sophia-dlg-"));
			const again = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-2", op: "prompt", text: "and again" }, withToken(second));
			assert.equal(again.status, 200);
			await harness.waitFor(sessionId, (event) => event.type === "run.settled" && event.seq > 0);

			// Nothing on disk holds it: meta, command log, event log, pi's own session file.
			await harness.stop();
			for (const file of filesUnder(harness.dataDir)) {
				const text = readFileSync(file, "utf8");
				for (const secret of [first, second]) assert.ok(!text.includes(secret), `${file} holds a delegation token`);
				assert.ok(!text.includes("sophia-dlg-"), file);
			}
		} finally {
			await harness.cleanup();
		}
	});

	it("is not taken from someone else, from another graph, from an unbound request or in another shape", async () => {
		const harness = await startHost();
		try {
			const sessionId = await createSession(harness);
			const session = harness.host.sessions.get(sessionId);
			assert.equal(session?.hasDelegatedToken, false);
			// A stranger may chime into a session on the graph; their token is theirs, not the session's.
			const chime = await harness.call(
				"POST",
				`/sessions/${sessionId}/chimes`,
				{ requestId: "c-1", text: "psst", author: "stranger" },
				{ ...STRANGER, extra: { "x-sophia-delegated-token": token("c") } },
			);
			assert.equal(chime.status, 200, JSON.stringify(chime.body));
			assert.equal(session?.hasDelegatedToken, false, "a chimer's token is not the session's");
			// The owner, bound to another graph: the session is not even visible, and its token is for that graph.
			const elsewhere = await harness.call("GET", `/sessions/${sessionId}`, undefined, { ...withToken(token("d")), graphId: "another-graph" });
			assert.equal(elsewhere.status, 404);
			// The owner on an unbound path: gardend would hand no token there; one that arrives anyway is ignored.
			await harness.call("GET", `/sessions/${sessionId}`, undefined, { ...withToken(token("e")), graphId: null });
			assert.equal(session?.hasDelegatedToken, false);
			// Not gardend's shape (a forged or pi-expandable value): ignored.
			for (const forged of ["${MNEMOSYNE_MCP_ACCESS_TOKEN}", "sophia-dlg-short", `${token("f")}x`, "Bearer x"]) {
				await harness.call("GET", `/sessions/${sessionId}`, undefined, withToken(forged));
				assert.equal(session?.hasDelegatedToken, false, forged);
			}
			await harness.call("GET", `/sessions/${sessionId}`, undefined, withToken(token("0")));
			assert.equal(session?.hasDelegatedToken, true);
		} finally {
			await harness.cleanup();
		}
	});

	it("dies with the host: a revived session has none until its owner's next request", async () => {
		const first = await startHost();
		const sessionId = await createSession(first, {}, withToken(token("1")));
		assert.equal(first.host.sessions.get(sessionId)?.hasDelegatedToken, true);
		await first.stop();
		const revived = await startHost({ dataDir: first.dataDir });
		try {
			const session = revived.host.sessions.get(sessionId);
			assert.equal(session?.hasDelegatedToken, false);
			await revived.call("GET", `/sessions/${sessionId}/events?since=0`, undefined, withToken(token("2")));
			assert.equal(session?.hasDelegatedToken, true);
		} finally {
			await revived.cleanup();
		}
	});

	it("with gardend configured, a body never starts without one", async () => {
		// Nothing listens on this port: the refusal comes before any connection is tried.
		const harness = await startHost({ gardend: { url: "http://127.0.0.1:9/mcp" } });
		try {
			const sessionId = await createSession(harness);
			const refused = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-1", op: "prompt", text: "hi" });
			assert.equal(refused.status, 409, JSON.stringify(refused.body));
			assert.equal(refused.body.code, "delegation_required");
			assert.match(refused.body.message, /\/g\/<graph>\/sessions/);
			assert.equal(TEST_GRAPH, "test-graph");
		} finally {
			await harness.cleanup();
		}
	});
});
