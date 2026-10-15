/**
 * A real gardend for the tests that need one: the binary named by `VEHICLE_TEST_GARDEND_BIN` (built with
 * delegation tokens, garden `src-tauri/build-gardend-headless.sh`), `gardend serve` on a free loopback port with
 * a throwaway profile, and `test/fixtures/echo-service.mjs` supervised as its service `vehicle` (with
 * `"delegateCaller": true`), which answers with what gardend minted for it. Nothing here prints a key or a token.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const GARDEND_BIN = process.env.VEHICLE_TEST_GARDEND_BIN;
const ECHO = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "echo-service.mjs");

export interface Gardend {
	readonly url: string;
	readonly profile: string;
	/** The profile's master key (the self-host key): the owner. */
	readonly key: string;
	fetchJson(path: string, init?: { method?: string; token?: string; body?: unknown }): Promise<{ status: number; body: any }>;
	mcp(token: string, method: string, params?: unknown): Promise<{ status: number; body: any }>;
	tool(token: string, name: string, args: Record<string, unknown>): Promise<any>;
	/** What gardend hands the `vehicle` service for this caller on this graph (`x-sophia-delegated-token`). */
	delegation(token: string, graphId: string): Promise<{ userId: string; graphRole: string; token: string }>;
	/** `gardend token create --grant <grant>`: the secret and the id. */
	clientToken(grant: string): { token: string; id: string };
	/** A read-only client token with `extra` scopes added (the store holds custom scopes; the CLI mints grants). */
	readOnlyTokenWith(extra: readonly string[]): { token: string; id: string };
	/** The audit log's rows (`loopback-audit.jsonl`). */
	audit(): Record<string, any>[];
	stop(): Promise<void>;
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});
}

export async function startGardend(bin: string): Promise<Gardend> {
	const root = mkdtempSync(join(tmpdir(), "vehicle-gardend-"));
	const profile = join(root, "profile");
	const services = join(root, "services");
	mkdirSync(join(services, "vehicle"), { recursive: true });
	writeFileSync(
		join(services, "vehicle", "service.json"),
		JSON.stringify({ serviceId: "vehicle", command: process.execPath, args: [ECHO], healthPath: "/health", memberAccess: "all", delegateCaller: true }),
	);
	const port = await freePort();
	const url = `http://127.0.0.1:${port}`;
	const env: NodeJS.ProcessEnv = { ...process.env, GARDEN_SERVICES_DIR: services };
	for (const name of Object.keys(env)) if (name.startsWith("GARDEN_") && name !== "GARDEN_SERVICES_DIR") delete env[name];
	// Its output carries the open link with the key: kept in memory, never printed.
	const child: ChildProcess = spawn(bin, ["serve", "--profile", profile, "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout?.on("data", (chunk) => (output += chunk));
	child.stderr?.on("data", (chunk) => (output += chunk));

	const stopChild = async () => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			await new Promise<void>((resolve) => child.once("exit", () => resolve()));
		}
	};
	const deadline = Date.now() + 60_000;
	let key = "";
	try {
		for (;;) {
			if (child.exitCode !== null) throw new Error(`gardend exited (${child.exitCode})`);
			try {
				key ||= (JSON.parse(readFileSync(join(profile, "selfhost-key.json"), "utf8")) as { key: string }).key;
				const status = (await (await fetch(`${url}/api/services/vehicle/status`, { headers: { authorization: `Bearer ${key}` } })).json()) as {
					state?: string;
					health?: { ok?: boolean };
				};
				if (status.state === "running" && status.health?.ok) break;
			} catch {
				// not up yet
			}
			if (Date.now() > deadline) throw new Error(`gardend did not start its vehicle service: ${output.replace(/sophia-key-[0-9a-f]+/g, "<key>").slice(-2000)}`);
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	} catch (error) {
		await stopChild();
		rmSync(root, { recursive: true, force: true });
		throw error;
	}

	const fetchJson: Gardend["fetchJson"] = async (path, init = {}) => {
		const response = await fetch(`${url}${path}`, {
			method: init.method ?? (init.body === undefined ? "GET" : "POST"),
			headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
		});
		const text = await response.text();
		let body: unknown = text;
		try {
			body = JSON.parse(text);
		} catch {
			// not JSON
		}
		return { status: response.status, body };
	};
	const mcp: Gardend["mcp"] = (token, method, params = {}) => fetchJson("/mcp", { token, body: { jsonrpc: "2.0", id: 1, method, params } });
	const cli = (args: string[]) => execFileSync(bin, args, { env, encoding: "utf8" });
	const clientToken: Gardend["clientToken"] = (grant) => {
		const created = JSON.parse(cli(["token", "create", "--label", `test ${grant}`, "--grant", grant, "--profile-dir", profile, "--json"]));
		return { token: created.token as string, id: created.record.tokenId as string };
	};
	return {
		url,
		profile,
		key,
		fetchJson,
		mcp,
		tool: async (token, name, args) => (await mcp(token, "tools/call", { name, arguments: args })).body,
		delegation: async (token, graphId) => {
			const { status, body } = await fetchJson(`/services/vehicle/g/${graphId}/whoami`, { token });
			if (status !== 200 || !body.secretOk || typeof body.delegatedToken !== "string") throw new Error(`no delegation (${status})`);
			return { userId: body.userId, graphRole: body.graphRole, token: body.delegatedToken };
		},
		clientToken,
		readOnlyTokenWith: (extra) => {
			const minted = clientToken("read-only");
			const path = join(profile, "loopback-client-tokens.json");
			const store = JSON.parse(readFileSync(path, "utf8")) as { tokens: { tokenId: string; scopes: string[]; grantProfileId: string | null }[] };
			const record = store.tokens.find((candidate) => candidate.tokenId === minted.id);
			if (!record) throw new Error("the minted token is not in the store");
			record.scopes = [...record.scopes, ...extra];
			record.grantProfileId = null;
			writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
			return minted;
		},
		audit: () =>
			readFileSync(join(profile, "loopback-audit.jsonl"), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, any>),
		stop: async () => {
			await stopChild();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
