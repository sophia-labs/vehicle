#!/usr/bin/env node
/**
 * `vehicle-host`: serve the ride protocol v2 on loopback, as the local service gardend supervises at
 * `/services/vehicle` (garden `docs/local-service-hosting.md`).
 *
 * What gardend gives every service it starts (and nothing else may set):
 *   MNEMOSYNE_INTERNAL_SERVICE_SECRET   required, at least 16 bytes: the per-spawn secret gardend sends as
 *                                       `x-internal-service`; identity headers are believed only with it
 *   PORT                                the private loopback port (default 7692 when run by hand)
 *   DATA_DIR                            this service's data dir: sessions, logs and pi's files
 *   GARDEN_SERVICE_HOST                 the bind address, loopback only (default 127.0.0.1)
 *   MNEMOSYNE_MCP_URL                   gardend's own loopback `/mcp`, never a public URL
 *   MNEMOSYNE_MCP_ACCESS_TOKEN          the process's own member token: not used. Every session acts for its
 *                                       person with the delegation token gardend hands with that person's
 *                                       requests (`"delegateCaller": true` in service.json), so the host drops
 *                                       it from its environment at start and nothing here can act as itself.
 *
 * The person's settings (`gardend chat key set`, `gardend service env set ... --service vehicle`):
 *   OPENROUTER_API_KEY (or another pi provider key)   read by pi itself
 *   VEHICLE_DEFAULT_MODEL    default openrouter/openai/gpt-6-luna
 *   VEHICLE_BODY_IDLE_MS     default 600000
 *   VEHICLE_MAX_TURNS, VEHICLE_MAX_COST_USD   the default budget per run
 *   VEHICLE_ISOLATION        the box `agent` sessions run in: bwrap (Linux, WSL2), seatbelt (macOS), none, or
 *                            microvm (not implemented yet: agent sessions are refused). Default: the platform's
 *                            (bwrap on Linux, seatbelt on macOS). Chat sessions run in this process whatever it is.
 *   VEHICLE_AGENT_UNISOLATED=1   with VEHICLE_ISOLATION=none only: run agent sessions unisolated, on purpose
 *   VEHICLE_MIRROR           on (default) or off: each conversation's record as a document in its graph, under
 *                            _sophia/Conversations, written for the person after each settled run (mirror.ts)
 *
 * Public sessions (a gardend in public mode: visitors and Sophia accounts, `public.ts`):
 *   VEHICLE_PUBLIC_DEFAULT_MODEL       a visitor's own key, no model named (default openrouter/openai/gpt-6-luna)
 *   VEHICLE_PUBLIC_PROVIDER            the provider a visitor's own key is for (default openrouter)
 *   VEHICLE_CREDIT_DEFAULT_MODEL       an account's credit, no model named (default openrouter/deepseek/deepseek-v4.1-flash)
 *   VEHICLE_CREDIT_MODELS              the models credit pays for (a comma list)
 *   VEHICLE_SIGNUP_GRANT_USD           credit a verified account gets once (default 0.50)
 *   VEHICLE_CREDIT_DAILY_CAP_USD       credit-funded spend per UTC day, everyone together (default 5)
 *   VEHICLE_PUBLIC_TURNS_PER_DAY       turns per visitor or account per UTC day (default 100)
 *   VEHICLE_PUBLIC_SESSION_MAX_TURNS   turns per public conversation (default 40)
 *   VEHICLE_PUBLIC_RUN_MAX_TURNS, VEHICLE_PUBLIC_RUN_MAX_COST_USD   each public run's budget (default 8, 0.05)
 *
 * Run by hand (outside gardend), give it the same variables. Node 22.19 or later (pi's floor).
 */

import { mkdirSync } from "node:fs";
import { VehicleHost } from "./host.ts";
import { type IsolationSetting, isolationSetting } from "./isolation.ts";
import { mirrorSetting } from "./mirror.ts";
import { type PublicSettings, publicSettingsFromEnv } from "./public.ts";
import { createRideServer } from "./server.ts";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const NODE_FLOOR = [22, 19] as const;
const MCP_TOKEN_ENV = "MNEMOSYNE_MCP_ACCESS_TOKEN";

function fail(message: string): never {
	console.error(`vehicle-host: ${message}`);
	process.exit(2);
}

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) fail(`${name} is required (gardend sets it when it starts this service)`);
	return value;
}

function optionalNumber(name: string): number | undefined {
	const raw = process.env[name]?.trim();
	if (!raw) return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value)) fail(`${name} must be a number`);
	return value;
}

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < NODE_FLOOR[0] || (major === NODE_FLOOR[0] && minor < NODE_FLOOR[1])) {
	fail(`Node ${NODE_FLOOR.join(".")} or later is needed (this is ${process.versions.node}); put a newer node first on gardend's PATH`);
}

const secret = required("MNEMOSYNE_INTERNAL_SERVICE_SECRET");
if (Buffer.byteLength(secret) < 16) fail("MNEMOSYNE_INTERNAL_SERVICE_SECRET must be at least 16 bytes");
const dataDir = required("DATA_DIR");
const bind = process.env.GARDEN_SERVICE_HOST?.trim() || "127.0.0.1";
if (!LOOPBACK.has(bind)) fail("GARDEN_SERVICE_HOST must be a loopback address; gardend is the way in");
const port = optionalNumber("PORT") ?? 7692;
const mcpUrl = process.env.MNEMOSYNE_MCP_URL?.trim();
// Not used (see above): gone before anything else loads, so no body or child can reach the graph as the host.
delete process.env[MCP_TOKEN_ENV];
if (mcpUrl) {
	const parsed = new URL(mcpUrl);
	if (!LOOPBACK.has(parsed.hostname.replace(/^\[|\]$/g, ""))) fail("MNEMOSYNE_MCP_URL must be gardend's loopback address");
} else {
	console.warn("vehicle-host: no MNEMOSYNE_MCP_URL: sessions will have no graph tools");
}
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
process.env.PI_TELEMETRY ??= "0";
process.title = "vehicle-host";

let isolation: IsolationSetting;
try {
	isolation = isolationSetting();
} catch (error) {
	fail((error as Error).message);
}

const maxTurns = optionalNumber("VEHICLE_MAX_TURNS");
const maxCostUsd = optionalNumber("VEHICLE_MAX_COST_USD");
const bodyIdleMs = optionalNumber("VEHICLE_BODY_IDLE_MS");
let mirror: boolean;
try {
	mirror = mirrorSetting(process.env.VEHICLE_MIRROR);
} catch (error) {
	fail((error as Error).message);
}
let publicSettings: PublicSettings;
try {
	publicSettings = publicSettingsFromEnv();
} catch (error) {
	fail((error as Error).message);
}
const host = await VehicleHost.open({
	dataDir,
	defaultModel: process.env.VEHICLE_DEFAULT_MODEL?.trim() || "openrouter/openai/gpt-6-luna",
	...(mcpUrl ? { gardend: { url: mcpUrl } } : {}),
	...(bodyIdleMs === undefined ? {} : { bodyIdleMs }),
	mirror,
	public: publicSettings,
	defaultBudget: { ...(maxTurns === undefined ? {} : { maxTurns }), ...(maxCostUsd === undefined ? {} : { maxCostUsd }) },
	// `VEHICLE_TEST_FAUX=1` (a packaged service's test setting) makes agent bodies answer with pi's faux provider too.
	agentBodies: { isolation, ...(process.env.VEHICLE_TEST_FAUX === "1" ? { faux: true } : {}) },
});
const server = createRideServer(host, { secret });
server.listen(port, bind, () => {
	console.log(`vehicle-host: ride v2 on http://${bind}:${port} (${host.sessions.size} sessions revived; mirror ${mirror && mcpUrl ? "on" : "off"})`);
	// One real box, made now, so the operator learns at start whether agent sessions can run here.
	void host.agentStatus().then((status) =>
		console.log(
			status.refusal
				? `vehicle-host: agent sessions refused (isolation ${status.tier}, ${status.source}): ${status.refusal}`
				: `vehicle-host: agent sessions run in ${status.tier} boxes (${status.source})`,
		),
	);
});

let stopping = false;
const stop = (signal: string) => {
	if (stopping) return;
	stopping = true;
	console.log(`vehicle-host: ${signal}, stopping`);
	server.close();
	server.closeAllConnections();
	// A record being mirrored into the graph is let finish (briefly); the next settle would write it anyway.
	void host
		.mirrorsIdle(2_000)
		.then(() => host.close())
		.finally(() => process.exit(0));
	setTimeout(() => process.exit(0), 8_000).unref();
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
