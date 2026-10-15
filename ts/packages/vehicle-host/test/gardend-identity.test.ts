/**
 * vehicle-host as gardend's supervised service. It believes only what gardend mints (garden
 * `docs/local-service-hosting.md`): the per-spawn secret `x-internal-service`, `x-user-id`, the roles, and
 * `x-graph-id` from a graph-scoped path. The graph of a session comes from that header, never from a body;
 * the role fixes the session's access; the list is the caller's own, on the bound graph.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createSession, DRIVER, type Harness, SECRET, STRANGER, startHost, TEST_GRAPH } from "./harness.ts";

describe("gardend's identity, and nothing else", () => {
	let harness: Harness;
	before(async () => {
		harness = await startHost();
	});
	after(async () => harness.cleanup());

	it("does not believe the first version's own headers: without gardend's secret nothing passes, and its principal header names nobody", async () => {
		const v0 = await harness.call("GET", "/sessions", undefined, {
			secret: "",
			graphId: null,
			extra: { "x-vehicle-host-secret": SECRET, "x-vehicle-principal": "carol", "x-vehicle-role": "owner" },
		});
		assert.equal(v0.status, 401);
		assert.equal(v0.body.code, "unauthorized");
		const secretOnly = await harness.call("GET", "/sessions", undefined, {
			graphId: null,
			extra: { "x-vehicle-principal": "carol", "x-vehicle-role": "owner" },
		});
		assert.equal(secretOnly.status, 401);
		assert.equal(secretOnly.body.code, "identity_required");
	});

	it("takes the session's graph from x-graph-id: none is refused, and a body naming another graph is refused", async () => {
		const unbound = await harness.call("POST", "/sessions", { requestId: "c-unbound" }, { ...DRIVER, graphId: null });
		assert.equal(unbound.status, 400);
		assert.equal(unbound.body.code, "graph_required");
		const unboundWithBody = await harness.call("POST", "/sessions", { requestId: "c-body", graphId: "led-badge" }, { ...DRIVER, graphId: null });
		assert.equal(unboundWithBody.status, 400, "a body's graph is never enough");
		const mismatch = await harness.call("POST", "/sessions", { requestId: "c-mismatch", graphId: "someone-elses" });
		assert.equal(mismatch.status, 400);
		assert.equal(mismatch.body.code, "graph_mismatch");
		const created = await harness.call("POST", "/sessions", { requestId: "c-bound" }, { ...DRIVER, graphId: "notes" });
		assert.equal(created.status, 201);
		assert.equal(created.body.value.session.graphId, "notes");
		const same = await harness.call("POST", "/sessions", { requestId: "c-same", graphId: "notes" }, { ...DRIVER, graphId: "notes" });
		assert.equal(same.status, 201, "a body that repeats the bound graph is fine");
	});

	it("keeps a session to its graph: a request bound to another graph does not see or drive it", async () => {
		const sessionId = await createSession(harness, {}, { ...DRIVER, graphId: "graph-a" });
		const elsewhere = { ...DRIVER, graphId: "graph-b" };
		assert.equal((await harness.call("GET", `/sessions/${sessionId}`, undefined, elsewhere)).status, 404);
		assert.equal((await harness.call("GET", `/sessions/${sessionId}/events?since=0`, undefined, elsewhere)).status, 404);
		const drive = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "x", op: "prompt", text: "hi" }, elsewhere);
		assert.equal(drive.status, 404);
		const chime = await harness.call("POST", `/sessions/${sessionId}/chimes`, { requestId: "ch", author: "Codex", text: "hi" }, { ...STRANGER, graphId: "graph-b" });
		assert.equal(chime.status, 404);
		assert.equal((await harness.call("GET", `/sessions/${sessionId}`, undefined, { ...DRIVER, graphId: "graph-a" })).status, 200);
	});

	it("lists the caller's own sessions on the bound graph, newest first, with a preview of what was said", async () => {
		const local = await startHost();
		try {
			local.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
			const first = await createSession(local, { title: "named" });
			await local.call("POST", `/sessions/${first}/commands`, { requestId: "p-1", op: "prompt", text: "What   regulates\nthe 3.3 V rail?" });
			await local.waitFor(first, (event) => event.type === "run.settled");
			const second = await createSession(local);
			await local.call("POST", `/sessions/${second}/commands`, { requestId: "p-2", op: "prompt", text: "And the charger?" });
			await local.waitFor(second, (event) => event.type === "run.settled");
			await createSession(local, {}, { ...DRIVER, graphId: "other-graph" });
			await createSession(local, {}, STRANGER);

			const listed = await local.call("GET", "/sessions");
			assert.equal(listed.status, 200);
			const sessions = listed.body.value.sessions as Record<string, unknown>[];
			assert.deepEqual(
				sessions.map((session) => session.sessionId),
				[second, first],
				"the caller's sessions on this graph, most recently active first",
			);
			assert.equal(sessions[1]?.title, "named");
			assert.equal(sessions[1]?.preview, "What regulates the 3.3 V rail?");
			assert.equal(sessions[0]?.preview, "And the charger?");
			for (const session of sessions) {
				assert.equal(session.graphId, TEST_GRAPH);
				assert.ok(Date.parse(String(session.updatedAt)) >= Date.parse(String(session.createdAt)));
			}
			const everywhere = await local.call("GET", "/sessions", undefined, { ...DRIVER, graphId: null });
			assert.equal((everywhere.body.value.sessions as unknown[]).length, 3, "no graph: the caller's sessions on every graph");
			const theirs = await local.call("GET", "/sessions", undefined, STRANGER);
			assert.equal((theirs.body.value.sessions as unknown[]).length, 1);
		} finally {
			await local.cleanup();
		}
	});

	it("fixes the session's access by the role gardend minted for the graph", async () => {
		const viewer = await harness.call("POST", "/sessions", { requestId: "c-viewer" }, { ...DRIVER, role: "viewer" });
		assert.equal(viewer.body.value.session.access, "read");
		const editor = await harness.call("POST", "/sessions", { requestId: "c-editor" }, { ...DRIVER, role: "editor" });
		assert.equal(editor.body.value.session.access, "write");
		// With a graph, the graph role decides, whatever the caller role says.
		const graphRole = await harness.call("POST", "/sessions", { requestId: "c-graph-role" }, {
			...DRIVER,
			role: undefined,
			extra: { "x-sophia-caller-role": "owner", "x-sophia-graph-role": "viewer" },
		});
		assert.equal(graphRole.status, 201, JSON.stringify(graphRole.body));
		assert.equal(graphRole.body.value.session.access, "read");
		const noRole = await harness.call("POST", "/sessions", { requestId: "c-no-role" }, { ...DRIVER, role: undefined });
		assert.equal(noRole.status, 400);
		assert.equal(noRole.body.code, "invalid_identity");
	});

	it("opens an event stream at once, before any event: a client watches first, then sends", async () => {
		const sessionId = await createSession(harness);
		const cursor = (await harness.events(sessionId)).at(-1)?.seq ?? 0;
		const controller = new AbortController();
		const startedAt = Date.now();
		const response = await fetch(`${harness.url}/sessions/${sessionId}/events?since=${cursor}`, {
			headers: {
				accept: "text/event-stream",
				"x-internal-service": SECRET,
				"x-user-id": "carol",
				"x-graph-id": TEST_GRAPH,
				"x-sophia-graph-role": "owner",
				"x-vehicle-client-id": "chat-tab-1",
			},
			signal: controller.signal,
		});
		const waited = Date.now() - startedAt;
		controller.abort();
		assert.equal(response.headers.get("content-type"), "text/event-stream");
		assert.ok(waited < 500, `the stream opened after ${waited} ms (the heartbeat is 1000 ms)`);
	});

	it("will not let a writer's conversation be driven by a caller whose role now only reads", async () => {
		const sessionId = await createSession(harness, {}, { ...DRIVER, role: "owner" });
		const reduced = { ...DRIVER, role: "viewer" };
		const command = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-r", op: "prompt", text: "write something" }, reduced);
		assert.equal(command.status, 403);
		assert.equal(command.body.code, "access_reduced");
		const claim = await harness.call("POST", `/sessions/${sessionId}/claim`, { requestId: "c-r" }, { ...reduced, clientId: "other-tab" });
		assert.equal(claim.status, 403);
		assert.equal(claim.body.code, "access_reduced");
		assert.equal((await harness.call("GET", `/sessions/${sessionId}`, undefined, reduced)).status, 200, "reading it is still theirs");
	});
});

const here = dirname(fileURLToPath(import.meta.url));
const MAIN = join(here, "..", "src", "main.ts");

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			server.close(() => resolve(port));
		});
		server.on("error", reject);
	});
}

/** Run `main.ts` as gardend runs the service: only the environment gardend gives a child. */
function runMain(env: Record<string, string>): { exited: Promise<{ code: number | null; output: string }>; stop: () => void } {
	const child = spawn(process.execPath, ["--conditions=sophia-source", MAIN], {
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		output += String(chunk);
	});
	return {
		exited: new Promise((resolve) => child.on("exit", (code) => resolve({ code, output }))),
		stop: () => child.kill("SIGTERM"),
	};
}

describe("the service entry under gardend's environment", () => {
	it("refuses to start without gardend's secret, whatever the first version's variable says", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "vehicle-main-"));
		try {
			const run = runMain({ VEHICLE_HOST_SECRET: SECRET, DATA_DIR: dataDir, PORT: String(await freePort()) });
			const { code, output } = await run.exited;
			assert.equal(code, 2);
			assert.match(output, /MNEMOSYNE_INTERNAL_SERVICE_SECRET is required/);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("serves on gardend's port and data dir, and answers a request carrying gardend's minted headers", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "vehicle-main-"));
		const port = await freePort();
		const run = runMain({
			MNEMOSYNE_INTERNAL_SERVICE_SECRET: SECRET,
			DATA_DIR: dataDir,
			PORT: String(port),
			GARDEN_SERVICE_HOST: "127.0.0.1",
			GARDEN_SERVICE_ID: "vehicle",
		});
		try {
			const base = `http://127.0.0.1:${port}`;
			let health: Response | undefined;
			for (let attempt = 0; attempt < 100 && !health?.ok; attempt += 1) {
				health = await fetch(`${base}/health`).catch(() => undefined);
				if (!health?.ok) await new Promise((resolve) => setTimeout(resolve, 100));
			}
			assert.equal(health?.status, 200);
			const minted = {
				"x-internal-service": SECRET,
				"x-user-id": "owner",
				"x-sophia-caller-role": "owner",
				"x-graph-id": "led-badge",
				"x-sophia-graph-role": "owner",
				"x-vehicle-client-id": "tab-1",
				"content-type": "application/json",
			};
			const created = await fetch(`${base}/sessions`, { method: "POST", headers: minted, body: JSON.stringify({ requestId: "main-1" }) });
			const body = (await created.json()) as { value: { session: { graphId: string; model: string; access: string } } };
			assert.equal(created.status, 201, JSON.stringify(body));
			assert.equal(body.value.session.graphId, "led-badge");
			assert.equal(body.value.session.model, "openrouter/openai/gpt-6-luna");
			const forged = await fetch(`${base}/sessions`, { headers: { ...minted, "x-internal-service": "x".repeat(SECRET.length) } });
			assert.equal(forged.status, 401);
		} finally {
			run.stop();
			const { code } = await run.exited;
			assert.equal(code, 0, "SIGTERM is a clean stop (gardend does not restart it)");
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
