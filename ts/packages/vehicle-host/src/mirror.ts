/**
 * The session mirror (principle 2 in the README: continuity lives in memory, never in a process). After each
 * settled run the session's record is written to a Garden document in the session's own graph, so gardend
 * holds the record of every conversation, readable in the person's tree like any other document.
 *
 * Where: the graph's agent folder `_sophia` (folder id `agent-scratchpad`, the id an earlier Sophia agent gave it
 * and every older graph still has), in a folder `Conversations` (id `sophia-conversations`). Both are ordinary
 * folders the person sees in the tree; each is made only when it is missing, so a person who moved one keeps
 * it where they put it. One document per session, id `sophia-conversation-<sessionId>`.
 *
 * Who writes: the session's person, with the delegation token gardend handed for them (gardend's audit says
 * the person, `via: service:vehicle`), through gardend's own MCP tools (`create_document`, `write_document`,
 * `rename`, `insert_blocks`, `create_wires`); the token binds the graph, so no call names one. A viewer's
 * session cannot write: the mirror is skipped and inspect says so.
 *
 * What: the transcript, readably: who and when for each turn, the replies' text, the tool calls as one-line
 * chips, never the context note pi-sophia adds for the model, never a token. A small header gives the model and
 * the start, and a branch's header links its parent (a wikilink) while the two documents carry a wire
 * `divergesFrom` (branch → parent).
 *
 * When: on settle only (never per delta), coalesced, skipped when nothing changed; a title change alone is a
 * `rename`. Writes are idempotent: the document is made once (`mirror.json` beside the session says so), then
 * updated in place. A document the person put in Garden's Trash stays there: the mirror keeps it current, and
 * it comes back current when they restore it.
 *
 * Off with `VEHICLE_MIRROR=off`.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { turnTextForModel } from "@sophia-labs/pi-sophia";
import type { EventLog } from "./logs.ts";

export const MIRROR_SCHEMA = "sophia.vehicle-mirror.v1";
/** The graph's agent folder, as an earlier Sophia agent made it (`_sophia`). */
export const AGENT_FOLDER = { id: "agent-scratchpad", name: "_sophia" } as const;
export const CONVERSATIONS_FOLDER = { id: "sophia-conversations", name: "Conversations" } as const;
/** gardend's built-in wire predicate for a branch: the branch "diverges from" its parent. */
export const BRANCH_PREDICATE = "divergesFrom";
const MAX_DOCUMENT_CHARS = 400_000;
/**
 * gardend's limit for a new document's title (`ids::normalize_title`). A longer one is not refused at the call: the
 * operation is retried in the background and the call times out, so the mirror never sends one.
 */
export const MAX_GARDEN_TITLE_CHARS = 96;
const MAX_TURN_CHARS = 32_000;
const CALL_TIMEOUT_MS = 30_000;
/** pi-sophia's note for the model about what the person had open: not part of what they said. */
const CONTEXT_NOTE = /\n\n\(Open in the person's view, by id: [^\n]*\)$/;
/** A chime's text as the room hands it to the model: `[<author> collaborator]\n<text>`. */
const CHIME_PREFIX = /^\[([A-Za-z0-9 _.-]{1,64}) collaborator\]\n/;
/** Credentials that must never reach a document, whoever typed them. */
const SECRETS = [/sophia-(?:dlg|key)-[0-9a-f]{16,}/g, /\bsk-[A-Za-z0-9_-]{20,}/g, /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g];

/** `VEHICLE_MIRROR`: `on` (the default) or `off`. */
export function mirrorSetting(value: string | undefined): boolean {
	const setting = value?.trim().toLowerCase() || "on";
	if (setting !== "on" && setting !== "off") throw new Error("VEHICLE_MIRROR must be on or off");
	return setting === "on";
}

/** The session's mirror document: one per session, its id derived from the session's. */
export function mirrorDocumentId(sessionId: string): string {
	return `sophia-conversation-${sessionId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

export function branchWireId(sessionId: string): string {
	return `wire-sophia-branch-${sessionId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** What the mirror knows of a branch: its parent's document and title, and where it branched. */
export interface MirrorBranch {
	readonly kind: "fork" | "clone";
	readonly parentSessionId: string;
	readonly parentDocumentId: string;
	readonly parentTitle: string;
	/** For a fork: the start of the message it branched before (the branch's first message, resent edited). */
	readonly before?: string;
}

/** `mirror.json` in the session's directory. */
interface MirrorState {
	readonly schema: typeof MIRROR_SCHEMA;
	readonly documentId: string;
	created?: string;
	writtenAt?: string;
	digest?: string;
	title?: string;
	wired?: boolean;
	branch?: MirrorBranch;
	lastError?: { at: string; message: string };
}

/** What inspect says of the mirror. */
export interface MirrorView {
	readonly state: "off" | "skipped" | "pending" | "written" | "failed";
	readonly documentId?: string;
	readonly folder?: string;
	readonly reason?: string;
	readonly writtenAt?: string;
	readonly error?: string;
}

/** One transcript entry as pi keeps it (`SessionManager.getBranch()`). */
export type PiEntry = Readonly<Record<string, unknown>>;

/** A command as the host records it: what the person said (`text`), with how (`op`) and through whom (`via`). */
export interface MirrorCommand {
	readonly op: string;
	readonly text?: string;
	readonly contextRefs?: readonly string[];
	readonly via?: { readonly author: string };
}

export interface MirrorSnapshot {
	readonly sessionId: string;
	readonly owner: string;
	readonly model: string;
	readonly createdAt: string;
	readonly title: string | undefined;
	readonly entries: readonly PiEntry[];
	readonly commands: readonly MirrorCommand[];
	readonly branch?: MirrorBranch;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

const pad = (value: number) => String(value).padStart(2, "0");
const dayOf = (at: Date) => `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
const clockOf = (at: Date) => `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;

/** What the person wrote, without the note pi-sophia adds for the model about what they had open. */
export function personText(text: string): string {
	return text.replace(CONTEXT_NOTE, "");
}

/** Remove anything shaped like a credential. */
export function redactSecrets(text: string): string {
	return SECRETS.reduce((out, pattern) => out.replace(pattern, "[redacted]"), text);
}

/** The person, named as gardend names them, in words: `owner`, a member's token, an Access email. */
export function personLabel(principal: string): string {
	if (principal === "owner") return "Owner";
	if (principal.startsWith("token:")) return `Member (token ${principal.slice(6, 14)})`;
	if (principal.startsWith("service:")) return `Service ${principal.slice(8)}`;
	return principal;
}

function textOf(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function clip(text: string, max: number): string {
	const chars = [...text];
	return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** A document title gardend takes: one line, at most 96 characters (cut with an ellipsis). */
export function gardenTitle(title: string | undefined): string {
	const line = (title ?? "").replace(/\s+/g, " ").trim();
	return clip(line || "Conversation with Sophia", MAX_GARDEN_TITLE_CHARS);
}

/** A code span that cannot be broken by its own text. */
const codeSpan = (text: string) => `\`${text.replace(/`/g, "'").replace(/\s+/g, " ").trim()}\``;

const CHIP_ARGUMENTS = ["query", "documentId", "document_id", "title", "part", "artifactId", "artifact_id", "blockId", "folderId", "name"];

/** A tool call as one chip: its name without pi's `mcp__<server>__` prefix and its most telling argument. */
export function toolChip(name: string, args: unknown, failed: boolean): string {
	const tool = name.replace(/^mcp__[A-Za-z0-9_]+?__/, "");
	const record = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
	const key = CHIP_ARGUMENTS.find((candidate) => typeof record[candidate] === "string") ?? Object.keys(record).find((candidate) => typeof record[candidate] === "string");
	const value = key ? clip(String(record[key]), 48) : "";
	const chip = codeSpan(value ? `${tool} ${key === "query" ? `“${value}”` : value}` : tool);
	return failed ? `${chip} (failed)` : chip;
}

/**
 * The transcript as a Garden document (markdown): a header, then each turn with who and when, the replies'
 * text and their tool calls as chips. A branch's link to its parent is not here: it goes in as a wikilink
 * block after the header ([`branchLineXml`]), which markdown cannot carry.
 */
export function renderMirror(snapshot: MirrorSnapshot): string {
	const started = new Date(snapshot.createdAt);
	const [provider, ...model] = snapshot.model.split("/");
	const header = `Conversation with Sophia · started ${dayOf(started)} ${clockOf(started)} UTC · model ${codeSpan(model.join("/") || snapshot.model)}${model.length > 0 ? ` (${provider})` : ""}`;

	// The person's words as they said them: the command whose model text this entry is (pi keeps what the model
	// was given: the person's text, a chime's attribution line, the note about what they had open).
	const pending = snapshot.commands.filter((command) => command.text !== undefined);
	const said = (modelText: string): { text: string; who: string; op?: string } => {
		const index = pending.findIndex((command) => turnTextForModel(command.text as string, command.contextRefs) === modelText);
		const command = index >= 0 ? pending.splice(index, 1)[0] : undefined;
		let text = personText(command?.text ?? modelText);
		const chime = CHIME_PREFIX.exec(text);
		if (chime) text = text.slice(chime[0].length);
		const author = command?.via?.author ?? chime?.[1];
		const op = command?.op === "steer" ? "steer" : command?.op === "follow_up" ? "follow-up" : undefined;
		return { text, who: author ? `${author} (collaborator)` : personLabel(snapshot.owner), ...(op ? { op } : {}) };
	};

	const results = new Map<string, boolean>();
	for (const entry of snapshot.entries) {
		const message = entry.message as Record<string, unknown> | undefined;
		if (entry.type === "message" && message?.role === "toolResult" && typeof message.toolCallId === "string") {
			results.set(message.toolCallId, message.isError === true);
		}
	}

	const turns: string[] = [];
	let day = dayOf(started);
	const when = (timestamp: unknown): string => {
		const at = typeof timestamp === "string" ? new Date(timestamp) : undefined;
		if (!at || Number.isNaN(at.getTime())) return "";
		const today = dayOf(at);
		const stamp = today === day ? `${clockOf(at)} UTC` : `${today} ${clockOf(at)} UTC`;
		day = today;
		return stamp;
	};
	let reply: { parts: string[]; chips: string[]; at: unknown } | undefined;
	const flushChips = () => {
		if (reply && reply.chips.length > 0) {
			reply.parts.push(reply.chips.join(" · "));
			reply.chips = [];
		}
	};
	const closeReply = () => {
		if (!reply) return;
		flushChips();
		const stamp = when(reply.at);
		turns.push([`**Sophia**${stamp ? ` · ${stamp}` : ""}`, ...(reply.parts.length > 0 ? reply.parts : ["_(no reply)_"])].join("\n\n"));
		reply = undefined;
	};
	for (const entry of snapshot.entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as Record<string, unknown> | undefined;
		if (!message) continue;
		if (message.role === "user") {
			closeReply();
			const { text, who, op } = said(textOf(message));
			const stamp = when(entry.timestamp);
			turns.push(`**${who}**${stamp ? ` · ${stamp}` : ""}${op ? ` · ${op}` : ""}\n\n${clip(text.trim(), MAX_TURN_CHARS) || "_(empty)_"}`);
			continue;
		}
		if (message.role !== "assistant" && message.role !== "toolResult") continue;
		reply ??= { parts: [], chips: [], at: entry.timestamp };
		reply.at = entry.timestamp ?? reply.at;
		if (message.role !== "assistant") continue;
		const text = textOf(message).trim();
		if (text) {
			flushChips();
			reply.parts.push(clip(text, MAX_TURN_CHARS));
		}
		const blocks = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];
		for (const block of blocks) {
			if (block?.type !== "toolCall") continue;
			reply.chips.push(toolChip(String(block.name ?? "tool"), block.arguments, results.get(String(block.id)) === true));
		}
		if (message.stopReason === "aborted") reply.parts.push("_(stopped)_");
		else if (message.stopReason === "error") reply.parts.push(`_(the model call failed${typeof message.errorMessage === "string" ? `: ${clip(message.errorMessage, 200)}` : ""})_`);
	}
	closeReply();

	// A long conversation keeps its newest turns whole.
	let body = turns.join("\n\n");
	let omitted = 0;
	while (body.length > MAX_DOCUMENT_CHARS && turns.length > 1) {
		turns.shift();
		omitted += 1;
		body = turns.join("\n\n");
	}
	const notes = omitted > 0 ? [`_(${omitted} earlier turns are not shown here; the conversation keeps them.)_`] : [];
	return redactSecrets([header, ...notes, "---", body].filter((part) => part !== "").join("\n\n"));
}

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The header's branch line, as TipTap XML: a wikilink to the parent's document. */
export function branchLineXml(branch: MirrorBranch): string {
	const link = `<wikilink label="${escapeXml(clip(branch.parentTitle, 120))}" targetDocId="${escapeXml(branch.parentDocumentId)}"></wikilink>`;
	const where =
		branch.kind === "clone" ? " (a duplicate)" : branch.before ? ` before “${escapeXml(redactSecrets(clip(branch.before.replace(/\s+/g, " ").trim(), 80)))}”` : "";
	return `<paragraph>${branch.kind === "clone" ? "Duplicated from" : "Branched from"} ${link}${where}</paragraph>`;
}

// ─── gardend's MCP, for the person ──────────────────────────────────────────

export class MirrorError extends Error {}

let rpcId = 0;

/** One `tools/call` on gardend's `/mcp` with the person's delegation token; the tool's JSON value, or a MirrorError. */
export async function callGardendTool(url: string, token: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
			signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
		});
	} catch (error) {
		throw new MirrorError(`gardend could not be reached for ${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
	let body: { result?: { structuredContent?: unknown; content?: { type?: string; text?: string }[]; isError?: boolean }; error?: { message?: string } };
	try {
		body = (await response.json()) as typeof body;
	} catch {
		throw new MirrorError(`gardend answered ${name} with HTTP ${response.status}`);
	}
	if (!response.ok || body.error) throw new MirrorError(`${name}: ${body.error?.message ?? `HTTP ${response.status}`}`);
	const result = body.result ?? {};
	const text = result.content?.find((item) => item.type === "text")?.text;
	if (result.isError) throw new MirrorError(`${name}: ${text ?? "failed"}`);
	if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent as Record<string, unknown>;
	try {
		return text ? (JSON.parse(text) as Record<string, unknown>) : {};
	} catch {
		return { text };
	}
}

/**
 * The folders a graph's mirrors go in, made when missing (once per graph and host process). A folder the
 * person moved stays where they put it: only a missing one is made.
 */
export class MirrorFolders {
	private readonly ensured = new Map<string, Promise<void>>();

	ensure(graphId: string, call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>): Promise<void> {
		let ready = this.ensured.get(graphId);
		if (!ready) {
			ready = (async () => {
				const known = new Set<string>();
				let cursor: string | undefined;
				for (let page = 0; page < 50; page += 1) {
					const listed = await call("get_workspace", { foldersOnly: true, depth: 5, limit: 200, ...(cursor ? { cursor } : {}) });
					for (const folder of Array.isArray(listed.folders) ? (listed.folders as { id?: string }[]) : []) if (folder.id) known.add(folder.id);
					const next = (listed.page as { nextCursor?: unknown } | undefined)?.nextCursor;
					if (typeof next !== "string" || next === "" || next === cursor) break;
					cursor = next;
				}
				if (!known.has(AGENT_FOLDER.id)) await call("create_folder", { folderId: AGENT_FOLDER.id, name: AGENT_FOLDER.name });
				if (!known.has(CONVERSATIONS_FOLDER.id)) {
					await call("create_folder", { folderId: CONVERSATIONS_FOLDER.id, name: CONVERSATIONS_FOLDER.name, parentId: AGENT_FOLDER.id });
				}
			})();
			this.ensured.set(graphId, ready);
			// A failure is tried again at the next write.
			ready.catch(() => this.ensured.delete(graphId));
		}
		return ready;
	}
}

// ─── One session's mirror ───────────────────────────────────────────────────

export interface SessionMirrorOptions {
	/** gardend's `/mcp`, or undefined when the host has no gardend (then the mirror is off). */
	readonly url: string | undefined;
	readonly enabled: boolean;
	/** Why this session's mirror never writes (a viewer's session), if it never does. */
	readonly skipReason: string | undefined;
	readonly graphId: string;
	readonly folders: MirrorFolders;
	readonly dir: () => string;
	readonly events: EventLog;
	readonly getToken: () => string | undefined;
	readonly snapshot: () => MirrorSnapshot;
	readonly deleted: () => boolean;
}

export class SessionMirror {
	private readonly options: SessionMirrorOptions;
	private running: Promise<void> | undefined;
	private again = false;

	constructor(options: SessionMirrorOptions) {
		this.options = options;
	}

	private get path(): string {
		return join(this.options.dir(), "mirror.json");
	}

	private load(): MirrorState | undefined {
		if (!existsSync(this.path)) return undefined;
		try {
			const state = JSON.parse(readFileSync(this.path, "utf8")) as MirrorState;
			return state.schema === MIRROR_SCHEMA ? state : undefined;
		} catch {
			return undefined;
		}
	}

	private save(state: MirrorState): void {
		const temporary = `${this.path}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporary, this.path);
	}

	get active(): boolean {
		return this.options.enabled && this.options.url !== undefined && this.options.skipReason === undefined;
	}

	/** The mirror's document, once it exists (what a delete hands the client to put in Garden's Trash). */
	written(): { documentId: string; graphId: string } | undefined {
		const state = this.load();
		return state?.created ? { documentId: state.documentId, graphId: this.options.graphId } : undefined;
	}

	/** Remember where a new branch came from (written into its document's header, and wired, at its first write). */
	noteBranch(branch: MirrorBranch): void {
		const state = this.load() ?? { schema: MIRROR_SCHEMA, documentId: mirrorDocumentId(this.options.snapshot().sessionId) };
		this.save({ ...state, branch });
	}

	branch(): MirrorBranch | undefined {
		return this.load()?.branch;
	}

	view(): MirrorView {
		const documentId = mirrorDocumentId(this.options.snapshot().sessionId);
		if (!this.options.enabled || this.options.url === undefined) {
			return { state: "off", reason: this.options.enabled ? "this host has no gardend to write to" : "VEHICLE_MIRROR=off" };
		}
		if (this.options.skipReason) return { state: "skipped", reason: this.options.skipReason };
		const state = this.load();
		const folder = `${AGENT_FOLDER.name}/${CONVERSATIONS_FOLDER.name}`;
		if (state?.lastError) return { state: "failed", documentId, folder, error: state.lastError.message, ...(state.writtenAt ? { writtenAt: state.writtenAt } : {}) };
		if (state?.writtenAt) return { state: "written", documentId, folder, writtenAt: state.writtenAt };
		return { state: "pending", documentId, folder, reason: "written after the first reply settles" };
	}

	/** Write the record now or, while a write is under way, once more after it. Never throws. */
	schedule(): Promise<void> {
		if (!this.active || this.options.deleted()) return Promise.resolve();
		if (this.running) {
			this.again = true;
			return this.running;
		}
		this.running = (async () => {
			do {
				this.again = false;
				try {
					await this.writeOnce();
				} catch (error) {
					// The record's directory went away under a write (a delete, a host shutting down): nothing to tell.
					if (!this.options.deleted()) console.error("[vehicle-host] mirror:", redactSecrets(error instanceof Error ? error.message : String(error)));
				}
			} while (this.again && !this.options.deleted());
		})().finally(() => {
			this.running = undefined;
		});
		return this.running;
	}

	/** Resolves once no write is under way (tests; shutdown). */
	async idle(): Promise<void> {
		while (this.running) await this.running;
	}

	private async writeOnce(): Promise<void> {
		const url = this.options.url as string;
		const snapshot = this.options.snapshot();
		const hasTurns = snapshot.entries.some((entry) => entry.type === "message" && (entry.message as { role?: string } | undefined)?.role === "user");
		if (!hasTurns) return;
		const token = this.options.getToken();
		const state: MirrorState = this.load() ?? { schema: MIRROR_SCHEMA, documentId: mirrorDocumentId(snapshot.sessionId) };
		if (!token) return;
		const branch = state.branch ?? snapshot.branch;
		const title = gardenTitle(snapshot.title);
		const content = renderMirror({ ...snapshot, ...(branch ? { branch } : {}) });
		const branchLine = branch ? branchLineXml(branch) : undefined;
		const digest = createHash("sha256").update(content).update("\0").update(branchLine ?? "").digest("hex");
		const call = (name: string, args: Record<string, unknown>) => callGardendTool(url, token, name, args);
		try {
			const created = !state.created;
			if (created) {
				await this.options.folders.ensure(this.options.graphId, call);
				// "keep": a create whose reply was lost (or a lost mirror.json) finds the document already there and
				// leaves it where the person may have moved it; gardend refuses a create over an existing id otherwise.
				await call("create_document", { documentId: state.documentId, title, parentId: CONVERSATIONS_FOLDER.id, ifExists: "keep" });
				state.created = new Date().toISOString();
				state.title = title;
				this.save(state);
			}
			let wrote = false;
			if (state.digest !== digest) {
				await call("write_document", { documentId: state.documentId, content, format: "markdown", ...(state.title !== title ? { title } : {}) });
				if (branchLine) await call("insert_blocks", { documentId: state.documentId, content: branchLine, format: "xml", index: 1 });
				state.digest = digest;
				state.title = title;
				wrote = true;
			} else if (state.title !== title) {
				await call("rename", { entity_type: "document", entity_id: state.documentId, new_name: title });
				state.title = title;
				wrote = true;
			}
			if (branch && !state.wired) {
				await call("create_wires", {
					sourceDocumentId: state.documentId,
					targetDocumentId: branch.parentDocumentId,
					predicate: BRANCH_PREDICATE,
					wireId: branchWireId(snapshot.sessionId),
				});
				state.wired = true;
				wrote = true;
			}
			if (!wrote && !state.lastError) return;
			state.writtenAt = new Date().toISOString();
			delete state.lastError;
			this.save(state);
			this.options.events.append("mirror.written", { documentId: state.documentId, created });
		} catch (error) {
			const message = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 1024);
			state.lastError = { at: new Date().toISOString(), message };
			if (!this.options.deleted()) {
				this.save(state);
				this.options.events.append("mirror.failed", { documentId: state.documentId, message });
			}
		}
	}
}
