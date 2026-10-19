/**
 * The model proxy: an `agent` body never holds the model key (V6's residual risk; the Gondolin pattern).
 *
 * One loopback HTTP server per host, started with the first agent body. Each body gets a grant: a base URL that
 * names its session (`http://127.0.0.1:<port>/s/<sessionId>`) and a random token, which pi in the body uses as its
 * provider's key. The base URL replaces the provider's for the body's model runtime (`./body-entry.ts`), so pi's
 * requests come here instead of to the provider. A request is forwarded only when:
 *
 * - its path is `/s/<sessionId>/<route>`, that session holds a live grant, and the token presented
 *   (`Authorization: Bearer`, or `x-api-key`) is that grant's: compared by SHA-256 in constant time. A grant ends
 *   with its body (`revoke`), and a new body of the same session gets a new token;
 * - it is a POST, with no query, to the one route of the session's model's API (`ROUTES`): never a model list, a
 *   key endpoint or anything else of the provider's. No open relay;
 * - its JSON body names the session's model, so the key pays for nothing else.
 *
 * Then the host's key for the provider replaces the token (in the header pi used), the request goes to the host's
 * base URL for that model, and the answer streams back as it arrives (SSE included). Redirects are not followed.
 * Anything refused gets a short error and no upstream request. Nothing here logs, and no answer echoes a token or a
 * key.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

/** The one model route per pi API, relative to the model's base URL (as pi's clients build it). */
export const MODEL_ROUTES: Readonly<Record<string, string>> = {
	"openai-completions": "/chat/completions",
	"openai-responses": "/responses",
	"anthropic-messages": "/v1/messages",
};

const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Request headers never forwarded: hop-by-hop, the caller's credentials (the token), and what fetch sets itself. */
const DROP_REQUEST = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"host",
	"content-length",
	"accept-encoding",
	"authorization",
	"x-api-key",
	"cookie",
]);
/** Response headers never passed back: hop-by-hop, and the encoding and length fetch has already undone. */
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "set-cookie", "trailer", "upgrade"]);

/** The session's model as the host would call it, resolved at each request. */
export interface ModelUpstream {
	readonly api: string;
	readonly baseUrl: string;
	readonly id: string;
}

export interface ModelGrantSource {
	/** The session's model on the host: its API, base URL and id (undefined: not available). */
	upstream(): ModelUpstream | undefined;
	/** The host's key for the session's provider. */
	key(): Promise<string | undefined>;
}

/** What one body gets: where to send its model calls, and the token that stands in for the key there. */
export interface ModelGrant {
	readonly baseUrl: string;
	/** Goes to the body over its bootstrap pipe only: never logged. */
	readonly token: string;
	/** The body is gone: its token stops working now. */
	revoke(): void;
}

interface Entry {
	readonly digest: Buffer;
	readonly source: ModelGrantSource;
}

const digest = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

function refuse(res: ServerResponse, status: number, code: string, message: string): void {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	const body = JSON.stringify({ error: { code, message } });
	res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
	res.end(body);
}

/** The token a request presents: pi sends the key as a bearer token (OpenAI-shaped APIs) or as `x-api-key`. */
function presented(req: IncomingMessage): { token: string; header: "authorization" | "x-api-key" } | undefined {
	const auth = req.headers.authorization;
	if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) return { token: auth.replace(/^Bearer\s+/i, "").trim(), header: "authorization" };
	const apiKey = req.headers["x-api-key"];
	if (typeof apiKey === "string" && apiKey.trim() !== "") return { token: apiKey.trim(), header: "x-api-key" };
	return undefined;
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) return undefined;
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

export class ModelProxy {
	private readonly server: Server;
	private readonly grants = new Map<string, Entry>();
	/** `http://127.0.0.1:<port>` */
	readonly origin: string;

	private constructor(server: Server, origin: string) {
		this.server = server;
		this.origin = origin;
	}

	/** Listen on an ephemeral loopback port (IPv4 loopback only). */
	static async start(): Promise<ModelProxy> {
		let proxy: ModelProxy | undefined;
		const server = createServer((req, res) => {
			if (!proxy) return refuse(res, 503, "starting", "the model proxy is starting");
			proxy.handle(req, res).catch(() => refuse(res, 500, "proxy_error", "the model proxy failed"));
		});
		server.requestTimeout = 0;
		server.headersTimeout = 30_000;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		proxy = new ModelProxy(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
		return proxy;
	}

	/** A grant for one body of `sessionId`. It replaces any earlier grant of that session (an older body's). */
	grant(sessionId: string, source: ModelGrantSource): ModelGrant {
		const token = `vmp-${randomBytes(32).toString("base64url")}`;
		const entry: Entry = { digest: digest(token), source };
		this.grants.set(sessionId, entry);
		return {
			baseUrl: `${this.origin}/s/${encodeURIComponent(sessionId)}`,
			token,
			revoke: () => {
				if (this.grants.get(sessionId) === entry) this.grants.delete(sessionId);
			},
		};
	}

	/** How many grants are live (for tests and status). */
	get liveGrants(): number {
		return this.grants.size;
	}

	close(): Promise<void> {
		this.grants.clear();
		this.server.closeAllConnections();
		return new Promise((resolve) => this.server.close(() => resolve()));
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://proxy.invalid");
		const match = /^\/s\/([^/]+)(\/.*)$/.exec(url.pathname);
		if (!match) return refuse(res, 404, "not_found", "not a model proxy path");
		let sessionId: string;
		try {
			sessionId = decodeURIComponent(match[1] ?? "");
		} catch {
			return refuse(res, 404, "not_found", "not a model proxy path");
		}
		const route = match[2] ?? "";
		const entry = this.grants.get(sessionId);
		const offered = presented(req);
		// Always hash, so an unknown session and a wrong token take the same path.
		const offeredDigest = digest(offered?.token ?? "");
		if (!entry || !offered || !timingSafeEqual(entry.digest, offeredDigest)) {
			req.resume();
			return refuse(res, 401, "unauthorized", "no live grant for this session and token");
		}
		const upstream = entry.source.upstream();
		const allowed = upstream ? MODEL_ROUTES[upstream.api] : undefined;
		if (!upstream || !allowed) {
			req.resume();
			return refuse(res, 403, "model_api_unsupported", "this session's model is not served through the proxy");
		}
		if (req.method !== "POST" || route !== allowed || url.search !== "") {
			req.resume();
			return refuse(res, 403, "not_a_model_endpoint", `only POST ${allowed} is forwarded`);
		}
		const body = await readBody(req);
		if (!body) return refuse(res, 413, "too_large", "the request body is too large");
		let model: unknown;
		try {
			model = (JSON.parse(body.toString("utf8")) as { model?: unknown }).model;
		} catch {
			return refuse(res, 400, "invalid_json", "the request body is not JSON");
		}
		if (model !== upstream.id) return refuse(res, 403, "wrong_model", "only this session's model is forwarded");
		const key = await entry.source.key();
		if (!key) return refuse(res, 503, "no_model_key", "the host has no key for this session's provider");

		const headers = new Headers();
		for (const [name, value] of Object.entries(req.headers)) {
			if (value === undefined || DROP_REQUEST.has(name)) continue;
			for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
		}
		if (offered.header === "x-api-key") headers.set("x-api-key", key);
		else headers.set("authorization", `Bearer ${key}`);

		const controller = new AbortController();
		res.once("close", () => {
			if (!res.writableFinished) controller.abort();
		});
		let reply: Response;
		try {
			reply = await fetch(`${upstream.baseUrl.replace(/\/+$/, "")}${allowed}`, {
				method: "POST",
				headers,
				body: new Uint8Array(body),
				redirect: "manual",
				signal: controller.signal,
			});
		} catch {
			return refuse(res, 502, "upstream_unreachable", "the model provider could not be reached");
		}
		const out: Record<string, string> = {};
		reply.headers.forEach((value, name) => {
			if (!DROP_RESPONSE.has(name)) out[name] = value;
		});
		res.writeHead(reply.status, out);
		res.flushHeaders();
		if (!reply.body) {
			res.end();
			return;
		}
		const stream = Readable.fromWeb(reply.body as import("node:stream/web").ReadableStream<Uint8Array>);
		stream.on("error", () => res.destroy());
		stream.pipe(res);
	}
}
