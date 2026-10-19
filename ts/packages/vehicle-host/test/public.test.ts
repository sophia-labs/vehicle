/**
 * Public sessions (`src/public.ts`): visitors and Sophia accounts of a gardend in public mode. They read for free;
 * a conversation opens by their own model key (`X-Model-Key`, memory only) or an account's credit (a signup grant
 * once, a debit per run, a global daily cap), and every public turn keeps to the limits. Real HTTP, pi's faux
 * provider (it records the key each model call was made with).
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { mirrorSkipReason } from "../src/index.ts";
import { account, createSession, DRIVER, type Harness, startHost, visitor } from "./harness.ts";

const COSTLY = [{ id: "faux-1", cost: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 } }];
const KEY = "sk-or-v1-visitor-own-key-0123456789abcdef";

/** Every file under `dir`, read as text. */
function everyFile(dir: string): { path: string; text: string }[] {
	const out: { path: string; text: string }[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		const stat = statSync(path);
		if (stat.isDirectory()) out.push(...everyFile(path));
		else out.push({ path, text: readFileSync(path, "latin1") });
	}
	return out;
}

/**
 * Answers every model call, recording which runtime answered: `house` (the host's, the house key) or `own` (a
 * session's own runtime, holding the visitor's key).
 */
function recordKeys(harness: Harness, keys: string[], answer = "An answer about the cows.") {
	const script = (who: string) =>
		Array.from({ length: 20 }, () => () => {
			keys.push(who);
			return fauxAssistantMessage(answer);
		});
	harness.faux.setResponses(script("house"));
	harness.byokFaux.setResponses(script("own"));
}

/**
 * The key a runtime holds for the faux provider: its credential store's answer (pi hands a real provider such as
 * openrouter that key as its `apiKey`; the faux provider asks for none, so the store is where to look).
 */
async function keyOf(runtime: unknown): Promise<string | undefined> {
	const credentials = (runtime as { credentials?: { read(provider: string): Promise<{ key?: string } | undefined> } } | undefined)?.credentials;
	return (await credentials?.read("faux"))?.key;
}

async function turn(harness: Harness, sessionId: string, requestId: string, who: ReturnType<typeof visitor>, text = "How many cows?") {
	const reply = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId, op: "prompt", text }, who);
	if (reply.status === 200) {
		const accepted = reply.body.value.command.acceptedSeq as number;
		await harness.waitFor(sessionId, (event) => event.type === "run.settled" && event.seq > accepted, 10_000, who);
	}
	return reply;
}

describe("public sessions: the two doors", () => {
	let harness: Harness;
	before(async () => {
		harness = await startHost({ models: COSTLY, fauxKey: "house-key" });
	});
	after(async () => harness.cleanup());

	it("refuses an anonymous visitor without a key, naming both doors; reading the account says the same", async () => {
		const who = visitor("aaaaaaaaaaaaaaaaaaaaaaaa");
		const refused = await harness.call("POST", "/sessions", { requestId: "no-door" }, who);
		assert.equal(refused.status, 402, JSON.stringify(refused.body));
		assert.equal(refused.body.code, "model_key_required");
		assert.match(refused.body.message, /paste your OpenRouter key/);
		assert.match(refused.body.message, /Sophia account/);
		assert.ok(refused.body.details.doors.byok && refused.body.details.doors.account);
		const mine = await harness.call("GET", "/account", undefined, { ...who, graphId: null });
		assert.equal(mine.status, 200);
		assert.equal(mine.body.value.kind, "anonymous");
		assert.equal(mine.body.value.principal, "anon:aaaaaaaaaaaaaaaaaaaaaaaa");
		assert.ok(mine.body.value.doors.byok);
	});

	it("runs a visitor's conversation on its own key, keeps the key out of every file, and asks for it again after a restart", async () => {
		const who = visitor("bbbbbbbbbbbbbbbbbbbbbbbb", { "x-model-key": KEY });
		const keys: string[] = [];
		recordKeys(harness, keys);
		const sessionId = await createSession(harness, {}, who);
		const meta = JSON.parse(readFileSync(join(harness.dataDir, "sessions", sessionId, "meta.json"), "utf8"));
		assert.equal(meta.funding, "byok");
		assert.equal(meta.role, "viewer");
		assert.equal((await turn(harness, sessionId, "byok-1", who)).status, 200);
		assert.deepEqual(keys, ["own"], "the session's own runtime answered, not the house's");
		assert.equal(await keyOf(harness.byokRuntimes.at(-1)), KEY, "and it holds the visitor's key");
		assert.equal(await keyOf((harness.host as unknown as { services: { modelRuntime: unknown } }).services.modelRuntime), "house-key", "the house runtime keeps the house key");

		// A provider error that quotes the key never reaches the log.
		harness.byokFaux.setResponses([() => fauxAssistantMessage("", { stopReason: "error", errorMessage: `401 invalid key ${KEY}` })]);
		assert.equal((await turn(harness, sessionId, "byok-2", who)).status, 200);
		const events = await harness.events(sessionId, 0, who);
		assert.ok(JSON.stringify(events).includes("[redacted]"), "the quoted key was replaced");
		const capsule = await harness.call("GET", `/sessions/${sessionId}/capsule`, undefined, who);
		const snapshot = await harness.call("GET", `/sessions/${sessionId}`, undefined, who);
		for (const text of [JSON.stringify(events), JSON.stringify(capsule.body), JSON.stringify(snapshot.body)]) {
			assert.ok(!text.includes(KEY), "no key in events, capsule or inspect");
		}
		for (const file of everyFile(harness.dataDir)) assert.ok(!file.text.includes(KEY), `the key is in ${file.path}`);

		// After a restart the key is gone with the process: the next command must bring it.
		await harness.stop();
		const revived = await startHost({ models: COSTLY, fauxKey: "house-key", dataDir: harness.dataDir });
		try {
			const keysAfter: string[] = [];
			recordKeys(revived, keysAfter);
			const bare = visitor("bbbbbbbbbbbbbbbbbbbbbbbb");
			const refused = await revived.call("POST", `/sessions/${sessionId}/commands`, { requestId: "byok-3", op: "prompt", text: "Again?" }, bare);
			assert.equal(refused.status, 402, JSON.stringify(refused.body));
			assert.equal(refused.body.code, "model_key_required");
			assert.equal(keysAfter.length, 0, "no model call on the house key");
			assert.equal((await turn(revived, sessionId, "byok-4", who, "Again?")).status, 200);
			assert.deepEqual(keysAfter, ["own"]);
			assert.equal(await keyOf(revived.byokRuntimes.at(-1)), KEY);
			for (const file of everyFile(revived.dataDir)) assert.ok(!file.text.includes(KEY), `the key is in ${file.path}`);
		} finally {
			await revived.stop();
		}
		harness = await startHost({ models: COSTLY, fauxKey: "house-key", dataDir: harness.dataDir });
	});

	it("lets one public conversation read every public graph gardend names, its own first", async () => {
		const who = visitor("a1a1a1a1a1a1a1a1a1a1a1a1", { "x-model-key": KEY, "x-sophia-public-graphs": "uruguay-catalogue,test-graph,cow-tools-guide" });
		const sessionId = await createSession(harness, {}, who);
		const meta = JSON.parse(readFileSync(join(harness.dataDir, "sessions", sessionId, "meta.json"), "utf8"));
		assert.equal(meta.graphId, "test-graph");
		assert.deepEqual(meta.graphs, ["uruguay-catalogue", "cow-tools-guide"]);
		// The workspace's own people stay bound to one graph, whatever a header says.
		const ownerSession = await createSession(harness, {}, { ...DRIVER, extra: { "x-sophia-public-graphs": "uruguay-catalogue" } });
		const ownerMeta = JSON.parse(readFileSync(join(harness.dataDir, "sessions", ownerSession, "meta.json"), "utf8"));
		assert.equal(ownerMeta.graphs, undefined);
	});

	it("lets a signed-in account on its visitors' folder graph be a contributor: a writer, never mirrored; nobody else", async () => {
		const base = account("66666666-7777-8888-9999-000000000000", true, { "x-model-key": KEY });
		const contributor = { ...base, role: "contributor" as const };
		const sessionId = await createSession(harness, {}, contributor);
		const meta = JSON.parse(readFileSync(join(harness.dataDir, "sessions", sessionId, "meta.json"), "utf8"));
		assert.equal(meta.role, "contributor");
		const seen = await harness.call("GET", `/sessions/${sessionId}`, undefined, contributor);
		assert.equal(seen.status, 200);
		assert.equal(seen.body.value.session.access, "write");
		// Never mirrored: a visitor's chat is not a public document (W6: a contributor writes only in the folder).
		assert.match(mirrorSkipReason("contributor") ?? "", /visitors' folder/);
		assert.equal(mirrorSkipReason("editor"), undefined);
		assert.match(mirrorSkipReason("viewer") ?? "", /cannot write/);
		// An anonymous visitor is never a contributor, whatever its headers say.
		const forged = { ...visitor("efefefefefefefefefefefef", { "x-model-key": KEY }), role: "contributor" as const };
		const refused = await harness.call("POST", "/sessions", { requestId: "forged-contributor" }, forged);
		assert.equal(refused.status, 400);
		assert.equal(refused.body.code, "invalid_identity");
	});

	it("lists a visitor's conversations to that visitor only", async () => {
		const mine = visitor("cccccccccccccccccccccccc", { "x-model-key": KEY });
		const other = visitor("dddddddddddddddddddddddd", { "x-model-key": KEY });
		const sessionId = await createSession(harness, {}, mine);
		const listed = await harness.call("GET", "/sessions", undefined, other);
		assert.ok(!(listed.body.value.sessions as { sessionId: string }[]).some((session) => session.sessionId === sessionId));
		assert.equal((await harness.call("GET", `/sessions/${sessionId}`, undefined, other)).status, 404);
		const own = await harness.call("GET", "/sessions", undefined, mine);
		assert.ok((own.body.value.sessions as { sessionId: string }[]).some((session) => session.sessionId === sessionId));
		const chime = await harness.call("POST", `/sessions/${sessionId}/chimes`, { requestId: "c1", author: "Someone", text: "hi" }, other);
		assert.equal(chime.status, 403);
		assert.equal(chime.body.code, "chimes_closed");
	});

	it("grants a verified account its credit once, runs it on the house key, and debits each run by its cost", async () => {
		const who = account("11111111-2222-3333-4444-555555555555");
		const keys: string[] = [];
		recordKeys(harness, keys);
		const first = await harness.call("GET", "/account", undefined, { ...who, graphId: null });
		assert.equal(first.body.value.kind, "account");
		assert.equal(first.body.value.credit.balanceUsd, 0.5);
		const again = await harness.call("GET", "/account", undefined, { ...who, graphId: null });
		assert.equal(again.body.value.credit.grantedUsd, 0.5, "granted once");
		const sessionId = await createSession(harness, {}, who);
		assert.equal((await turn(harness, sessionId, "credit-1", who)).status, 200);
		assert.deepEqual(keys, ["house"], "credit pays with the house key: the host's runtime answered");
		const settled = (await harness.events(sessionId, 0, who)).find((event) => event.type === "run.settled");
		const cost = settled?.payload.costUsd as number;
		assert.ok(cost > 0, "the run had a cost");
		const after1 = await harness.call("GET", "/account", undefined, { ...who, graphId: null });
		assert.equal(after1.body.value.credit.spentUsd, Math.round(cost * 1e6) / 1e6);
		assert.equal(after1.body.value.credit.balanceUsd, Math.round((0.5 - cost) * 1e6) / 1e6);
		const ledger = readFileSync(join(harness.dataDir, "public", "ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const mine = ledger.filter((row) => row.principal === "cognito:11111111-2222-3333-4444-555555555555");
		assert.deepEqual(
			mine.map((row) => [row.kind, row.source ?? row.funding ?? null]),
			[["grant", "signup"], ["turn", "credit"], ["debit", null]],
		);
		assert.equal(mine[0].idempotencyKey, "signup:cognito:11111111-2222-3333-4444-555555555555");
		assert.equal(mine[2].idempotencyKey, `run:${sessionId}:${settled?.payload.runId}`);
	});

	it("refuses a credit model outside the list, and an unverified account its credit", async () => {
		const who = account("22222222-2222-3333-4444-555555555555");
		const odd = await harness.call("POST", "/sessions", { requestId: "odd-model", model: "faux/other" }, who);
		assert.equal(odd.status, 400);
		assert.equal(odd.body.code, "model_not_allowed");
		const unverified = account("33333333-2222-3333-4444-555555555555", false);
		const refused = await harness.call("POST", "/sessions", { requestId: "unverified" }, unverified);
		assert.equal(refused.status, 402);
		assert.equal(refused.body.code, "email_unverified");
	});

	it("lets the owner grant credit (a purchase, idempotent by its key) and nobody else", async () => {
		const principal = "cognito:44444444-2222-3333-4444-555555555555";
		const grant = (who = DRIVER) =>
			harness.call("POST", "/account/grants", { principal, amountUsd: 2, source: "purchase", idempotencyKey: "checkout-session-1" }, { ...who, graphId: null });
		const first = await grant();
		assert.equal(first.status, 200, JSON.stringify(first.body));
		assert.equal(first.body.value.created, true);
		const twice = await grant();
		assert.equal(twice.body.value.created, false);
		assert.equal(twice.body.value.balanceUsd, 2);
		const refused = await grant(account("55555555-2222-3333-4444-555555555555"));
		assert.equal(refused.status, 403);
	});
});

describe("public sessions: limits and caps", () => {
	it("refuses at zero credit, plainly", async () => {
		const harness = await startHost({ models: COSTLY, fauxKey: "house-key", public: { signupGrantUsd: 0.000001 } });
		try {
			recordKeys(harness, []);
			const who = account("66666666-2222-3333-4444-555555555555");
			const sessionId = await createSession(harness, {}, who);
			assert.equal((await turn(harness, sessionId, "z-1", who)).status, 200);
			const refused = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "z-2", op: "prompt", text: "More?" }, who);
			assert.equal(refused.status, 402, JSON.stringify(refused.body));
			assert.equal(refused.body.code, "out_of_credit");
			assert.equal(refused.body.message, "out of credit: paste your OpenRouter key (send it as X-Model-Key) to keep talking");
			// Their own key still opens a conversation.
			const byok = await harness.call("POST", "/sessions", { requestId: "z-byok" }, { ...who, extra: { ...who.extra, "x-model-key": KEY } });
			assert.equal(byok.status, 201, JSON.stringify(byok.body));
		} finally {
			await harness.cleanup();
		}
	});

	it("closes credit for everyone once today's global cap is spent, and not their own keys", async () => {
		const harness = await startHost({ models: COSTLY, fauxKey: "house-key", public: { creditDailyCapUsd: 0.000001 } });
		try {
			recordKeys(harness, []);
			const first = account("77777777-2222-3333-4444-555555555555");
			const sessionId = await createSession(harness, {}, first);
			assert.equal((await turn(harness, sessionId, "cap-1", first)).status, 200);
			const second = account("88888888-2222-3333-4444-555555555555");
			const refused = await harness.call("POST", "/sessions", { requestId: "cap-2" }, second);
			assert.equal(refused.status, 503, JSON.stringify(refused.body));
			assert.equal(refused.body.code, "credit_pool_exhausted");
			assert.match(refused.body.message, /used up/);
			const mine = await harness.call("GET", "/account", undefined, { ...second, graphId: null });
			assert.equal(mine.body.value.credit.poolOpenToday, false);
			const byok = await harness.call("POST", "/sessions", { requestId: "cap-byok" }, visitor("eeeeeeeeeeeeeeeeeeeeeeee", { "x-model-key": KEY }));
			assert.equal(byok.status, 201);
		} finally {
			await harness.cleanup();
		}
	});

	it("keeps a conversation to its turns and a visitor to its turns per day", async () => {
		const harness = await startHost({ public: { sessionMaxTurns: 2, turnsPerDay: 3 } });
		try {
			recordKeys(harness, []);
			const who = visitor("ffffffffffffffffffffffff", { "x-model-key": KEY });
			const one = await createSession(harness, {}, who);
			assert.equal((await turn(harness, one, "t-1", who)).status, 200);
			assert.equal((await turn(harness, one, "t-2", who)).status, 200);
			const third = await harness.call("POST", `/sessions/${one}/commands`, { requestId: "t-3", op: "prompt", text: "And?" }, who);
			assert.equal(third.status, 429);
			assert.equal(third.body.code, "session_turn_limit");
			assert.match(third.body.message, /reached its 2 turns/);
			const two = await createSession(harness, {}, who);
			assert.equal((await turn(harness, two, "t-4", who)).status, 200);
			const daily = await harness.call("POST", `/sessions/${two}/commands`, { requestId: "t-5", op: "prompt", text: "More" }, who);
			assert.equal(daily.status, 429);
			assert.equal(daily.body.code, "daily_turn_limit");
			// The workspace's own people have no such limits.
			const ownerSession = await createSession(harness);
			for (const n of [1, 2, 3]) assert.equal((await turn(harness, ownerSession, `o-${n}`, DRIVER)).status, 200);
		} finally {
			await harness.cleanup();
		}
	});

	it("caps each public run's budget whatever the request asks", async () => {
		const harness = await startHost({ public: { runBudget: { maxTurns: 2, maxCostUsd: 0.01 } } });
		try {
			const sessionId = await createSession(harness, { budget: { maxTurns: 50, maxCostUsd: 5 } }, visitor("abababababababababababab", { "x-model-key": KEY }));
			const meta = JSON.parse(readFileSync(join(harness.dataDir, "sessions", sessionId, "meta.json"), "utf8"));
			assert.deepEqual(meta.budget, { maxTurns: 2, maxCostUsd: 0.01 });
		} finally {
			await harness.cleanup();
		}
	});

	it("opens no conversation to visitors on a host whose public sessions are off", async () => {
		const harness = await startHost({ public: false });
		try {
			const refused = await harness.call("POST", "/sessions", { requestId: "off" }, visitor("cdcdcdcdcdcdcdcdcdcdcdcd", { "x-model-key": KEY }));
			assert.equal(refused.status, 403);
			assert.equal(refused.body.code, "not_public");
		} finally {
			await harness.cleanup();
		}
	});
});
