/**
 * Sophia's workspace prompt, carried over from Sophia's earlier hosted chat
 * (its `workspace-chat-v1` prompt) with its substance kept: every tool it
 * names (always in backticks) is one the session is handed, every tool it is handed is named, and every rule
 * in "How to work" comes from a failure seen in a real session. Dropped: the hosted runtime's internals and the
 * model's "voice": gardend signs comments itself, with the person the session acts for "via vehicle"
 * (an `author` argument is kept only as an unverified claim). Added: the bound workspace (gardend binds it: the tools take no
 * workspace argument) and the datasheets (documents first, datasheets too; never a refusal for a missing one).
 *
 * pi carries it as structured prompt sections: the intro is the preamble, the tool list and the rules are
 * sections of their own, so a later change patches one section instead of the whole prompt.
 */

import { accessForRole, chatTools, type SophiaAccess, type SophiaRole, TOOL_FAMILIES } from "./manifest.ts";

export interface SophiaPromptInput {
	readonly graphId: string;
	/** More workspaces the session reads (a public session): each tool call names one as `graphId`. */
	readonly graphs?: readonly string[];
	readonly role: SophiaRole;
	/** The cell tools the session is handed (bare names); absent means the whole manifest for the role. */
	readonly tools?: readonly string[];
	/** The name the model calls a cell tool by (pi names MCP tools `mcp__<server>__<tool>`). Default: as is. */
	readonly toolName?: (tool: string) => string;
	/**
	 * An `agent` body: it also has pi's `read`, `write`, `edit` and `bash` on a private working folder, inside an
	 * isolated box. `workdir` is that folder (the tools' current directory); `isolation` names the box.
	 */
	readonly agent?: { readonly workdir: string; readonly isolation: string };
}

export interface SophiaPrompt {
	/** Who the assistant is and whose authority it carries; pi's preamble. */
	readonly intro: string;
	/** The tools, by family; the `workspace_tools` section. */
	readonly tools: string;
	/** How to work; the `how_to_work` section. */
	readonly rules: string;
	/** An `agent` body's working folder and shell; the `agent_box` section (empty for chat). */
	readonly box: string;
	/** The sections joined, as one text (for tests and for hosts without sections). */
	readonly text: string;
}

/** Items joined as prose: "a", "a and b", "a, b and c" (or "or"). */
function prose(items: readonly string[], conjunction: "and" | "or"): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`;
}

/** The tools the prompt may name for an access level, given the tools a session is actually handed. */
export function exposedTools(access: SophiaAccess, liveTools: readonly string[] | undefined): readonly string[] {
	const manifest = chatTools(access);
	if (liveTools === undefined) return manifest;
	const live = new Set(liveTools);
	return manifest.filter((tool) => live.has(tool));
}

export function sophiaPrompt(input: SophiaPromptInput): SophiaPrompt {
	const access = accessForRole(input.role);
	const handed = new Set(exposedTools(access, input.tools));
	const named = input.toolName ?? ((tool: string) => tool);
	/** A tool as the prompt writes it: its callable name, in backticks. */
	const code = (tool: string) => `\`${named(tool)}\``;
	/** An argument name, in backticks. */
	const arg = (name: string) => `\`${name}\``;
	const list = (tools: readonly string[]) => tools.map(code).join(", ");
	const has = (...names: string[]) => names.every((name) => handed.has(name));
	const writeTools = TOOL_FAMILIES.flatMap((family) => family.write);
	const writes = access === "write" && writeTools.some((tool) => handed.has(tool));
	const family = (id: string) => {
		const found = TOOL_FAMILIES.find((candidate) => candidate.id === id);
		if (!found) throw new Error(`unknown tool family ${id}`);
		return found;
	};
	const tools = (id: string, part: "read" | "all" = writes ? "all" : "read") => {
		const found = family(id);
		return (part === "all" ? [...found.read, ...found.write] : [...found.read]).filter((tool) => handed.has(tool));
	};
	const whom = input.role === "owner" ? "its owner" : input.role === "contributor" ? "a visitor" : "an editor";
	/** What the person's permissions let the assistant change. */
	const change =
		input.role === "contributor"
			? "so you can read and search it, and write only inside its visitors' folder: new notes there, and changes to the notes this visitor wrote. The workspace refuses any other change, so do not try one; say so instead"
			: "so you can read, search and change it";
	const othersEarly = (input.graphs ?? []).filter((graph) => graph !== input.graphId);
	/** Where the assistant is: one workspace, or (a public session) every workspace it reads, its own first. */
	const where =
		othersEarly.length === 0
			? `the workspace "${input.graphId}"`
			: `the workspaces ${prose([input.graphId, ...othersEarly].map((graph) => `"${graph}"`), "and")}`;
	const these = othersEarly.length === 0 ? "this workspace" : "these workspaces";
	const others = (input.graphs ?? []).filter((graph) => graph !== input.graphId);
	const bound =
		others.length === 0
			? `This conversation is bound to that workspace: every tool works in it without being told which workspace, and you cannot reach any other.`
			: `This conversation also reads ${prose(
					others.map((graph) => `"${graph}"`),
					"and",
				)}. Every tool takes the workspace as \`graphId\`: name the one you mean; a call that names none works in "${input.graphId}". You cannot reach any other workspace.`;

	const intro = (
		writes
			? [
					`You are Sophia, the assistant in the workspace "${input.graphId}". You act for the person you are talking with, with their permissions here: they are ${whom}, ${change}.`,
					"Change things when the person asks you to. For anything large, or anything that removes text, say what you will do before you do it.",
				]
			: access === "write"
				? [
						`You are Sophia, the assistant in the workspace "${input.graphId}". You act for the person you are talking with, with their permissions here: they are ${whom}.`,
						"You can read and search this workspace, but this workspace offers you no tools to change it right now. If they ask for a change, say exactly what you would change and where.",
					]
				: [
						`You are Sophia, the assistant in ${where}. You act for the person you are talking with, with their permissions here.`,
						`You can read and search ${these}, but you cannot change anything here: the person can view ${these} but not edit them. If they ask for a change, say exactly what you would change and where, and that someone with edit rights can make it.`,
					]
	)
		.concat(bound)
		.concat(
			has("datasheet_facts")
				? ["Answer from what this workspace holds: its documents first, then its files and datasheets."]
				: [],
		)
		.join("\n");

	const line = (title: string, names: readonly string[], ...clauses: string[]) =>
		names.length === 0
			? []
			: [
					`- ${title}: ${list(names)}.${clauses
						.filter(Boolean)
						.map((clause) => ` ${clause}`)
						.join("")}`,
				];
	const findClauses = [
		has("search_documents") ? `${code("search_documents")} finds documents by title and text` : "",
		has("search_blocks") ? `${code("search_blocks")} finds passages` : "",
		has("semantic_search") ? `${code("semantic_search")} finds by meaning` : "",
		has("find")
			? `${code("find")} finds data: the datasets, codes, places, people and other things in the workspace's own RDF, by meaning and in any language; ask it first when the question is about data rather than about the documents, then read a hit's facts with ${has("sparql_query") ? code("sparql_query") : "its link"}`
			: "",
		has("list_documents") && has("get_workspace")
			? `${code("list_documents")} and ${code("get_workspace")} show what is here and the folder tree`
			: has("list_documents")
				? `${code("list_documents")} shows what is here`
				: has("get_workspace")
					? `${code("get_workspace")} shows what is here and the folder tree`
					: "",
		has("quick_orient") ? `${code("quick_orient")} gives a short overview` : "",
		has("sparql_query")
			? `${code("sparql_query")} runs SPARQL SELECT over the workspace's RDF (wrap patterns in GRAPH ?g { ... })`
			: "",
	].filter(Boolean);
	const findSentence =
		findClauses.length === 0
			? ""
			: findClauses.length <= 2
				? `${findClauses.join(" and ")}.`
				: `${findClauses.slice(0, -1).join(", ")}, and ${findClauses.at(-1)}.`;
	const wiresReads = tools("wires", "read");
	const artifactNames = tools("artifacts").filter((tool) => tool !== "custom_css");

	const toolLines = [
		"Your tools (call them by these names; you have no others):",
		...line(family("find").title, tools("find"), findSentence),
		...line(
			family("read").title,
			tools("read"),
			has("scan_text_layer")
				? `${code("scan_text_layer")} says where reading a scanned PDF stands and, once done, gives its words, each with its box on the page.`
				: "",
		),
		...(tools("history").length > 0
			? [`- ${family("history").title}: ${list(tools("history"))} show every saved version of a document.`]
			: []),
		...(has("datasheet_facts")
			? [
					`- ${family("datasheets").title}: ${code("datasheet_facts")} adds what an imported datasheet (a PDF file) says about a part: give ${arg("part")} (a part number such as TPS63020) or ${arg("artifact")} (the PDF's id), and optionally ${arg("parameter")} (vin, vout, iout, fsw, a symbol such as IQ, or words from a parameter name), which keeps the answer short. Each datasheet comes with its title, which says what the part is, and every value with its conditions and the datasheet page.`,
				]
			: []),
		...(writes
			? [
					...line(
						family("documents").title,
						tools("documents"),
						has("write_document")
							? `${code("write_document")} replaces a whole document; to keep JSON, code or other exact text byte for byte, put it in a fenced code block and pass ${arg("format")} "markdown".`
							: "",
						has("delete_document") ? `${code("delete_document")} deletes a whole document and its history with it.` : "",
						has("read_scan_text")
							? `${code("read_scan_text")} reads a scanned PDF's text when its pages are pictures; it runs in the background, so check ${has("scan_text_layer") ? code("scan_text_layer") : "back"} for the words.`
							: "",
					),
					...(has("edit_comment")
						? [
								`- ${family("comments").title}: ${code("edit_comment")} creates, resolves or deletes a comment. gardend signs it with the person you act for, via this session; pass no ${arg("author")}.`,
							]
						: []),
					...(tools("folders").length > 0
						? [
								`- ${family("folders").title}: ${list(tools("folders"))}${has("rename") ? " (rename a document or a folder, not the workspace)" : ""}.`,
							]
						: []),
				]
			: []),
		...(writes
			? (() => {
					const parts = [
						wiresReads.length > 0 ? list(wiresReads) : "",
						has("create_wires") ? `${code("create_wires")} makes one` : "",
						has("delete")
							? `${code("delete")} with ${arg("type")} "wires" and the wire's ${arg("wireId")} removes one (it removes nothing else here)`
							: "",
					].filter(Boolean);
					if (parts.length === 0) return [];
					const [first, ...rest] = parts;
					const head =
						wiresReads.length > 0 ? `${first}${rest.length > 0 ? `; ${rest.join(", and ")}` : ""}` : prose(parts, "and");
					return [`- ${family("wires").title} (typed links between documents and blocks): ${head}.`];
				})()
			: wiresReads.length > 0
				? [`- ${family("wires").title} (typed links between documents and blocks): ${list(wiresReads)}.`]
				: []),
		...(tools("values").length > 0
			? [`- ${family("values").title} (how much a block matters to the person): ${list(tools("values"))}.`]
			: []),
		...(tools("workflows").length > 0
			? [
					writes && has("workflow_plan_compose")
						? `- ${family("workflows").title}: a workflow is a document whose body says so; its plan is RDF that gardend keeps beside it. ${code("workflow_plan_read")} shows the plan and what it still lacks; ${code("workflow_plan_compose")} changes it with moves and a one-line ${arg("rationale")}, and the person watches each move land in the workflow pane${has("workflow_plan_create") ? `; ${code("workflow_plan_create")} makes a new one` : ""}. When the person asks you to plan or change a workflow, write the plan this way, never as prose in the workflow's body. The person approves and runs it; you never run it.${has("workflow_plan_publish") ? ` After a run, ${code("workflow_plan_publish")} puts its verified findings in the margin of the documents they name, as comments on their exact quotes: only when the person asks.` : ""}`
						: `- ${family("workflows").title}: ${code("workflow_plan_read")} shows the plan of a workflow (a document whose body says it is one).`,
				]
			: []),
		...(writes
			? artifactNames.length > 0 || has("custom_css")
				? [
						`- ${family("artifacts").title} (live pages in the workspace): ${[
							...(artifactNames.length > 0 ? [list(artifactNames)] : []),
							...(has("custom_css") ? [`${code("custom_css")} with ${arg("action")} "read" only, to learn the workspace's incarnation`] : []),
						].join(", and ")}.`,
					]
				: []
			: tools("artifacts").length > 0
				? [`- ${family("artifacts").title} (pages in the workspace): ${list(tools("artifacts"))}.`]
				: []),
		...(has("surface")
			? [`- ${family("surface").title}: ${code("surface")} turns a list of actions on documents into links the person can open.`]
			: []),
		input.agent
			? writes
				? "You cannot reach other workspaces through these tools, and you cannot change the workspace's RDF directly (no SPARQL UPDATE, no RDF loads) or recompute its values in bulk: change documents, wires and values with the tools above."
				: "You cannot reach other workspaces through these tools."
			: writes
				? "You cannot reach other workspaces, browse the web or run code, and you cannot change the workspace's RDF directly (no SPARQL UPDATE, no RDF loads) or recompute its values in bulk: change documents, wires and values with the tools above."
				: "You cannot reach other workspaces, browse the web or run code.",
		`Tool arguments are camelCase (${arg("documentId")}, ${arg("blockId")}) unless a tool's schema names only another spelling.`,
	];

	const finders = ["search_documents", "list_documents", "get_workspace"].filter((tool) => handed.has(tool)).map(code);
	const alternatives = ["search_blocks", "semantic_search", "list_documents", "get_workspace"]
		.filter((tool) => handed.has(tool))
		.map(code);
	const numbered: string[] = [];
	const rule = (text: string) => {
		numbered.push(`${numbered.filter((entry) => /^\d+\. /.test(entry)).length + 1}. ${text}`);
	};
	rule(
		`Ids are not titles. Documents, blocks, folders and artifacts are named by ids made of letters, digits, hyphens and underscores; a title such as "Q3 plan" is not an id and will be refused. To open something the person names, find its id first with ${prose(finders, "or")}, then read it by that id.`,
	);
	rule(
		`Search before you give up. If a read fails or a search${has("datasheet_facts") ? ` or ${code("datasheet_facts")}` : ""} finds nothing, try another way before saying something is not here: ${prose(["a shorter or different query", ...alternatives], "or")}.`,
	);
	if (has("datasheet_facts")) {
		rule(
			[
				`Parts. Search the documents for a part number before you ask ${code("datasheet_facts")} about it: they say what each part does here and the values chosen for this design.`,
				`Ask ${code("datasheet_facts")} as well when the question is about a part's electrical facts (ratings, voltages, currents, frequencies), and cite the datasheet and page.`,
				"If it finds nothing, the part's datasheet is not imported: answer from the documents, and never refuse for that reason.",
				has("get_workspace")
					? `A workspace whose documents do not name its parts may hold only files: ${code("get_workspace")} lists them, and a datasheet's file name usually carries its part number.`
					: "",
				"Do not guess a value that neither gives.",
			]
				.filter(Boolean)
				.join(" "),
		);
	}
	if (writes) {
		const smallest = ["edit_block_text", "update_blocks"].filter((tool) => handed.has(tool)).map(code);
		rule(
			[
				`Read before you write. Read the current content right before you change it, and make the smallest change that does the job${smallest.length > 0 ? `: ${prose(smallest, "or")} rather than rewriting a document` : ""}.`,
				...(has("write_document", "read_document")
					? [`When you use ${code("write_document")}, pass the revision from your last ${code("read_document")} as ${arg("expectedRevision")}.`]
					: []),
				"If a write is refused because the content changed, read it again and reconcile: never overwrite newer work by retrying blindly. If a write is refused for permission, say so plainly and stop trying.",
			].join(" "),
		);
		const history = has("get_document_history", "read_document_at_snapshot");
		const blocksBack = (has("delete_blocks") || has("edit_comment")) && history;
		if (has("delete_blocks") || has("edit_comment") || has("delete_document") || has("delete")) {
			rule(
				[
					"Delete only what the person asked you to delete.",
					...(blocksBack
						? [
								`Deleted blocks and comments stay recoverable: the document's History keeps every saved version (${code("get_document_history")}, ${code("read_document_at_snapshot")}), so after deleting them, name what you removed and say it can be brought back from the document's History.`,
							]
						: []),
					...(has("delete_document")
						? [
								`${blocksBack ? "Deleting a whole document is different: " : ""}${code("delete_document")} removes the document together with its history, so it cannot be undone from History. Delete a document only when the person has asked for that document; if the request could mean more than one, name the ones you would delete, say their history goes with them, and ask first. Every time you delete a document, say plainly in your reply that its history was deleted with it and that it cannot be brought back from History.`,
							]
						: []),
					...(has("delete")
						? [
								`Remove a wire with ${code("delete")}, ${arg("type")} "wires" and the wire's ${arg("wireId")}${has("get_wires") ? ` from ${code("get_wires")}` : ""}, the same way a person removes one.`,
							]
						: []),
				].join(" "),
			);
		}
		if (has("create_artifact_text", "write_artifact_text", "read_artifact")) {
			rule(
				"HTML artifacts are how you make a live view: a page that everyone who has it open sees change as soon as you write a new version, such as a dashboard, a table of what the workspace holds or a status board. Use HTML and CSS only: scripts do not run, nothing loads from the network, and images must be data: URIs.",
			);
			// These two tools take snake_case arguments only (their live schemas forbid other names).
			numbered.push(
				`   - You need the workspace's ${arg("graph_incarnation")} (the id of this life of the workspace) to create or change one. Take it from ${code("read_artifact")} with ${arg("strict_utf8")}: true on any existing HTML or text artifact${has("custom_css") ? `, or from ${code("custom_css")} with ${arg("action")} "read"` : ""}. Never invent one.`,
				`   - Create: ${code("create_artifact_text")} with a new ${arg("artifact_id")} and a new ${arg("operation_id")} that you make up (lowercase letters, digits and hyphens), a filename ending in .html, ${arg("mime_type")} "text/html", the ${arg("graph_incarnation")} and the complete text; ${arg("parent_id")} puts it in a folder.`,
				`   - Change: ${code("read_artifact")} with ${arg("strict_utf8")}: true for the current text and its ${arg("contentHashSha256")}, then ${code("write_artifact_text")} with ${arg("expected_content_sha256")} set to that hash, a new ${arg("operation_id")} and the complete new text. If it is refused because the hash changed, someone else changed the page: read it again and merge, never just retry with the new hash. Reuse an ${arg("operation_id")} only to repeat the very same request after a timeout.`,
			);
			const revisions = [
				has("list_artifact_revisions") ? `${code("list_artifact_revisions")} shows earlier versions` : "",
				has("restore_artifact_revision") ? `${code("restore_artifact_revision")} brings one back (it keeps the current version first)` : "",
			].filter(Boolean);
			if (revisions.length > 0) numbered.push(`   - ${revisions.join(", and ")}.`);
		}
		const wiresAndValues = [
			has("create_wires")
				? `Wire two documents or blocks with ${code("create_wires")} when one refers to, depends on, contradicts or answers the other and the person would want to follow that link${has("list_wire_predicates") ? `; call ${code("list_wire_predicates")} first and use an existing predicate` : ""}.`
				: "",
			has("value") ? `Use ${code("value")} to record how much a block matters (importance and valence) when the person says so, not as a guess.` : "",
		].filter(Boolean);
		if (wiresAndValues.length > 0) rule(`Wires and values. ${wiresAndValues.join(" ")}`);
		rule(
			has("surface")
				? `Cite and show your work. Name the documents your answer comes from. After you change anything, call ${code("surface")} once with every action of this turn (${arg("documentId")}, ${arg("blockId")} when there is one, and a short action word such as created, edited, moved, commented or deleted), so the person gets a link to open each change; then say in words what you changed and where an earlier version can be found.`
				: "Cite and show your work. Name the documents your answer comes from. After you change anything, say in words what you changed and where an earlier version can be found.",
		);
	} else {
		rule(
			has("surface")
				? `Cite what you use. Name the documents your answer comes from, and use ${code("surface")} to give the person links to the documents and blocks you mean.`
				: "Cite what you use. Name the documents your answer comes from.",
		);
	}

	const rules = [
		...numbered,
		'A message may end with a note in parentheses naming what the person has open; "this document" means the first thing named there.',
		"Answer plainly and briefly. If you did not find something after trying other ways, say so and say what you tried.",
	].join("\n");
	const toolsText = toolLines.join("\n");
	const box = input.agent ? agentBox(input.agent) : "";
	return {
		intro,
		tools: toolsText,
		rules,
		box,
		text: [intro, "", toolsText, ...(box ? ["", box] : []), "", "How to work:", rules].join("\n"),
	};
}

/** The `agent_box` section: what an agent body's own tools reach, and what they do not. */
function agentBox(agent: { readonly workdir: string; readonly isolation: string }): string {
	return [
		`You also have a computer of your own: a private working folder, ${"`"}${agent.workdir}${"`"}, which is your current directory, with pi's tools ${"`read`"}, ${"`write`"}, ${"`edit`"} and ${"`bash`"}.`,
		`It runs in an isolated box (${agent.isolation}): you can write only inside that folder and in /tmp, the rest of the system is read-only, and the person's own files are not there. The network is open.`,
		"Files in the folder are not workspace documents: to put something in the workspace, use the workspace tools above; to work on something from the workspace, read it with them and write it into the folder.",
		"If a command or a write outside the folder is refused, that is the box: say so instead of trying to get around it.",
	].join("\n");
}

/** At most this many open references are named to the model. */
export const TURN_CONTEXT_REFS_RENDERED = 8;
/** A document, artifact or folder id, optionally `#` a block id: the cell's id grammar. */
const ID_REF = /^[A-Za-z0-9_-]{1,128}(?:#[A-Za-z0-9_-]{1,128})?$/;

/**
 * The text a turn is given to the model with: the person's words, then (when they have something open) one
 * note naming it by id, so "this document" resolves. References that are not id-shaped are never rendered:
 * nothing a client sends reaches the model as prose. With nothing renderable it is exactly the person's words.
 */
export function turnTextForModel(text: string, refs: readonly string[] | undefined): string {
	const named = [...new Set((refs ?? []).filter((ref) => typeof ref === "string" && ID_REF.test(ref)))].slice(
		0,
		TURN_CONTEXT_REFS_RENDERED,
	);
	if (named.length === 0) return text;
	return `${text}\n\n(Open in the person's view, by id: ${named.map((ref) => `\`${ref}\``).join(", ")}. "This document" means the first.)`;
}
