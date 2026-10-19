import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BudgetGuard,
	chatTools,
	createSophiaMcpTransport,
	EXCLUDED_TOOLS,
	graphFence,
	graphNamedBy,
	mcpToolName,
	normalizeBudget,
	profileToolName,
	AGENT_BUILTINS,
	createSophiaExtension,
	SOPHIA_EXCLUDED_BUILTINS,
	sophiaExcludedBuiltins,
	sophiaPrompt,
	sophiaToolAllowlist,
	TOOL_FAMILIES,
	turnTextForModel,
	WRITE_TOOLS,
} from "../src/index.ts";

const named = (text: string) => [...text.matchAll(/`(mcp__sophia__[a-z_]+)`/g)].map((match) => match[1]);

describe("the manifest and the prompt", () => {
	it("hands a viewer only reads, and never an excluded tool", () => {
		const reader = chatTools("read");
		for (const tool of reader) assert.ok(!WRITE_TOOLS.has(tool), `${tool} writes`);
		for (const tool of [...chatTools("write")]) assert.ok(!EXCLUDED_TOOLS.includes(tool), `${tool} is excluded`);
		assert.ok(reader.includes("read_document") && reader.includes("search_documents"));
	});

	it("names exactly the tools it is handed, by the names pi gives them", () => {
		for (const role of ["viewer", "editor"] as const) {
			const access = role === "viewer" ? "read" : "write";
			const handed = chatTools(access);
			const prompt = sophiaPrompt({ graphId: "g-1", role, toolName: (tool) => mcpToolName("sophia", tool) });
			const mentioned = new Set(named(prompt.text).map((name) => name?.replace("mcp__sophia__", "")));
			assert.deepEqual([...mentioned].sort(), [...handed].sort(), `${role}: prompt and manifest disagree`);
		}
	});

	it("tells a contributor it writes only inside the visitors' folder", () => {
		const prompt = sophiaPrompt({ graphId: "cow-tools-guide", role: "contributor" });
		assert.match(prompt.text, /they are a visitor, so you can read and search it, and write only inside its visitors' folder/);
		assert.match(prompt.text, /The workspace refuses any other change, so do not try one/);
		const editor = sophiaPrompt({ graphId: "g", role: "editor" });
		assert.match(editor.text, /they are an editor, so you can read, search and change it\./);
	});

	it("hands every role find, and says when to ask it rather than search_documents", () => {
		for (const access of ["read", "write"] as const) assert.ok(chatTools(access).includes("find"), access);
		const prompt = sophiaPrompt({ graphId: "uruguay-catalogue", role: "viewer" });
		assert.match(prompt.tools, /`find` finds data: the datasets, codes, places, people/);
		assert.match(prompt.tools, /ask it first when the question is about data rather than about the documents/);
		const old = sophiaPrompt({ graphId: "g", role: "viewer", tools: ["read_document", "search_documents"] });
		assert.doesNotMatch(old.text, /`find`/, "a gardend without find is not told about it");
	});

	it("leaves out what the live cell does not serve", () => {
		const prompt = sophiaPrompt({ graphId: "g-1", role: "viewer", tools: ["read_document", "search_documents"] });
		assert.match(prompt.text, /`search_documents`/);
		assert.doesNotMatch(prompt.text, /`semantic_search`|`sparql_query`|`surface`/);
	});

	it("binds the workspace, keeps the substance, and drops voices", () => {
		const prompt = sophiaPrompt({ graphId: "led-badge", role: "viewer" });
		assert.match(prompt.intro, /workspace "led-badge"/);
		assert.match(prompt.intro, /without being told which workspace/);
		assert.doesNotMatch(prompt.text, /graphId|graph_id/, "gardend binds the graph: the model never names it");
		assert.match(prompt.intro, /cannot change anything here/);
		assert.match(prompt.rules, /Ids are not titles/);
		assert.match(prompt.rules, /Search before you give up/);
		assert.doesNotMatch(prompt.text, /voice|credit|Choreograph/i);
		const writer = sophiaPrompt({ graphId: "g", role: "owner" });
		assert.match(writer.tools, /gardend signs it with the person you act for/);
		assert.doesNotMatch(writer.tools, /author` "Sophia"/, "comments are signed by gardend, not by the model");
		assert.match(writer.rules, /Read before you write/);
		assert.doesNotMatch(writer.text, /graphId|graph_id/);
	});

	it("hands a writer the workflow plan tools, and tells it a plan is composed, never written as prose", () => {
		assert.ok(chatTools("read").includes("workflow_plan_read"))
		for (const tool of ["workflow_plan_create", "workflow_plan_compose", "workflow_plan_publish"]) assert.ok(chatTools("write").includes(tool), tool)
		assert.match(sophiaPrompt({ graphId: "freud-dreams", role: "owner" }).tools, /`workflow_plan_publish` puts its verified findings in the margin[^.]*: only when the person asks/)
		const writer = sophiaPrompt({ graphId: "freud-dreams", role: "editor" })
		assert.match(writer.tools, /`workflow_plan_compose` changes it with moves and a one-line `rationale`/)
		assert.match(writer.tools, /never as prose in the workflow's body/)
		const reader = sophiaPrompt({ graphId: "freud-dreams", role: "viewer" })
		assert.doesNotMatch(reader.tools, /workflow_plan_compose/)
	});

	it("removes a wire the way gardend takes it: type \"wires\" and its wireId", () => {
		const writer = sophiaPrompt({ graphId: "g", role: "editor" });
		for (const text of [writer.tools, writer.rules]) {
			assert.match(text, /`delete` with `type` "wires" and the wire's `wireId`|`delete`, `type` "wires" and the wire's `wireId`/);
			assert.doesNotMatch(text, /"wire"[^s]/, "the earlier writer prompt said type \"wire\", which gardend refuses");
		}
	});

	it("hands every role the datasheets: documents first, datasheets too, and never a refusal for a missing one", () => {
		for (const access of ["read", "write"] as const) assert.ok(chatTools(access).includes("datasheet_facts"), access);
		for (const role of ["viewer", "editor", "owner"] as const) {
			const prompt = sophiaPrompt({ graphId: "led-badge", role });
			assert.match(prompt.intro, /its documents first, then its files and datasheets/, role);
			assert.match(prompt.tools, /`datasheet_facts` adds what an imported datasheet \(a PDF file\) says about a part/, role);
			assert.match(prompt.rules, /Search the documents for a part number before you ask `datasheet_facts` about it/, role);
			assert.match(prompt.rules, /never refuse for that reason/, role);
			assert.match(prompt.rules, /`get_workspace` lists them/, role);
			assert.doesNotMatch(prompt.text, /Files are not documents|has not been imported/, `${role}: the old rule had models refuse`);
		}
		const noFiles = sophiaPrompt({ graphId: "g", role: "viewer", tools: ["read_document", "search_documents", "datasheet_facts"] });
		assert.match(noFiles.rules, /never refuse for that reason/);
		assert.doesNotMatch(noFiles.text, /get_workspace/, "a tool the session is not handed is never named");
		const without = sophiaPrompt({ graphId: "g", role: "viewer", tools: ["read_document", "search_documents"] });
		assert.doesNotMatch(without.text, /datasheet/, "a cell that does not serve it is not told about it");
		assert.match(without.rules, /If a read fails or a search finds nothing/);
	});

	it("names what the person has open, by id only", () => {
		assert.equal(turnTextForModel("hi", undefined), "hi");
		assert.equal(turnTextForModel("hi", ["not an id!"]), "hi");
		assert.match(turnTextForModel("hi", ["doc-1#block-2"]), /`doc-1#block-2`/);
	});
});

describe("the graph binding", () => {
	it("lets a public session read every public graph, naming each, and no other", () => {
		const prompt = sophiaPrompt({ graphId: "uruguay-cows", graphs: ["uruguay-catalogue", "cow-tools-guide"], role: "viewer" });
		assert.match(prompt.intro, /assistant in the workspaces "uruguay-cows", "uruguay-catalogue" and "cow-tools-guide"/);
		assert.match(prompt.intro, /read and search these workspaces/);
		assert.match(prompt.intro, /also reads "uruguay-catalogue" and "cow-tools-guide"/);
		assert.match(prompt.intro, /`graphId`/);
		assert.match(prompt.intro, /names none works in "uruguay-cows"/);
		assert.equal(graphFence(undefined, "uruguay-cows", ["uruguay-catalogue"]), undefined);
		assert.equal(graphFence("uruguay-catalogue", "uruguay-cows", ["uruguay-catalogue"]), undefined);
		assert.equal(graphFence("uruguay-cows", "uruguay-cows", ["uruguay-catalogue"]), undefined);
		assert.match(graphFence("someone-private", "uruguay-cows", ["uruguay-catalogue"]) ?? "", /reads only these workspaces/);
		assert.match(graphFence("other", "g") ?? "", /bound to the workspace "g"/);
		assert.match(graphFence(7, "g") ?? "", /bound/);
	});

	it("names the graph a call carries, by either spelling", () => {
		assert.equal(graphNamedBy({ graphId: "a" }), "a");
		assert.equal(graphNamedBy({ graph_id: "b" }), "b");
		assert.equal(graphNamedBy({ query: "buck" }), undefined);
	});

	it("serves only gardend's address, and needs a token getter", () => {
		assert.throws(() => createSophiaMcpTransport({ url: "http://127.0.0.1:1/mcp" }));
		const transport = createSophiaMcpTransport({ url: "http://127.0.0.1:1/mcp", getToken: () => "t" });
		assert.throws(() => transport({ name: "other", config: { url: "http://127.0.0.1:2/mcp" }, source: "x" }, "/", undefined));
		assert.ok(transport({ name: "sophia", config: { url: "http://127.0.0.1:1/mcp" }, source: "x" }, "/", undefined));
	});
});

describe("a tool called by its bare name", () => {
	it("is the profile's tool under pi's name; anything else stays unknown", () => {
		const reader = chatTools("read");
		for (const called of ["search_blocks", "mcp__sophia__search_blocks", "default_api.search_blocks", "sophia__search_blocks", "functions:search_blocks"]) {
			assert.equal(profileToolName(called, "sophia", reader), "mcp__sophia__search_blocks", called);
		}
		for (const called of ["create_document", "sparql_update", "bash", "read", "search_block", "mcp__other__search_blocks_x"]) {
			assert.equal(profileToolName(called, "sophia", reader), undefined, `${called}: not a reader's tool`);
		}
		assert.equal(profileToolName("create_document", "sophia", chatTools("write")), "mcp__sophia__create_document");
	});
});

describe("tools and budget", () => {
	it("allows a viewer's chat only the reader's graph tools, never a built-in", () => {
		const allow = sophiaToolAllowlist({ role: "viewer", gardend: { url: "http://127.0.0.1:1/mcp" } });
		assert.ok(allow.length > 0);
		for (const name of allow) {
			assert.match(name, /^mcp__sophia__/);
			assert.ok(!WRITE_TOOLS.has(name.replace("mcp__sophia__", "")));
		}
		for (const builtin of ["read", "bash", "edit", "write"]) assert.ok(SOPHIA_EXCLUDED_BUILTINS.includes(builtin));
		assert.deepEqual(sophiaToolAllowlist({ role: "owner" }), []);
		assert.equal(TOOL_FAMILIES.length, 12);
	});

	it("hands an agent the graph tools and pi's read, write, edit and bash; a chat none of them", () => {
		const gardend = { url: "http://127.0.0.1:1/mcp" };
		const agent = sophiaToolAllowlist({ role: "owner", gardend, profile: "agent" });
		for (const builtin of AGENT_BUILTINS) assert.ok(agent.includes(builtin), builtin);
		assert.ok(agent.includes("mcp__sophia__create_document"));
		assert.deepEqual(sophiaToolAllowlist({ role: "owner", profile: "agent" }), ["read", "write", "edit", "bash"], "with no gardend, its box only");
		assert.deepEqual([...sophiaExcludedBuiltins("agent")].sort(), ["find", "grep", "ls", "powershell"]);
		assert.deepEqual([...sophiaExcludedBuiltins("chat")].sort(), [...SOPHIA_EXCLUDED_BUILTINS].sort());
		for (const builtin of AGENT_BUILTINS) assert.ok(!sophiaToolAllowlist({ role: "owner", gardend, profile: "chat" }).includes(builtin));
		assert.throws(() => createSophiaExtension({ graphId: "g", role: "owner", profile: "agent" }), /working folder/);
	});

	it("tells an agent about its box, and a chat that it runs no code", () => {
		const agent = sophiaPrompt({ graphId: "g", role: "owner", agent: { workdir: "/data/workspaces/s1", isolation: "bwrap" } });
		assert.match(agent.box, /`\/data\/workspaces\/s1`/);
		assert.match(agent.box, /`read`, `write`, `edit` and `bash`/);
		assert.match(agent.box, /isolated box \(bwrap\)/);
		assert.doesNotMatch(agent.tools, /run code/);
		assert.match(agent.text, /computer of your own/);
		const chat = sophiaPrompt({ graphId: "g", role: "owner" });
		assert.equal(chat.box, "");
		assert.match(chat.tools, /browse the web or run code/);
	});

	it("caps turns and cost per run", () => {
		assert.throws(() => normalizeBudget({ maxTurns: 0 }));
		assert.throws(() => normalizeBudget({ maxCostUsd: -1 }));
		const guard = new BudgetGuard({ maxTurns: 3, maxCostUsd: 1 });
		guard.startRun();
		assert.equal(guard.endTurn(0.1), undefined);
		assert.equal(guard.endTurn(0.1), undefined);
		assert.equal(guard.endTurn(0.1)?.reason, "max_turns");
		guard.startRun();
		assert.equal(guard.endTurn(2)?.reason, "max_cost");
	});
});
