/**
 * The MCP leg against a real gardend (`VEHICLE_TEST_GARDEND_BIN`, see `gardend-fixture.ts`; skipped without it).
 * A session's graph tools act for its owner with the delegation token gardend handed for them: gardend binds the
 * graph (the model's calls carry none and nothing rewrites them), attributes the writes to the person through
 * the service, and refuses a viewer's writes itself. The model is pi's faux provider, scripted to call the tools.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, getSystemMessageText, type Message } from "@earendil-works/pi-ai";
import { GARDEND_BIN, type Gardend, startGardend } from "./gardend-fixture.ts";
import { contextText, createSession, type Harness, type Identity, startHost } from "./harness.ts";

const GRAPH = "proof-graph";
const ELSEWHERE = "elsewhere";

function filesUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? filesUnder(path) : [path];
	});
}

describe("a session's graph tools against a real gardend", { skip: GARDEND_BIN ? false : "set VEHICLE_TEST_GARDEND_BIN" }, () => {
	let gardend: Gardend;
	let harness: Harness;

	before(async () => {
		gardend = await startGardend(GARDEND_BIN as string);
		for (const graph of [GRAPH, ELSEWHERE]) {
			const created = await gardend.tool(gardend.key, "create_graph", { graph_id: graph, title: graph });
			assert.equal(created.error, undefined, JSON.stringify(created));
		}
		harness = await startHost({ gardend: { url: `${gardend.url}/mcp` }, graphId: GRAPH });
	});
	after(async () => {
		await harness?.cleanup();
		await gardend?.stop();
	});

	/** The caller as gardend minted it on the graph-scoped path, with the delegation token it handed. */
	const asCaller = (delegation: { userId: string; graphRole: string; token: string }, clientId: string): Identity => ({
		principal: delegation.userId,
		role: delegation.graphRole,
		clientId,
		extra: { "x-sophia-delegated-token": delegation.token },
	});

	const run = async (who: Identity, text: string) => {
		const sessionId = await createSession(harness, {}, who);
		const sent = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: `p-${Math.random()}`, op: "prompt", text }, who);
		assert.equal(sent.status, 200, JSON.stringify(sent.body));
		await harness.waitFor(sessionId, (event) => event.type === "run.settled", 30_000, who);
		return { sessionId, events: await harness.events(sessionId, 0, who) };
	};
	const toolResults = (events: Awaited<ReturnType<typeof run>>["events"]) =>
		events.filter((event) => event.type === "tool.result").map((event) => event.payload as { toolName: string; isError: boolean; text: string });
	const toolCalls = (events: Awaited<ReturnType<typeof run>>["events"]) =>
		events
			.filter((event) => event.type === "message.completed" && event.payload.toolCalls)
			.flatMap((event) => event.payload.toolCalls as { name: string; args: Record<string, unknown> }[]);

	it("acts for the owner on the session's graph: no graph argument, the write is the owner's, another graph is fenced", async () => {
		const owner = await gardend.delegation(gardend.key, GRAPH);
		assert.equal(owner.userId, "owner");
		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("mcp__sophia__create_document", { title: "Written for the owner" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("mcp__sophia__list_documents", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("mcp__sophia__list_documents", { graphId: ELSEWHERE }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const { sessionId, events } = await run(asCaller(owner, "owner-tab"), "Write a document, then list what is here.");

		const tools = events.find((event) => event.type === "run.started")?.payload.tools as string[];
		assert.ok(tools.includes("mcp__sophia__create_document") && tools.includes("mcp__sophia__datasheet_facts"), tools.join(","));
		const results = toolResults(events);
		assert.equal(results[0]?.toolName, "mcp__sophia__create_document");
		assert.equal(results[0]?.isError, false, results[0]?.text);
		assert.equal(results[1]?.isError, false, results[1]?.text);
		assert.match(results[1]?.text ?? "", /Written for the owner/);
		assert.equal(results[2]?.isError, true, "a call naming another graph is fenced");
		// The calls ran as the model made them: gardend filled the graph in, nothing rewrote them.
		for (const call of toolCalls(events).slice(0, 2)) assert.deepEqual(Object.keys(call.args).filter((key) => /graph/i.test(key)), [], JSON.stringify(call));

		const crdt = gardend.audit().filter((row) => row.category === "crdt.operation" && row.outcome === "succeeded" && row.details?.graphId === GRAPH);
		assert.ok(crdt.some((row) => row.actor === "owner" && row.details.via === "service:vehicle"), JSON.stringify(crdt.map((row) => [row.actor, row.details?.via])));
		const calls = gardend.audit().filter((row) => row.category === "mcp.tools.call");
		assert.ok(calls.some((row) => row.actor === "owner" && row.action === "create_document" && row.targetId === GRAPH && row.details.via === "service:vehicle"));

		// The token never reached the host's files.
		for (const file of filesUnder(harness.dataDir)) assert.ok(!readFileSync(file, "utf8").includes("sophia-dlg-"), file);
		assert.ok(harness.host.sessions.get(sessionId)?.hasDelegatedToken);
	});

	it("acts for a member as the member", async () => {
		const member = gardend.clientToken("member");
		const delegation = await gardend.delegation(member.token, GRAPH);
		assert.equal(delegation.userId, `token:${member.id}`);
		assert.equal(delegation.graphRole, "editor");
		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("mcp__sophia__create_document", { title: "Written for the member" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const { events } = await run(asCaller(delegation, "member-tab"), "Write a document.");
		assert.equal(toolResults(events)[0]?.isError, false, toolResults(events)[0]?.text);
		const crdt = gardend.audit().filter((row) => row.category === "crdt.operation" && row.outcome === "succeeded");
		assert.ok(crdt.some((row) => row.actor === `token:${member.id}` && row.details.via === "service:vehicle"));
		assert.ok(!crdt.some((row) => row.actor === "service:vehicle" || row.actor === "local-runtime"), "no write is the service's own");
	});

	it("reads for a viewer, and gardend itself refuses the viewer's writes", async () => {
		// A reader who may reach the chat: the read-only grant plus the service proxy.
		const viewer = gardend.readOnlyTokenWith(["services.proxy"]);
		const delegation = await gardend.delegation(viewer.token, GRAPH);
		assert.equal(delegation.graphRole, "viewer");

		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("mcp__sophia__list_documents", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const { events } = await run(asCaller(delegation, "viewer-tab"), "What is here?");
		const tools = events.find((event) => event.type === "run.started")?.payload.tools as string[];
		assert.ok(!tools.includes("mcp__sophia__create_document"), "the host withholds writers from a viewer");
		assert.equal(toolResults(events)[0]?.isError, false);
		assert.match(toolResults(events)[0]?.text ?? "", /Written for the owner/);

		// And had the host's filter been bypassed: gardend lists no writer for the token and refuses the write.
		const listed = await gardend.mcp(delegation.token, "tools/list");
		const names = (listed.body.result.tools as { name: string }[]).map((tool) => tool.name);
		assert.ok(names.includes("read_document") && !names.includes("create_document") && !names.includes("write_document"));
		const refused = await gardend.tool(delegation.token, "create_document", { title: "Not for a viewer" });
		assert.match(refused.error?.message ?? "", /missing required scope (documents|workspace)\.write\.crdt/);
	});

	it("runs a tool the model called by its bare name (gemini drops pi's mcp__sophia__ prefix)", async () => {
		const owner = await gardend.delegation(gardend.key, GRAPH);
		harness.faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("list_documents", {}), fauxToolCall("default_api.search_documents", { query: "Written" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("sparql_update", { query: "INSERT DATA {}" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const { sessionId, events } = await run(asCaller(owner, "bare-tab"), "What is here?");
		const results = toolResults(events);
		assert.equal(results[0]?.toolName, "mcp__sophia__list_documents");
		assert.equal(results[0]?.isError, false, results[0]?.text);
		assert.match(results[0]?.text ?? "", /Written for the owner/);
		assert.equal(results[1]?.toolName, "mcp__sophia__search_documents");
		assert.equal(results[1]?.isError, false, results[1]?.text);
		assert.equal(results[2]?.isError, true, "a bare name outside the profile stays unknown");
		assert.match(results[2]?.text ?? "", /not found/);
		const inspected = await harness.call("GET", `/sessions/${sessionId}`, undefined, asCaller(owner, "bare-tab"));
		const names = (inspected.body.value.transcript as { toolCalls?: { name: string }[] }[]).flatMap((item) => (item.toolCalls ?? []).map((call) => call.name));
		assert.deepEqual(names.slice(0, 2), ["mcp__sophia__list_documents", "mcp__sophia__search_documents"], "the transcript records the names that ran");
	});

	it("an agent body asks its host for the token over pi's RPC channel: it acts for the owner, and its shell never sees it", async () => {
		const owner = await gardend.delegation(gardend.key, GRAPH);
		const who = asCaller(owner, "agent-tab");
		const sessionId = await createSession(harness, { profile: "agent" }, who);
		const turn = async (text: string, identity: Identity) => {
			const mark = (await harness.events(sessionId, 0, identity)).at(-1)?.seq ?? 0;
			const requestId = `a-${Math.random()}`;
			const sent = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId, op: "prompt", text }, identity);
			assert.equal(sent.status, 200, JSON.stringify(sent.body));
			await harness.waitFor(sessionId, (event) => event.type === "run.settled" && event.seq > mark, 60_000, identity);
			return harness.events(sessionId, mark, identity);
		};
		const first = await turn(
			'[tool mcp__sophia__create_document {"title":"Written by an agent body"}] [tool mcp__sophia__list_documents {}] [tool bash {"command":"env; tr \'\\\\0\' \'\\\\n\' < /proc/$PPID/environ 2>/dev/null; echo END"}]',
			who,
		);
		const materialized = first.find((event) => event.type === "body.materialized");
		assert.equal(materialized?.payload.kind, "rpc");
		const tools = first.find((event) => event.type === "run.started")?.payload.tools as string[];
		assert.ok(tools.includes("bash") && tools.includes("mcp__sophia__create_document"), tools.join(","));
		const [created, listed, shell] = toolResults(first);
		assert.equal(created?.isError, false, created?.text);
		assert.equal(listed?.isError, false, listed?.text);
		assert.match(listed?.text ?? "", /Written by an agent body/);
		assert.match(shell?.text ?? "", /END/);
		assert.doesNotMatch(shell?.text ?? "", /sophia-dlg-/, "the token is not in the shell's environment, nor pi's");
		assert.ok(!(shell?.text ?? "").includes(owner.token));
		const calls = gardend.audit().filter((row) => row.category === "mcp.tools.call" && row.action === "create_document");
		assert.ok(calls.some((row) => row.actor === "owner" && row.targetId === GRAPH && row.details.via === "service:vehicle"), "the write is the owner's");

		// A token gardend never minted, offered with the next request: the live body's very next call carries it.
		const bogus = await turn("[tool mcp__sophia__list_documents {}]", { ...who, extra: { "x-sophia-delegated-token": `sophia-dlg-${"0".repeat(64)}` } });
		assert.equal(toolResults(bogus)[0]?.isError, true, "the body asked for the newest token and got the bogus one");
		const real = await turn("[tool mcp__sophia__list_documents {}]", who);
		assert.equal(toolResults(real)[0]?.isError, false, toolResults(real)[0]?.text);
		for (const events of [bogus, real]) {
			assert.equal(events.filter((event) => event.type === "body.materialized").length, 0, "the same body throughout");
		}
		// Nowhere on disk: not the host's files, not the agent's workspace or pi folder.
		for (const file of filesUnder(harness.dataDir)) assert.ok(!readFileSync(file, "utf8").includes("sophia-dlg-"), file);
	});

	it("reads the newest token before every request: a refresh takes effect in a live body", async () => {
		const owner = await gardend.delegation(gardend.key, GRAPH);
		const who = asCaller(owner, "refresh-tab");
		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("mcp__sophia__list_documents", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("one"),
			fauxAssistantMessage(fauxToolCall("mcp__sophia__list_documents", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("two"),
			fauxAssistantMessage(fauxToolCall("mcp__sophia__list_documents", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("three"),
		]);
		const { sessionId } = await run(who, "first");
		// Every request of the owner refreshes the session's token, the watch included: a turn is sent and
		// watched with one identity, so the token under test is the only one offered while it runs.
		const turn = async (text: string, identity: Identity) => {
			const mark = (await harness.events(sessionId, 0, identity)).at(-1)?.seq ?? 0;
			const sent = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: text, op: "prompt", text }, identity);
			assert.equal(sent.status, 200, JSON.stringify(sent.body));
			await harness.waitFor(sessionId, (event) => event.type === "run.settled" && event.seq > mark, 30_000, identity);
			return harness.events(sessionId, mark, identity);
		};
		// A token gardend never minted, in gardend's shape: the very next call carries it and is refused.
		const afterBogus = await turn("bogus", { ...who, extra: { "x-sophia-delegated-token": `sophia-dlg-${"0".repeat(64)}` } });
		assert.equal(toolResults(afterBogus)[0]?.isError, true, "the bogus token was used at once, without a new body");
		// The real one again, offered with the next request: the same body's next call works.
		const afterReal = await turn("real", who);
		assert.equal(toolResults(afterReal)[0]?.isError, false, toolResults(afterReal)[0]?.text);
		for (const events of [afterBogus, afterReal]) {
			assert.equal(events.filter((event) => event.type === "body.materialized").length, 0, "the same body throughout");
		}
	});

	it("the model reads the chat prompt's datasheet guidance: documents first, datasheets too, no refusal for a missing one", async () => {
		// Live runs: the old rule ("Files are not documents ... say that its datasheet has not been imported")
		// had gemini-2.5-flash refuse part questions the documents answer. pi's faux model records the system prompt
		// exactly as a provider gets it, with gardend's live tools (datasheet_facts among them).
		const owner = await gardend.delegation(gardend.key, GRAPH);
		const seen: { system: string; text: string }[] = [];
		const shown = (context: { messages: readonly Message[] }) => {
			const system = context.messages.find((message) => message.role === "system");
			seen.push({ system: system ? getSystemMessageText(system) : "", text: contextText(context) });
		};
		harness.faux.setResponses([
			(context) => {
				shown(context);
				return fauxAssistantMessage(fauxToolCall("mcp__sophia__datasheet_facts", { part: "TPS63020", parameter: "vin" }), { stopReason: "toolUse" });
			},
			(context) => {
				shown(context);
				return fauxAssistantMessage("done");
			},
		]);
		const { events } = await run(asCaller(owner, "prompt-tab"), "What's the max input voltage of the TPS63020?");
		const [first, second] = seen;
		assert.ok(first && second, `two model calls, saw ${seen.length}`);
		const prompt = first.system;
		const sentences = [
			"Answer from what this workspace holds: its documents first, then its files and datasheets.",
			"`mcp__sophia__datasheet_facts` adds what an imported datasheet (a PDF file) says about a part",
			"If a read fails or a search or `mcp__sophia__datasheet_facts` finds nothing, try another way before saying something is not here",
			"Parts. Search the documents for a part number before you ask `mcp__sophia__datasheet_facts` about it",
			"Ask `mcp__sophia__datasheet_facts` as well when the question is about a part's electrical facts (ratings, voltages, currents, frequencies), and cite the datasheet and page.",
			"If it finds nothing, the part's datasheet is not imported: answer from the documents, and never refuse for that reason.",
			"`mcp__sophia__get_workspace` lists them, and a datasheet's file name usually carries its part number.",
			"If you did not find something after trying other ways, say so and say what you tried.",
		];
		for (const sentence of sentences) assert.ok(prompt.includes(sentence), `the prompt says: ${sentence}`);
		assert.doesNotMatch(prompt, /Files are not documents|say that its datasheet has not been imported/, "the rule that made the model refuse is gone");
		// The tool ran for real against gardend: its "not found" is what the model reads next, unaltered.
		const facts = toolResults(events)[0];
		assert.equal(facts?.toolName, "mcp__sophia__datasheet_facts");
		assert.equal(facts?.isError, false, facts?.text);
		assert.match(second.text, /"matched": 0/);
	});
});
