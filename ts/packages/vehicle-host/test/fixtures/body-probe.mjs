#!/usr/bin/env node
/**
 * An escape-style body: started by the host in place of pi, in the same box, with the same pipe and environment.
 * It takes everything a body is handed (fd 3, the environment, Linux's /proc/self/environ) and, when the bootstrap
 * names a model proxy, tries the proxy from inside the box the way a hostile shell could: a model call, other
 * paths, another model, another session's path, no token. It writes what it saw to `probe.json` in its working
 * folder and exits. A test (`key-out-of-box.test.ts`) reads that file on the host.
 */

import { readFileSync, writeFileSync } from "node:fs";

let pipe = "";
try {
	pipe = readFileSync(3, "utf8");
} catch (error) {
	pipe = `(fd 3 unreadable: ${error})`;
}
let procEnviron = "";
try {
	procEnviron = readFileSync("/proc/self/environ", "utf8");
} catch {}

let boot;
try {
	boot = JSON.parse(pipe);
} catch {}

async function attempt(label, url, init) {
	try {
		const response = await fetch(url, init);
		return { label, status: response.status, text: (await response.text()).slice(0, 4096) };
	} catch (error) {
		return { label, status: 0, text: String(error) };
	}
}

const tries = [];
const proxy = boot?.modelProxy;
if (proxy?.baseUrl && proxy?.token) {
	const auth = { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" };
	const call = (model) => JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hello from inside the box" }] });
	const origin = new URL(proxy.baseUrl).origin;
	tries.push(await attempt("model call", `${proxy.baseUrl}/chat/completions`, { method: "POST", headers: auth, body: call(boot.model.id) }));
	tries.push(await attempt("model list", `${proxy.baseUrl}/models`, { headers: auth }));
	tries.push(await attempt("another endpoint", `${proxy.baseUrl}/embeddings`, { method: "POST", headers: auth, body: call(boot.model.id) }));
	tries.push(await attempt("another model", `${proxy.baseUrl}/chat/completions`, { method: "POST", headers: auth, body: call("openai/gpt-6-luna-pro") }));
	tries.push(await attempt("another session", `${origin}/s/another-session/chat/completions`, { method: "POST", headers: auth, body: call(boot.model.id) }));
	tries.push(await attempt("the provider's own path", `${origin}/api/v1/chat/completions`, { method: "POST", headers: auth, body: call(boot.model.id) }));
	tries.push(await attempt("no token", `${proxy.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: call(boot.model.id) }));
}

writeFileSync("probe.json", JSON.stringify({ pipe, env: process.env, procEnviron, tries }, null, 1));
process.exit(0);
