/**
 * The ride protocol v2 over HTTP, bound to loopback. gardend is the only intended caller: it supervises this
 * process as the local service `vehicle`, authenticates people and agents, drops whatever identity they sent,
 * and forwards with its per-spawn secret (`x-internal-service`) and the identity it minted (`x-user-id`, the
 * roles, and `x-graph-id` for a graph-scoped path). Identity headers are believed only together with the
 * secret (garden `docs/local-service-hosting.md`).
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { buildCapsule } from "./capsule.ts";
import type { VehicleHost } from "./host.ts";
import type { RideSession } from "./session.ts";
import type { EphemeralEvent, RideEvent } from "./logs.ts";
import {
	type Caller,
	delegatedTokenOf,
	errorFrame,
	frame,
	HEADERS,
	MAX_BODY_BYTES,
	MAX_WAIT_MS,
	MAX_WATCH_EVENTS,
	modelKeyOf,
	parseCaller,
	RIDE_PROTOCOL,
	RideError,
} from "./protocol.ts";

export interface RideServerOptions {
	/** gardend's per-spawn secret for this process (`MNEMOSYNE_INTERNAL_SERVICE_SECRET`). */
	readonly secret: string;
	/** SSE keep-alive comment interval. */
	readonly heartbeatMs?: number;
}

const SESSION_ROUTE = /^\/sessions\/([A-Za-z0-9-]{1,128})(?:\/(claim|release|commands|chimes|events|capsule))?$/;

function secretMatches(expected: Buffer, given: string | string[] | undefined): boolean {
	if (typeof given !== "string") return false;
	const provided = Buffer.from(given);
	return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) throw new RideError("body_too_large", 413, `request bodies are at most ${MAX_BODY_BYTES} bytes`);
		chunks.push(chunk as Buffer);
	}
	if (size === 0) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new RideError("invalid_json", 400, "the request body is not JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RideError("invalid_request", 400, "the request body must be a JSON object");
	return parsed as Record<string, unknown>;
}

function send(response: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
	response.end(text);
}

function intParam(params: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
	const raw = params.get(name);
	if (raw === null || raw === "") return fallback;
	if (!/^-?\d{1,16}$/.test(raw)) throw new RideError("invalid_request", 400, `${name} must be an integer`);
	return Math.min(max, Math.max(min, Number(raw)));
}

export function createRideServer(host: VehicleHost, options: RideServerOptions): Server {
	const expected = Buffer.from(options.secret);
	if (expected.length < 16) throw new Error("the service secret must be at least 16 bytes");
	const heartbeatMs = options.heartbeatMs ?? 15_000;

	const watch = async (
		request: IncomingMessage,
		response: ServerResponse,
		caller: Caller,
		sessionId: string,
		params: URLSearchParams,
		offer: (session: RideSession) => unknown,
	) => {
		const session = host.get(sessionId, caller);
		offer(session);
		const lastEventId = request.headers["last-event-id"];
		const since = intParam(params, "since", typeof lastEventId === "string" && /^\d+$/.test(lastEventId) ? Number(lastEventId) : 0, -1, Number.MAX_SAFE_INTEGER);
		const accept = request.headers.accept ?? "";
		if (accept.includes("text/event-stream")) {
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
			// Open the stream now, not at the first event: a client watches before it sends a command, and
			// must know the stream is open (gardend forwards the headers as soon as they come).
			response.flushHeaders();
			let cursor = Math.max(0, since);
			let heartbeat: NodeJS.Timeout | undefined;
			let unsubscribe = () => {};
			const end = () => {
				clearInterval(heartbeat);
				unsubscribe();
				response.end();
			};
			const write = (event: RideEvent | EphemeralEvent) => {
				if ("ephemeral" in event) {
					response.write(`event: ${event.type}\ndata: ${JSON.stringify({ protocol: RIDE_PROTOCOL, type: "event", ephemeral: true, event })}\n\n`);
					return;
				}
				if (event.seq <= cursor) return;
				cursor = event.seq;
				response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({ protocol: RIDE_PROTOCOL, type: "event", cursor: event.seq, event })}\n\n`);
				// A deleted session says so last: the stream ends with it.
				if (event.type === "session.deleted") end();
			};
			unsubscribe = session.events.subscribe(write);
			for (;;) {
				const batch = session.events.since(cursor);
				if (batch.length === 0 || response.writableEnded) break;
				for (const event of batch) write(event);
			}
			if (response.writableEnded) return;
			heartbeat = setInterval(() => response.write(`: keep-alive ${cursor}\n\n`), heartbeatMs);
			request.on("close", () => {
				clearInterval(heartbeat);
				unsubscribe();
			});
			return;
		}
		const waitMs = intParam(params, "waitMs", 0, 0, MAX_WAIT_MS);
		const abort = new AbortController();
		request.on("close", () => abort.abort());
		const events = await session.events.wait(Math.max(0, since), waitMs, abort.signal);
		const cursor = events.at(-1)?.seq ?? Math.max(0, since);
		send(response, 200, frame("watch.completed", { events, cursor, count: events.length, more: events.length === MAX_WATCH_EVENTS }));
	};

	const route = async (request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", "http://vehicle-host");
		const method = request.method ?? "GET";
		if (method === "GET" && url.pathname === "/health") {
			send(response, 200, { protocol: RIDE_PROTOCOL, ok: true });
			return;
		}
		if (!secretMatches(expected, request.headers[HEADERS.secret])) throw new RideError("unauthorized", 401, "the service secret is missing or wrong");
		const caller = parseCaller(request.headers);
		// The caller's delegation token refreshes the one each of their sessions on this graph acts with; their own
		// model key (public sessions on the caller's key) likewise, in memory only.
		const delegated = delegatedTokenOf(request.headers, caller);
		const modelKey = modelKeyOf(request.headers);
		const offer = (session: RideSession | undefined) => {
			if (session && delegated) session.offerToken(caller, delegated);
			if (session && modelKey) session.offerModelKey(caller, modelKey);
			return session;
		};
		if (url.pathname === "/account") {
			if (method === "GET") {
				send(response, 200, frame("account", host.account(caller)));
				return;
			}
			throw new RideError("method_not_allowed", 405, "use GET");
		}
		if (url.pathname === "/account/grants") {
			if (method === "POST") {
				send(response, 200, host.grantCredit(caller, await readBody(request)));
				return;
			}
			throw new RideError("method_not_allowed", 405, "use POST");
		}
		if (url.pathname === "/sessions") {
			if (method === "POST") {
				const result = await host.create(caller, await readBody(request), modelKey);
				const created = (result.frame.value as { session?: { sessionId?: string } } | undefined)?.session?.sessionId;
				offer(created ? host.sessions.get(created) : undefined);
				send(response, result.status, result.frame);
				return;
			}
			if (method === "GET") {
				send(response, 200, frame("session.list", { sessions: host.list(caller) }));
				return;
			}
			throw new RideError("method_not_allowed", 405, "use GET or POST");
		}
		const match = SESSION_ROUTE.exec(url.pathname);
		if (!match) throw new RideError("not_found", 404, "no such route");
		const [, sessionId = "", action] = match;
		if (method === "GET" && action === undefined) {
			const session = offer(host.get(sessionId, caller)) as RideSession;
			send(response, 200, frame("session.snapshot", { cursor: session.events.cursor, ...session.inspect() }));
			return;
		}
		if (method === "PATCH" && action === undefined) {
			const body = await readBody(request);
			send(response, 200, await (offer(host.get(sessionId, caller)) as RideSession).rename(caller, body));
			return;
		}
		if (method === "DELETE" && action === undefined) {
			send(response, 200, await host.remove(sessionId, caller));
			return;
		}
		if (method === "GET" && action === "capsule") {
			send(response, 200, frame("session.capsule", buildCapsule(offer(host.get(sessionId, caller)) as RideSession)));
			return;
		}
		if (method === "GET" && action === "events") {
			await watch(request, response, caller, sessionId, url.searchParams, offer);
			return;
		}
		if (method === "POST" && action !== undefined) {
			const body = await readBody(request);
			// Anyone authenticated may chime into a session on the graph the request is bound to; everything else
			// is the owner's.
			const found = host.sessions.get(sessionId);
			const session =
				action === "chimes" ? (found && (caller.graphId === undefined || found.meta.graphId === caller.graphId) ? found : undefined) : host.get(sessionId, caller);
			if (!session) throw new RideError("not_found", 404, "no such session");
			offer(session);
			const result =
				action === "claim"
					? await session.claim(caller, body)
					: action === "release"
						? await session.release(caller, body)
						: action === "commands"
							? await session.command(caller, body)
							: action === "chimes"
								? await session.chime(caller, body)
								: undefined;
			if (!result) throw new RideError("not_found", 404, "no such route");
			send(response, 200, result);
			return;
		}
		throw new RideError("method_not_allowed", 405, "method not allowed here");
	};

	return createServer((request, response) => {
		route(request, response).catch((error: unknown) => {
			const rideError =
				error instanceof RideError ? error : new RideError("internal_error", 500, error instanceof Error ? error.message : String(error));
			if (rideError.status === 500) console.error("[vehicle-host]", error);
			if (response.headersSent) {
				response.end();
				return;
			}
			send(response, rideError.status, errorFrame(rideError));
		});
	});
}
