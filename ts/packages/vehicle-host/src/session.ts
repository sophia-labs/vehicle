/**
 * One ride session: a durable record (meta, command log, event log) and, while it is awake, a pi body.
 *
 * The record outlives the body. A body is materialized on demand from pi's own session file, dies when it
 * idles or the host stops, and is revived from the same file (principles 2 and 3 in the README). The lease,
 * the room policy and the chimes are rebuilt from the event log; commands are rebuilt from the command log.
 *
 * The body is pi in the host's process for a `chat` session, and an isolated `pi --mode rpc` child for an
 * `agent` session (`./body.ts`, `./rpc-body.ts`, `./isolation.ts`). The verbs, the events, the lease, the capsule
 * and revival are the same for both.
 *
 * Ride verbs map onto pi's own semantics: `prompt` starts a run when idle and is pi's follow-up when busy;
 * `steer` and `follow_up` are pi's steer and follow-up queue when busy and start a run when idle; `abort` is
 * pi's abort plus pi's clear_queue (the interactive Esc); `cancel` takes one queued message back out of pi's
 * queue.
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentSessionEvent,
	createAgentSession,
	createMcpExtension,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	accessForRole,
	type BudgetStop,
	createSophiaExtension,
	createSophiaMcpTransport,
	type GardendMcpOptions,
	messageCostUsd,
	SOPHIA_EXCLUDED_BUILTINS,
	type SophiaBudget,
	type SophiaProfile,
	type SophiaRole,
	sophiaToolAllowlist,
	turnTextForModel,
} from "@sophia-labs/pi-sophia";
import { InProcessBody, type PiBody } from "./body.ts";
import { type BoxTier, type IsolationSetting, planBox } from "./isolation.ts";
import type { ModelGrant } from "./model-proxy.ts";
import { appendJsonl, EventLog, type RideEvent, readJsonl } from "./logs.ts";
import { type MirrorFolders, personText, SessionMirror } from "./mirror.ts";
import { findPiSessionFile } from "./pi-files.ts";
import type { Funding, PublicPolicy } from "./public.ts";
import {
	bounded,
	type Caller,
	type ChimeDelivery,
	COMMAND_OPS,
	type CommandOp,
	DEFAULT_LEASE_TTL_MS,
	digestOf,
	frame,
	MAX_AUTHOR_CHARS,
	MAX_CHIME_CHARS,
	MAX_LEASE_TTL_MS,
	optionalRefs,
	RideError,
	ROOM_POLICIES,
	type RoomPolicy,
	requireId,
	requireText,
	TEXT_OPS,
} from "./protocol.ts";
import { type BodyExit, RpcBody } from "./rpc-body.ts";

export { findPiSessionFile } from "./pi-files.ts";

export const SESSION_SCHEMA = "sophia.vehicle-session.v1";
export const TRASH_SCHEMA = "sophia.vehicle-trash.v1";
export const MAX_TITLE_CHARS = 200;
const ABORT_WAIT_MS = 10_000;

/** A title as a person typed it: one line, trimmed, at most 200 characters; empty or null clears it. */
export function parseTitle(value: unknown): string | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value !== "string" || value.includes("\0")) throw new RideError("invalid_request", 400, "title must be a string or null");
	const title = value.replace(/\s+/g, " ").trim();
	if ([...title].length > MAX_TITLE_CHARS) throw new RideError("invalid_request", 400, `title must be at most ${MAX_TITLE_CHARS} characters`);
	return title === "" ? undefined : title;
}

/** Write a file whole or not at all: a sibling temporary file, then a rename over the old one. */
function writeFileAtomic(path: string, text: string): void {
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, text, { mode: 0o600 });
	renameSync(temporary, path);
}

export interface SessionMeta {
	readonly schema: typeof SESSION_SCHEMA;
	readonly sessionId: string;
	readonly createdAt: string;
	/** The principal the session belongs to. Only they read it, drive it, rename it or delete it. */
	readonly owner: string;
	readonly graphId: string;
	readonly role: SophiaRole;
	/** `chat`: pi in the host's process, graph tools only. `agent`: an isolated body with a working folder. */
	readonly profile: SophiaProfile;
	readonly model: { readonly provider: string; readonly id: string };
	readonly budget: Required<SophiaBudget>;
	/** The one field that changes: `PATCH /sessions/:id` renames (or clears) it. */
	readonly title?: string;
	readonly parent?: { readonly sessionId: string; readonly kind: "fork" | "clone"; readonly entryId?: string };
	/**
	 * A public session (`public.ts`): who pays for its model. `byok`: the caller's own key, sent with every request
	 * and held in memory only; `credit`: the house key, debited from the account's credit. Absent: a session of
	 * this Sophia's own people (the house key, no credit).
	 */
	readonly funding?: Funding;
	/**
	 * A public session reads every public graph (gardend binds its delegation to all of them): the ones besides
	 * `graphId`, as they were when it was created. Each tool call names one; none reads `graphId`.
	 */
	readonly graphs?: readonly string[];
}

export type CommandStatus =
	| "accepted"
	| "queued"
	| "delivered"
	| "completed"
	| "aborted"
	| "failed"
	| "cancelled"
	| "interrupted";
const OPEN_STATUSES: ReadonlySet<CommandStatus> = new Set(["accepted", "queued", "delivered"]);

export interface CommandRecord {
	commandId: string;
	requestId: string;
	op: CommandOp;
	text?: string;
	contextRefs?: string[];
	client: { principal: string; clientId: string };
	via?: { chimeId: string; author: string; principal: string };
	status: CommandStatus;
	disposition?: string;
	acceptedAt: string;
	acceptedSeq: number;
	deliveredAt?: string;
	settledAt?: string;
	runId?: string;
	error?: string;
	targetCommandId?: string;
	result?: Record<string, unknown>;
}

interface Lease {
	clientId: string;
	principal: string;
	claimedAt: string;
	expiresAt: number;
}

interface Chime {
	chimeId: string;
	author: string;
	principal: string;
	delivery: ChimeDelivery;
	text: string;
	status: "pending" | "accepted" | "rejected" | "submitted";
}

type LogRow =
	| { kind: "request"; requestId: string; digest: string; at: string; response: Record<string, unknown> }
	| { kind: "command"; record: CommandRecord };

/**
 * How `agent` bodies start on this host (`./host.ts` builds it from the settings): the isolation tier, the body's
 * code, and the model proxy that calls the model for them. Absent: this host makes no agent bodies.
 */
export interface AgentBodies {
	readonly isolation: IsolationSetting;
	/** Why agent bodies cannot start here (the setting, or a probe of the tier); `undefined`: they can. */
	refusal(): Promise<string | undefined>;
	readonly node: string;
	readonly nodeArgs: readonly string[];
	readonly entry: string;
	readonly entryArgs: readonly string[];
	/** Read-only in the box: the body's code. */
	readonly readable: readonly string[];
	/** Never readable from the box (seatbelt), beyond the home folder and the data dir. */
	readonly hidden: readonly string[];
	/** gardend's loopback `/mcp`, given to the body (it is not a secret). */
	readonly mcpUrl?: string;
	/** A test setting: the body answers with pi's faux provider (`./body-faux.ts`). */
	readonly faux: boolean;
	/**
	 * A grant on the host's model proxy (`./model-proxy.ts`) for one body of a session: the base URL its model calls
	 * go to and the token that stands in for the key there. The key stays on the host; `model` is read at each call.
	 */
	modelGrant(sessionId: string, model: () => { readonly provider: string; readonly id: string }): Promise<ModelGrant>;
	/** Stop the model proxy (the host is closing). */
	close(): Promise<void>;
	readonly startTimeoutMs?: number;
}

/** Where an `agent` session's working folder lives: `<dataDir>/workspaces/<sessionId>`. */
export function workspaceDir(dataDir: string, sessionId: string): string {
	return join(dataDir, "workspaces", sessionId);
}

/** A directory the host made, still a real directory: never a symbolic link a body put in its place. */
export function isRealDir(path: string): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

export interface SessionServices {
	readonly modelRuntime: ModelRuntime;
	readonly dataDir: string;
	readonly agentDir: string;
	readonly mcpLogPath: string;
	readonly gardend?: GardendMcpOptions;
	readonly bodyIdleMs: number;
	readonly agent?: AgentBodies;
	/** The session mirror (`mirror.ts`): whether it writes, and the folders made per graph. */
	readonly mirror: { readonly enabled: boolean; readonly folders: MirrorFolders };
	/** Public sessions: their doors, limits and ledger (`public.ts`). */
	readonly public?: PublicPolicy;
	/** A model runtime of its own for a session on the caller's own key (no stored key, no house key in it). */
	readonly byokRuntime: () => Promise<ModelRuntime>;
	/** Fork or clone a session into a new one (the host owns the registry). */
	fork(source: RideSession, caller: Caller, request: { requestId: string; kind: "fork" | "clone"; entryId?: string }): Promise<Record<string, unknown>>;
}

interface Body {
	readonly body: PiBody;
	readonly unsubscribe: () => void;
}

interface Run {
	readonly runId: string;
	/** What the run's model calls cost (provider-reported, else priced from the catalogue). */
	costUsd: number;
	budgetStop?: BudgetStop;
	lastStopReason?: string;
	lastError?: string;
}

const textOf = (message: unknown): string => {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
};

const boundedJson = (value: unknown, maxBytes: number): unknown => {
	const text = JSON.stringify(value ?? null);
	return Buffer.byteLength(text) <= maxBytes ? value : { truncated: true, preview: bounded(text, maxBytes) };
};

/** Why a conversation is not mirrored into the workspace, or undefined when it is. */
export function mirrorSkipReason(role: SessionMeta["role"]): string | undefined {
	if (accessForRole(role) === "read") return "a viewer's conversation cannot write to the workspace, so it is not mirrored there";
	if (role === "contributor") {
		return "a visitor's conversation is not mirrored into the workspace; to keep it, ask Sophia to write it as a note in the visitors' folder";
	}
	return undefined;
}

export class RideSession {
	private currentMeta: SessionMeta;
	/** Where the record lives: `sessions/<id>/`, or its place in `trash/` once deleted. */
	dir: string;
	readonly events: EventLog;
	readonly commands = new Map<string, CommandRecord>();
	private readonly services: SessionServices;
	private readonly commandLogPath: string;
	private readonly requests = new Map<string, { digest: string; response: Record<string, unknown> }>();
	private lease: Lease | undefined;
	private roomPolicy: RoomPolicy = "suggest";
	private readonly chimes = new Map<string, Chime>();
	private body: Body | undefined;
	private bodyStarting: Promise<Body> | undefined;
	private chain: Promise<unknown> = Promise.resolve();
	private run: Run | undefined;
	private runCount = 0;
	/** Commands whose user message pi has not yet started: the run's prompt and the queued ones, in order. */
	private awaiting: { commandId: string; text: string }[] = [];
	/** What sits in pi's steer and follow-up queues, by command. */
	private queued: { commandId: string; kind: "steer" | "followUp"; text: string }[] = [];
	private idleTimer: NodeJS.Timeout | undefined;
	/**
	 * The newest delegation token gardend handed with a request of the session's owner on its graph: what the
	 * body's MCP client acts with (read before every request, so a refresh takes effect at once). Memory only:
	 * never in meta, the logs, the capsule or pi's file. A revived session has none until its owner's next
	 * request.
	 */
	#delegatedToken: string | undefined;
	/**
	 * A `byok` session's model key: the newest one its owner sent (`X-Model-Key`), in memory only, like the
	 * delegation token. A revived session has none until its owner's next request brings it.
	 */
	#modelKey: string | undefined;
	/** The `byok` session's own model runtime, holding that key (made with the first body). */
	#byokRuntime: ModelRuntime | undefined;
	/** A branch's first message from its source's history, once read (null: it has none). */
	#historyPreview: string | null | undefined;
	/** Set once `DELETE /sessions/:id` moved the record to the trash: nothing more happens to it here. */
	private deleted = false;
	/** The session's record as a Garden document in its graph, written after each settled run (`mirror.ts`). */
	readonly mirror: SessionMirror;

	private constructor(services: SessionServices, dir: string, meta: SessionMeta) {
		this.services = services;
		this.dir = dir;
		this.currentMeta = meta;
		this.commandLogPath = join(dir, "commands.jsonl");
		this.events = new EventLog(join(dir, "events.jsonl"));
		// A caller's own key never reaches the log, whatever text carries it (a provider's error, say).
		this.events.redact(() => (this.#modelKey ? [this.#modelKey] : []));
		this.mirror = new SessionMirror({
			url: services.gardend?.url,
			enabled: services.mirror.enabled,
			skipReason: mirrorSkipReason(meta.role),
			graphId: meta.graphId,
			folders: services.mirror.folders,
			dir: () => this.dir,
			events: this.events,
			getToken: () => this.#delegatedToken,
			deleted: () => this.deleted,
			snapshot: () => ({
				sessionId: this.meta.sessionId,
				owner: this.meta.owner,
				model: `${this.meta.model.provider}/${this.meta.model.id}`,
				createdAt: this.meta.createdAt,
				title: this.meta.title ?? this.preview(),
				entries: this.branchEntries(),
				commands: [...this.commands.values()],
			}),
		});
	}

	static create(services: SessionServices, dir: string, meta: SessionMeta): RideSession {
		mkdirSync(join(dir, "pi"), { recursive: true, mode: 0o700 });
		writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		const session = new RideSession(services, dir, meta);
		session.events.append("session.created", {
			sessionId: meta.sessionId,
			graphId: meta.graphId,
			profile: meta.profile,
			access: accessForRole(meta.role),
			model: `${meta.model.provider}/${meta.model.id}`,
			budget: meta.budget,
			...(meta.parent ? { parent: meta.parent } : {}),
		});
		return session;
	}

	/** Rebuild a session from its directory after the host restarted. Open commands died with the old body. */
	static revive(services: SessionServices, dir: string): RideSession {
		const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as SessionMeta;
		if (meta.schema !== SESSION_SCHEMA) throw new Error(`unknown session schema in ${dir}`);
		const session = new RideSession(services, dir, meta);
		for (const row of readJsonl<LogRow>(session.commandLogPath)) {
			if (row.kind === "request") session.requests.set(row.requestId, { digest: row.digest, response: row.response });
			else session.commands.set(row.record.commandId, row.record);
		}
		for (const event of session.events.all()) session.replay(event.type, event.payload);
		if (session.lease && session.lease.expiresAt <= Date.now()) session.lease = undefined;
		const interrupted: string[] = [];
		for (const record of session.commands.values()) {
			if (!OPEN_STATUSES.has(record.status)) continue;
			record.status = "interrupted";
			record.settledAt = new Date().toISOString();
			session.saveCommand(record);
			interrupted.push(record.commandId);
		}
		session.events.append("session.revived", {
			cursor: session.events.cursor,
			commands: session.commands.size,
			interrupted,
			lease: session.lease ? { clientId: session.lease.clientId } : null,
		});
		return session;
	}

	get meta(): SessionMeta {
		return this.currentMeta;
	}

	/** Durable state carried by events: the lease, the room policy, the chimes. */
	private replay(type: string, payload: Record<string, unknown>): void {
		if (type === "lease.claimed" || type === "lease.renewed") {
			this.lease = {
				clientId: String(payload.clientId),
				principal: String(payload.principal),
				claimedAt: String(payload.claimedAt),
				expiresAt: Number(payload.expiresAt),
			};
		} else if (type === "lease.released" || type === "lease.revoked" || type === "session.shutdown") {
			this.lease = undefined;
		} else if (type === "room.policy") {
			this.roomPolicy = payload.policy as RoomPolicy;
		} else if (type === "chime.received") {
			const chime = payload.chime as Chime;
			this.chimes.set(chime.chimeId, { ...chime });
		} else if (type === "chime.resolved") {
			const chime = this.chimes.get(String(payload.chimeId));
			if (chime) chime.status = payload.status as Chime["status"];
		}
	}

	/**
	 * Keep `token` as the one this session's graph tools act with, when it came with a request of the session's
	 * owner bound to the session's graph (gardend binds a delegation token to both). Anyone else's is ignored.
	 */
	offerToken(caller: Caller, token: string): void {
		if (caller.principal !== this.meta.owner || caller.graphId !== this.meta.graphId) return;
		this.#delegatedToken = token;
	}

	/**
	 * With gardend configured, a body starts only with a delegation token: without one it would have no graph
	 * tools for its whole life. Refused before a command is accepted, so the caller learns why.
	 */
	private requireDelegation(): void {
		if (this.body || !this.services.gardend || this.#delegatedToken !== undefined) return;
		throw new RideError(
			"delegation_required",
			409,
			"gardend has not handed this conversation a token for its workspace yet: send it on the workspace's path (/g/<graph>/sessions/...)",
		);
	}

	/** A branch acts for the same person on the same graph as its source: it starts with the source's newest token. */
	inheritDelegation(source: RideSession): void {
		if (source.meta.owner === this.meta.owner && source.meta.graphId === this.meta.graphId) {
			this.#delegatedToken ??= source.#delegatedToken;
			this.#modelKey ??= source.#modelKey;
		}
	}

	/**
	 * Keep `key` as the model key of this `byok` session when its owner sent it; a body already running uses it from
	 * its next model call. Anyone else's, or one for a session that does not run on the caller's key, is ignored.
	 */
	offerModelKey(caller: Caller, key: string): void {
		if (this.meta.funding !== "byok" || caller.principal !== this.meta.owner || key === this.#modelKey) return;
		this.#modelKey = key;
		if (this.#byokRuntime) void this.#byokRuntime.setRuntimeApiKey(this.meta.model.provider, key);
	}

	/** Whether the session has its owner's model key in memory (never the key itself). */
	get hasModelKey(): boolean {
		return this.#modelKey !== undefined;
	}

	/** Turns taken in this conversation: the person's prompts, follow-ups and steers. */
	get turnsTaken(): number {
		let count = 0;
		for (const record of this.commands.values()) if (TEXT_OPS.has(record.op)) count += 1;
		return count;
	}

	/** A public session's limits and door, before a turn is accepted (`public.ts`). */
	private requirePublicTurn(caller: Caller): void {
		if (!this.meta.funding) return;
		const policy = this.services.public;
		if (!policy) throw new RideError("not_public", 403, "this Sophia does not open conversations to visitors");
		policy.beforeTurn(caller, { sessionId: this.meta.sessionId, funding: this.meta.funding, turnsTaken: this.turnsTaken }, this.hasModelKey);
	}

	/** Whether the session has a delegation token to act with (never the token itself). */
	get hasDelegatedToken(): boolean {
		return this.#delegatedToken !== undefined;
	}

	// ─── Reading ────────────────────────────────────────────────────────────────

	/** The owner reads a session, on its own graph: a request gardend bound to another graph does not see it. */
	requireReader(caller: Caller): void {
		if (caller.principal !== this.meta.owner || (caller.graphId !== undefined && caller.graphId !== this.meta.graphId)) {
			throw new RideError("not_found", 404, "no such session");
		}
	}

	/**
	 * The session's access was fixed by the role it was created with. A caller whose role now gives less (an
	 * owner's grant cut to read-only) may still read it, but not drive it with powers it no longer has.
	 */
	private requireAccess(caller: Caller): void {
		if (accessForRole(this.meta.role) === "write" && accessForRole(caller.role) === "read") {
			throw new RideError("access_reduced", 403, "this conversation can change the workspace, and your role now only reads it: start a new one");
		}
		if (this.meta.profile === "agent" && caller.role !== "owner") {
			throw new RideError("access_reduced", 403, "an agent session runs code on this computer: only the workspace's owner can drive it");
		}
	}

	get status(): "running" | "idle" | "dormant" {
		if (!this.body) return "dormant";
		return this.body.body.isStreaming ? "running" : "idle";
	}

	currentLease(): Lease | undefined {
		if (this.lease && this.lease.expiresAt <= Date.now()) {
			const expired = this.lease;
			this.lease = undefined;
			this.events.append("lease.expired", { clientId: expired.clientId });
		}
		return this.lease;
	}

	leaseView(): Record<string, unknown> | null {
		const lease = this.currentLease();
		return lease ? { clientId: lease.clientId, claimedAt: lease.claimedAt, expiresAt: new Date(lease.expiresAt).toISOString() } : null;
	}

	/** When the conversation last moved: the last command, message or run, else its creation. */
	updatedAt(): string {
		const events = this.events.all();
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index] as RideEvent;
			if (event.type.startsWith("command.") || event.type.startsWith("message.") || event.type.startsWith("run.")) return event.ts;
		}
		return this.meta.createdAt;
	}

	/**
	 * The first thing the owner said, cut short: what a conversation list shows for a session without a title. A
	 * branch that has not been sent anything yet begins with its source's history: its first message (read once).
	 */
	preview(): string | undefined {
		for (const record of this.commands.values()) {
			if (record.text !== undefined && !record.via) return bounded(record.text.replace(/\s+/g, " ").trim(), 160);
		}
		if (!this.meta.parent) return undefined;
		if (this.#historyPreview === undefined) {
			const first = this.branchEntries().find((entry) => entry.type === "message" && (entry.message as { role?: string } | undefined)?.role === "user");
			const text = first ? personText(textOf(first.message)) : "";
			this.#historyPreview = text ? bounded(text.replace(/\s+/g, " ").trim(), 160) : null;
		}
		return this.#historyPreview ?? undefined;
	}

	summary(): Record<string, unknown> {
		const preview = this.preview();
		return {
			sessionId: this.meta.sessionId,
			graphId: this.meta.graphId,
			profile: this.meta.profile,
			...(this.meta.profile === "agent" ? { isolation: this.services.agent?.isolation.tier ?? "none" } : {}),
			access: accessForRole(this.meta.role),
			model: `${this.meta.model.provider}/${this.meta.model.id}`,
			createdAt: this.meta.createdAt,
			updatedAt: this.updatedAt(),
			...(this.meta.title ? { title: this.meta.title } : {}),
			...(preview ? { preview } : {}),
			...(this.meta.parent ? { parent: this.meta.parent } : {}),
			status: this.status,
			cursor: this.events.cursor,
			budget: this.meta.budget,
			lease: this.leaseView(),
			roomPolicy: this.roomPolicy,
		};
	}

	/** The body's working folder: a private workspace for an agent, an empty `work/` for chat. */
	get workdir(): string {
		return this.meta.profile === "agent" ? workspaceDir(this.services.dataDir, this.meta.sessionId) : join(this.dir, "work");
	}

	/**
	 * pi's session entries on the active branch: from the live in-process body, else from pi's file (which an
	 * agent body writes itself; a file that is not pi's reads as no transcript, never as an error).
	 */
	branchEntries(): readonly Record<string, unknown>[] {
		const live = this.body?.body.branch();
		if (live) return live;
		const file = this.piSessionFile();
		if (!file) return [];
		try {
			return SessionManager.open(file, join(this.dir, "pi"), this.workdir).getBranch() as unknown as Record<string, unknown>[];
		} catch {
			return [];
		}
	}

	piSessionFile(): string | undefined {
		const piDir = join(this.dir, "pi");
		return this.body?.body.sessionFile ?? (isRealDir(piDir) ? findPiSessionFile(piDir) : undefined);
	}

	inspect(): Record<string, unknown> {
		const transcript = this.branchEntries().flatMap((entry) => {
			if (entry.type !== "message") return [];
			const message = entry.message as { role: string; content?: unknown; stopReason?: string; toolName?: string; isError?: boolean };
			if (message.role === "system") return [];
			const toolCalls = Array.isArray(message.content)
				? message.content
						.filter((block: { type?: string }) => block?.type === "toolCall")
						.map((block: { name: string; arguments: unknown }) => ({ name: block.name, args: boundedJson(block.arguments, 4096) }))
				: [];
			return [
				{
					entryId: entry.id,
					// When pi recorded the entry (ISO 8601): a user turn when it was taken, a reply's step when it ended.
					...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
					role: message.role,
					text: bounded(textOf(message), 16 * 1024),
					...(toolCalls.length > 0 ? { toolCalls } : {}),
					...(message.toolName ? { toolName: message.toolName, isError: message.isError === true } : {}),
					...(message.stopReason ? { stopReason: message.stopReason } : {}),
				},
			];
		});
		const stats = this.body?.body.stats();
		return {
			session: this.summary(),
			commands: [...this.commands.values()],
			queue: this.queued.map(({ commandId, kind }) => ({ commandId, kind })),
			chimes: [...this.chimes.values()].filter((chime) => chime.status === "pending"),
			transcript,
			...(stats ? { stats } : {}),
			tools: this.body?.body.activeToolNames() ?? null,
			mirror: this.mirror.view(),
		};
	}

	// ─── Mutating requests ──────────────────────────────────────────────────────

	/** Run `work` after every earlier mutation of this session; replay a repeated requestId. */
	private async idempotent(
		requestId: string,
		digest: string,
		work: () => Promise<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		const prior = this.requests.get(requestId);
		if (prior) {
			if (prior.digest !== digest) {
				throw new RideError("request_id_conflict", 409, "this requestId was already used for a different request");
			}
			return { ...prior.response, replayed: true };
		}
		const next = this.chain.then(async () => {
			this.requireLive();
			const raced = this.requests.get(requestId);
			if (raced) {
				if (raced.digest !== digest) throw new RideError("request_id_conflict", 409, "this requestId was already used for a different request");
				return { ...raced.response, replayed: true };
			}
			const response = await work();
			this.requests.set(requestId, { digest, response });
			appendJsonl(this.commandLogPath, { kind: "request", requestId, digest, at: new Date().toISOString(), response } satisfies LogRow);
			return response;
		});
		this.chain = next.catch(() => undefined);
		return next;
	}

	/** Run `work` after every earlier mutation of this session (no requestId to remember). */
	private exclusive<T>(work: () => Promise<T> | T): Promise<T> {
		const next = this.chain.then(async () => {
			this.requireLive();
			return work();
		});
		this.chain = next.catch(() => undefined);
		return next;
	}

	/** A deleted session is gone: a request that raced the delete finds nothing. */
	private requireLive(): void {
		if (this.deleted) throw new RideError("not_found", 404, "no such session");
	}

	private saveCommand(record: CommandRecord): void {
		this.commands.set(record.commandId, record);
		appendJsonl(this.commandLogPath, { kind: "command", record } satisfies LogRow);
	}

	/**
	 * `lease_held`: who holds it, and whether this caller could take it over (`claim` with `takeover`): only
	 * the same principal can, from another of their own clients. Nobody takes over someone else's ride.
	 */
	private leaseHeld(lease: Lease, caller: Caller): RideError {
		return new RideError("lease_held", 409, "another client holds the driver lease", {
			holder: { clientId: lease.clientId, claimedAt: lease.claimedAt, expiresAt: new Date(lease.expiresAt).toISOString() },
			canTakeOver: lease.principal === caller.principal,
		});
	}

	private requireDriver(caller: Caller): void {
		if (caller.principal !== this.meta.owner) throw new RideError("not_session_owner", 403, "only the session's owner can drive it");
		this.requireAccess(caller);
		const lease = this.currentLease();
		if (!lease) throw new RideError("lease_required", 409, "claim the driver lease before sending commands");
		if (lease.clientId !== caller.clientId || lease.principal !== caller.principal) throw this.leaseHeld(lease, caller);
		const ttl = lease.expiresAt - Date.parse(lease.claimedAt);
		if (lease.expiresAt - Date.now() < ttl / 2) {
			lease.expiresAt = Date.now() + ttl;
			this.events.append("lease.renewed", { ...lease });
		}
	}

	/**
	 * Take the driver lease. Held by another client: `lease_held`, unless `takeover` is true and the holder is
	 * the caller's own principal (the same person in another tab, browser or terminal): then the holder's lease
	 * is revoked (`lease.revoked`, which its watch sees) and the caller holds it. A run under way goes on; it
	 * is the same person's. Someone else's lease is never taken over: one driver at a time, and nobody
	 * impersonates the driver.
	 */
	claim(caller: Caller, body: Record<string, unknown>): Promise<Record<string, unknown>> {
		const requestId = requireId("requestId", body.requestId);
		const ttlMs = body.ttlMs === undefined ? DEFAULT_LEASE_TTL_MS : Number(body.ttlMs);
		if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_LEASE_TTL_MS) {
			throw new RideError("invalid_request", 400, `ttlMs must be an integer from 1000 to ${MAX_LEASE_TTL_MS}`);
		}
		if (body.takeover !== undefined && typeof body.takeover !== "boolean") throw new RideError("invalid_request", 400, "takeover must be a boolean");
		const takeover = body.takeover === true;
		// `takeover: false` digests as no takeover at all, as before the flag existed.
		return this.idempotent(requestId, digestOf({ op: "claim", ttlMs, clientId: caller.clientId, takeover: takeover || undefined }), async () => {
			if (caller.principal !== this.meta.owner) throw new RideError("not_session_owner", 403, "only the session's owner can drive it");
			this.requireAccess(caller);
			const lease = this.currentLease();
			let revoked: Lease | undefined;
			if (lease && (lease.clientId !== caller.clientId || lease.principal !== caller.principal)) {
				if (!takeover || lease.principal !== caller.principal) throw this.leaseHeld(lease, caller);
				revoked = lease;
				this.lease = undefined;
				this.events.append("lease.revoked", { clientId: lease.clientId, by: caller.clientId, reason: "takeover" });
			}
			const now = new Date();
			this.lease = { clientId: caller.clientId, principal: caller.principal, claimedAt: now.toISOString(), expiresAt: now.getTime() + ttlMs };
			this.events.append("lease.claimed", { ...this.lease });
			return frame(
				"driver.claimed",
				{ lease: this.leaseView(), ...(revoked ? { tookOverFrom: { clientId: revoked.clientId, claimedAt: revoked.claimedAt } } : {}) },
				requestId,
			);
		});
	}

	/**
	 * `PATCH /sessions/:id`: rename the conversation (or clear its name: `title` null or empty, and it is listed
	 * by its preview again). The owner's, like reading it: no lease, and a role cut to read-only may still name
	 * its own conversation. Kept in `meta.json` (written whole), announced as `session.renamed`.
	 */
	rename(caller: Caller, body: Record<string, unknown>): Promise<Record<string, unknown>> {
		const requestId = body.requestId === undefined ? undefined : requireId("requestId", body.requestId);
		if (!("title" in body)) throw new RideError("invalid_request", 400, "title is required (null clears it)");
		const title = parseTitle(body.title);
		return this.exclusive(() => {
			const { title: _previous, ...rest } = this.currentMeta;
			const meta: SessionMeta = { ...rest, ...(title ? { title } : {}) };
			writeFileAtomic(join(this.dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
			this.currentMeta = meta;
			this.events.append("session.renamed", { title: title ?? null, by: caller.clientId });
			void this.mirror.schedule();
			return frame("session.renamed", { session: this.summary() }, requestId);
		});
	}

	/**
	 * `DELETE /sessions/:id`, the record's part: refused while anything is under way (a run, or a command
	 * not yet settled: `session_running`; abort first), never cutting off a reply another tab is showing.
	 * Otherwise the body is disposed and the whole directory is moved, never unlinked, to
	 * `<trashDir>/<sessionId>` (with `deleted.json` saying how to restore it); `session.deleted` is the last
	 * event, written into the moved log, and ends every watch. Returns the trash entry's name.
	 */
	retire(caller: Caller, trashDir: string): Promise<string> {
		return this.exclusive(async () => {
			const open = [...this.commands.values()].filter((record) => OPEN_STATUSES.has(record.status)).map((record) => record.commandId);
			if (this.body?.body.isStreaming || this.bodyStarting || open.length > 0) {
				throw new RideError("session_running", 409, "Sophia is still working in this conversation: abort the run, then delete it", { status: this.status, open });
			}
			// The record moves in this same turn (a watcher sees `session.deleted` right after `body.dormant`); the
			// body's end is awaited last.
			const disposed = this.sleep("deleted");
			// Nothing acts for the person in a deleted session.
			this.#delegatedToken = undefined;
			const mirror = this.mirror.written();
			mkdirSync(trashDir, { recursive: true, mode: 0o700 });
			let entry = this.meta.sessionId;
			if (existsSync(join(trashDir, entry))) entry = `${this.meta.sessionId}.${Date.now()}`;
			const target = join(trashDir, entry);
			renameSync(this.dir, target);
			// An agent's working folder goes with it (only the folder the host made, never a link in its place).
			const workspace = workspaceDir(this.services.dataDir, this.meta.sessionId);
			if (this.meta.profile === "agent" && isRealDir(workspace)) renameSync(workspace, join(target, "workspace"));
			this.deleted = true;
			this.dir = target;
			const deletedAt = new Date().toISOString();
			writeFileSync(
				join(target, "deleted.json"),
				`${JSON.stringify(
					{
						schema: TRASH_SCHEMA,
						sessionId: this.meta.sessionId,
						graphId: this.meta.graphId,
						deletedAt,
						by: { clientId: caller.clientId },
						...(mirror ? { mirror } : {}),
						restore:
							this.meta.profile === "agent"
								? `stop the service, move workspace/ back to workspaces/${this.meta.sessionId} and this directory back to sessions/${this.meta.sessionId}, start it again${mirror ? "; restore its document from the workspace's Trash too" : ""}`
								: `stop the service, move this directory back to sessions/${this.meta.sessionId}, start it again${mirror ? "; restore its document from the workspace's Trash too" : ""}`,
					},
					null,
					2,
				)}\n`,
				{ mode: 0o600 },
			);
			this.events.relocate(join(target, "events.jsonl"));
			this.events.append("session.deleted", { by: caller.clientId, trashedAs: entry });
			await disposed;
			return entry;
		});
	}

	release(caller: Caller, body: Record<string, unknown>): Promise<Record<string, unknown>> {
		const requestId = requireId("requestId", body.requestId);
		return this.idempotent(requestId, digestOf({ op: "release", clientId: caller.clientId }), async () => {
			const lease = this.currentLease();
			if (!lease || lease.clientId !== caller.clientId || lease.principal !== caller.principal) {
				throw new RideError("lease_not_held", 409, "this client does not hold the driver lease");
			}
			this.lease = undefined;
			this.events.append("lease.released", { clientId: caller.clientId });
			return frame("driver.released", { lease: null }, requestId);
		});
	}

	command(caller: Caller, body: Record<string, unknown>): Promise<Record<string, unknown>> {
		const requestId = requireId("requestId", body.requestId);
		const op = body.op as CommandOp;
		if (!(COMMAND_OPS as readonly string[]).includes(op)) {
			throw new RideError("invalid_request", 400, `op must be one of ${COMMAND_OPS.join(", ")}`);
		}
		const { requestId: _ignored, ...rest } = body;
		return this.idempotent(requestId, digestOf({ ...rest, clientId: caller.clientId }), async () => {
			if (op === "fork" || op === "clone") {
				if (caller.principal !== this.meta.owner) throw new RideError("not_session_owner", 403, "only the session's owner can fork it");
				const entryId = body.entryId === undefined ? undefined : requireId("entryId", body.entryId);
				const forked = await this.services.fork(this, caller, { requestId, kind: op, ...(entryId ? { entryId } : {}) });
				return frame(`session.${op === "fork" ? "forked" : "cloned"}`, forked, requestId);
			}
			this.requireDriver(caller);
			if (TEXT_OPS.has(op) || op === "accept_chime") {
				this.requireDelegation();
				this.requirePublicTurn(caller);
			}
			if (TEXT_OPS.has(op)) {
				const record = await this.submitText(caller, requestId, op as ChimeDelivery, body);
				return frame("command.accepted", { command: this.commandView(record), session: this.summary() }, requestId);
			}
			switch (op) {
				case "abort":
					return frame("command.accepted", { command: this.commandView(await this.abort(caller, requestId, body)) }, requestId);
				case "cancel":
					return frame("command.cancelled", { command: this.commandView(await this.cancel(caller, requestId, body)) }, requestId);
				case "shutdown":
					await this.shutdown(caller.clientId);
					return frame("closed", { reason: "shutdown", cursor: this.events.cursor }, requestId);
				case "set_room_policy": {
					const policy = body.policy as RoomPolicy;
					if (!(ROOM_POLICIES as readonly string[]).includes(policy)) {
						throw new RideError("invalid_request", 400, `policy must be one of ${ROOM_POLICIES.join(", ")}`);
					}
					this.roomPolicy = policy;
					this.events.append("room.policy", { policy, by: caller.clientId });
					return frame("room.policy", { policy }, requestId);
				}
				case "accept_chime":
				case "reject_chime": {
					const chime = this.chimes.get(requireId("chimeId", body.chimeId));
					if (!chime || chime.status !== "pending") throw new RideError("chime_not_pending", 409, "no pending chime with that id");
					if (op === "reject_chime") {
						chime.status = "rejected";
						this.events.append("chime.resolved", { chimeId: chime.chimeId, status: "rejected" });
						return frame("chime.rejected", { chimeId: chime.chimeId }, requestId);
					}
					chime.status = "accepted";
					this.events.append("chime.resolved", { chimeId: chime.chimeId, status: "accepted" });
					const record = await this.submitText(caller, requestId, chime.delivery, { text: chime.text }, chime);
					return frame("command.accepted", { command: this.commandView(record), chimeId: chime.chimeId }, requestId);
				}
			}
			throw new RideError("invalid_request", 400, `unsupported op ${op}`);
		});
	}

	/** A collaborator's attributed message; the room's policy decides what becomes of it. */
	chime(caller: Caller, body: Record<string, unknown>): Promise<Record<string, unknown>> {
		const requestId = requireId("requestId", body.requestId);
		const author = requireText(body.author, "author", MAX_AUTHOR_CHARS);
		if (!/^[A-Za-z0-9 _.-]+$/.test(author)) throw new RideError("invalid_request", 400, "author may use letters, digits, space, _ . -");
		const delivery = (body.delivery ?? "follow_up") as ChimeDelivery;
		if (!TEXT_OPS.has(delivery)) throw new RideError("invalid_request", 400, "delivery must be prompt, follow_up or steer");
		const text = requireText(body.text, "text", MAX_CHIME_CHARS * 4);
		if ([...text].length > MAX_CHIME_CHARS) throw new RideError("invalid_request", 400, `text must be at most ${MAX_CHIME_CHARS} characters`);
		if (this.meta.funding) throw new RideError("chimes_closed", 403, "a visitor's conversation takes no chimes");
		const { requestId: _ignored, ...rest } = body;
		return this.idempotent(`chime:${caller.principal}:${requestId}`, digestOf({ ...rest, principal: caller.principal }), async () => {
			const policy = this.roomPolicy;
			if (policy === "mute" || policy === "observe") {
				return frame("chime.rejected", { disposition: "rejected", policy, message: policy === "mute" ? "the room is muted" : "the room is observing" }, requestId);
			}
			const chime: Chime = { chimeId: `chime-${this.events.cursor + 1}`, author, principal: caller.principal, delivery, text, status: "pending" };
			this.chimes.set(chime.chimeId, chime);
			this.events.append("chime.received", { chime: { ...chime } });
			if (policy === "suggest") {
				return frame("chime.accepted", { disposition: "pending", chimeId: chime.chimeId, policy }, requestId);
			}
			// co-drive: the room submits it under the current driver's lease, attributed to the collaborator.
			const lease = this.currentLease();
			if (!lease) return frame("chime.accepted", { disposition: "pending", chimeId: chime.chimeId, policy, message: "no driver holds the lease" }, requestId);
			chime.status = "submitted";
			this.events.append("chime.resolved", { chimeId: chime.chimeId, status: "submitted" });
			const driver: Caller = { principal: lease.principal, clientId: lease.clientId, role: this.meta.role };
			const record = await this.submitText(driver, `chime:${chime.chimeId}`, delivery, { text }, chime);
			return frame("chime.accepted", { disposition: "submitted", chimeId: chime.chimeId, command: this.commandView(record), policy }, requestId);
		});
	}

	private commandView(record: CommandRecord): Record<string, unknown> {
		const { text, ...rest } = record;
		return { ...rest, ...(text === undefined ? {} : { chars: [...text].length }) };
	}

	private async submitText(
		caller: Caller,
		requestId: string,
		op: ChimeDelivery,
		body: Record<string, unknown>,
		chime?: Chime,
	): Promise<CommandRecord> {
		const text = requireText(body.text);
		const refs = optionalRefs(body.contextRefs);
		const commandId = body.commandId === undefined ? requestId : requireId("commandId", body.commandId);
		if (this.commands.has(commandId)) throw new RideError("command_exists", 409, "a command with this commandId exists");
		const said = chime ? `[${chime.author} collaborator]\n${text}` : text;
		const modelText = turnTextForModel(said, refs);
		const accepted = this.events.append("command.accepted", {
			commandId,
			op,
			chars: [...text].length,
			clientId: caller.clientId,
			...(chime ? { via: { chimeId: chime.chimeId, author: chime.author } } : {}),
		});
		const record: CommandRecord = {
			commandId,
			requestId,
			op,
			text: said,
			...(refs ? { contextRefs: refs } : {}),
			client: { principal: caller.principal, clientId: caller.clientId },
			...(chime ? { via: { chimeId: chime.chimeId, author: chime.author, principal: chime.principal } } : {}),
			status: "accepted",
			acceptedAt: accepted.ts,
			acceptedSeq: accepted.seq,
		};
		this.saveCommand(record);
		try {
			const { body } = await this.ensureBody();
			this.awaiting.push({ commandId, text: modelText });
			if (!body.isStreaming) {
				record.disposition = await this.startRun(body, modelText);
			} else {
				const kind = op === "steer" ? "steer" : "followUp";
				this.queued.push({ commandId, kind, text: modelText });
				record.disposition = kind === "steer" ? await body.steer(modelText) : await body.followUp(modelText);
				if (record.status === "accepted") record.status = "queued";
			}
			if (record.disposition === "handled") this.settle(record, "completed");
			else this.saveCommand(record);
		} catch (error) {
			this.awaiting = this.awaiting.filter((entry) => entry.commandId !== commandId);
			this.queued = this.queued.filter((entry) => entry.commandId !== commandId);
			record.error = error instanceof Error ? error.message : String(error);
			this.settle(record, "failed");
		}
		return record;
	}

	/** Start a pi run; resolves once pi accepted it (`started`) or consumed it (`handled`). */
	private startRun(body: PiBody, text: string): Promise<string> {
		return body.prompt(text, (message) => this.events.append("run.error", { message }));
	}

	private settle(record: CommandRecord, status: CommandStatus, extra: Record<string, unknown> = {}): void {
		record.status = status;
		record.settledAt = new Date().toISOString();
		this.saveCommand(record);
		this.events.append(`command.${status}`, { commandId: record.commandId, op: record.op, ...(record.error ? { error: record.error } : {}), ...extra });
	}

	private async abort(caller: Caller, requestId: string, body: Record<string, unknown>): Promise<CommandRecord> {
		const commandId = body.commandId === undefined ? requestId : requireId("commandId", body.commandId);
		if (this.commands.has(commandId)) throw new RideError("command_exists", 409, "a command with this commandId exists");
		const accepted = this.events.append("command.accepted", { commandId, op: "abort", clientId: caller.clientId });
		const record: CommandRecord = {
			commandId,
			requestId,
			op: "abort",
			client: { principal: caller.principal, clientId: caller.clientId },
			status: "accepted",
			acceptedAt: accepted.ts,
			acceptedSeq: accepted.seq,
		};
		this.saveCommand(record);
		const running = this.body?.body.isStreaming === true;
		if (this.body && running) {
			this.dropQueue("aborted");
			await this.abortBody(this.body.body);
		}
		record.result = { abortedRun: running };
		this.settle(record, "completed");
		return record;
	}

	private async cancel(caller: Caller, requestId: string, body: Record<string, unknown>): Promise<CommandRecord> {
		const targetId = requireId("commandId", body.commandId);
		const target = this.commands.get(targetId);
		const entry = this.queued.find((queued) => queued.commandId === targetId);
		if (!target || target.status !== "queued" || !entry || !this.body) {
			throw new RideError("not_cancellable", 409, "only a queued command that pi has not delivered can be cancelled", {
				status: target?.status ?? null,
			});
		}
		const pi = this.body.body;
		const { steering, followUp } = await pi.clearQueue();
		const list = entry.kind === "steer" ? steering : followUp;
		const index = list.indexOf(entry.text);
		if (index >= 0) list.splice(index, 1);
		this.queued = this.queued.filter((queued) => queued.commandId !== targetId);
		this.awaiting = this.awaiting.filter((waiting) => waiting.commandId !== targetId);
		for (const text of steering) await pi.steer(text);
		for (const text of followUp) await pi.followUp(text);
		this.settle(target, "cancelled", { by: caller.clientId });
		return { ...target, requestId, targetCommandId: targetId };
	}

	/** Take every queued command back out of pi's queue, reporting each as cancelled. */
	private dropQueue(reason: string): void {
		if (!this.body || this.queued.length === 0) return;
		this.body.body.clearQueue().catch(() => undefined);
		for (const entry of this.queued) {
			const record = this.commands.get(entry.commandId);
			if (record && record.status === "queued") this.settle(record, "cancelled", { reason });
		}
		const dropped = new Set(this.queued.map((entry) => entry.commandId));
		this.awaiting = this.awaiting.filter((waiting) => !dropped.has(waiting.commandId));
		this.queued = [];
	}

	// ─── The body ───────────────────────────────────────────────────────────────

	async ensureBody(): Promise<Body> {
		this.clearIdle();
		if (this.body) return this.body;
		this.requireDelegation();
		this.bodyStarting ??= this.materialize().finally(() => {
			this.bodyStarting = undefined;
		});
		return this.bodyStarting;
	}

	private async materialize(): Promise<Body> {
		if (this.meta.profile === "agent") return this.materializeAgent();
		const cwd = join(this.dir, "work");
		const piDir = join(this.dir, "pi");
		mkdirSync(cwd, { recursive: true, mode: 0o700 });
		mkdirSync(piDir, { recursive: true, mode: 0o700 });
		const modelRuntime = await this.bodyModelRuntime();
		const model = modelRuntime.getModel(this.meta.model.provider, this.meta.model.id);
		if (!model) throw new RideError("model_unavailable", 503, `model ${this.meta.model.provider}/${this.meta.model.id} is not available`);
		const file = findPiSessionFile(piDir);
		const sessionManager = file ? SessionManager.open(file, piDir, cwd) : SessionManager.create(cwd, piDir, { id: this.meta.sessionId });
		const settingsManager = SettingsManager.inMemory({
			enableInstallTelemetry: false,
			retry: { enabled: true, maxRetries: 2 },
		});
		// The graph tools act for the session's owner, with the newest delegation token gardend handed for them.
		const gardend: GardendMcpOptions | undefined = this.services.gardend
			? { ...this.services.gardend, getToken: () => this.#delegatedToken }
			: undefined;
		const sophiaOptions = {
			graphId: this.meta.graphId,
			...(this.meta.graphs && this.meta.graphs.length > 0 ? { graphs: this.meta.graphs } : {}),
			role: this.meta.role,
			profile: this.meta.profile,
			...(gardend ? { gardend } : {}),
			budget: this.meta.budget,
			onBudgetStop: (stop: BudgetStop) => {
				if (this.run) this.run.budgetStop = stop;
				this.events.append("budget.exceeded", { ...stop });
			},
		};
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: this.services.agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				{
					name: "mcp",
					factory: createMcpExtension({
						// Only the servers extensions register: never the person's own mcp.json.
						loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }),
						logPath: this.services.mcpLogPath,
						...(gardend ? { createTransport: createSophiaMcpTransport(gardend) } : {}),
					}),
				},
				{ name: "sophia", factory: createSophiaExtension(sophiaOptions) },
				// A visitor's own key never reaches pi's transcript: a provider error that quotes it is scrubbed on the
				// finished message, which pi records as returned here.
				{ name: "vehicle-redact", factory: (pi: ExtensionAPI) => this.redactModelKey(pi) },
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir: this.services.agentDir,
			modelRuntime,
			model,
			thinkingLevel: "off",
			resourceLoader,
			sessionManager,
			settingsManager,
			tools: sophiaToolAllowlist(sophiaOptions),
			excludeTools: [...SOPHIA_EXCLUDED_BUILTINS],
		});
		const body = new InProcessBody(session);
		const unsubscribe = body.subscribe((event) => this.onPiEvent(event));
		await session.bindExtensions({
			onError: (error) => this.events.append("extension.error", { extension: error.extensionPath, event: error.event, message: bounded(error.error, 2048) }),
		});
		this.body = { body, unsubscribe };
		this.events.append("body.materialized", { piSessionId: session.sessionId, resumedFromFile: file !== undefined, kind: body.kind });
		return this.body;
	}

	private redactModelKey(pi: ExtensionAPI): void {
		pi.on("message_end", (event) => {
			const key = this.#modelKey;
			if (!key || key.length < 8) return undefined;
			const text = JSON.stringify(event.message);
			if (!text.includes(key)) return undefined;
			return { message: JSON.parse(text.split(key).join("[redacted]")) as typeof event.message };
		});
	}

	/**
	 * The model runtime a chat body uses: the host's (the house key) for this Sophia's people and credit sessions; a
	 * runtime of the session's own holding the caller's key for a `byok` one. A `byok` session never starts a body
	 * without that key: the host's runtime would otherwise pay for it.
	 */
	private async bodyModelRuntime(): Promise<ModelRuntime> {
		if (this.meta.funding !== "byok") return this.services.modelRuntime;
		const key = this.#modelKey;
		if (!key) {
			throw new RideError("model_key_required", 402, "This conversation runs on your own OpenRouter key: send it as X-Model-Key with every request.");
		}
		this.#byokRuntime ??= await this.services.byokRuntime();
		await this.#byokRuntime.setRuntimeApiKey(this.meta.model.provider, key);
		return this.#byokRuntime;
	}

	/**
	 * An `agent` body: `pi --mode rpc` in a box of the host's isolation tier, working in the session's own folder.
	 * Refused (`isolation_unavailable`) when this host cannot isolate it. The model key never goes to the body: it
	 * gets a grant on the host's model proxy over the bootstrap pipe (a base URL and a token for this body only), and
	 * the delegation token over pi's RPC channel (`./rpc-body.ts`).
	 */
	private async materializeAgent(): Promise<Body> {
		const agent = this.services.agent;
		if (!agent) throw new RideError("isolation_unavailable", 503, "this host does not run agent bodies");
		const refusal = await agent.refusal();
		if (refusal) throw new RideError("isolation_unavailable", 503, refusal);
		const workdir = this.workdir;
		const piDir = join(this.dir, "pi");
		mkdirSync(workdir, { recursive: true, mode: 0o700 });
		mkdirSync(piDir, { recursive: true, mode: 0o700 });
		// The body may have put a link where its folders were (seatbelt cannot stop that): it does not start then.
		if (!isRealDir(workdir) || !isRealDir(piDir)) throw new RideError("body_tampered", 409, "this session's folders are not the ones the host made");
		if (!this.services.modelRuntime.getModel(this.meta.model.provider, this.meta.model.id)) {
			throw new RideError("model_unavailable", 503, `model ${this.meta.model.provider}/${this.meta.model.id} is not available`);
		}
		const tier = agent.isolation.tier as BoxTier;
		const tmpDir = tier === "bwrap" ? "/tmp" : mkdtempSync(join(tmpdir(), "vehicle-body-"));
		const launch = planBox({
			tier,
			node: agent.node,
			nodeArgs: agent.nodeArgs,
			entry: agent.entry,
			entryArgs: agent.entryArgs,
			readable: agent.readable,
			hidden: agent.hidden,
			workdir,
			stateDir: piDir,
			dataDir: this.services.dataDir,
			tmpDir,
			env: {
				PI_TELEMETRY: "0",
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				...(agent.mcpUrl ? { SOPHIA_GARDEND_MCP_URL: agent.mcpUrl } : {}),
			},
		});
		const resumed = findPiSessionFile(piDir) !== undefined;
		let started: RpcBody | undefined;
		const grant = await agent.modelGrant(this.meta.sessionId, () => this.meta.model);
		const body = await RpcBody.start({
			launch,
			isolation: tier,
			bootstrap: {
				sessionId: this.meta.sessionId,
				graphId: this.meta.graphId,
				role: this.meta.role,
				profile: this.meta.profile,
				model: this.meta.model,
				budget: this.meta.budget,
				workdir,
				piDir,
				isolation: tier,
				modelProxy: { baseUrl: grant.baseUrl, token: grant.token },
				faux: agent.faux,
			},
			getToken: () => this.#delegatedToken,
			onNotice: (notice) => this.events.append("body.notice", { level: notice.level, message: bounded(notice.message, 1024) }),
			onExtensionError: (error) => this.events.append("extension.error", { extension: error.extension, event: error.event, message: bounded(error.message, 2048) }),
			onBudgetStop: (stop) => {
				if (this.run) this.run.budgetStop = stop;
				this.events.append("budget.exceeded", { ...stop });
			},
			onExit: (exit) => {
				if (started) this.onBodyExit(started, exit);
			},
			afterExit: () => {
				grant.revoke();
				if (tier !== "bwrap") rmSync(tmpDir, { recursive: true, force: true });
			},
			...(agent.startTimeoutMs ? { startTimeoutMs: agent.startTimeoutMs } : {}),
		}).catch((error: unknown) => {
			grant.revoke();
			throw error;
		});
		started = body;
		const unsubscribe = body.subscribe((event) => this.onPiEvent(event));
		this.body = { body, unsubscribe };
		this.events.append("body.materialized", { piSessionId: body.sessionId, resumedFromFile: resumed, kind: body.kind, box: launch.describe });
		return this.body;
	}

	/**
	 * The body died by itself (a crash, the box killed it, an abort it ignored): the run and every command it held
	 * end with it, and the next command materializes a new body from pi's file.
	 */
	private onBodyExit(body: PiBody, exit: BodyExit): void {
		if (this.body?.body !== body) return;
		this.body.unsubscribe();
		this.body = undefined;
		this.clearIdle();
		const reason = `the body exited (${exit.code ?? exit.signal})`;
		this.events.append("body.exited", { code: exit.code, signal: exit.signal, stderr: bounded(exit.stderrTail.trim(), 2048) });
		const run = this.run;
		this.run = undefined;
		for (const record of this.commands.values()) {
			if (record.status === "queued") this.settle(record, "cancelled", { reason: "body_exited" });
			else if (OPEN_STATUSES.has(record.status)) {
				record.error = reason;
				this.settle(record, "failed");
			}
		}
		this.awaiting = [];
		this.queued = [];
		if (run) this.events.append("run.settled", { runId: run.runId, aborted: true, stopReason: "body_exited" });
		this.events.append("body.dormant", { reason: "exited" });
	}

	private onPiEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start": {
				this.runCount += 1;
				this.run = { runId: `${this.events.cursor + 1}`, costUsd: 0 };
				this.events.append("run.started", { runId: this.run.runId, tools: this.body?.body.activeToolNames() ?? [] });
				break;
			}
			case "message_start": {
				if (event.message.role !== "user") break;
				const text = textOf(event.message);
				const index = this.awaiting.findIndex((waiting) => waiting.text === text);
				if (index < 0) break;
				const [waiting] = this.awaiting.splice(index, 1);
				this.queued = this.queued.filter((queued) => queued.commandId !== waiting?.commandId);
				const record = waiting ? this.commands.get(waiting.commandId) : undefined;
				if (!record || !OPEN_STATUSES.has(record.status)) break;
				record.status = "delivered";
				record.deliveredAt = new Date().toISOString();
				if (this.run) record.runId = this.run.runId;
				this.saveCommand(record);
				this.events.append("command.delivered", { commandId: record.commandId, op: record.op, runId: record.runId });
				break;
			}
			case "message_update": {
				const update = event.assistantMessageEvent;
				if (update.type === "text_delta") this.events.ephemeral("message.delta", { delta: update.delta });
				break;
			}
			case "message_end": {
				const message = event.message as unknown as Record<string, unknown> & { role: string };
				if (message.role === "assistant") {
					const usage = message.usage as { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } } | undefined;
					const toolCalls = (Array.isArray(message.content) ? message.content : [])
						.filter((block: { type?: string }) => block?.type === "toolCall")
						.map((block: { id: string; name: string; arguments: unknown }) => ({ id: block.id, name: block.name, args: boundedJson(block.arguments, 2048) }));
					if (this.run) {
						const model = this.services.modelRuntime.getModel(this.meta.model.provider, this.meta.model.id);
						this.run.costUsd += messageCostUsd(usage as Parameters<typeof messageCostUsd>[0], model);
						this.run.lastStopReason = String(message.stopReason ?? "");
						if (message.errorMessage) this.run.lastError = String(message.errorMessage);
					}
					this.events.append("message.completed", {
						role: "assistant",
						text: bounded(textOf(message), 8192),
						...(toolCalls.length > 0 ? { toolCalls } : {}),
						stopReason: message.stopReason,
						model: message.model,
						usage: { input: usage?.input ?? 0, output: usage?.output ?? 0, totalTokens: usage?.totalTokens ?? 0, costUsd: usage?.cost?.total ?? 0 },
						...(message.errorMessage ? { errorMessage: bounded(String(message.errorMessage), 2048) } : {}),
					});
				} else if (message.role === "toolResult") {
					this.events.append("tool.result", {
						toolCallId: message.toolCallId,
						toolName: message.toolName,
						isError: message.isError === true,
						text: bounded(textOf(message), 2048),
					});
				} else if (message.role === "user") {
					this.events.append("message.completed", { role: "user", text: bounded(textOf(message), 2048) });
				}
				break;
			}
			case "tool_execution_start":
				if (!event.parentToolCallId) {
					this.events.append("tool.started", { toolCallId: event.toolCallId, toolName: event.toolName, args: boundedJson(event.args, 2048) });
				}
				break;
			case "queue_update":
				this.events.append("queue.updated", { steering: event.steering.length, followUp: event.followUp.length });
				break;
			case "agent_end":
				this.events.append("run.ended", { runId: this.run?.runId, willRetry: event.willRetry });
				break;
			case "agent_settled":
				this.settleRun(event.aborted);
				break;
			case "compaction_start":
				this.events.append("compaction.started", { reason: event.reason });
				break;
			case "compaction_end":
				this.events.append("compaction.ended", { reason: event.reason, aborted: event.aborted });
				break;
			case "auto_retry_start":
				this.events.append("retry.started", { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs });
				break;
			default:
				break;
		}
	}

	private settleRun(aborted: boolean): void {
		const run = this.run;
		this.run = undefined;
		const failed = !aborted && run?.lastStopReason === "error";
		for (const record of this.commands.values()) {
			if (record.status !== "delivered" || (run && record.runId !== run.runId)) continue;
			if (failed && run?.lastError) record.error = bounded(run.lastError, 2048);
			this.settle(record, aborted ? "aborted" : failed ? "failed" : "completed", run?.budgetStop ? { budget: run.budgetStop.reason } : {});
		}
		if (aborted) this.dropQueue(run?.budgetStop ? "budget" : "aborted");
		this.events.append("run.settled", {
			runId: run?.runId,
			aborted,
			stopReason: run?.lastStopReason ?? null,
			...(run?.budgetStop ? { budget: run.budgetStop } : {}),
			...(run && this.meta.funding ? { costUsd: run.costUsd, funding: this.meta.funding } : {}),
		});
		// A credit session pays for what its run cost, once.
		if (run && this.meta.funding === "credit") {
			this.services.public?.debit(this.meta.owner, this.meta.sessionId, run.runId, run.costUsd, `${this.meta.model.provider}/${this.meta.model.id}`);
		}
		// The record, into the graph: after the run, never during it.
		void this.mirror.schedule();
		const body = this.body?.body;
		// Messages pi queued after its last look at the queue would wait for the next prompt: drive them now.
		if (body && !aborted && body.pendingMessageCount > 0 && !body.isStreaming) {
			void (async () => {
				const { steering, followUp } = await body.clearQueue();
				const [first, ...rest] = [...steering, ...followUp];
				this.events.append("queue.stranded", { count: steering.length + followUp.length });
				if (first === undefined) return this.startIdle();
				await this.startRun(body, first);
				for (const text of rest) await body.followUp(text);
			})().catch((error: unknown) => this.events.append("run.error", { message: error instanceof Error ? error.message : String(error) }));
			return;
		}
		this.startIdle();
	}

	private startIdle(): void {
		this.clearIdle();
		if (this.services.bodyIdleMs <= 0) return;
		this.idleTimer = setTimeout(() => {
			if (this.body && !this.body.body.isStreaming && this.queued.length === 0) void this.sleep("idle");
		}, this.services.bodyIdleMs);
		this.idleTimer.unref();
	}

	private clearIdle(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	/** Dispose the body; the record stays and the next command revives it from pi's file. */
	sleep(reason: string): Promise<void> {
		this.clearIdle();
		const live = this.body;
		if (!live) return Promise.resolve();
		this.body = undefined;
		live.unsubscribe();
		this.awaiting = [];
		this.queued = [];
		this.events.append("body.dormant", { reason });
		return live.body.dispose().catch(() => undefined);
	}

	/**
	 * pi's abort waits for the run to go idle; a provider that ignores the abort must not hold the session. An
	 * isolated body that does not settle in time is killed (its box with it); an in-process one is left to finish.
	 */
	private async abortBody(body: PiBody): Promise<void> {
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([
			body.abort().catch(() => undefined),
			new Promise<void>((resolve) => {
				timer = setTimeout(() => {
					this.events.append("abort.slow", { waitedMs: ABORT_WAIT_MS, killed: body instanceof RpcBody });
					if (body instanceof RpcBody) body.kill();
					resolve();
				}, ABORT_WAIT_MS);
			}),
		]);
		clearTimeout(timer);
	}

	async shutdown(clientId: string): Promise<void> {
		if (this.body?.body.isStreaming) {
			this.dropQueue("shutdown");
			await this.abortBody(this.body.body);
		}
		await this.sleep("shutdown");
		this.lease = undefined;
		this.events.append("session.shutdown", { by: clientId });
	}

	/** Host shutdown: open commands are interrupted, the body is disposed (resolves once it is gone). */
	close(): Promise<void> {
		for (const record of this.commands.values()) {
			if (OPEN_STATUSES.has(record.status)) this.settle(record, "interrupted", { reason: "host_stopping" });
		}
		return this.sleep("host_stopping");
	}
}
