//! The ride protocol v2 (`sophia.vehicle-ride.v2`), client side.
//!
//! A ride session lives in `vehicle-host`, which gardend supervises as its local service `vehicle` and mounts
//! at `/services/vehicle` (`protocol/ride-v2.md`). Vehicle never talks to `vehicle-host` directly: it goes
//! through gardend, which authenticates the caller (the profile's master key or a gardend token, sent here as
//! `Authorization: Bearer ...` and nowhere else), drops whatever identity a caller sends and mints its own.
//! A graph is bound by the path (`/services/vehicle/g/<graph>/...`), never by a request body.
//!
//! This module is the HTTP client (sessions, lease, commands, chimes, inspect, capsule, watch), the event
//! watcher a room runs (SSE, with long-poll when the proxy cannot stream or the stream drops), and the JSONL
//! form of the ride over stdio, for agents.

use anyhow::{Context, Result, anyhow, bail};
use reqwest::{
    Method, StatusCode,
    blocking::{Client, RequestBuilder, Response},
    header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    fmt, fs,
    io::{BufRead, BufReader, Write},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const RIDE_PROTOCOL: &str = "sophia.vehicle-ride.v2";
pub const DEFAULT_GARDEND_URL: &str = "http://127.0.0.1:7674";
pub const SERVICE_MOUNT: &str = "/services/vehicle";
/// The header naming one client instance (a terminal, a chat tab, an agent): the unit that holds the lease.
pub const CLIENT_ID_HEADER: &str = "x-vehicle-client-id";
/// A visitor of a public Sophia (no credential): who it is from one request to the next (gardend hashes it into
/// the visitor's principal, `anon:<hash>`). It carries no authority beyond being the same visitor.
pub const VISITOR_ID_HEADER: &str = "x-visitor-id";
/// The caller's own model key (an OpenRouter key): a public Sophia's conversations run on it. Sent as this header
/// and nowhere else; gardend hands it only to the service that takes it, which keeps it in memory.
pub const MODEL_KEY_HEADER: &str = "x-model-key";
pub const MAX_WAIT_MS: u64 = 30_000;
pub const MAX_CHIME_CHARS: usize = 16_000;
pub const MAX_AUTHOR_CHARS: usize = 64;
const LONG_POLL_WAIT_MS: u64 = 25_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

// ─── Credentials and the endpoint ────────────────────────────────────────────

/// What gardend accepts as `Authorization: Bearer ...`: the profile's master key or a gardend client token.
/// It is only ever sent as that header: never printed, logged or put in a URL.
#[derive(Clone)]
pub struct Credential(String);

impl fmt::Debug for Credential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Credential(<redacted>)")
    }
}

#[derive(Deserialize)]
struct KeyFile {
    key: String,
}

impl Credential {
    pub fn new(secret: impl Into<String>) -> Result<Self> {
        let secret = secret.into().trim().to_string();
        if secret.is_empty() || !secret.bytes().all(|byte| byte.is_ascii_graphic()) {
            bail!("the credential must be one printable token");
        }
        Ok(Self(secret))
    }

    /// The master key of a self-host profile: `<profile>/selfhost-key.json`, `{"key": "..."}`.
    pub fn from_key_file(path: &Path) -> Result<Self> {
        let body = fs::read_to_string(path)
            .with_context(|| format!("read the key file {}", path.display()))?;
        // Never echo the file: a parse error could quote it.
        let file: KeyFile = serde_json::from_str(&body).map_err(|_| {
            anyhow!(
                "{} is not a gardend key file ({{\"key\": ...}})",
                path.display()
            )
        })?;
        Self::new(file.key).with_context(|| format!("the key in {}", path.display()))
    }

    /// A gardend token from the environment variable `name` when it is set, else the key file.
    pub fn resolve(token_env: &str, key_file: &Path) -> Result<Self> {
        if let Some(token) = std::env::var(token_env)
            .ok()
            .filter(|value| !value.trim().is_empty())
        {
            return Self::new(token).with_context(|| format!("the token in ${token_env}"));
        }
        Self::from_key_file(key_file).with_context(|| {
            format!(
                "no credential: set ${token_env} to a gardend token (`gardend token create --grant member`), or point --key-file at the profile's selfhost-key.json"
            )
        })
    }

    /// The `Authorization` header value. Send it as that header and nowhere else.
    pub fn bearer_header(&self) -> String {
        format!("Bearer {}", self.0)
    }

    /// The bare value, for a header of its own (`X-Model-Key`). Never print it.
    pub fn header_value(&self) -> &str {
        &self.0
    }
}

/// Where a ride goes: gardend's address, the graph the path binds (if any), the credential (none for a visitor of
/// a public Sophia), and this client.
#[derive(Debug, Clone)]
pub struct RideEndpoint {
    pub gardend_url: String,
    pub graph_id: Option<String>,
    pub credential: Option<Credential>,
    pub client_id: String,
    /// A visitor's id (`X-Visitor-Id`), when the ride goes without a credential.
    pub visitor_id: Option<String>,
    /// The caller's own model key (`X-Model-Key`), when it brings one.
    pub model_key: Option<Credential>,
}

impl RideEndpoint {
    pub fn new(
        gardend_url: &str,
        graph_id: Option<&str>,
        credential: Credential,
        client_id: &str,
    ) -> Result<Self> {
        let gardend_url = gardend_url.trim().trim_end_matches('/').to_string();
        if !(gardend_url.starts_with("http://") || gardend_url.starts_with("https://")) {
            bail!("--gardend must be an http(s) URL, such as {DEFAULT_GARDEND_URL}");
        }
        let graph_id = graph_id
            .map(str::trim)
            .filter(|graph| !graph.is_empty())
            .map(str::to_string);
        if let Some(graph) = &graph_id {
            validate_graph_id(graph)?;
        }
        validate_client_id(client_id)?;
        Ok(Self {
            gardend_url,
            graph_id,
            credential: Some(credential),
            client_id: client_id.to_string(),
            visitor_id: None,
            model_key: None,
        })
    }

    /// A ride with no credential: a visitor of a public Sophia (gardend in public mode), as `visitor_id`.
    pub fn anonymous(
        gardend_url: &str,
        graph_id: Option<&str>,
        visitor_id: &str,
        client_id: &str,
    ) -> Result<Self> {
        let visitor_id = visitor_id.trim();
        if !(16..=128).contains(&visitor_id.len())
            || !visitor_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            bail!("a visitor id is 16 to 128 of [A-Za-z0-9_-]");
        }
        let mut endpoint = Self::new(gardend_url, graph_id, Credential::new("unused")?, client_id)?;
        endpoint.credential = None;
        endpoint.visitor_id = Some(visitor_id.to_string());
        Ok(endpoint)
    }

    /// Send the caller's own model key with every request (`X-Model-Key`).
    pub fn with_model_key(mut self, key: Credential) -> Self {
        self.model_key = Some(key);
        self
    }

    /// `<gardend>/services/vehicle`, or `<gardend>/services/vehicle/g/<graph>` when a graph is bound.
    pub fn base_url(&self) -> String {
        match &self.graph_id {
            Some(graph) => format!("{}{SERVICE_MOUNT}/g/{graph}", self.gardend_url),
            None => format!("{}{SERVICE_MOUNT}", self.gardend_url),
        }
    }
}

pub fn validate_graph_id(graph: &str) -> Result<()> {
    let mut bytes = graph.bytes();
    let first_ok = bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric());
    if !first_ok
        || graph.len() > 200
        || !graph
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
    {
        bail!("{graph:?} is not a graph id");
    }
    Ok(())
}

pub fn validate_session_id(session_id: &str) -> Result<()> {
    if session_id.is_empty()
        || session_id.len() > 128
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        bail!("{session_id:?} is not a session id");
    }
    Ok(())
}

fn validate_client_id(client_id: &str) -> Result<()> {
    if client_id.trim().is_empty()
        || client_id.len() > 256
        || !client_id.bytes().all(|byte| byte.is_ascii_graphic())
    {
        bail!("the client id must be one printable token of at most 256 bytes");
    }
    Ok(())
}

static MINTED: AtomicU64 = AtomicU64::new(0);

fn millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// A fresh id for a request: `<prefix>-<ms>-<pid>-<n>`.
pub fn mint_id(prefix: &str) -> String {
    let count = MINTED.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{}-{count}", millis(), std::process::id())
}

/// A client id unique to this process: `vehicle-<kind>-<pid>-<ms>`.
pub fn process_client_id(kind: &str) -> String {
    format!("vehicle-{kind}-{}-{}", std::process::id(), millis())
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/// A refusal: a ride error frame (`{"type":"error","code":...}`), or gardend's own refusal before the ride.
#[derive(Debug, Clone)]
pub struct RideError {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

impl fmt::Display for RideError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} ({}): {}",
            self.code, self.status, self.message
        )?;
        if let Some(holder) = self
            .details
            .as_ref()
            .and_then(|details| details.pointer("/holder/clientId"))
            .and_then(Value::as_str)
        {
            write!(formatter, " [held by {holder}]")?;
        }
        Ok(())
    }
}

impl std::error::Error for RideError {}

impl RideError {
    fn from_reply(status: StatusCode, body: &Value, text: &str) -> Self {
        let code = body
            .get("code")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| match status {
                StatusCode::UNAUTHORIZED => "gardend_unauthorized".to_string(),
                StatusCode::FORBIDDEN => "gardend_forbidden".to_string(),
                _ => format!("http_{}", status.as_u16()),
            });
        let mut message = body
            .get("message")
            .or_else(|| body.get("error"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| text.chars().take(300).collect());
        if body.get("code").is_none() {
            if status == StatusCode::UNAUTHORIZED {
                message = format!(
                    "gardend refused the credential ({message}); check --key-file or the token variable"
                );
            } else if status == StatusCode::BAD_GATEWAY || status == StatusCode::NOT_FOUND {
                message = format!(
                    "{message} (is gardend's `vehicle` service configured and up? `/self-host.json` lists it)"
                );
            }
        }
        Self {
            status: status.as_u16(),
            code,
            message,
            details: body.get("details").cloned(),
        }
    }

    /// The ride error frame for this refusal, as the JSONL ride prints it.
    pub fn frame(&self, request_id: Option<&str>) -> Value {
        let mut frame = json!({
            "protocol": RIDE_PROTOCOL,
            "type": "error",
            "code": self.code,
            "message": self.message,
            "status": self.status,
        });
        if let Some(details) = &self.details {
            frame["details"] = details.clone();
        }
        if let Some(request_id) = request_id {
            frame["requestId"] = json!(request_id);
        }
        frame
    }
}

/// The ride refusal inside an error, if that is what it is.
pub fn ride_error(error: &anyhow::Error) -> Option<&RideError> {
    error.downcast_ref::<RideError>()
}

/// Whether an error is the ride refusal `code`.
pub fn is_ride_error(error: &anyhow::Error, code: &str) -> bool {
    ride_error(error).is_some_and(|refusal| refusal.code == code)
}

// ─── What the ride returns ───────────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LeaseView {
    pub client_id: String,
    pub claimed_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionSummary {
    pub session_id: String,
    pub graph_id: String,
    pub profile: String,
    pub access: String,
    pub model: String,
    pub created_at: String,
    pub updated_at: String,
    pub title: Option<String>,
    pub preview: Option<String>,
    /// An agent session's box: `bwrap`, `seatbelt` or `none`.
    #[serde(default)]
    pub isolation: Option<String>,
    pub parent: Option<Value>,
    /// `running`, `idle` or `dormant` (no body in memory).
    pub status: String,
    pub cursor: u64,
    pub budget: Value,
    pub lease: Option<LeaseView>,
    pub room_policy: String,
}

impl SessionSummary {
    /// What a list shows for the session: its title, else the first thing said, else its id.
    pub fn label(&self) -> String {
        self.title
            .clone()
            .or_else(|| self.preview.clone())
            .filter(|label| !label.trim().is_empty())
            .unwrap_or_else(|| self.session_id.clone())
    }

    /// The session this one was branched (`fork`) or duplicated (`clone`) from.
    pub fn parent_ref(&self) -> Option<ParentRef> {
        let parent = self.parent.as_ref()?;
        let session_id = parent.get("sessionId")?.as_str()?.to_string();
        let kind = parent
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("fork")
            .to_string();
        let entry_id = parent
            .get("entryId")
            .and_then(Value::as_str)
            .map(str::to_string);
        Some(ParentRef {
            session_id,
            kind,
            entry_id,
        })
    }

    /// Its lineage as a list says it, `↳ branched from <its source>` (or `duplicated from`), with the source
    /// found among `listed`; a source that is no longer listed (deleted) is "a deleted conversation".
    pub fn lineage(&self, listed: &[SessionSummary]) -> Option<String> {
        let parent = self.parent_ref()?;
        let source = listed
            .iter()
            .find(|session| session.session_id == parent.session_id)
            .map(|session| {
                let label: String = session
                    .label()
                    .replace('\n', " ")
                    .chars()
                    .take(60)
                    .collect();
                format!("\"{label}\" ({})", short_session_id(&parent.session_id))
            })
            .unwrap_or_else(|| "a deleted conversation".to_string());
        Some(format!("↳ {} from {source}", parent.verb()))
    }
}

/// A branch's source, as its summary names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParentRef {
    pub session_id: String,
    /// `fork` (branched from before one of its messages) or `clone` (duplicated).
    pub kind: String,
    /// The source's user message the branch was forked before.
    pub entry_id: Option<String>,
}

impl ParentRef {
    /// "branched" for a fork, "duplicated" for a clone.
    pub fn verb(&self) -> &'static str {
        if self.kind == "clone" {
            "duplicated"
        } else {
            "branched"
        }
    }
}

/// A session id shortened for a list or a status line: the last eight characters of its last group. A branch's
/// id is pi's, time-ordered (UUIDv7), so its first characters are those of every session made in the same minute;
/// the end is random.
pub fn short_session_id(session_id: &str) -> &str {
    let tail = session_id.rsplit('-').next().unwrap_or(session_id);
    let skip = tail.chars().count().saturating_sub(8);
    tail.char_indices()
        .nth(skip)
        .map_or(tail, |(at, _)| &tail[at..])
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ToolCallView {
    pub name: String,
    pub args: Value,
}

/// One message on the session's active branch, as `inspect` gives it (pi's own transcript).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TranscriptItem {
    pub entry_id: String,
    /// `user`, `assistant` or `toolResult`.
    pub role: String,
    pub text: String,
    pub tool_calls: Vec<ToolCallView>,
    pub tool_name: Option<String>,
    pub is_error: bool,
    pub stop_reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PendingChime {
    pub chime_id: String,
    pub author: String,
    pub principal: String,
    pub delivery: String,
    pub text: String,
    pub status: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CommandView {
    pub command_id: String,
    pub op: String,
    pub status: String,
    pub disposition: Option<String>,
    pub via: Option<Value>,
    pub error: Option<String>,
    pub run_id: Option<String>,
    pub accepted_at: String,
}

/// `inspect`: the session, its commands, what pi has queued, the chimes waiting on the driver, the transcript.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Snapshot {
    pub cursor: u64,
    pub session: SessionSummary,
    pub commands: Vec<CommandView>,
    pub queue: Vec<Value>,
    pub chimes: Vec<PendingChime>,
    pub transcript: Vec<TranscriptItem>,
    pub stats: Option<Value>,
    pub tools: Option<Vec<String>>,
}

/// One durable event of a session's log; `seq` is the watch cursor.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RideEvent {
    pub seq: u64,
    pub ts: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct WatchBatch {
    pub events: Vec<RideEvent>,
    pub cursor: u64,
    pub more: bool,
}

/// How a chime is delivered when the room accepts it: as the driver's prompt, follow-up or steer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Delivery {
    Prompt,
    FollowUp,
    Steer,
}

impl Delivery {
    pub fn op(self) -> &'static str {
        match self {
            Self::Prompt => "prompt",
            Self::FollowUp => "follow_up",
            Self::Steer => "steer",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChimeRequest {
    pub request_id: String,
    /// The collaborator's name as the model and the transcript show it: `[<author> collaborator]`.
    pub author: String,
    pub delivery: Delivery,
    pub text: String,
}

impl ChimeRequest {
    /// The host checks the same bounds; checking here gives a clear message before anything is sent.
    pub fn validate(&self) -> Result<()> {
        let author = self.author.trim();
        if author.is_empty()
            || author.chars().count() > MAX_AUTHOR_CHARS
            || !author
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '.' | '-'))
        {
            bail!("the chime author is 1 to {MAX_AUTHOR_CHARS} letters, digits, spaces, _ . or -");
        }
        if self.text.trim().is_empty() || self.text.contains('\0') {
            bail!("the chime text must be non-empty");
        }
        if self.text.chars().count() > MAX_CHIME_CHARS {
            bail!("the chime text is at most {MAX_CHIME_CHARS} characters");
        }
        Ok(())
    }

    fn body(&self) -> Value {
        json!({
            "requestId": self.request_id,
            "author": self.author.trim(),
            "delivery": self.delivery.op(),
            "text": self.text,
        })
    }
}

/// What the room's policy made of a chime.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChimeOutcome {
    /// `pending` (suggest: the driver decides), `submitted` (co-drive) or `rejected` (observe, mute).
    pub disposition: String,
    pub chime_id: Option<String>,
    pub policy: Option<String>,
    pub message: Option<String>,
    pub command_id: Option<String>,
}

impl ChimeOutcome {
    pub fn from_frame(frame: &Value) -> Self {
        let value = &frame["value"];
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
        Self {
            disposition: text("disposition").unwrap_or_else(|| {
                if frame["type"] == "chime.rejected" {
                    "rejected".to_string()
                } else {
                    "accepted".to_string()
                }
            }),
            chime_id: text("chimeId"),
            policy: text("policy"),
            message: text("message"),
            command_id: value
                .pointer("/command/commandId")
                .and_then(Value::as_str)
                .map(str::to_string),
        }
    }
}

/// A new conversation made from another: `fork` (from before one of its messages) or `clone` (a duplicate).
#[derive(Debug, Clone, Default)]
pub struct Branch {
    pub session: SessionSummary,
    /// A fork's: the message it was forked before, as the person wrote it (to edit and send again).
    pub selected_text: Option<String>,
}

/// One of the messages said in a session (the person's, or a collaborator's chime), numbered from 1 in
/// the order of its transcript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserMessage {
    pub number: usize,
    pub entry_id: String,
    pub text: String,
}

/// The message a branch starts before: `before` is its number (1 = the first message said in the
/// session) or pi's entry id from `inspect`; `None` is the last one.
pub fn user_message(transcript: &[TranscriptItem], before: Option<&str>) -> Result<UserMessage> {
    let said: Vec<UserMessage> = transcript
        .iter()
        .filter(|item| item.role == "user" && !item.entry_id.is_empty())
        .enumerate()
        .map(|(index, item)| UserMessage {
            number: index + 1,
            entry_id: item.entry_id.clone(),
            text: item.text.clone(),
        })
        .collect();
    if said.is_empty() {
        bail!("nothing has been said in this session yet: there is no message to branch before");
    }
    let Some(before) = before.map(str::trim).filter(|before| !before.is_empty()) else {
        return Ok(said.last().cloned().expect("not empty"));
    };
    if let Ok(number) = before.parse::<usize>() {
        return said
            .iter()
            .find(|message| message.number == number)
            .cloned()
            .ok_or_else(|| {
                anyhow!(
                    "there is no message {number}: this session has {} (1 to {}), or give a message's id",
                    said.len(),
                    said.len()
                )
            });
    }
    said.iter()
        .find(|message| message.entry_id == before)
        .cloned()
        .ok_or_else(|| anyhow!("no message {before:?} in this session's conversation (give its number, 1 to {}, or the entryId `inspect` shows)", said.len()))
}

/// `POST /sessions` on the bound graph.
#[derive(Debug, Clone, Default)]
pub struct CreateSession {
    pub request_id: String,
    pub title: Option<String>,
    pub model: Option<String>,
    /// `chat` (the host's default) or `agent`: an isolated body with a working folder and a shell, for the
    /// graph's owner only.
    pub profile: Option<String>,
    /// Take the driver lease for this client (the default).
    pub claim: bool,
}

// ─── The client ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct RideClient {
    endpoint: RideEndpoint,
    http: Client,
    streaming: Client,
}

impl RideClient {
    pub fn new(endpoint: RideEndpoint) -> Result<Self> {
        let http = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .context("build the HTTP client")?;
        // An event stream stays open for as long as the room does.
        let streaming = Client::builder()
            .timeout(None::<Duration>)
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .context("build the streaming HTTP client")?;
        Ok(Self {
            endpoint,
            http,
            streaming,
        })
    }

    pub fn endpoint(&self) -> &RideEndpoint {
        &self.endpoint
    }

    /// The client for a session on `graph_id`: bound to that graph. gardend hands a session's graph tools their
    /// token (the owner's delegation token) only with requests on the graph's path, so a client that knows the
    /// session's graph binds to it, even when it was started without `--graph`.
    pub fn for_session_graph(&self, graph_id: &str) -> Result<Self> {
        match &self.endpoint.graph_id {
            Some(_) => Ok(self.clone()),
            None => self.bound_to(Some(graph_id)),
        }
    }

    /// The same client bound to another graph (or to none).
    pub fn bound_to(&self, graph_id: Option<&str>) -> Result<Self> {
        let mut endpoint = self.endpoint.clone();
        endpoint.graph_id = graph_id.map(str::to_string);
        if let Some(graph) = &endpoint.graph_id {
            validate_graph_id(graph)?;
        }
        Ok(Self {
            endpoint,
            http: self.http.clone(),
            streaming: self.streaming.clone(),
        })
    }

    fn request(&self, client: &Client, method: Method, path: &str) -> RequestBuilder {
        let mut request = client
            .request(method, format!("{}{path}", self.endpoint.base_url()))
            .header(CLIENT_ID_HEADER, &self.endpoint.client_id);
        if let Some(credential) = &self.endpoint.credential {
            request = request.header(AUTHORIZATION, credential.bearer_header());
        }
        if let Some(visitor_id) = &self.endpoint.visitor_id {
            request = request.header(VISITOR_ID_HEADER, visitor_id);
        }
        if let Some(key) = &self.endpoint.model_key {
            request = request.header(MODEL_KEY_HEADER, key.header_value());
        }
        request
    }

    fn unreachable(&self, error: reqwest::Error) -> anyhow::Error {
        // reqwest's message names the URL, which carries no secret (the credential is a header).
        anyhow!(error).context(format!(
            "cannot reach gardend at {} (is `gardend serve` running?)",
            self.endpoint.gardend_url
        ))
    }

    /// One ride exchange: the frame on success, a [`RideError`] for a refusal.
    pub fn exchange(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Value> {
        let mut request = self
            .request(&self.http, method, path)
            .header(ACCEPT, "application/json");
        if let Some(body) = body {
            request = request
                .header(CONTENT_TYPE, "application/json")
                .body(serde_json::to_vec(body)?);
        }
        let response = request.send().map_err(|error| self.unreachable(error))?;
        let status = response.status();
        let text = response.text().context("read the ride's answer")?;
        let body = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
        if !status.is_success() || body["type"] == "error" {
            return Err(RideError::from_reply(status, &body, &text).into());
        }
        if body["protocol"] != RIDE_PROTOCOL {
            bail!(
                "{} answered {} without a ride frame: is `vehicle` a service of this gardend?",
                self.endpoint.base_url(),
                status.as_u16()
            );
        }
        Ok(body)
    }

    fn session_path(session_id: &str, action: Option<&str>) -> Result<String> {
        validate_session_id(session_id)?;
        Ok(match action {
            Some(action) => format!("/sessions/{session_id}/{action}"),
            None => format!("/sessions/{session_id}"),
        })
    }

    /// `GET /sessions`: the caller's sessions on the bound graph (every graph when unbound), newest first.
    pub fn list_sessions(&self) -> Result<Vec<SessionSummary>> {
        let frame = self.exchange(Method::GET, "/sessions", None)?;
        serde_json::from_value(frame["value"]["sessions"].clone()).context("read the session list")
    }

    /// `POST /sessions` on the bound graph (a session needs one).
    pub fn create_session(&self, request: &CreateSession) -> Result<SessionSummary> {
        if self.endpoint.graph_id.is_none() {
            bail!("a new session needs a graph: pass --graph <id>");
        }
        let mut body = json!({ "requestId": request.request_id, "claim": request.claim });
        if let Some(title) = request.title.as_deref().filter(|t| !t.trim().is_empty()) {
            body["title"] = json!(title);
        }
        if let Some(model) = request.model.as_deref().filter(|m| !m.trim().is_empty()) {
            body["model"] = json!(model);
        }
        if let Some(profile) = request.profile.as_deref().filter(|p| !p.trim().is_empty()) {
            body["profile"] = json!(profile);
        }
        let frame = self.exchange(Method::POST, "/sessions", Some(&body))?;
        serde_json::from_value(frame["value"]["session"].clone())
            .context("read the created session")
    }

    /// `inspect`.
    pub fn inspect(&self, session_id: &str) -> Result<Snapshot> {
        let frame = self.exchange(Method::GET, &Self::session_path(session_id, None)?, None)?;
        serde_json::from_value(frame["value"].clone()).context("read the session snapshot")
    }

    pub fn claim(&self, session_id: &str, request_id: &str) -> Result<Value> {
        self.exchange(
            Method::POST,
            &Self::session_path(session_id, Some("claim"))?,
            Some(&json!({ "requestId": request_id })),
        )
    }

    /// `claim` with `takeover`: the same person's other client loses the lease (`lease.revoked`) and this one
    /// drives. Another person's lease is never taken over (`lease_held`, `canTakeOver: false`).
    pub fn take_over(&self, session_id: &str, request_id: &str) -> Result<Value> {
        self.exchange(
            Method::POST,
            &Self::session_path(session_id, Some("claim"))?,
            Some(&json!({ "requestId": request_id, "takeover": true })),
        )
    }

    /// `rename`: a title, or `None` to clear it.
    pub fn rename(&self, session_id: &str, title: Option<&str>) -> Result<Value> {
        self.exchange(
            Method::PATCH,
            &Self::session_path(session_id, None)?,
            Some(&json!({ "requestId": mint_id("rename"), "title": title })),
        )
    }

    pub fn release(&self, session_id: &str, request_id: &str) -> Result<Value> {
        self.exchange(
            Method::POST,
            &Self::session_path(session_id, Some("release"))?,
            Some(&json!({ "requestId": request_id })),
        )
    }

    /// `POST /sessions/:id/commands` with `{op, requestId, ...}`: every mutation needs this client's lease.
    pub fn command(&self, session_id: &str, body: &Value) -> Result<Value> {
        self.exchange(
            Method::POST,
            &Self::session_path(session_id, Some("commands"))?,
            Some(body),
        )
    }

    /// A text command (`prompt`, `follow_up`, `steer`).
    pub fn say(&self, session_id: &str, delivery: Delivery, text: &str) -> Result<Value> {
        self.command(
            session_id,
            &json!({ "op": delivery.op(), "requestId": mint_id(delivery.op()), "text": text }),
        )
    }

    pub fn abort(&self, session_id: &str) -> Result<Value> {
        self.command(
            session_id,
            &json!({ "op": "abort", "requestId": mint_id("abort") }),
        )
    }

    pub fn set_room_policy(&self, session_id: &str, policy: &str) -> Result<Value> {
        self.command(
            session_id,
            &json!({ "op": "set_room_policy", "requestId": mint_id("policy"), "policy": policy }),
        )
    }

    /// `fork`: a new conversation with this one's history before the message `entry_id` (pi's `/fork`). It needs
    /// only ownership (not the lease); the new session's lease goes to this client.
    pub fn fork(&self, session_id: &str, entry_id: &str) -> Result<Branch> {
        let frame = self.command(
            session_id,
            &json!({ "op": "fork", "requestId": mint_id("fork"), "entryId": entry_id }),
        )?;
        Self::branch_of(&frame)
    }

    /// `clone`: a new conversation with this one's whole history (pi's `/clone`), named "Copy of" it.
    pub fn duplicate(&self, session_id: &str) -> Result<Branch> {
        let frame = self.command(
            session_id,
            &json!({ "op": "clone", "requestId": mint_id("clone") }),
        )?;
        Self::branch_of(&frame)
    }

    fn branch_of(frame: &Value) -> Result<Branch> {
        Ok(Branch {
            session: serde_json::from_value(frame["value"]["session"].clone())
                .context("read the new session")?,
            selected_text: frame["value"]["selectedText"].as_str().map(str::to_string),
        })
    }

    pub fn resolve_chime(&self, session_id: &str, chime_id: &str, accept: bool) -> Result<Value> {
        let op = if accept {
            "accept_chime"
        } else {
            "reject_chime"
        };
        self.command(
            session_id,
            &json!({ "op": op, "requestId": mint_id(op), "chimeId": chime_id }),
        )
    }

    /// `chime`: anyone authenticated on the session's graph may chime; the room's policy decides.
    pub fn chime(&self, session_id: &str, chime: &ChimeRequest) -> Result<ChimeOutcome> {
        chime.validate()?;
        let frame = self.exchange(
            Method::POST,
            &Self::session_path(session_id, Some("chimes"))?,
            Some(&chime.body()),
        )?;
        Ok(ChimeOutcome::from_frame(&frame))
    }

    pub fn capsule(&self, session_id: &str) -> Result<Value> {
        self.exchange(
            Method::GET,
            &Self::session_path(session_id, Some("capsule"))?,
            None,
        )
    }

    /// `watch` by long-poll: the events after `since`, waiting up to `wait_ms` (at most 30 s) for one.
    pub fn watch(&self, session_id: &str, since: u64, wait_ms: u64) -> Result<WatchBatch> {
        let path = format!(
            "{}?since={since}&waitMs={}",
            Self::session_path(session_id, Some("events"))?,
            wait_ms.min(MAX_WAIT_MS)
        );
        let frame = self.exchange(Method::GET, &path, None)?;
        serde_json::from_value(frame["value"].clone()).context("read the watch batch")
    }

    /// `watch` as a server-sent event stream from `since`, live from there on, with the ephemeral text
    /// deltas. `None` when the way in answers but does not stream (a proxy that refuses event streams).
    pub fn open_stream(&self, session_id: &str, since: u64) -> Result<Option<EventStream>> {
        let path = format!(
            "{}?since={since}",
            Self::session_path(session_id, Some("events"))?
        );
        let response = self
            .request(&self.streaming, Method::GET, &path)
            .header(ACCEPT, "text/event-stream")
            .send()
            .map_err(|error| self.unreachable(error))?;
        let status = response.status();
        let streams = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream"));
        if status.is_success() && streams {
            return Ok(Some(EventStream {
                reader: BufReader::new(response),
                parser: SseParser::default(),
            }));
        }
        if matches!(
            status,
            StatusCode::NOT_IMPLEMENTED | StatusCode::NOT_ACCEPTABLE
        ) || status.is_success()
        {
            return Ok(None);
        }
        let text = response.text().unwrap_or_default();
        let body = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
        Err(RideError::from_reply(status, &body, &text).into())
    }
}

// ─── Server-sent events ──────────────────────────────────────────────────────

/// What the stream carries: durable events (with a `seq`) and ephemeral text deltas (without).
#[derive(Debug, Clone, PartialEq)]
pub enum StreamItem {
    Event(RideEvent),
    Delta(String),
}

/// The parts of the SSE format the ride uses: `data:` lines up to a blank line make one message (`id:` and
/// `event:` repeat what the frame carries; `:` lines are keep-alives).
#[derive(Debug, Default)]
struct SseParser {
    data: Vec<String>,
}

impl SseParser {
    /// Feed one line (without its line ending); a blank line ends a message and yields its data.
    fn push(&mut self, line: &str) -> Option<String> {
        if line.is_empty() {
            if self.data.is_empty() {
                return None;
            }
            let data = self.data.join("\n");
            self.data.clear();
            return Some(data);
        }
        if let Some(value) = line.strip_prefix("data:") {
            self.data
                .push(value.strip_prefix(' ').unwrap_or(value).to_string());
        }
        None
    }
}

/// One stream message as an item; `None` for an ephemeral event that is not a text delta.
fn decode_stream_message(data: &str) -> Result<Option<StreamItem>> {
    let frame: Value = serde_json::from_str(data).context("an event stream frame is not JSON")?;
    let event = frame
        .get("event")
        .ok_or_else(|| anyhow!("an event stream frame has no event"))?;
    if frame["ephemeral"] == true {
        if event["type"] != "message.delta" {
            return Ok(None);
        }
        let delta = event
            .pointer("/payload/delta")
            .and_then(Value::as_str)
            .unwrap_or_default();
        return Ok(Some(StreamItem::Delta(delta.to_string())));
    }
    Ok(Some(StreamItem::Event(
        serde_json::from_value(event.clone()).context("read a streamed event")?,
    )))
}

/// A live event stream; iterate it until it ends (the proxy closed it) or errs (the connection dropped).
pub struct EventStream {
    reader: BufReader<Response>,
    parser: SseParser,
}

impl Iterator for EventStream {
    type Item = Result<StreamItem>;

    fn next(&mut self) -> Option<Self::Item> {
        let mut line = String::new();
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => return None,
                Ok(_) => {}
                Err(error) => return Some(Err(anyhow!(error).context("the event stream dropped"))),
            }
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if let Some(message) = self.parser.push(trimmed) {
                match decode_stream_message(&message) {
                    Ok(Some(item)) => return Some(Ok(item)),
                    Ok(None) => continue,
                    Err(error) => return Some(Err(error)),
                }
            }
        }
    }
}

// ─── The watcher a room runs ─────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchMode {
    /// Server-sent events (with live text), long-poll when the way in cannot stream.
    Stream,
    /// Long-poll only (no live text: a message appears when it is complete).
    Poll,
}

impl WatchMode {
    pub fn label(self) -> &'static str {
        match self {
            Self::Stream => "sse",
            Self::Poll => "long-poll",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum WatchMsg {
    Event(RideEvent),
    Delta(String),
    /// The way the watcher now reads the session.
    Mode(WatchMode),
    Problem(String),
}

/// A background reader of one session's events. Events arrive in order, each once, from `since` on; a
/// dropped stream resumes from the last `seq` with no gap.
pub struct Watcher {
    stop: Arc<AtomicBool>,
    pub messages: mpsc::Receiver<WatchMsg>,
}

impl Watcher {
    pub fn start(client: RideClient, session_id: String, since: u64, mode: WatchMode) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let (sender, messages) = mpsc::channel();
        let flag = Arc::clone(&stop);
        thread::spawn(move || watch_loop(client, session_id, since, mode, flag, sender));
        Self { stop, messages }
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.stop();
    }
}

fn watch_loop(
    client: RideClient,
    session_id: String,
    since: u64,
    mode: WatchMode,
    stop: Arc<AtomicBool>,
    sender: mpsc::Sender<WatchMsg>,
) {
    let mut cursor = since;
    let mut streaming = mode == WatchMode::Stream;
    let mut announced: Option<WatchMode> = None;
    let mut backoff = Duration::from_millis(250);
    let send = |message: WatchMsg| sender.send(message).is_ok();
    let announce = |mode: WatchMode, announced: &mut Option<WatchMode>| {
        if *announced != Some(mode) {
            *announced = Some(mode);
            return send(WatchMsg::Mode(mode));
        }
        true
    };

    while !stop.load(Ordering::SeqCst) {
        if streaming {
            match client.open_stream(&session_id, cursor) {
                Ok(Some(stream)) => {
                    if !announce(WatchMode::Stream, &mut announced) {
                        return;
                    }
                    backoff = Duration::from_millis(250);
                    for item in stream {
                        if stop.load(Ordering::SeqCst) {
                            return;
                        }
                        let message = match item {
                            Ok(StreamItem::Event(event)) => {
                                if event.seq <= cursor {
                                    continue;
                                }
                                cursor = event.seq;
                                WatchMsg::Event(event)
                            }
                            Ok(StreamItem::Delta(delta)) => WatchMsg::Delta(delta),
                            Err(_) => break,
                        };
                        if !send(message) {
                            return;
                        }
                    }
                    // The stream ended or dropped: catch up by long-poll once (nothing is lost; the cursor
                    // resumes), then stream again.
                }
                Ok(None) => {
                    streaming = false;
                }
                Err(error) => {
                    if !send(WatchMsg::Problem(format!("{error:#}"))) {
                        return;
                    }
                    thread::sleep(backoff);
                    backoff = (backoff * 2).min(Duration::from_secs(5));
                    continue;
                }
            }
        }
        if !streaming && !announce(WatchMode::Poll, &mut announced) {
            return;
        }
        let wait = if streaming { 0 } else { LONG_POLL_WAIT_MS };
        match client.watch(&session_id, cursor, wait) {
            Ok(batch) => {
                backoff = Duration::from_millis(250);
                for event in batch.events {
                    if event.seq <= cursor {
                        continue;
                    }
                    cursor = event.seq;
                    if !send(WatchMsg::Event(event)) {
                        return;
                    }
                }
            }
            Err(error) => {
                if !send(WatchMsg::Problem(format!("{error:#}"))) {
                    return;
                }
                thread::sleep(backoff);
                backoff = (backoff * 2).min(Duration::from_secs(5));
            }
        }
    }
}

// ─── The JSONL ride over stdio ───────────────────────────────────────────────

/// Which session a JSONL ride drives.
#[derive(Debug, Clone)]
pub enum RideTarget {
    Existing(String),
    New(CreateSession),
}

#[derive(Debug, Clone)]
pub struct RideStdioOptions {
    pub target: RideTarget,
    /// Claim the driver lease at the start (a held lease is reported in `ready`, not fatal).
    pub claim: bool,
}

const COMMAND_OPS: [&str; 11] = [
    "prompt",
    "follow_up",
    "steer",
    "abort",
    "cancel",
    "fork",
    "clone",
    "set_room_policy",
    "accept_chime",
    "reject_chime",
    "shutdown",
];

fn with_request_id(mut frame: Value, request_id: &str) -> Value {
    if let Some(object) = frame.as_object_mut() {
        object
            .entry("requestId")
            .or_insert_with(|| json!(request_id));
    }
    frame
}

fn error_frame(error: &anyhow::Error, request_id: Option<&str>) -> Value {
    match ride_error(error) {
        Some(refusal) => refusal.frame(request_id),
        None => {
            let mut frame = json!({
                "protocol": RIDE_PROTOCOL,
                "type": "error",
                "code": "transport",
                "message": format!("{error:#}"),
            });
            if let Some(request_id) = request_id {
                frame["requestId"] = json!(request_id);
            }
            frame
        }
    }
}

fn emit<W: Write>(output: &mut W, frame: &Value) -> Result<()> {
    serde_json::to_writer(&mut *output, frame).context("write a ride frame")?;
    output.write_all(b"\n").context("write a ride frame")?;
    output.flush().context("flush a ride frame")
}

/// The ride over stdio: `ready` first, then one frame per request line, `closed` last (on `shutdown` or at
/// the end of the input). Requests are `{"op": ..., "requestId": ..., ...}` with the HTTP bodies of
/// `protocol/ride-v2.md`; frames are the host's, with `requestId` added to the reads.
pub fn run_ride_stdio<R: BufRead, W: Write>(
    client: &RideClient,
    options: &RideStdioOptions,
    input: R,
    mut output: W,
) -> Result<()> {
    let session_id = match &options.target {
        RideTarget::Existing(session_id) => session_id.clone(),
        RideTarget::New(create) => match client.create_session(create) {
            Ok(summary) => summary.session_id,
            Err(error) => {
                emit(&mut output, &error_frame(&error, Some(&create.request_id)))?;
                return Err(error);
            }
        },
    };
    let snapshot = match client.inspect(&session_id) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            emit(&mut output, &error_frame(&error, None))?;
            return Err(error);
        }
    };
    let bound = client.for_session_graph(&snapshot.session.graph_id)?;
    let client = &bound;
    let me = client.endpoint().client_id.clone();
    let mut claimed = snapshot
        .session
        .lease
        .as_ref()
        .is_some_and(|lease| lease.client_id == me);
    let mut claim_error = None;
    if options.claim && !claimed {
        match client.claim(&session_id, &mint_id("ride-claim")) {
            Ok(_) => claimed = true,
            Err(error) => claim_error = Some(error_frame(&error, None)),
        }
    }
    let mut cursor = snapshot.cursor;
    let session = client
        .inspect(&session_id)
        .map(|fresh| fresh.session)
        .unwrap_or(snapshot.session);
    let mut ready = json!({
        "protocol": RIDE_PROTOCOL,
        "type": "ready",
        "clientId": me,
        "claimed": claimed,
        "cursor": cursor,
        "session": session,
    });
    if let Some(refusal) = claim_error {
        ready["claimError"] = refusal;
    }
    emit(&mut output, &ready)?;

    for line in input.lines() {
        let line = line.context("read a ride request")?;
        if line.trim().is_empty() {
            continue;
        }
        let request = match serde_json::from_str::<Map<String, Value>>(&line) {
            Ok(request) => request,
            Err(error) => {
                emit(
                    &mut output,
                    &json!({"protocol": RIDE_PROTOCOL, "type": "error", "code": "invalid_json", "message": error.to_string()}),
                )?;
                continue;
            }
        };
        let request_id = request
            .get("requestId")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .map(str::to_string);
        let op = request
            .get("op")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(request_id) = request_id else {
            emit(
                &mut output,
                &json!({"protocol": RIDE_PROTOCOL, "type": "error", "code": "invalid_request", "message": "every request needs a requestId"}),
            )?;
            continue;
        };
        let outcome = match op {
            "claim" | "release" => {
                let mut body = request.clone();
                body.remove("op");
                client
                    .exchange(
                        Method::POST,
                        &RideClient::session_path(&session_id, Some(op))?,
                        Some(&Value::Object(body)),
                    )
                    .inspect(|_| claimed = op == "claim")
            }
            "chime" | "rename" => {
                let mut body = request.clone();
                body.remove("op");
                let (method, path) = if op == "chime" {
                    (
                        Method::POST,
                        RideClient::session_path(&session_id, Some("chimes"))?,
                    )
                } else {
                    (Method::PATCH, RideClient::session_path(&session_id, None)?)
                };
                client.exchange(method, &path, Some(&Value::Object(body)))
            }
            "delete" => client
                .exchange(
                    Method::DELETE,
                    &RideClient::session_path(&session_id, None)?,
                    None,
                )
                .map(|frame| with_request_id(frame, &request_id)),
            "inspect" => client
                .exchange(
                    Method::GET,
                    &RideClient::session_path(&session_id, None)?,
                    None,
                )
                .map(|frame| with_request_id(frame, &request_id)),
            "capsule" => client
                .capsule(&session_id)
                .map(|frame| with_request_id(frame, &request_id)),
            "watch" => {
                let since = request
                    .get("since")
                    .and_then(Value::as_u64)
                    .unwrap_or(cursor);
                let wait_ms = request
                    .get("waitMs")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    .min(MAX_WAIT_MS);
                let path = format!(
                    "{}?since={since}&waitMs={wait_ms}",
                    RideClient::session_path(&session_id, Some("events"))?
                );
                client
                    .exchange(Method::GET, &path, None)
                    .map(|frame| with_request_id(frame, &request_id))
                    .inspect(|frame| {
                        if let Some(seen) = frame.pointer("/value/cursor").and_then(Value::as_u64) {
                            cursor = cursor.max(seen);
                        }
                    })
            }
            op if COMMAND_OPS.contains(&op) => {
                client.command(&session_id, &Value::Object(request.clone()))
            }
            _ => Err(anyhow::Error::new(RideError {
                status: 400,
                code: "invalid_request".to_string(),
                message: format!(
                    "op must be one of claim, release, {}, chime, inspect, capsule, watch, rename, delete",
                    COMMAND_OPS.join(", ")
                ),
                details: None,
            })),
        };
        match outcome {
            Ok(frame) => {
                emit(&mut output, &frame)?;
                if op == "shutdown" {
                    return Ok(());
                }
                if op == "delete" {
                    // The session is in the host's trash: nothing is left to ride.
                    return emit(
                        &mut output,
                        &json!({ "protocol": RIDE_PROTOCOL, "type": "closed", "reason": "deleted", "cursor": cursor }),
                    );
                }
            }
            Err(error) => emit(&mut output, &error_frame(&error, Some(&request_id)))?,
        }
    }

    if claimed {
        // The input ended: give the lease back so a person (or another agent) can drive.
        let _ = client.release(&session_id, &mint_id("ride-release"));
    }
    emit(
        &mut output,
        &json!({ "protocol": RIDE_PROTOCOL, "type": "closed", "reason": "stdin_closed", "cursor": cursor }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_never_show_and_key_files_are_read_without_echo() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("selfhost-key.json");
        fs::write(
            &path,
            r#"{"key":"sophia-key-test-secret","createdAt":"now","note":"x"}"#,
        )
        .unwrap();
        let credential = Credential::from_key_file(&path).unwrap();
        assert_eq!(format!("{credential:?}"), "Credential(<redacted>)");
        assert_eq!(credential.bearer_header(), "Bearer sophia-key-test-secret");

        fs::write(&path, "sophia-key-not-json").unwrap();
        let error = format!("{:#}", Credential::from_key_file(&path).unwrap_err());
        assert!(!error.contains("sophia-key-not-json"), "{error}");
        assert!(Credential::new("two words").is_err());
    }

    #[test]
    fn the_endpoint_binds_a_graph_by_path_and_refuses_what_is_not_an_id() {
        let credential = Credential::new("k").unwrap();
        let bound = RideEndpoint::new(
            "http://127.0.0.1:7674/",
            Some("led-badge"),
            credential.clone(),
            "c",
        )
        .unwrap();
        assert_eq!(
            bound.base_url(),
            "http://127.0.0.1:7674/services/vehicle/g/led-badge"
        );
        let unbound =
            RideEndpoint::new("http://127.0.0.1:7674", None, credential.clone(), "c").unwrap();
        assert_eq!(unbound.base_url(), "http://127.0.0.1:7674/services/vehicle");
        assert!(RideEndpoint::new("http://h", Some("../x"), credential.clone(), "c").is_err());
        assert!(RideEndpoint::new("h:7674", None, credential.clone(), "c").is_err());
        assert!(RideEndpoint::new("http://h", None, credential, "two words").is_err());
        assert!(validate_session_id("4dfec34f-7ba9-44b8-8010-f41887b1475f").is_ok());
        assert!(validate_session_id("../capsule").is_err());
    }

    #[test]
    fn sse_messages_decode_into_events_and_deltas() {
        let mut parser = SseParser::default();
        let mut messages = Vec::new();
        for line in [
            ": keep-alive 3",
            "id: 4",
            "event: run.started",
            r#"data: {"protocol":"sophia.vehicle-ride.v2","type":"event","cursor":4,"event":{"seq":4,"ts":"t","type":"run.started","payload":{"runId":"4"}}}"#,
            "",
            "event: message.delta",
            r#"data: {"protocol":"sophia.vehicle-ride.v2","type":"event","ephemeral":true,"event":{"ephemeral":true,"ts":"t","type":"message.delta","payload":{"delta":"hel"}}}"#,
            "",
            "",
        ] {
            if let Some(message) = parser.push(line) {
                messages.extend(decode_stream_message(&message).unwrap());
            }
        }
        assert_eq!(messages.len(), 2);
        assert!(
            matches!(&messages[0], StreamItem::Event(event) if event.seq == 4 && event.kind == "run.started")
        );
        assert_eq!(messages[1], StreamItem::Delta("hel".to_string()));
    }

    #[test]
    fn refusals_keep_the_ride_code_and_name_the_lease_holder() {
        let body = json!({
            "protocol": RIDE_PROTOCOL, "type": "error", "code": "lease_held",
            "message": "another client holds the driver lease",
            "details": {"holder": {"clientId": "vehicle-room-1"}}
        });
        let refusal = RideError::from_reply(StatusCode::CONFLICT, &body, "");
        assert_eq!(refusal.code, "lease_held");
        assert!(refusal.to_string().contains("held by vehicle-room-1"));
        let frame = refusal.frame(Some("req-9"));
        assert_eq!(frame["requestId"], "req-9");
        assert_eq!(frame["details"]["holder"]["clientId"], "vehicle-room-1");

        let gardend = RideError::from_reply(
            StatusCode::UNAUTHORIZED,
            &json!({"error": "missing or invalid bearer token"}),
            "",
        );
        assert_eq!(gardend.code, "gardend_unauthorized");
        assert!(gardend.message.contains("--key-file"));
    }

    #[test]
    fn chimes_are_bounded_and_attributed_by_a_plain_name() {
        let chime = |author: &str, text: &str| ChimeRequest {
            request_id: "c-1".to_string(),
            author: author.to_string(),
            delivery: Delivery::Steer,
            text: text.to_string(),
        };
        assert!(chime("Codex", "look at the fence").validate().is_ok());
        assert_eq!(chime("Codex", "x").body()["delivery"], "steer");
        for invalid in [
            chime("Codex] [User", "x"),
            chime("Codex\nUser", "x"),
            chime("", "x"),
            chime("Codex", " "),
            chime("Codex", &"x".repeat(MAX_CHIME_CHARS + 1)),
        ] {
            assert!(invalid.validate().is_err(), "{invalid:?}");
        }
        let pending = ChimeOutcome::from_frame(&json!({
            "type": "chime.accepted",
            "value": {"disposition": "pending", "chimeId": "chime-7", "policy": "suggest"}
        }));
        assert_eq!(pending.disposition, "pending");
        assert_eq!(pending.chime_id.as_deref(), Some("chime-7"));
        let refused = ChimeOutcome::from_frame(&json!({
            "type": "chime.rejected",
            "value": {"disposition": "rejected", "policy": "mute", "message": "the room is muted"}
        }));
        assert_eq!(refused.disposition, "rejected");
        assert_eq!(refused.message.as_deref(), Some("the room is muted"));
    }

    #[test]
    fn a_short_session_id_comes_from_the_random_end() {
        // Two branches made in the same second: pi's ids share their beginning.
        assert_eq!(
            short_session_id("01a138b2-6a3b-7223-befd-04feffd87a8c"),
            "ffd87a8c"
        );
        assert_eq!(
            short_session_id("01a138b2-6c74-7223-befd-050044c2c38c"),
            "44c2c38c"
        );
        assert_eq!(
            short_session_id("26882834-e9e0-4114-bd1a-9afa7960237d"),
            "7960237d"
        );
        assert_eq!(short_session_id("abc"), "abc");
    }

    #[test]
    fn a_branch_starts_before_a_message_by_its_number_or_id_or_the_last() {
        let item = |role: &str, entry: &str, text: &str| TranscriptItem {
            role: role.to_string(),
            entry_id: entry.to_string(),
            text: text.to_string(),
            ..TranscriptItem::default()
        };
        let transcript = [
            item("user", "u1", "first"),
            item("assistant", "a1", "one"),
            item("user", "u2", "[Codex collaborator]\nsecond"),
            item("assistant", "a2", "two"),
            item("user", "u3", "third"),
        ];
        let entry = |before: Option<&str>| {
            user_message(&transcript, before).map(|message| (message.number, message.entry_id))
        };
        assert_eq!(
            entry(None).unwrap(),
            (3, "u3".to_string()),
            "the last by default"
        );
        assert_eq!(entry(Some("  ")).unwrap(), (3, "u3".to_string()));
        assert_eq!(
            entry(Some("2")).unwrap(),
            (2, "u2".to_string()),
            "a chime is a message too"
        );
        assert_eq!(entry(Some("u1")).unwrap(), (1, "u1".to_string()));
        assert!(
            entry(Some("0"))
                .unwrap_err()
                .to_string()
                .contains("there is no message 0: this session has 3")
        );
        assert!(
            entry(Some("a1"))
                .unwrap_err()
                .to_string()
                .contains("no message \"a1\""),
            "an answer is not a message to branch before"
        );
        assert!(
            user_message(&[], None)
                .unwrap_err()
                .to_string()
                .contains("nothing has been said")
        );
    }
}
