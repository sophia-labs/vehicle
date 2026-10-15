// A local service for the real-gardend tests: gardend supervises it as `vehicle` (with "delegateCaller": true)
// and it answers every request with what gardend minted for it, the delegation token included. The tests use it
// to get real delegation tokens from gardend's own proxy.
import { createServer } from "node:http";

const port = Number(process.env.PORT);
const host = process.env.GARDEN_SERVICE_HOST || "127.0.0.1";
createServer((request, response) => {
	response.setHeader("content-type", "application/json");
	if (request.url === "/health") {
		response.end(JSON.stringify({ ok: true }));
		return;
	}
	const header = (name) => request.headers[name] ?? null;
	response.end(
		JSON.stringify({
			secretOk: header("x-internal-service") === process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET,
			path: request.url,
			userId: header("x-user-id"),
			graphId: header("x-graph-id"),
			graphRole: header("x-sophia-graph-role"),
			delegatedToken: header("x-sophia-delegated-token"),
		}),
	);
}).listen(port, host);
