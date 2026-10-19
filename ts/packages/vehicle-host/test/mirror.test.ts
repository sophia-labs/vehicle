/**
 * The session mirror against a real gardend (`VEHICLE_TEST_GARDEND_BIN`, see `gardend-fixture.ts`; skipped
 * without it): each conversation's record becomes a Garden document in its graph, under `_sophia/Conversations`,
 * written for the person with their delegation token after each settled run. The model is pi's faux provider.
 *
 * What it holds: the document exists after a run with the transcript (no hidden note, no token), gardend's
 * audit names the person (via the service), a second run updates it in place, a rename renames it, a delete
 * hands its id to the client, which puts it in Garden's Trash, a restored session keeps it current, a viewer's
 * session writes nothing, fork and clone produce sessions whose documents are wired to their parent's, and
 * `mirror: false` (VEHICLE_MIRROR=off) writes nothing.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { AGENT_FOLDER, BRANCH_PREDICATE, CONVERSATIONS_FOLDER, mirrorDocumentId } from "../src/index.ts";
import { GARDEND_BIN, type Gardend, startGardend } from "./gardend-fixture.ts";
import { createSession, type Harness, type Identity, startHost } from "./harness.ts";

const GRAPH = "mirror-graph";
const OFF_GRAPH = "mirror-off-graph";

describe("the session mirror against a real gardend", { skip: GARDEND_BIN ? false : "set VEHICLE_TEST_GARDEND_BIN" }, () => {
	let gardend: Gardend;
	let harness: Harness;
	let owner: Identity;

	before(async () => {
		gardend = await startGardend(GARDEND_BIN as string);
		for (const graph of [GRAPH, OFF_GRAPH]) {
			const created = await gardend.tool(gardend.key, "create_graph", { graph_id: graph, title: graph });
			assert.equal(created.error, undefined, JSON.stringify(created));
		}
		harness = await startHost({ gardend: { url: `${gardend.url}/mcp` }, graphId: GRAPH });
		owner = asCaller(await gardend.delegation(gardend.key, GRAPH), "owner-tab");
	});
	after(async () => {
		await harness?.cleanup();
		await gardend?.stop();
	});

	function asCaller(delegation: { userId: string; graphRole: string; token: string }, clientId: string, graphId = GRAPH): Identity {
		return { principal: delegation.userId, role: delegation.graphRole, clientId, graphId, extra: { "x-sophia-delegated-token": delegation.token } };
	}

	/** The owner's view of the graph, with the master key (which names the graph). */
	const ownerTool = async (name: string, args: Record<string, unknown>, graph = GRAPH) => {
		const reply = await gardend.tool(gardend.key, name, { graphId: graph, ...args });
		if (reply.error) throw new Error(`${name}: ${reply.error.message}`);
		return reply.result.structuredContent as Record<string, any>;
	};
	const readMirror = async (sessionId: string) => (await ownerTool("read_document", { documentId: mirrorDocumentId(sessionId), format: "markdown" })) as { title: string; content: string; revision: number };
	const conversationsFolder = async (graph = GRAPH) => (await ownerTool("get_workspace", { folderId: CONVERSATIONS_FOLDER.id, depth: 1 }, graph)).documents as { id: string; title: string; parentId: string }[];

	/** A prompt, its run settled and (unless `mirrored` is false) its mirror written. */
	async function turn(h: Harness, sessionId: string, who: Identity, text: string, extra: Record<string, unknown> = {}, mirrored = true) {
		const mark = (await h.events(sessionId, 0, who)).at(-1)?.seq ?? 0;
		const sent = await h.call("POST", `/sessions/${sessionId}/commands`, { requestId: `p-${Math.random()}`, op: "prompt", text, ...extra }, who);
		assert.equal(sent.status, 200, JSON.stringify(sent.body));
		await h.waitFor(sessionId, (event) => event.type === "run.settled" && event.seq > mark, 30_000, who);
		if (mirrored) await h.waitFor(sessionId, (event) => (event.type === "mirror.written" || event.type === "mirror.failed") && event.seq > mark, 30_000, who);
		return (await h.events(sessionId, mark, who)).filter((event) => event.type.startsWith("mirror."));
	}

	let mainSession = "";

	it("writes the record after a settled run, for the person, in _sophia/Conversations, and updates it in place", async () => {
		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("mcp__sophia__list_documents", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("This workspace has no documents yet."),
			fauxAssistantMessage("The second answer, in place."),
		]);
		mainSession = await createSession(harness, {}, owner);
		const first = await turn(harness, mainSession, owner, "What is in this workspace?", { contextRefs: ["doc-open-1"] });
		assert.equal(first.at(-1)?.type, "mirror.written", JSON.stringify(first));
		assert.equal(first.at(-1)?.payload.created, true);

		// Where it lives: the agent folder `_sophia`, its `Conversations`, one document named by the first question.
		const folders = (await ownerTool("get_workspace", { foldersOnly: true, depth: 2 })).folders as { id: string; title: string; parentId: string | null }[];
		assert.deepEqual(
			folders.filter((folder) => folder.id === AGENT_FOLDER.id || folder.id === CONVERSATIONS_FOLDER.id).map((folder) => [folder.id, folder.title, folder.parentId]),
			[
				[AGENT_FOLDER.id, "_sophia", null],
				[CONVERSATIONS_FOLDER.id, "Conversations", AGENT_FOLDER.id],
			],
		);
		assert.deepEqual(
			(await conversationsFolder()).map((doc) => [doc.id, doc.title]),
			[[mirrorDocumentId(mainSession), "What is in this workspace?"]],
		);

		// What it says: who and when, the question as asked, the tool chip, the answer; never the note for the model or a token.
		const doc = await readMirror(mainSession);
		assert.match(doc.content, /^Conversation with Sophia · started \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · model `faux-1` \(faux\)/);
		assert.match(doc.content, /\*\*Owner\*\* · \d{2}:\d{2} UTC\n\nWhat is in this workspace\?\n\n\*\*Sophia\*\* · \d{2}:\d{2} UTC\n\n`list_documents`\n\nThis workspace has no documents yet\./);
		assert.doesNotMatch(doc.content, /Open in the person's view|doc-open-1|sophia-dlg-/);

		// gardend's audit: the person wrote it, through the service.
		const writes = gardend.audit().filter((row) => row.category === "mcp.tools.call" && row.targetId === GRAPH && ["create_document", "write_document", "create_folder"].includes(row.action));
		assert.ok(writes.length >= 4, JSON.stringify(writes.map((row) => row.action)));
		for (const row of writes) {
			assert.equal(row.actor, "owner");
			assert.equal(row.details.via, "service:vehicle");
			assert.equal(row.outcome, "succeeded");
		}
		const inspected = await harness.call("GET", `/sessions/${mainSession}`, undefined, owner);
		assert.equal(inspected.body.value.mirror.state, "written");
		assert.equal(inspected.body.value.mirror.documentId, mirrorDocumentId(mainSession));
		assert.equal(inspected.body.value.mirror.folder, "_sophia/Conversations");

		// A second run: the same document, updated in place, both turns in it.
		const second = await turn(harness, mainSession, owner, "And now?");
		assert.equal(second.at(-1)?.payload.created, false);
		const updated = await readMirror(mainSession);
		assert.ok(updated.revision > doc.revision);
		assert.match(updated.content, /This workspace has no documents yet\.[\s\S]*\*\*Owner\*\* · \d{2}:\d{2} UTC\n\nAnd now\?[\s\S]*The second answer, in place\./);
		assert.equal((await conversationsFolder()).length, 1, "updated, not duplicated");
		// The folders were made once: the second write made none.
		assert.equal(gardend.audit().filter((row) => row.category === "mcp.tools.call" && row.action === "create_folder").length, 2);
	});

	it("renames the document with the conversation", async () => {
		const mark = (await harness.events(mainSession, 0, owner)).at(-1)?.seq ?? 0;
		const renamed = await harness.call("PATCH", `/sessions/${mainSession}`, { title: "What the workspace holds" }, owner);
		assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
		await harness.waitFor(mainSession, (event) => event.type === "mirror.written" && event.seq > mark, 30_000, owner);
		assert.deepEqual((await conversationsFolder()).map((doc) => doc.title), ["What the workspace holds"]);
		const rename = gardend.audit().filter((row) => row.category === "mcp.tools.call" && row.action === "rename");
		assert.equal(rename.at(-1)?.actor, "owner");
	});

	it("keeps the document where the person put it when the host lost word of its create", async () => {
		// gardend refuses a create over an existing document (2026-10-14); the mirror asks it to keep the one there.
		const documentId = mirrorDocumentId(mainSession);
		await ownerTool("create_folder", { folderId: "kept-conversations", name: "Kept" });
		await ownerTool("move_documents", { documentIds: [documentId], parentId: "kept-conversations" });
		// A create whose reply was lost leaves mirror.json without `created`: the next write creates again.
		const statePath = join(harness.dataDir, "sessions", mainSession, "mirror.json");
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		assert.ok(state.created, JSON.stringify(state));
		delete state.created;
		writeFileSync(statePath, JSON.stringify(state));
		harness.faux.setResponses([fauxAssistantMessage("An answer after the lost reply.")]);
		const events = await turn(harness, mainSession, owner, "Are you still there?");
		assert.equal(events.at(-1)?.type, "mirror.written", JSON.stringify(events));
		const kept = (await ownerTool("get_workspace", { folderId: "kept-conversations", depth: 1 })).documents as { id: string; title: string }[];
		assert.deepEqual(kept.map((doc) => [doc.id, doc.title]), [[documentId, "What the workspace holds"]], "left where the person put it, its title kept");
		assert.match((await readMirror(mainSession)).content, /An answer after the lost reply\./);
		await ownerTool("move_documents", { documentIds: [documentId], parentId: CONVERSATIONS_FOLDER.id });
	});

	it("hands a deleted conversation's document to the client for the Trash; a restored session keeps it current", async () => {
		const deleted = await harness.call("DELETE", `/sessions/${mainSession}`, undefined, owner);
		assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
		const documentId = mirrorDocumentId(mainSession);
		assert.deepEqual(deleted.body.value.mirror, { documentId, graphId: GRAPH });
		const trashed = JSON.parse(readFileSync(join(harness.dataDir, "trash", mainSession, "deleted.json"), "utf8"));
		assert.equal(trashed.mirror.documentId, documentId);
		assert.match(trashed.restore, /restore its document from the workspace's Trash too/);

		// The client puts it in the workspace's Trash with the person's own credential (the self-host key here).
		const toTrash = await gardend.fetchJson(`/navigation/${GRAPH}/documents/${documentId}`, { method: "DELETE", token: gardend.key });
		assert.equal(toTrash.status, 200, JSON.stringify(toTrash.body));
		const trash = await gardend.fetchJson(`/navigation/${GRAPH}/trash`, { token: gardend.key });
		assert.deepEqual(trash.body.items.map((item: { id: string; title: string }) => [item.id, item.title]), [[documentId, "What the workspace holds"]]);
		assert.deepEqual(await conversationsFolder(), []);

		// Restore the session as the trash says (stop, move back, start): it is the same conversation, still mirrored.
		await harness.stop();
		mkdirSync(join(harness.dataDir, "sessions"), { recursive: true });
		renameSync(join(harness.dataDir, "trash", mainSession), join(harness.dataDir, "sessions", mainSession));
		const revived = await startHost({ dataDir: harness.dataDir, gardend: { url: `${gardend.url}/mcp` }, graphId: GRAPH });
		harness = revived;
		revived.faux.setResponses([fauxAssistantMessage("A third answer, after the restore.")]);
		await revived.call("POST", `/sessions/${mainSession}/claim`, { requestId: "claim-after-restore" }, owner);
		const third = await turn(revived, mainSession, owner, "Still there?");
		assert.equal(third.at(-1)?.type, "mirror.written");
		// Kept current while in the Trash, and not taken out of it: that is the person's to do.
		assert.equal((await gardend.fetchJson(`/navigation/${GRAPH}/trash`, { token: gardend.key })).body.items.length, 1);
		assert.match((await readMirror(mainSession)).content, /A third answer, after the restore\./);
		const restored = await gardend.fetchJson(`/navigation/${GRAPH}/trash/${documentId}/restore?kind=document`, { method: "POST", token: gardend.key });
		assert.equal(restored.status, 200, JSON.stringify(restored.body));
		assert.deepEqual((await conversationsFolder()).map((doc) => doc.id), [documentId], "back in Conversations, current");
	});

	it("writes nothing for a viewer's session, and says why in inspect", async () => {
		const viewer = asCaller(await gardend.delegation(gardend.readOnlyTokenWith(["services.proxy"]).token, GRAPH), "viewer-tab");
		assert.equal(viewer.role, "viewer");
		harness.faux.setResponses([fauxAssistantMessage("Read only.")]);
		const sessionId = await createSession(harness, {}, viewer);
		const events = await turn(harness, sessionId, viewer, "What is here?", {}, false);
		await harness.host.mirrorsIdle();
		assert.deepEqual(events, []);
		const inspected = await harness.call("GET", `/sessions/${sessionId}`, undefined, viewer);
		assert.equal(inspected.body.value.mirror.state, "skipped");
		assert.match(inspected.body.value.mirror.reason, /viewer/);
		const missing = await gardend.tool(gardend.key, "read_document", { graphId: GRAPH, documentId: mirrorDocumentId(sessionId) });
		assert.match(missing.error?.message ?? "", /not found/);
		assert.ok(!gardend.audit().some((row) => row.actor === viewer.principal && row.category === "mcp.tools.call"), "the viewer's session called no write tool");
	});

	it("titles the document as gardend takes a title: a first question past 96 characters is cut", async () => {
		// gardend refuses a longer title by retrying the operation in the background, so the call would time out.
		const question = "Which component converts the battery voltage to 3.3 V on this board? Answer in one short sentence with its part number, please.";
		harness.faux.setResponses([fauxAssistantMessage("The TPS63020.")]);
		const sessionId = await createSession(harness, {}, owner);
		const events = await turn(harness, sessionId, owner, question);
		assert.equal(events.at(-1)?.type, "mirror.written", JSON.stringify(events));
		const doc = await readMirror(sessionId);
		assert.equal([...doc.title].length, 96);
		assert.ok(question.startsWith(doc.title.slice(0, -1)) && doc.title.endsWith("…"), doc.title);
		assert.match(doc.content, new RegExp(question.replace(/[.?]/g, "\\$&")));
	});

	it("mirrors a fork and a clone as branches: each document wired to its parent's, the parent linked in its header", async () => {
		harness.faux.setResponses([fauxAssistantMessage("Answer one."), fauxAssistantMessage("Answer two."), fauxAssistantMessage("A different second answer.")]);
		const parent = await createSession(harness, {}, owner);
		await turn(harness, parent, owner, "First question");
		await turn(harness, parent, owner, "Second question", { contextRefs: ["doc-open-2"] });
		await harness.call("PATCH", `/sessions/${parent}`, { title: "The parent" }, owner);
		await harness.host.mirrorsIdle();
		const parentDoc = mirrorDocumentId(parent);

		const clone = await harness.call("POST", `/sessions/${parent}/commands`, { requestId: "clone-1", op: "clone" }, owner);
		assert.equal(clone.status, 200, JSON.stringify(clone.body));
		const cloneId = clone.body.value.session.sessionId as string;
		await harness.waitFor(cloneId, (event) => event.type === "mirror.written", 30_000, owner);

		const source = await harness.call("GET", `/sessions/${parent}`, undefined, owner);
		const second = (source.body.value.transcript as { entryId: string; role: string; text: string }[]).find((item) => item.role === "user" && item.text.startsWith("Second question"));
		assert.ok(second);
		const fork = await harness.call("POST", `/sessions/${parent}/commands`, { requestId: "fork-1", op: "fork", entryId: second.entryId }, owner);
		assert.equal(fork.status, 200, JSON.stringify(fork.body));
		assert.equal(fork.body.value.selectedText, "Second question", "the person's words, without the note for the model");
		const forkId = fork.body.value.session.sessionId as string;
		await harness.waitFor(forkId, (event) => event.type === "mirror.written", 30_000, owner);

		for (const [branch, kind] of [
			[cloneId, "clone"],
			[forkId, "fork"],
		] as const) {
			const wires = (await ownerTool("get_wires", { documentId: mirrorDocumentId(branch) })).wires as Record<string, string>[];
			assert.deepEqual(
				wires.map((wire) => [wire.sourceDocumentId, wire.predicate, wire.targetDocumentId]),
				[[mirrorDocumentId(branch), BRANCH_PREDICATE, parentDoc]],
				`${kind} is wired to its parent`,
			);
			const xml = (await ownerTool("read_document", { documentId: mirrorDocumentId(branch), format: "xml" })).content as string;
			assert.match(xml, new RegExp(`${kind === "clone" ? "Duplicated from" : "Branched from"} <wikilink label="The parent" targetDocId="${parentDoc}"></wikilink>`));
		}
		// Each branch is its own conversation in the list: a clone is "Copy of" its source, a fork is named by the
		// history it begins with until it is renamed (never by its source's name).
		const listed = (await harness.call("GET", "/sessions", undefined, owner)).body.value.sessions as Record<string, any>[];
		const row = (id: string) => listed.find((session) => session.sessionId === id) as Record<string, any>;
		assert.deepEqual([row(cloneId).title, row(cloneId).parent.kind, row(cloneId).parent.sessionId], ["Copy of The parent", "clone", parent]);
		assert.deepEqual([row(forkId).title, row(forkId).preview, row(forkId).parent.kind], [undefined, "First question", "fork"]);
		const cloneDoc = await readMirror(cloneId);
		assert.equal(cloneDoc.title, "Copy of The parent");
		assert.match(cloneDoc.content, /First question[\s\S]*Answer one\.[\s\S]*Second question[\s\S]*Answer two\./);
		const forkDoc = await readMirror(forkId);
		assert.match(forkDoc.content, /Branched from \[\[The parent\]\] before “Second question”/);
		assert.doesNotMatch(forkDoc.content, /Answer two/);

		// The branch goes on: its own answer, the wire kept (made once).
		await turn(harness, forkId, owner, "Second question, edited");
		assert.match((await readMirror(forkId)).content, /Second question, edited[\s\S]*A different second answer\./);
		assert.equal(((await ownerTool("get_wires", { documentId: mirrorDocumentId(forkId) })).wires as unknown[]).length, 1);
		assert.equal((await conversationsFolder()).filter((doc) => [parentDoc, mirrorDocumentId(cloneId), mirrorDocumentId(forkId)].includes(doc.id)).length, 3);
	});

	it("writes nothing with the mirror off (VEHICLE_MIRROR=off)", async () => {
		const offHost = await startHost({ gardend: { url: `${gardend.url}/mcp` }, graphId: OFF_GRAPH, mirror: false });
		try {
			const who = asCaller(await gardend.delegation(gardend.key, OFF_GRAPH), "off-tab", OFF_GRAPH);
			offHost.faux.setResponses([fauxAssistantMessage("Not mirrored.")]);
			const sessionId = await createSession(offHost, {}, who);
			await turn(offHost, sessionId, who, "Anything?", {}, false);
			await offHost.host.mirrorsIdle();
			const inspected = await offHost.call("GET", `/sessions/${sessionId}`, undefined, who);
			assert.deepEqual(inspected.body.value.mirror, { state: "off", reason: "VEHICLE_MIRROR=off" });
			assert.ok(!existsSync(join(offHost.dataDir, "sessions", sessionId, "mirror.json")));
			const folders = (await ownerTool("get_workspace", { foldersOnly: true, depth: 2 }, OFF_GRAPH)).folders as { id: string }[];
			assert.deepEqual(folders, []);
		} finally {
			await offHost.cleanup();
		}
	});
});
