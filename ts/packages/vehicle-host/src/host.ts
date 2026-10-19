/**
 * The host: the session registry over `$VEHICLE_DATA_DIR`. It creates, revives, forks and clones sessions;
 * each session owns its body. Layout:
 *
 *   $VEHICLE_DATA_DIR/
 *     creations.jsonl                 session creation requests (idempotency by principal + requestId)
 *     pi-agent/                       pi's agent dir for every body (auth, model cache, mcp.log)
 *     sessions/<sessionId>/
 *       meta.json                     owner, graph, role, profile, model, budget, parent; only the title changes
 *       commands.jsonl                append-only: accepted requests and every command transition
 *       events.jsonl                  append-only: the ride event log (the watch cursor)
 *       pi/<timestamp>_<id>.jsonl     pi's own session file (SessionManager); an agent body writes it itself
 *       work/                         a chat body's working directory (empty: chat touches only the graph)
 *       mirror.json                   the session mirror's state: its Garden document, last write, branch (mirror.ts)
 *     workspaces/<sessionId>/         an agent session's working folder: the one place its box may write
 *     trash/<sessionId>/              a deleted session, moved here whole (never unlinked), with deleted.json and
 *                                     an agent's workspace/; restored by moving them back while the service is stopped
 */

import { randomUUID } from "node:crypto";
import { constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { type GardendMcpOptions, isSophiaProfile, isSophiaRole, normalizeBudget, type SophiaBudget } from "@sophia-labs/pi-sophia";
import { type BoxTier, type IsolationSetting, isolationSetting, probeTier, settingRefusal } from "./isolation.ts";
import { appendJsonl, readJsonl } from "./logs.ts";
import { ModelProxy } from "./model-proxy.ts";
import { type Caller, digestOf, frame, RideError, requireId } from "./protocol.ts";
import { MirrorFolders, mirrorDocumentId, personText } from "./mirror.ts";
import { DEFAULT_PUBLIC_SETTINGS, isPublicCaller, PublicPolicy, type PublicSettings } from "./public.ts";
import {
	type AgentBodies,
	findPiSessionFile,
	isRealDir,
	RideSession,
	SESSION_SCHEMA,
	type SessionMeta,
	type SessionServices,
	workspaceDir,
} from "./session.ts";

/** How this host starts `agent` bodies (all optional: the defaults follow the platform and this package). */
export interface AgentBodyOptions {
	/** Default: from the environment (`VEHICLE_ISOLATION`, `VEHICLE_AGENT_UNISOLATED`), else the platform's tier. */
	readonly isolation?: IsolationSetting;
	/**
	 * The body's entry: the bundled service's `app/main.mjs` run with `--vehicle-body` (`VEHICLE_BODY_ENTRY`, set by
	 * the service's entry), else this package's `src/body-entry.ts` from source.
	 */
	readonly entry?: string;
	readonly entryArgs?: readonly string[];
	readonly nodeArgs?: readonly string[];
	/** Read-only in the box: the body's code (default: the entry's folder, or the source workspace). */
	readonly readable?: readonly string[];
	/** A test setting: bodies answer with pi's faux provider (`./body-faux.ts`). */
	readonly faux?: boolean;
	readonly startTimeoutMs?: number;
}

export interface VehicleHostOptions {
	readonly dataDir: string;
	/** `provider/model`, for example `openrouter/openai/gpt-6-luna`. */
	readonly defaultModel: string;
	readonly gardend?: GardendMcpOptions;
	/** A model runtime to use instead of one built over `$VEHICLE_DATA_DIR/pi-agent` (tests register pi's faux provider in it). */
	readonly modelRuntime?: ModelRuntime;
	/** Dispose an idle body after this long. Default 10 minutes; 0 keeps bodies until shutdown. */
	readonly bodyIdleMs?: number;
	readonly defaultBudget?: SophiaBudget;
	/**
	 * Mirror each session's record into a Garden document in its graph (`mirror.ts`; `VEHICLE_MIRROR`). Default
	 * on; it writes only with a gardend to write to.
	 */
	readonly mirror?: boolean;
	readonly agentBodies?: AgentBodyOptions;
	/**
	 * Public sessions (`public.ts`): the doors, limits and ledger for callers gardend mints as public (a gardend in
	 * public mode). Default: the default settings. `false`: visitors get no conversations at all.
	 */
	readonly public?: PublicSettings | false;
	/**
	 * A model runtime for one session on the caller's own key. Default: pi's, with no stored credential (tests
	 * register pi's faux provider in theirs).
	 */
	readonly byokRuntime?: () => Promise<ModelRuntime>;
}

/** The body command and its read-only roots: the bundle's entry when this host runs bundled, else the source. */
function bodyCommand(options: AgentBodyOptions): { entry: string; entryArgs: string[]; nodeArgs: string[]; readable: string[] } {
	const bundled = options.entry ?? process.env.VEHICLE_BODY_ENTRY?.trim();
	if (bundled) {
		const entry = realpathSync(bundled);
		return {
			entry,
			entryArgs: [...(options.entryArgs ?? (options.entry ? [] : ["--vehicle-body"]))],
			nodeArgs: [...(options.nodeArgs ?? [])],
			readable: [...(options.readable ?? [dirname(entry)])],
		};
	}
	const here = dirname(fileURLToPath(import.meta.url));
	const entry = join(here, "body-entry.ts");
	// From source, node resolves pi and pi-sophia through the workspace's node_modules: the whole `ts/` is readable.
	return {
		entry,
		entryArgs: [...(options.entryArgs ?? [])],
		nodeArgs: [...(options.nodeArgs ?? ["--conditions=sophia-source"])],
		readable: [...(options.readable ?? [realpathSync(resolve(here, "..", "..", ".."))])],
	};
}

/**
 * `agent` bodies on this host: the setting, the body command, the model key lookup and one real probe of the tier
 * (a box running `node -e 0`), made once and remembered.
 */
function agentBodies(dataDir: string, options: AgentBodyOptions, modelRuntime: ModelRuntime, mcpUrl: string | undefined): AgentBodies {
	const isolation = options.isolation ?? isolationSetting();
	const command = bodyCommand(options);
	const node = realpathSync(process.execPath);
	// A gardend profile keeps the service's data at `<profile>/services/<id>`: the whole profile (graphs, keys) is
	// hidden from a box, not just this service's data.
	const hidden = basename(dirname(dataDir)) === "services" ? [dirname(dirname(dataDir))] : [];
	let probed: Promise<string | undefined> | undefined;
	// The model proxy (`./model-proxy.ts`), started with the first agent body.
	let proxy: Promise<ModelProxy> | undefined;
	const probe = async (): Promise<string | undefined> => {
		const before = settingRefusal(isolation);
		if (before || isolation.tier === "none") return before;
		const scratch = join(dataDir, "probe");
		const workdir = join(scratch, "work");
		const stateDir = join(scratch, "state");
		mkdirSync(workdir, { recursive: true, mode: 0o700 });
		mkdirSync(stateDir, { recursive: true, mode: 0o700 });
		const tmpDir = isolation.tier === "bwrap" ? "/tmp" : mkdtempSync(join(tmpdir(), "vehicle-probe-"));
		try {
			const failure = await probeTier(isolation.tier as BoxTier, { node, readable: command.readable, hidden, workdir, stateDir, dataDir, tmpDir, env: {} });
			return failure ? `${isolation.tier} cannot make a box on this host: ${failure}` : undefined;
		} finally {
			rmSync(scratch, { recursive: true, force: true });
			if (isolation.tier !== "bwrap") rmSync(tmpDir, { recursive: true, force: true });
		}
	};
	return {
		isolation,
		refusal: () => {
			probed ??= probe();
			return probed;
		},
		node,
		...command,
		hidden,
		...(mcpUrl ? { mcpUrl } : {}),
		faux: options.faux === true,
		modelGrant: async (sessionId, model) => {
			proxy ??= ModelProxy.start();
			return (await proxy).grant(sessionId, {
				upstream: () => {
					const { provider, id } = model();
					const found = modelRuntime.getModel(provider, id);
					return found ? { api: found.api, baseUrl: found.baseUrl, id: found.id } : undefined;
				},
				key: async () => (await modelRuntime.getAuth(model().provider))?.auth.apiKey ?? undefined,
			});
		},
		close: async () => {
			const started = proxy;
			proxy = undefined;
			if (started) await (await started).close();
		},
		...(options.startTimeoutMs ? { startTimeoutMs: options.startTimeoutMs } : {}),
	};
}

/**
 * Copy an agent's working folder for a fork or clone (a snapshot: the two then go their own ways). Links are
 * copied as links, never followed; files that are neither files, folders nor links (pipes, sockets) are left out.
 * Copy-on-write where the file system can (APFS, btrfs, XFS).
 */
function snapshotWorkspace(from: string, to: string): { copied: boolean } {
	if (!isRealDir(from)) {
		mkdirSync(to, { recursive: true, mode: 0o700 });
		return { copied: false };
	}
	cpSync(from, to, {
		recursive: true,
		verbatimSymlinks: true,
		mode: constants.COPYFILE_FICLONE,
		filter: (source) => {
			const stat = lstatSync(source);
			return stat.isFile() || stat.isDirectory() || stat.isSymbolicLink();
		},
	});
	return { copied: true };
}

interface CreationRow {
	readonly principal: string;
	readonly requestId: string;
	readonly digest: string;
	readonly sessionId: string;
}

export function parseModelRef(ref: string): { provider: string; id: string } {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) throw new RideError("invalid_request", 400, "model must be provider/model");
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

export class VehicleHost {
	readonly dataDir: string;
	readonly sessions = new Map<string, RideSession>();
	private readonly options: VehicleHostOptions;
	private readonly services: SessionServices;
	private readonly creations = new Map<string, CreationRow>();
	private chain: Promise<unknown> = Promise.resolve();

	private constructor(options: VehicleHostOptions, modelRuntime: ModelRuntime) {
		this.options = options;
		this.dataDir = options.dataDir;
		const agentDir = join(options.dataDir, "pi-agent");
		this.services = {
			modelRuntime,
			dataDir: options.dataDir,
			agentDir,
			mcpLogPath: join(agentDir, "mcp.log"),
			...(options.gardend ? { gardend: options.gardend } : {}),
			bodyIdleMs: options.bodyIdleMs ?? 10 * 60_000,
			agent: agentBodies(options.dataDir, options.agentBodies ?? {}, modelRuntime, options.gardend?.url),
			mirror: { enabled: options.mirror ?? true, folders: new MirrorFolders() },
			...(options.public === false ? {} : { public: new PublicPolicy(options.dataDir, options.public ?? DEFAULT_PUBLIC_SETTINGS) }),
			byokRuntime:
				options.byokRuntime ??
				(() =>
					ModelRuntime.create({
						// A file that never holds a credential: the session's key is a runtime key, in memory only.
						authPath: join(agentDir, "byok-none.json"),
						modelsPath: null,
						allowModelNetwork: false,
						refreshOnCreate: false,
					})),
			fork: (source, caller, request) => this.fork(source, caller, request),
		};
	}

	/** The isolation agent bodies get here, and why they cannot start (`refusal`), from a real probe of the tier. */
	async agentStatus(): Promise<{ tier: string; source: string; refusal?: string }> {
		const agent = this.services.agent;
		if (!agent) return { tier: "none", source: "host", refusal: "this host does not run agent bodies" };
		const refusal = await agent.refusal();
		return { tier: agent.isolation.tier, source: agent.isolation.source, ...(refusal ? { refusal } : {}) };
	}

	static async open(options: VehicleHostOptions): Promise<VehicleHost> {
		mkdirSync(join(options.dataDir, "sessions"), { recursive: true, mode: 0o700 });
		const agentDir = join(options.dataDir, "pi-agent");
		mkdirSync(agentDir, { recursive: true, mode: 0o700 });
		parseModelRef(options.defaultModel);
		const modelRuntime =
			options.modelRuntime ??
			(await ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: null,
				allowModelNetwork: false,
				refreshOnCreate: false,
			}));
		const host = new VehicleHost(options, modelRuntime);
		for (const row of readJsonl<CreationRow>(join(options.dataDir, "creations.jsonl"))) {
			host.creations.set(`${row.principal}\0${row.requestId}`, row);
		}
		const sessionsDir = join(options.dataDir, "sessions");
		for (const name of readdirSync(sessionsDir)) {
			const dir = join(sessionsDir, name);
			if (!existsSync(join(dir, "meta.json"))) continue;
			const session = RideSession.revive(host.services, dir);
			host.sessions.set(session.meta.sessionId, session);
		}
		return host;
	}

	/**
	 * A session the caller may read: theirs, and on the graph gardend bound the request to (a request bound
	 * to another graph does not see it). Anything else is "no such session".
	 */
	get(sessionId: string, caller: Caller): RideSession {
		const session = this.sessions.get(sessionId);
		if (!session) throw new RideError("not_found", 404, "no such session");
		session.requireReader(caller);
		return session;
	}

	/**
	 * `GET /sessions`: the caller's own sessions, on the graph gardend bound the request to (every graph when
	 * the request names none), most recently active first.
	 */
	list(caller: Caller): Record<string, unknown>[] {
		return [...this.sessions.values()]
			.filter((session) => session.meta.owner === caller.principal && (caller.graphId === undefined || session.meta.graphId === caller.graphId))
			.map((session) => session.summary())
			.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
	}

	/**
	 * `POST /sessions`: idempotent per principal and requestId. The creating client takes the lease unless
	 * `claim` is false. The graph is the one gardend bound the request to (`x-graph-id`, from a graph-scoped
	 * path), never one named in the body: a body that names another graph is refused.
	 */
	async create(caller: Caller, body: Record<string, unknown>, modelKey?: string): Promise<{ status: number; frame: Record<string, unknown> }> {
		const requestId = requireId("requestId", body.requestId);
		const graphId = caller.graphId;
		if (!graphId) {
			throw new RideError("graph_required", 400, "create sessions on a graph-scoped path: /services/vehicle/g/<graph>/sessions");
		}
		if (body.graphId !== undefined && body.graphId !== graphId) {
			throw new RideError("graph_mismatch", 400, "the session's graph is the one gardend bound this request to; the body may not name another");
		}
		const profile = body.profile ?? "chat";
		if (!isSophiaProfile(profile)) throw new RideError("invalid_request", 400, "profile must be chat or agent");
		if (profile === "agent") {
			// An agent runs code on this computer: only the workspace's owner may start one, and only in a box.
			if (caller.role !== "owner") {
				throw new RideError("forbidden_profile", 403, "only the workspace's owner can start an agent session: it runs code on this computer");
			}
			const refusal = this.services.agent ? await this.services.agent.refusal() : "this host does not run agent bodies";
			if (refusal) throw new RideError("isolation_unavailable", 503, refusal);
		}
		// A visitor or a Sophia account (public mode) opens a conversation by one of two doors: its own model key, or
		// an account's credit (`public.ts`); its runs keep to the public budget.
		const publicDoor = isPublicCaller(caller) ? this.publicPolicy().open(caller, modelKey !== undefined, body.model) : undefined;
		const model = parseModelRef(publicDoor ? publicDoor.model : body.model === undefined ? this.options.defaultModel : String(body.model));
		let budget;
		try {
			budget = normalizeBudget({ ...this.options.defaultBudget, ...(body.budget as SophiaBudget | undefined) });
			if (publicDoor) {
				const cap = this.publicPolicy().settings.runBudget;
				budget = { maxTurns: Math.min(budget.maxTurns, cap.maxTurns), maxCostUsd: Math.min(budget.maxCostUsd, cap.maxCostUsd) };
			}
		} catch (error) {
			throw new RideError("invalid_request", 400, (error as Error).message);
		}
		const title = body.title === undefined ? undefined : String(body.title).slice(0, 200);
		const claim = body.claim !== false;
		const { requestId: _ignored, graphId: _bound, ...rest } = body;
		const digest = digestOf({ ...rest, graphId, role: caller.role });
		const key = `${caller.principal}\0${requestId}`;
		const run = this.chain.then(async () => {
			const prior = this.creations.get(key);
			if (prior) {
				if (prior.digest !== digest) throw new RideError("request_id_conflict", 409, "this requestId was already used for a different request");
				const session = this.get(prior.sessionId, caller);
				return { status: 200, frame: frame("session.created", { session: session.summary(), replayed: true }, requestId) };
			}
			if (!this.services.modelRuntime.getModel(model.provider, model.id)) {
				throw new RideError("model_unavailable", 400, `model ${model.provider}/${model.id} is not available on this host`);
			}
			if (!isSophiaRole(caller.role)) throw new RideError("invalid_identity", 400, "role is required");
			const sessionId = randomUUID();
			const meta: SessionMeta = {
				schema: SESSION_SCHEMA,
				sessionId,
				createdAt: new Date().toISOString(),
				owner: caller.principal,
				graphId,
				role: caller.role,
				profile,
				model,
				budget,
				...(title ? { title } : {}),
				...(publicDoor ? { funding: publicDoor.funding } : {}),
				// A public conversation reads every public graph, its own first (gardend's list, at creation).
				...(publicDoor && caller.publicGraphs?.includes(graphId)
					? { graphs: caller.publicGraphs.filter((graph) => graph !== graphId) }
					: {}),
			};
			if (profile === "agent") mkdirSync(workspaceDir(this.dataDir, sessionId), { recursive: true, mode: 0o700 });
			const session = RideSession.create(this.services, join(this.dataDir, "sessions", sessionId), meta);
			this.sessions.set(sessionId, session);
			const row: CreationRow = { principal: caller.principal, requestId, digest, sessionId };
			this.creations.set(key, row);
			appendJsonl(join(this.dataDir, "creations.jsonl"), row);
			if (modelKey) session.offerModelKey(caller, modelKey);
			if (claim) await session.claim(caller, { requestId: `create:${requestId}` });
			return { status: 201, frame: frame("session.created", { session: session.summary() }, requestId) };
		});
		this.chain = run.catch(() => undefined);
		return run;
	}

	private publicPolicy(): PublicPolicy {
		const policy = this.services.public;
		if (!policy) throw new RideError("not_public", 403, "this Sophia does not open conversations to visitors");
		return policy;
	}

	/**
	 * `GET /account`: a public caller's turns, credit and doors (`public.ts`); for this Sophia's own people, that
	 * they have no limits here.
	 */
	account(caller: Caller): Record<string, unknown> {
		if (isPublicCaller(caller)) return this.publicPolicy().account(caller);
		return { kind: "member", principal: caller.principal, role: caller.role, limits: "none: this Sophia's own people use its key" };
	}

	/**
	 * `POST /account/grants`: credit for an account from outside the signup grant (a purchase, the operator), by the
	 * workspace's owner only; idempotent by its key, so a payment delivered twice credits once.
	 */
	grantCredit(caller: Caller, body: Record<string, unknown>): Record<string, unknown> {
		if (caller.role !== "owner" || isPublicCaller(caller)) throw new RideError("forbidden", 403, "only this Sophia's owner grants credit");
		const policy = this.publicPolicy();
		const principal = String(body.principal ?? "");
		const created = policy.grant(principal, Number(body.amountUsd), (body.source ?? "operator") as "operator", String(body.idempotencyKey ?? ""), body.note === undefined ? undefined : String(body.note));
		return frame("account.granted", { principal, created, balanceUsd: policy.balanceOf(principal) });
	}

	/**
	 * Fork (from before a user message, as pi's `/fork`) or clone (the active branch, as pi's `/clone`) into a
	 * new session. pi writes the new session file (`createBranchedSession`); the host moves it into the new
	 * session's directory and records the lineage. The calling client takes the new session's lease.
	 */
	async fork(
		source: RideSession,
		caller: Caller,
		request: { requestId: string; kind: "fork" | "clone"; entryId?: string },
	): Promise<Record<string, unknown>> {
		const sourceFile = source.piSessionFile();
		if (!sourceFile || !existsSync(sourceFile)) {
			throw new RideError("nothing_to_fork", 409, "this session has no saved conversation yet: send a message before cloning or forking it");
		}
		if (source.meta.profile === "agent" && caller.role !== "owner") {
			throw new RideError("access_reduced", 403, "an agent session runs code: only the workspace's owner can fork it");
		}
		const sourcePiDir = join(source.dir, "pi");
		const manager = SessionManager.open(sourceFile, sourcePiDir, source.workdir);
		let targetLeafId: string | null;
		let selectedText: string | undefined;
		if (request.kind === "clone") {
			targetLeafId = manager.getLeafId();
		} else {
			if (!request.entryId) throw new RideError("invalid_request", 400, "fork needs the entryId of a user message");
			const entry = manager.getEntry(request.entryId) as { type: string; parentId: string | null; message?: { role: string; content: unknown } } | undefined;
			if (!entry || entry.type !== "message" || entry.message?.role !== "user") {
				throw new RideError("invalid_request", 400, "fork needs the entryId of a user message on this session");
			}
			targetLeafId = entry.parentId;
			const content = entry.message.content;
			// What the person wrote, without the note pi-sophia added for the model.
			selectedText = personText(
				typeof content === "string" ? content : (content as { type: string; text?: string }[]).filter((block) => block.type === "text").map((block) => block.text).join("\n"),
			);
		}
		let sessionId: string = randomUUID();
		let forkedFile: string | undefined;
		if (targetLeafId) {
			const branched = manager.createBranchedSession(targetLeafId);
			if (!branched) throw new RideError("fork_failed", 500, "pi did not write the forked session");
			// pi writes a branch only once its path holds a conversation: a fork before the first message has none,
			// and starts empty, as a new session does (its first prompt makes pi's file).
			if (existsSync(branched)) {
				forkedFile = branched;
				const header = JSON.parse(readFileSync(forkedFile, "utf8").split("\n")[0] ?? "{}") as { id?: string };
				if (!header.id) throw new RideError("fork_failed", 500, "the forked session has no id");
				sessionId = header.id;
			}
		}
		const dir = join(this.dataDir, "sessions", sessionId);
		// A branch is its own conversation: not named as its source (a list would show two of one name). A clone is
		// "Copy of" its source, as Garden names a duplicated document; a fork is named by what was said in it.
		const { title: _sourceTitle, ...inherited } = source.meta;
		const sourceName = source.meta.title ?? source.preview();
		const meta: SessionMeta = {
			...inherited,
			sessionId,
			createdAt: new Date().toISOString(),
			...(request.kind === "clone" && sourceName ? { title: `Copy of ${sourceName}`.slice(0, 200) } : {}),
			parent: { sessionId: source.meta.sessionId, kind: request.kind, ...(request.entryId ? { entryId: request.entryId } : {}) },
		};
		// An agent's working folder is backtracked with its conversation: the new session starts from a copy.
		const workspace =
			meta.profile === "agent" ? snapshotWorkspace(workspaceDir(this.dataDir, source.meta.sessionId), workspaceDir(this.dataDir, sessionId)) : undefined;
		const forked = RideSession.create(this.services, dir, meta);
		if (forkedFile) renameSync(forkedFile, join(dir, "pi", forkedFile.split("/").at(-1) as string));
		this.sessions.set(sessionId, forked);
		await forked.claim(caller, { requestId: `${request.kind}:${source.meta.sessionId}:${request.requestId}` });
		// The branch acts for the same person, and its record is mirrored as a branch of its source's (a wire to
		// the source's document, a link in its header): now, when it already holds a conversation.
		forked.inheritDelegation(source);
		forked.mirror.noteBranch({
			kind: request.kind,
			parentSessionId: source.meta.sessionId,
			parentDocumentId: mirrorDocumentId(source.meta.sessionId),
			parentTitle: source.meta.title ?? source.preview() ?? "an earlier conversation",
			...(selectedText ? { before: selectedText } : {}),
		});
		void forked.mirror.schedule();
		source.events.append(`session.${request.kind === "fork" ? "forked" : "cloned"}`, {
			into: sessionId,
			...(request.entryId ? { entryId: request.entryId } : {}),
			...(workspace ? { workspace } : {}),
		});
		return { session: forked.summary(), ...(selectedText !== undefined ? { selectedText } : {}), ...(workspace ? { workspace } : {}) };
	}

	/**
	 * `DELETE /sessions/:id`: the owner's, like reading it (a request bound to another graph, or another
	 * principal, finds no such session; a role cut to read-only may still delete its own conversation).
	 * Refused while a run is under way (`session_running`). The record moves to `trash/`; afterwards the
	 * session is not listed and every request for it is `not_found`.
	 */
	async remove(sessionId: string, caller: Caller): Promise<Record<string, unknown>> {
		const session = this.get(sessionId, caller);
		// Its mirror document, for the client to put in the workspace's Trash with the person's own credential
		// (gardend's delegation token reaches only /mcp, and no tool there trashes a document).
		const mirror = session.mirror.written();
		const trashedAs = await session.retire(caller, join(this.dataDir, "trash"));
		this.sessions.delete(sessionId);
		return frame("session.deleted", { sessionId, trashedAs, ...(mirror ? { mirror } : {}) });
	}

	/** Find pi's file for a session (exported for tests and tools). */
	piFileOf(sessionId: string): string | undefined {
		return findPiSessionFile(join(this.dataDir, "sessions", sessionId, "pi"));
	}

	/** Stop every body (an isolated one ends its box); resolves once they are gone. */
	async close(): Promise<void> {
		await Promise.all([...this.sessions.values()].map((session) => session.close()));
		await this.services.agent?.close();
	}

	/** Resolves once no session mirror is writing (at most `timeoutMs`): before the process exits. */
	async mirrorsIdle(timeoutMs = 5_000): Promise<void> {
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([
			Promise.all([...this.sessions.values()].map((session) => session.mirror.idle())),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
			}),
		]);
		clearTimeout(timer);
	}
}
