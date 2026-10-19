/**
 * The model proxy on its own (`src/model-proxy.ts`): real HTTP on loopback, with a stand-in provider that records
 * every request it gets and streams its answer in pieces held by the test, so streaming is seen, not assumed.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { type ModelGrant, ModelProxy, type ModelUpstream } from "../src/index.ts";
import { gate } from "./harness.ts";

const KEY = `proxy-test-key-${Math.random().toString(36).slice(2)}`;

describe("the model proxy", () => {
	let upstream: Server;
	let upstreamUrl: string;
	let proxy: ModelProxy;
	const seen: { path: string; authorization?: string; apiKey?: string }[] = [];
	let hold = gate();

	before(async () => {
		upstream = createServer(async (req, res) => {
			for await (const _ of req) {
				// drain
			}
			seen.push({
				path: req.url ?? "",
				...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
				...(typeof req.headers["x-api-key"] === "string" ? { apiKey: req.headers["x-api-key"] } : {}),
			});
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write("data: first\n\n");
			await hold.promise;
			res.end("data: second\n\ndata: [DONE]\n\n");
		});
		await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
		upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
		proxy = await ModelProxy.start();
	});
	after(async () => {
		hold.open();
		await proxy.close();
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
	});

	const source = (upstreamModel: ModelUpstream) => ({ upstream: () => upstreamModel, key: async () => KEY });
	const completions: ModelUpstream = { api: "openai-completions", baseUrl: "", id: "openai/gpt-6-luna" };
	const post = (url: string, token: string | undefined, model: string, header: "authorization" | "x-api-key" = "authorization") =>
		fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...(token ? (header === "authorization" ? { authorization: `Bearer ${token}` } : { "x-api-key": token }) : {}) },
			body: JSON.stringify({ model, stream: true, messages: [] }),
		});

	it("forwards a model call with the host's key in place of the token, and streams the answer as it comes", async () => {
		const a = proxy.grant("session-a", source({ ...completions, baseUrl: `${upstreamUrl}/api/v1` }));
		hold = gate();
		const before = seen.length;
		const response = await post(`${a.baseUrl}/chat/completions`, a.token, completions.id);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "text/event-stream");
		const reader = (response.body as ReadableStream<Uint8Array>).getReader();
		// The first piece arrives while the provider still holds the rest: nothing is buffered.
		const first = await reader.read();
		assert.match(new TextDecoder().decode(first.value), /data: first/);
		hold.open();
		let rest = "";
		for (let next = await reader.read(); !next.done; next = await reader.read()) rest += new TextDecoder().decode(next.value);
		assert.match(rest, /data: second/);
		assert.deepEqual(seen.slice(before), [{ path: "/api/v1/chat/completions", authorization: `Bearer ${KEY}` }]);
		a.revoke();
	});

	it("keeps the header pi used: a key sent as x-api-key (Anthropic's messages) goes on as x-api-key", async () => {
		const c = proxy.grant("session-c", source({ api: "anthropic-messages", baseUrl: `${upstreamUrl}/api`, id: "anthropic/claude-test" }));
		hold.open();
		const before = seen.length;
		const response = await post(`${c.baseUrl}/v1/messages`, c.token, "anthropic/claude-test", "x-api-key");
		assert.equal(response.status, 200);
		await response.text();
		assert.deepEqual(seen.slice(before), [{ path: "/api/v1/messages", apiKey: KEY }]);
		c.revoke();
	});

	it("refuses every other path, method, model, session and token, and none of them reaches the provider", async () => {
		const a = proxy.grant("session-a", source({ ...completions, baseUrl: `${upstreamUrl}/api/v1` }));
		const b = proxy.grant("session-b", source({ ...completions, baseUrl: `${upstreamUrl}/api/v1` }));
		const before = seen.length;
		const cases: { label: string; response: Promise<Response>; status: number }[] = [
			{ label: "a model list", response: fetch(`${a.baseUrl}/models`, { headers: { authorization: `Bearer ${a.token}` } }), status: 403 },
			{ label: "a GET of the model route", response: fetch(`${a.baseUrl}/chat/completions`, { headers: { authorization: `Bearer ${a.token}` } }), status: 403 },
			{ label: "another endpoint", response: post(`${a.baseUrl}/embeddings`, a.token, completions.id), status: 403 },
			{ label: "a query string", response: post(`${a.baseUrl}/chat/completions?x=1`, a.token, completions.id), status: 403 },
			{ label: "another model", response: post(`${a.baseUrl}/chat/completions`, a.token, "openai/gpt-6-luna-pro"), status: 403 },
			{ label: "session b's token on session a", response: post(`${a.baseUrl}/chat/completions`, b.token, completions.id), status: 401 },
			{ label: "session a's token on session b", response: post(`${b.baseUrl}/chat/completions`, a.token, completions.id), status: 401 },
			{ label: "no token", response: post(`${a.baseUrl}/chat/completions`, undefined, completions.id), status: 401 },
			{ label: "a made-up token", response: post(`${a.baseUrl}/chat/completions`, "vmp-guess", completions.id), status: 401 },
			{ label: "an unknown session", response: post(`${proxy.origin}/s/nobody/chat/completions`, a.token, completions.id), status: 401 },
			{ label: "the provider's own path", response: post(`${proxy.origin}/api/v1/chat/completions`, a.token, completions.id), status: 404 },
		];
		for (const entry of cases) {
			const response = await entry.response;
			const text = await response.text();
			assert.equal(response.status, entry.status, `${entry.label}: ${text}`);
			assert.ok(!text.includes(a.token) && !text.includes(b.token) && !text.includes(KEY), `${entry.label} echoed a secret`);
		}
		assert.equal(seen.length, before, "a refused request reached the provider");
		a.revoke();
		b.revoke();
	});

	it("ends a token with its body: a revoked grant and a replaced one are refused", async () => {
		hold.open();
		const first: ModelGrant = proxy.grant("session-d", source({ ...completions, baseUrl: `${upstreamUrl}/api/v1` }));
		const second = proxy.grant("session-d", source({ ...completions, baseUrl: `${upstreamUrl}/api/v1` }));
		assert.notEqual(first.token, second.token);
		assert.equal((await post(`${first.baseUrl}/chat/completions`, first.token, completions.id)).status, 401);
		const ok = await post(`${second.baseUrl}/chat/completions`, second.token, completions.id);
		assert.equal(ok.status, 200);
		await ok.text();
		// The older body's revoke does not end the newer body's grant.
		first.revoke();
		const still = await post(`${second.baseUrl}/chat/completions`, second.token, completions.id);
		assert.equal(still.status, 200);
		await still.text();
		second.revoke();
		assert.equal((await post(`${second.baseUrl}/chat/completions`, second.token, completions.id)).status, 401);
		assert.equal(proxy.liveGrants, 0);
	});
});
