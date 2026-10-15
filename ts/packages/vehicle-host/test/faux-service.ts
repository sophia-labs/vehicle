#!/usr/bin/env node
/**
 * vehicle-host with pi's faux provider, for the tests of the ride's clients (the Rust `vehicle` room, its
 * chimes and its JSONL ride): the real host and the real ride protocol, with a scripted model that costs
 * nothing and needs no key.
 *
 * It reads gardend's service environment (`PORT`, `DATA_DIR`, `MNEMOSYNE_INTERNAL_SERVICE_SECRET`,
 * `GARDEN_SERVICE_HOST`), so a test manifest can put it under a real gardend as the service `vehicle`:
 *
 *   {"serviceId": "vehicle", "command": "node",
 *    "args": ["--conditions=sophia-source", "<this file>"], "healthPath": "/health", "memberAccess": "all"}
 *
 * Run by hand, every variable is optional (an ephemeral port, a temporary data dir, a fresh secret). With
 * `VEHICLE_FAUX_FRONT_TOKENS` (JSON: bearer token → {principal, role}) it also serves a gardend-shaped front on
 * another loopback port: `/services/vehicle/...` with `Authorization: Bearer <token>`, identity headers dropped
 * and minted as gardend mints them, a graph-scoped path (`/g/<graph>/...`) bound, responses streamed.
 * `VEHICLE_FAUX_FRONT_NO_SSE=1` makes the front refuse event streams (501), as gardend 0.1.3 did;
 * `VEHICLE_FAUX_FRONT_CUT_STREAMS_MS=<ms>` drops every event stream that long after it opens (a flaky network).
 * `VEHICLE_FAUX_DELEGATION=1` runs the host as under a gardend with `/mcp` (nothing listens there: the faux model
 * calls no tools), so a body starts only with its owner's delegation token, and the front mints one on every
 * graph-scoped request (`x-sophia-delegated-token`), as gardend does for a `"delegateCaller"` service.
 * `VEHICLE_FAUX_FRONT_PUBLIC=1` makes the front a public gardend's (public mode): a request with no bearer is a
 * visitor, `anon:<hash of X-Visitor-Id>`, a viewer with `x-sophia-caller-kind: anonymous`; `X-Model-Key` passes
 * through (the manifest's `"acceptsModelKey": true`), `X-Visitor-Id` does not.
 *
 * The model answers by rule, from the newest user message it is shown:
 *   `[hold]`        waits until the run is aborted (at most 120 s), then answers "held";
 *   `[slow <ms>]`   waits that long (abortable), then answers;
 *   otherwise       answers at once.
 * Every answer is `faux heard: <that message>`, streamed as text deltas.
 *
 * When ready it prints one JSON line: {"host": "<url>", "front": "<url>" | null}.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRideServer, DEFAULT_PUBLIC_SETTINGS, VehicleHost } from "../src/index.ts";

const HOLD_MS = 120_000;
const MOUNT = "/services/vehicle";
const GRAPH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
/** What gardend drops from a caller before it forwards (garden `docs/local-service-hosting.md`). */
const DROPPED = [/^authorization$/, /^cookie$/, /^cf-access-/, /^x-user-/, /^x-graph-/, /^x-sophia-/, /^x-internal-/, /^x-pn-/, /^x-visitor-id$/, /^host$/, /^connection$/];

const env = (name: string) => process.env[name]?.trim() || undefined;

function newestUserText(messages: readonly { role: string; content?: unknown }[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) {
			return message.content.map((block: { type?: string; text?: string }) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
		}
	}
	return "";
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

const faux = fauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 400 });
const answer: FauxResponseFactory = async (context, options) => {
	faux.appendResponses([answer]);
	const heard = newestUserText(context.messages as never);
	if (heard.includes("[hold]")) {
		await pause(HOLD_MS, options?.signal);
		return fauxAssistantMessage("held");
	}
	const slow = /\[slow (\d{1,6})\]/.exec(heard);
	if (slow) await pause(Number(slow[1]), options?.signal);
	return fauxAssistantMessage(`faux heard: ${heard}`);
};
faux.setResponses([answer]);

const ownDataDir = env("DATA_DIR") === undefined;
const dataDir = env("DATA_DIR") ?? mkdtempSync(join(tmpdir(), "vehicle-faux-"));
const secret = env("MNEMOSYNE_INTERNAL_SERVICE_SECRET") ?? randomBytes(24).toString("hex");
const bind = env("GARDEN_SERVICE_HOST") ?? "127.0.0.1";

const modelRuntime = await ModelRuntime.create({
	authPath: join(dataDir, "faux-auth.json"),
	modelsPath: null,
	allowModelNetwork: false,
	refreshOnCreate: false,
});
modelRuntime.registerNativeProvider(faux.provider);
await modelRuntime.setRuntimeApiKey("faux", "faux-key");
const delegation = env("VEHICLE_FAUX_DELEGATION") === "1";
const host = await VehicleHost.open({
	dataDir,
	defaultModel: "faux/faux-1",
	modelRuntime,
	bodyIdleMs: 0,
	...(delegation ? { gardend: { url: "http://127.0.0.1:9/mcp" } } : {}),
	// `agent` sessions: real isolated bodies in this platform's box, answered by pi's faux provider inside the body
	// (`src/body-faux.ts`: `[tool <name> <json>]` runs that tool).
	agentBodies: { faux: true },
	// Public sessions on the faux provider: a visitor's own key goes into a runtime of the session's own.
	public: {
		...DEFAULT_PUBLIC_SETTINGS,
		provider: "faux",
		byokDefaultModel: "faux/faux-1",
		creditDefaultModel: "faux/faux-1",
		creditModels: ["faux/faux-1"],
	},
	byokRuntime: async () => {
		const runtime = await ModelRuntime.create({ authPath: join(dataDir, "faux-byok-none.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
		runtime.registerNativeProvider(faux.provider);
		return runtime;
	},
});
const server = createRideServer(host, { secret, heartbeatMs: 2_000 });
await new Promise<void>((resolve) => server.listen(Number(env("PORT") ?? 0), bind, resolve));
const hostUrl = `http://${bind}:${(server.address() as AddressInfo).port}`;

/** A gardend-shaped front: authenticate, drop the caller's identity, mint gardend's, bind the graph, stream. */
function startFront(tokens: Record<string, { principal: string; role: string }>): Promise<string> {
	const refuseStreams = env("VEHICLE_FAUX_FRONT_NO_SSE") === "1";
	const publicFront = env("VEHICLE_FAUX_FRONT_PUBLIC") === "1";
	const cutStreamsMs = Number(env("VEHICLE_FAUX_FRONT_CUT_STREAMS_MS") ?? 0);
	const hostPort = (server.address() as AddressInfo).port;
	const front = createServer((request, response) => {
		const fail = (status: number, error: string) => {
			if (response.headersSent) return void response.end();
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify({ error }));
		};
		const url = new URL(request.url ?? "/", "http://front");
		if (url.pathname !== MOUNT && !url.pathname.startsWith(`${MOUNT}/`)) return fail(404, "not found");
		const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
		const visitorId = request.headers["x-visitor-id"];
		const visitor =
			bearer === undefined && publicFront
				? {
						principal: `anon:${createHash("sha256").update(`visitor\0${typeof visitorId === "string" ? visitorId : request.socket.remoteAddress}`).digest("hex").slice(0, 24)}`,
						role: "viewer",
						kind: "anonymous",
					}
				: undefined;
		const who: { principal: string; role: string; kind?: string } | undefined = visitor ?? (bearer === undefined ? undefined : tokens[bearer]);
		if (!who) return fail(401, "unauthorized");
		if (refuseStreams && (request.headers.accept ?? "").includes("text/event-stream")) return fail(501, "event streams are not proxied");
		let path = url.pathname.slice(MOUNT.length) || "/";
		const minted: Record<string, string> = { "x-internal-service": secret, "x-user-id": who.principal, "x-sophia-caller-role": who.role };
		if (who.kind) minted["x-sophia-caller-kind"] = who.kind;
		if (path === "/g" || path.startsWith("/g/")) {
			const [, , graph = "", ...rest] = path.split("/");
			if (!GRAPH_SEGMENT.test(graph)) return fail(400, "a /g/ path must name a graph");
			path = `/${rest.join("/")}`;
			Object.assign(minted, { "x-graph-id": graph, "x-graph-owner": "user:owner", "x-sophia-graph-role": who.role });
			if (delegation) {
				// gardend's shape (`sophia-dlg-` and 64 hex digits), one per caller and graph.
				minted["x-sophia-delegated-token"] = `sophia-dlg-${createHash("sha256").update(`${who.principal}\0${graph}\0${secret}`).digest("hex")}`;
			}
		}
		const headers: IncomingHttpHeaders = {};
		for (const [name, value] of Object.entries(request.headers)) {
			if (!DROPPED.some((pattern) => pattern.test(name))) headers[name] = value;
		}
		const upstream = httpRequest(
			{ host: bind, port: hostPort, method: request.method, path: `${path}${url.search}`, headers: { ...headers, ...minted } },
			(answer) => {
				response.writeHead(answer.statusCode ?? 502, answer.headers);
				response.flushHeaders();
				answer.pipe(response);
				if (cutStreamsMs > 0 && String(answer.headers["content-type"] ?? "").startsWith("text/event-stream")) {
					setTimeout(() => response.socket?.destroy(), cutStreamsMs).unref();
				}
			},
		);
		let callerGone = false;
		upstream.on("error", (error) => {
			if (callerGone) return;
			console.error("[faux front]", error.message);
			fail(502, "the service did not answer");
		});
		// The caller went away (a watch closed): end the upstream request too.
		response.on("close", () => {
			if (response.writableFinished) return;
			callerGone = true;
			upstream.destroy();
		});
		request.pipe(upstream);
	});
	return new Promise((resolve) => front.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(front.address() as AddressInfo).port}`)));
}

const frontTokens = env("VEHICLE_FAUX_FRONT_TOKENS");
const frontUrl = frontTokens ? await startFront(JSON.parse(frontTokens) as Record<string, { principal: string; role: string }>) : null;
process.stdout.write(`${JSON.stringify({ host: hostUrl, front: frontUrl })}\n`);

let stopping = false;
const stop = () => {
	if (stopping) return;
	stopping = true;
	server.closeAllConnections();
	server.close();
	host.close();
	if (ownDataDir) rmSync(dataDir, { recursive: true, force: true });
	setTimeout(() => process.exit(0), 100).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
// Run by a test (not by gardend, which supervises us itself): a test that dies without stopping us must not
// leave us running, so stdin closing is our cue.
if (process.env.GARDEN_SERVICE_ID === undefined) {
	process.stdin.on("end", stop);
	process.stdin.on("error", stop);
	process.stdin.resume();
}
