/**
 * The ride protocol v2: Vehicle's v1 verbs, unchanged in meaning, over HTTP (and JSONL later). The spec
 * is `protocol/ride-v2.md`; the JSON schemas are in `protocol/schemas/`.
 */

import { createHash } from "node:crypto";
import { isSophiaRole, type SophiaRole } from "@sophia-labs/pi-sophia";

export const RIDE_PROTOCOL = "sophia.vehicle-ride.v2";
export const CAPSULE_SCHEMA = "sophia.vehicle-session-capsule.v2";
export const MAX_ID_BYTES = 256;
export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_WAIT_MS = 30_000;
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_WATCH_EVENTS = 500;
export const DEFAULT_LEASE_TTL_MS = 30 * 60_000;
export const MAX_LEASE_TTL_MS = 24 * 60 * 60_000;
export const MAX_CHIME_CHARS = 16_000;
export const MAX_AUTHOR_CHARS = 64;

/**
 * The headers gardend mints on every request it proxies to a supervised service (garden
 * `docs/local-service-hosting.md`, "Loopback API"), believed only together with the per-spawn secret
 * gardend hands this process as `MNEMOSYNE_INTERNAL_SERVICE_SECRET`. gardend drops any copy a caller sent
 * (`x-internal-*`, `x-user-*`, `x-graph-*`, `x-sophia-*`), so these are gardend's word, not the caller's.
 *
 * - `x-internal-service`: the per-spawn secret;
 * - `x-user-id`: who calls (`owner` for the master key, `token:<id>`, an Access email, `service:<id>`);
 * - `x-sophia-caller-role`: `owner`, `editor` or `viewer`, from the caller's grant;
 * - `x-graph-id`, `x-sophia-graph-role`: the graph a graph-scoped path (`/services/vehicle/g/<graph>/...`)
 *   names, and the caller's role on it. The graph comes only from here, never from a request body.
 * - `x-sophia-delegated-token`: with the graph, a token for gardend's `/mcp` that acts for this caller on
 *   this graph, with this role, for an hour (the manifest's `"delegateCaller": true`). A session's MCP client
 *   uses its owner's newest one. It is a credential: kept in memory only, never in a file, event, capsule
 *   or log, and never part of `Caller`.
 *
 * `x-vehicle-client-id` is the caller's own: one client instance (a chat tab, a terminal, an agent), the
 * unit that holds the driver lease. It carries no authority: the lease also binds the principal.
 */
export const HEADERS = {
	secret: "x-internal-service",
	principal: "x-user-id",
	callerRole: "x-sophia-caller-role",
	graphId: "x-graph-id",
	graphRole: "x-sophia-graph-role",
	delegatedToken: "x-sophia-delegated-token",
	clientId: "x-vehicle-client-id",
	/** Public mode: `anonymous` (a visitor, `anon:<hash>`) or `account` (a Sophia account, `cognito:<sub>`). */
	callerKind: "x-sophia-caller-kind",
	accountEmail: "x-sophia-account-email",
	accountEmailVerified: "x-sophia-account-email-verified",
	/**
	 * The caller's own model key (an OpenRouter key), which gardend forwards only to a service whose manifest says
	 * `"acceptsModelKey": true`. A credential: memory only, never in a file, event, capsule, mirror or log, and
	 * never part of `Caller`.
	 */
	modelKey: "x-model-key",
	/** Public mode: every public graph, a comma list; a public caller's delegation reads them all. */
	publicGraphs: "x-sophia-public-graphs",
} as const;

/** A model key as a caller may send it: one printable token. */
const MODEL_KEY = /^[\x21-\x7e]{8,512}$/;

/** gardend's delegation tokens: `sophia-dlg-` and 64 hex digits. Anything else is not one. */
const DELEGATED_TOKEN = /^sophia-dlg-[0-9a-f]{64}$/;

const GRAPH_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

export const COMMAND_OPS = [
	"prompt",
	"follow_up",
	"steer",
	"abort",
	"cancel",
	"shutdown",
	"fork",
	"clone",
	"set_room_policy",
	"accept_chime",
	"reject_chime",
] as const;
export type CommandOp = (typeof COMMAND_OPS)[number];
export const TEXT_OPS: ReadonlySet<CommandOp> = new Set(["prompt", "follow_up", "steer"]);

export const ROOM_POLICIES = ["observe", "suggest", "co-drive", "mute"] as const;
export type RoomPolicy = (typeof ROOM_POLICIES)[number];
export type ChimeDelivery = "prompt" | "follow_up" | "steer";

/** Who is calling, as gardend minted it. */
export interface Caller {
	readonly principal: string;
	readonly role: SophiaRole;
	/** One client instance (a chat tab, a terminal, an agent): the unit that holds the driver lease. */
	readonly clientId: string;
	/** The graph gardend bound this request to (a graph-scoped path), if any. */
	readonly graphId?: string;
	/** A public-mode caller (`public.ts`): an anonymous visitor or a Sophia account; absent for everyone else. */
	readonly kind?: "anonymous" | "account";
	/** A Sophia account's email, and whether its ID token says it is verified. */
	readonly email?: string;
	readonly emailVerified?: boolean;
	/** Every public graph (gardend's `x-sophia-public-graphs`): a public caller's conversation reads them all. */
	readonly publicGraphs?: readonly string[];
}

export class RideError extends Error {
	readonly code: string;
	readonly status: number;
	readonly details: Record<string, unknown> | undefined;
	constructor(code: string, status: number, message: string, details?: Record<string, unknown>) {
		super(message);
		this.code = code;
		this.status = status;
		this.details = details;
	}
}

export function frame(type: string, value: unknown, requestId?: string): Record<string, unknown> {
	return { protocol: RIDE_PROTOCOL, type, ...(requestId === undefined ? {} : { requestId }), value };
}

export function errorFrame(error: RideError, requestId?: string): Record<string, unknown> {
	return {
		protocol: RIDE_PROTOCOL,
		type: "error",
		...(requestId === undefined ? {} : { requestId }),
		code: error.code,
		message: error.message,
		...(error.details ? { details: error.details } : {}),
	};
}

export function requireId(label: string, value: unknown): string {
	if (
		typeof value !== "string" ||
		value.trim() === "" ||
		Buffer.byteLength(value) > MAX_ID_BYTES ||
		/[\u0000\r\n]/.test(value)
	) {
		throw new RideError("invalid_request", 400, `${label} must be a bounded, non-empty single-line identifier`);
	}
	return value;
}

export function requireText(value: unknown, label = "text", maxBytes = MAX_TEXT_BYTES): string {
	if (typeof value !== "string" || value.trim() === "" || Buffer.byteLength(value) > maxBytes || value.includes("\0")) {
		throw new RideError("invalid_request", 400, `${label} must be non-empty, NUL-free, and at most ${maxBytes} bytes`);
	}
	return value;
}

export function optionalRefs(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value) || value.length > 100 || value.some((ref) => typeof ref !== "string" || ref === "")) {
		throw new RideError("invalid_request", 400, "contextRefs must be an array of at most 100 non-empty strings");
	}
	return value as string[];
}

export function parseCaller(headers: Record<string, string | string[] | undefined>): Caller {
	const one = (name: string) => {
		const value = headers[name];
		if (Array.isArray(value)) throw new RideError("invalid_identity", 400, `${name} must be sent once`);
		return value;
	};
	const principal = one(HEADERS.principal);
	const graphId = one(HEADERS.graphId);
	// With a graph, the role on it; without, the caller's role from its grant. gardend mints both the same way.
	const role = graphId ? one(HEADERS.graphRole) : one(HEADERS.callerRole);
	const clientId = one(HEADERS.clientId);
	if (!principal) throw new RideError("identity_required", 401, `${HEADERS.principal} is required`);
	if (!isSophiaRole(role)) {
		throw new RideError("invalid_identity", 400, `${graphId ? HEADERS.graphRole : HEADERS.callerRole} must be owner, editor, contributor or viewer`);
	}
	if (graphId !== undefined && !GRAPH_ID.test(graphId)) throw new RideError("invalid_identity", 400, `${HEADERS.graphId} is not a graph id`);
	const kind = one(HEADERS.callerKind);
	if (kind !== undefined && kind !== "anonymous" && kind !== "account") throw new RideError("invalid_identity", 400, `${HEADERS.callerKind} must be anonymous or account`);
	// A public caller reads, whatever else the request says: gardend mints it a viewer, or (a signed-in account on the
	// graph with its visitors' folder) a contributor, whose writes gardend fences to that folder.
	if (kind && role !== "viewer" && role !== "contributor") throw new RideError("invalid_identity", 400, "a public caller is a viewer or a contributor");
	if (role === "contributor" && kind !== "account") throw new RideError("invalid_identity", 400, "only a signed-in account is a contributor");
	if (kind === "anonymous" && !principal.startsWith("anon:")) throw new RideError("invalid_identity", 400, "an anonymous caller is anon:<id>");
	if (kind === "account" && !principal.startsWith("cognito:")) throw new RideError("invalid_identity", 400, "an account is cognito:<sub>");
	const email = kind === "account" ? one(HEADERS.accountEmail) : undefined;
	const publicGraphs = kind
		? (one(HEADERS.publicGraphs) ?? "")
				.split(",")
				.map((graph) => graph.trim())
				.filter((graph) => GRAPH_ID.test(graph))
				.slice(0, 64)
		: [];
	return {
		principal: requireId("principal", principal),
		role,
		clientId: requireId("clientId", clientId ?? principal),
		...(graphId ? { graphId } : {}),
		...(kind ? { kind } : {}),
		...(email ? { email: email.slice(0, 254) } : {}),
		...(kind === "account" ? { emailVerified: one(HEADERS.accountEmailVerified) === "true" } : {}),
		...(publicGraphs.length > 0 ? { publicGraphs } : {}),
	};
}

/** The caller's own model key (believed only after the secret check, like the identity headers), or `undefined`. */
export function modelKeyOf(headers: Record<string, string | string[] | undefined>): string | undefined {
	const value = headers[HEADERS.modelKey];
	if (typeof value !== "string") return undefined;
	const key = value.trim();
	if (!MODEL_KEY.test(key)) throw new RideError("invalid_model_key", 400, `${HEADERS.modelKey} must be one printable token of 8 to 512 characters`);
	return key;
}

/**
 * The delegation token gardend handed with a request (believed only after the secret check, like the identity
 * headers), or `undefined`. Only on a graph-bound request: the token is bound to that graph.
 */
export function delegatedTokenOf(headers: Record<string, string | string[] | undefined>, caller: Caller): string | undefined {
	const value = headers[HEADERS.delegatedToken];
	if (typeof value !== "string" || caller.graphId === undefined) return undefined;
	return DELEGATED_TOKEN.test(value) ? value : undefined;
}

/** A stable digest of a request body: the idempotency check compares it for a repeated requestId. */
export function digestOf(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, inner]) => inner !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stableJson(inner)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

/** Text cut to at most `maxBytes` UTF-8 bytes, marked when cut. */
export function bounded(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	let cut = text.slice(0, maxBytes);
	while (Buffer.byteLength(cut) > maxBytes - 3) cut = cut.slice(0, -1);
	return `${cut}...`;
}
