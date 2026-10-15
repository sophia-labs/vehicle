import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createSession, DRIVER, type Harness, SECOND, startHost, STRANGER } from "./harness.ts";

describe("the driver lease", () => {
	let harness: Harness;
	before(async () => {
		harness = await startHost();
	});
	after(async () => harness.cleanup());

	it("refuses a request without the host secret, and a forged identity without it", async () => {
		const reply = await harness.call("GET", "/sessions", undefined, { ...DRIVER, secret: "" });
		assert.equal(reply.status, 401);
		const wrong = await harness.call("GET", "/sessions", undefined, { ...DRIVER, secret: "not-the-secret-at-all!!" });
		assert.equal(wrong.status, 401);
	});

	it("is held by the creating client; a second client is refused and told who holds it", async () => {
		harness.faux.setResponses([fauxAssistantMessage("hello")]);
		const sessionId = await createSession(harness);

		const refused = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-2", op: "prompt", text: "hi" }, SECOND);
		assert.equal(refused.status, 409);
		assert.equal(refused.body.code, "lease_held");
		assert.equal(refused.body.details.holder.clientId, DRIVER.clientId);

		const claim = await harness.call("POST", `/sessions/${sessionId}/claim`, { requestId: "c-2" }, SECOND);
		assert.equal(claim.status, 409);
		assert.equal(claim.body.code, "lease_held");

		// Someone else cannot even see it.
		const stranger = await harness.call("GET", `/sessions/${sessionId}`, undefined, STRANGER);
		assert.equal(stranger.status, 404);

		// Nothing the refused client sent reached the model.
		assert.equal(harness.faux.state.callCount, 0);
		const accepted = (await harness.events(sessionId)).filter((event) => event.type === "command.accepted");
		assert.equal(accepted.length, 0);

		// The driver's command goes through; after release, the second client may claim.
		const ok = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-1", op: "prompt", text: "hi" });
		assert.equal(ok.status, 200, JSON.stringify(ok.body));
		await harness.waitFor(sessionId, (event) => event.type === "run.settled");
		assert.equal((await harness.call("POST", `/sessions/${sessionId}/release`, { requestId: "r-1" })).status, 200);
		const second = await harness.call("POST", `/sessions/${sessionId}/claim`, { requestId: "c-3" }, SECOND);
		assert.equal(second.status, 200);
		assert.equal(second.body.value.lease.clientId, SECOND.clientId);
		const formerDriver = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-3", op: "prompt", text: "again" });
		assert.equal(formerDriver.body.code, "lease_held");
	});

	it("refuses commands when nobody holds the lease", async () => {
		const sessionId = await createSession(harness, { claim: false });
		const reply = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-1", op: "steer", text: "x" });
		assert.equal(reply.status, 409);
		assert.equal(reply.body.code, "lease_required");
	});
});

describe("requestId is the idempotency key", () => {
	let harness: Harness;
	before(async () => {
		harness = await startHost();
	});
	after(async () => harness.cleanup());

	it("replays a repeated command instead of running it twice, and refuses a reused id with another body", async () => {
		harness.faux.setResponses([fauxAssistantMessage("one answer"), fauxAssistantMessage("must not be used")]);
		const sessionId = await createSession(harness);
		const first = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "req-1", op: "prompt", text: "Count to one" });
		assert.equal(first.status, 200);
		await harness.waitFor(sessionId, (event) => event.type === "run.settled");
		const again = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "req-1", op: "prompt", text: "Count to one" });
		assert.equal(again.status, 200);
		assert.equal(again.body.replayed, true);
		assert.equal(again.body.value.command.commandId, first.body.value.command.commandId);
		const conflict = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "req-1", op: "prompt", text: "Count to two" });
		assert.equal(conflict.status, 409);
		assert.equal(conflict.body.code, "request_id_conflict");

		assert.equal(harness.faux.state.callCount, 1);
		const accepted = (await harness.events(sessionId)).filter((event) => event.type === "command.accepted");
		assert.equal(accepted.length, 1);
	});

	it("creates a session once per requestId", async () => {
		const body = { requestId: "create-once" };
		const one = await harness.call("POST", "/sessions", body);
		const two = await harness.call("POST", "/sessions", body);
		assert.equal(one.status, 201);
		assert.equal(two.status, 200);
		assert.equal(two.body.value.replayed, true);
		assert.equal(two.body.value.session.sessionId, one.body.value.session.sessionId);
	});

	it("replays concurrent duplicates once", async () => {
		harness.faux.setResponses([fauxAssistantMessage("concurrent")]);
		const sessionId = await createSession(harness);
		const body = { requestId: "dup", op: "prompt", text: "once" };
		const replies = await Promise.all([1, 2, 3].map(() => harness.call("POST", `/sessions/${sessionId}/commands`, body)));
		assert.deepEqual(
			replies.map((reply) => reply.status),
			[200, 200, 200],
		);
		assert.equal(replies.filter((reply) => reply.body.replayed === true).length, 2);
		await harness.waitFor(sessionId, (event) => event.type === "run.settled");
		const accepted = (await harness.events(sessionId)).filter((event) => event.type === "command.accepted");
		assert.equal(accepted.length, 1);
	});
});
