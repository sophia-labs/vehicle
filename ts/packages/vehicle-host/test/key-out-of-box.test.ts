/**
 * The model key never enters an agent's box (V6's residual risk, closed by the host's model proxy,
 * `src/model-proxy.ts`). Real boxes (seatbelt on macOS, bubblewrap on Linux), real HTTP, the real pi client in the
 * body. The provider is a stand-in HTTP server on loopback that speaks OpenAI's streaming chat completions and
 * records what reached it, so no real key or model is used.
 *
 * Red-first: on the code before the proxy, the escape-style body below reads the key from its bootstrap pipe (seen
 * on macOS and Linux). The memory check is a guard, not a red check: on the build box (`ptrace_scope=0`) it read
 * pi's memory before the proxy too, and did not find the key there either.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type IsolationSetting, type IsolationTier, workspaceDir } from "../src/index.ts";
import { createSession, DRIVER, type Harness, startHost } from "./harness.ts";

const PLATFORM_TIER = (process.env.VEHICLE_TEST_TIER as IsolationTier | undefined) ?? (process.platform === "darwin" ? "seatbelt" : process.platform === "linux" ? "bwrap" : undefined);
const boxed = (tier: IsolationTier): IsolationSetting => ({ tier, source: "VEHICLE_ISOLATION", allowUnisolatedAgent: false });
/** The host's model key: unique, so any appearance of it in the box is this test's. */
const HOST_KEY = `host-key-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}-never-in-the-box`;
const MODEL = "openrouter/openai/gpt-6-luna";
const MODEL_ID = "openai/gpt-6-luna";
const PROBE = fileURLToPath(new URL("./fixtures/body-probe.mjs", import.meta.url));
const reverse = (text: string) => [...text].reverse().join("");

interface Seen {
	readonly path: string;
	readonly authorization?: string;
	readonly apiKey?: string;
	readonly model?: unknown;
	readonly stream?: unknown;
	readonly raw: string;
}

/** The provider's stand-in: OpenRouter's `/api/v1/chat/completions`, streamed as SSE in three pieces. */
async function startUpstream(): Promise<{ server: Server; url: string; seen: Seen[] }> {
	const seen: Seen[] = [];
	const server = createServer(async (req: IncomingMessage, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const raw = Buffer.concat(chunks).toString("utf8");
		let parsed: { model?: unknown; stream?: unknown } = {};
		try {
			parsed = JSON.parse(raw);
		} catch {}
		seen.push({
			path: req.url ?? "",
			...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
			...(typeof req.headers["x-api-key"] === "string" ? { apiKey: req.headers["x-api-key"] } : {}),
			model: parsed.model,
			stream: parsed.stream,
			raw,
		});
		if (req.method !== "POST" || req.url !== "/api/v1/chat/completions") {
			res.writeHead(404).end();
			return;
		}
		const chunk = (delta: Record<string, unknown>, finish: string | null, extra: Record<string, unknown> = {}) =>
			`data: ${JSON.stringify({ id: "gen-standin", object: "chat.completion.chunk", created: 0, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		res.write(chunk({ role: "assistant", content: "PROXIED-" }, null));
		await new Promise((resolve) => setTimeout(resolve, 30));
		res.write(chunk({ content: "HELLO" }, null));
		await new Promise((resolve) => setTimeout(resolve, 30));
		res.write(chunk({}, "stop", { usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
		res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** Point the host's OpenRouter at the stand-in and give it the key (the host's runtime only, never a body's). */
async function hostOnStandIn(harness: Harness, upstream: string): Promise<void> {
	harness.modelRuntime.registerProvider("openrouter", { baseUrl: `${upstream}/api/v1` });
	await harness.modelRuntime.setRuntimeApiKey("openrouter", HOST_KEY);
}

/** Every file under a folder, as text (the host's records, pi's files, the workspaces). */
function filesUnder(dir: string): { path: string; text: string }[] {
	const out: { path: string; text: string }[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		const stat = statSync(path, { throwIfNoEntry: false });
		if (!stat) continue;
		if (stat.isDirectory()) out.push(...filesUnder(path));
		else if (stat.isFile()) out.push({ path, text: readFileSync(path, "latin1") });
	}
	return out;
}

async function until<T>(what: string, probe: () => T | undefined, timeoutMs = 60_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function turn(harness: Harness, sessionId: string, text: string) {
	const mark = (await harness.events(sessionId, 0)).at(-1)?.seq ?? 0;
	const requestId = `p-${Math.random().toString(36).slice(2)}`;
	const sent = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId, op: "prompt", text });
	assert.equal(sent.status, 200, JSON.stringify(sent.body));
	await harness.waitFor(sessionId, (event) => event.seq > mark && /^command\.(completed|failed|aborted)$/.test(event.type) && event.payload.commandId === requestId, 60_000);
	await harness.waitFor(sessionId, (event) => event.seq > mark && event.type === "run.settled", 30_000);
	return harness.events(sessionId, mark);
}

describe(`the model key stays out of a ${PLATFORM_TIER ?? "(no)"} box`, { skip: PLATFORM_TIER ? false : "no box on this platform" }, () => {
	const tier = PLATFORM_TIER as IsolationTier;
	let upstream: Awaited<ReturnType<typeof startUpstream>>;
	const harnesses: Harness[] = [];

	before(async () => {
		upstream = await startUpstream();
	});
	after(async () => {
		for (const harness of harnesses) await harness.cleanup();
		await new Promise<void>((resolve) => upstream?.server.close(() => resolve()));
	});

	it("an escape-style body finds no key in its pipe or environment, and its token works only for its own model call", async () => {
		const harness = await startHost({ agentBodies: { isolation: boxed(tier), entry: PROBE, entryArgs: [], startTimeoutMs: 20_000 }, fauxKey: HOST_KEY });
		harnesses.push(harness);
		await hostOnStandIn(harness, upstream.url);
		const before = upstream.seen.length;
		const sessionId = await createSession(harness, { profile: "agent", model: MODEL });
		const sent = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "probe-1", op: "prompt", text: "probe" });
		assert.equal(sent.status, 200, JSON.stringify(sent.body));
		const file = join(workspaceDir(harness.dataDir, sessionId), "probe.json");
		const probe = await until("the probe's report", () => {
			if (!existsSync(file)) return undefined;
			try {
				return JSON.parse(readFileSync(file, "utf8")) as { pipe: string; env: Record<string, string>; procEnviron: string; tries: { label: string; status: number; text: string }[] };
			} catch {
				return undefined;
			}
		});
		// Red on the code before the proxy: the bootstrap pipe carried the key.
		assert.ok(!probe.pipe.includes(HOST_KEY), "the model key reached the body's bootstrap pipe");
		assert.ok(!JSON.stringify(probe.env).includes(HOST_KEY), "the model key is in the body's environment");
		assert.ok(!probe.procEnviron.includes(HOST_KEY), "the model key is in /proc/self/environ");
		const boot = JSON.parse(probe.pipe) as { modelProxy?: { baseUrl: string; token: string }; modelKey?: unknown };
		assert.equal(boot.modelKey, undefined);
		assert.match(boot.modelProxy?.token ?? "", /^vmp-[A-Za-z0-9_-]{43}$/);
		assert.equal(boot.modelProxy?.baseUrl, `${boot.modelProxy?.baseUrl.split("/s/")[0]}/s/${sessionId}`);
		assert.match(boot.modelProxy?.baseUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+\/s\//);

		// From inside the box: the proxy is reachable, forwards the one model call, and refuses everything else.
		const status = Object.fromEntries(probe.tries.map((attempt) => [attempt.label, attempt.status]));
		assert.deepEqual(status, {
			"model call": 200,
			"model list": 403,
			"another endpoint": 403,
			"another model": 403,
			"another session": 401,
			"the provider's own path": 404,
			"no token": 401,
		});
		assert.match(probe.tries[0]?.text ?? "", /PROXIED-/);
		for (const attempt of probe.tries) assert.ok(!attempt.text.includes(HOST_KEY) && !attempt.text.includes(boot.modelProxy?.token ?? "\0"), `${attempt.label} echoed a secret`);
		const reached = upstream.seen.slice(before);
		assert.equal(reached.length, 1, `only the model call reaches the provider: ${reached.map((seen) => seen.path).join(", ")}`);
		assert.equal(reached[0]?.path, "/api/v1/chat/completions");
		assert.equal(reached[0]?.authorization, `Bearer ${HOST_KEY}`);
		assert.equal(reached[0]?.model, MODEL_ID);
		assert.ok(!reached[0]?.raw.includes(boot.modelProxy?.token ?? "\0"));

		// The body is gone: its token is refused from now on.
		await harness.waitFor(sessionId, (event) => event.type === "command.failed", 30_000);
		const after = await fetch(`${boot.modelProxy?.baseUrl}/chat/completions`, {
			method: "POST",
			headers: { authorization: `Bearer ${boot.modelProxy?.token}`, "content-type": "application/json" },
			body: JSON.stringify({ model: MODEL_ID, messages: [] }),
		});
		assert.equal(after.status, 401);
		// The token is in none of the host's files: records, event log, pi's folder, workspaces (the probe's own
		// report aside, which the probe wrote).
		const leaks = filesUnder(harness.dataDir).filter((entry) => !entry.path.endsWith("probe.json") && (entry.text.includes(boot.modelProxy?.token ?? "\0") || entry.text.includes(HOST_KEY)));
		assert.deepEqual(
			leaks.map((entry) => entry.path),
			[],
		);
	});

	it("runs a turn end to end through the proxy: pi in the box streams the model's answer, the provider sees the host's key", async () => {
		const harness = await startHost({ agentBodies: { isolation: boxed(tier), faux: false } });
		harnesses.push(harness);
		await hostOnStandIn(harness, upstream.url);
		const before = upstream.seen.length;
		const sessionId = await createSession(harness, { profile: "agent", model: MODEL });
		const events = await turn(harness, sessionId, "say hello");
		const settled = events.find((event) => event.type === "run.settled");
		assert.equal(settled?.payload.aborted ?? false, false, JSON.stringify(events.slice(-6)));
		assert.match(JSON.stringify(events), /PROXIED-HELLO/);
		const reached = upstream.seen.slice(before);
		assert.equal(reached.length, 1);
		assert.equal(reached[0]?.path, "/api/v1/chat/completions");
		assert.equal(reached[0]?.authorization, `Bearer ${HOST_KEY}`);
		assert.equal(reached[0]?.model, MODEL_ID);
		assert.equal(reached[0]?.stream, true);
		assert.match(reached[0]?.raw ?? "", /say hello/);
		// Neither the key nor any proxy token is in the host's files.
		const leaks = filesUnder(harness.dataDir).filter((entry) => entry.text.includes(HOST_KEY) || /vmp-[A-Za-z0-9_-]{43}/.test(entry.text));
		assert.deepEqual(
			leaks.map((entry) => entry.path),
			[],
		);
	});

	it("a shell that reads pi's memory finds no key there (Linux, where /proc/<pid>/mem is readable)", { skip: process.platform === "linux" ? false : "no /proc on this platform" }, async (t) => {
		const harness = await startHost({ agentBodies: { isolation: boxed(tier) }, fauxKey: HOST_KEY });
		harnesses.push(harness);
		const sessionId = await createSession(harness, { profile: "agent" });
		// The key and the marker go into the command reversed, so the prompt itself never puts them in pi's memory.
		const scan = [
			'const fs=require("fs");const [pid,rk,rm]=process.argv.slice(1);',
			'const un=(s)=>Buffer.from([...s].reverse().join(""));const key=un(rk),marker=un(rm);',
			"let readable=false,foundKey=false,foundMarker=false,bytes=0,error=null,fd;",
			"try{fd=fs.openSync(`/proc/${pid}/mem`,\"r\");}catch(e){error=String(e.code||e);}",
			"if(fd!==undefined){for(const line of fs.readFileSync(`/proc/${pid}/maps`,\"utf8\").split(\"\\n\")){",
			"const m=/^([0-9a-f]+)-([0-9a-f]+) r/.exec(line);if(!m||/\\[(vvar|vsyscall|vdso)\\]/.test(line))continue;",
			"const start=parseInt(m[1],16),end=parseInt(m[2],16);if(end-start>(1<<30))continue;let carry=Buffer.alloc(0);",
			"for(let at=start;at<end;at+=8<<20){const len=Math.min(8<<20,end-at);const buf=Buffer.alloc(len);let n=0;",
			"try{n=fs.readSync(fd,buf,0,len,at);}catch{break;}if(n>0)readable=true;bytes+=n;",
			"const hay=Buffer.concat([carry,buf.subarray(0,n)]);if(hay.includes(key))foundKey=true;if(hay.includes(marker))foundMarker=true;",
			"carry=hay.subarray(Math.max(0,hay.length-256));}}}",
			'console.log("MEMSCAN "+JSON.stringify({readable,foundKey,foundMarker,bytes,error}));',
		].join("");
		const command = `node -e '${scan}' "$PPID" '${reverse(HOST_KEY)}' '${reverse(sessionId)}'`;
		const events = await turn(harness, sessionId, `[tool bash ${JSON.stringify({ command })}]`);
		const result = events.find((event) => event.type === "tool.result")?.payload as { text?: string } | undefined;
		const line = /MEMSCAN (\{.*\})/.exec(result?.text ?? "")?.[1];
		assert.ok(line, `no scan result: ${result?.text}`);
		const found = JSON.parse(line) as { readable: boolean; foundKey: boolean; foundMarker: boolean; bytes: number; error: string | null };
		const scope = existsSync("/proc/sys/kernel/yama/ptrace_scope") ? readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim() : "absent";
		t.diagnostic(`ptrace_scope ${scope}; scan ${JSON.stringify(found)}`);
		if (!found.readable) {
			t.diagnostic("pi's memory is not readable from the shell here (ptrace_scope or the kernel refuses): nothing to find");
			return;
		}
		assert.equal(found.foundMarker, true, "the scan must see pi's memory (its session id) to count");
		assert.equal(found.foundKey, false, "the model key is in pi's memory, within the shell's reach");
	});
});
