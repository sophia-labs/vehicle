pub mod bridge;
pub mod ride;

use anyhow::{Context, anyhow};
use cockpit::{CockpitWidget, PaneHandle, PaneManager, SpawnConfig};
use ratatui::{
    Terminal,
    backend::TestBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum VehicleError {
    #[error("driver lease is held by {holder}; {actor} cannot submit input")]
    NotDriver { holder: String, actor: String },

    #[error("document {0} not found")]
    DocumentNotFound(String),

    #[error("block {0} not found in document")]
    BlockNotFound(String),

    #[error("line {line} is outside the document buffer")]
    LineOutOfRange { line: usize },

    #[error("column {column} is outside line {line}")]
    ColumnOutOfRange { line: usize, column: usize },

    #[error(
        "v0 preserves one line per Garden block; got {line_count} lines for {block_count} blocks"
    )]
    LineBlockCountMismatch {
        line_count: usize,
        block_count: usize,
    },

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, VehicleError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DriverLease {
    pub holder: String,
    pub epoch: u64,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Presence {
    pub user_id: String,
    pub display_name: String,
    pub focus: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Pane {
    pub pane_id: String,
    pub kind: PaneKind,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PaneKind {
    Agent,
    GardenDocument,
    PiTerminal,
    VimGardenDocument,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentEvent {
    pub seq: u64,
    pub source: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VehicleSession {
    pub session_id: String,
    pub graph_id: String,
    pub driver: DriverLease,
    pub presences: Vec<Presence>,
    pub panes: Vec<Pane>,
    pub transcript: Vec<AgentEvent>,
    pub input_draft: String,
    pub pending_control_events: Vec<ControlEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ControlEvent {
    pub actor: String,
    pub text: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum VehicleMode {
    Vim,
    Pi,
}

impl VehicleMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vim => "vim",
            Self::Pi => "pi",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Self::Vim => "Garden document via Neovim",
            Self::Pi => "Pi agent",
        }
    }

    pub fn pane_kind(self) -> PaneKind {
        match self {
            Self::Vim => PaneKind::VimGardenDocument,
            Self::Pi => PaneKind::PiTerminal,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CockpitPaneSpec {
    pub mode: VehicleMode,
    pub title: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: BTreeMap<String, String>,
}

impl CockpitPaneSpec {
    pub fn new(
        mode: VehicleMode,
        title: impl Into<String>,
        command: impl Into<String>,
        args: Vec<String>,
    ) -> Self {
        Self {
            mode,
            title: title.into(),
            command: command.into(),
            args,
            cwd: None,
            env: BTreeMap::new(),
        }
    }

    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    pub fn spawn_config(&self) -> SpawnConfig {
        let mut config = SpawnConfig::new_command(&self.command).args(self.args.clone());
        if let Some(cwd) = &self.cwd {
            config = config.cwd(cwd.clone());
        }
        for (key, value) in &self.env {
            config = config.env(key.clone(), value.clone());
        }
        config
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CockpitSessionSpec {
    pub session_id: String,
    pub graph_id: String,
    pub owner: String,
    pub primary_mode: VehicleMode,
    pub panes: Vec<CockpitPaneSpec>,
    pub width: u16,
    pub height: u16,
    pub settle_ms: u64,
}

impl CockpitSessionSpec {
    pub fn new(
        session_id: impl Into<String>,
        graph_id: impl Into<String>,
        owner: impl Into<String>,
        primary_mode: VehicleMode,
        panes: Vec<CockpitPaneSpec>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            graph_id: graph_id.into(),
            owner: owner.into(),
            primary_mode,
            panes,
            width: 120,
            height: 30,
            settle_ms: 120,
        }
    }

    pub fn viewport(mut self, width: u16, height: u16) -> Self {
        self.width = width;
        self.height = height;
        self
    }

    pub fn settle_ms(mut self, settle_ms: u64) -> Self {
        self.settle_ms = settle_ms;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CockpitPaneReport {
    pub pane_id: u64,
    pub mode: VehicleMode,
    pub title: String,
    pub command: String,
    pub pid: Option<u32>,
    pub state: String,
    pub output: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CockpitRunReport {
    pub session_id: String,
    pub graph_id: String,
    pub primary_mode: VehicleMode,
    pub focused_pane: Option<u64>,
    pub pane_count: usize,
    pub event_count: usize,
    pub pane_reports: Vec<CockpitPaneReport>,
    pub render_preview: String,
}

impl VehicleSession {
    pub fn new(
        session_id: impl Into<String>,
        graph_id: impl Into<String>,
        owner: impl Into<String>,
    ) -> Self {
        let owner = owner.into();
        Self {
            session_id: session_id.into(),
            graph_id: graph_id.into(),
            driver: DriverLease {
                holder: owner.clone(),
                epoch: 0,
                expires_at: None,
            },
            presences: vec![Presence {
                user_id: owner.clone(),
                display_name: owner,
                focus: "agent".to_string(),
            }],
            panes: vec![
                Pane {
                    pane_id: "agent-1".to_string(),
                    kind: PaneKind::Agent,
                    title: "Pi agent".to_string(),
                },
                Pane {
                    pane_id: "doc-1".to_string(),
                    kind: PaneKind::GardenDocument,
                    title: "Garden document".to_string(),
                },
            ],
            transcript: Vec::new(),
            input_draft: String::new(),
            pending_control_events: Vec::new(),
        }
    }

    pub fn take_driver(&mut self, holder: impl Into<String>) {
        self.driver.holder = holder.into();
        self.driver.epoch += 1;
    }

    pub fn append_agent_event(
        &mut self,
        source: impl Into<String>,
        text: impl Into<String>,
    ) -> AgentEvent {
        let event = AgentEvent {
            seq: self.transcript.len() as u64 + 1,
            source: source.into(),
            text: text.into(),
        };
        self.transcript.push(event.clone());
        event
    }
}

pub trait AgentBackend {
    fn send(&mut self, input: &str, session: &VehicleSession) -> Result<Vec<AgentEvent>>;
}

#[derive(Debug, Default)]
pub struct MockAgentBackend;

impl AgentBackend for MockAgentBackend {
    fn send(&mut self, input: &str, session: &VehicleSession) -> Result<Vec<AgentEvent>> {
        Ok(vec![AgentEvent {
            seq: session.transcript.len() as u64 + 1,
            source: "mock-pi".to_string(),
            text: format!("mock-pi echoed for {}: {}", session.graph_id, input),
        }])
    }
}

pub struct ControlPlane;

impl ControlPlane {
    pub fn submit_to_agent(
        session: &mut VehicleSession,
        actor: &str,
        text: &str,
        agent: &mut dyn AgentBackend,
    ) -> Result<Vec<AgentEvent>> {
        if session.driver.holder != actor {
            return Err(VehicleError::NotDriver {
                holder: session.driver.holder.clone(),
                actor: actor.to_string(),
            });
        }

        let events = agent.send(text, session)?;
        for event in &events {
            session.append_agent_event(event.source.clone(), event.text.clone());
        }
        Ok(events)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GardenDocument {
    pub document_id: String,
    pub title: String,
    pub blocks: Vec<GardenBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GardenBlock {
    pub block_id: String,
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockTextUpdate {
    pub block_id: String,
    pub text: String,
}

pub trait GardenBackend {
    fn read_document(&self, document_id: &str) -> Result<GardenDocument>;
    fn write_block_texts(
        &self,
        document_id: &str,
        updates: &[BlockTextUpdate],
    ) -> Result<GardenDocument>;
}

#[derive(Debug, Clone)]
pub struct FileGardenBackend {
    root: PathBuf,
}

impl FileGardenBackend {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn path_for(&self, document_id: &str) -> PathBuf {
        self.root.join(format!("{document_id}.json"))
    }
}

impl GardenBackend for FileGardenBackend {
    fn read_document(&self, document_id: &str) -> Result<GardenDocument> {
        let path = self.path_for(document_id);
        if !path.exists() {
            return Err(VehicleError::DocumentNotFound(document_id.to_string()));
        }
        Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
    }

    fn write_block_texts(
        &self,
        document_id: &str,
        updates: &[BlockTextUpdate],
    ) -> Result<GardenDocument> {
        let mut document = self.read_document(document_id)?;
        let updates_by_block: BTreeMap<&str, &str> = updates
            .iter()
            .map(|update| (update.block_id.as_str(), update.text.as_str()))
            .collect();

        for update in updates {
            if !document
                .blocks
                .iter()
                .any(|block| block.block_id == update.block_id)
            {
                return Err(VehicleError::BlockNotFound(update.block_id.clone()));
            }
        }

        for block in &mut document.blocks {
            if let Some(text) = updates_by_block.get(block.block_id.as_str()) {
                block.text = (*text).to_string();
            }
        }

        fs::create_dir_all(&self.root)?;
        fs::write(
            self.path_for(document_id),
            serde_json::to_string_pretty(&document)?,
        )?;
        Ok(document)
    }
}

#[derive(Debug, Clone)]
pub struct GardenDocBuffer {
    document_id: String,
    title: String,
    lines: Vec<BufferLine>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BufferLine {
    pub block_id: String,
    pub kind: String,
    pub original_text: String,
    pub text: String,
}

impl GardenDocBuffer {
    pub fn from_document(document: GardenDocument) -> Self {
        Self {
            document_id: document.document_id,
            title: document.title,
            lines: document
                .blocks
                .into_iter()
                .map(|block| BufferLine {
                    block_id: block.block_id,
                    kind: block.kind,
                    original_text: block.text.clone(),
                    text: block.text,
                })
                .collect(),
        }
    }

    pub fn document_id(&self) -> &str {
        &self.document_id
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn lines(&self) -> &[BufferLine] {
        &self.lines
    }

    pub fn text_lines(&self) -> Vec<String> {
        self.lines.iter().map(|line| line.text.clone()).collect()
    }

    pub fn replace_line(&mut self, line: usize, text: impl Into<String>) -> Result<()> {
        let Some(buffer_line) = self.lines.get_mut(line) else {
            return Err(VehicleError::LineOutOfRange { line });
        };
        buffer_line.text = text.into();
        Ok(())
    }

    pub fn insert_text(&mut self, line: usize, column: usize, text: &str) -> Result<()> {
        let Some(buffer_line) = self.lines.get_mut(line) else {
            return Err(VehicleError::LineOutOfRange { line });
        };
        if column > buffer_line.text.len() || !buffer_line.text.is_char_boundary(column) {
            return Err(VehicleError::ColumnOutOfRange { line, column });
        }
        buffer_line.text.insert_str(column, text);
        Ok(())
    }

    pub fn delete_char(&mut self, line: usize, column: usize) -> Result<()> {
        let Some(buffer_line) = self.lines.get_mut(line) else {
            return Err(VehicleError::LineOutOfRange { line });
        };
        if column >= buffer_line.text.len() || !buffer_line.text.is_char_boundary(column) {
            return Err(VehicleError::ColumnOutOfRange { line, column });
        }
        let next = buffer_line
            .text
            .char_indices()
            .find_map(|(idx, _)| (idx > column).then_some(idx))
            .unwrap_or(buffer_line.text.len());
        buffer_line.text.replace_range(column..next, "");
        Ok(())
    }

    pub fn move_line(&mut self, from: usize, to: usize) -> Result<()> {
        if from >= self.lines.len() {
            return Err(VehicleError::LineOutOfRange { line: from });
        }
        if to >= self.lines.len() {
            return Err(VehicleError::LineOutOfRange { line: to });
        }
        if from == to {
            return Ok(());
        }
        let line = self.lines.remove(from);
        self.lines.insert(to, line);
        Ok(())
    }

    pub fn changed_updates(&self) -> Vec<BlockTextUpdate> {
        self.lines
            .iter()
            .filter(|line| line.text != line.original_text)
            .map(|line| BlockTextUpdate {
                block_id: line.block_id.clone(),
                text: line.text.clone(),
            })
            .collect()
    }

    pub fn save(&mut self, backend: &dyn GardenBackend) -> Result<GardenDocument> {
        let updates = self.changed_updates();
        let document = backend.write_block_texts(&self.document_id, &updates)?;
        *self = GardenDocBuffer::from_document(document.clone());
        Ok(document)
    }
}

#[derive(Debug, Clone)]
pub struct DemoReport {
    pub driver: String,
    pub agent_event: String,
    pub changed_block: String,
    pub saved_line: String,
    pub render_preview: String,
}

pub fn seed_demo_document(root: impl AsRef<Path>) -> Result<()> {
    let root = root.as_ref();
    fs::create_dir_all(root)?;
    let document = demo_document();
    fs::write(
        root.join("demo-doc.json"),
        serde_json::to_string_pretty(&document)?,
    )?;
    Ok(())
}

pub fn demo_document() -> GardenDocument {
    GardenDocument {
        document_id: "demo-doc".to_string(),
        title: "Vehicle Demo Garden Doc".to_string(),
        blocks: vec![
            GardenBlock {
                block_id: "block-intro".to_string(),
                kind: "paragraph".to_string(),
                text: "Vehicle is a local cockpit for one Pi agent.".to_string(),
            },
            GardenBlock {
                block_id: "block-neovim".to_string(),
                kind: "paragraph".to_string(),
                text: "Neovim owns Garden document editing.".to_string(),
            },
            GardenBlock {
                block_id: "block-boundary".to_string(),
                kind: "paragraph".to_string(),
                text: "Garden stores collaboration state, not PTY bytes.".to_string(),
            },
        ],
    }
}

pub fn default_pi_pane(graph_id: &str) -> CockpitPaneSpec {
    CockpitPaneSpec::new(
        VehicleMode::Pi,
        "Pi agent shell",
        "sh",
        vec![
            "-lc".to_string(),
            format!("printf 'vehicle pi mode\\ngraph={graph_id}\\nmock pi agent ready\\n'"),
        ],
    )
}

/// A placeholder Garden-document pane: the `vim` mode's sibling in the cockpit smoke.
pub fn default_vim_pane(graph_id: &str) -> CockpitPaneSpec {
    CockpitPaneSpec::new(
        VehicleMode::Vim,
        "Garden document shell",
        "sh",
        vec![
            "-lc".to_string(),
            format!("printf 'vehicle vim mode\\ngraph={graph_id}\\nvehicle.nvim ready\\n'"),
        ],
    )
}

pub fn pi_cockpit_spec(graph_id: &str, pane: CockpitPaneSpec) -> CockpitSessionSpec {
    CockpitSessionSpec::new("vehicle-pi", graph_id, "carol", VehicleMode::Pi, vec![pane])
}

pub fn paired_pi_vim_spec(graph_id: &str) -> CockpitSessionSpec {
    CockpitSessionSpec::new(
        "vehicle-cockpit-smoke",
        graph_id,
        "carol",
        VehicleMode::Pi,
        vec![default_pi_pane(graph_id), default_vim_pane(graph_id)],
    )
}

pub async fn run_cockpit_once(spec: CockpitSessionSpec) -> anyhow::Result<CockpitRunReport> {
    if spec.panes.is_empty() {
        return Err(anyhow!("cockpit session requires at least one pane"));
    }

    let mut manager = PaneManager::new();
    let body_area = Rect {
        x: 0,
        y: 3,
        width: spec.width,
        height: spec.height.saturating_sub(3),
    };
    manager.set_terminal_size(body_area);

    let mut spawned = Vec::new();
    for pane in &spec.panes {
        let handle = manager.spawn(pane.spawn_config()).with_context(|| {
            format!(
                "failed to spawn {} cockpit pane with command {}",
                pane.mode.as_str(),
                pane.command
            )
        })?;
        spawned.push((pane.clone(), handle));
    }

    tokio::time::sleep(Duration::from_millis(spec.settle_ms)).await;
    let events = manager.poll_events();
    let render_preview = render_cockpit_preview(&spec, &manager)?;

    let pane_reports = spawned
        .iter()
        .map(|(pane, handle)| CockpitPaneReport {
            pane_id: handle.id().0,
            mode: pane.mode,
            title: pane.title.clone(),
            command: command_label(pane),
            pid: handle.pid(),
            state: pane_state_label(handle),
            output: pane_output(handle),
        })
        .collect::<Vec<_>>();

    Ok(CockpitRunReport {
        session_id: spec.session_id,
        graph_id: spec.graph_id,
        primary_mode: spec.primary_mode,
        focused_pane: manager.focused().map(|pane_id| pane_id.0),
        pane_count: manager.pane_count(),
        event_count: events.len(),
        pane_reports,
        render_preview,
    })
}

fn render_cockpit_preview(
    spec: &CockpitSessionSpec,
    manager: &PaneManager,
) -> anyhow::Result<String> {
    let backend = TestBackend::new(spec.width, spec.height);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| {
        let area = frame.area();
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(3), Constraint::Min(8)])
            .split(area);

        let header = Paragraph::new(Line::from(vec![
            Span::styled("vehicle v0", Style::default().fg(Color::Cyan)),
            Span::raw(format!(
                "  mode={}  graph={}  driver={}  panes={}",
                spec.primary_mode.as_str(),
                spec.graph_id,
                spec.owner,
                manager.pane_count()
            )),
        ]))
        .block(Block::default().borders(Borders::ALL).title("status"));
        frame.render_widget(header, chunks[0]);

        let areas = manager.get_areas();
        let areas_vec = areas
            .iter()
            .map(|(&pane_id, &area)| (pane_id, area))
            .collect::<Vec<_>>();
        let pane_ids = manager.pane_ids();
        let panes = pane_ids
            .iter()
            .filter_map(|pane_id| manager.get_pane(*pane_id).map(|handle| (*pane_id, handle)))
            .collect::<Vec<_>>();

        let widget = CockpitWidget::new(&panes, &areas_vec, manager.focused())
            .sub_panes(manager.get_sub_pane_areas())
            .empty_panes(manager.get_empty_pane_areas());
        frame.render_widget(widget, chunks[1]);
    })?;

    Ok(format!("{:?}", terminal.backend().buffer()))
}

fn command_label(pane: &CockpitPaneSpec) -> String {
    if pane.args.is_empty() {
        pane.command.clone()
    } else {
        format!("{} {}", pane.command, pane.args.join(" "))
    }
}

fn pane_state_label(handle: &PaneHandle) -> String {
    match handle.state() {
        cockpit::PaneState::Running => "running".to_string(),
        cockpit::PaneState::Exited { code } => format!("exited({code})"),
        cockpit::PaneState::Crashed { signal, error } => {
            format!("crashed(signal={signal:?}, error={error:?})")
        }
        cockpit::PaneState::Paused => "paused".to_string(),
    }
}

fn pane_output(handle: &PaneHandle) -> String {
    let snapshot = handle.screen_snapshot();
    snapshot
        .rows()
        .map(|row| {
            row.iter()
                .map(|cell| cell.char)
                .collect::<String>()
                .trim_end()
                .to_string()
        })
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn run_demo() -> Result<DemoReport> {
    let tempdir = tempfile::tempdir()?;
    seed_demo_document(tempdir.path())?;
    let garden = FileGardenBackend::new(tempdir.path());

    let mut session = VehicleSession::new("vehicle-demo", "demo-graph", "carol");
    session.take_driver("remote-collaborator");
    let mut agent = MockAgentBackend;
    let events = ControlPlane::submit_to_agent(
        &mut session,
        "remote-collaborator",
        "summarize the vehicle v0 slice",
        &mut agent,
    )?;

    let document = garden.read_document("demo-doc")?;
    let mut buffer = GardenDocBuffer::from_document(document);
    let original = buffer.lines()[1].text.clone();
    buffer.insert_text(
        1,
        original.len(),
        " It is a standalone vehicle.nvim plugin.",
    )?;
    let changed_block = buffer.changed_updates()[0].block_id.clone();
    let saved = buffer.save(&garden)?;
    let saved_line = saved
        .blocks
        .iter()
        .find(|block| block.block_id == changed_block)
        .map(|block| block.text.clone())
        .unwrap_or_default();

    let render_preview = render_session_preview(&session, &buffer)?;

    Ok(DemoReport {
        driver: session.driver.holder,
        agent_event: events[0].text.clone(),
        changed_block,
        saved_line,
        render_preview,
    })
}

pub fn render_session_preview(
    session: &VehicleSession,
    buffer: &GardenDocBuffer,
) -> Result<String> {
    let backend = TestBackend::new(96, 24);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| {
        let area = frame.area();
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(3),
                Constraint::Min(8),
                Constraint::Length(7),
            ])
            .split(area);

        let header = Paragraph::new(Line::from(vec![
            Span::styled("vehicle v0", Style::default().fg(Color::Cyan)),
            Span::raw(format!(
                "  graph={}  driver={}  doc={}",
                session.graph_id,
                session.driver.holder,
                buffer.document_id()
            )),
        ]))
        .block(Block::default().borders(Borders::ALL).title("status"));
        frame.render_widget(header, chunks[0]);

        let transcript = session
            .transcript
            .iter()
            .map(|event| Line::from(format!("#{} {}: {}", event.seq, event.source, event.text)))
            .collect::<Vec<_>>();
        let agent = Paragraph::new(transcript).block(
            Block::default()
                .borders(Borders::ALL)
                .title("Pi agent transcript"),
        );
        frame.render_widget(agent, chunks[1]);

        let doc_lines = buffer
            .lines()
            .iter()
            .map(|line| Line::from(format!("{} [{}] {}", line.block_id, line.kind, line.text)))
            .collect::<Vec<_>>();
        let doc = Paragraph::new(doc_lines).block(
            Block::default()
                .borders(Borders::ALL)
                .title("Garden document via vehicle.nvim"),
        );
        frame.render_widget(doc, chunks[2]);
    })?;

    Ok(format!("{:?}", terminal.backend().buffer()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_backend() -> (tempfile::TempDir, FileGardenBackend) {
        let tempdir = tempfile::tempdir().unwrap();
        seed_demo_document(tempdir.path()).unwrap();
        let backend = FileGardenBackend::new(tempdir.path());
        (tempdir, backend)
    }

    #[test]
    fn driver_lease_blocks_non_holder() {
        let mut session = VehicleSession::new("s", "g", "carol");
        session.take_driver("alice");
        let mut agent = MockAgentBackend;

        let err = ControlPlane::submit_to_agent(&mut session, "bob", "hi", &mut agent).unwrap_err();
        assert!(matches!(
            err,
            VehicleError::NotDriver { holder, actor } if holder == "alice" && actor == "bob"
        ));
        assert!(session.transcript.is_empty());
    }

    #[test]
    fn driver_input_appends_agent_event() {
        let mut session = VehicleSession::new("s", "g", "carol");
        let mut agent = MockAgentBackend;

        let events =
            ControlPlane::submit_to_agent(&mut session, "carol", "hello", &mut agent).unwrap();

        assert_eq!(events.len(), 1);
        assert_eq!(session.transcript.len(), 1);
        assert_eq!(session.transcript[0].source, "mock-pi");
        assert!(session.transcript[0].text.contains("hello"));
    }

    #[test]
    fn buffer_maps_lines_to_block_ids_and_saves_only_changed_blocks() {
        let (_tempdir, backend) = temp_backend();
        let document = backend.read_document("demo-doc").unwrap();
        let mut buffer = GardenDocBuffer::from_document(document);

        buffer
            .replace_line(1, "Neovim saves one Garden block.")
            .unwrap();
        let updates = buffer.changed_updates();
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].block_id, "block-neovim");

        let saved = buffer.save(&backend).unwrap();
        let saved_text = saved
            .blocks
            .iter()
            .find(|block| block.block_id == "block-neovim")
            .unwrap()
            .text
            .clone();
        assert_eq!(saved_text, "Neovim saves one Garden block.");

        let untouched = saved
            .blocks
            .iter()
            .find(|block| block.block_id == "block-boundary")
            .unwrap()
            .text
            .clone();
        assert_eq!(
            untouched,
            "Garden stores collaboration state, not PTY bytes."
        );
    }

    #[test]
    fn buffer_supports_minimal_edit_operations() {
        let (_tempdir, backend) = temp_backend();
        let document = backend.read_document("demo-doc").unwrap();
        let mut buffer = GardenDocBuffer::from_document(document);

        buffer.insert_text(0, "Vehicle".len(), " v0").unwrap();
        buffer.delete_char(0, 0).unwrap();

        assert_eq!(
            buffer.lines()[0].text,
            "ehicle v0 is a local cockpit for one Pi agent."
        );
    }

    #[test]
    fn moved_lines_keep_their_block_identity() {
        let (_tempdir, backend) = temp_backend();
        let document = backend.read_document("demo-doc").unwrap();
        let mut buffer = GardenDocBuffer::from_document(document);

        buffer.move_line(1, 0).unwrap();
        buffer
            .replace_line(0, "Moved Neovim line still belongs to block-neovim.")
            .unwrap();
        let updates = buffer.changed_updates();

        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].block_id, "block-neovim");
        assert_eq!(
            updates[0].text,
            "Moved Neovim line still belongs to block-neovim."
        );
    }

    #[test]
    fn vehicle_modes_map_to_sibling_pane_kinds() {
        assert_eq!(VehicleMode::Vim.pane_kind(), PaneKind::VimGardenDocument);
        assert_eq!(VehicleMode::Pi.pane_kind(), PaneKind::PiTerminal);
    }

    #[tokio::test]
    async fn cockpit_session_renders_pi_and_vim_panes() {
        let spec = paired_pi_vim_spec("demo-graph")
            .viewport(100, 24)
            .settle_ms(180);
        let report = run_cockpit_once(spec).await.unwrap();

        assert_eq!(report.primary_mode, VehicleMode::Pi);
        assert_eq!(report.pane_count, 2);
        assert!(report.pane_reports.iter().any(
            |pane| pane.mode == VehicleMode::Pi && pane.output.contains("mock pi agent ready")
        ));
        assert!(report.pane_reports.iter().any(
            |pane| pane.mode == VehicleMode::Vim && pane.output.contains("vehicle.nvim ready")
        ));
        assert!(report.render_preview.contains("mode=pi"));
        assert!(report.render_preview.contains("vehicle pi mode"));
    }

    #[test]
    fn demo_runs_full_flow() {
        let report = run_demo().unwrap();

        assert_eq!(report.driver, "remote-collaborator");
        assert!(
            report
                .agent_event
                .contains("summarize the vehicle v0 slice")
        );
        assert_eq!(report.changed_block, "block-neovim");
        assert!(report.saved_line.contains("vehicle.nvim plugin"));
        assert!(report.render_preview.contains("Pi agent transcript"));
        assert!(
            report
                .render_preview
                .contains("Garden document via vehicle.nvim")
        );
    }
}
