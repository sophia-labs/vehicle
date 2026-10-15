/**
 * The mirror's document text, from pi's own entries and the host's commands: who and when for each turn, the
 * person's words as they said them (not the note pi-sophia adds for the model), a chime under its author, a
 * steer marked, tool calls as one-line chips (a failed one said so), the day when it changes, and never a
 * credential, whoever typed it. No gardend needed: the gardend leg is `mirror.test.ts`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { branchLineXml, gardenTitle, type MirrorSnapshot, mirrorDocumentId, mirrorSetting, renderMirror, toolChip } from "../src/index.ts";

const user = (id: string, text: string, timestamp: string) => ({ type: "message", id, timestamp, message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (id: string, timestamp: string, text: string, calls: { id: string; name: string; arguments: Record<string, unknown> }[] = [], extra: Record<string, unknown> = {}) => ({
	type: "message",
	id,
	timestamp,
	message: { role: "assistant", content: [...(text ? [{ type: "text", text }] : []), ...calls.map((call) => ({ type: "toolCall", ...call }))], ...extra },
});
const result = (id: string, toolCallId: string, isError: boolean, timestamp: string) => ({
	type: "message",
	id,
	timestamp,
	message: { role: "toolResult", toolCallId, toolName: "x", isError, content: [{ type: "text", text: "result text that is never shown" }] },
});

describe("the mirror's document", () => {
	it("is the conversation as the person had it: who, when, their words, chips, and nothing hidden", () => {
		const asked = "Which part makes 3.3V?";
		const steer = "Only the power parts, please.";
		const chime = "Also name the charger.";
		const snapshot: MirrorSnapshot = {
			sessionId: "s-1",
			owner: "owner",
			model: "openrouter/google/gemini-2.5-flash",
			createdAt: "2026-10-13T23:58:00.000Z",
			title: "Power",
			commands: [
				{ op: "prompt", text: asked, contextRefs: ["buck-boost-converter"] },
				{ op: "steer", text: steer },
				{ op: "follow_up", text: `[Codex collaborator]\n${chime}`, via: { author: "Codex" } },
			],
			entries: [
				{ type: "custom", id: "b", timestamp: "2026-10-13T23:58:00.000Z" },
				// What pi-sophia gives the model (its `turnTextForModel`): the words, then the note about what was open.
				user("u1", `${asked}\n\n(Open in the person's view, by id: \`buck-boost-converter\`. "This document" means the first.)`, "2026-10-13T23:58:30.000Z"),
				assistant("a1", "2026-10-13T23:58:40.000Z", "Let me look.", [
					{ id: "c1", name: "mcp__sophia__search_blocks", arguments: { query: "3.3V regulator" } },
					{ id: "c2", name: "mcp__sophia__read_document", arguments: { documentId: "buck-boost-converter" } },
				]),
				result("r1", "c1", false, "2026-10-13T23:58:41.000Z"),
				result("r2", "c2", true, "2026-10-13T23:58:42.000Z"),
				user("u2", steer, "2026-10-13T23:58:50.000Z"),
				assistant("a2", "2026-10-14T00:01:00.000Z", "The TPS63020. The key sophia-key-0123456789abcdef0123 is not for you."),
				user("u3", `[Codex collaborator]\n${chime}`, "2026-10-14T00:02:00.000Z"),
				assistant("a3", "2026-10-14T00:02:30.000Z", "", [], { stopReason: "aborted" }),
			],
		};
		const text = renderMirror(snapshot);
		assert.equal(
			text,
			[
				"Conversation with Sophia · started 2026-10-13 23:58 UTC · model `google/gemini-2.5-flash` (openrouter)",
				"---",
				"**Owner** · 23:58 UTC\n\nWhich part makes 3.3V?",
				"**Sophia** · 23:58 UTC\n\nLet me look.\n\n`search_blocks “3.3V regulator”` · `read_document buck-boost-converter` (failed)",
				"**Owner** · 23:58 UTC · steer\n\nOnly the power parts, please.",
				"**Sophia** · 2026-10-14 00:01 UTC\n\nThe TPS63020. The key [redacted] is not for you.",
				"**Codex (collaborator)** · 00:02 UTC · follow-up\n\nAlso name the charger.",
				"**Sophia** · 00:02 UTC\n\n_(stopped)_",
			].join("\n\n"),
		);
		assert.doesNotMatch(text, /Open in the person's view|result text|sophia-key-/);
	});

	it("names other people as gardend does, and links a branch to its parent", () => {
		const text = renderMirror({
			sessionId: "s-2",
			owner: "token:57cc6d45-1111-2222-3333-444455556666",
			model: "faux/faux-1",
			createdAt: "2026-10-13T10:00:00.000Z",
			title: undefined,
			commands: [],
			entries: [user("u", "Hello", "2026-10-13T10:00:01.000Z")],
		});
		assert.match(text, /\*\*Member \(token 57cc6d45\)\*\* · 10:00 UTC\n\nHello/);
		assert.equal(
			branchLineXml({ kind: "fork", parentSessionId: "p", parentDocumentId: mirrorDocumentId("p"), parentTitle: 'Power & "rails"', before: "Which <part>?" }),
			'<paragraph>Branched from <wikilink label="Power &amp; &quot;rails&quot;" targetDocId="sophia-conversation-p"></wikilink> before “Which &lt;part&gt;?”</paragraph>',
		);
		assert.match(branchLineXml({ kind: "clone", parentSessionId: "p", parentDocumentId: "d", parentTitle: "T" }), /^<paragraph>Duplicated from <wikilink label="T" targetDocId="d"><\/wikilink> \(a duplicate\)<\/paragraph>$/);
	});

	it("chips a call by its most telling argument", () => {
		assert.equal(toolChip("mcp__sophia__list_documents", {}, false), "`list_documents`");
		assert.equal(toolChip("mcp__sophia__datasheet_facts", { part: "BQ25185", parameter: "Vin" }, false), "`datasheet_facts BQ25185`");
		assert.equal(toolChip("read_document", { documentId: "a`b" }, true), "`read_document a'b` (failed)");
	});

	it("is titled as gardend takes a title: one line, at most 96 characters", () => {
		const long = `Which component converts the battery voltage to 3.3 V? Answer in one short sentence with its part number.`;
		assert.equal([...gardenTitle(long)].length, 96);
		assert.match(gardenTitle(long), /…$/);
		assert.equal(gardenTitle("  Power\n rails "), "Power rails");
		assert.equal(gardenTitle(undefined), "Conversation with Sophia");
	});

	it("is a setting: VEHICLE_MIRROR on (the default) or off", () => {
		assert.equal(mirrorSetting(undefined), true);
		assert.equal(mirrorSetting(" OFF "), false);
		assert.equal(mirrorSetting("on"), true);
		assert.throws(() => mirrorSetting("maybe"), /on or off/);
		assert.equal(mirrorDocumentId("0b1c-2d"), "sophia-conversation-0b1c-2d");
	});
});
