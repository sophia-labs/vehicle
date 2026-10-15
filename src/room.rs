//! The Vehicle room: one ride v2 session in the terminal.
//!
//! The room reads the session (`inspect`) and follows its event log (SSE through gardend, long-poll when the
//! way in cannot stream), so the transcript streams as the model writes. Whoever holds the driver lease
//! drives: a plain line is a `prompt`, or a `steer` while a run is going; `/follow-up`, `/abort` (Esc) and
//! `/cancel` are the other verbs. Everyone else chimes (`vehicle chime`); the room's policy decides what a
//! chime becomes, and in `suggest` the driver accepts or rejects each one here.

use anyhow::{Result, anyhow};
use ratatui_core::{
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    terminal::Frame,
    text::{Line, Span, Text},
};
use ratatui_crossterm::crossterm::event::{self, Event, KeyEventKind};
use ratatui_textarea::{Input, Key, TextArea};
use ratatui_widgets::{
    block::Block,
    borders::Borders,
    paragraph::{Paragraph, Wrap},
};
use serde_json::Value;
use signal_hook::consts::{SIGHUP, SIGTERM};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::TryRecvError,
    },
    time::{Duration, Instant},
};
use vehicle::ride::{
    CreateSession, Delivery, RideClient, RideEvent, Snapshot, TranscriptItem, WatchMode, WatchMsg,
    Watcher, is_ride_error, mint_id, ride_error, user_message,
};

use crate::tui::{
    TerminalGuard, compact_json, json_value_lines, key_event_input, push_field, section_line,
    short_id, short_time, truncate, value_string, wrap_lines,
};

const MAX_MESSAGES_PER_PUMP: usize = 4_000;
const REFRESH_DEBOUNCE: Duration = Duration::from_millis(150);
const CHAT_ENTRIES_SHOWN: usize = 400;
const STREAMING_TEXT_KEPT: usize = 64 * 1024;

pub struct RoomOptions {
    pub client: RideClient,
    pub session_id: String,
    pub watch: WatchMode,
}

/// Run the room until the person leaves; the lease is released on the way out, also when the terminal
/// goes away (SIGHUP) or the room is told to stop (SIGTERM).
pub fn run(options: RoomOptions) -> Result<()> {
    let hung_up = Arc::new(AtomicBool::new(false));
    for signal in [SIGHUP, SIGTERM] {
        signal_hook::flag::register(signal, Arc::clone(&hung_up))?;
    }
    let mut app = RoomApp::open(options)?;
    let mut terminal = TerminalGuard::enter()?;
    while !app.should_quit && !hung_up.load(Ordering::SeqCst) {
        app.pump();
        terminal.terminal.draw(|frame| app.render(frame))?;
        if event::poll(Duration::from_millis(40))?
            && let Event::Key(key) = event::read()?
            && key.kind != KeyEventKind::Release
        {
            app.handle_input(key_event_input(key));
        }
    }
    drop(terminal);
    let released = app.leave();
    println!(
        "left room {}{}",
        app.session_id,
        if released { " (lease released)" } else { "" }
    );
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RoomTab {
    Activity,
    Chimes,
    Session,
    Commands,
    Debug,
}

impl RoomTab {
    const ALL: [RoomTab; 5] = [
        RoomTab::Activity,
        RoomTab::Chimes,
        RoomTab::Session,
        RoomTab::Commands,
        RoomTab::Debug,
    ];

    fn label(self) -> &'static str {
        match self {
            RoomTab::Activity => "activity",
            RoomTab::Chimes => "chimes",
            RoomTab::Session => "session",
            RoomTab::Commands => "commands",
            RoomTab::Debug => "debug",
        }
    }

    fn from_label(label: &str) -> Option<Self> {
        let label = label.trim().to_ascii_lowercase();
        Self::ALL.iter().copied().find(|tab| tab.label() == label)
    }

    fn cycle(self, delta: isize) -> Self {
        let current = Self::ALL.iter().position(|tab| *tab == self).unwrap_or(0) as isize;
        let len = Self::ALL.len() as isize;
        Self::ALL[(current + delta).rem_euclid(len) as usize]
    }
}

// ─── The chat: pi's transcript, then what the event log adds ─────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
enum Speaker {
    /// The session's owner (whoever drove it: this room, a chat tab, an agent's ride).
    Driver,
    /// A chime the room accepted: the model sees it as `[<author> collaborator]`.
    Collaborator(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tone {
    Info,
    Success,
    Warning,
    Error,
    Muted,
}

#[derive(Debug, Clone, PartialEq)]
enum ChatEntry {
    Said {
        speaker: Speaker,
        text: String,
        /// `steer` or `follow-up` when the turn was not a plain prompt (known for turns seen live).
        via: Option<String>,
    },
    Answer {
        text: String,
        tools: Vec<String>,
        /// Why the model call failed, when it did (pi may retry it).
        error: Option<String>,
    },
    ToolResult {
        name: String,
        is_error: bool,
        chars: usize,
    },
    Notice {
        text: String,
        tone: Tone,
    },
}

/// What a user turn says and who said it: `[<author> collaborator]\n<text>` is a chime, and the note
/// pi-sophia adds for the model about open documents is not shown.
fn user_turn(text: &str) -> (Speaker, String) {
    let text = text
        .split("\n\n(Open in the person's view, by id: ")
        .next()
        .unwrap_or(text);
    if let Some(rest) = text.strip_prefix('[')
        && let Some((head, body)) = rest.split_once('\n')
        && let Some(author) = head.strip_suffix(" collaborator]")
    {
        return (Speaker::Collaborator(author.to_string()), body.to_string());
    }
    (Speaker::Driver, text.to_string())
}

fn tool_call_label(name: &str, args: &Value) -> String {
    let name = name.strip_prefix("mcp__sophia__").unwrap_or(name);
    let detail = ["query", "documentId", "document_id", "id", "title", "text"]
        .iter()
        .find_map(|key| value_string(args, key).map(|value| format!("{key}={value:?}")))
        .unwrap_or_else(|| {
            if args.is_null() || args.as_object().is_some_and(|object| object.is_empty()) {
                String::new()
            } else {
                compact_json(args, 60)
            }
        });
    truncate(format!("{name} {detail}").trim(), 90)
}

fn transcript_entry(item: &TranscriptItem) -> ChatEntry {
    match item.role.as_str() {
        "user" => {
            let (speaker, text) = user_turn(&item.text);
            ChatEntry::Said {
                speaker,
                text,
                via: None,
            }
        }
        "assistant" => ChatEntry::Answer {
            text: item.text.clone(),
            tools: item
                .tool_calls
                .iter()
                .map(|call| tool_call_label(&call.name, &call.args))
                .collect(),
            error: (item.stop_reason.as_deref() == Some("error"))
                .then(|| "the model call failed".to_string()),
        },
        "toolResult" => ChatEntry::ToolResult {
            name: item.tool_name.clone().unwrap_or_else(|| "tool".to_string()),
            is_error: item.is_error,
            chars: item.text.chars().count(),
        },
        other => ChatEntry::Notice {
            text: format!("{other}: {}", truncate(&item.text, 120)),
            tone: Tone::Muted,
        },
    }
}

/// What an event adds to the chat (most events only show in the activity list).
fn event_entry(event: &RideEvent, me: &str, delivered_op: Option<&str>) -> Option<ChatEntry> {
    let payload = &event.payload;
    let text = |key: &str| value_string(payload, key).unwrap_or_default();
    let notice = |text: String, tone: Tone| Some(ChatEntry::Notice { text, tone });
    match event.kind.as_str() {
        "message.completed" if text("role") == "user" => {
            let (speaker, said) = user_turn(&text("text"));
            Some(ChatEntry::Said {
                speaker,
                text: said,
                via: delivered_op
                    .filter(|op| *op == "steer" || *op == "follow_up")
                    .map(|op| op.replace('_', "-")),
            })
        }
        // An aborted reply with nothing in it: the "run aborted" notice says it.
        "message.completed"
            if text("text").trim().is_empty()
                && text("stopReason") != "error"
                && payload
                    .get("toolCalls")
                    .and_then(Value::as_array)
                    .is_none_or(Vec::is_empty) =>
        {
            None
        }
        "message.completed" => Some(ChatEntry::Answer {
            text: text("text"),
            tools: payload
                .get("toolCalls")
                .and_then(Value::as_array)
                .map(|calls| {
                    calls
                        .iter()
                        .map(|call| {
                            tool_call_label(
                                call.get("name").and_then(Value::as_str).unwrap_or("tool"),
                                call.get("args").unwrap_or(&Value::Null),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default(),
            error: (text("stopReason") == "error").then(|| {
                value_string(payload, "errorMessage")
                    .unwrap_or_else(|| "the model call failed".to_string())
            }),
        }),
        "tool.result" => Some(ChatEntry::ToolResult {
            name: text("toolName"),
            is_error: payload.get("isError").and_then(Value::as_bool) == Some(true),
            chars: text("text").chars().count(),
        }),
        "chime.received" => {
            let chime = payload.get("chime").unwrap_or(&Value::Null);
            let field = |key: &str| value_string(chime, key).unwrap_or_default();
            notice(
                format!(
                    "{} chimes a {} ({}): {}",
                    field("author"),
                    field("delivery").replace('_', "-"),
                    field("chimeId"),
                    truncate(&field("text").replace('\n', " "), 160)
                ),
                Tone::Info,
            )
        }
        "chime.resolved" => notice(
            format!("{} {}", text("chimeId"), text("status")),
            if text("status") == "rejected" {
                Tone::Muted
            } else {
                Tone::Success
            },
        ),
        "lease.claimed" => notice(
            if text("clientId") == me {
                "you drive".to_string()
            } else {
                format!("{} drives", text("clientId"))
            },
            Tone::Muted,
        ),
        "lease.released" => notice(
            format!("{} let go of the wheel", text("clientId")),
            Tone::Muted,
        ),
        "lease.expired" => notice(
            format!("{}'s lease expired", text("clientId")),
            Tone::Warning,
        ),
        "lease.revoked" => notice(
            if text("clientId") == me {
                format!(
                    "{} took the wheel from you (/take to take it back)",
                    text("by")
                )
            } else {
                format!("{} took the wheel from {}", text("by"), text("clientId"))
            },
            Tone::Warning,
        ),
        "session.renamed" => notice(
            match value_string(payload, "title") {
                Some(title) => format!("renamed: {title}"),
                None => "the title was cleared".to_string(),
            },
            Tone::Muted,
        ),
        "session.deleted" => notice(
            "the session was deleted (moved to the host's trash)".to_string(),
            Tone::Error,
        ),
        "room.policy" => notice(format!("room policy: {}", text("policy")), Tone::Info),
        "run.settled" if payload.get("aborted").and_then(Value::as_bool) == Some(true) => notice(
            match payload.pointer("/budget/reason").and_then(Value::as_str) {
                Some(reason) => format!("run stopped by the budget ({reason})"),
                None => "run aborted".to_string(),
            },
            Tone::Warning,
        ),
        "run.error" => notice(format!("run error: {}", text("message")), Tone::Error),
        "retry.started" => notice(
            format!(
                "retrying the model call (attempt {} of {})",
                text("attempt"),
                text("maxAttempts")
            ),
            Tone::Warning,
        ),
        "command.failed" => notice(
            format!(
                "{} {} failed: {}",
                text("op"),
                text("commandId"),
                text("error")
            ),
            Tone::Error,
        ),
        "command.cancelled" => notice(
            format!("{} {} cancelled", text("op"), text("commandId")),
            Tone::Muted,
        ),
        "session.shutdown" => notice("the session shut down".to_string(), Tone::Warning),
        "session.forked" | "session.cloned" => notice(
            format!(
                "{} into {}",
                event.kind.replace("session.", ""),
                text("into")
            ),
            Tone::Info,
        ),
        _ => None,
    }
}

fn tone_color(tone: Tone) -> Color {
    match tone {
        Tone::Info => Color::Cyan,
        Tone::Success => Color::Green,
        Tone::Warning => Color::Yellow,
        Tone::Error => Color::Red,
        Tone::Muted => Color::DarkGray,
    }
}

fn body_lines(text: &str, style: Style) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = text
        .trim_end()
        .lines()
        .map(|line| Line::from(Span::styled(format!("  {line}"), style)))
        .collect();
    if lines.is_empty() {
        lines.push(Line::from(""));
    }
    lines
}

/// How an entry reads in the chat. `continuing`: the entry carries on the model's previous step (it follows
/// a tool result), so it does not repeat the "sophia" heading.
fn chat_lines(entry: &ChatEntry, continuing: bool, number: Option<usize>) -> Vec<Line<'static>> {
    let bold = |color: Color| Style::default().fg(color).add_modifier(Modifier::BOLD);
    match entry {
        ChatEntry::Said { speaker, text, via } => {
            let mut head = match speaker {
                Speaker::Driver => vec![Span::styled("you", bold(Color::Green))],
                Speaker::Collaborator(author) => vec![
                    Span::styled(author.clone(), bold(Color::Magenta)),
                    Span::styled(" · collaborator", Style::default().fg(Color::DarkGray)),
                ],
            };
            // The message's number: what `/branch N` takes.
            if let Some(number) = number {
                head.push(Span::styled(
                    format!(" · #{number}"),
                    Style::default().fg(Color::DarkGray),
                ));
            }
            if let Some(via) = via {
                head.push(Span::styled(
                    format!(" · {via}"),
                    Style::default().fg(Color::Yellow),
                ));
            }
            let mut lines = vec![Line::from(head)];
            lines.extend(body_lines(text, Style::default()));
            lines.push(Line::from(""));
            lines
        }
        ChatEntry::Answer { text, tools, error } => {
            let has_text = !text.trim().is_empty();
            let mut lines = Vec::new();
            if !continuing {
                lines.push(Line::from(Span::styled("sophia", bold(Color::Cyan))));
            } else if has_text {
                lines.push(Line::from(""));
            }
            if has_text {
                lines.extend(body_lines(text, Style::default()));
            }
            for tool in tools {
                lines.push(Line::from(Span::styled(
                    format!("  → {tool}"),
                    Style::default().fg(Color::Yellow),
                )));
            }
            if let Some(error) = error {
                lines.push(Line::from(Span::styled(
                    format!("  ✗ {}", truncate(error, 200)),
                    Style::default().fg(Color::Red),
                )));
            }
            if has_text || error.is_some() {
                lines.push(Line::from(""));
            }
            lines
        }
        ChatEntry::ToolResult {
            name,
            is_error,
            chars,
        } => vec![Line::from(Span::styled(
            format!(
                "  ← {} {} · {chars} chars",
                name.strip_prefix("mcp__sophia__").unwrap_or(name),
                if *is_error { "error" } else { "ok" }
            ),
            Style::default().fg(if *is_error {
                Color::Red
            } else {
                Color::DarkGray
            }),
        ))],
        ChatEntry::Notice { text, tone } => vec![Line::from(Span::styled(
            format!("· {text}"),
            Style::default().fg(tone_color(*tone)),
        ))],
    }
}

/// The chat's lines: entries in order, a model's tool steps under one heading, notices set apart. Each
/// message said is numbered from `first_number` (the number of the first one among `entries`).
fn chat_text(entries: &[ChatEntry], first_number: usize) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut previous: Option<&ChatEntry> = None;
    let mut number = first_number;
    for entry in entries {
        let said = matches!(entry, ChatEntry::Said { .. }).then(|| {
            number += 1;
            number - 1
        });
        let notice = matches!(entry, ChatEntry::Notice { .. });
        if matches!(previous, Some(ChatEntry::Notice { .. })) && !notice {
            lines.push(Line::from(""));
        }
        let continuing = matches!(entry, ChatEntry::Answer { .. })
            && matches!(previous, Some(ChatEntry::ToolResult { .. }));
        lines.extend(chat_lines(entry, continuing, said));
        previous = Some(entry);
    }
    if matches!(previous, Some(ChatEntry::Notice { .. })) {
        lines.push(Line::from(""));
    }
    lines
}

// ─── The activity list: every event ──────────────────────────────────────────

#[derive(Debug, Clone)]
struct ActivityItem {
    seq: u64,
    label: &'static str,
    title: String,
    detail: String,
    tone: Tone,
}

fn activity_item(event: &RideEvent) -> ActivityItem {
    let payload = &event.payload;
    let text = |key: &str| value_string(payload, key).unwrap_or_default();
    let (label, title, detail, tone): (&'static str, String, String, Tone) =
        match event.kind.as_str() {
            "session.created" => (
                "sess",
                "created".into(),
                format!("{} · {}", text("graphId"), text("model")),
                Tone::Info,
            ),
            "session.revived" => {
                let interrupted = payload
                    .get("interrupted")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                (
                    "sess",
                    "revived".into(),
                    format!("{interrupted} interrupted"),
                    if interrupted > 0 {
                        Tone::Warning
                    } else {
                        Tone::Muted
                    },
                )
            }
            "session.shutdown" => ("sess", "shutdown".into(), text("by"), Tone::Warning),
            "session.forked" | "session.cloned" => (
                "sess",
                event.kind.replace("session.", ""),
                text("into"),
                Tone::Info,
            ),
            "body.materialized" => (
                "body",
                "awake".into(),
                if payload.get("resumedFromFile").and_then(Value::as_bool) == Some(true) {
                    "revived from pi's file".into()
                } else {
                    "new".into()
                },
                Tone::Muted,
            ),
            "body.dormant" => ("body", "dormant".into(), text("reason"), Tone::Muted),
            "lease.claimed" | "lease.renewed" => (
                "lease",
                event.kind.replace("lease.", ""),
                text("clientId"),
                Tone::Info,
            ),
            "lease.released" => ("lease", "released".into(), text("clientId"), Tone::Muted),
            "lease.expired" => ("lease", "expired".into(), text("clientId"), Tone::Warning),
            "lease.revoked" => (
                "lease",
                "revoked".into(),
                format!("{} by {}", text("clientId"), text("by")),
                Tone::Warning,
            ),
            "session.renamed" => ("sess", "renamed".into(), text("title"), Tone::Muted),
            "session.deleted" => ("sess", "deleted".into(), text("trashedAs"), Tone::Error),
            kind if kind.starts_with("command.") => {
                let state = kind.trim_start_matches("command.");
                let via = payload
                    .pointer("/via/author")
                    .and_then(Value::as_str)
                    .map(|author| format!(" via {author}"))
                    .unwrap_or_default();
                let error = value_string(payload, "error")
                    .map(|error| format!(" {error}"))
                    .unwrap_or_default();
                (
                    "cmd",
                    format!("{} {state}", text("op")),
                    format!("{}{via}{error}", text("commandId")),
                    match state {
                        "completed" => Tone::Success,
                        "failed" => Tone::Error,
                        "aborted" | "cancelled" | "interrupted" => Tone::Warning,
                        _ => Tone::Info,
                    },
                )
            }
            "run.started" => (
                "run",
                "started".into(),
                format!(
                    "{} tools",
                    payload
                        .get("tools")
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len)
                ),
                Tone::Info,
            ),
            "run.ended" => ("run", "ended".into(), String::new(), Tone::Muted),
            "run.settled" => {
                let aborted = payload.get("aborted").and_then(Value::as_bool) == Some(true);
                (
                    "run",
                    if aborted { "aborted" } else { "settled" }.into(),
                    payload
                        .pointer("/budget/reason")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| text("stopReason")),
                    if aborted {
                        Tone::Warning
                    } else {
                        Tone::Success
                    },
                )
            }
            "run.error" => ("run", "error".into(), text("message"), Tone::Error),
            "message.completed" => {
                let role = text("role");
                let cost = payload
                    .pointer("/usage/costUsd")
                    .and_then(Value::as_f64)
                    .filter(|cost| *cost > 0.0)
                    .map(|cost| format!(" ${cost:.4}"))
                    .unwrap_or_default();
                (
                    "msg",
                    if role == "user" { "user" } else { "sophia" }.into(),
                    format!("{}{cost}", text("text").replace('\n', " ")),
                    Tone::Info,
                )
            }
            "tool.started" => (
                "tool",
                text("toolName")
                    .trim_start_matches("mcp__sophia__")
                    .to_string(),
                compact_json(payload.get("args").unwrap_or(&Value::Null), 60),
                Tone::Warning,
            ),
            "tool.result" => {
                let failed = payload.get("isError").and_then(Value::as_bool) == Some(true);
                (
                    "tool",
                    format!(
                        "{} {}",
                        text("toolName").trim_start_matches("mcp__sophia__"),
                        if failed { "error" } else { "ok" }
                    ),
                    text("text").replace('\n', " "),
                    if failed { Tone::Error } else { Tone::Success },
                )
            }
            "queue.updated" => (
                "queue",
                "updated".into(),
                format!(
                    "steer {} · follow-up {}",
                    text("steering"),
                    text("followUp")
                ),
                Tone::Muted,
            ),
            "queue.stranded" => ("queue", "stranded".into(), text("count"), Tone::Warning),
            "budget.exceeded" => ("budget", "exceeded".into(), text("reason"), Tone::Error),
            "room.policy" => ("room", "policy".into(), text("policy"), Tone::Info),
            "chime.received" => {
                let chime = payload.get("chime").unwrap_or(&Value::Null);
                let field = |key: &str| value_string(chime, key).unwrap_or_default();
                (
                    "chime",
                    field("author"),
                    format!(
                        "{} {}: {}",
                        field("chimeId"),
                        field("delivery"),
                        field("text").replace('\n', " ")
                    ),
                    Tone::Info,
                )
            }
            "chime.resolved" => (
                "chime",
                text("status"),
                text("chimeId"),
                if text("status") == "rejected" {
                    Tone::Muted
                } else {
                    Tone::Success
                },
            ),
            "extension.error" => ("ext", "error".into(), text("message"), Tone::Error),
            "abort.slow" => ("run", "abort slow".into(), text("waitedMs"), Tone::Warning),
            "retry.started" => ("run", "retry".into(), text("attempt"), Tone::Warning),
            kind => (
                "evt",
                kind.to_string(),
                compact_json(payload, 80),
                Tone::Muted,
            ),
        };
    ActivityItem {
        seq: event.seq,
        label,
        title,
        detail,
        tone,
    }
}

// ─── The room ────────────────────────────────────────────────────────────────

struct RoomApp {
    client: RideClient,
    session_id: String,
    watch_mode: WatchMode,
    watching: Option<WatchMode>,
    watcher: Watcher,
    snapshot: Snapshot,
    /// The event cursor the transcript read at open is current to: later events add to `tail`.
    history_cursor: u64,
    events: Vec<RideEvent>,
    tail: Vec<ChatEntry>,
    streaming: String,
    /// The op of the command pi took last (`command.delivered`): it names the user turn that follows.
    delivered_op: Option<String>,
    running: bool,
    driving: bool,
    tab: RoomTab,
    selected_activity: usize,
    activity_detail_open: bool,
    chat_scroll: usize,
    chat_height: usize,
    composer: TextArea<'static>,
    status: String,
    needs_refresh: bool,
    last_refresh: Instant,
    should_quit: bool,
}

impl RoomApp {
    fn open(options: RoomOptions) -> Result<Self> {
        let RoomOptions {
            client,
            session_id,
            watch,
        } = options;
        let snapshot = client.inspect(&session_id).map_err(|error| {
            if is_ride_error(&error, "not_found") {
                anyhow!(
                    "no session {session_id} for you here (wrong id, another graph than --graph, or not yours)"
                )
            } else {
                error
            }
        })?;
        // On the session's graph from here on: gardend hands the session's tools their token there only.
        let client = client.for_session_graph(&snapshot.session.graph_id)?;
        let watcher = Watcher::start(client.clone(), session_id.clone(), 0, watch);
        let mut app = Self {
            history_cursor: snapshot.cursor,
            running: snapshot.session.status == "running",
            driving: false,
            snapshot,
            client,
            session_id,
            watch_mode: watch,
            watching: None,
            watcher,
            events: Vec::new(),
            tail: Vec::new(),
            streaming: String::new(),
            delivered_op: None,
            tab: RoomTab::Activity,
            selected_activity: 0,
            activity_detail_open: false,
            chat_scroll: 0,
            chat_height: 20,
            composer: make_composer(),
            status: String::new(),
            needs_refresh: false,
            last_refresh: Instant::now(),
            should_quit: false,
        };
        app.driving = app.lease_holder().as_deref() == Some(app.me());
        if app.driving {
            app.status = "you drive; type to talk, /help for commands".to_string();
        } else if app.lease_holder().is_none() {
            app.claim();
        } else {
            // Ask (without taking over): the refusal says whether it is this person in another client.
            match app.client.claim(&app.session_id, &mint_id("room-claim")) {
                Ok(_) => {
                    app.driving = true;
                    app.status = "you drive; type to talk, /help for commands".to_string();
                }
                Err(error) => match ride_error(&error) {
                    Some(refusal) if can_take_over(refusal) => {
                        app.status = format!(
                            "read-only: you drive this from {}; /take to take the wheel here",
                            app.lease_holder().unwrap_or_default()
                        )
                    }
                    _ => {
                        app.status = format!(
                            "read-only: {} drives; you can watch, and /claim when it lets go",
                            app.lease_holder().unwrap_or_default()
                        )
                    }
                },
            }
        }
        app.restyle_composer();
        Ok(app)
    }

    fn me(&self) -> &str {
        &self.client.endpoint().client_id
    }

    fn lease_holder(&self) -> Option<String> {
        self.snapshot
            .session
            .lease
            .as_ref()
            .map(|lease| lease.client_id.clone())
    }

    /// Release the lease if this room holds it; true when it did.
    fn leave(&mut self) -> bool {
        self.watcher.stop();
        if self.driving {
            self.driving = false;
            return self
                .client
                .release(&self.session_id, &mint_id("room-release"))
                .is_ok();
        }
        false
    }

    // ─── Events in ──────────────────────────────────────────────────────────

    fn pump(&mut self) {
        for _ in 0..MAX_MESSAGES_PER_PUMP {
            match self.watcher.messages.try_recv() {
                Ok(message) => self.apply(message),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    self.status = "the watch stopped; /refresh to read the session".to_string();
                    break;
                }
            }
        }
        if self.needs_refresh && self.last_refresh.elapsed() >= REFRESH_DEBOUNCE {
            self.refresh();
        }
    }

    fn apply(&mut self, message: WatchMsg) {
        match message {
            WatchMsg::Event(event) => self.apply_event(event),
            WatchMsg::Delta(delta) => {
                self.streaming.push_str(&delta);
                if self.streaming.len() > STREAMING_TEXT_KEPT {
                    let cut = self.streaming.len() - STREAMING_TEXT_KEPT / 2;
                    let cut = (cut..self.streaming.len())
                        .find(|index| self.streaming.is_char_boundary(*index))
                        .unwrap_or(cut);
                    self.streaming.drain(..cut);
                }
            }
            WatchMsg::Mode(mode) => self.watching = Some(mode),
            WatchMsg::Problem(problem) => self.status = format!("watch: {problem}"),
        }
    }

    fn apply_event(&mut self, event: RideEvent) {
        match event.kind.as_str() {
            "run.started" => self.running = true,
            "run.settled" => {
                self.running = false;
                self.streaming.clear();
            }
            "message.completed" => self.streaming.clear(),
            "command.delivered" => self.delivered_op = value_string(&event.payload, "op"),
            _ => {}
        }
        if event.seq > self.history_cursor
            && let Some(entry) = event_entry(&event, self.me(), self.delivered_op.as_deref())
        {
            self.tail.push(entry);
        }
        if event.kind == "message.completed" && event.payload["role"] == "user" {
            self.delivered_op = None;
        }
        if event.kind == "lease.claimed" || event.kind == "lease.renewed" {
            self.driving = value_string(&event.payload, "clientId").as_deref() == Some(self.me());
        } else if matches!(
            event.kind.as_str(),
            "lease.released" | "lease.expired" | "lease.revoked" | "session.shutdown"
        ) && (event.kind == "session.shutdown"
            || value_string(&event.payload, "clientId").as_deref() == Some(self.me()))
        {
            self.driving = false;
        } else if event.kind == "session.deleted" {
            self.driving = false;
            self.status = "the session was deleted; Ctrl-C leaves the room".to_string();
        }
        if event.kind.starts_with("lease.")
            || event.kind.starts_with("chime.")
            || event.kind.starts_with("session.")
            || matches!(
                event.kind.as_str(),
                "run.settled" | "room.policy" | "command.accepted" | "command.cancelled"
            )
        {
            self.needs_refresh = true;
        }
        let following = self.selected_activity + 1 >= self.events.len();
        self.events.push(event);
        if following && !self.activity_detail_open {
            self.selected_activity = self.events.len() - 1;
        }
        self.restyle_composer();
    }

    /// Read the session again (the lease, the policy, the chimes, the commands, the stats). The transcript
    /// stays as it was read at open: everything said since came as events, in order, with the room's
    /// notices between them.
    fn refresh(&mut self) {
        self.needs_refresh = false;
        self.last_refresh = Instant::now();
        match self.client.inspect(&self.session_id) {
            Ok(snapshot) => {
                let transcript = std::mem::take(&mut self.snapshot.transcript);
                self.snapshot = snapshot;
                self.snapshot.transcript = transcript;
                self.driving = self.lease_holder().as_deref() == Some(self.me());
            }
            Err(error) => self.status = format!("refresh failed: {error:#}"),
        }
        self.restyle_composer();
    }

    // ─── Input ──────────────────────────────────────────────────────────────

    fn handle_input(&mut self, input: Input) {
        let composer_empty = self.composer_text().trim().is_empty();
        match input {
            Input {
                key: Key::Char('c' | 'q'),
                ctrl: true,
                ..
            } => self.should_quit = true,
            Input { key: Key::Esc, .. } => {
                if self.activity_detail_open {
                    self.activity_detail_open = false;
                } else if self.running && self.driving {
                    self.abort();
                } else {
                    self.status = "nothing to stop; Ctrl-C leaves the room".to_string();
                }
            }
            Input {
                key: Key::Tab,
                shift,
                ..
            } => {
                self.tab = self.tab.cycle(if shift { -1 } else { 1 });
                self.activity_detail_open = false;
            }
            Input {
                key: Key::PageUp, ..
            } => self.scroll_chat(true),
            Input {
                key: Key::PageDown, ..
            } => self.scroll_chat(false),
            Input { key: Key::End, .. } if composer_empty => self.chat_scroll = 0,
            Input {
                key: Key::Up,
                ctrl: false,
                alt: false,
                ..
            } if composer_empty && self.tab == RoomTab::Activity => self.move_activity(-1),
            Input {
                key: Key::Down,
                ctrl: false,
                alt: false,
                ..
            } if composer_empty && self.tab == RoomTab::Activity => self.move_activity(1),
            Input {
                key: Key::Enter,
                ctrl: false,
                alt: false,
                ..
            } if composer_empty && self.tab == RoomTab::Activity => {
                self.activity_detail_open = !self.activity_detail_open;
            }
            Input {
                key: Key::Char('j'),
                ctrl: true,
                ..
            }
            | Input {
                key: Key::Enter,
                alt: true,
                ..
            } => {
                self.composer.input(Input {
                    key: Key::Enter,
                    ctrl: false,
                    alt: false,
                    shift: false,
                });
            }
            Input {
                key: Key::Enter, ..
            } => self.submit(),
            input => {
                self.composer.input(input);
            }
        }
    }

    fn composer_text(&self) -> String {
        self.composer.lines().join("\n")
    }

    fn submit(&mut self) {
        let text = self.composer_text().trim().to_string();
        if text.is_empty() {
            return;
        }
        self.composer = make_composer();
        self.restyle_composer();
        self.chat_scroll = 0;
        if let Some(command) = text.strip_prefix('/') {
            self.command(command.trim());
        } else if self.running {
            self.say(Delivery::Steer, &text);
        } else {
            self.say(Delivery::Prompt, &text);
        }
    }

    fn report(&mut self, what: &str, error: anyhow::Error) {
        self.status = match ride_error(&error) {
            Some(refusal) if refusal.code == "lease_held" && can_take_over(refusal) => format!(
                "{what}: you drive this from another client ({refusal}); /take to take the wheel here"
            ),
            Some(refusal) if refusal.code == "lease_held" || refusal.code == "lease_required" => {
                format!("{what}: you do not drive ({refusal}); /claim when the wheel is free")
            }
            _ => format!("{what}: {error:#}"),
        };
    }

    fn say(&mut self, delivery: Delivery, text: &str) {
        match self.client.say(&self.session_id, delivery, text) {
            Ok(frame) => {
                let command = &frame["value"]["command"];
                let disposition = value_string(command, "disposition")
                    .or_else(|| value_string(command, "status"))
                    .unwrap_or_default();
                self.status = match (delivery, disposition.as_str()) {
                    (_, "started") => format!("{} started a run", delivery.op().replace('_', "-")),
                    (Delivery::Steer, "queued") => {
                        "steer queued: pi takes it before its next model call".to_string()
                    }
                    (_, "queued") => format!(
                        "{} queued: it runs when the current work is done",
                        delivery.op().replace('_', "-")
                    ),
                    (_, other) => format!("{} {other}", delivery.op().replace('_', "-")),
                };
            }
            Err(error) => self.report(delivery.op(), error),
        }
    }

    fn abort(&mut self) {
        match self.client.abort(&self.session_id) {
            Ok(_) => self.status = "abort sent".to_string(),
            Err(error) => self.report("abort", error),
        }
    }

    fn claim(&mut self) {
        match self.client.claim(&self.session_id, &mint_id("room-claim")) {
            Ok(_) => {
                self.driving = true;
                self.status = "you drive; type to talk, /help for commands".to_string();
                self.needs_refresh = true;
            }
            Err(error) => self.report("claim", error),
        }
    }

    fn command(&mut self, command: &str) {
        let (verb, rest) = command
            .split_once(char::is_whitespace)
            .map(|(verb, rest)| (verb, rest.trim()))
            .unwrap_or((command, ""));
        match verb.to_ascii_lowercase().as_str() {
            "quit" | "q" | "exit" => self.should_quit = true,
            "help" | "h" | "?" => {
                self.status = "Enter: prompt (steer while running) · /follow-up T · /steer T · /prompt T · /abort (Esc) · /cancel ID · /claim · /take · /release · /policy observe|suggest|co-drive|mute · /accept [ID] · /reject [ID] · /rename [T] · /new [T] · /branch [N] · /duplicate · /refresh · /activity /chimes /session /commands /debug · /quit".to_string();
            }
            "prompt" | "p" if !rest.is_empty() => self.say(Delivery::Prompt, rest),
            "steer" | "s" if !rest.is_empty() => self.say(Delivery::Steer, rest),
            "follow-up" | "followup" | "fu" | "f" if !rest.is_empty() => {
                self.say(Delivery::FollowUp, rest)
            }
            "abort" | "stop" => self.abort(),
            "cancel" if !rest.is_empty() => {
                let body = serde_json::json!({ "op": "cancel", "requestId": mint_id("cancel"), "commandId": rest });
                match self.client.command(&self.session_id, &body) {
                    Ok(_) => self.status = format!("cancelled {rest}"),
                    Err(error) => self.report("cancel", error),
                }
            }
            "claim" | "drive" => self.claim(),
            "take" | "takeover" => match self
                .client
                .take_over(&self.session_id, &mint_id("room-take"))
            {
                Ok(frame) => {
                    self.driving = true;
                    self.status = match frame["value"]["tookOverFrom"]["clientId"].as_str() {
                        Some(from) => format!("you took the wheel from {from}"),
                        None => "you drive".to_string(),
                    };
                    self.needs_refresh = true;
                }
                Err(error) => self.report("take", error),
            },
            "rename" => {
                let title = (!rest.is_empty()).then_some(rest);
                match self.client.rename(&self.session_id, title) {
                    Ok(_) => {
                        self.status = match title {
                            Some(title) => format!("renamed: {title}"),
                            None => "title cleared".to_string(),
                        };
                        self.needs_refresh = true;
                    }
                    Err(error) => self.report("rename", error),
                }
            }
            "release" => match self
                .client
                .release(&self.session_id, &mint_id("room-release"))
            {
                Ok(_) => {
                    self.driving = false;
                    self.status = "you let go of the wheel; /claim to drive again".to_string();
                    self.needs_refresh = true;
                }
                Err(error) => self.report("release", error),
            },
            "policy" if rest.is_empty() => {
                self.status = format!(
                    "room policy: {} (observe|suggest|co-drive|mute)",
                    self.snapshot.session.room_policy
                );
            }
            "policy" => {
                let policy = match rest.to_ascii_lowercase().as_str() {
                    "codrive" | "co-drive" | "co_drive" => "co-drive".to_string(),
                    other => other.to_string(),
                };
                match self.client.set_room_policy(&self.session_id, &policy) {
                    Ok(_) => {
                        self.status = format!("room policy: {policy}");
                        self.needs_refresh = true;
                    }
                    Err(error) => self.report("policy", error),
                }
            }
            "accept" | "reject" => {
                let accept = verb.eq_ignore_ascii_case("accept");
                let chime_id = if rest.is_empty() {
                    self.snapshot
                        .chimes
                        .first()
                        .map(|chime| chime.chime_id.clone())
                } else {
                    Some(rest.to_string())
                };
                let Some(chime_id) = chime_id else {
                    self.status = "no chime is waiting".to_string();
                    return;
                };
                match self
                    .client
                    .resolve_chime(&self.session_id, &chime_id, accept)
                {
                    Ok(_) => {
                        self.status = format!(
                            "{} {chime_id}",
                            if accept { "accepted" } else { "rejected" }
                        );
                        self.needs_refresh = true;
                    }
                    Err(error) => self.report(verb, error),
                }
            }
            "new" => self.start_new(rest),
            "branch" | "fork" => self.branch(rest),
            "duplicate" | "dup" | "clone" => self.duplicate(),
            "refresh" | "r" => self.refresh(),
            other => match RoomTab::from_label(other) {
                Some(tab) => {
                    self.tab = tab;
                    self.activity_detail_open = false;
                }
                None => self.status = format!("unknown command /{command}; /help lists them"),
            },
        }
    }

    /// `/new`: a new session on this session's graph, of the same profile; the room moves there (and lets go
    /// of this one).
    fn start_new(&mut self, title: &str) {
        let graph = self.snapshot.session.graph_id.clone();
        let profile = self.snapshot.session.profile.clone();
        let client = match self.client.bound_to(Some(&graph)) {
            Ok(client) => client,
            Err(error) => return self.report("new", error),
        };
        let created = client.create_session(&CreateSession {
            request_id: mint_id("room-new"),
            title: (!title.is_empty()).then(|| title.to_string()),
            model: None,
            profile: Some(profile),
            claim: true,
        });
        match created {
            Ok(summary) => {
                let status = format!(
                    "new session {} (left {})",
                    short_id(&summary.session_id),
                    self.session_id
                );
                self.move_to(&summary.session_id, "new", status);
            }
            Err(error) => self.report("new", error),
        }
    }

    /// `/branch [N]`: a new conversation with this one's history before message N (the numbers the chat
    /// shows; default the last), as the chat's "Branch from here". The room moves to it with N's words in the
    /// composer, to edit and send; this conversation stays as it was.
    fn branch(&mut self, before: &str) {
        let snapshot = match self.client.inspect(&self.session_id) {
            Ok(snapshot) => snapshot,
            Err(error) => return self.report("branch", error),
        };
        let message = match user_message(&snapshot.transcript, Some(before)) {
            Ok(message) => message,
            Err(error) => return self.report("branch", error),
        };
        match self.client.fork(&self.session_id, &message.entry_id) {
            Ok(branch) => {
                let words = branch
                    .selected_text
                    .clone()
                    .unwrap_or_else(|| user_turn(&message.text).1);
                let status = format!(
                    "branched from {} before #{}: its words are below; edit them and Enter to send",
                    short_id(&self.session_id),
                    message.number
                );
                if self.move_to(&branch.session.session_id, "branch", status) {
                    self.composer = make_composer();
                    self.composer.insert_str(words);
                    self.restyle_composer();
                }
            }
            Err(error) => self.report("branch", error),
        }
    }

    /// `/duplicate`: a new conversation with this one's whole history ("Copy of" it); the room moves to it.
    fn duplicate(&mut self) {
        match self.client.duplicate(&self.session_id) {
            Ok(branch) => {
                let status = format!(
                    "duplicated {} as {}: {}",
                    short_id(&self.session_id),
                    short_id(&branch.session.session_id),
                    branch.session.label()
                );
                self.move_to(&branch.session.session_id, "duplicate", status);
            }
            Err(error) => self.report("duplicate", error),
        }
    }

    /// Leave this session (letting go of its lease) and open `session_id` here; false when it could not open.
    fn move_to(&mut self, session_id: &str, what: &str, status: String) -> bool {
        self.leave();
        let next = RoomOptions {
            client: self.client.clone(),
            session_id: session_id.to_string(),
            watch: self.watch_mode,
        };
        match RoomApp::open(next) {
            Ok(app) => {
                *self = app;
                self.status = status;
                true
            }
            Err(error) => {
                self.report(what, error);
                false
            }
        }
    }

    fn move_activity(&mut self, delta: isize) {
        if self.events.is_empty() {
            return;
        }
        let last = self.events.len() as isize - 1;
        self.selected_activity = (self.selected_activity as isize + delta).clamp(0, last) as usize;
    }

    fn scroll_chat(&mut self, up: bool) {
        let step = (self.chat_height / 2).max(1);
        self.chat_scroll = if up {
            self.chat_scroll.saturating_add(step)
        } else {
            self.chat_scroll.saturating_sub(step)
        };
    }

    // ─── Drawing ────────────────────────────────────────────────────────────

    fn restyle_composer(&mut self) {
        let title = if !self.driving {
            match self.lease_holder() {
                Some(holder) => {
                    format!("read-only: {holder} drives (/claim when free, /take if it is you)")
                }
                None => "nobody drives: /claim".to_string(),
            }
        } else if self.running {
            "steer: running (Enter steers, Esc stops)".to_string()
        } else {
            "prompt".to_string()
        };
        let color = if !self.driving {
            Color::DarkGray
        } else if self.running {
            Color::Yellow
        } else {
            Color::Cyan
        };
        self.composer.set_block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(color))
                .title(title),
        );
    }

    fn render(&mut self, frame: &mut Frame<'_>) {
        let composer_height = (self.composer.lines().len() as u16 + 2).clamp(3, 8);
        let root = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(1),
                Constraint::Length(1),
                Constraint::Min(6),
                Constraint::Length(composer_height),
                Constraint::Length(1),
            ])
            .split(frame.area());
        frame.render_widget(self.header(), root[0]);
        frame.render_widget(self.tabs(), root[1]);
        let main = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(62), Constraint::Percentage(38)])
            .split(root[2]);
        let chat = self.chat_panel(main[0].width, main[0].height);
        frame.render_widget(chat, main[0]);
        frame.render_widget(self.detail_panel(main[1].height), main[1]);
        frame.render_widget(&self.composer, root[3]);
        frame.render_widget(self.footer(), root[4]);
    }

    fn header(&self) -> Paragraph<'static> {
        let session = &self.snapshot.session;
        let driver = match self.lease_holder() {
            Some(_) if self.driving => "you".to_string(),
            Some(holder) => holder,
            None => "nobody".to_string(),
        };
        let status = if self.running {
            "running"
        } else {
            session.status.as_str()
        };
        let line = format!(
            " vehicle room  {}  graph={}  {}  driver={}  policy={}  chimes={}  {} ",
            truncate(&session.label().replace('\n', " "), 32),
            session.graph_id,
            status,
            driver,
            session.room_policy,
            self.snapshot.chimes.len(),
            self.watching.map_or("connecting", WatchMode::label),
        );
        Paragraph::new(line).style(
            Style::default()
                .fg(Color::Black)
                .bg(Color::White)
                .add_modifier(Modifier::BOLD),
        )
    }

    fn tabs(&self) -> Paragraph<'static> {
        let spans = RoomTab::ALL
            .iter()
            .flat_map(|tab| {
                let style = if *tab == self.tab {
                    Style::default()
                        .fg(Color::Black)
                        .bg(Color::Cyan)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(Color::DarkGray)
                };
                let label = if *tab == RoomTab::Chimes && !self.snapshot.chimes.is_empty() {
                    format!(" chimes ({}) ", self.snapshot.chimes.len())
                } else {
                    format!(" {} ", tab.label())
                };
                [Span::raw(" "), Span::styled(label, style)]
            })
            .collect::<Vec<_>>();
        Paragraph::new(Line::from(spans))
    }

    fn chat_entries(&self) -> Vec<ChatEntry> {
        self.snapshot
            .transcript
            .iter()
            .map(transcript_entry)
            .filter(|entry| {
                !matches!(entry, ChatEntry::Answer { text, tools, .. } if text.trim().is_empty() && tools.is_empty())
            })
            .chain(self.tail.iter().cloned())
            .collect()
    }

    fn chat_panel(&mut self, width: u16, height: u16) -> Paragraph<'static> {
        let entries = self.chat_entries();
        let start = entries.len().saturating_sub(CHAT_ENTRIES_SHOWN);
        let first_number = 1 + entries[..start]
            .iter()
            .filter(|entry| matches!(entry, ChatEntry::Said { .. }))
            .count();
        let mut lines = chat_text(&entries[start..], first_number);
        if !self.streaming.is_empty() {
            lines.push(Line::from(Span::styled(
                "sophia ▍",
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            )));
            lines.extend(body_lines(&self.streaming, Style::default()));
        } else if self.running {
            lines.push(Line::from(Span::styled(
                "sophia is working…",
                Style::default().fg(Color::DarkGray),
            )));
        }
        if lines.is_empty() {
            lines.push(Line::from(Span::styled(
                "nothing said yet",
                Style::default().fg(Color::DarkGray),
            )));
        }
        let inner_width = width.saturating_sub(2) as usize;
        let inner_height = height.saturating_sub(2) as usize;
        self.chat_height = inner_height;
        let wrapped = wrap_lines(lines, inner_width);
        let max_scroll = wrapped.len().saturating_sub(inner_height);
        self.chat_scroll = self.chat_scroll.min(max_scroll);
        let end = wrapped.len() - self.chat_scroll;
        let begin = end.saturating_sub(inner_height);
        let title = if self.chat_scroll > 0 {
            format!("chat (scrolled {} up; End follows)", self.chat_scroll)
        } else {
            "chat".to_string()
        };
        Paragraph::new(Text::from(wrapped[begin..end].to_vec()))
            .block(Block::default().borders(Borders::ALL).title(title))
    }

    fn detail_panel(&self, height: u16) -> Paragraph<'static> {
        let (title, lines, wrap) = match self.tab {
            RoomTab::Activity if self.activity_detail_open => {
                ("activity detail".to_string(), self.activity_detail(), true)
            }
            RoomTab::Activity => (
                "activity".to_string(),
                self.activity_lines(height.saturating_sub(2) as usize),
                false,
            ),
            RoomTab::Chimes => ("chimes".to_string(), self.chime_lines(), true),
            RoomTab::Session => ("session".to_string(), self.session_lines(), true),
            RoomTab::Commands => ("commands".to_string(), self.command_lines(), false),
            RoomTab::Debug => ("debug".to_string(), self.debug_lines(), true),
        };
        let panel = Paragraph::new(Text::from(lines))
            .block(Block::default().borders(Borders::ALL).title(title));
        if wrap {
            panel.wrap(Wrap { trim: false })
        } else {
            panel
        }
    }

    fn activity_lines(&self, rows: usize) -> Vec<Line<'static>> {
        if self.events.is_empty() {
            return vec![Line::from("no events yet")];
        }
        let rows = rows.max(1);
        let selected = self.selected_activity.min(self.events.len() - 1);
        let start = (selected + 1).saturating_sub(rows);
        self.events[start..]
            .iter()
            .take(rows)
            .enumerate()
            .map(|(offset, event)| {
                let item = activity_item(event);
                let chosen = start + offset == selected;
                let style = if chosen {
                    Style::default()
                        .fg(Color::Black)
                        .bg(Color::Cyan)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(tone_color(item.tone))
                };
                Line::from(Span::styled(
                    format!(
                        "{} {:>4} {:<5} {:<19} {}",
                        if chosen { ">" } else { " " },
                        item.seq,
                        item.label,
                        truncate(&item.title, 19),
                        truncate(&item.detail, 60)
                    ),
                    style,
                ))
            })
            .collect()
    }

    fn activity_detail(&self) -> Vec<Line<'static>> {
        let Some(event) = self.events.get(self.selected_activity) else {
            return vec![Line::from("no event selected")];
        };
        let item = activity_item(event);
        let mut lines = vec![Line::from(vec![
            Span::styled(
                format!("#{} ", event.seq),
                Style::default()
                    .fg(tone_color(item.tone))
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                event.kind.clone(),
                Style::default().add_modifier(Modifier::BOLD),
            ),
        ])];
        push_field(&mut lines, "at", &event.ts);
        push_field(&mut lines, "summary", &item.detail);
        lines.push(section_line("payload"));
        lines.extend(json_value_lines(&event.payload, 120));
        lines
    }

    fn chime_lines(&self) -> Vec<Line<'static>> {
        let mut lines = vec![section_line("room policy")];
        push_field(&mut lines, "policy", &self.snapshot.session.room_policy);
        lines.push(Line::from(Span::styled(
            "observe, mute: chimes refused · suggest: you accept or reject · co-drive: delivered at once",
            Style::default().fg(Color::DarkGray),
        )));
        lines.push(Line::from(""));
        lines.push(section_line("waiting on the driver"));
        if self.snapshot.chimes.is_empty() {
            lines.push(Line::from("none"));
        }
        for chime in &self.snapshot.chimes {
            lines.push(Line::from(vec![
                Span::styled(
                    format!("{} ", chime.chime_id),
                    Style::default().fg(Color::Cyan),
                ),
                Span::styled(
                    chime.author.clone(),
                    Style::default()
                        .fg(Color::Magenta)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!(
                        "  {} · {}",
                        chime.delivery.replace('_', "-"),
                        chime.principal
                    ),
                    Style::default().fg(Color::DarkGray),
                ),
            ]));
            for line in chime.text.lines().take(12) {
                lines.push(Line::from(format!("  {line}")));
            }
        }
        if !self.snapshot.chimes.is_empty() {
            lines.push(Line::from(Span::styled(
                "/accept [ID] · /reject [ID] (oldest first)",
                Style::default().fg(Color::DarkGray),
            )));
        }
        lines
    }

    fn session_lines(&self) -> Vec<Line<'static>> {
        let session = &self.snapshot.session;
        let mut lines = Vec::new();
        push_field(&mut lines, "session", &session.session_id);
        push_field(&mut lines, "title", session.title.as_deref().unwrap_or(""));
        push_field(&mut lines, "graph", &session.graph_id);
        push_field(&mut lines, "model", &session.model);
        push_field(
            &mut lines,
            "profile",
            &match &session.isolation {
                Some(isolation) => format!("{} ({isolation})", session.profile),
                None => session.profile.clone(),
            },
        );
        push_field(&mut lines, "access", &session.access);
        push_field(&mut lines, "status", &session.status);
        push_field(&mut lines, "created", &short_time(&session.created_at));
        push_field(&mut lines, "updated", &short_time(&session.updated_at));
        if let Some(lease) = &session.lease {
            push_field(&mut lines, "driver", &lease.client_id);
            push_field(&mut lines, "lease until", &short_time(&lease.expires_at));
        }
        push_field(&mut lines, "policy", &session.room_policy);
        if let Some(parent) = &session.parent {
            push_field(&mut lines, "parent", &compact_json(parent, 80));
        }
        push_field(&mut lines, "budget", &compact_json(&session.budget, 80));
        if let Some(stats) = &self.snapshot.stats {
            push_field(
                &mut lines,
                "cost",
                &stats
                    .get("costUsd")
                    .and_then(Value::as_f64)
                    .map(|cost| format!("${cost:.4}"))
                    .unwrap_or_default(),
            );
            push_field(
                &mut lines,
                "tokens",
                &compact_json(stats.get("tokens").unwrap_or(&Value::Null), 80),
            );
        }
        if let Some(tools) = &self.snapshot.tools {
            push_field(&mut lines, "tools", &tools.len().to_string());
            for tool in tools.iter().take(40) {
                lines.push(Line::from(Span::styled(
                    format!("  {}", tool.trim_start_matches("mcp__sophia__")),
                    Style::default().fg(Color::DarkGray),
                )));
            }
        }
        lines
    }

    fn command_lines(&self) -> Vec<Line<'static>> {
        if self.snapshot.commands.is_empty() {
            return vec![Line::from("no commands yet")];
        }
        self.snapshot
            .commands
            .iter()
            .rev()
            .take(60)
            .map(|command| {
                let via = command
                    .via
                    .as_ref()
                    .and_then(|via| value_string(via, "author"))
                    .map(|author| format!(" via {author}"))
                    .unwrap_or_default();
                let tone = match command.status.as_str() {
                    "completed" => Tone::Success,
                    "failed" => Tone::Error,
                    "aborted" | "cancelled" | "interrupted" => Tone::Warning,
                    _ => Tone::Info,
                };
                Line::from(Span::styled(
                    format!(
                        "{:<11} {:<10} {}{via}",
                        command.status,
                        command.op,
                        truncate(&command.command_id, 40)
                    ),
                    Style::default().fg(tone_color(tone)),
                ))
            })
            .collect()
    }

    fn debug_lines(&self) -> Vec<Line<'static>> {
        let endpoint = self.client.endpoint();
        let mut lines = Vec::new();
        push_field(&mut lines, "gardend", &endpoint.gardend_url);
        push_field(&mut lines, "ride", &endpoint.base_url());
        push_field(&mut lines, "client id", &endpoint.client_id);
        push_field(&mut lines, "session", &self.session_id);
        push_field(&mut lines, "watch asked", self.watch_mode.label());
        push_field(
            &mut lines,
            "watch now",
            self.watching.map_or("connecting", WatchMode::label),
        );
        push_field(
            &mut lines,
            "cursor",
            &self.events.last().map_or(0, |event| event.seq).to_string(),
        );
        push_field(
            &mut lines,
            "transcript at",
            &self.history_cursor.to_string(),
        );
        push_field(&mut lines, "events", &self.events.len().to_string());
        push_field(&mut lines, "chat tail", &self.tail.len().to_string());
        lines
    }

    fn footer(&self) -> Paragraph<'static> {
        let keys = if self.driving {
            "Enter send · /help · Esc stop · PgUp/PgDn scroll · Tab panes · Ctrl-C leave"
        } else {
            "/claim or /take to drive · /help · PgUp/PgDn scroll · Tab panes · Ctrl-C leave"
        };
        Paragraph::new(format!(" {} │ {keys}", self.status))
            .style(Style::default().fg(Color::DarkGray))
    }
}

/// Whether a `lease_held` refusal says the lease is this person's, in another client (`/take` would work).
fn can_take_over(refusal: &vehicle::ride::RideError) -> bool {
    refusal
        .details
        .as_ref()
        .and_then(|details| details.get("canTakeOver"))
        .and_then(Value::as_bool)
        == Some(true)
}

impl Drop for RoomApp {
    fn drop(&mut self) {
        // A panic or an early return must not leave the lease held for its whole TTL.
        if self.driving {
            let _ = self
                .client
                .release(&self.session_id, &mint_id("room-release"));
        }
    }
}

fn make_composer() -> TextArea<'static> {
    let mut composer = TextArea::default();
    composer.set_block(Block::default().borders(Borders::ALL).title("prompt"));
    composer.set_placeholder_text(
        "Say something to the session. While it runs, Enter steers. /help for commands.",
    );
    composer.set_placeholder_style(Style::default().fg(Color::DarkGray));
    composer.set_cursor_line_style(Style::default());
    composer.set_cursor_style(Style::default().fg(Color::Black).bg(Color::Cyan));
    composer
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(seq: u64, kind: &str, payload: Value) -> RideEvent {
        RideEvent {
            seq,
            ts: "2026-10-14T00:00:00.000Z".to_string(),
            kind: kind.to_string(),
            payload,
        }
    }

    #[test]
    fn a_collaborators_turn_is_named_and_the_context_note_is_not_shown() {
        assert_eq!(
            user_turn("[Codex collaborator]\nCheck the fence first."),
            (
                Speaker::Collaborator("Codex".to_string()),
                "Check the fence first.".to_string()
            )
        );
        assert_eq!(
            user_turn(
                "What regulates the rail?\n\n(Open in the person's view, by id: `doc-1`. \"This document\" means the first.)"
            ),
            (Speaker::Driver, "What regulates the rail?".to_string())
        );
        assert_eq!(
            user_turn("[not a chime] at all"),
            (Speaker::Driver, "[not a chime] at all".to_string())
        );
    }

    #[test]
    fn events_become_chat_entries_and_activity_rows() {
        let said = event_entry(
            &event(
                9,
                "message.completed",
                json!({"role": "user", "text": "[Codex collaborator]\nlook here"}),
            ),
            "me",
            None,
        );
        assert_eq!(
            said,
            Some(ChatEntry::Said {
                speaker: Speaker::Collaborator("Codex".to_string()),
                text: "look here".to_string(),
                via: None,
            })
        );
        let answer = event_entry(
            &event(
                10,
                "message.completed",
                json!({"role": "assistant", "text": "", "toolCalls": [{"id": "t1", "name": "mcp__sophia__search_documents", "args": {"query": "buck"}}]}),
            ),
            "me",
            None,
        )
        .unwrap();
        assert!(
            matches!(&answer, ChatEntry::Answer { tools, .. } if tools == &vec!["search_documents query=\"buck\"".to_string()])
        );
        let chime = event_entry(
            &event(
                11,
                "chime.received",
                json!({"chime": {"chimeId": "chime-11", "author": "Codex", "delivery": "follow_up", "text": "check it"}}),
            ),
            "me",
            None,
        )
        .unwrap();
        assert!(
            matches!(&chime, ChatEntry::Notice { text, .. } if text == "Codex chimes a follow-up (chime-11): check it")
        );
        assert_eq!(
            event_entry(
                &event(12, "lease.claimed", json!({"clientId": "me"})),
                "me",
                None
            ),
            Some(ChatEntry::Notice {
                text: "you drive".to_string(),
                tone: Tone::Muted
            })
        );
        assert_eq!(
            event_entry(&event(13, "queue.updated", json!({})), "me", None),
            None
        );
        assert_eq!(
            event_entry(
                &event(
                    13,
                    "lease.revoked",
                    json!({"clientId": "me", "by": "tab-2", "reason": "takeover"})
                ),
                "me",
                None
            ),
            Some(ChatEntry::Notice {
                text: "tab-2 took the wheel from you (/take to take it back)".to_string(),
                tone: Tone::Warning
            })
        );

        let steered = event_entry(
            &event(
                14,
                "message.completed",
                json!({"role": "user", "text": "only power"}),
            ),
            "me",
            Some("steer"),
        )
        .unwrap();
        assert_eq!(
            chat_lines(&steered, false, None)[0].to_string(),
            "you · steer",
            "a steer is labelled as one"
        );
        assert_eq!(
            event_entry(
                &event(
                    15,
                    "message.completed",
                    json!({"role": "assistant", "text": "", "stopReason": "aborted"})
                ),
                "me",
                None
            ),
            None,
            "an empty aborted reply is left to the notice"
        );

        let row = activity_item(&event(
            14,
            "command.completed",
            json!({"commandId": "chime:chime-11", "op": "follow_up", "via": {"author": "Codex"}}),
        ));
        assert_eq!(row.title, "follow_up completed");
        assert_eq!(row.detail, "chime:chime-11 via Codex");
        assert_eq!(row.tone, Tone::Success);
        let aborted = activity_item(&event(
            15,
            "run.settled",
            json!({"aborted": true, "stopReason": "aborted"}),
        ));
        assert_eq!(aborted.title, "aborted");
        assert_eq!(aborted.tone, Tone::Warning);
    }

    #[test]
    fn the_transcript_renders_who_said_what() {
        let item = |role: &str, text: &str| TranscriptItem {
            role: role.to_string(),
            text: text.to_string(),
            ..TranscriptItem::default()
        };
        let entries = [
            transcript_entry(&item("user", "Which part converts the battery voltage?")),
            transcript_entry(&TranscriptItem {
                tool_calls: vec![vehicle::ride::ToolCallView {
                    name: "mcp__sophia__read_document".to_string(),
                    args: json!({"documentId": "buck-boost-converter"}),
                }],
                ..item("assistant", "")
            }),
            transcript_entry(&TranscriptItem {
                tool_name: Some("mcp__sophia__read_document".to_string()),
                ..item("toolResult", "{}")
            }),
            transcript_entry(&item("assistant", "The TPS63020.")),
            transcript_entry(&TranscriptItem {
                stop_reason: Some("error".to_string()),
                ..item("assistant", "The comp")
            }),
        ];
        let rendered = chat_text(&entries, 1)
            .iter()
            .map(|line| line.to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            rendered,
            vec![
                "you · #1",
                "  Which part converts the battery voltage?",
                "",
                "sophia",
                "  → read_document documentId=\"buck-boost-converter\"",
                "  ← read_document ok · 2 chars",
                "",
                "  The TPS63020.",
                "",
                "sophia",
                "  The comp",
                "  ✗ the model call failed",
                "",
            ]
        );
    }
}
