/**
 * Binding a session to one graph. gardend does it: under gardend, a session's MCP client carries a delegation
 * token bound to the session's graph, so gardend's `tools/list` offers no graph argument, every call gets the
 * graph filled in, and a call that names another graph is refused (garden `docs/local-service-hosting.md`,
 * "Delegation tokens"). The model never supplies the graph.
 *
 * The extension keeps one fence of its own in the `tool_call` hook: a call whose graph argument names another
 * graph is blocked before it leaves the host. With a graph-bound token that is defence in depth; with a plain
 * token (pi by hand) it is the only binding there is.
 */

export const GRAPH_ARGUMENTS = ["graphId", "graph_id"] as const;

/** The graph a call names, by either spelling. */
export function graphNamedBy(args: Readonly<Record<string, unknown>> | undefined): unknown {
	return args?.graphId ?? args?.graph_id;
}

/**
 * The fence: why a call that names `named` is blocked in a session on `graphId` that also reads `graphs` (a
 * public session reads every public graph), or `undefined` when it may go. A call that names no graph goes.
 */
export function graphFence(named: unknown, graphId: string, graphs: readonly string[] = []): string | undefined {
	if (named === undefined) return undefined;
	const readable = [graphId, ...graphs.filter((graph) => graph !== graphId)];
	if (typeof named === "string" && readable.includes(named)) return undefined;
	return readable.length === 1
		? `This conversation is bound to the workspace "${graphId}".`
		: `This conversation reads only these workspaces: ${readable.map((graph) => `"${graph}"`).join(", ")}.`;
}
