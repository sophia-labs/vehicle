/**
 * Which of gardend's tools a Sophia chat is handed, by access. Carried over from Sophia's earlier
 * hosted chat (its `workspace-chat-v1` contract): one table
 * feeds both the tool manifest and the prompt, so the prompt never names a tool the session is not handed
 * and never leaves a handed tool undescribed.
 *
 * Authority is the person's role on the graph, minted by gardend: owners and editors get the writer
 * manifest, viewers the reader manifest. gardend's token scopes remain the outer wall; this table is what
 * the model is offered.
 */

/** `contributor`: a signed-in visitor of a public Sophia, who writes only inside its visitors' folder (gardend's fence). */
export type SophiaRole = "owner" | "editor" | "contributor" | "viewer";
export type SophiaAccess = "read" | "write";
/**
 * `chat`: graph tools only, pi's built-ins disabled; the body runs in the host's process.
 * `agent`: the graph tools plus pi's built-ins `read`, `write`, `edit` and `bash` on a private working folder; the
 * body runs as an isolated `pi --mode rpc` child (vehicle-host's isolation tiers), and only a graph's owner starts one.
 */
export type SophiaProfile = "chat" | "agent";

export const SOPHIA_PROFILES: readonly SophiaProfile[] = Object.freeze(["chat", "agent"]);

export function isSophiaProfile(value: unknown): value is SophiaProfile {
	return value === "chat" || value === "agent";
}

/** pi's built-in tools an `agent` body is handed: its working folder and a shell, inside the box. */
export const AGENT_BUILTINS: readonly string[] = Object.freeze(["read", "write", "edit", "bash"]);

export interface ToolFamily {
	readonly id: string;
	/** The heading the prompt gives this family. */
	readonly title: string;
	/** Tools whose effects are all reads. Every role gets them. */
	readonly read: readonly string[];
	/** Tools that write. Owners and editors only. */
	readonly write: readonly string[];
}

export const TOOL_FAMILIES: readonly ToolFamily[] = Object.freeze([
	{
		id: "find",
		title: "Find",
		read: [
			"search_documents",
			"search_blocks",
			"semantic_search",
			// gardend's entity search over the graph's own RDF (where its owner turned it on)
			"find",
			"list_documents",
			"get_workspace",
			"quick_orient",
			"sparql_query",
		],
		write: [],
	},
	{
		id: "read",
		title: "Read",
		read: ["read_document", "read_blocks", "get_block", "query_blocks", "document_digest"],
		write: [],
	},
	{ id: "history", title: "History", read: ["get_document_history", "read_document_at_snapshot"], write: [] },
	// Datasheets are files (PDFs), not documents: what one says about a part is read through its import.
	{ id: "datasheets", title: "Datasheets", read: ["datasheet_facts"], write: [] },
	{
		id: "documents",
		title: "Write documents",
		read: [],
		write: [
			"create_document",
			"write_document",
			"insert_blocks",
			"update_blocks",
			"edit_block_text",
			"delete_blocks",
			"delete_document",
		],
	},
	{ id: "comments", title: "Comments", read: [], write: ["edit_comment"] },
	{ id: "folders", title: "Folders", read: [], write: ["create_folder", "move_documents", "move_folder", "rename"] },
	{
		id: "wires",
		title: "Wires",
		read: ["get_wires", "traverse_wires", "list_wire_predicates"],
		write: ["create_wires", "delete"],
	},
	{ id: "values", title: "Values", read: ["get_values", "get_block_values", "get_important_blocks"], write: ["value"] },
	// A workflow is a document whose plan is RDF gardend keeps beside it (its body says so). The plan changes only through
	// compose moves the person watches land in the workflow pane, never as raw RDF and never as prose in the body.
	{
		id: "workflows",
		title: "Workflows",
		read: ["workflow_plan_read"],
		write: ["workflow_plan_create", "workflow_plan_compose"],
	},
	{
		id: "artifacts",
		title: "HTML artifacts",
		read: ["read_artifact", "list_artifact_revisions"],
		write: ["create_artifact_text", "write_artifact_text", "restore_artifact_revision", "custom_css"],
	},
	{ id: "surface", title: "Show your work", read: ["surface"], write: [] },
]);

/**
 * Cell tools kept out of chat on purpose: graph-wide acts, raw write faces, Geist memory, and tools whose
 * effects the person could not see or undo from a document's history (`sparql_update`, `rdf_load` and
 * `revaluate` also write around the graph's source ledger).
 */
export const EXCLUDED_TOOLS: readonly string[] = Object.freeze([
	"crdt_operation",
	"sparql_update",
	"sparql_query_named",
	"rdf_load",
	"rdf_dump",
	"create_restore_point",
	"restore_to_restore_point",
	"delete_restore_point",
	"list_restore_points",
	"get_restore_point",
	"diff_restore_points",
	"get_restore_operation",
	"cancel_restore_operation",
	"create_document_once",
	"make_document_editable",
	"ingest_artifact",
	"edit_artifact_image",
	"list_artifact_kinds",
	"flush_crdt",
	"reindex_graph",
	"update_graph",
	"revaluate",
	"emporium_write",
	"emporium_retract",
	"emporium_sweep",
	"workflow_book_apply",
	"workflow_book_compose",
	"source_pull",
	"source_push",
	"source_rebuild",
	"flow_seed_board",
	"propose_domain_ontology",
	"context_bundle",
	"music",
	"recall",
	"remember",
	"remember_batch",
	"sing",
	"care",
	"archive_memories",
	"backfill_memory_projection",
	"memory_semantic_recall",
	"status",
	"agent_self_image",
	"query_graph",
	"cancel_job",
]);

/** A chat cannot do its job without these. */
export const REQUIRED_TOOLS: readonly string[] = Object.freeze(["read_document", "search_documents"]);

const ROLES: ReadonlySet<string> = new Set(["owner", "editor", "contributor", "viewer"]);

export function isSophiaRole(value: unknown): value is SophiaRole {
	return typeof value === "string" && ROLES.has(value);
}

export function accessForRole(role: SophiaRole): SophiaAccess {
	return role === "viewer" ? "read" : "write";
}

/** The exact cell tool list for an access level, sorted. */
export function chatTools(access: SophiaAccess): readonly string[] {
	const tools = TOOL_FAMILIES.flatMap((family) =>
		access === "write" ? [...family.read, ...family.write] : [...family.read],
	);
	return Object.freeze([...new Set(tools)].sort());
}

/** Every write tool of every family. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(TOOL_FAMILIES.flatMap((family) => family.write));
