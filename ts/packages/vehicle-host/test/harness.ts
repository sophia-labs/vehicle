/**
 * A real vehicle-host on a temporary data dir, served over real HTTP on an ephemeral loopback port. The
 * model is pi's own faux provider (`@earendil-works/pi-ai`, the provider pi's test suite uses): a real
 * provider implementation whose responses are scripted, so runs are deterministic and cost nothing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxModelDefinition, type FauxProviderHandle, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { GardendMcpOptions, SophiaBudget } from "@sophia-labs/pi-sophia";
import { type AgentBodyOptions, createRideServer, DEFAULT_PUBLIC_SETTINGS, type PublicSettings, type RideEvent, VehicleHost } from "../src/index.ts";

export const SECRET = "test-secret-0123456789abcdef";

/**
 * Who calls, as gardend would mint it. `graphId`: the graph of a graph-scoped path (`/g/<graph>/...`), which
 * gardend takes off the path and sends as `x-graph-id` with the role as `x-sophia-graph-role`; `null` for a
 * request that names no graph (the role then comes as `x-sophia-caller-role` only). Absent: the harness's
 * graph.
 */
export interface Identity {
	readonly principal?: string;
	readonly role?: string;
	readonly clientId?: string;
	readonly secret?: string;
	readonly graphId?: string | null;
	/** Extra headers, as a caller might send them (gardend would strip these; the host must ignore them). */
	readonly extra?: Record<string, string>;
}

export interface Reply {
	readonly status: number;
	readonly body: Record<string, any>;
}

export interface Harness {
	readonly dataDir: string;
	readonly host: VehicleHost;
	readonly faux: FauxProviderHandle;
	/**
	 * The faux provider of the sessions that run on a visitor's own key: a second instance, so a test sees which
	 * runtime answered. Each such session's runtime is in `byokRuntimes`, holding the visitor's key.
	 */
	readonly byokFaux: FauxProviderHandle;
	readonly byokRuntimes: ModelRuntime[];
	/** The host's own model runtime (a test may point a provider somewhere and give it a key). */
	readonly modelRuntime: ModelRuntime;
	readonly url: string;
	call(method: string, path: string, body?: unknown, who?: Identity, signal?: AbortSignal): Promise<Reply>;
	events(sessionId: string, since?: number, who?: Identity): Promise<RideEvent[]>;
	waitFor(sessionId: string, predicate: (event: RideEvent) => boolean, timeoutMs?: number, who?: Identity): Promise<RideEvent>;
	/** Stop the server and the host, keeping the data dir. */
	stop(): Promise<void>;
	/** Stop and delete the data dir. */
	cleanup(): Promise<void>;
}

export const DRIVER: Identity = { principal: "carol", role: "owner", clientId: "chat-tab-1" };
export const SECOND: Identity = { principal: "carol", role: "owner", clientId: "terminal-2" };
export const STRANGER: Identity = { principal: "someone-else", role: "owner", clientId: "x" };

export const TEST_GRAPH = "test-graph";

/** The public settings of a test host: the defaults, with the faux provider as the visitor's and credit's. */
export function testPublicSettings(model: string): PublicSettings {
	return { ...DEFAULT_PUBLIC_SETTINGS, provider: "faux", byokDefaultModel: model, creditDefaultModel: model, creditModels: [model] };
}

/** A visitor of a public Sophia, as gardend mints one: `anon:<hash>`, a viewer, `x-sophia-caller-kind: anonymous`. */
export function visitor(id: string, extra: Record<string, string> = {}): Identity {
	return { principal: `anon:${id}`, role: "viewer", clientId: `${id}-tab`, extra: { "x-sophia-caller-kind": "anonymous", ...extra } };
}

/** A Sophia account, as gardend mints one: `cognito:<sub>`, a viewer, with its email's verification. */
export function account(sub: string, verified = true, extra: Record<string, string> = {}): Identity {
	return {
		principal: `cognito:${sub}`,
		role: "viewer",
		clientId: `${sub}-tab`,
		extra: {
			"x-sophia-caller-kind": "account",
			"x-sophia-account-email": `${sub}@example.com`,
			"x-sophia-account-email-verified": verified ? "true" : "false",
			...extra,
		},
	};
}

export async function startHost(options: {
	dataDir?: string;
	models?: FauxModelDefinition[];
	gardend?: GardendMcpOptions;
	budget?: SophiaBudget;
	/** The graph every call is bound to unless its identity says otherwise. Default `test-graph`. */
	graphId?: string;
	/** How agent bodies start (default: the platform's isolation, pi's faux provider in the body). */
	agentBodies?: AgentBodyOptions;
	/** The faux provider's key on the host (handed to agent bodies over their bootstrap pipe). */
	fauxKey?: string;
	/** The session mirror (default on; it writes only with `gardend`). */
	mirror?: boolean;
	/** Public sessions (default: the defaults, on the faux provider: `testPublicSettings`). */
	public?: Partial<PublicSettings> | false;
} = {}): Promise<Harness> {
	const boundGraph = options.graphId ?? TEST_GRAPH;
	const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "vehicle-host-test-"));
	const faux = fauxProvider({ models: options.models ?? [{ id: "faux-1" }], tokensPerSecond: 2000 });
	const byokFaux = fauxProvider({ models: options.models ?? [{ id: "faux-1" }], tokensPerSecond: 2000 });
	const byokRuntimes: ModelRuntime[] = [];
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dataDir, "test-auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("faux", options.fauxKey ?? "faux-key");
	const host = await VehicleHost.open({
		dataDir,
		defaultModel: `faux/${faux.models[0].id}`,
		modelRuntime,
		bodyIdleMs: 0,
		...(options.gardend ? { gardend: options.gardend } : {}),
		...(options.budget ? { defaultBudget: options.budget } : {}),
		agentBodies: { faux: true, ...options.agentBodies },
		...(options.mirror === undefined ? {} : { mirror: options.mirror }),
		public: options.public === false ? false : { ...testPublicSettings(`faux/${faux.models[0].id}`), ...options.public },
		// A visitor's own key goes into a runtime of the session's own, which knows the faux provider but holds no key.
		byokRuntime: async () => {
			const runtime = await ModelRuntime.create({
				authPath: join(dataDir, "test-byok-none.json"),
				modelsPath: null,
				allowModelNetwork: false,
				refreshOnCreate: false,
			});
			runtime.registerNativeProvider(byokFaux.provider);
			byokRuntimes.push(runtime);
			return runtime;
		},
	});
	const server = createRideServer(host, { secret: SECRET, heartbeatMs: 1000 });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	const call = async (method: string, path: string, body?: unknown, who: Identity = DRIVER, signal?: AbortSignal): Promise<Reply> => {
		const headers: Record<string, string> = { "content-type": "application/json", ...who.extra };
		if (who.secret !== "") headers["x-internal-service"] = who.secret ?? SECRET;
		if (who.principal) headers["x-user-id"] = who.principal;
		if (who.role) headers["x-sophia-caller-role"] = who.role;
		const graphId = who.graphId === undefined ? boundGraph : who.graphId;
		if (graphId) {
			headers["x-graph-id"] = graphId;
			if (who.role) headers["x-sophia-graph-role"] = who.role;
		}
		if (who.clientId) headers["x-vehicle-client-id"] = who.clientId;
		const response = await fetch(`${url}${path}`, {
			method,
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			...(signal ? { signal } : {}),
		});
		return { status: response.status, body: (await response.json()) as Record<string, any> };
	};

	const events = async (sessionId: string, since = 0, who: Identity = DRIVER) => {
		const reply = await call("GET", `/sessions/${sessionId}/events?since=${since}`, undefined, who);
		if (reply.status !== 200) throw new Error(`watch failed: ${JSON.stringify(reply.body)}`);
		return reply.body.value.events as RideEvent[];
	};

	const waitFor = async (sessionId: string, predicate: (event: RideEvent) => boolean, timeoutMs = 10_000, who: Identity = DRIVER) => {
		const deadline = Date.now() + timeoutMs;
		let since = 0;
		while (Date.now() < deadline) {
			const reply = await call("GET", `/sessions/${sessionId}/events?since=${since}&waitMs=1000`, undefined, who);
			for (const event of reply.body.value.events as RideEvent[]) {
				if (predicate(event)) return event;
				since = event.seq;
			}
		}
		throw new Error(`timed out waiting for an event on ${sessionId}`);
	};

	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await host.mirrorsIdle(60_000);
		await host.close();
	};

	return {
		dataDir,
		host,
		faux,
		byokFaux,
		byokRuntimes,
		modelRuntime,
		url,
		call,
		events,
		waitFor,
		stop,
		cleanup: async () => {
			await stop();
			rmSync(dataDir, { recursive: true, force: true });
		},
	};
}

/** A promise you resolve from outside: holds a scripted model call open while a test acts mid-turn. */
export function gate(): { promise: Promise<void>; open: () => void } {
	let open = () => {};
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

/** Wait for the gate, or for the request's abort signal (as a real provider's HTTP call would). */
export async function held(hold: { promise: Promise<void> }, options: { signal?: AbortSignal } | undefined): Promise<void> {
	const signal = options?.signal;
	if (signal?.aborted) return;
	await Promise.race([
		hold.promise,
		new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })),
	]);
}

/** Every text the model was shown in one request, joined. */
export function contextText(context: { messages: readonly { role: string; content?: unknown }[] }): string {
	return context.messages
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? message.content.map((block: { type?: string; text?: string }) => (block.type === "text" ? block.text : "")).join("\n")
					: "",
		)
		.join("\n---\n");
}

export async function createSession(harness: Harness, body: Record<string, unknown> = {}, who: Identity = DRIVER): Promise<string> {
	const reply = await harness.call("POST", "/sessions", { requestId: `create-${Math.random()}`, ...body }, who);
	if (reply.status !== 201) throw new Error(`create failed: ${JSON.stringify(reply.body)}`);
	return reply.body.value.session.sessionId as string;
}
