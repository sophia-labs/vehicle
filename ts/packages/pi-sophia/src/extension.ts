/**
 * `@sophia-labs/pi-sophia`: Sophia's behaviour as one pi extension (principle 1 in the README).
 *
 * - gardend's `/mcp` is registered through pi's own MCP support, so the graph tools are the agent's tools.
 *   Tools the profile hands over get `direct` exposure; every other cell tool is `hidden` (unreachable).
 * - The graph is bound by gardend, not by the model: under gardend the session's MCP client carries the
 *   delegation token gardend handed with the caller's last request (`getToken`), which binds every call to
 *   the session's graph and speaks for the person. gardend's `tools/list` then has no graph argument, fills
 *   the graph in, refuses another graph, and refuses a viewer's writes itself. The `tool_call` fence still
 *   blocks a call that names another graph (defence in depth, and the only binding with a plain token).
 * - Profile `chat`: graph tools only. pi's built-ins (read, bash, edit, write, ...) are never active.
 * - Profile `agent`: the graph tools plus pi's `read`, `write`, `edit` and `bash` on the body's working folder. The
 *   extension only offers them: the isolation is the host's (an `agent` body is a `pi --mode rpc` child in a box).
 * - The workspace prompt replaces pi's coding preamble; nothing from the host's disk (context files, skills)
 *   reaches the model.
 * - A budget guard caps turns and cost per run.
 */

import type { ExtensionAPI, ExtensionFactory, McpTransportFactory } from "@earendil-works/pi-coding-agent";
import { StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { type BudgetStop, BudgetGuard, messageCostUsd, type SophiaBudget } from "./budget.ts";
import { graphFence, graphNamedBy } from "./graph-binding.ts";
import {
	AGENT_BUILTINS,
	accessForRole,
	chatTools,
	isSophiaProfile,
	isSophiaRole,
	type SophiaAccess,
	type SophiaProfile,
	type SophiaRole,
} from "./manifest.ts";
import { sophiaPrompt } from "./prompt.ts";

export const DEFAULT_SERVER_NAME = "sophia";
export const BUDGET_ENTRY_TYPE = "sophia.budget";
export const BINDING_ENTRY_TYPE = "sophia.binding";
/**
 * The `auth.provider` a session with `getToken` registers gardend under. It names no pi provider: the
 * transport from [`createSophiaMcpTransport`] supplies the token, and without that transport pi finds no key
 * under this name, so the server gets no credential at all (it fails closed).
 */
export const DELEGATED_AUTH_PROVIDER = "sophia-delegated";

export interface GardendMcpOptions {
	/** gardend's MCP endpoint, for example `http://127.0.0.1:7674/mcp`. */
	readonly url: string;
	/**
	 * The token to send, read before every request: under gardend, the newest delegation token gardend handed
	 * the host with this session's caller's requests (bound to the session's graph, acting for that person).
	 * It needs the transport from [`createSophiaMcpTransport`] (pass it to `createMcpExtension`). `undefined`
	 * sends no credential. When set, `token` and `tokenEnv` are not used. An isolated body asks its host for the
	 * token over pi's RPC channel, so it may answer later (a promise).
	 */
	readonly getToken?: () => string | undefined | Promise<string | undefined>;
	/**
	 * A fixed bearer token (pi by hand, tests). When neither this nor `getToken` is given, the header
	 * references `${<tokenEnv>}`, which pi resolves from the environment at connect time, so the token never
	 * sits in a config object. Unless it is a graph-bound token, the model must name the graph itself.
	 */
	readonly token?: string;
	/** The environment variable holding the token when `token` is absent. Default `SOPHIA_GARDEND_TOKEN`. */
	readonly tokenEnv?: string;
	/** Per-request timeout, seconds. Default 60. */
	readonly timeoutSeconds?: number;
}

/**
 * The MCP transport for gardend when the token comes from `getToken`: pi's streamable HTTP transport, with the
 * token read before each request (pi's own header config is resolved once, at connect). Only gardend's URL is
 * served; any other server is refused.
 */
export function createSophiaMcpTransport(options: GardendMcpOptions): McpTransportFactory {
	const getToken = options.getToken;
	if (!getToken) throw new Error("createSophiaMcpTransport needs getToken");
	return (entry) => {
		const url = "url" in entry.config ? entry.config.url : undefined;
		if (url !== options.url) throw new Error(`MCP server "${entry.name}" is not gardend's`);
		return new StreamableHttpTransport({
			url,
			authProvider: { token: async () => getToken() },
		});
	};
}

export interface SophiaExtensionOptions {
	readonly graphId: string;
	/**
	 * More workspaces the session reads besides its own (a public session reads every public graph: gardend binds
	 * its delegation to all of them, read-only). Each tool call names one as `graphId`; one that names none reads
	 * `graphId`.
	 */
	readonly graphs?: readonly string[];
	/** The person's role on the graph, as gardend minted it. Default `viewer` (fail closed: read only). */
	readonly role?: SophiaRole;
	readonly profile?: SophiaProfile;
	/** Profile `agent` only: the body's working folder (its built-in tools' current directory) and its box. */
	readonly agent?: { readonly workdir: string; readonly isolation: string };
	/** Absent: no graph is reachable (the session has no tools). */
	readonly gardend?: GardendMcpOptions;
	readonly serverName?: string;
	readonly budget?: SophiaBudget;
	/** Called once per run when the budget guard stops it. */
	readonly onBudgetStop?: (stop: BudgetStop) => void;
}

const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"] as const;
const GRAPH_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

/** pi's name for one of the server's tools. */
export function mcpToolName(serverName: string, tool: string): string {
	return `mcp__${serverName.replace(/[^A-Za-z0-9_]/g, "_")}__${tool.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/**
 * The name pi gives the profile's tool a model called by `name`: the name itself when it is pi's
 * (`mcp__sophia__search_blocks`), or the cell tool's bare name with whatever prefix the model put on it
 * (`search_blocks`, `default_api.search_blocks`, `sophia__search_blocks`). `undefined` for any other tool.
 */
export function profileToolName(name: string, server: string, manifest: readonly string[]): string | undefined {
	const tool = name.split(/__|[.:]/).at(-1) ?? name;
	if (!manifest.includes(tool)) return undefined;
	const full = mcpToolName(server, tool);
	return name === tool || name === full || name.endsWith(`__${tool}`) || name.endsWith(`.${tool}`) || name.endsWith(`:${tool}`) ? full : undefined;
}

/** pi's built-ins a profile is handed: none for chat, `read`, `write`, `edit` and `bash` for an agent. */
export function profileBuiltins(profile: SophiaProfile | undefined): readonly string[] {
	return profile === "agent" ? AGENT_BUILTINS : [];
}

/**
 * The tool names a session of this profile may have active: the access level's cell tools, as pi names them, and
 * for an agent the built-ins it is handed.
 */
export function sophiaToolAllowlist(options: Pick<SophiaExtensionOptions, "role" | "gardend" | "serverName" | "profile">): string[] {
	const server = options.serverName ?? DEFAULT_SERVER_NAME;
	const graph = options.gardend ? chatTools(accessForRole(options.role ?? "viewer")).map((tool) => mcpToolName(server, tool)) : [];
	return [...graph, ...profileBuiltins(options.profile)];
}

/** pi's built-in tools; the chat profile never activates them. */
export const SOPHIA_EXCLUDED_BUILTINS: readonly string[] = BUILTIN_TOOLS;

/** pi's built-ins a profile never activates: all of them for chat, the ones it is not handed for an agent. */
export function sophiaExcludedBuiltins(profile: SophiaProfile | undefined): readonly string[] {
	const handed = new Set(profileBuiltins(profile));
	return BUILTIN_TOOLS.filter((tool) => !handed.has(tool));
}

export function createSophiaExtension(options: SophiaExtensionOptions): ExtensionFactory {
	if (!GRAPH_ID.test(options.graphId)) throw new Error("graphId must be a graph id (letters, digits, _ . -)");
	const role: SophiaRole = options.role ?? "viewer";
	if (!isSophiaRole(role)) throw new Error("role must be owner, editor or viewer");
	const profile: SophiaProfile = options.profile ?? "chat";
	if (!isSophiaProfile(profile)) throw new Error(`profile ${String(profile)} is not a Sophia profile`);
	if (profile === "agent" && !options.agent) throw new Error("an agent body needs its working folder and box");
	const builtins = new Set(profileBuiltins(profile));
	const access: SophiaAccess = accessForRole(role);
	const server = options.serverName ?? DEFAULT_SERVER_NAME;
	const manifest = chatTools(access);
	const allowed = new Map(manifest.map((tool) => [mcpToolName(server, tool), tool]));
	const graphId = options.graphId;
	const readable = new Set([graphId, ...(options.graphs ?? []).filter((graph) => GRAPH_ID.test(graph))]);
	const others = [...readable].filter((graph) => graph !== graphId);
	if (options.gardend?.token !== undefined && (options.gardend.token.includes("${") || options.gardend.token.startsWith("!"))) {
		// pi expands `${NAME}` and `!command` in header values; a token must never be read as either.
		throw new Error("the gardend token has a form pi would expand; pass it through the environment instead");
	}
	const tokenEnv = options.gardend?.tokenEnv ?? "SOPHIA_GARDEND_TOKEN";
	if (!/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv)) throw new Error("tokenEnv must be an environment variable name");

	return (pi: ExtensionAPI) => {
		const guard = new BudgetGuard(options.budget);

		if (options.gardend) {
			pi.registerMcpServer(server, {
				url: options.gardend.url,
				...(options.gardend.getToken
					? { auth: { provider: DELEGATED_AUTH_PROVIDER } }
					: {
							headers: {
								Authorization: options.gardend.token ? `Bearer ${options.gardend.token}` : `Bearer \${${tokenEnv}}`,
							},
						}),
				description:
					others.length === 0
						? `The Sophia workspace "${graphId}": its documents, files, search, history, wires and values.`
						: `The Sophia workspaces ${[...readable].map((graph) => `"${graph}"`).join(", ")}: their documents, files, search, wires and values.`,
				exposure: "hidden",
				toolExposure: Object.fromEntries(manifest.map((tool) => [tool, "direct" as const])),
				timeout: options.gardend.timeoutSeconds ?? 60,
			});
		}

		/** The profile's graph tools that are registered right now, as pi names them. */
		const liveTools = () => pi.getAllTools().filter((tool) => allowed.has(tool.name) && tool.exposure === "direct");
		/** An agent's built-ins that pi has (all four, unless pi was started without them). */
		const liveBuiltins = () => pi.getAllTools().filter((tool) => builtins.has(tool.name)).map((tool) => tool.name);

		pi.on("session_start", () => {
			pi.appendEntry(BINDING_ENTRY_TYPE, { graphId, role, access, profile, server, budget: guard.limits });
		});

		// The prompt, and the profile's tools only. Runs after the MCP extension's own handler, which waits
		// for servers with direct tools, so the live tools are known here.
		pi.on("before_agent_start", (event) => {
			const live = liveTools();
			pi.setActiveTools([...live.map((tool) => tool.name), ...liveBuiltins()]);
			const prompt = sophiaPrompt({
				graphId,
				...(others.length > 0 ? { graphs: others } : {}),
				role,
				tools: live.map((tool) => allowed.get(tool.name) as string),
				toolName: (tool) => mcpToolName(server, tool),
				...(options.agent ? { agent: options.agent } : {}),
			});
			const promptOptions = event.systemPromptOptions;
			promptOptions.customPrompt = prompt.intro;
			promptOptions.sections.workspace_tools = prompt.tools;
			if (prompt.box) promptOptions.sections.agent_box = prompt.box;
			promptOptions.sections.how_to_work = prompt.rules;
			promptOptions.appendSystemPrompt = "";
			promptOptions.contextFiles = [];
			promptOptions.skills = [];
			promptOptions.promptGuidelines = [];
		});

		// A call by the cell tool's bare name (`search_blocks`, or `default_api.search_blocks`) is the profile's
		// tool: some models (gemini-2.5-flash) drop pi's `mcp__sophia__` prefix. pi finds a tool by its exact name
		// before any hook runs, so the call is renamed on the finished message, which pi applies before it runs
		// the calls (the transcript then records the name that ran). Only the name: never the arguments.
		pi.on("message_end", (event) => {
			const message = event.message;
			if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
			let changed = false;
			const content = message.content.map((block) => {
				if (block.type !== "toolCall") return block;
				const name = profileToolName(block.name, server, manifest);
				if (name === undefined || name === block.name) return block;
				changed = true;
				return { ...block, name };
			});
			return changed ? { message: { ...message, content: content as typeof message.content } } : undefined;
		});

		// The fence: graph tools of this profile only, on the bound graph only.
		pi.on("tool_call", (event) => {
			if (guard.exceeded) {
				return { block: true, reason: `The budget for this run is spent (${guard.exceeded.reason}).`, terminate: true };
			}
			if (builtins.has(event.toolName)) return undefined;
			if (!allowed.has(event.toolName)) {
				return { block: true, reason: `${event.toolName} is not available in this conversation.` };
			}
			const fenced = graphFence(graphNamedBy(event.input), graphId, others);
			if (fenced) return { block: true, reason: fenced };
			return undefined;
		});

		pi.on("agent_start", () => guard.startRun());

		pi.on("turn_end", (event, ctx) => {
			const message = event.message;
			if (message.role !== "assistant") return undefined;
			const stop = guard.endTurn(messageCostUsd(message.usage, ctx.model));
			if (!stop) return undefined;
			const continues = message.stopReason === "toolUse" || ctx.hasPendingMessages();
			pi.appendEntry(BUDGET_ENTRY_TYPE, { ...stop, aborted: continues });
			options.onBudgetStop?.(stop);
			if (continues) ctx.abort();
			return undefined;
		});
	};
}

function envNumber(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`not a number: ${value}`);
	return parsed;
}

/**
 * The extension as pi loads it from a path or package (`pi -e @sophia-labs/pi-sophia`, or a `pi --mode rpc`
 * body), configured from the environment: `SOPHIA_GRAPH_ID`, `SOPHIA_GRAPH_ROLE`, `SOPHIA_GARDEND_MCP_URL`,
 * `SOPHIA_GARDEND_TOKEN`, `SOPHIA_MAX_TURNS`, `SOPHIA_MAX_COST_USD`.
 */
export function sophiaExtensionFromEnv(env: NodeJS.ProcessEnv = process.env): ExtensionFactory {
	const graphId = env.SOPHIA_GRAPH_ID?.trim();
	if (!graphId) throw new Error("SOPHIA_GRAPH_ID is required");
	const role = env.SOPHIA_GRAPH_ROLE?.trim() || "viewer";
	if (!isSophiaRole(role)) throw new Error("SOPHIA_GRAPH_ROLE must be owner, editor or viewer");
	const url = env.SOPHIA_GARDEND_MCP_URL?.trim();
	const maxTurns = envNumber(env.SOPHIA_MAX_TURNS);
	const maxCostUsd = envNumber(env.SOPHIA_MAX_COST_USD);
	return createSophiaExtension({
		graphId,
		role,
		...(url ? { gardend: { url } } : {}),
		budget: { ...(maxTurns === undefined ? {} : { maxTurns }), ...(maxCostUsd === undefined ? {} : { maxCostUsd }) },
	});
}
