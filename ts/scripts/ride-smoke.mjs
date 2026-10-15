#!/usr/bin/env node
/**
 * One real chat turn over the ride protocol v2, for proving a packaged service. Two ways in:
 *
 *   node ride-smoke.mjs --service <dir>
 *       Start <dir>/service.json's command the way gardend starts a service (its own secret, port and data dir,
 *       loopback bind, no GARDEN_* variables) with pi's faux provider (VEHICLE_TEST_FAUX=1, so no model and no
 *       key), mint the identity headers as gardend mints them, and drive one turn. No graph tools (no gardend).
 *
 *   GARDEN_KEY=<key> node ride-smoke.mjs --gardend <http://127.0.0.1:port> --graph <id> [--model provider/model]
 *       Through a running gardend's proxy (`/services/vehicle/g/<graph>/...`), with the self-host key from the
 *       environment (never an argument, never printed).
 *
 * Common: [--question <text>] [--timeout-ms <n>] [--out <file.json>]. Prints a JSON summary: every ride call's
 * status, the events of the turn (types, tool names, the reply text) and what the run cost. Exit 0 when the run
 * settled with a reply.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => {
	const at = argv.indexOf(name);
	return at >= 0 ? argv[at + 1] : undefined;
};
const serviceDir = flag("--service");
const gardend = flag("--gardend");
const graph = flag("--graph") ?? "smoke-graph";
const question = flag("--question") ?? "Which documents are in this workspace? Answer in one sentence.";
const model = flag("--model");
const timeoutMs = Number(flag("--timeout-ms") ?? 120_000);
const out = flag("--out");
if (!serviceDir === !gardend) {
	console.error("usage: ride-smoke.mjs --service <dir> | --gardend <url> --graph <id>  (see the header)");
	process.exit(2);
}

const clientId = `ride-smoke-${randomUUID().slice(0, 8)}`;
const calls = [];
let child;
let dataDir;
let base;
let headers;

async function freePort() {
	return await new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolvePort(port));
		});
	});
}

async function startService(dir) {
	const manifest = JSON.parse(readFileSync(join(dir, "service.json"), "utf8"));
	const port = await freePort();
	const secret = randomUUID().replaceAll("-", "");
	dataDir = mkdtempSync(join(tmpdir(), "ride-smoke-"));
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GARDEN_")));
	for (const { name, value } of manifest.env ?? []) env[name] = value;
	Object.assign(env, {
		VEHICLE_TEST_FAUX: "1",
		PORT: String(port),
		DATA_DIR: dataDir,
		GARDEN_SERVICE_HOST: "127.0.0.1",
		MNEMOSYNE_INTERNAL_SERVICE_SECRET: secret,
		GARDEN_SERVICE_ID: manifest.serviceId,
	});
	child = spawn(manifest.command, manifest.args ?? [], { cwd: resolve(dir, manifest.workingDir ?? "."), env, stdio: ["ignore", "pipe", "pipe"] });
	const log = [];
	child.stdout.on("data", (chunk) => log.push(String(chunk)));
	child.stderr.on("data", (chunk) => log.push(String(chunk)));
	base = `http://127.0.0.1:${port}`;
	headers = {
		"x-internal-service": secret,
		"x-user-id": "owner",
		"x-sophia-caller-role": "owner",
		"x-graph-id": graph,
		"x-sophia-graph-role": "owner",
	};
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`the service exited (${child.exitCode}): ${log.join("").trim()}`);
		try {
			const response = await fetch(`${base}${manifest.healthPath ?? "/health"}`);
			if (response.ok) return { log };
		} catch {}
		await new Promise((done) => setTimeout(done, 100));
	}
	throw new Error(`the service did not answer its health check: ${log.join("").trim()}`);
}

async function ride(method, path, body) {
	const response = await fetch(`${base}${path}`, {
		method,
		headers: { ...headers, "x-vehicle-client-id": clientId, ...(body ? { "content-type": "application/json" } : {}) },
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const text = await response.text();
	let frame;
	try {
		frame = JSON.parse(text);
	} catch {
		frame = { raw: text.slice(0, 400) };
	}
	calls.push({ method, path: path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>"), status: response.status, type: frame.type, code: frame.code });
	if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${JSON.stringify(frame).slice(0, 400)}`);
	return frame;
}

let serviceLog;
const summary = { mode: serviceDir ? "service" : "gardend", graph, question, clientId };
try {
	if (serviceDir) {
		serviceLog = (await startService(serviceDir)).log;
		summary.service = serviceDir;
	} else {
		const key = process.env.GARDEN_KEY?.trim();
		if (!key) throw new Error("GARDEN_KEY is not set");
		base = `${gardend.replace(/\/$/, "")}/services/vehicle/g/${encodeURIComponent(graph)}`;
		headers = { authorization: `Bearer ${key}` };
	}
	const created = await ride("POST", "/sessions", { requestId: `create-${clientId}`, ...(model ? { model } : {}), title: "ride smoke" });
	const session = created.value.session;
	summary.session = { model: session.model, role: session.role, graphId: session.graphId, profile: session.profile };
	const sessionId = session.sessionId;
	const accepted = await ride("POST", `/sessions/${sessionId}/commands`, { requestId: `prompt-${clientId}`, op: "prompt", text: question });
	summary.prompt = { type: accepted.type, status: accepted.value?.status ?? accepted.value?.command?.status };
	const events = [];
	let since = 0;
	let settled;
	const deadline = Date.now() + timeoutMs;
	while (!settled && Date.now() < deadline) {
		const frame = await ride("GET", `/sessions/${sessionId}/events?since=${since}&waitMs=10000`);
		for (const event of frame.value.events) {
			events.push(event);
			since = event.seq;
			if (event.type === "run.settled") settled = event;
		}
	}
	const replies = events.filter((event) => event.type === "message.completed" && event.payload?.role === "assistant");
	summary.events = events.map((event) => event.type);
	summary.tools = events
		.filter((event) => event.type === "tool.started" || event.type === "tool.result")
		.map((event) => ({ type: event.type, tool: event.payload?.toolName, isError: event.payload?.isError, chars: event.payload?.text?.length }));
	summary.reply = replies.map((event) => event.payload.text).filter(Boolean).join("\n").trim();
	summary.settled = settled ? { aborted: settled.payload?.aborted, stopReason: settled.payload?.stopReason, usage: settled.payload?.usage, costUsd: settled.payload?.costUsd ?? settled.payload?.cost } : null;
	const snapshot = await ride("GET", `/sessions/${sessionId}`);
	summary.stats = snapshot.value?.stats;
	summary.ok = Boolean(settled && !settled.payload?.aborted && summary.reply);
} catch (error) {
	summary.ok = false;
	summary.error = error instanceof Error ? error.message : String(error);
} finally {
	summary.calls = calls;
	if (child) {
		child.kill("SIGTERM");
		await new Promise((done) => child.once("exit", done));
		summary.serviceLog = serviceLog?.join("").trim().split("\n").slice(-12);
		rmSync(dataDir, { recursive: true, force: true });
	}
}
const text = `${JSON.stringify(summary, null, 2)}\n`;
if (out) writeFileSync(out, text);
process.stdout.write(text);
process.exit(summary.ok ? 0 : 1);
