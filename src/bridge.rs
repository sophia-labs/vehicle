use anyhow::{Context, Result, anyhow, bail};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::Path,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message as WsMessage, client::IntoClientRequest, http::header},
};
use yrs::sync::{Message as YMessage, SyncMessage, awareness::Awareness};
use yrs::types::Attrs;
use yrs::types::xml::{XmlElementRef, XmlFragment, XmlOut, XmlTextRef};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{
    Any, Assoc, Doc, IndexedSequence, Map as YMap, MapRef, OffsetKind, Options, Out, ReadTxn,
    StickyIndex, Text, Transact, Update, Xml, XmlElementPrelim, XmlTextPrelim,
};

const CONTENT_FIELD: &str = "content";

fn new_ydoc() -> Doc {
    Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    })
}

const EDITABLE_TEXT_NODES: &[&str] = &[
    "paragraph",
    "heading",
    "listItem",
    "blockquote",
    "codeBlock",
];

const COMMAND_ONLY_NODES: &[&str] = &[
    "horizontalRule",
    "image",
    "mathBlock",
    "footnote",
    "wikilink",
    "mathInline",
    "hardBreak",
];

const INLINE_ATOM_NODES: &[&str] = &["footnote", "wikilink", "mathInline", "hardBreak"];

const READ_ONLY_OPAQUE_NODES: &[&str] = &[
    "table",
    "tableRow",
    "tableHeader",
    "tableCell",
    "queryBlock",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BridgeProjection {
    pub format_version: u32,
    pub document_id: String,
    pub title: Option<String>,
    pub tiptap_json: Value,
    pub tiptap_xml: String,
    pub doc_view: DocView,
    pub lines: Vec<BridgeLine>,
    pub comments: Vec<BridgeComment>,
    pub unsupported: Vec<UnsupportedRegion>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BridgeComment {
    pub comment_id: String,
    pub data: Value,
    pub block_id: Option<String>,
    pub start_utf16: Option<usize>,
    pub end_utf16: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DocView {
    pub document_id: String,
    pub revision: u64,
    pub blocks: Vec<BlockView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BlockView {
    pub block_id: String,
    pub node_type: String,
    pub attrs: BTreeMap<String, Value>,
    pub text: String,
    pub support: SupportLevel,
    pub marks: Vec<InlineMark>,
    pub inline_atoms: Vec<InlineAtom>,
    pub children: Vec<BlockView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BridgeLine {
    pub block_id: String,
    pub node_type: String,
    pub text: String,
    pub support: SupportLevel,
    pub attrs: BTreeMap<String, Value>,
    pub marks: Vec<InlineMark>,
    pub inline_atoms: Vec<InlineAtom>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InlineAtom {
    pub atom_type: String,
    pub atom_index: usize,
    pub offset_utf16: usize,
    pub attrs: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SupportLevel {
    EditableText,
    CommandOnly,
    ReadOnlyOpaque,
    HiddenMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InlineMark {
    pub mark_type: String,
    pub start_utf16: usize,
    pub end_utf16: usize,
    pub attrs: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UnsupportedRegion {
    pub block_id: Option<String>,
    pub node_type: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BridgeSaveRequest {
    pub lines: Vec<BridgeSaveLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BridgeSaveLine {
    pub block_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BridgeMutationRequest {
    pub document_id: Option<String>,
    pub title: Option<String>,
    pub operations: Vec<BridgeOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum BridgeOperation {
    ReplaceBlockText {
        block_id: String,
        text: String,
    },
    InsertText {
        block_id: String,
        offset_utf16: usize,
        text: String,
    },
    DeleteText {
        block_id: String,
        offset_utf16: usize,
        len_utf16: usize,
    },
    FormatText {
        block_id: String,
        offset_utf16: usize,
        len_utf16: usize,
        mark_type: String,
        attrs: Option<BTreeMap<String, Value>>,
    },
    SplitBlock {
        block_id: String,
        offset_utf16: usize,
        new_block_id: Option<String>,
    },
    JoinNext {
        block_id: String,
    },
    InsertBlock {
        after_block_id: Option<String>,
        block: Value,
    },
    DeleteBlock {
        block_id: String,
    },
    MoveBlock {
        block_id: String,
        after_block_id: Option<String>,
    },
    SetBlockAttrs {
        block_id: String,
        attrs: BTreeMap<String, Value>,
    },
    CreateInlineComment {
        comment_id: String,
        block_id: String,
        offset_utf16: usize,
        len_utf16: usize,
        text: String,
        author: String,
        author_id: String,
    },
    CreateBlockComment {
        comment_id: String,
        block_id: String,
        text: String,
        author: String,
        author_id: String,
    },
    UpdateComment {
        comment_id: String,
        text: Option<String>,
        resolved: Option<bool>,
    },
    DeleteComment {
        comment_id: String,
    },
    InsertFootnote {
        block_id: String,
        offset_utf16: usize,
        content: String,
    },
    UpdateFootnote {
        block_id: String,
        atom_index: usize,
        content: String,
    },
    DeleteFootnote {
        block_id: String,
        atom_index: usize,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GardenJsonDocument {
    pub document_id: String,
    pub title: String,
    pub blocks: Vec<GardenJsonBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GardenJsonBlock {
    pub block_id: String,
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LiveBridgeCommand {
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OpenYdocFileParams {
    pub path: PathBuf,
    pub document_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OpenYdocRoomParams {
    pub path: PathBuf,
    pub document_id: String,
    pub url: String,
    pub token: Option<String>,
    pub token_env: Option<String>,
    pub on_behalf_of: Option<String>,
    pub on_behalf_of_env: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LiveApplyParams {
    pub request: BridgeMutationRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LiveAwarenessParams {
    pub user: Value,
    pub block_id: String,
    pub offset_utf16: usize,
    pub selection_end_utf16: Option<usize>,
}

pub fn project_json_document_path(path: &Path) -> Result<BridgeProjection> {
    let document: GardenJsonDocument = serde_json::from_str(
        &fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?,
    )
    .with_context(|| format!("parse {}", path.display()))?;
    project_json_document(&document)
}

pub fn project_json_document(document: &GardenJsonDocument) -> Result<BridgeProjection> {
    let tiptap_json = garden_json_to_tiptap_json(document);
    let doc = ydoc_from_tiptap_json(&tiptap_json)?;
    Ok(project_ydoc(
        &doc,
        &document.document_id,
        Some(document.title.clone()),
        0,
    ))
}

pub fn save_json_document_path(
    path: &Path,
    request: BridgeSaveRequest,
) -> Result<BridgeProjection> {
    let mut document: GardenJsonDocument = serde_json::from_str(
        &fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?,
    )
    .with_context(|| format!("parse {}", path.display()))?;
    let updates = request
        .lines
        .into_iter()
        .map(|line| (line.block_id, line.text))
        .collect::<BTreeMap<_, _>>();
    let known = document
        .blocks
        .iter()
        .map(|block| block.block_id.clone())
        .collect::<BTreeSet<_>>();
    for block_id in updates.keys() {
        if !known.contains(block_id) {
            bail!("save-json references unknown block_id {block_id}");
        }
    }
    for block in &mut document.blocks {
        if let Some(text) = updates.get(&block.block_id) {
            block.text = text.clone();
        }
    }
    fs::write(path, serde_json::to_string_pretty(&document)?)
        .with_context(|| format!("write {}", path.display()))?;
    project_json_document(&document)
}

pub fn read_ydoc_update_v1(path: &Path) -> Result<Doc> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    ydoc_from_update_v1(&bytes)
}

pub fn ydoc_from_update_v1(bytes: &[u8]) -> Result<Doc> {
    let doc = new_ydoc();
    if !bytes.is_empty() {
        let update = Update::decode_v1(bytes).context("decode update-v1")?;
        let mut txn = doc.transact_mut();
        txn.apply_update(update).context("apply update-v1")?;
    }
    Ok(doc)
}

pub fn write_ydoc_update_v1(path: &Path, doc: &Doc) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("mkdir {}", parent.display()))?;
    }
    fs::write(path, encode_update_v1(doc)).with_context(|| format!("write {}", path.display()))
}

pub fn encode_update_v1(doc: &Doc) -> Vec<u8> {
    let txn = doc.transact();
    txn.encode_state_as_update_v1(&yrs::StateVector::default())
}

pub fn init_ydoc_from_json_path(json_path: &Path, output_path: &Path) -> Result<BridgeProjection> {
    let document: GardenJsonDocument = serde_json::from_str(
        &fs::read_to_string(json_path).with_context(|| format!("read {}", json_path.display()))?,
    )
    .with_context(|| format!("parse {}", json_path.display()))?;
    let tiptap_json = garden_json_to_tiptap_json(&document);
    let doc = ydoc_from_tiptap_json(&tiptap_json)?;
    write_ydoc_update_v1(output_path, &doc)?;
    Ok(project_ydoc(
        &doc,
        &document.document_id,
        Some(document.title),
        0,
    ))
}

pub fn project_ydoc_path(path: &Path, document_id: &str) -> Result<BridgeProjection> {
    let doc = read_ydoc_update_v1(path)?;
    Ok(project_ydoc(&doc, document_id, None, 0))
}

pub fn apply_ydoc_mutations_path(
    path: &Path,
    document_id: &str,
    request: BridgeMutationRequest,
) -> Result<BridgeProjection> {
    let doc = read_ydoc_update_v1(path)?;
    apply_mutations_to_ydoc(&doc, &request)?;
    write_ydoc_update_v1(path, &doc)?;
    Ok(project_ydoc(&doc, document_id, request.title, 0))
}

pub async fn sync_ydoc_once_path(
    path: &Path,
    document_id: &str,
    url: &str,
    bearer_token: Option<&str>,
    on_behalf_of: Option<&str>,
    timeout: Duration,
) -> Result<BridgeProjection> {
    let doc = if path.exists() {
        read_ydoc_update_v1(path)?
    } else {
        new_ydoc()
    };

    let mut request = url
        .into_client_request()
        .with_context(|| format!("build websocket request for {url}"))?;
    if let Some(token) = bearer_token.filter(|token| !token.is_empty()) {
        request.headers_mut().insert(
            header::AUTHORIZATION,
            format!("Bearer {token}")
                .parse()
                .context("build authorization header")?,
        );
    }
    if let Some(subject) = on_behalf_of.filter(|subject| !subject.is_empty()) {
        request.headers_mut().insert(
            header::HeaderName::from_static("x-pn-on-behalf-of"),
            subject.parse().context("build x-pn-on-behalf-of header")?,
        );
    }

    let (mut socket, _) = connect_async(request)
        .await
        .with_context(|| format!("connect websocket {url}"))?;

    let initial_step1 = {
        let txn = doc.transact();
        YMessage::Sync(SyncMessage::SyncStep1(txn.state_vector())).encode_v1()
    };
    socket
        .send(WsMessage::Binary(initial_step1.into()))
        .await
        .context("send initial sync step1")?;

    let deadline = tokio::time::Instant::now() + timeout;
    let mut saw_server_state = false;
    let mut saw_any_message = false;

    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            break;
        }
        let remaining = deadline - now;
        let next = tokio::time::timeout(remaining, socket.next()).await;
        let Some(frame) =
            next.map_err(|_| anyhow!("sync timed out after {}ms", timeout.as_millis()))?
        else {
            break;
        };
        let frame = frame.context("read websocket frame")?;
        let WsMessage::Binary(data) = frame else {
            continue;
        };
        saw_any_message = true;
        let message = YMessage::decode_v1(&data).context("decode y-protocol message")?;
        match message {
            YMessage::Sync(SyncMessage::SyncStep1(state_vector)) => {
                let update = {
                    let txn = doc.transact();
                    txn.encode_state_as_update_v1(&state_vector)
                };
                socket
                    .send(WsMessage::Binary(
                        YMessage::Sync(SyncMessage::SyncStep2(update))
                            .encode_v1()
                            .into(),
                    ))
                    .await
                    .context("send sync step2")?;
            }
            YMessage::Sync(SyncMessage::SyncStep2(update))
            | YMessage::Sync(SyncMessage::Update(update)) => {
                let decoded = Update::decode_v1(&update).context("decode remote update")?;
                let mut txn = doc.transact_mut();
                txn.apply_update(decoded).context("apply remote update")?;
                saw_server_state = true;
            }
            YMessage::Awareness(_) | YMessage::AwarenessQuery => {}
            YMessage::Auth(_) | YMessage::Custom(..) => {}
        }
        if saw_server_state {
            break;
        }
    }

    if !saw_any_message {
        bail!("websocket sync completed without receiving any y-protocol messages");
    }

    write_ydoc_update_v1(path, &doc)?;
    Ok(project_ydoc(&doc, document_id, None, 0))
}

pub fn apply_mutations_to_ydoc(doc: &Doc, request: &BridgeMutationRequest) -> Result<()> {
    let fragment = doc.get_or_insert_xml_fragment(CONTENT_FIELD);
    let needs_comments = request.operations.iter().any(|op| {
        matches!(
            op,
            BridgeOperation::CreateInlineComment { .. }
                | BridgeOperation::CreateBlockComment { .. }
                | BridgeOperation::UpdateComment { .. }
                | BridgeOperation::DeleteComment { .. }
        )
    });
    let comments = needs_comments.then(|| doc.get_or_insert_map("comments"));
    let mut txn = doc.transact_mut();
    for op in &request.operations {
        apply_ydoc_operation(&mut txn, &fragment, comments.as_ref(), op)?;
    }
    Ok(())
}

fn apply_ydoc_operation(
    txn: &mut yrs::TransactionMut<'_>,
    fragment: &yrs::XmlFragmentRef,
    comments: Option<&MapRef>,
    op: &BridgeOperation,
) -> Result<()> {
    match op {
        BridgeOperation::ReplaceBlockText { block_id, text } => {
            let (element, _) = find_ydoc_block(txn, fragment, block_id)
                .ok_or_else(|| anyhow!("block {block_id} not found"))?;
            ensure_ydoc_editable(&element)?;
            replace_ydoc_block_text_preserving_structure(txn, &element, text)?;
        }
        BridgeOperation::InsertText {
            block_id,
            offset_utf16,
            text,
        } => {
            let (element, _) = find_ydoc_block(txn, fragment, block_id)
                .ok_or_else(|| anyhow!("block {block_id} not found"))?;
            ensure_ydoc_editable(&element)?;
            insert_ydoc_text(txn, &element, *offset_utf16, text)?;
        }
        BridgeOperation::DeleteText {
            block_id,
            offset_utf16,
            len_utf16,
        } => {
            let (element, _) = find_ydoc_block(txn, fragment, block_id)
                .ok_or_else(|| anyhow!("block {block_id} not found"))?;
            ensure_ydoc_editable(&element)?;
            delete_ydoc_text(txn, &element, *offset_utf16, *len_utf16)?;
        }
        BridgeOperation::FormatText {
            block_id,
            offset_utf16,
            len_utf16,
            mark_type,
            attrs,
        } => {
            let (element, _) = find_ydoc_block(txn, fragment, block_id)
                .ok_or_else(|| anyhow!("block {block_id} not found"))?;
            ensure_ydoc_editable(&element)?;
            format_ydoc_text(txn, &element, *offset_utf16, *len_utf16, mark_type, attrs)?;
        }
        BridgeOperation::SplitBlock {
            block_id,
            offset_utf16,
            new_block_id,
        } => split_ydoc_block(txn, fragment, block_id, *offset_utf16, new_block_id.clone())?,
        BridgeOperation::JoinNext { block_id } => join_next_ydoc_block(txn, fragment, block_id)?,
        BridgeOperation::InsertBlock {
            after_block_id,
            block,
        } => insert_ydoc_block(txn, fragment, after_block_id.as_deref(), block)?,
        BridgeOperation::DeleteBlock { block_id } => delete_ydoc_block(txn, fragment, block_id)?,
        BridgeOperation::MoveBlock {
            block_id,
            after_block_id,
        } => move_ydoc_block(txn, fragment, block_id, after_block_id.as_deref())?,
        BridgeOperation::SetBlockAttrs { block_id, attrs } => {
            let (element, _) = find_ydoc_block(txn, fragment, block_id)
                .ok_or_else(|| anyhow!("block {block_id} not found"))?;
            for (key, value) in attrs {
                if value.is_null() {
                    element.remove_attribute(txn, key);
                } else {
                    element.insert_attribute(txn, key.clone(), json_to_any(value));
                }
            }
            element.insert_attribute(txn, "data-block-id", Any::from(block_id.as_str()));
        }
        BridgeOperation::CreateInlineComment {
            comment_id,
            block_id,
            offset_utf16,
            len_utf16,
            text,
            author,
            author_id,
        } => create_inline_comment(
            txn,
            fragment,
            comments.ok_or_else(|| anyhow!("comments map unavailable"))?,
            comment_id,
            block_id,
            *offset_utf16,
            *len_utf16,
            text,
            author,
            author_id,
        )?,
        BridgeOperation::CreateBlockComment {
            comment_id,
            block_id,
            text,
            author,
            author_id,
        } => create_block_comment(
            txn,
            fragment,
            comments.ok_or_else(|| anyhow!("comments map unavailable"))?,
            comment_id,
            block_id,
            text,
            author,
            author_id,
        )?,
        BridgeOperation::UpdateComment {
            comment_id,
            text,
            resolved,
        } => update_comment(
            txn,
            comments.ok_or_else(|| anyhow!("comments map unavailable"))?,
            comment_id,
            text.as_deref(),
            *resolved,
        )?,
        BridgeOperation::DeleteComment { comment_id } => {
            clear_comment_marks(txn, fragment, comment_id)?;
            comments
                .ok_or_else(|| anyhow!("comments map unavailable"))?
                .remove(txn, comment_id);
        }
        BridgeOperation::InsertFootnote {
            block_id,
            offset_utf16,
            content,
        } => insert_ydoc_footnote(txn, fragment, block_id, *offset_utf16, content)?,
        BridgeOperation::UpdateFootnote {
            block_id,
            atom_index,
            content,
        } => update_ydoc_footnote(txn, fragment, block_id, *atom_index, content)?,
        BridgeOperation::DeleteFootnote {
            block_id,
            atom_index,
        } => delete_ydoc_footnote(txn, fragment, block_id, *atom_index)?,
    }
    Ok(())
}

fn find_ydoc_block<T: ReadTxn>(
    txn: &T,
    fragment: &yrs::XmlFragmentRef,
    block_id: &str,
) -> Option<(XmlElementRef, u32)> {
    for (index, child) in fragment.children(txn).enumerate() {
        if let XmlOut::Element(element) = child
            && ydoc_block_id(txn, &element).as_deref() == Some(block_id)
        {
            return Some((element, index as u32));
        }
    }
    None
}

fn ydoc_block_id<T: ReadTxn>(txn: &T, element: &XmlElementRef) -> Option<String> {
    let attr = element
        .get_attribute(txn, "data-block-id")
        .or_else(|| element.get_attribute(txn, "blockId"));
    match attr {
        Some(Out::Any(Any::String(value))) if !value.is_empty() => Some(value.to_string()),
        _ => None,
    }
}

fn ensure_ydoc_editable(element: &XmlElementRef) -> Result<()> {
    let node_type = element.tag().to_string();
    if support_for(&node_type) != SupportLevel::EditableText {
        bail!("{node_type} is not editable text in the Vehicle bridge draft");
    }
    Ok(())
}

fn replace_ydoc_block_text(txn: &mut yrs::TransactionMut<'_>, element: &XmlElementRef, text: &str) {
    let len = element.len(txn);
    if len > 0 {
        element.remove_range(txn, 0, len);
    }
    if !text.is_empty() {
        let text_ref = element.insert(txn, 0, XmlTextPrelim::new(""));
        text_ref.insert(txn, 0, text);
    }
}

fn replace_ydoc_block_text_preserving_structure(
    txn: &mut yrs::TransactionMut<'_>,
    element: &XmlElementRef,
    text: &str,
) -> Result<()> {
    let before = ydoc_block_text(txn, element);
    if before == text {
        return Ok(());
    }

    let mut prefix_bytes = 0usize;
    for (before_char, after_char) in before.chars().zip(text.chars()) {
        if before_char != after_char {
            break;
        }
        prefix_bytes += before_char.len_utf8();
    }

    let before_tail = &before[prefix_bytes..];
    let after_tail = &text[prefix_bytes..];
    let mut before_suffix_bytes = 0usize;
    let mut after_suffix_bytes = 0usize;
    for (before_char, after_char) in before_tail.chars().rev().zip(after_tail.chars().rev()) {
        if before_char != after_char {
            break;
        }
        before_suffix_bytes += before_char.len_utf8();
        after_suffix_bytes += after_char.len_utf8();
    }

    let before_middle_end = before.len() - before_suffix_bytes;
    let after_middle_end = text.len() - after_suffix_bytes;
    let offset_utf16 = utf16_len(&before[..prefix_bytes]);
    let delete_len_utf16 = utf16_len(&before[prefix_bytes..before_middle_end]);
    let replacement = &text[prefix_bytes..after_middle_end];

    if delete_len_utf16 > 0 {
        delete_ydoc_text(txn, element, offset_utf16, delete_len_utf16)?;
    }
    if !replacement.is_empty() {
        insert_ydoc_text(txn, element, offset_utf16, replacement)?;
    }
    Ok(())
}

#[derive(Clone)]
struct YdocTextSegment {
    text: XmlTextRef,
    start_utf16: usize,
    len_utf16: usize,
}

fn collect_ydoc_text_segments<T: ReadTxn>(
    txn: &T,
    element: &XmlElementRef,
) -> Vec<YdocTextSegment> {
    let mut segments = Vec::new();
    let mut stack: Vec<XmlOut> = element.children(txn).collect();
    stack.reverse();
    let mut cursor = 0usize;
    while let Some(node) = stack.pop() {
        match node {
            XmlOut::Text(text) => {
                let value = ydoc_text_content(txn, &text);
                let len_utf16 = utf16_len(&value);
                segments.push(YdocTextSegment {
                    text,
                    start_utf16: cursor,
                    len_utf16,
                });
                cursor += len_utf16;
            }
            XmlOut::Element(element) => {
                let mut children: Vec<XmlOut> = element.children(txn).collect();
                children.reverse();
                stack.extend(children);
            }
            XmlOut::Fragment(_) => {}
        }
    }
    segments
}

fn ydoc_text_content<T: ReadTxn>(txn: &T, text: &XmlTextRef) -> String {
    let mut out = String::new();
    for diff in text.diff(txn, yrs::types::text::YChange::identity) {
        if let Out::Any(Any::String(chunk)) = diff.insert {
            out.push_str(&chunk);
        }
    }
    out
}

fn ydoc_block_text<T: ReadTxn>(txn: &T, element: &XmlElementRef) -> String {
    collect_ydoc_text_segments(txn, element)
        .iter()
        .map(|segment| ydoc_text_content(txn, &segment.text))
        .collect::<Vec<_>>()
        .join("")
}

fn locate_ydoc_segment(
    segments: &[YdocTextSegment],
    offset_utf16: usize,
    total_utf16: usize,
) -> Option<(YdocTextSegment, usize)> {
    if segments.is_empty() {
        return None;
    }
    let clamped = offset_utf16.min(total_utf16);
    for segment in segments {
        let start = segment.start_utf16;
        let end = segment.start_utf16 + segment.len_utf16;
        if clamped > start && clamped <= end {
            return Some((segment.clone(), clamped - start));
        }
    }
    if clamped == 0 {
        return Some((segments[0].clone(), 0));
    }
    let last = segments.last()?.clone();
    Some((last.clone(), last.len_utf16))
}

fn sticky_index_for_block_offset(
    doc: &Doc,
    block_id: &str,
    offset_utf16: usize,
) -> Result<StickyIndex> {
    let fragment = doc.get_or_insert_xml_fragment(CONTENT_FIELD);
    let txn = doc.transact();
    let (element, _) = find_ydoc_block(&txn, &fragment, block_id)
        .ok_or_else(|| anyhow!("block {block_id} not found for awareness cursor"))?;
    let segments = collect_ydoc_text_segments(&txn, &element);
    let total_utf16 = segments
        .iter()
        .map(|segment| segment.len_utf16)
        .sum::<usize>();
    if offset_utf16 > total_utf16 {
        bail!("awareness cursor offset {offset_utf16} outside block text length {total_utf16}");
    }
    if segments.is_empty() || total_utf16 == 0 {
        return element
            .sticky_index(&txn, 0, Assoc::After)
            .ok_or_else(|| anyhow!("could not anchor awareness cursor in empty block {block_id}"));
    }

    // A zero-width inline atom creates two text segments with the same logical
    // UTF-16 boundary. Prefer the segment starting at that boundary: yrs cannot
    // always create a relative position at the tombstoned end of the segment
    // on the atom's left.
    let mut candidates = Vec::new();
    if offset_utf16 < total_utf16
        && let Some((index, _)) = segments.iter().enumerate().find(|(_, segment)| {
            offset_utf16 >= segment.start_utf16
                && offset_utf16 < segment.start_utf16 + segment.len_utf16
        })
    {
        candidates.push(index);
    }
    if offset_utf16 == total_utf16 {
        candidates.push(segments.len() - 1);
    }
    for (index, segment) in segments.iter().enumerate() {
        let end = segment.start_utf16 + segment.len_utf16;
        if offset_utf16 >= segment.start_utf16
            && offset_utf16 <= end
            && !candidates.contains(&index)
        {
            candidates.push(index);
        }
    }

    for index in candidates {
        let segment = &segments[index];
        let local_utf16 = offset_utf16.saturating_sub(segment.start_utf16);
        let current = ydoc_text_content(&txn, &segment.text);
        let index = match doc.offset_kind() {
            OffsetKind::Bytes => {
                byte_index_for_utf16(&current, local_utf16).unwrap_or(current.len())
            }
            OffsetKind::Utf16 => local_utf16,
        };
        if let Some(sticky) = segment
            .text
            .sticky_index(&txn, index as u32, Assoc::After)
            .or_else(|| segment.text.sticky_index(&txn, index as u32, Assoc::Before))
        {
            return Ok(sticky);
        }
    }
    Err(anyhow!(
        "could not anchor awareness cursor in block {block_id}"
    ))
}

fn utf16_offset_for_byte(value: &str, byte_offset: usize) -> usize {
    let mut end = byte_offset.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    utf16_len(&value[..end])
}

fn resolve_sticky_index(doc: &Doc, sticky: &StickyIndex) -> Option<(String, usize)> {
    let fragment = doc.get_or_insert_xml_fragment(CONTENT_FIELD);
    let txn = doc.transact();
    let offset = sticky.get_offset(&txn)?;
    for child in fragment.children(&txn) {
        let XmlOut::Element(element) = child else {
            continue;
        };
        let block_id = ydoc_block_id(&txn, &element)?;
        let element_branch = yrs::branch::BranchPtr::from(<XmlElementRef as AsRef<
            yrs::branch::Branch,
        >>::as_ref(&element));
        if offset.branch == element_branch {
            return Some((block_id, 0));
        }
        for segment in collect_ydoc_text_segments(&txn, &element) {
            let text_branch = yrs::branch::BranchPtr::from(<XmlTextRef as AsRef<
                yrs::branch::Branch,
            >>::as_ref(&segment.text));
            if offset.branch == text_branch {
                let text = ydoc_text_content(&txn, &segment.text);
                let local_utf16 = match doc.offset_kind() {
                    OffsetKind::Bytes => utf16_offset_for_byte(&text, offset.index as usize),
                    OffsetKind::Utf16 => offset.index as usize,
                };
                return Some((block_id, segment.start_utf16 + local_utf16));
            }
        }
    }
    None
}

fn awareness_timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn insert_ydoc_text(
    txn: &mut yrs::TransactionMut<'_>,
    element: &XmlElementRef,
    offset_utf16: usize,
    text: &str,
) -> Result<()> {
    let segments = collect_ydoc_text_segments(txn, element);
    let total_utf16 = segments
        .iter()
        .map(|segment| segment.len_utf16)
        .sum::<usize>();
    if offset_utf16 > total_utf16 {
        bail!("offset {offset_utf16} outside block text length {total_utf16}");
    }
    if segments.is_empty() {
        let text_ref = element.insert(txn, 0, XmlTextPrelim::new(""));
        text_ref.insert(txn, 0, text);
        return Ok(());
    }
    let (segment, local_utf16) = locate_ydoc_segment(&segments, offset_utf16, total_utf16)
        .ok_or_else(|| anyhow!("block has no text segment"))?;
    let current = ydoc_text_content(txn, &segment.text);
    let local_offset = match txn.doc().offset_kind() {
        OffsetKind::Bytes => byte_index_for_utf16(&current, local_utf16).unwrap_or(current.len()),
        OffsetKind::Utf16 => local_utf16,
    };
    segment.text.insert(txn, local_offset as u32, text);
    Ok(())
}

fn delete_ydoc_text(
    txn: &mut yrs::TransactionMut<'_>,
    element: &XmlElementRef,
    offset_utf16: usize,
    len_utf16: usize,
) -> Result<()> {
    let segments = collect_ydoc_text_segments(txn, element);
    let total_utf16 = segments
        .iter()
        .map(|segment| segment.len_utf16)
        .sum::<usize>();
    if offset_utf16 > total_utf16 || offset_utf16 + len_utf16 > total_utf16 {
        bail!(
            "delete range {}..{} outside block text length {}",
            offset_utf16,
            offset_utf16 + len_utf16,
            total_utf16
        );
    }
    let start = offset_utf16;
    let end = offset_utf16 + len_utf16;
    for segment in segments.iter().rev() {
        let seg_start = segment.start_utf16;
        let seg_end = seg_start + segment.len_utf16;
        if seg_end <= start || seg_start >= end {
            continue;
        }
        let local_start = start.saturating_sub(seg_start);
        let local_end = end.min(seg_end) - seg_start;
        if local_end <= local_start {
            continue;
        }
        let current = ydoc_text_content(txn, &segment.text);
        let (range_start, range_end) = match txn.doc().offset_kind() {
            OffsetKind::Bytes => (
                byte_index_for_utf16(&current, local_start).unwrap_or(0),
                byte_index_for_utf16(&current, local_end).unwrap_or(current.len()),
            ),
            OffsetKind::Utf16 => (local_start, local_end),
        };
        segment
            .text
            .remove_range(txn, range_start as u32, (range_end - range_start) as u32);
    }
    Ok(())
}

fn format_ydoc_text(
    txn: &mut yrs::TransactionMut<'_>,
    element: &XmlElementRef,
    offset_utf16: usize,
    len_utf16: usize,
    mark_type: &str,
    attrs: &Option<BTreeMap<String, Value>>,
) -> Result<()> {
    let segments = collect_ydoc_text_segments(txn, element);
    let total_utf16 = segments
        .iter()
        .map(|segment| segment.len_utf16)
        .sum::<usize>();
    if offset_utf16 > total_utf16 || offset_utf16 + len_utf16 > total_utf16 {
        bail!(
            "format range {}..{} outside block text length {}",
            offset_utf16,
            offset_utf16 + len_utf16,
            total_utf16
        );
    }
    let mut format_attrs = Attrs::new();
    let mark_value = match attrs {
        Some(attrs) => Value::Object(
            attrs
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        ),
        None => Value::Object(Map::new()),
    };
    format_attrs.insert(mark_type.into(), json_to_any(&mark_value));
    let start = offset_utf16;
    let end = offset_utf16 + len_utf16;
    for segment in &segments {
        let seg_start = segment.start_utf16;
        let seg_end = seg_start + segment.len_utf16;
        if seg_end <= start || seg_start >= end {
            continue;
        }
        let local_start = start.saturating_sub(seg_start);
        let local_end = end.min(seg_end) - seg_start;
        if local_end <= local_start {
            continue;
        }
        let current = ydoc_text_content(txn, &segment.text);
        let (range_start, range_end) = match txn.doc().offset_kind() {
            OffsetKind::Bytes => (
                byte_index_for_utf16(&current, local_start).unwrap_or(0),
                byte_index_for_utf16(&current, local_end).unwrap_or(current.len()),
            ),
            OffsetKind::Utf16 => (local_start, local_end),
        };
        segment.text.format(
            txn,
            range_start as u32,
            (range_end - range_start) as u32,
            format_attrs.clone(),
        );
    }
    Ok(())
}

fn utf16_slice(value: &str, offset_utf16: usize, len_utf16: usize) -> Result<String> {
    let start = byte_index_for_utf16(value, offset_utf16)
        .ok_or_else(|| anyhow!("UTF-16 offset {offset_utf16} is outside text"))?;
    let end_offset = offset_utf16 + len_utf16;
    let end = byte_index_for_utf16(value, end_offset)
        .ok_or_else(|| anyhow!("UTF-16 offset {end_offset} is outside text"))?;
    Ok(value[start..end].to_string())
}

fn comment_data(
    text: &str,
    author: &str,
    author_id: &str,
    quoted_text: &str,
    block_id: Option<&str>,
    document_position: Option<usize>,
) -> Value {
    let now = awareness_timestamp_ms() as u64;
    let mut data = Map::new();
    data.insert("text".to_string(), json!(text));
    data.insert("author".to_string(), json!(author));
    data.insert("authorId".to_string(), json!(author_id));
    data.insert("createdAt".to_string(), json!(now));
    data.insert("updatedAt".to_string(), json!(now));
    data.insert("resolved".to_string(), json!(false));
    data.insert("quotedText".to_string(), json!(quoted_text));
    if let Some(block_id) = block_id {
        data.insert("blockId".to_string(), json!(block_id));
    }
    if let Some(position) = document_position {
        data.insert("documentPosition".to_string(), json!(position));
    }
    Value::Object(data)
}

fn prose_mirror_leaf(node_type: &str) -> bool {
    matches!(
        node_type,
        "horizontalRule"
            | "image"
            | "mathBlock"
            | "queryBlock"
            | "footnote"
            | "wikilink"
            | "mathInline"
            | "hardBreak"
    )
}

fn prose_mirror_node_size(node: &Value) -> usize {
    let node_type = node.get("type").and_then(Value::as_str).unwrap_or("");
    if node_type == "text" {
        return utf16_len(node.get("text").and_then(Value::as_str).unwrap_or(""));
    }
    if prose_mirror_leaf(node_type) {
        return 1;
    }
    content_nodes(node)
        .iter()
        .map(prose_mirror_node_size)
        .sum::<usize>()
        + 2
}

fn prose_mirror_text_position(
    node: &Value,
    node_position: usize,
    target_utf16: usize,
    text_cursor: &mut usize,
) -> Option<usize> {
    let node_type = node.get("type").and_then(Value::as_str).unwrap_or("");
    if node_type == "text" {
        let len = utf16_len(node.get("text").and_then(Value::as_str).unwrap_or(""));
        if target_utf16 >= *text_cursor && target_utf16 <= *text_cursor + len {
            return Some(node_position + target_utf16 - *text_cursor);
        }
        *text_cursor += len;
        return None;
    }
    if prose_mirror_leaf(node_type) {
        return None;
    }

    let mut child_position = node_position + 1;
    for child in content_nodes(node) {
        if let Some(position) =
            prose_mirror_text_position(child, child_position, target_utf16, text_cursor)
        {
            return Some(position);
        }
        child_position += prose_mirror_node_size(child);
    }
    None
}

fn document_position_for_block_offset<T: ReadTxn>(
    txn: &T,
    fragment: &yrs::XmlFragmentRef,
    block_id: &str,
    offset_utf16: Option<usize>,
) -> Option<usize> {
    let mut block_position = 0usize;
    for child in fragment.children(txn) {
        let XmlOut::Element(element) = child else {
            continue;
        };
        let node = ydoc_element_to_tiptap_json(txn, &element);
        if ydoc_block_id(txn, &element).as_deref() == Some(block_id) {
            let Some(offset_utf16) = offset_utf16 else {
                return Some(block_position);
            };
            let total_utf16 = utf16_len(&plain_text(&node));
            if offset_utf16 > total_utf16 {
                return None;
            }
            if total_utf16 == 0 && offset_utf16 == 0 {
                return Some(block_position + 1);
            }
            return prose_mirror_text_position(&node, block_position, offset_utf16, &mut 0);
        }
        block_position += prose_mirror_node_size(&node);
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn create_inline_comment(
    txn: &mut yrs::TransactionMut<'_>,
    fragment: &yrs::XmlFragmentRef,
    comments: &MapRef,
    comment_id: &str,
    block_id: &str,
    offset_utf16: usize,
    len_utf16: usize,
    text: &str,
    author: &str,
    author_id: &str,
) -> Result<()> {
    if len_utf16 == 0 {
        bail!("inline comments require a non-empty text range");
    }
    if comments.contains_key(&*txn, comment_id) {
        bail!("comment {comment_id} already exists");
    }
    let (element, _) = find_ydoc_block(txn, fragment, block_id)
        .ok_or_else(|| anyhow!("block {block_id} not found"))?;
    ensure_ydoc_editable(&element)?;
    let block_text = ydoc_block_text(txn, &element);
    let quoted_text = utf16_slice(&block_text, offset_utf16, len_utf16)?;
    let document_position =
        document_position_for_block_offset(txn, fragment, block_id, Some(offset_utf16))
            .ok_or_else(|| anyhow!("could not resolve ProseMirror position in block {block_id}"))?;
    let mark_attrs = Some(BTreeMap::from([(
        "commentId".to_string(),
        json!(comment_id),
    )]));
    format_ydoc_text(
        txn,
        &element,
        offset_utf16,
        len_utf16,
        "commentMark",
        &mark_attrs,
    )?;
    let data = comment_data(
        text,
        author,
        author_id,
        &quoted_text,
        None,
        Some(document_position),
    );
    comments.insert(txn, comment_id, json_to_any(&data));
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn create_block_comment(
    txn: &mut yrs::TransactionMut<'_>,
    fragment: &yrs::XmlFragmentRef,
    comments: &MapRef,
    comment_id: &str,
    block_id: &str,
    text: &str,
    author: &str,
    author_id: &str,
) -> Result<()> {
    if comments.contains_key(&*txn, comment_id) {
        bail!("comment {comment_id} already exists");
    }
    let (element, _) = find_ydoc_block(txn, fragment, block_id)
        .ok_or_else(|| anyhow!("block {block_id} not found"))?;
    let quoted_text = ydoc_block_text(txn, &element);
    let document_position = document_position_for_block_offset(txn, fragment, block_id, None)
        .ok_or_else(|| anyhow!("could not resolve ProseMirror position for block {block_id}"))?;
    let data = comment_data(
        text,
        author,
        author_id,
        &quoted_text,
        Some(block_id),
        Some(document_position),
    );
    comments.insert(txn, comment_id, json_to_any(&data));
    Ok(())
}

fn update_comment(
    txn: &mut yrs::TransactionMut<'_>,
    comments: &MapRef,
    comment_id: &str,
    text: Option<&str>,
    resolved: Option<bool>,
) -> Result<()> {
    let Some(Out::Any(existing)) = comments.get(&*txn, comment_id) else {
        bail!("comment {comment_id} not found");
    };
    let mut data = any_to_json(&existing)
        .as_object()
        .cloned()
        .ok_or_else(|| anyhow!("comment {comment_id} is not a JSON object"))?;
    if let Some(text) = text {
        data.insert("text".to_string(), json!(text));
    }
    if let Some(resolved) = resolved {
        data.insert("resolved".to_string(), json!(resolved));
    }
    data.insert(
        "updatedAt".to_string(),
        json!(awareness_timestamp_ms() as u64),
    );
    comments.insert(txn, comment_id, json_to_any(&Value::Object(data)));
    Ok(())
}

fn comment_mark_id(value: &Any) -> Option<String> {
    match any_to_json(value) {
        Value::String(value) => Some(value),
        Value::Object(attrs) => attrs
            .get("commentId")
            .or_else(|| attrs.get("data-comment-id"))
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

fn clear_comment_marks(
    txn: &mut yrs::TransactionMut<'_>,
    fragment: &yrs::XmlFragmentRef,
    comment_id: &str,
) -> Result<()> {
    let mut ranges = Vec::<(XmlTextRef, u32, u32)>::new();
    for child in fragment.children(txn) {
        let XmlOut::Element(element) = child else {
            continue;
        };
        for segment in collect_ydoc_text_segments(txn, &element) {
            let mut cursor = 0u32;
            for diff in segment.text.diff(txn, yrs::types::text::YChange::identity) {
                let chunk = match diff.insert {
                    Out::Any(Any::String(value)) => value.to_string(),
                    _ => continue,
                };
                let len = match txn.doc().offset_kind() {
                    OffsetKind::Bytes => chunk.len() as u32,
                    OffsetKind::Utf16 => utf16_len(&chunk) as u32,
                };
                let matches = diff
                    .attributes
                    .as_deref()
                    .and_then(|attrs| attrs.get("commentMark"))
                    .and_then(comment_mark_id)
                    .as_deref()
                    == Some(comment_id);
                if matches && len > 0 {
                    ranges.push((segment.text.clone(), cursor, len));
                }
                cursor += len;
            }
        }
    }
    let mut attrs = Attrs::new();
    attrs.insert("commentMark".into(), Any::Null);
    for (text, start, len) in ranges {
        text.format(txn, start, len, attrs.clone());
    }
    Ok(())
}

#[derive(Clone)]
struct YdocInlineTextLocation {
    text: XmlTextRef,
    parent: XmlElementRef,
    child_index: u32,
    start_utf16: usize,
    len_utf16: usize,
}

fn collect_inline_text_locations<T: ReadTxn>(
    txn: &T,
    element: &XmlElementRef,
    cursor: &mut usize,
    out: &mut Vec<YdocInlineTextLocation>,
) {
    for (child_index, child) in element.children(txn).enumerate() {
        match child {
            XmlOut::Text(text) => {
                let value = ydoc_text_content(txn, &text);
                let len_utf16 = utf16_len(&value);
                out.push(YdocInlineTextLocation {
                    text,
                    parent: element.clone(),
                    child_index: child_index as u32,
                    start_utf16: *cursor,
                    len_utf16,
                });
                *cursor += len_utf16;
            }
            XmlOut::Element(child) if !INLINE_ATOM_NODES.contains(&child.tag().as_ref()) => {
                collect_inline_text_locations(txn, &child, cursor, out);
            }
            XmlOut::Element(_) | XmlOut::Fragment(_) => {}
        }
    }
}

fn first_inline_container<T: ReadTxn>(txn: &T, element: &XmlElementRef) -> XmlElementRef {
    for child in element.children(txn) {
        if let XmlOut::Element(child) = child
            && !INLINE_ATOM_NODES.contains(&child.tag().as_ref())
        {
            return first_inline_container(txn, &child);
        }
    }
    element.clone()
}

fn right_text_chunks<T: ReadTxn>(
    txn: &T,
    text: &XmlTextRef,
    split_utf16: usize,
) -> Vec<(String, Option<Attrs>)> {
    let mut chunks = Vec::new();
    let mut cursor = 0usize;
    for diff in text.diff(txn, yrs::types::text::YChange::identity) {
        let value = match diff.insert {
            Out::Any(Any::String(value)) => value.to_string(),
            _ => continue,
        };
        let len = utf16_len(&value);
        if cursor + len > split_utf16 {
            let local_start = split_utf16.saturating_sub(cursor);
            if let Some(byte_start) = byte_index_for_utf16(&value, local_start) {
                let right = value[byte_start..].to_string();
                if !right.is_empty() {
                    chunks.push((right, diff.attributes.as_deref().cloned()));
                }
            }
        }
        cursor += len;
    }
    chunks
}

fn insert_footnote_element(
    txn: &mut yrs::TransactionMut<'_>,
    parent: &XmlElementRef,
    child_index: u32,
    content: &str,
) {
    let footnote = parent.insert(txn, child_index, XmlElementPrelim::empty("footnote"));
    footnote.insert_attribute(txn, "content", Any::from(content));
}

fn insert_ydoc_footnote(
    txn: &mut yrs::TransactionMut<'_>,
    fragment: &yrs::XmlFragmentRef,
    block_id: &str,
    offset_utf16: usize,
    content: &str,
) -> Result<()> {
    let (element, _) = find_ydoc_block(txn, fragment, block_id)
        .ok_or_else(|| anyhow!("block {block_id} not found"))?;
    ensure_ydoc_editable(&element)?;
    let mut locations = Vec::new();
    let mut cursor = 0usize;
    collect_inline_text_locations(txn, &element, &mut cursor, &mut locations);
    if offset_utf16 > cursor {
        bail!("footnote offset {offset_utf16} outside block text length {cursor}");
    }
    if locations.is_empty() {
        let container = first_inline_container(txn, &element);
        insert_footnote_element(txn, &container, 0, content);
        return Ok(());
    }
    let location = locations
        .iter()
        .find(|location| {
            let end = location.start_utf16 + location.len_utf16;
            offset_utf16 >= location.start_utf16 && offset_utf16 <= end
        })
        .cloned()
        .unwrap_or_else(|| locations.last().expect("locations is non-empty").clone());
    let local_utf16 = offset_utf16.saturating_sub(location.start_utf16);
    if local_utf16 == 0 {
        insert_footnote_element(txn, &location.parent, location.child_index, content);
        return Ok(());
    }
    if local_utf16 == location.len_utf16 {
        insert_footnote_element(txn, &location.parent, location.child_index + 1, content);
        return Ok(());
    }

    let current = ydoc_text_content(txn, &location.text);
    let right_chunks = right_text_chunks(txn, &location.text, local_utf16);
    let range_start = match txn.doc().offset_kind() {
        OffsetKind::Bytes => byte_index_for_utf16(&current, local_utf16).unwrap_or(current.len()),
        OffsetKind::Utf16 => local_utf16,
    };
    let range_end = match txn.doc().offset_kind() {
        OffsetKind::Bytes => current.len(),
        OffsetKind::Utf16 => utf16_len(&current),
    };
    location
        .text
        .remove_range(txn, range_start as u32, (range_end - range_start) as u32);
    insert_footnote_element(txn, &location.parent, location.child_index + 1, content);
    for (insert_at, (value, attrs)) in (location.child_index + 2..).zip(right_chunks) {
        let text = location
            .parent
            .insert(txn, insert_at, XmlTextPrelim::new(""));
        if let Some(attrs) = attrs.filter(|attrs| !attrs.is_empty()) {
            text.insert_with_attributes(txn, 0, &value, attrs);
        } else {
            text.insert(txn, 0, &value);
        }
    }
    Ok(())
}

#[derive(Clone)]
struct YdocFootnoteLocation {
    parent: XmlElementRef,
    child_index: u32,
}

fn collect_footnote_locations<T: ReadTxn>(
    txn: &T,
    element: &XmlElementRef,
    out: &mut Vec<YdocFootnoteLocation>,
) {
    for (child_index, child) in element.children(txn).enumerate() {
        if let XmlOut::Element(child) = child {
            if child.tag().as_ref() == "footnote" {
                out.push(YdocFootnoteLocation {
                    parent: element.clone(),
                    child_index: child_index as u32,
                });
            } else {
                collect_footnote_locations(txn, &child, out);
            }
        }
    }
}

fn find_ydoc_footnote<T: ReadTxn>(
    txn: &T,
    block: &XmlElementRef,
    atom_index: usize,
) -> Option<YdocFootnoteLocation> {
    let mut locations = Vec::new();
    collect_footnote_locations(txn, block, &mut locations);
    locations.get(atom_index).cloned()
}

fn update_ydoc_footnote(
    txn: &mut yrs::TransactionMut<'_>,
    fragment: &yrs::XmlFragmentRef,
    block_id: &str,
    atom_index: usize,
    content: &str,
) -> Result<()> {
    let (block, _) = find_ydoc_block(txn, fragment, block_id)
        .ok_or_else(|| anyhow!("block {block_id} not found"))?;
    let footnote = find_ydoc_footnote(txn, &block, atom_index)
        .ok_or_else(|| anyhow!("footnote {atom_index} not found in block {block_id}"))?;
    // A footnote has no stable node identity beyond its position. Replacing
    // the atom avoids an attribute-level conflict when an edit follows its
    // insertion before the remote peer has observed the new element.
    footnote.parent.remove_range(txn, footnote.child_index, 1);
    insert_footnote_element(txn, &footnote.parent, footnote.child_index, content);
    Ok(())
}

fn delete_ydoc_footnote(
    txn: &mut yrs::TransactionMut<'_>,
    fragment: &yrs::XmlFragmentRef,
    block_id: &str,
    atom_index: usize,
) -> Result<()> {
    let (block, _) = find_ydoc_block(txn, fragment, block_id)
        .ok_or_else(|| anyhow!("block {block_id} not found"))?;
    let footnote = find_ydoc_footnote(txn, &block, atom_index)
        .ok_or_else(|| anyhow!("footnote {atom_index} not found in block {block_id}"))?;
    footnote.parent.remove_range(txn, footnote.child_index, 1);
    Ok(())
}

fn split_ydoc_block(
    txn: &mut yrs::TransactionMut<'_>,
    fragment: &yrs::XmlFragmentRef,
    block_id: &str,
    offset_utf16: usize,
    new_block_id: Option<String>,
) -> Result<()> {
    let (element, index) = find_ydoc_block(txn, fragment, block_id)
        .ok_or_else(|| anyhow!("top-level block {block_id} not found"))?;
    ensure_ydoc_editable(&element)?;
    let text = ydoc_block_text(txn, &element);
    let total_utf16 = utf16_len(&text);
    if offset_utf16 > total_utf16 {
        bail!("split offset {offset_utf16} outside block text length {total_utf16}");
    }
    let byte = byte_index_for_utf16(&text, offset_utf16).unwrap_or(text.len());
    let before = text[..byte].to_string();
    let after = text[byte..].to_string();
    let mut new_block = ydoc_element_to_tiptap_json(txn, &element);
    let new_id = new_block_id.unwrap_or_else(|| format!("{block_id}-split"));
    ensure_object_field(&mut new_block, "attrs")?
        .insert("data-block-id".to_string(), json!(new_id));
    replace_ydoc_block_text(txn, &element, &before);
    replace_block_text(&mut new_block, &after);
    insert_tiptap_node_at(txn, fragment, index + 1, &new_block);
    Ok(())
}

fn join_next_ydoc_block(
    txn: &mut yrs::TransactionMut<'_>,
    fragment: &yrs::XmlFragmentRef,
    block_id: &str,
) -> Result<()> {
    let (element, index) = find_ydoc_block(txn, fragment, block_id)
        .ok_or_else(|| anyhow!("top-level block {block_id} not found"))?;
    ensure_ydoc_editable(&element)?;
    let next_index = index + 1;
    let Some(XmlOut::Element(next_element)) = fragment.get(txn, next_index) else {
        bail!("block {block_id} has no next sibling to join");
    };
    ensure_ydoc_editable(&next_element)?;
    let joined = format!(
        "{}{}",
        ydoc_block_text(txn, &element),
        ydoc_block_text(txn, &next_element)
    );
    replace_ydoc_block_text(txn, &element, &joined);
    fragment.remove_range(txn, next_index, 1);
    Ok(())
}

fn insert_ydoc_block(
    txn: &mut yrs::TransactionMut<'_>,
    fragment: &yrs::XmlFragmentRef,
    after_block_id: Option<&str>,
    block: &Value,
) -> Result<()> {
    let block_id = block_id_of(block).ok_or_else(|| {
        anyhow!("insert-block requires block.attrs.data-block-id or block.attrs.blockId")
    })?;
    let index = match after_block_id {
        Some(after) => find_ydoc_block(txn, fragment, after)
            .map(|(_, index)| index + 1)
            .ok_or_else(|| anyhow!("after block {after} not found"))?,
        None => 0,
    };
    let mut enriched = block.clone();
    ensure_object_field(&mut enriched, "attrs")?
        .insert("data-block-id".to_string(), json!(block_id));
    insert_tiptap_node_at(txn, fragment, index, &enriched);
    Ok(())
}

fn delete_ydoc_block(
    txn: &mut yrs::TransactionMut<'_>,
    fragment: &yrs::XmlFragmentRef,
    block_id: &str,
) -> Result<()> {
    let (_, index) = find_ydoc_block(txn, fragment, block_id)
        .ok_or_else(|| anyhow!("top-level block {block_id} not found"))?;
    fragment.remove_range(txn, index, 1);
    Ok(())
}

fn move_ydoc_block(
    txn: &mut yrs::TransactionMut<'_>,
    fragment: &yrs::XmlFragmentRef,
    block_id: &str,
    after_block_id: Option<&str>,
) -> Result<()> {
    if Some(block_id) == after_block_id {
        return Ok(());
    }
    let (element, index) = find_ydoc_block(txn, fragment, block_id)
        .ok_or_else(|| anyhow!("top-level block {block_id} not found"))?;
    let node = ydoc_element_to_tiptap_json(txn, &element);
    fragment.remove_range(txn, index, 1);
    let insert_index = match after_block_id {
        Some(after) => find_ydoc_block(txn, fragment, after)
            .map(|(_, index)| index + 1)
            .ok_or_else(|| anyhow!("after block {after} not found"))?,
        None => 0,
    };
    insert_tiptap_node_at(txn, fragment, insert_index, &node);
    Ok(())
}

fn ydoc_element_to_tiptap_json<T: ReadTxn>(txn: &T, element: &XmlElementRef) -> Value {
    xml_node_to_json(txn, &XmlOut::Element(element.clone()))
        .into_iter()
        .next()
        .unwrap_or_else(|| json!({ "type": element.tag().to_string() }))
}

type BridgeSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

#[derive(Default)]
struct LiveBridgeSession {
    doc: Option<Doc>,
    awareness: Option<Awareness>,
    document_id: Option<String>,
    path: Option<PathBuf>,
    socket: Option<BridgeSocket>,
}

impl LiveBridgeSession {
    fn require_doc(&self) -> Result<&Doc> {
        self.doc
            .as_ref()
            .ok_or_else(|| anyhow!("no document is open"))
    }

    fn require_document_id(&self) -> Result<&str> {
        self.document_id
            .as_deref()
            .ok_or_else(|| anyhow!("no document is open"))
    }

    fn require_awareness(&self) -> Result<&Awareness> {
        self.awareness
            .as_ref()
            .ok_or_else(|| anyhow!("no awareness session is open"))
    }

    fn require_awareness_mut(&mut self) -> Result<&mut Awareness> {
        self.awareness
            .as_mut()
            .ok_or_else(|| anyhow!("no awareness session is open"))
    }

    fn awareness_payload(&self) -> Result<Value> {
        let awareness = self.require_awareness()?;
        let doc = self.require_doc()?;
        let local_client_id = awareness.client_id();
        let mut clients = Vec::new();
        for (client_id, client_state) in awareness.iter() {
            let Some(raw) = client_state.data else {
                continue;
            };
            let state: Value = serde_json::from_str(&raw)
                .with_context(|| format!("decode awareness state for client {client_id}"))?;
            let resolved = state
                .get("cursor")
                .and_then(|cursor| cursor.get("head"))
                .and_then(|head| serde_json::from_value::<StickyIndex>(head.clone()).ok())
                .and_then(|sticky| resolve_sticky_index(doc, &sticky));
            let (block_id, offset_utf16) = resolved
                .map(|(block_id, offset)| (Some(block_id), Some(offset)))
                .unwrap_or_else(|| {
                    let block_id = state
                        .get("editorSelection")
                        .and_then(|selection| selection.get("blockId"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let offset = block_id.as_ref().map(|_| 0);
                    (block_id, offset)
                });
            clients.push(json!({
                "client_id": client_id.get().to_string(),
                "local": client_id == local_client_id,
                "state": state,
                "block_id": block_id,
                "offset_utf16": offset_utf16,
            }));
        }
        clients.sort_by(|left, right| {
            left.get("client_id")
                .and_then(Value::as_str)
                .cmp(&right.get("client_id").and_then(Value::as_str))
        });
        Ok(json!({
            "document_id": self.require_document_id()?,
            "local_client_id": local_client_id.get().to_string(),
            "clients": clients,
        }))
    }

    async fn set_awareness(&mut self, params: LiveAwarenessParams) -> Result<Value> {
        let anchor = sticky_index_for_block_offset(
            self.require_doc()?,
            &params.block_id,
            params.offset_utf16,
        )?;
        let head_offset = params.selection_end_utf16.unwrap_or(params.offset_utf16);
        let head =
            sticky_index_for_block_offset(self.require_doc()?, &params.block_id, head_offset)?;
        let state = json!({
            "user": params.user,
            "cursor": {
                "anchor": anchor,
                "head": head,
            },
            "editorSelection": {
                "blockId": params.block_id,
                "timestamp": awareness_timestamp_ms(),
            },
        });
        let encoded = {
            let awareness = self.require_awareness_mut()?;
            awareness
                .set_local_state(state)
                .context("set local awareness state")?;
            let update = awareness
                .update_with_clients([awareness.client_id()])
                .context("encode local awareness state")?;
            YMessage::Awareness(update).encode_v1()
        };
        if let Some(socket) = &mut self.socket {
            socket
                .send(WsMessage::Binary(encoded.into()))
                .await
                .context("send local awareness state")?;
        }
        self.awareness_payload()
    }

    async fn send_awareness_offline(&mut self) -> Result<()> {
        let encoded = {
            let Some(awareness) = self.awareness.as_mut() else {
                return Ok(());
            };
            if awareness.local_state_raw().is_none() {
                return Ok(());
            }
            let client_id = awareness.client_id();
            awareness.clean_local_state();
            let update = awareness
                .update_with_clients([client_id])
                .context("encode awareness disconnect")?;
            YMessage::Awareness(update).encode_v1()
        };
        if let Some(socket) = &mut self.socket {
            socket
                .send(WsMessage::Binary(encoded.into()))
                .await
                .context("send awareness disconnect")?;
        }
        Ok(())
    }

    fn project(&self) -> Result<BridgeProjection> {
        Ok(project_ydoc(
            self.require_doc()?,
            self.require_document_id()?,
            None,
            0,
        ))
    }

    fn persist(&self) -> Result<()> {
        if let (Some(path), Some(doc)) = (&self.path, &self.doc) {
            write_ydoc_update_v1(path, doc)?;
        }
        Ok(())
    }

    async fn send_full_update(&mut self) -> Result<()> {
        let Some(doc) = &self.doc else {
            return Ok(());
        };
        let Some(socket) = &mut self.socket else {
            return Ok(());
        };
        let update = encode_update_v1(doc);
        socket
            .send(WsMessage::Binary(
                YMessage::Sync(SyncMessage::Update(update))
                    .encode_v1()
                    .into(),
            ))
            .await
            .context("send live update")?;
        Ok(())
    }

    async fn send_sync_step1(&mut self) -> Result<()> {
        let Some(doc) = &self.doc else {
            return Ok(());
        };
        let Some(socket) = &mut self.socket else {
            return Ok(());
        };
        let step1 = {
            let txn = doc.transact();
            YMessage::Sync(SyncMessage::SyncStep1(txn.state_vector())).encode_v1()
        };
        socket
            .send(WsMessage::Binary(step1.into()))
            .await
            .context("send live sync step1")?;
        Ok(())
    }

    async fn connect_room(
        &mut self,
        url: &str,
        bearer_token: Option<&str>,
        on_behalf_of: Option<&str>,
        timeout: Duration,
    ) -> Result<()> {
        let doc = self.require_doc()?;
        let mut request = url
            .into_client_request()
            .with_context(|| format!("build websocket request for {url}"))?;
        if let Some(token) = bearer_token.filter(|token| !token.is_empty()) {
            request.headers_mut().insert(
                header::AUTHORIZATION,
                format!("Bearer {token}")
                    .parse()
                    .context("build authorization header")?,
            );
        }
        if let Some(subject) = on_behalf_of.filter(|subject| !subject.is_empty()) {
            request.headers_mut().insert(
                header::HeaderName::from_static("x-pn-on-behalf-of"),
                subject.parse().context("build x-pn-on-behalf-of header")?,
            );
        }

        let (mut socket, _) = connect_async(request)
            .await
            .with_context(|| format!("connect websocket {url}"))?;
        let step1 = {
            let txn = doc.transact();
            YMessage::Sync(SyncMessage::SyncStep1(txn.state_vector())).encode_v1()
        };
        socket
            .send(WsMessage::Binary(step1.into()))
            .await
            .context("send live initial sync step1")?;
        socket
            .send(WsMessage::Binary(
                YMessage::AwarenessQuery.encode_v1().into(),
            ))
            .await
            .context("request live awareness state")?;

        let deadline = tokio::time::Instant::now() + timeout;
        let mut saw_any_message = false;
        while tokio::time::Instant::now() < deadline {
            let remaining = deadline - tokio::time::Instant::now();
            let Some(frame) = tokio::time::timeout(remaining, socket.next())
                .await
                .map_err(|_| anyhow!("live sync timed out after {}ms", timeout.as_millis()))?
            else {
                break;
            };
            let frame = frame.context("read live websocket frame")?;
            let WsMessage::Binary(data) = frame else {
                continue;
            };
            saw_any_message = true;
            let applied = handle_y_message(self, &mut socket, &data).await?;
            if applied {
                break;
            }
        }
        if !saw_any_message {
            bail!("live websocket connected but did not receive y-protocol messages");
        }
        self.socket = Some(socket);
        self.persist()?;
        Ok(())
    }

    async fn handle_command(&mut self, command: LiveBridgeCommand) -> Result<bool> {
        match command.method.as_str() {
            "open-ydoc-file" => {
                self.send_awareness_offline().await?;
                let params: OpenYdocFileParams = serde_json::from_value(command.params)?;
                let doc = if params.path.exists() {
                    read_ydoc_update_v1(&params.path)?
                } else {
                    new_ydoc()
                };
                self.awareness = Some(Awareness::new(doc.clone()));
                self.doc = Some(doc);
                self.document_id = Some(params.document_id);
                self.path = Some(params.path);
                self.socket = None;
                self.persist()?;
                emit_response(command.id, &self.project()?)?;
            }
            "open-ydoc-room" => {
                self.send_awareness_offline().await?;
                let params: OpenYdocRoomParams = serde_json::from_value(command.params)?;
                let doc = if params.path.exists() {
                    read_ydoc_update_v1(&params.path)?
                } else {
                    new_ydoc()
                };
                self.awareness = Some(Awareness::new(doc.clone()));
                self.doc = Some(doc);
                self.document_id = Some(params.document_id);
                self.path = Some(params.path);
                self.socket = None;
                let env_token = params
                    .token_env
                    .as_deref()
                    .and_then(|key| std::env::var(key).ok());
                let token = params.token.as_deref().or(env_token.as_deref());
                let env_on_behalf_of = params
                    .on_behalf_of_env
                    .as_deref()
                    .and_then(|key| std::env::var(key).ok());
                let on_behalf_of = params
                    .on_behalf_of
                    .as_deref()
                    .or(env_on_behalf_of.as_deref());
                self.connect_room(
                    &params.url,
                    token,
                    on_behalf_of,
                    Duration::from_millis(params.timeout_ms.unwrap_or(2500)),
                )
                .await?;
                emit_response(command.id, &self.project()?)?;
            }
            "apply" => {
                let params: LiveApplyParams = serde_json::from_value(command.params)?;
                let doc = self.require_doc()?;
                apply_mutations_to_ydoc(doc, &params.request)?;
                self.persist()?;
                self.send_full_update().await?;
                emit_response(command.id, &self.project()?)?;
            }
            "project" => {
                emit_response(command.id, &self.project()?)?;
            }
            "sync" => {
                self.send_sync_step1().await?;
                emit_response(command.id, &self.project()?)?;
            }
            "set-awareness" => {
                let params: LiveAwarenessParams = serde_json::from_value(command.params)?;
                let payload = self.set_awareness(params).await?;
                emit_response(command.id, &payload)?;
            }
            "shutdown" => {
                self.send_awareness_offline().await?;
                emit_response(command.id, &json!({ "shutdown": true }))?;
                return Ok(false);
            }
            other => bail!("unknown live bridge method {other}"),
        }
        Ok(true)
    }
}

pub async fn run_live_bridge_stdio() -> Result<()> {
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    let mut session = LiveBridgeSession::default();

    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line.context("read live bridge stdin")? else {
                    break;
                };
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let command = serde_json::from_str::<LiveBridgeCommand>(line);
                match command {
                    Ok(command) => {
                        let id = command.id.clone();
                        match session.handle_command(command).await {
                            Ok(keep_running) => {
                                if !keep_running {
                                    break;
                                }
                            }
                            Err(error) => emit_error(id, &error.to_string())?,
                        }
                    }
                    Err(error) => emit_error(None, &format!("parse command: {error}"))?,
                }
            }
            frame = async {
                match session.socket.as_mut() {
                    Some(socket) => socket.next().await,
                    None => std::future::pending().await,
                }
            }, if session.socket.is_some() => {
                match frame {
                    Some(Ok(WsMessage::Binary(data))) => {
                        match handle_live_socket_bytes(&mut session, &data).await {
                            Ok(Some(projection)) => emit_event("remote-update", &projection)?,
                            Ok(None) => {}
                            Err(error) => emit_event("websocket-error", &json!({ "error": error.to_string() }))?,
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) | None => {
                        session.socket = None;
                        emit_event("websocket-closed", &json!({}))?;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(error)) => {
                        session.socket = None;
                        emit_event("websocket-error", &json!({ "error": error.to_string() }))?;
                    }
                }
            }
        }
    }

    let _ = session.send_awareness_offline().await;
    Ok(())
}

async fn handle_live_socket_bytes(
    session: &mut LiveBridgeSession,
    data: &[u8],
) -> Result<Option<BridgeProjection>> {
    let mut socket = session
        .socket
        .take()
        .ok_or_else(|| anyhow!("websocket frame received without socket"))?;
    let applied = handle_y_message(session, &mut socket, data).await?;
    session.socket = Some(socket);
    if applied {
        session.persist()?;
        Ok(Some(session.project()?))
    } else {
        Ok(None)
    }
}

async fn handle_y_message(
    session: &mut LiveBridgeSession,
    socket: &mut BridgeSocket,
    data: &[u8],
) -> Result<bool> {
    let message = YMessage::decode_v1(data).context("decode live y-protocol message")?;
    match message {
        YMessage::Sync(SyncMessage::SyncStep1(state_vector)) => {
            let doc = session.require_doc()?;
            let update = {
                let txn = doc.transact();
                txn.encode_state_as_update_v1(&state_vector)
            };
            socket
                .send(WsMessage::Binary(
                    YMessage::Sync(SyncMessage::SyncStep2(update))
                        .encode_v1()
                        .into(),
                ))
                .await
                .context("send live sync step2")?;
            Ok(false)
        }
        YMessage::Sync(SyncMessage::SyncStep2(update))
        | YMessage::Sync(SyncMessage::Update(update)) => {
            let doc = session.require_doc()?;
            let decoded = Update::decode_v1(&update).context("decode live remote update")?;
            let mut txn = doc.transact_mut();
            txn.apply_update(decoded)
                .context("apply live remote update")?;
            Ok(true)
        }
        YMessage::Awareness(update) => {
            session
                .require_awareness_mut()?
                .apply_update(update)
                .context("apply live awareness update")?;
            emit_event("awareness", &session.awareness_payload()?)?;
            Ok(false)
        }
        YMessage::AwarenessQuery => {
            let update = session
                .require_awareness()?
                .update()
                .context("encode awareness query response")?;
            if !update.clients.is_empty() {
                socket
                    .send(WsMessage::Binary(
                        YMessage::Awareness(update).encode_v1().into(),
                    ))
                    .await
                    .context("send awareness query response")?;
            }
            Ok(false)
        }
        YMessage::Auth(_) | YMessage::Custom(..) => Ok(false),
    }
}

fn emit_response<T: Serialize>(id: Option<Value>, result: &T) -> Result<()> {
    emit_json(&json!({ "id": id, "ok": true, "result": result }))
}

fn emit_error(id: Option<Value>, error: &str) -> Result<()> {
    emit_json(&json!({ "id": id, "ok": false, "error": error }))
}

fn emit_event<T: Serialize>(event: &str, payload: &T) -> Result<()> {
    emit_json(&json!({ "event": event, "payload": payload }))
}

fn emit_json(value: &Value) -> Result<()> {
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, value)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}

pub fn project_ydoc(
    doc: &Doc,
    document_id: &str,
    title: Option<String>,
    revision: u64,
) -> BridgeProjection {
    let tiptap_json = ydoc_to_tiptap_json(doc);
    let tiptap_xml = tiptap_json_to_xml(&tiptap_json);
    let mut projection = project_tiptap_json(tiptap_json, document_id, title, revision, tiptap_xml);
    projection.comments = project_comments(doc, &projection.lines);
    projection
}

pub fn project_tiptap_json(
    tiptap_json: Value,
    document_id: &str,
    title: Option<String>,
    revision: u64,
    tiptap_xml: String,
) -> BridgeProjection {
    let mut blocks = Vec::new();
    let mut unsupported = Vec::new();
    let mut fallback_index = 0usize;
    for node in content_nodes(&tiptap_json) {
        if let Some(block) = block_view_from_node(node, &mut fallback_index, &mut unsupported) {
            blocks.push(block);
        }
    }
    let lines = blocks.iter().map(line_from_block).collect();
    BridgeProjection {
        format_version: 1,
        document_id: document_id.to_string(),
        title,
        tiptap_json,
        tiptap_xml,
        doc_view: DocView {
            document_id: document_id.to_string(),
            revision,
            blocks,
        },
        lines,
        comments: Vec::new(),
        unsupported,
    }
}

fn project_comments(doc: &Doc, lines: &[BridgeLine]) -> Vec<BridgeComment> {
    let txn = doc.transact();
    let Some(comments) = txn.get_map("comments") else {
        return Vec::new();
    };
    let mut ids = comments.keys(&txn).map(str::to_string).collect::<Vec<_>>();
    ids.sort();
    let mut projected = Vec::new();
    for comment_id in ids {
        let Some(Out::Any(raw)) = comments.get(&txn, &comment_id) else {
            continue;
        };
        let data = any_to_json(&raw);
        let mut block_id = data
            .get("blockId")
            .or_else(|| data.get("block_id"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let mut start_utf16 = None;
        let mut end_utf16 = None;
        for line in lines {
            let mut line_start = None;
            let mut line_end = None;
            for mark in &line.marks {
                if mark.mark_type != "commentMark" {
                    continue;
                }
                let marked_comment_id = mark
                    .attrs
                    .get("commentId")
                    .or_else(|| mark.attrs.get("data-comment-id"))
                    .and_then(Value::as_str);
                if marked_comment_id == Some(comment_id.as_str()) {
                    line_start = Some(
                        line_start
                            .map(|start: usize| start.min(mark.start_utf16))
                            .unwrap_or(mark.start_utf16),
                    );
                    line_end = Some(
                        line_end
                            .map(|end: usize| end.max(mark.end_utf16))
                            .unwrap_or(mark.end_utf16),
                    );
                }
            }
            if let (Some(line_start), Some(line_end)) = (line_start, line_end) {
                block_id = Some(line.block_id.clone());
                start_utf16 = Some(line_start);
                end_utf16 = Some(line_end);
                break;
            }
        }
        projected.push(BridgeComment {
            comment_id,
            data,
            block_id,
            start_utf16,
            end_utf16,
        });
    }
    projected
}

pub fn ydoc_from_tiptap_json(tiptap_json: &Value) -> Result<Doc> {
    let doc = new_ydoc();
    let fragment = doc.get_or_insert_xml_fragment(CONTENT_FIELD);
    {
        let mut txn = doc.transact_mut();
        let content = tiptap_json
            .get("content")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("TipTap JSON document is missing content array"))?;
        append_nodes(&mut txn, &fragment, content);
    }
    Ok(doc)
}

pub fn ydoc_to_tiptap_json(doc: &Doc) -> Value {
    let fragment = doc.get_or_insert_xml_fragment(CONTENT_FIELD);
    let txn = doc.transact();
    let mut content = Vec::new();
    for child in fragment.children(&txn) {
        content.extend(xml_node_to_json(&txn, &child));
    }
    json!({ "type": "doc", "content": content })
}

pub fn garden_json_to_tiptap_json(document: &GardenJsonDocument) -> Value {
    let content = document
        .blocks
        .iter()
        .map(garden_block_to_tiptap_node)
        .collect::<Vec<_>>();
    json!({ "type": "doc", "content": content })
}

fn garden_block_to_tiptap_node(block: &GardenJsonBlock) -> Value {
    let mut attrs = Map::new();
    attrs.insert("data-block-id".to_string(), json!(block.block_id));
    let text_content = if block.text.is_empty() {
        Vec::new()
    } else {
        vec![json!({ "type": "text", "text": block.text })]
    };
    let mut node = Map::new();
    match block.kind.as_str() {
        "heading" => {
            node.insert("type".to_string(), json!("heading"));
            attrs.insert("level".to_string(), json!(2));
        }
        "bullet" => {
            node.insert("type".to_string(), json!("listItem"));
            attrs.insert("listType".to_string(), json!("bullet"));
        }
        "numbered" => {
            node.insert("type".to_string(), json!("listItem"));
            attrs.insert("listType".to_string(), json!("ordered"));
        }
        "todo" => {
            node.insert("type".to_string(), json!("listItem"));
            attrs.insert("listType".to_string(), json!("task"));
            attrs.insert("checked".to_string(), json!(false));
        }
        "quote" => {
            node.insert("type".to_string(), json!("blockquote"));
        }
        "code" => {
            node.insert("type".to_string(), json!("codeBlock"));
        }
        "divider" => {
            node.insert("type".to_string(), json!("horizontalRule"));
        }
        other => {
            node.insert(
                "type".to_string(),
                json!(if other.is_empty() { "paragraph" } else { other }),
            );
        }
    }
    node.insert("attrs".to_string(), Value::Object(attrs));
    if !text_content.is_empty() {
        node.insert("content".to_string(), Value::Array(text_content));
    }
    Value::Object(node)
}

fn append_nodes<F: XmlFragment>(txn: &mut yrs::TransactionMut<'_>, parent: &F, nodes: &[Value]) {
    for node in nodes {
        append_node(txn, parent, node);
    }
}

fn append_node<F: XmlFragment>(txn: &mut yrs::TransactionMut<'_>, parent: &F, node: &Value) {
    let node_type = node.get("type").and_then(Value::as_str);
    if node_type == Some("text") {
        let text = node.get("text").and_then(Value::as_str).unwrap_or("");
        if text.is_empty() {
            return;
        }
        let index = parent.len(txn);
        let text_ref = parent.insert(txn, index, XmlTextPrelim::new(""));
        if let Some(attrs) = marks_to_attrs(node.get("marks")) {
            text_ref.insert_with_attributes(txn, 0, text, attrs);
        } else {
            text_ref.insert(txn, 0, text);
        }
        return;
    }

    let tag = node_type.unwrap_or("paragraph");
    let index = parent.len(txn);
    let element = parent.insert(txn, index, XmlElementPrelim::empty(tag));
    if let Some(attrs) = node.get("attrs").and_then(Value::as_object) {
        for (key, value) in attrs {
            if !value.is_null() {
                element.insert_attribute(txn, key.clone(), json_to_any(value));
            }
        }
    }
    if let Some(content) = node.get("content").and_then(Value::as_array) {
        append_nodes(txn, &element, content);
    }
}

fn insert_tiptap_node_at<F: XmlFragment>(
    txn: &mut yrs::TransactionMut<'_>,
    parent: &F,
    index: u32,
    node: &Value,
) {
    let node_type = node.get("type").and_then(Value::as_str);
    if node_type == Some("text") {
        let text = node.get("text").and_then(Value::as_str).unwrap_or("");
        let text_ref = parent.insert(txn, index, XmlTextPrelim::new(""));
        if !text.is_empty() {
            if let Some(attrs) = marks_to_attrs(node.get("marks")) {
                text_ref.insert_with_attributes(txn, 0, text, attrs);
            } else {
                text_ref.insert(txn, 0, text);
            }
        }
        return;
    }

    let tag = node_type.unwrap_or("paragraph");
    let element = parent.insert(txn, index, XmlElementPrelim::empty(tag));
    if let Some(attrs) = node.get("attrs").and_then(Value::as_object) {
        for (key, value) in attrs {
            if !value.is_null() {
                element.insert_attribute(txn, key.clone(), json_to_any(value));
            }
        }
    }
    if let Some(content) = node.get("content").and_then(Value::as_array) {
        for (child_index, child) in content.iter().enumerate() {
            insert_tiptap_node_at(txn, &element, child_index as u32, child);
        }
    }
}

fn marks_to_attrs(marks: Option<&Value>) -> Option<Attrs> {
    let marks = marks?.as_array()?;
    if marks.is_empty() {
        return None;
    }
    let mut attrs = Attrs::new();
    for mark in marks {
        let Some(mark_type) = mark.get("type").and_then(Value::as_str) else {
            continue;
        };
        let mark_attrs = mark
            .get("attrs")
            .map(json_to_any)
            .unwrap_or_else(|| Any::Map(Arc::new(Default::default())));
        attrs.insert(mark_type.into(), mark_attrs);
    }
    Some(attrs)
}

fn json_to_any(value: &Value) -> Any {
    match value {
        Value::Null => Any::Null,
        Value::Bool(value) => Any::Bool(*value),
        Value::Number(value) => Any::Number(value.as_f64().unwrap_or(0.0)),
        Value::String(value) => Any::from(value.as_str()),
        Value::Array(values) => Any::Array(values.iter().map(json_to_any).collect()),
        Value::Object(entries) => Any::Map(Arc::new(
            entries
                .iter()
                .map(|(key, value)| (key.clone(), json_to_any(value)))
                .collect(),
        )),
    }
}

fn any_to_json(any: &Any) -> Value {
    match any {
        Any::Null | Any::Undefined => Value::Null,
        Any::Bool(value) => json!(value),
        Any::Number(value) => json!(value),
        Any::BigInt(value) => json!(value),
        Any::String(value) => json!(value.as_ref()),
        Any::Buffer(value) => json!(value.as_ref()),
        Any::Array(values) => Value::Array(values.iter().map(any_to_json).collect()),
        Any::Map(entries) => Value::Object(
            entries
                .iter()
                .map(|(key, value)| (key.to_string(), any_to_json(value)))
                .collect(),
        ),
    }
}

fn xml_node_to_json<T: ReadTxn>(txn: &T, node: &XmlOut) -> Vec<Value> {
    match node {
        XmlOut::Text(text) => {
            let mut out = Vec::new();
            for diff in text.diff(txn, yrs::types::text::YChange::identity) {
                let chunk = match diff.insert {
                    yrs::Out::Any(Any::String(value)) => value.to_string(),
                    _ => continue,
                };
                if chunk.is_empty() {
                    continue;
                }
                let mut node = Map::new();
                node.insert("type".to_string(), json!("text"));
                node.insert("text".to_string(), json!(chunk));
                if let Some(attrs) = diff.attributes.as_deref() {
                    let marks = attrs_to_marks(attrs);
                    if !marks.is_empty() {
                        node.insert("marks".to_string(), Value::Array(marks));
                    }
                }
                out.push(Value::Object(node));
            }
            out
        }
        XmlOut::Element(element) => {
            let mut obj = Map::new();
            obj.insert("type".to_string(), json!(element.tag().to_string()));
            let mut attrs = Map::new();
            for (key, value) in element.attributes(txn) {
                attrs.insert(
                    key.to_string(),
                    match value {
                        yrs::Out::Any(any) => any_to_json(&any),
                        _ => Value::Null,
                    },
                );
            }
            if !attrs.is_empty() {
                obj.insert("attrs".to_string(), Value::Object(attrs));
            }
            let mut content = Vec::new();
            for child in element.children(txn) {
                content.extend(xml_node_to_json(txn, &child));
            }
            if !content.is_empty() {
                obj.insert("content".to_string(), Value::Array(content));
            }
            vec![Value::Object(obj)]
        }
        XmlOut::Fragment(fragment) => {
            let mut content = Vec::new();
            for child in fragment.children(txn) {
                content.extend(xml_node_to_json(txn, &child));
            }
            content
        }
    }
}

fn attrs_to_marks(attrs: &Attrs) -> Vec<Value> {
    attrs
        .iter()
        .map(|(name, value)| {
            let attrs_json = any_to_json(value);
            let mut mark = Map::new();
            mark.insert("type".to_string(), json!(name.to_string()));
            if let Value::Object(entries) = &attrs_json
                && !entries.is_empty()
            {
                mark.insert("attrs".to_string(), attrs_json);
            }
            Value::Object(mark)
        })
        .collect()
}

fn content_nodes(value: &Value) -> &[Value] {
    value
        .get("content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn block_view_from_node(
    node: &Value,
    fallback_index: &mut usize,
    unsupported: &mut Vec<UnsupportedRegion>,
) -> Option<BlockView> {
    let node_type = node
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("paragraph")
        .to_string();
    if node_type == "text" {
        return None;
    }
    let attrs = attrs_map(node.get("attrs"));
    let block_id = attrs
        .get("data-block-id")
        .or_else(|| attrs.get("blockId"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            *fallback_index += 1;
            format!("missing-block-id-{fallback_index}")
        });
    let support = support_for(&node_type);
    if matches!(support, SupportLevel::ReadOnlyOpaque) {
        unsupported.push(UnsupportedRegion {
            block_id: Some(block_id.clone()),
            node_type: node_type.clone(),
            reason: "node is preserved but not structurally editable in vehicle.nvim draft"
                .to_string(),
        });
    }
    let text = plain_text(node);
    let marks = inline_marks(node);
    let inline_atoms = inline_atoms(node);
    let children = content_nodes(node)
        .iter()
        .filter_map(|child| block_view_from_node(child, fallback_index, unsupported))
        .collect();
    Some(BlockView {
        block_id,
        node_type,
        attrs,
        text,
        support,
        marks,
        inline_atoms,
        children,
    })
}

fn line_from_block(block: &BlockView) -> BridgeLine {
    BridgeLine {
        block_id: block.block_id.clone(),
        node_type: block.node_type.clone(),
        text: block.text.clone(),
        support: block.support.clone(),
        attrs: block.attrs.clone(),
        marks: block.marks.clone(),
        inline_atoms: block.inline_atoms.clone(),
    }
}

fn support_for(node_type: &str) -> SupportLevel {
    if EDITABLE_TEXT_NODES.contains(&node_type) {
        SupportLevel::EditableText
    } else if COMMAND_ONLY_NODES.contains(&node_type) {
        SupportLevel::CommandOnly
    } else {
        if READ_ONLY_OPAQUE_NODES.contains(&node_type) || !node_type.starts_with('_') {
            SupportLevel::ReadOnlyOpaque
        } else {
            SupportLevel::HiddenMetadata
        }
    }
}

fn attrs_map(value: Option<&Value>) -> BTreeMap<String, Value> {
    value
        .and_then(Value::as_object)
        .map(|entries| {
            entries
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}

fn plain_text(node: &Value) -> String {
    if node.get("type").and_then(Value::as_str) == Some("text") {
        return node
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
    }
    content_nodes(node)
        .iter()
        .map(plain_text)
        .collect::<Vec<_>>()
        .join("")
}

fn inline_marks(node: &Value) -> Vec<InlineMark> {
    let mut out = Vec::new();
    let mut cursor = 0usize;
    collect_inline_marks(node, &mut cursor, &mut Vec::new(), &mut out);
    out
}

fn inline_atoms(node: &Value) -> Vec<InlineAtom> {
    let mut out = Vec::new();
    let mut cursor = 0usize;
    let mut counts = BTreeMap::<String, usize>::new();
    for child in content_nodes(node) {
        collect_inline_atoms(child, &mut cursor, &mut counts, &mut out);
    }
    out
}

fn collect_inline_atoms(
    node: &Value,
    cursor: &mut usize,
    counts: &mut BTreeMap<String, usize>,
    out: &mut Vec<InlineAtom>,
) {
    let node_type = node.get("type").and_then(Value::as_str).unwrap_or("");
    if node_type == "text" {
        *cursor += utf16_len(node.get("text").and_then(Value::as_str).unwrap_or(""));
        return;
    }
    if INLINE_ATOM_NODES.contains(&node_type) {
        let atom_index = counts.entry(node_type.to_string()).or_default();
        out.push(InlineAtom {
            atom_type: node_type.to_string(),
            atom_index: *atom_index,
            offset_utf16: *cursor,
            attrs: attrs_map(node.get("attrs")),
        });
        *atom_index += 1;
        return;
    }
    for child in content_nodes(node) {
        collect_inline_atoms(child, cursor, counts, out);
    }
}

fn collect_inline_marks(
    node: &Value,
    cursor: &mut usize,
    inherited: &mut Vec<(String, BTreeMap<String, Value>)>,
    out: &mut Vec<InlineMark>,
) {
    if node.get("type").and_then(Value::as_str) == Some("text") {
        let text = node.get("text").and_then(Value::as_str).unwrap_or("");
        let len = utf16_len(text);
        let mut marks = inherited.clone();
        for mark in node
            .get("marks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(mark_type) = mark.get("type").and_then(Value::as_str) {
                marks.push((mark_type.to_string(), attrs_map(mark.get("attrs"))));
            }
        }
        for (mark_type, attrs) in marks {
            out.push(InlineMark {
                mark_type,
                start_utf16: *cursor,
                end_utf16: *cursor + len,
                attrs,
            });
        }
        *cursor += len;
        return;
    }

    for child in content_nodes(node) {
        collect_inline_marks(child, cursor, inherited, out);
    }
}

fn tiptap_json_to_xml(value: &Value) -> String {
    content_nodes(value)
        .iter()
        .map(tiptap_node_to_xml)
        .collect::<Vec<_>>()
        .join("")
}

fn tiptap_node_to_xml(node: &Value) -> String {
    let node_type = node
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("paragraph");
    if node_type == "text" {
        let text = escape_xml(node.get("text").and_then(Value::as_str).unwrap_or(""));
        return wrap_text_marks(text, node.get("marks"));
    }
    let attrs = node
        .get("attrs")
        .and_then(Value::as_object)
        .map(|attrs| {
            attrs
                .iter()
                .filter(|(_, value)| !value.is_null())
                .map(|(key, value)| format!(" {key}=\"{}\"", escape_xml(&xml_attr_value(value))))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    let children = content_nodes(node)
        .iter()
        .map(tiptap_node_to_xml)
        .collect::<Vec<_>>()
        .join("");
    format!("<{node_type}{attrs}>{children}</{node_type}>")
}

fn wrap_text_marks(text: String, marks: Option<&Value>) -> String {
    let Some(marks) = marks.and_then(Value::as_array) else {
        return text;
    };
    marks.iter().rev().fold(text, |inner, mark| {
        let mark_type = mark.get("type").and_then(Value::as_str).unwrap_or("mark");
        let attrs = mark
            .get("attrs")
            .and_then(Value::as_object)
            .map(|attrs| {
                attrs
                    .iter()
                    .filter(|(_, value)| !value.is_null())
                    .map(|(key, value)| {
                        format!(" {key}=\"{}\"", escape_xml(&xml_attr_value(value)))
                    })
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default();
        format!("<{mark_type}{attrs}>{inner}</{mark_type}>")
    })
}

fn xml_attr_value(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Null => String::new(),
        Value::Array(_) | Value::Object(_) => value.to_string(),
    }
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub fn apply_mutations_to_tiptap_json(
    tiptap_json: &mut Value,
    request: &BridgeMutationRequest,
) -> Result<()> {
    for op in &request.operations {
        apply_operation(tiptap_json, op)?;
    }
    Ok(())
}

fn apply_operation(tiptap_json: &mut Value, op: &BridgeOperation) -> Result<()> {
    match op {
        BridgeOperation::ReplaceBlockText { block_id, text } => {
            let block = find_block_mut(tiptap_json, block_id)
                .ok_or_else(|| anyhow!("block {block_id} not found"))?;
            ensure_editable(block)?;
            replace_block_text(block, text);
        }
        BridgeOperation::InsertText {
            block_id,
            offset_utf16,
            text,
        } => {
            let block = find_block_mut(tiptap_json, block_id)
                .ok_or_else(|| anyhow!("block {block_id} not found"))?;
            ensure_editable(block)?;
            if !insert_text(block, *offset_utf16, text) {
                bail!("offset {offset_utf16} outside block {block_id}");
            }
        }
        BridgeOperation::DeleteText {
            block_id,
            offset_utf16,
            len_utf16,
        } => {
            let block = find_block_mut(tiptap_json, block_id)
                .ok_or_else(|| anyhow!("block {block_id} not found"))?;
            ensure_editable(block)?;
            delete_text(block, *offset_utf16, *len_utf16)?;
        }
        BridgeOperation::FormatText {
            block_id,
            offset_utf16,
            len_utf16,
            mark_type,
            attrs,
        } => {
            let block = find_block_mut(tiptap_json, block_id)
                .ok_or_else(|| anyhow!("block {block_id} not found"))?;
            ensure_editable(block)?;
            format_text(block, *offset_utf16, *len_utf16, mark_type, attrs)?;
        }
        BridgeOperation::SplitBlock {
            block_id,
            offset_utf16,
            new_block_id,
        } => {
            split_top_level_block(tiptap_json, block_id, *offset_utf16, new_block_id.clone())?;
        }
        BridgeOperation::JoinNext { block_id } => {
            join_next_top_level_block(tiptap_json, block_id)?;
        }
        BridgeOperation::InsertBlock {
            after_block_id,
            block,
        } => {
            insert_top_level_block(tiptap_json, after_block_id.as_deref(), block.clone())?;
        }
        BridgeOperation::DeleteBlock { block_id } => {
            delete_top_level_block(tiptap_json, block_id)?;
        }
        BridgeOperation::MoveBlock {
            block_id,
            after_block_id,
        } => {
            move_top_level_block(tiptap_json, block_id, after_block_id.as_deref())?;
        }
        BridgeOperation::SetBlockAttrs { block_id, attrs } => {
            let block = find_block_mut(tiptap_json, block_id)
                .ok_or_else(|| anyhow!("block {block_id} not found"))?;
            let block_attrs = ensure_object_field(block, "attrs")?;
            for (key, value) in attrs {
                if value.is_null() {
                    block_attrs.remove(key);
                } else {
                    block_attrs.insert(key.clone(), value.clone());
                }
            }
            block_attrs.insert("data-block-id".to_string(), json!(block_id));
        }
        BridgeOperation::CreateInlineComment { .. }
        | BridgeOperation::CreateBlockComment { .. }
        | BridgeOperation::UpdateComment { .. }
        | BridgeOperation::DeleteComment { .. } => {
            bail!("comment mutations require a Y.Doc-backed bridge")
        }
        BridgeOperation::InsertFootnote {
            block_id,
            offset_utf16,
            content,
        } => {
            let block = find_block_mut(tiptap_json, block_id)
                .ok_or_else(|| anyhow!("block {block_id} not found"))?;
            ensure_editable(block)?;
            insert_footnote_json(block, *offset_utf16, content)?;
        }
        BridgeOperation::UpdateFootnote {
            block_id,
            atom_index,
            content,
        } => {
            let block = find_block_mut(tiptap_json, block_id)
                .ok_or_else(|| anyhow!("block {block_id} not found"))?;
            let mut cursor = 0usize;
            let footnote = find_inline_atom_mut(block, "footnote", *atom_index, &mut cursor)
                .ok_or_else(|| anyhow!("footnote {atom_index} not found in block {block_id}"))?;
            ensure_object_field(footnote, "attrs")?.insert("content".to_string(), json!(content));
        }
        BridgeOperation::DeleteFootnote {
            block_id,
            atom_index,
        } => {
            let block = find_block_mut(tiptap_json, block_id)
                .ok_or_else(|| anyhow!("block {block_id} not found"))?;
            let mut cursor = 0usize;
            if !delete_inline_atom(block, "footnote", *atom_index, &mut cursor) {
                bail!("footnote {atom_index} not found in block {block_id}");
            }
        }
    }
    Ok(())
}

fn find_block_mut<'a>(root: &'a mut Value, block_id: &str) -> Option<&'a mut Value> {
    if block_id_of(root).as_deref() == Some(block_id) {
        return Some(root);
    }
    let content = root.get_mut("content")?.as_array_mut()?;
    for child in content {
        if let Some(found) = find_block_mut(child, block_id) {
            return Some(found);
        }
    }
    None
}

fn block_id_of(node: &Value) -> Option<String> {
    let attrs = node.get("attrs")?.as_object()?;
    attrs
        .get("data-block-id")
        .or_else(|| attrs.get("blockId"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn ensure_editable(block: &Value) -> Result<()> {
    let node_type = block
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("paragraph");
    if support_for(node_type) != SupportLevel::EditableText {
        bail!("{node_type} is not editable text in the Vehicle bridge draft");
    }
    Ok(())
}

fn replace_block_text(block: &mut Value, text: &str) {
    let content = ensure_array_field(block, "content").expect("block object");
    content.clear();
    if !text.is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }
}

fn insert_text(block: &mut Value, offset_utf16: usize, text: &str) -> bool {
    let total = utf16_len(&plain_text(block));
    if offset_utf16 > total {
        return false;
    }
    if total == 0 {
        let content = ensure_array_field(block, "content").expect("block object");
        content.push(json!({ "type": "text", "text": text }));
        return offset_utf16 == 0;
    }
    let mut cursor = 0usize;
    insert_text_recurse(block, &mut cursor, offset_utf16, text)
}

fn insert_text_recurse(
    node: &mut Value,
    cursor: &mut usize,
    target_utf16: usize,
    insert: &str,
) -> bool {
    if node.get("type").and_then(Value::as_str) == Some("text") {
        let original = node
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let len = utf16_len(&original);
        if target_utf16 >= *cursor && target_utf16 <= *cursor + len {
            let local = target_utf16 - *cursor;
            let byte = byte_index_for_utf16(&original, local).unwrap_or(original.len());
            let mut next = original;
            next.insert_str(byte, insert);
            node["text"] = json!(next);
            *cursor += len;
            return true;
        }
        *cursor += len;
        return false;
    }
    if let Some(content) = node.get_mut("content").and_then(Value::as_array_mut) {
        for child in content {
            if insert_text_recurse(child, cursor, target_utf16, insert) {
                return true;
            }
        }
    }
    false
}

fn insert_footnote_json(block: &mut Value, offset_utf16: usize, content: &str) -> Result<()> {
    let total = utf16_len(&plain_text(block));
    if offset_utf16 > total {
        bail!("footnote offset {offset_utf16} outside block text length {total}");
    }
    let footnote = json!({ "type": "footnote", "attrs": { "content": content } });
    if total == 0 {
        ensure_array_field(block, "content")?.push(footnote);
        return Ok(());
    }
    let mut cursor = 0usize;
    if insert_inline_atom_json(block, &mut cursor, offset_utf16, &footnote) {
        Ok(())
    } else {
        bail!("could not place footnote at UTF-16 offset {offset_utf16}")
    }
}

fn insert_inline_atom_json(
    node: &mut Value,
    cursor: &mut usize,
    target_utf16: usize,
    atom: &Value,
) -> bool {
    let Some(content) = node.get_mut("content").and_then(Value::as_array_mut) else {
        return false;
    };
    let mut next = Vec::new();
    let mut inserted = false;
    for mut child in std::mem::take(content) {
        if !inserted && child.get("type").and_then(Value::as_str) == Some("text") {
            let original = child
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let len = utf16_len(&original);
            if target_utf16 >= *cursor && target_utf16 <= *cursor + len {
                let local = target_utf16 - *cursor;
                push_text_piece(&mut next, &child, &original, 0, local, None, None);
                next.push(atom.clone());
                push_text_piece(&mut next, &child, &original, local, len, None, None);
                inserted = true;
            } else {
                next.push(child);
            }
            *cursor += len;
        } else {
            if !inserted && insert_inline_atom_json(&mut child, cursor, target_utf16, atom) {
                inserted = true;
            }
            next.push(child);
        }
    }
    *content = next;
    inserted
}

fn find_inline_atom_mut<'a>(
    node: &'a mut Value,
    atom_type: &str,
    target_index: usize,
    cursor: &mut usize,
) -> Option<&'a mut Value> {
    if node.get("type").and_then(Value::as_str) == Some(atom_type) {
        if *cursor == target_index {
            return Some(node);
        }
        *cursor += 1;
        return None;
    }
    let content = node.get_mut("content")?.as_array_mut()?;
    for child in content {
        if let Some(found) = find_inline_atom_mut(child, atom_type, target_index, cursor) {
            return Some(found);
        }
    }
    None
}

fn delete_inline_atom(
    node: &mut Value,
    atom_type: &str,
    target_index: usize,
    cursor: &mut usize,
) -> bool {
    let Some(content) = node.get_mut("content").and_then(Value::as_array_mut) else {
        return false;
    };
    let mut index = 0usize;
    while index < content.len() {
        if content[index].get("type").and_then(Value::as_str) == Some(atom_type) {
            if *cursor == target_index {
                content.remove(index);
                return true;
            }
            *cursor += 1;
        } else if delete_inline_atom(&mut content[index], atom_type, target_index, cursor) {
            return true;
        }
        index += 1;
    }
    false
}

fn delete_text(block: &mut Value, offset_utf16: usize, len_utf16: usize) -> Result<()> {
    let total = utf16_len(&plain_text(block));
    if offset_utf16 > total || offset_utf16 + len_utf16 > total {
        bail!(
            "delete range {}..{} outside block text length {}",
            offset_utf16,
            offset_utf16 + len_utf16,
            total
        );
    }
    let mut cursor = 0usize;
    delete_text_recurse(block, &mut cursor, offset_utf16, offset_utf16 + len_utf16);
    prune_empty_text_nodes(block);
    Ok(())
}

fn delete_text_recurse(node: &mut Value, cursor: &mut usize, start: usize, end: usize) {
    if node.get("type").and_then(Value::as_str) == Some("text") {
        let original = node
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let len = utf16_len(&original);
        let node_start = *cursor;
        let node_end = node_start + len;
        if start < node_end && end > node_start {
            let local_start = start.saturating_sub(node_start);
            let local_end = end.min(node_end) - node_start;
            let byte_start = byte_index_for_utf16(&original, local_start).unwrap_or(0);
            let byte_end = byte_index_for_utf16(&original, local_end).unwrap_or(original.len());
            let mut next = original;
            next.replace_range(byte_start..byte_end, "");
            node["text"] = json!(next);
        }
        *cursor += len;
        return;
    }
    if let Some(content) = node.get_mut("content").and_then(Value::as_array_mut) {
        for child in content {
            delete_text_recurse(child, cursor, start, end);
        }
    }
}

fn format_text(
    block: &mut Value,
    offset_utf16: usize,
    len_utf16: usize,
    mark_type: &str,
    attrs: &Option<BTreeMap<String, Value>>,
) -> Result<()> {
    let total = utf16_len(&plain_text(block));
    if offset_utf16 > total || offset_utf16 + len_utf16 > total {
        bail!(
            "format range {}..{} outside block text length {}",
            offset_utf16,
            offset_utf16 + len_utf16,
            total
        );
    }
    let mut cursor = 0usize;
    format_text_recurse(
        block,
        &mut cursor,
        offset_utf16,
        offset_utf16 + len_utf16,
        mark_type,
        attrs,
    );
    Ok(())
}

fn format_text_recurse(
    node: &mut Value,
    cursor: &mut usize,
    start: usize,
    end: usize,
    mark_type: &str,
    attrs: &Option<BTreeMap<String, Value>>,
) {
    if let Some(content) = node.get_mut("content").and_then(Value::as_array_mut) {
        let mut next = Vec::new();
        for mut child in std::mem::take(content) {
            if child.get("type").and_then(Value::as_str) == Some("text") {
                let original = child
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let len = utf16_len(&original);
                let node_start = *cursor;
                let node_end = node_start + len;
                if start < node_end && end > node_start {
                    let local_start = start.saturating_sub(node_start);
                    let local_end = end.min(node_end) - node_start;
                    push_text_piece(&mut next, &child, &original, 0, local_start, None, None);
                    push_text_piece(
                        &mut next,
                        &child,
                        &original,
                        local_start,
                        local_end,
                        Some(mark_type),
                        attrs.as_ref(),
                    );
                    push_text_piece(&mut next, &child, &original, local_end, len, None, None);
                } else {
                    next.push(child);
                }
                *cursor += len;
            } else {
                format_text_recurse(&mut child, cursor, start, end, mark_type, attrs);
                next.push(child);
            }
        }
        *content = next;
    }
}

fn push_text_piece(
    out: &mut Vec<Value>,
    original_node: &Value,
    text: &str,
    start_utf16: usize,
    end_utf16: usize,
    mark_type: Option<&str>,
    attrs: Option<&BTreeMap<String, Value>>,
) {
    if start_utf16 >= end_utf16 {
        return;
    }
    let start = byte_index_for_utf16(text, start_utf16).unwrap_or(0);
    let end = byte_index_for_utf16(text, end_utf16).unwrap_or(text.len());
    let mut node = original_node.clone();
    node["text"] = json!(&text[start..end]);
    if let Some(mark_type) = mark_type {
        let marks = ensure_array_field(&mut node, "marks").expect("text node");
        let mut mark = Map::new();
        mark.insert("type".to_string(), json!(mark_type));
        if let Some(attrs) = attrs {
            mark.insert(
                "attrs".to_string(),
                Value::Object(attrs.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
            );
        }
        marks.push(Value::Object(mark));
    }
    out.push(node);
}

fn prune_empty_text_nodes(node: &mut Value) {
    if let Some(content) = node.get_mut("content").and_then(Value::as_array_mut) {
        for child in content.iter_mut() {
            prune_empty_text_nodes(child);
        }
        content.retain(|child| {
            child.get("type").and_then(Value::as_str) != Some("text")
                || !child
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .is_empty()
        });
    }
}

fn split_top_level_block(
    root: &mut Value,
    block_id: &str,
    offset_utf16: usize,
    new_block_id: Option<String>,
) -> Result<()> {
    let content = root
        .get_mut("content")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("document missing content array"))?;
    let index = content
        .iter()
        .position(|node| block_id_of(node).as_deref() == Some(block_id))
        .ok_or_else(|| anyhow!("top-level block {block_id} not found"))?;
    let text = plain_text(&content[index]);
    let total = utf16_len(&text);
    if offset_utf16 > total {
        bail!("split offset {offset_utf16} outside block text length {total}");
    }
    let byte = byte_index_for_utf16(&text, offset_utf16).unwrap_or(text.len());
    let before = text[..byte].to_string();
    let after = text[byte..].to_string();
    let mut new_block = content[index].clone();
    let new_id = new_block_id.unwrap_or_else(|| format!("{block_id}-split"));
    ensure_object_field(&mut new_block, "attrs")?
        .insert("data-block-id".to_string(), json!(new_id));
    replace_block_text(&mut content[index], &before);
    replace_block_text(&mut new_block, &after);
    content.insert(index + 1, new_block);
    Ok(())
}

fn join_next_top_level_block(root: &mut Value, block_id: &str) -> Result<()> {
    let content = root
        .get_mut("content")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("document missing content array"))?;
    let index = content
        .iter()
        .position(|node| block_id_of(node).as_deref() == Some(block_id))
        .ok_or_else(|| anyhow!("top-level block {block_id} not found"))?;
    if index + 1 >= content.len() {
        bail!("block {block_id} has no next sibling to join");
    }
    let joined = format!(
        "{}{}",
        plain_text(&content[index]),
        plain_text(&content[index + 1])
    );
    replace_block_text(&mut content[index], &joined);
    content.remove(index + 1);
    Ok(())
}

fn insert_top_level_block(
    root: &mut Value,
    after_block_id: Option<&str>,
    mut block: Value,
) -> Result<()> {
    let block_id = block_id_of(&block).ok_or_else(|| {
        anyhow!("insert-block requires block.attrs.data-block-id or block.attrs.blockId")
    })?;
    ensure_object_field(&mut block, "attrs")?.insert("data-block-id".to_string(), json!(block_id));
    let content = root
        .get_mut("content")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("document missing content array"))?;
    let index = match after_block_id {
        Some(after) => content
            .iter()
            .position(|node| block_id_of(node).as_deref() == Some(after))
            .map(|index| index + 1)
            .ok_or_else(|| anyhow!("after block {after} not found"))?,
        None => 0,
    };
    content.insert(index, block);
    Ok(())
}

fn delete_top_level_block(root: &mut Value, block_id: &str) -> Result<()> {
    let content = root
        .get_mut("content")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("document missing content array"))?;
    let index = content
        .iter()
        .position(|node| block_id_of(node).as_deref() == Some(block_id))
        .ok_or_else(|| anyhow!("top-level block {block_id} not found"))?;
    content.remove(index);
    Ok(())
}

fn move_top_level_block(
    root: &mut Value,
    block_id: &str,
    after_block_id: Option<&str>,
) -> Result<()> {
    let content = root
        .get_mut("content")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("document missing content array"))?;
    let index = content
        .iter()
        .position(|node| block_id_of(node).as_deref() == Some(block_id))
        .ok_or_else(|| anyhow!("top-level block {block_id} not found"))?;
    let block = content.remove(index);
    let insert_at = match after_block_id {
        Some(after) => content
            .iter()
            .position(|node| block_id_of(node).as_deref() == Some(after))
            .map(|index| index + 1)
            .ok_or_else(|| anyhow!("after block {after} not found"))?,
        None => 0,
    };
    content.insert(insert_at, block);
    Ok(())
}

fn ensure_array_field<'a>(node: &'a mut Value, key: &str) -> Result<&'a mut Vec<Value>> {
    let object = node
        .as_object_mut()
        .ok_or_else(|| anyhow!("expected JSON object"))?;
    if !object.get(key).is_some_and(Value::is_array) {
        object.insert(key.to_string(), Value::Array(Vec::new()));
    }
    Ok(object
        .get_mut(key)
        .and_then(Value::as_array_mut)
        .expect("array field inserted"))
}

fn ensure_object_field<'a>(node: &'a mut Value, key: &str) -> Result<&'a mut Map<String, Value>> {
    let object = node
        .as_object_mut()
        .ok_or_else(|| anyhow!("expected JSON object"))?;
    if !object.get(key).is_some_and(Value::is_object) {
        object.insert(key.to_string(), Value::Object(Map::new()));
    }
    Ok(object
        .get_mut(key)
        .and_then(Value::as_object_mut)
        .expect("object field inserted"))
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn byte_index_for_utf16(value: &str, offset: usize) -> Option<usize> {
    if offset == 0 {
        return Some(0);
    }
    let mut units = 0usize;
    for (byte_index, ch) in value.char_indices() {
        if units == offset {
            return Some(byte_index);
        }
        units += ch.len_utf16();
    }
    (units == offset).then_some(value.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::{
        accept_hdr_async,
        tungstenite::handshake::server::{Request, Response},
    };
    use yrs::Map as YMap;

    fn fixture() -> GardenJsonDocument {
        GardenJsonDocument {
            document_id: "doc-1".to_string(),
            title: "Doc 1".to_string(),
            blocks: vec![
                GardenJsonBlock {
                    block_id: "block-a".to_string(),
                    kind: "paragraph".to_string(),
                    text: "Hello world".to_string(),
                },
                GardenJsonBlock {
                    block_id: "block-b".to_string(),
                    kind: "heading".to_string(),
                    text: "Second".to_string(),
                },
            ],
        }
    }

    #[test]
    fn projects_json_document_through_ydoc() {
        let projection = project_json_document(&fixture()).unwrap();
        assert_eq!(projection.document_id, "doc-1");
        assert_eq!(projection.lines.len(), 2);
        assert_eq!(projection.lines[0].block_id, "block-a");
        assert_eq!(projection.lines[0].text, "Hello world");
        assert!(projection.tiptap_xml.contains("data-block-id=\"block-a\""));
    }

    #[test]
    fn update_v1_roundtrips_tiptap_blocks() {
        let tiptap = garden_json_to_tiptap_json(&fixture());
        let doc = ydoc_from_tiptap_json(&tiptap).unwrap();
        let bytes = encode_update_v1(&doc);
        let hydrated = ydoc_from_update_v1(&bytes).unwrap();
        let projection = project_ydoc(&hydrated, "doc-1", None, 0);
        assert_eq!(projection.lines[1].node_type, "heading");
        assert_eq!(projection.lines[1].attrs.get("level"), Some(&json!(2.0)));
    }

    #[test]
    fn awareness_cursor_roundtrips_block_and_utf16_offset() {
        let tiptap = json!({
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "attrs": { "data-block-id": "unicode-block" },
                "content": [{ "type": "text", "text": "café 🧪 漢字" }]
            }]
        });
        let doc = ydoc_from_tiptap_json(&tiptap).unwrap();
        let offset_utf16 = utf16_len("café 🧪");
        let cursor = sticky_index_for_block_offset(&doc, "unicode-block", offset_utf16).unwrap();
        let fragment = doc.get_or_insert_xml_fragment(CONTENT_FIELD);
        let txn = doc.transact();
        let cursor_offset = cursor.get_offset(&txn).unwrap();
        let (element, _) = find_ydoc_block(&txn, &fragment, "unicode-block").unwrap();
        let segments = collect_ydoc_text_segments(&txn, &element);
        let expected_branch = yrs::branch::BranchPtr::from(<XmlTextRef as AsRef<
            yrs::branch::Branch,
        >>::as_ref(&segments[0].text));
        assert_eq!(cursor_offset.branch, expected_branch);
        drop(txn);
        assert_eq!(
            resolve_sticky_index(&doc, &cursor),
            Some(("unicode-block".to_string(), offset_utf16))
        );

        let mut awareness = Awareness::new(doc.clone());
        awareness
            .set_local_state(json!({
                "user": { "name": "Neovim", "color": "#7aa2f7" },
                "cursor": { "anchor": cursor, "head": cursor },
                "editorSelection": { "blockId": "unicode-block", "timestamp": 1 },
            }))
            .unwrap();
        let session = LiveBridgeSession {
            doc: Some(doc),
            awareness: Some(awareness),
            document_id: Some("doc-presence".to_string()),
            ..Default::default()
        };
        let payload = session.awareness_payload().unwrap();
        assert_eq!(payload["document_id"], "doc-presence");
        assert_eq!(payload["clients"][0]["block_id"], "unicode-block");
        assert_eq!(payload["clients"][0]["offset_utf16"], offset_utf16);
        assert_eq!(payload["clients"][0]["state"]["user"]["name"], "Neovim");
        assert_eq!(payload["clients"][0]["local"], true);
    }

    #[test]
    fn ydoc_comments_and_footnotes_roundtrip_with_frontend_shapes() {
        let tiptap = json!({
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "attrs": { "data-block-id": "block-a" },
                    "content": [{
                        "type": "text",
                        "text": "alpha café 🧪 omega",
                        "marks": [{ "type": "bold" }]
                    }]
                },
                {
                    "type": "paragraph",
                    "attrs": { "data-block-id": "block-b" },
                    "content": [{ "type": "text", "text": "Block comment target" }]
                }
            ]
        });
        let doc = ydoc_from_tiptap_json(&tiptap).unwrap();
        let commented_len = utf16_len("café 🧪");
        apply_mutations_to_ydoc(
            &doc,
            &BridgeMutationRequest {
                document_id: Some("doc-notes".to_string()),
                title: None,
                operations: vec![
                    BridgeOperation::CreateInlineComment {
                        comment_id: "comment-inline".to_string(),
                        block_id: "block-a".to_string(),
                        offset_utf16: utf16_len("alpha "),
                        len_utf16: commented_len,
                        text: "Inline note".to_string(),
                        author: "Carol".to_string(),
                        author_id: "carol".to_string(),
                    },
                    BridgeOperation::CreateBlockComment {
                        comment_id: "comment-block".to_string(),
                        block_id: "block-b".to_string(),
                        text: "Block note".to_string(),
                        author: "Carol".to_string(),
                        author_id: "carol".to_string(),
                    },
                    BridgeOperation::InsertFootnote {
                        block_id: "block-a".to_string(),
                        offset_utf16: utf16_len("alpha café"),
                        content: "First footnote".to_string(),
                    },
                ],
            },
        )
        .unwrap();

        let projection = project_ydoc(&doc, "doc-notes", None, 0);
        assert_eq!(projection.lines[0].text, "alpha café 🧪 omega");
        assert_eq!(projection.lines[0].inline_atoms.len(), 1);
        assert_eq!(projection.lines[0].inline_atoms[0].atom_type, "footnote");
        assert_eq!(
            projection.lines[0].inline_atoms[0].attrs["content"],
            "First footnote"
        );
        let footnote_offset = projection.lines[0].inline_atoms[0].offset_utf16;
        let footnote_cursor = sticky_index_for_block_offset(&doc, "block-a", footnote_offset)
            .expect("awareness cursor at footnote boundary");
        assert_eq!(
            resolve_sticky_index(&doc, &footnote_cursor),
            Some(("block-a".to_string(), footnote_offset))
        );
        let inline = projection
            .comments
            .iter()
            .find(|comment| comment.comment_id == "comment-inline")
            .unwrap();
        assert_eq!(inline.block_id.as_deref(), Some("block-a"));
        assert_eq!(inline.start_utf16, Some(utf16_len("alpha ")));
        assert_eq!(inline.end_utf16, Some(utf16_len("alpha ") + commented_len));
        assert_eq!(inline.data["quotedText"], "café 🧪");
        assert_eq!(inline.data["author"], "Carol");
        assert_eq!(inline.data["documentPosition"], 7.0);
        let block = projection
            .comments
            .iter()
            .find(|comment| comment.comment_id == "comment-block")
            .unwrap();
        assert_eq!(block.block_id.as_deref(), Some("block-b"));
        assert_eq!(block.start_utf16, None);
        assert_eq!(block.data["documentPosition"], 21.0);

        apply_mutations_to_ydoc(
            &doc,
            &BridgeMutationRequest {
                document_id: Some("doc-notes".to_string()),
                title: None,
                operations: vec![
                    BridgeOperation::UpdateComment {
                        comment_id: "comment-inline".to_string(),
                        text: Some("Edited inline note".to_string()),
                        resolved: Some(true),
                    },
                    BridgeOperation::UpdateFootnote {
                        block_id: "block-a".to_string(),
                        atom_index: 0,
                        content: "Edited footnote".to_string(),
                    },
                ],
            },
        )
        .unwrap();
        let updated = project_ydoc(&doc, "doc-notes", None, 0);
        let inline = updated
            .comments
            .iter()
            .find(|comment| comment.comment_id == "comment-inline")
            .unwrap();
        assert_eq!(inline.data["text"], "Edited inline note");
        assert_eq!(inline.data["resolved"], true);
        assert_eq!(
            updated.lines[0].inline_atoms[0].attrs["content"],
            "Edited footnote"
        );

        apply_mutations_to_ydoc(
            &doc,
            &BridgeMutationRequest {
                document_id: Some("doc-notes".to_string()),
                title: None,
                operations: vec![
                    BridgeOperation::DeleteComment {
                        comment_id: "comment-inline".to_string(),
                    },
                    BridgeOperation::DeleteFootnote {
                        block_id: "block-a".to_string(),
                        atom_index: 0,
                    },
                ],
            },
        )
        .unwrap();
        let cleaned = project_ydoc(&doc, "doc-notes", None, 0);
        assert_eq!(cleaned.lines[0].text, "alpha café 🧪 omega");
        assert!(cleaned.lines[0].inline_atoms.is_empty());
        assert!(
            cleaned.lines[0]
                .marks
                .iter()
                .all(|mark| mark.mark_type != "commentMark")
        );
        assert_eq!(cleaned.comments.len(), 1);
        assert_eq!(cleaned.comments[0].comment_id, "comment-block");
    }

    #[test]
    fn mutation_edits_text_and_preserves_block_id() {
        let mut tiptap = garden_json_to_tiptap_json(&fixture());
        apply_mutations_to_tiptap_json(
            &mut tiptap,
            &BridgeMutationRequest {
                document_id: Some("doc-1".to_string()),
                title: None,
                operations: vec![
                    BridgeOperation::InsertText {
                        block_id: "block-a".to_string(),
                        offset_utf16: 5,
                        text: ", Vehicle".to_string(),
                    },
                    BridgeOperation::DeleteText {
                        block_id: "block-a".to_string(),
                        offset_utf16: 0,
                        len_utf16: 1,
                    },
                ],
            },
        )
        .unwrap();
        let projection = project_tiptap_json(tiptap, "doc-1", None, 1, String::new());
        assert_eq!(projection.lines[0].block_id, "block-a");
        assert_eq!(projection.lines[0].text, "ello, Vehicle world");
    }

    #[test]
    fn mutation_handles_utf16_offsets() {
        let mut doc = fixture();
        doc.blocks[0].text = "a😀b".to_string();
        let mut tiptap = garden_json_to_tiptap_json(&doc);
        apply_mutations_to_tiptap_json(
            &mut tiptap,
            &BridgeMutationRequest {
                document_id: None,
                title: None,
                operations: vec![BridgeOperation::InsertText {
                    block_id: "block-a".to_string(),
                    offset_utf16: 3,
                    text: "X".to_string(),
                }],
            },
        )
        .unwrap();
        let projection = project_tiptap_json(tiptap, "doc-1", None, 1, String::new());
        assert_eq!(projection.lines[0].text, "a😀Xb");
    }

    #[test]
    fn mutation_can_format_split_join_move_and_delete() {
        let mut tiptap = garden_json_to_tiptap_json(&fixture());
        apply_mutations_to_tiptap_json(
            &mut tiptap,
            &BridgeMutationRequest {
                document_id: None,
                title: None,
                operations: vec![
                    BridgeOperation::FormatText {
                        block_id: "block-a".to_string(),
                        offset_utf16: 0,
                        len_utf16: 5,
                        mark_type: "bold".to_string(),
                        attrs: None,
                    },
                    BridgeOperation::SplitBlock {
                        block_id: "block-a".to_string(),
                        offset_utf16: 5,
                        new_block_id: Some("block-c".to_string()),
                    },
                    BridgeOperation::JoinNext {
                        block_id: "block-a".to_string(),
                    },
                    BridgeOperation::InsertBlock {
                        after_block_id: Some("block-a".to_string()),
                        block: json!({
                            "type": "paragraph",
                            "attrs": { "data-block-id": "block-d" },
                            "content": [{ "type": "text", "text": "Inserted" }]
                        }),
                    },
                    BridgeOperation::MoveBlock {
                        block_id: "block-d".to_string(),
                        after_block_id: Some("block-b".to_string()),
                    },
                    BridgeOperation::DeleteBlock {
                        block_id: "block-d".to_string(),
                    },
                ],
            },
        )
        .unwrap();
        let projection = project_tiptap_json(tiptap, "doc-1", None, 1, String::new());
        assert_eq!(projection.lines.len(), 2);
        assert_eq!(projection.lines[0].block_id, "block-a");
        assert_eq!(projection.lines[0].text, "Hello world");
    }

    #[test]
    fn ydoc_apply_preserves_non_content_root_state() {
        let tiptap = garden_json_to_tiptap_json(&fixture());
        let doc = ydoc_from_tiptap_json(&tiptap).unwrap();
        {
            let comments = doc.get_or_insert_map("comments");
            let mut txn = doc.transact_mut();
            comments.insert(&mut txn, "comment-1", Any::from("preserve me"));
        }

        let tempdir = tempfile::tempdir().unwrap();
        let path = tempdir.path().join("doc.update-v1.bin");
        write_ydoc_update_v1(&path, &doc).unwrap();

        let projection = apply_ydoc_mutations_path(
            &path,
            "doc-1",
            BridgeMutationRequest {
                document_id: Some("doc-1".to_string()),
                title: None,
                operations: vec![BridgeOperation::ReplaceBlockText {
                    block_id: "block-a".to_string(),
                    text: "Direct yrs mutation".to_string(),
                }],
            },
        )
        .unwrap();
        assert_eq!(projection.lines[0].text, "Direct yrs mutation");

        let hydrated = read_ydoc_update_v1(&path).unwrap();
        let comments = hydrated.get_or_insert_map("comments");
        let txn = hydrated.transact();
        assert!(matches!(
            comments.get(&txn, "comment-1"),
            Some(Out::Any(Any::String(value))) if value.as_ref() == "preserve me"
        ));
    }

    #[test]
    fn ydoc_replace_text_preserves_marks_and_nested_block_structure() {
        let tiptap = json!({
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "attrs": { "data-block-id": "marked" },
                    "content": [
                        { "type": "text", "text": "Keep " },
                        { "type": "text", "text": "bold", "marks": [{ "type": "bold" }] },
                        { "type": "text", "text": " intact." }
                    ]
                },
                {
                    "type": "listItem",
                    "attrs": {
                        "data-block-id": "list",
                        "listType": "bullet",
                        "indent": 0
                    },
                    "content": [{
                        "type": "paragraph",
                        "attrs": { "data-block-id": "list-child" },
                        "content": [{ "type": "text", "text": "List child stays nested." }]
                    }]
                }
            ]
        });
        let doc = ydoc_from_tiptap_json(&tiptap).unwrap();
        apply_mutations_to_ydoc(
            &doc,
            &BridgeMutationRequest {
                document_id: Some("doc-1".to_string()),
                title: None,
                operations: vec![
                    BridgeOperation::ReplaceBlockText {
                        block_id: "marked".to_string(),
                        text: "Keep bold intact!".to_string(),
                    },
                    BridgeOperation::ReplaceBlockText {
                        block_id: "list".to_string(),
                        text: "List child updated.".to_string(),
                    },
                ],
            },
        )
        .unwrap();

        let projection = project_ydoc(&doc, "doc-1", None, 1);
        assert!(projection.tiptap_xml.contains("<bold>bold</bold>"));
        assert_eq!(projection.lines[0].text, "Keep bold intact!");
        assert_eq!(projection.lines[1].text, "List child updated.");
        assert_eq!(projection.tiptap_json["content"][1]["type"], "listItem");
        assert_eq!(
            projection.tiptap_json["content"][1]["content"][0]["type"],
            "paragraph"
        );
    }

    #[test]
    fn ydoc_apply_formats_text_directly() {
        let tiptap = garden_json_to_tiptap_json(&fixture());
        let doc = ydoc_from_tiptap_json(&tiptap).unwrap();
        apply_mutations_to_ydoc(
            &doc,
            &BridgeMutationRequest {
                document_id: Some("doc-1".to_string()),
                title: None,
                operations: vec![BridgeOperation::FormatText {
                    block_id: "block-a".to_string(),
                    offset_utf16: 0,
                    len_utf16: 5,
                    mark_type: "bold".to_string(),
                    attrs: None,
                }],
            },
        )
        .unwrap();

        let projection = project_ydoc(&doc, "doc-1", None, 1);
        assert_eq!(projection.lines[0].marks[0].mark_type, "bold");
        assert_eq!(projection.lines[0].marks[0].start_utf16, 0);
        assert_eq!(projection.lines[0].marks[0].end_utf16, 5);
    }

    #[test]
    fn ydoc_apply_supports_direct_text_and_block_operations() {
        let tiptap = garden_json_to_tiptap_json(&fixture());
        let doc = ydoc_from_tiptap_json(&tiptap).unwrap();
        apply_mutations_to_ydoc(
            &doc,
            &BridgeMutationRequest {
                document_id: Some("doc-1".to_string()),
                title: None,
                operations: vec![
                    BridgeOperation::InsertText {
                        block_id: "block-a".to_string(),
                        offset_utf16: 5,
                        text: ", direct".to_string(),
                    },
                    BridgeOperation::SplitBlock {
                        block_id: "block-a".to_string(),
                        offset_utf16: 13,
                        new_block_id: Some("block-c".to_string()),
                    },
                    BridgeOperation::JoinNext {
                        block_id: "block-a".to_string(),
                    },
                    BridgeOperation::InsertBlock {
                        after_block_id: Some("block-a".to_string()),
                        block: json!({
                            "type": "paragraph",
                            "attrs": { "data-block-id": "block-d" },
                            "content": [{ "type": "text", "text": "Inserted direct" }]
                        }),
                    },
                    BridgeOperation::MoveBlock {
                        block_id: "block-d".to_string(),
                        after_block_id: Some("block-b".to_string()),
                    },
                    BridgeOperation::DeleteBlock {
                        block_id: "block-d".to_string(),
                    },
                ],
            },
        )
        .unwrap();

        let projection = project_ydoc(&doc, "doc-1", None, 1);
        assert_eq!(projection.lines.len(), 2);
        assert_eq!(projection.lines[0].block_id, "block-a");
        assert_eq!(projection.lines[0].text, "Hello, direct world");
    }

    #[test]
    #[allow(clippy::result_large_err)]
    fn sync_once_hydrates_from_y_websocket_room() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let mut server_fixture = fixture();
            server_fixture.blocks[0].text = "Server room state".to_string();
            let server_doc =
                ydoc_from_tiptap_json(&garden_json_to_tiptap_json(&server_fixture)).unwrap();

            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket =
                    accept_hdr_async(stream, |request: &Request, response: Response| {
                        assert_eq!(
                            request.headers().get(header::AUTHORIZATION).unwrap(),
                            "Bearer fixture-token"
                        );
                        assert_eq!(
                            request.headers().get("x-pn-on-behalf-of").unwrap(),
                            "fixture-subject"
                        );
                        Ok(response)
                    })
                    .await
                    .unwrap();
                let step1 = {
                    let txn = server_doc.transact();
                    YMessage::Sync(SyncMessage::SyncStep1(txn.state_vector())).encode_v1()
                };
                socket.send(WsMessage::Binary(step1.into())).await.unwrap();

                while let Some(Ok(frame)) = socket.next().await {
                    let WsMessage::Binary(data) = frame else {
                        continue;
                    };
                    let message = YMessage::decode_v1(&data).unwrap();
                    match message {
                        YMessage::Sync(SyncMessage::SyncStep1(state_vector)) => {
                            let update = {
                                let txn = server_doc.transact();
                                txn.encode_state_as_update_v1(&state_vector)
                            };
                            socket
                                .send(WsMessage::Binary(
                                    YMessage::Sync(SyncMessage::SyncStep2(update))
                                        .encode_v1()
                                        .into(),
                                ))
                                .await
                                .unwrap();
                            break;
                        }
                        YMessage::Sync(SyncMessage::SyncStep2(update))
                        | YMessage::Sync(SyncMessage::Update(update)) => {
                            let decoded = Update::decode_v1(&update).unwrap();
                            let mut txn = server_doc.transact_mut();
                            txn.apply_update(decoded).unwrap();
                        }
                        YMessage::Awareness(_) | YMessage::AwarenessQuery => {}
                        YMessage::Auth(_) | YMessage::Custom(..) => {}
                    }
                }
            });

            let tempdir = tempfile::tempdir().unwrap();
            let path = tempdir.path().join("doc.update-v1.bin");
            let projection = sync_ydoc_once_path(
                &path,
                "doc-1",
                &format!("ws://{addr}"),
                Some("fixture-token"),
                Some("fixture-subject"),
                Duration::from_secs(2),
            )
            .await
            .unwrap();

            assert_eq!(projection.lines[0].text, "Server room state");
            assert!(path.exists());
            server.await.unwrap();
        });
    }
}
