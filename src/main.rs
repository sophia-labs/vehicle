use anyhow::{Context, Result, anyhow, bail};
use clap::{Args, Parser, Subcommand, ValueEnum};
use cockpit::{CockpitWidget, PaneManager};
use crossterm::{
    event::{self, Event, KeyCode, KeyModifiers},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{
    Terminal,
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
};
use serde_json::{Value, json};
use std::{
    env, fs,
    io::{self, Read, Write, stdout},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use vehicle::{
    CockpitPaneSpec, CockpitRunReport, CockpitSessionSpec, ControlPlane, FileGardenBackend,
    GardenBackend, GardenDocBuffer, MockAgentBackend, VehicleMode, VehicleSession,
    bridge::{
        BridgeMutationRequest, BridgeProjection, BridgeSaveRequest, GardenJsonBlock,
        GardenJsonDocument, apply_ydoc_mutations_path, init_ydoc_from_json_path,
        project_json_document_path, project_ydoc_path, run_live_bridge_stdio,
        save_json_document_path, sync_ydoc_once_path,
    },
    default_pi_pane, paired_pi_vim_spec, pi_cockpit_spec, render_session_preview,
    ride::{
        ChimeRequest, CreateSession, Credential, DEFAULT_GARDEND_URL, Delivery, RideClient,
        RideEndpoint, RideStdioOptions, RideTarget, WatchMode, is_ride_error, mint_id,
        process_client_id, run_ride_stdio, short_session_id, user_message,
    },
    run_cockpit_once, run_demo, seed_demo_document,
};

mod lobby;
mod room;
mod tui;

#[derive(Debug, Parser)]
#[command(name = "vehicle")]
#[command(
    about = "Vehicle: the agent core's terminal surface (rooms, chimes, rides over gardend) and the standalone vehicle.nvim Garden editor"
)]
struct Cli {
    #[arg(long, help = "Run the deterministic end-to-end demo")]
    demo: bool,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
enum Commands {
    Demo,
    Bridge {
        #[command(subcommand)]
        command: BridgeCommands,
    },
    Seed {
        #[arg(long, default_value = "fixtures/garden-docs")]
        root: PathBuf,
    },
    Render {
        #[arg(long, default_value = "fixtures/garden-docs")]
        root: PathBuf,
        #[arg(long, default_value = "demo-doc")]
        document_id: String,
    },
    Edit {
        #[arg(default_value = "demo-doc")]
        document_id: String,
        #[arg(long, default_value = "fixtures/garden-docs")]
        root: PathBuf,
        #[arg(long, default_value = "nvim")]
        nvim: String,
    },
    Vim {
        #[arg(default_value = "demo-doc")]
        document_id: String,
        #[arg(long, default_value = "fixtures/garden-docs")]
        root: PathBuf,
        #[arg(long, default_value = "nvim")]
        nvim: String,
    },
    Pi {
        #[arg(long, default_value = "demo-graph")]
        graph_id: String,
        #[arg(long)]
        command: Option<String>,
        #[arg(long = "arg")]
        args: Vec<String>,
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[arg(long, default_value_t = 120)]
        settle_ms: u64,
        #[arg(long)]
        interactive: bool,
    },
    /// List your ride sessions (on --graph, or on every graph).
    Sessions {
        #[command(flatten)]
        ride: RideCli,
        #[arg(long)]
        json: bool,
    },
    /// Enter a session's room: watch it stream, drive it, take chimes. No session: pick one.
    Room {
        #[arg(value_name = "SESSION_ID")]
        session_id: Option<String>,
        /// Start a new session on --graph and enter its room.
        #[arg(long, conflicts_with = "session_id")]
        new: bool,
        /// A title for the new session.
        #[arg(long, requires = "new")]
        title: Option<String>,
        /// The new session's model, provider/model (default: the host's).
        #[arg(long, requires = "new")]
        model: Option<String>,
        /// The new session's profile: chat (graph tools; the default) or agent (an isolated body with a working
        /// folder and pi's read, write, edit and bash; the graph's owner only).
        #[arg(long, requires = "new", value_parser = ["chat", "agent"])]
        profile: Option<String>,
        /// How to follow the session: sse (live text; long-poll if the way in cannot stream) or poll.
        #[arg(long, value_enum, default_value_t = WatchArg::Sse)]
        watch: WatchArg,
        #[command(flatten)]
        ride: RideCli,
    },
    /// Branch a session: a new conversation with its history before one of its messages (pi's fork). The
    /// original is untouched; the message's words are printed, to edit and send in the branch's room.
    Branch {
        #[arg(value_name = "SESSION_ID")]
        session_id: String,
        /// The message to branch before: its number (1 = the first said in the session) or its id from
        /// `inspect` [default: the last].
        #[arg(long, value_name = "MESSAGE")]
        before: Option<String>,
        #[arg(long)]
        json: bool,
        #[command(flatten)]
        ride: RideCli,
    },
    /// Duplicate a session: a new conversation with its whole history (pi's clone), named "Copy of" it.
    Duplicate {
        #[arg(value_name = "SESSION_ID")]
        session_id: String,
        #[arg(long)]
        json: bool,
        #[command(flatten)]
        ride: RideCli,
    },
    /// Chime into a session's room: an attributed message its policy decides on.
    Chime {
        #[arg(value_name = "SESSION_ID")]
        session_id: String,
        /// Your name as the model and the room see it: `[<author> collaborator]`.
        #[arg(long, env = "VEHICLE_AUTHOR")]
        author: Option<String>,
        /// What it becomes once accepted.
        #[arg(long, value_enum, default_value_t = DeliveryArg::Prompt)]
        delivery: DeliveryArg,
        #[arg(long)]
        request_id: Option<String>,
        #[arg(long)]
        json: bool,
        #[command(flatten)]
        ride: RideCli,
        #[arg(required = true)]
        text: Vec<String>,
    },
    /// Set a room's chime policy. It needs the driver lease: share the room's --client-id, or run it when
    /// nobody drives (it claims, sets and lets go).
    Policy {
        #[arg(value_name = "SESSION_ID")]
        session_id: String,
        #[arg(value_enum)]
        policy: PolicyArg,
        #[command(flatten)]
        ride: RideCli,
    },
    /// The ride over stdio for agents: JSONL `sophia.vehicle-ride.v2` (ready, one frame per request, closed).
    Ride {
        /// Drive this session.
        #[arg(long)]
        session: Option<String>,
        /// Start a new session on --graph.
        #[arg(long, conflicts_with = "session")]
        new: bool,
        #[arg(long, requires = "new")]
        title: Option<String>,
        #[arg(long, requires = "new")]
        model: Option<String>,
        /// chat (the default) or agent (an isolated body; the graph's owner only).
        #[arg(long, requires = "new", value_parser = ["chat", "agent"])]
        profile: Option<String>,
        /// Do not claim the driver lease at the start (read, watch and chime only, until `claim`).
        #[arg(long)]
        no_claim: bool,
        #[command(flatten)]
        ride: RideCli,
    },
    CockpitSmoke {
        #[arg(long, default_value = "demo-graph")]
        graph_id: String,
        #[arg(long, default_value_t = 180)]
        settle_ms: u64,
    },
    NvimSmoke {
        #[arg(long, default_value = "nvim")]
        nvim: String,
        #[arg(long)]
        root: Option<PathBuf>,
    },
    NvimBridgeSmoke {
        #[arg(long, default_value = "nvim")]
        nvim: String,
    },
    NvimLiveBridgeSmoke {
        #[arg(long, default_value = "nvim")]
        nvim: String,
    },
    GardenFixture {
        #[arg(long, default_value = "vehicle-garden-fixture")]
        graph_id: String,
        #[arg(long, default_value = "demo-doc")]
        document_id: String,
        #[arg(long, default_value_t = 8787)]
        port: u16,
        #[arg(long, default_value = "nvim")]
        nvim: String,
        #[arg(long)]
        profile_dir: Option<PathBuf>,
        #[arg(long)]
        no_open: bool,
        #[arg(long)]
        no_vim: bool,
        #[arg(long)]
        prepare_only: bool,
        #[arg(long)]
        reuse: bool,
    },
}

/// How a ride reaches its session: through gardend, as gardend's caller.
#[derive(Debug, Clone, Args)]
struct RideCli {
    /// gardend's address.
    #[arg(long, env = "VEHICLE_GARDEND", default_value = DEFAULT_GARDEND_URL)]
    gardend: String,
    /// The graph to bind (`/services/vehicle/g/<graph>`); a new session needs one.
    #[arg(long, env = "VEHICLE_GRAPH")]
    graph: Option<String>,
    /// The profile's master key file, used when the token variable is unset [default: ~/sophia/selfhost-key.json].
    #[arg(long, env = "VEHICLE_KEY_FILE")]
    key_file: Option<PathBuf>,
    /// The environment variable that holds a gardend token; when it is set it is used instead of the key.
    #[arg(long, default_value = "VEHICLE_TOKEN")]
    token_env: String,
    /// This client's id, the unit that holds the driver lease [default: one per process].
    #[arg(long, env = "VEHICLE_CLIENT_ID")]
    client_id: Option<String>,
    /// Go as a visitor of a public Sophia, with no credential. The default for a gardend that is not on this
    /// computer when no token variable is set and no --key-file is given.
    #[arg(long, env = "VEHICLE_ANONYMOUS")]
    anonymous: bool,
    /// A visitor's id, the same from one ride to the next [default: one kept in ~/.local/state/vehicle/visitor-id].
    #[arg(long, env = "VEHICLE_VISITOR_ID")]
    visitor_id: Option<String>,
    /// The environment variable that holds your own model key (an OpenRouter key), sent as X-Model-Key: a public
    /// Sophia's conversations run on it. Never on the command line.
    #[arg(long, default_value = "VEHICLE_MODEL_KEY")]
    model_key_env: String,
}

impl RideCli {
    fn client(&self, kind: &str) -> Result<RideClient> {
        let client_id = self
            .client_id
            .clone()
            .unwrap_or_else(|| process_client_id(kind));
        let endpoint = if self.goes_anonymous() {
            let visitor_id = match &self.visitor_id {
                Some(id) => id.clone(),
                None => kept_visitor_id()?,
            };
            RideEndpoint::anonymous(
                &self.gardend,
                self.graph.as_deref(),
                &visitor_id,
                &client_id,
            )?
        } else {
            let key_file = match &self.key_file {
                Some(path) => path.clone(),
                None => default_key_file()?,
            };
            let credential = Credential::resolve(&self.token_env, &key_file)?;
            RideEndpoint::new(&self.gardend, self.graph.as_deref(), credential, &client_id)?
        };
        let endpoint = match env::var(&self.model_key_env)
            .ok()
            .filter(|value| !value.trim().is_empty())
        {
            Some(key) => endpoint.with_model_key(
                Credential::new(key)
                    .with_context(|| format!("the key in ${}", self.model_key_env))?,
            ),
            None => endpoint,
        };
        RideClient::new(endpoint)
    }

    /// No credential: asked for, or a gardend elsewhere with none configured (a public Sophia, given its URL).
    fn goes_anonymous(&self) -> bool {
        if self.anonymous {
            return true;
        }
        let configured = self.key_file.is_some()
            || env::var(&self.token_env)
                .ok()
                .is_some_and(|value| !value.trim().is_empty());
        !configured && !is_loopback_url(&self.gardend)
    }
}

/// `http(s)://127.0.0.1…`, `localhost` or `[::1]`: a gardend on this computer.
fn is_loopback_url(url: &str) -> bool {
    let rest = url
        .trim()
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = if host.starts_with('[') {
        host.split(']')
            .next()
            .unwrap_or_default()
            .trim_start_matches('[')
    } else {
        host.split(':').next().unwrap_or_default()
    };
    host == "localhost" || host == "::1" || host.starts_with("127.")
}

/// This computer's visitor id for public Sophias, made once (32 random hex digits) and kept owner-only.
fn kept_visitor_id() -> Result<String> {
    let dir = match env::var_os("XDG_STATE_HOME").filter(|dir| !dir.is_empty()) {
        Some(dir) => PathBuf::from(dir).join("vehicle"),
        None => PathBuf::from(
            env::var_os("HOME")
                .filter(|home| !home.is_empty())
                .ok_or_else(|| anyhow!("HOME is unset: pass --visitor-id"))?,
        )
        .join(".local/state/vehicle"),
    };
    let path = dir.join("visitor-id");
    if let Ok(id) = fs::read_to_string(&path) {
        let id = id.trim().to_string();
        if id.len() >= 16 {
            return Ok(id);
        }
    }
    let mut bytes = [0u8; 16];
    {
        use std::io::Read;
        fs::File::open("/dev/urandom")
            .and_then(|mut random| random.read_exact(&mut bytes))
            .context("read /dev/urandom for a visitor id")?;
    }
    let id: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .with_context(|| format!("write {}", path.display()))?;
        writeln!(file, "{id}")?;
    }
    #[cfg(not(unix))]
    fs::write(&path, format!("{id}\n")).with_context(|| format!("write {}", path.display()))?;
    Ok(id)
}

fn default_key_file() -> Result<PathBuf> {
    let home = env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .ok_or_else(|| anyhow!("HOME is unset: pass --key-file"))?;
    Ok(PathBuf::from(home).join("sophia/selfhost-key.json"))
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum WatchArg {
    Sse,
    Poll,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum DeliveryArg {
    Prompt,
    FollowUp,
    Steer,
}

impl From<DeliveryArg> for Delivery {
    fn from(value: DeliveryArg) -> Self {
        match value {
            DeliveryArg::Prompt => Self::Prompt,
            DeliveryArg::FollowUp => Self::FollowUp,
            DeliveryArg::Steer => Self::Steer,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum PolicyArg {
    Observe,
    Suggest,
    CoDrive,
    Mute,
}

impl PolicyArg {
    fn as_str(self) -> &'static str {
        match self {
            Self::Observe => "observe",
            Self::Suggest => "suggest",
            Self::CoDrive => "co-drive",
            Self::Mute => "mute",
        }
    }
}

#[derive(Debug, Subcommand)]
enum BridgeCommands {
    ProjectJson {
        #[arg(long, default_value = "fixtures/garden-docs")]
        root: PathBuf,
        #[arg(long, default_value = "demo-doc")]
        document_id: String,
    },
    SaveJson {
        #[arg(long, default_value = "fixtures/garden-docs")]
        root: PathBuf,
        #[arg(long, default_value = "demo-doc")]
        document_id: String,
    },
    InitYdoc {
        #[arg(long)]
        json: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
    ProjectYdoc {
        #[arg(long)]
        path: PathBuf,
        #[arg(long, default_value = "demo-doc")]
        document_id: String,
    },
    ApplyYdoc {
        #[arg(long)]
        path: PathBuf,
        #[arg(long, default_value = "demo-doc")]
        document_id: String,
    },
    SyncYdocOnce {
        #[arg(long)]
        path: PathBuf,
        #[arg(long)]
        url: String,
        #[arg(long, default_value = "demo-doc")]
        document_id: String,
        #[arg(long, default_value = "VEHICLE_GARDEN_TOKEN")]
        token_env: String,
        #[arg(long)]
        on_behalf_of: Option<String>,
        #[arg(long)]
        on_behalf_of_env: Option<String>,
        #[arg(long, default_value_t = 2500)]
        timeout_ms: u64,
    },
    Live,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    if cli.demo {
        return print_demo();
    }

    match cli.command.unwrap_or(Commands::Demo) {
        Commands::Demo => print_demo(),
        Commands::Bridge { command } => bridge_command(command),
        Commands::Seed { root } => {
            seed_demo_document(&root)?;
            println!("seeded {}", root.join("demo-doc.json").display());
            Ok(())
        }
        Commands::Render { root, document_id } => render_fixture(&root, &document_id),
        Commands::Edit {
            document_id,
            root,
            nvim,
        }
        | Commands::Vim {
            document_id,
            root,
            nvim,
        } => launch_nvim(&nvim, &root, &document_id),
        Commands::Pi {
            graph_id,
            command,
            args,
            cwd,
            settle_ms,
            interactive,
        } => {
            let pane = cockpit_pane_from_cli(
                VehicleMode::Pi,
                &graph_id,
                command,
                args,
                cwd,
                default_pi_pane,
            );
            let spec = pi_cockpit_spec(&graph_id, pane).settle_ms(settle_ms);
            run_cockpit_mode(spec, interactive)
        }
        Commands::Sessions { ride, json } => run_sessions(&ride, json),
        Commands::Room {
            session_id,
            new,
            title,
            model,
            profile,
            watch,
            ride,
        } => run_room(&ride, session_id, new, title, model, profile, watch),
        Commands::Branch {
            session_id,
            before,
            json,
            ride,
        } => run_branch(&ride, &session_id, Some(before), json),
        Commands::Duplicate {
            session_id,
            json,
            ride,
        } => run_branch(&ride, &session_id, None, json),
        Commands::Chime {
            session_id,
            author,
            delivery,
            request_id,
            json,
            ride,
            text,
        } => run_chime(
            &ride,
            &session_id,
            author,
            delivery.into(),
            request_id,
            &text.join(" "),
            json,
        ),
        Commands::Policy {
            session_id,
            policy,
            ride,
        } => run_policy(&ride, &session_id, policy),
        Commands::Ride {
            session,
            new,
            title,
            model,
            profile,
            no_claim,
            ride,
        } => run_ride(&ride, session, new, title, model, profile, no_claim),
        Commands::CockpitSmoke {
            graph_id,
            settle_ms,
        } => run_cockpit_cli(paired_pi_vim_spec(&graph_id).settle_ms(settle_ms)),
        Commands::NvimSmoke { nvim, root } => nvim_smoke(&nvim, root.as_deref()),
        Commands::NvimBridgeSmoke { nvim } => nvim_bridge_smoke(&nvim),
        Commands::NvimLiveBridgeSmoke { nvim } => nvim_live_bridge_smoke(&nvim),
        Commands::GardenFixture {
            graph_id,
            document_id,
            port,
            nvim,
            profile_dir,
            no_open,
            no_vim,
            prepare_only,
            reuse,
        } => run_garden_fixture(GardenFixtureOptions {
            graph_id,
            document_id,
            port,
            nvim,
            profile_dir,
            no_open,
            no_vim,
            prepare_only,
            reuse,
        }),
    }
}

fn run_sessions(ride: &RideCli, json_output: bool) -> Result<()> {
    let client = ride.client("cli")?;
    let sessions = client.list_sessions()?;
    if json_output {
        return print_json(&sessions);
    }
    if sessions.is_empty() {
        println!("no sessions");
        return Ok(());
    }
    println!(
        "{:<36}  {:<20}  {:<8}  {:<9}  {:<24}  {:<19}  TITLE",
        "SESSION", "GRAPH", "STATUS", "POLICY", "DRIVER", "UPDATED"
    );
    for session in &sessions {
        println!(
            "{:<36}  {:<20}  {:<8}  {:<9}  {:<24}  {:<19}  {}",
            session.session_id,
            session.graph_id,
            session.status,
            session.room_policy,
            session
                .lease
                .as_ref()
                .map_or("-", |lease| lease.client_id.as_str()),
            session.updated_at.get(..19).unwrap_or(&session.updated_at),
            session
                .label()
                .replace('\n', " ")
                .chars()
                .take(60)
                .collect::<String>()
        );
        if let Some(lineage) = session.lineage(&sessions) {
            println!("{:<36}  {lineage}", "");
        }
    }
    Ok(())
}

/// `vehicle branch` (`before: Some(..)`: a fork before one of the session's messages) and `vehicle duplicate`
/// (`None`: a clone). A branch needs only the source's ownership, and its lease goes to this client: a
/// one-off command gives it back at once, so that the branch's room can take it (with `--client-id`, that
/// client keeps it).
fn run_branch(
    ride: &RideCli,
    session_id: &str,
    before: Option<Option<String>>,
    json_output: bool,
) -> Result<()> {
    let client = ride.client("cli")?;
    let snapshot = client.inspect(session_id).map_err(|error| {
        if is_ride_error(&error, "not_found") {
            anyhow!("no session {session_id} for you here (wrong id, another graph than --graph, or not yours)")
        } else {
            error
        }
    })?;
    // On the session's graph: the request then carries the person's delegation for the branch to start with.
    let client = client.for_session_graph(&snapshot.session.graph_id)?;
    let (branch, message) = match &before {
        Some(before) => {
            let message = user_message(&snapshot.transcript, before.as_deref())?;
            (client.fork(session_id, &message.entry_id)?, Some(message))
        }
        None => (client.duplicate(session_id)?, None),
    };
    let new_id = branch.session.session_id.clone();
    let kept = ride.client_id.is_some();
    if !kept {
        client.release(&new_id, &mint_id("branch-release"))?;
    }
    if json_output {
        return print_json(json!({
            "sessionId": new_id,
            "kind": if before.is_some() { "fork" } else { "clone" },
            "from": session_id,
            "before": message.as_ref().map(|message| json!({"number": message.number, "entryId": message.entry_id})),
            "selectedText": branch.selected_text,
            "leaseKept": kept,
            "session": branch.session,
        }));
    }
    let source = snapshot.session.label().replace('\n', " ");
    let source: String = source.chars().take(60).collect();
    match &message {
        Some(message) => {
            println!(
                "branched {new_id} from \"{source}\" ({}) before message {}",
                short_session_id(session_id),
                message.number
            );
            let words = branch.selected_text.as_deref().unwrap_or(&message.text);
            for line in words.lines() {
                println!("  > {line}");
            }
            println!("continue it: vehicle room {new_id} (edit that message there and send it)");
        }
        None => {
            println!(
                "duplicated {new_id} from \"{source}\" ({}): {}",
                short_session_id(session_id),
                branch.session.label().replace('\n', " ")
            );
            println!("continue it: vehicle room {new_id}");
        }
    }
    Ok(())
}

fn run_room(
    ride: &RideCli,
    session_id: Option<String>,
    new: bool,
    title: Option<String>,
    model: Option<String>,
    profile: Option<String>,
    watch: WatchArg,
) -> Result<()> {
    let client = ride.client("room")?;
    let watch = match watch {
        WatchArg::Sse => WatchMode::Stream,
        WatchArg::Poll => WatchMode::Poll,
    };
    let session_id = match (session_id, new) {
        (Some(session_id), _) => session_id,
        (None, true) => new_session(&client, title, model, profile)?,
        (None, false) => match lobby::select(&client)? {
            lobby::LobbyChoice::Open(session_id) => session_id,
            lobby::LobbyChoice::New => new_session(&client, None, None, None)?,
            lobby::LobbyChoice::Quit => return Ok(()),
        },
    };
    room::run(room::RoomOptions {
        client,
        session_id,
        watch,
    })
}

fn new_session(
    client: &RideClient,
    title: Option<String>,
    model: Option<String>,
    profile: Option<String>,
) -> Result<String> {
    let summary = client.create_session(&CreateSession {
        request_id: mint_id("new"),
        title,
        model,
        profile,
        claim: true,
    })?;
    Ok(summary.session_id)
}

/// The author a chime carries when none is given: `$USER`, kept to the characters the room accepts.
fn default_author() -> String {
    let user: String = env::var("USER")
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        .take(64)
        .collect();
    if user.is_empty() {
        "collaborator".to_string()
    } else {
        user
    }
}

fn run_chime(
    ride: &RideCli,
    session_id: &str,
    author: Option<String>,
    delivery: Delivery,
    request_id: Option<String>,
    text: &str,
    json_output: bool,
) -> Result<()> {
    let client = ride.client("chime")?;
    let request = ChimeRequest {
        request_id: request_id
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| mint_id("chime")),
        author: author
            .filter(|author| !author.trim().is_empty())
            .unwrap_or_else(default_author),
        delivery,
        text: text.to_string(),
    };
    let outcome = client.chime(session_id, &request)?;
    if json_output {
        print_json(json!({
            "disposition": outcome.disposition,
            "chimeId": outcome.chime_id,
            "policy": outcome.policy,
            "message": outcome.message,
            "commandId": outcome.command_id,
        }))?;
    }
    let policy = outcome.policy.as_deref().unwrap_or("?");
    match outcome.disposition.as_str() {
        "rejected" => bail!(
            "refused by the room ({policy}): {}",
            outcome.message.as_deref().unwrap_or("not taken")
        ),
        _ if json_output => Ok(()),
        "pending" => {
            println!(
                "pending {} ({policy}): {}",
                outcome.chime_id.as_deref().unwrap_or("-"),
                outcome
                    .message
                    .as_deref()
                    .unwrap_or("waiting for the driver to accept or reject it")
            );
            Ok(())
        }
        "submitted" => {
            println!(
                "submitted {} ({policy}) as command {}",
                outcome.chime_id.as_deref().unwrap_or("-"),
                outcome.command_id.as_deref().unwrap_or("-")
            );
            Ok(())
        }
        other => {
            println!("{other} ({policy})");
            Ok(())
        }
    }
}

fn run_policy(ride: &RideCli, session_id: &str, policy: PolicyArg) -> Result<()> {
    let client = ride.client("cli")?;
    match client.set_room_policy(session_id, policy.as_str()) {
        Ok(_) => {}
        Err(error) if is_ride_error(&error, "lease_required") => {
            // Nobody drives: take the wheel for this one change and give it back.
            client.claim(session_id, &mint_id("policy-claim"))?;
            let set = client.set_room_policy(session_id, policy.as_str());
            let released = client.release(session_id, &mint_id("policy-release"));
            set?;
            released?;
        }
        Err(error) if is_ride_error(&error, "lease_held") => {
            return Err(error.context(
                "another client drives this session: type /policy in its room, or run this with the room's --client-id",
            ));
        }
        Err(error) => return Err(error),
    }
    println!("policy {}", policy.as_str());
    Ok(())
}

fn run_ride(
    ride: &RideCli,
    session: Option<String>,
    new: bool,
    title: Option<String>,
    model: Option<String>,
    profile: Option<String>,
    no_claim: bool,
) -> Result<()> {
    let client = ride.client("ride")?;
    let target = match (session, new) {
        (Some(session_id), _) => RideTarget::Existing(session_id),
        (None, true) => RideTarget::New(CreateSession {
            request_id: mint_id("ride-new"),
            title,
            model,
            profile,
            claim: !no_claim,
        }),
        (None, false) => bail!("ride needs --session <id> or --new (with --graph)"),
    };
    let stdin = io::stdin();
    let stdout = io::stdout();
    run_ride_stdio(
        &client,
        &RideStdioOptions {
            target,
            claim: !no_claim,
        },
        stdin.lock(),
        stdout.lock(),
    )
}

fn bridge_command(command: BridgeCommands) -> Result<()> {
    match command {
        BridgeCommands::ProjectJson { root, document_id } => {
            let path = root.join(format!("{document_id}.json"));
            print_json(project_json_document_path(&path)?)
        }
        BridgeCommands::SaveJson { root, document_id } => {
            let path = root.join(format!("{document_id}.json"));
            let request: BridgeSaveRequest = read_stdin_json()?;
            print_json(save_json_document_path(&path, request)?)
        }
        BridgeCommands::InitYdoc { json, output } => {
            print_json(init_ydoc_from_json_path(&json, &output)?)
        }
        BridgeCommands::ProjectYdoc { path, document_id } => {
            print_json(project_ydoc_path(&path, &document_id)?)
        }
        BridgeCommands::ApplyYdoc { path, document_id } => {
            let request: BridgeMutationRequest = read_stdin_json()?;
            print_json(apply_ydoc_mutations_path(&path, &document_id, request)?)
        }
        BridgeCommands::SyncYdocOnce {
            path,
            url,
            document_id,
            token_env,
            on_behalf_of,
            on_behalf_of_env,
            timeout_ms,
        } => {
            let token = env::var(token_env).ok();
            let env_on_behalf_of = on_behalf_of_env
                .as_deref()
                .and_then(|key| env::var(key).ok());
            let on_behalf_of = on_behalf_of.as_deref().or(env_on_behalf_of.as_deref());
            let runtime = tokio::runtime::Runtime::new()?;
            print_json(runtime.block_on(sync_ydoc_once_path(
                &path,
                &document_id,
                &url,
                token.as_deref(),
                on_behalf_of,
                Duration::from_millis(timeout_ms),
            ))?)
        }
        BridgeCommands::Live => {
            let runtime = tokio::runtime::Runtime::new()?;
            runtime.block_on(run_live_bridge_stdio())
        }
    }
}

fn read_stdin_json<T: serde::de::DeserializeOwned>() -> Result<T> {
    let mut body = String::new();
    io::stdin().read_to_string(&mut body)?;
    if body.trim().is_empty() {
        return Err(anyhow!("expected JSON request on stdin"));
    }
    Ok(serde_json::from_str(&body)?)
}

fn print_json<T: serde::Serialize>(value: T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

fn print_demo() -> Result<()> {
    let report = run_demo()?;
    println!("Vehicle v0 demo");
    println!("driver: {}", report.driver);
    println!("agent: {}", report.agent_event);
    println!("changed block: {}", report.changed_block);
    println!("saved line: {}", report.saved_line);
    println!("\nratatui preview buffer:\n{}", report.render_preview);
    Ok(())
}

fn cockpit_pane_from_cli(
    mode: VehicleMode,
    graph_id: &str,
    command: Option<String>,
    args: Vec<String>,
    cwd: Option<PathBuf>,
    default_pane: fn(&str) -> CockpitPaneSpec,
) -> CockpitPaneSpec {
    let mut pane = if let Some(command) = command {
        CockpitPaneSpec::new(mode, mode.title(), command, args)
    } else {
        default_pane(graph_id)
    };
    if let Some(cwd) = cwd {
        pane = pane.cwd(cwd);
    }
    pane
}

fn run_cockpit_mode(spec: CockpitSessionSpec, interactive: bool) -> Result<()> {
    if interactive {
        run_interactive_cockpit(spec)
    } else {
        run_cockpit_cli(spec)
    }
}

fn run_cockpit_cli(spec: CockpitSessionSpec) -> Result<()> {
    let runtime = tokio::runtime::Runtime::new()?;
    let report = runtime.block_on(run_cockpit_once(spec))?;
    print_cockpit_report(&report);
    Ok(())
}

fn run_interactive_cockpit(spec: CockpitSessionSpec) -> Result<()> {
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(run_interactive_cockpit_async(spec))
}

async fn run_interactive_cockpit_async(spec: CockpitSessionSpec) -> Result<()> {
    let mut stdout = stdout();
    enable_raw_mode()?;
    execute!(stdout, EnterAlternateScreen)?;
    let _terminal_guard = TerminalModeGuard;

    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    terminal.clear()?;

    let size = terminal.size()?;
    let mut manager = PaneManager::new();
    manager.set_terminal_size(Rect {
        x: 0,
        y: 3,
        width: size.width,
        height: size.height.saturating_sub(3),
    });
    for pane in &spec.panes {
        manager.spawn(pane.spawn_config()).with_context(|| {
            format!(
                "failed to spawn {} cockpit pane with command {}",
                pane.mode.as_str(),
                pane.command
            )
        })?;
    }

    loop {
        let size = terminal.size()?;
        let body_area = Rect {
            x: 0,
            y: 3,
            width: size.width,
            height: size.height.saturating_sub(3),
        };
        manager.set_terminal_size(body_area);
        manager.poll_events();

        terminal.draw(|frame| {
            let area = frame.area();
            let chunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Length(3), Constraint::Min(8)])
                .split(area);

            let header = Paragraph::new(Line::from(vec![
                Span::styled("vehicle v0", Style::default().fg(Color::Cyan)),
                Span::raw(format!(
                    "  mode={}  graph={}  driver={}  panes={}  tab=focus  ctrl-q=quit",
                    spec.primary_mode.as_str(),
                    spec.graph_id,
                    spec.owner,
                    manager.pane_count()
                )),
            ]))
            .block(Block::default().borders(Borders::ALL).title("status"));
            frame.render_widget(header, chunks[0]);

            let areas_vec = manager
                .get_areas()
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

        if event::poll(Duration::from_millis(16))? {
            match event::read()? {
                Event::Key(key) => {
                    if key.code == KeyCode::Char('q')
                        && key.modifiers.contains(KeyModifiers::CONTROL)
                    {
                        break;
                    }
                    if key.code == KeyCode::Tab {
                        manager.focus_next();
                    } else {
                        manager.route_key(key).await?;
                    }
                }
                Event::Resize(width, height) => {
                    manager.set_terminal_size(Rect {
                        x: 0,
                        y: 3,
                        width,
                        height: height.saturating_sub(3),
                    });
                }
                _ => {}
            }
        }
    }

    Ok(())
}

struct TerminalModeGuard;

impl Drop for TerminalModeGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(stdout(), LeaveAlternateScreen);
    }
}

fn print_cockpit_report(report: &CockpitRunReport) {
    println!("Vehicle v0 {}", report.primary_mode.as_str());
    println!("graph: {}", report.graph_id);
    println!("panes: {}", report.pane_count);
    println!("focused pane: {:?}", report.focused_pane);
    println!("events: {}", report.event_count);
    for pane in &report.pane_reports {
        println!(
            "pane {} [{}] pid={:?} state={} command={}",
            pane.pane_id,
            pane.mode.as_str(),
            pane.pid,
            pane.state,
            pane.command
        );
        if !pane.output.is_empty() {
            println!("{}", pane.output);
        }
    }
    println!("\nratatui cockpit buffer:\n{}", report.render_preview);
}

fn render_fixture(root: &Path, document_id: &str) -> Result<()> {
    if !root.join(format!("{document_id}.json")).exists() {
        seed_demo_document(root)?;
    }

    let backend = FileGardenBackend::new(root);
    let document = backend.read_document(document_id)?;
    let buffer = GardenDocBuffer::from_document(document);
    let mut session = VehicleSession::new("render", "demo-graph", "carol");
    let mut agent = MockAgentBackend;
    ControlPlane::submit_to_agent(&mut session, "carol", "render preview", &mut agent)?;
    let preview = render_session_preview(&session, &buffer)?;
    println!("{preview}");
    Ok(())
}

fn launch_nvim(nvim: &str, root: &Path, document_id: &str) -> Result<()> {
    if !root.join(format!("{document_id}.json")).exists() {
        seed_demo_document(root)?;
    }
    let plugin_root = plugin_root();
    let root = absolutize(root)?;
    let status = Command::new(nvim)
        .arg("--cmd")
        .arg(format!("set rtp+={}", plugin_root.display()))
        .arg("+lua require('vehicle.garden').setup({ adapter = { kind = 'json-file', root = vim.env.VEHICLE_GARDEN_ROOT } })")
        .arg(format!("+VehicleGardenOpen {document_id}"))
        .env("VEHICLE_GARDEN_ROOT", root)
        .status()
        .with_context(|| format!("failed to launch {nvim}"))?;
    if !status.success() {
        return Err(anyhow!("{nvim} exited with {status}"));
    }
    Ok(())
}

#[derive(Debug)]
struct GardenFixtureOptions {
    graph_id: String,
    document_id: String,
    port: u16,
    nvim: String,
    profile_dir: Option<PathBuf>,
    no_open: bool,
    no_vim: bool,
    prepare_only: bool,
    reuse: bool,
}

#[derive(Debug, Clone)]
struct GardenFixturePaths {
    profile_dir: PathBuf,
    graph_dir: PathBuf,
    document_dir: PathBuf,
    source_json_path: PathBuf,
    ydoc_path: PathBuf,
    graph_id: String,
    document_id: String,
    title: String,
}

fn run_garden_fixture(options: GardenFixtureOptions) -> Result<()> {
    let profile_dir = options
        .profile_dir
        .unwrap_or_else(default_garden_fixture_profile_dir);
    let paths = prepare_garden_fixture(
        &profile_dir,
        &options.graph_id,
        &options.document_id,
        options.reuse,
    )?;

    if options.prepare_only {
        print_garden_fixture_paths(&paths, None);
        return Ok(());
    }

    let stop = Arc::new(AtomicBool::new(false));
    let (server_handle, url, local_addr) =
        start_garden_fixture_server(paths.clone(), options.port, stop.clone())?;

    print_garden_fixture_paths(&paths, Some(&url));
    println!("browser refreshes after :VehicleGardenSave");
    if !options.no_open
        && let Err(error) = open_url(&url)
    {
        eprintln!("warning: could not open browser: {error:#}");
    }

    if options.no_vim {
        println!("viewer is running; stop this process with Ctrl-C");
        loop {
            thread::sleep(Duration::from_secs(3600));
        }
    }

    let result = launch_garden_fixture_nvim(&options.nvim, &paths);
    stop.store(true, Ordering::Relaxed);
    let _ = TcpStream::connect(local_addr);
    let _ = server_handle.join();
    result
}

fn prepare_garden_fixture(
    profile_dir: &Path,
    graph_id: &str,
    document_id: &str,
    reuse: bool,
) -> Result<GardenFixturePaths> {
    let profile_dir = absolutize(profile_dir)?;
    let graph_dir = profile_dir.join("graphs").join(graph_id);
    if !reuse && graph_dir.exists() {
        fs::remove_dir_all(&graph_dir)
            .with_context(|| format!("remove existing fixture graph {}", graph_dir.display()))?;
    }

    let document_dir = graph_dir.join("documents").join(document_id);
    let ydoc_dir = graph_dir.join("ydocs").join("documents").join(document_id);
    let workspace_dir = graph_dir.join("ydocs").join("workspace");
    fs::create_dir_all(&document_dir)
        .with_context(|| format!("create {}", document_dir.display()))?;
    fs::create_dir_all(&ydoc_dir).with_context(|| format!("create {}", ydoc_dir.display()))?;
    fs::create_dir_all(&workspace_dir)
        .with_context(|| format!("create {}", workspace_dir.display()))?;
    fs::create_dir_all(graph_dir.join("artifacts"))
        .with_context(|| format!("create artifacts dir for {}", graph_dir.display()))?;
    fs::create_dir_all(graph_dir.join("images"))
        .with_context(|| format!("create images dir for {}", graph_dir.display()))?;
    fs::create_dir_all(graph_dir.join("indexes").join("semantic"))
        .with_context(|| format!("create semantic index dir for {}", graph_dir.display()))?;

    let now = timestamp();
    write_pretty_json(
        &profile_dir.join("profile.json"),
        &json!({
            "profileId": "default",
            "displayName": "Default Local Profile",
            "runtimeProfile": "local_only",
            "createdAt": &now,
            "updatedAt": &now,
        }),
    )?;
    write_pretty_json(
        &profile_dir.join("identity.json"),
        &json!({
            "identityKind": "local_profile",
            "profileId": "default",
            "hostedAccount": null,
            "createdAt": &now,
        }),
    )?;
    write_pretty_json(
        &graph_dir.join("graph.json"),
        &json!({
            "graphId": graph_id,
            "title": "Vehicle Garden Fixture",
            "description": "Local-only Garden profile seeded by vehicle.",
            "status": "active",
            "origin": "local",
            "providerId": "local-profile",
            "localPath": display_path(&graph_dir),
            "createdAt": &now,
            "updatedAt": &now,
            "capabilities": [
                "graph.local.open",
                "graph.local.persist",
                "graph.local.query.rdf",
                "graph.local.export.rdf",
                "document.local.persist",
                "document.local.ydoc",
                "workspace.local.ydoc"
            ],
        }),
    )?;

    let document = garden_fixture_source_document(document_id);
    let source_json_path = ydoc_dir.join("vehicle-source.json");
    let ydoc_path = ydoc_dir.join("update-v1.bin");
    write_pretty_json(&source_json_path, &document)?;
    let projection = if reuse && ydoc_path.is_file() {
        project_ydoc_path(&ydoc_path, document_id)?
    } else {
        init_ydoc_from_json_path(&source_json_path, &ydoc_path)?
    };

    let paths = GardenFixturePaths {
        profile_dir,
        graph_dir,
        document_dir,
        source_json_path,
        ydoc_path,
        graph_id: graph_id.to_string(),
        document_id: document_id.to_string(),
        title: document.title,
    };
    write_garden_fixture_document_record(&paths, &projection)?;
    write_garden_projection_sidecars(&paths, &projection)?;
    write_garden_fixture_workspace(&paths)?;
    Ok(paths)
}

fn garden_fixture_source_document(document_id: &str) -> GardenJsonDocument {
    GardenJsonDocument {
        document_id: document_id.to_string(),
        title: "Vehicle fixture document".to_string(),
        blocks: vec![
            GardenJsonBlock {
                block_id: "block-intro".to_string(),
                kind: "paragraph".to_string(),
                text: "This file lives in a Garden local-only profile as update-v1.bin."
                    .to_string(),
            },
            GardenJsonBlock {
                block_id: "block-neovim".to_string(),
                kind: "paragraph".to_string(),
                text: "Edit this line in Neovim, run :VehicleGardenSave, and watch the browser update."
                    .to_string(),
            },
            GardenJsonBlock {
                block_id: "block-boundary".to_string(),
                kind: "paragraph".to_string(),
                text: "Vehicle is only providing the fixture and bridge; the Neovim adapter still stands alone."
                    .to_string(),
            },
        ],
    }
}

fn write_garden_fixture_document_record(
    paths: &GardenFixturePaths,
    projection: &BridgeProjection,
) -> Result<()> {
    let now = timestamp();
    write_pretty_json(
        &paths.document_dir.join("document.json"),
        &json!({
            "documentId": &paths.document_id,
            "graphId": &paths.graph_id,
            "title": &paths.title,
            "revision": 0,
            "body": projection
                .lines
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
            "origin": "local",
            "providerId": "local-profile",
            "localPath": display_path(&paths.document_dir),
            "rdfSubject": format!("urn:mnemosyne:local:document:{}", paths.document_id),
            "createdAt": &now,
            "updatedAt": &now,
            "capabilities": [
                "document.local.read",
                "document.local.write",
                "document.local.materialize.rdf",
                "document.local.ydoc",
                "document.local.tiptap-tree"
            ],
            "schemaVersion": 1,
            "tiptapXml": &projection.tiptap_xml,
            "tiptapJson": &projection.tiptap_json,
            "ydocUpdateBase64": "",
            "ydocStatePath": display_path(&paths.ydoc_path),
            "tree": null,
            "blocks": garden_fixture_blocks(projection),
            "rdfTripleCount": 0,
        }),
    )
}

fn write_garden_projection_sidecars(
    paths: &GardenFixturePaths,
    projection: &BridgeProjection,
) -> Result<()> {
    let ydoc_dir = paths
        .ydoc_path
        .parent()
        .ok_or_else(|| anyhow!("Y.Doc path has no parent: {}", paths.ydoc_path.display()))?;
    fs::write(ydoc_dir.join("tiptap.xml"), &projection.tiptap_xml)
        .with_context(|| format!("write {}", ydoc_dir.join("tiptap.xml").display()))?;
    write_pretty_json(&ydoc_dir.join("tiptap.json"), &projection.tiptap_json)?;
    write_pretty_json(
        &ydoc_dir.join("blocks.json"),
        &garden_fixture_blocks(projection),
    )?;
    Ok(())
}

fn garden_fixture_blocks(projection: &BridgeProjection) -> Vec<Value> {
    projection
        .lines
        .iter()
        .enumerate()
        .map(|(order, line)| {
            json!({
                "id": &line.block_id,
                "type": &line.node_type,
                "content": &line.text,
                "parentId": null,
                "order": order,
                "level": null,
                "checked": null,
                "language": null,
                "marks": &line.marks,
            })
        })
        .collect()
}

fn write_garden_fixture_workspace(paths: &GardenFixturePaths) -> Result<()> {
    write_pretty_json(
        &paths
            .graph_dir
            .join("ydocs")
            .join("workspace")
            .join("workspace.json"),
        &json!({
            "graphId": &paths.graph_id,
            "documents": [{
                "id": &paths.document_id,
                "title": &paths.title,
                "section": "documents",
                "order": 0
            }],
            "folders": [],
            "artifacts": [],
            "wires": []
        }),
    )
}

fn start_garden_fixture_server(
    paths: GardenFixturePaths,
    port: u16,
    stop: Arc<AtomicBool>,
) -> Result<(thread::JoinHandle<()>, String, std::net::SocketAddr)> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .with_context(|| format!("bind Garden fixture viewer on 127.0.0.1:{port}"))?;
    let local_addr = listener.local_addr()?;
    listener.set_nonblocking(true)?;
    let url = format!("http://{local_addr}/");
    let handle = thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, _)) => {
                    if let Err(error) = handle_garden_fixture_connection(stream, &paths) {
                        eprintln!("warning: fixture viewer request failed: {error:#}");
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(50));
                }
                Err(error) => {
                    eprintln!("warning: fixture viewer stopped accepting requests: {error}");
                    break;
                }
            }
        }
    });
    Ok((handle, url, local_addr))
}

fn handle_garden_fixture_connection(
    mut stream: TcpStream,
    paths: &GardenFixturePaths,
) -> Result<()> {
    let mut buffer = [0_u8; 4096];
    let read = stream.read(&mut buffer)?;
    let request = String::from_utf8_lossy(&buffer[..read]);
    let first_line = request.lines().next().unwrap_or_default();
    if first_line.starts_with("GET /api/document ") {
        let projection = project_ydoc_path(&paths.ydoc_path, &paths.document_id)?;
        write_garden_projection_sidecars(paths, &projection)?;
        let body = serde_json::to_string(&json!({
            "graphId": &paths.graph_id,
            "documentId": &paths.document_id,
            "title": &paths.title,
            "profileDir": display_path(&paths.profile_dir),
            "ydocPath": display_path(&paths.ydoc_path),
            "sourceJsonPath": display_path(&paths.source_json_path),
            "updatedAt": timestamp(),
            "projection": projection,
        }))?;
        return write_http_response(stream, "200 OK", "application/json", body.as_bytes());
    }

    if first_line.starts_with("GET /favicon.ico ") {
        return write_http_response(stream, "204 No Content", "text/plain", b"");
    }

    write_http_response(
        stream,
        "200 OK",
        "text/html; charset=utf-8",
        garden_fixture_html().as_bytes(),
    )
}

fn write_http_response(
    mut stream: TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
) -> Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    Ok(())
}

fn garden_fixture_html() -> &'static str {
    r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vehicle Garden Fixture</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f5f2;
      --ink: #222522;
      --muted: #646860;
      --line: #d9d8d0;
      --panel: #ffffff;
      --accent: #176f67;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font: 15px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      padding: 18px 24px 14px;
    }
    main {
      max-width: 980px;
      margin: 0 auto;
      padding: 22px 20px 42px;
    }
    h1 {
      margin: 0 0 6px;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0;
    }
    .meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 8px 18px;
      color: var(--muted);
      font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 0 0 18px;
      color: var(--muted);
      font-size: 13px;
    }
    button {
      border: 1px solid var(--accent);
      background: var(--accent);
      color: white;
      border-radius: 6px;
      padding: 7px 11px;
      font: inherit;
      cursor: pointer;
    }
    #blocks {
      display: grid;
      gap: 10px;
    }
    .block {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px 14px;
    }
    .block-id {
      color: var(--accent);
      font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
      font-size: 12px;
      margin-bottom: 6px;
    }
    .text {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .error {
      color: #9f2f24;
      font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <header>
    <h1 id="title">Vehicle Garden Fixture</h1>
    <div class="meta">
      <div>graph: <span id="graph"></span></div>
      <div>document: <span id="document"></span></div>
      <div>ydoc: <span id="ydoc"></span></div>
    </div>
  </header>
  <main>
    <div class="toolbar">
      <button type="button" id="refresh">Refresh</button>
      <span id="status">Loading...</span>
    </div>
    <section id="blocks"></section>
  </main>
  <script>
    const title = document.getElementById("title");
    const graph = document.getElementById("graph");
    const doc = document.getElementById("document");
    const ydoc = document.getElementById("ydoc");
    const status = document.getElementById("status");
    const blocks = document.getElementById("blocks");
    const refresh = document.getElementById("refresh");

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
      })[ch]);
    }

    async function load() {
      try {
        const response = await fetch("/api/document", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        title.textContent = payload.title || "Vehicle Garden Fixture";
        graph.textContent = payload.graphId;
        doc.textContent = payload.documentId;
        ydoc.textContent = payload.ydocPath;
        blocks.innerHTML = payload.projection.lines.map((line) => `
          <article class="block">
            <div class="block-id">${escapeHtml(line.block_id)} / ${escapeHtml(line.node_type)}</div>
            <div class="text">${escapeHtml(line.text)}</div>
          </article>
        `).join("");
        status.textContent = `Updated ${new Date().toLocaleTimeString()}`;
      } catch (error) {
        status.textContent = "Viewer error";
        blocks.innerHTML = `<pre class="error">${escapeHtml(error.stack || error.message || error)}</pre>`;
      }
    }

    refresh.addEventListener("click", load);
    load();
    setInterval(load, 700);
  </script>
</body>
</html>
"#
}

fn launch_garden_fixture_nvim(nvim: &str, paths: &GardenFixturePaths) -> Result<()> {
    let plugin_root = plugin_root();
    let bridge_bin = env::current_exe()?;
    let status = Command::new(nvim)
        .arg("--cmd")
        .arg(format!("set rtp+={}", plugin_root.display()))
        .arg("+runtime plugin/vehicle.lua")
        .arg("+lua require('vehicle.garden').setup({ adapter = { kind = 'live-ydoc-file', root = vim.env.VEHICLE_GARDEN_PROFILE, path = vim.env.VEHICLE_GARDEN_YDOC, bridge = vim.env.VEHICLE_BRIDGE_BIN } })")
        .arg(format!("+VehicleGardenOpen {}", paths.document_id))
        .env("VEHICLE_GARDEN_PROFILE", &paths.profile_dir)
        .env("VEHICLE_GARDEN_YDOC", &paths.ydoc_path)
        .env("VEHICLE_BRIDGE_BIN", &bridge_bin)
        .status()
        .with_context(|| format!("failed to launch {nvim}"))?;
    if !status.success() {
        return Err(anyhow!("{nvim} exited with {status}"));
    }
    Ok(())
}

fn print_garden_fixture_paths(paths: &GardenFixturePaths, url: Option<&str>) {
    println!("Garden local fixture");
    if let Some(url) = url {
        println!("viewer: {url}");
    }
    println!("profile: {}", paths.profile_dir.display());
    println!("graph: {}", paths.graph_dir.display());
    println!("document: {}", paths.document_dir.display());
    println!("ydoc: {}", paths.ydoc_path.display());
}

fn open_url(url: &str) -> Result<()> {
    let mut command = if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        command.arg(url);
        command
    } else if cfg!(target_os = "windows") {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", url]);
        command
    } else {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    };
    let status = command.status()?;
    if !status.success() {
        return Err(anyhow!("browser opener exited with {status}"));
    }
    Ok(())
}

fn write_pretty_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let body = format!("{}\n", serde_json::to_string_pretty(value)?);
    fs::write(path, body).with_context(|| format!("write {}", path.display()))
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

fn default_garden_fixture_profile_dir() -> PathBuf {
    plugin_root().join(".tmp").join("garden-fixture-profile")
}

fn nvim_smoke(nvim: &str, root: Option<&Path>) -> Result<()> {
    if Command::new(nvim).arg("--version").output().is_err() {
        println!("SKIP: {nvim} not found; standalone vehicle.nvim smoke not run");
        return Ok(());
    }

    let _tempdir;
    let root = if let Some(root) = root {
        _tempdir = None;
        absolutize(root)?
    } else {
        let tempdir = tempfile::tempdir()?;
        let root = tempdir.path().to_path_buf();
        _tempdir = Some(tempdir);
        root
    };

    seed_demo_document(&root)?;
    let plugin_root = plugin_root();
    let status = Command::new(nvim)
        .arg("--headless")
        .arg("--clean")
        .arg("--cmd")
        .arg(format!("set rtp+={}", plugin_root.display()))
        .arg("+runtime plugin/vehicle.lua")
        .arg("+lua require('vehicle.garden').setup({ adapter = { kind = 'json-file', root = vim.env.VEHICLE_GARDEN_ROOT } })")
        .arg("+VehicleGardenOpen demo-doc")
        .arg("+call setline(2, 'Neovim headless smoke saved this Garden block.')")
        .arg("+write")
        .arg("+qall!")
        .env("VEHICLE_GARDEN_ROOT", &root)
        .status()
        .with_context(|| format!("failed to launch {nvim}"))?;
    if !status.success() {
        return Err(anyhow!("headless {nvim} smoke failed with {status}"));
    }

    let backend = FileGardenBackend::new(&root);
    let document = backend.read_document("demo-doc")?;
    let saved_line = document
        .blocks
        .iter()
        .find(|block| block.block_id == "block-neovim")
        .map(|block| block.text.as_str())
        .unwrap_or_default();
    if saved_line != "Neovim headless smoke saved this Garden block." {
        return Err(anyhow!(
            "headless {nvim} smoke exited successfully but did not save through vehicle.nvim; block-neovim={saved_line:?}"
        ));
    }
    println!("PASS: vehicle.nvim headless smoke saved demo-doc");
    Ok(())
}

fn nvim_bridge_smoke(nvim: &str) -> Result<()> {
    if Command::new(nvim).arg("--version").output().is_err() {
        println!("SKIP: {nvim} not found; bridge-backed vehicle.nvim smoke not run");
        return Ok(());
    }

    let tempdir = tempfile::tempdir()?;
    let root = tempdir.path().join("garden-docs");
    seed_demo_document(&root)?;
    let json_path = root.join("demo-doc.json");
    let ydoc_path = root.join("demo-doc.update-v1.bin");
    init_ydoc_from_json_path(&json_path, &ydoc_path)?;

    let plugin_root = plugin_root();
    let bridge_bin = env::current_exe()?;
    let status = Command::new(nvim)
        .arg("--headless")
        .arg("--clean")
        .arg("--cmd")
        .arg(format!("set rtp+={}", plugin_root.display()))
        .arg("+runtime plugin/vehicle.lua")
        .arg("+lua require('vehicle.garden').setup({ adapter = { kind = 'bridge-ydoc-file', root = vim.env.VEHICLE_GARDEN_ROOT, bridge = vim.env.VEHICLE_BRIDGE_BIN } })")
        .arg("+VehicleGardenOpen demo-doc")
        .arg("+lua local g = require('vehicle.garden'); vim.fn.setpos(\"'<\", { 0, 1, 1, 0 }); vim.fn.setpos(\"'>\", { 0, 1, 7, 0 }); local comment_id = assert(g.comment('Initial Neovim smoke comment', { explicit = true, line1 = 1, line2 = 1 })); g.edit_comment('Neovim smoke comment', comment_id); g.resolve_comment(comment_id, true); vim.api.nvim_win_set_cursor(0, { 2, 7 }); assert(g.footnote('Initial Neovim smoke footnote')); g.edit_footnote('Neovim smoke footnote', 'block-neovim', 0); local comments = g.comments(); assert(#comments == 1); vim.cmd('lclose'); local footnotes = g.footnotes(); assert(#footnotes == 1); vim.cmd('lclose'); g.tree(); local tree = table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), '\\n'); assert(tree:find('Neovim smoke comment', 1, true)); assert(tree:find('Neovim smoke footnote', 1, true)); g.tree_close()")
        .arg("+call setline(2, 'Neovim saved this block through a Garden Y.Doc update-v1 bridge.')")
        .arg("+write")
        .arg("+qall!")
        .env("VEHICLE_GARDEN_ROOT", &root)
        .env("VEHICLE_BRIDGE_BIN", &bridge_bin)
        .status()
        .with_context(|| format!("failed to launch {nvim}"))?;
    if !status.success() {
        return Err(anyhow!(
            "bridge-backed headless {nvim} smoke failed with {status}"
        ));
    }

    let projection = project_ydoc_path(&ydoc_path, "demo-doc")?;
    let saved_line = projection
        .lines
        .iter()
        .find(|line| line.block_id == "block-neovim")
        .map(|line| line.text.as_str())
        .unwrap_or_default();
    if saved_line != "Neovim saved this block through a Garden Y.Doc update-v1 bridge." {
        return Err(anyhow!(
            "bridge-backed {nvim} smoke exited successfully but did not save through update-v1; block-neovim={saved_line:?}"
        ));
    }
    let comment = projection
        .comments
        .iter()
        .find(|comment| comment.data["text"] == "Neovim smoke comment")
        .ok_or_else(|| anyhow!("bridge-backed {nvim} smoke did not persist the Garden comment"))?;
    if comment.block_id.as_deref() != Some("block-intro")
        || comment.start_utf16 != Some(0)
        || comment.end_utf16 != Some(7)
        || comment.data["resolved"] != true
    {
        return Err(anyhow!(
            "bridge-backed {nvim} smoke persisted an unexpected Garden comment: {comment:?}"
        ));
    }
    let footnote = projection
        .lines
        .iter()
        .find(|line| line.block_id == "block-neovim")
        .and_then(|line| {
            line.inline_atoms
                .iter()
                .find(|atom| atom.atom_type == "footnote")
        })
        .ok_or_else(|| anyhow!("bridge-backed {nvim} smoke did not persist the Garden footnote"))?;
    if footnote.attrs.get("content") != Some(&json!("Neovim smoke footnote")) {
        return Err(anyhow!(
            "bridge-backed {nvim} smoke persisted an unexpected Garden footnote: {footnote:?}"
        ));
    }
    println!(
        "PASS: vehicle.nvim bridge smoke saved text, comments, footnotes, location lists, and tree state through update-v1"
    );
    Ok(())
}

fn nvim_live_bridge_smoke(nvim: &str) -> Result<()> {
    if Command::new(nvim).arg("--version").output().is_err() {
        println!("SKIP: {nvim} not found; live bridge vehicle.nvim smoke not run");
        return Ok(());
    }

    let tempdir = tempfile::tempdir()?;
    let root = tempdir.path().join("garden-docs");
    seed_demo_document(&root)?;
    let json_path = root.join("demo-doc.json");
    let ydoc_path = root.join("demo-doc.update-v1.bin");
    init_ydoc_from_json_path(&json_path, &ydoc_path)?;

    let plugin_root = plugin_root();
    let bridge_bin = env::current_exe()?;
    let status = Command::new(nvim)
        .arg("--headless")
        .arg("--clean")
        .arg("--cmd")
        .arg(format!("set rtp+={}", plugin_root.display()))
        .arg("+runtime plugin/vehicle.lua")
        .arg("+lua require('vehicle.garden').setup({ adapter = { kind = 'live-ydoc-file', root = vim.env.VEHICLE_GARDEN_ROOT, bridge = vim.env.VEHICLE_BRIDGE_BIN } })")
        .arg("+VehicleGardenOpen demo-doc")
        .arg("+call setline(2, 'Neovim saved this block through a persistent live bridge.')")
        .arg("+doautocmd TextChanged")
        .arg("+sleep 300m")
        .arg("+VehicleGardenBridgeStop")
        .arg("+qall!")
        .env("VEHICLE_GARDEN_ROOT", &root)
        .env("VEHICLE_BRIDGE_BIN", &bridge_bin)
        .status()
        .with_context(|| format!("failed to launch {nvim}"))?;
    if !status.success() {
        return Err(anyhow!(
            "live bridge headless {nvim} smoke failed with {status}"
        ));
    }

    let projection = project_ydoc_path(&ydoc_path, "demo-doc")?;
    let saved_line = projection
        .lines
        .iter()
        .find(|line| line.block_id == "block-neovim")
        .map(|line| line.text.as_str())
        .unwrap_or_default();
    if saved_line != "Neovim saved this block through a persistent live bridge." {
        return Err(anyhow!(
            "live bridge {nvim} smoke exited successfully but did not save through live bridge; block-neovim={saved_line:?}"
        ));
    }
    println!("PASS: vehicle.nvim streamed demo-doc through the persistent live bridge");
    Ok(())
}

fn plugin_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn absolutize(path: &Path) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(env::current_dir()?.join(path))
    }
}

#[cfg(test)]
mod cli_tests {
    use super::*;

    #[test]
    fn ride_commands_parse_with_gardend_defaults() {
        let cli = Cli::try_parse_from([
            "vehicle",
            "room",
            "--new",
            "--graph",
            "led-badge",
            "--title",
            "board",
        ])
        .unwrap();
        let Some(Commands::Room {
            new, title, ride, ..
        }) = cli.command
        else {
            panic!("room did not parse");
        };
        assert!(new);
        assert_eq!(title.as_deref(), Some("board"));
        assert_eq!(ride.graph.as_deref(), Some("led-badge"));
        assert_eq!(ride.token_env, "VEHICLE_TOKEN");

        let cli = Cli::try_parse_from([
            "vehicle",
            "chime",
            "s-1",
            "--delivery",
            "follow-up",
            "--author",
            "Codex",
            "look",
            "here",
        ])
        .unwrap();
        let Some(Commands::Chime {
            delivery,
            text,
            author,
            ..
        }) = cli.command
        else {
            panic!("chime did not parse");
        };
        assert_eq!(Delivery::from(delivery), Delivery::FollowUp);
        assert_eq!(text.join(" "), "look here");
        assert_eq!(author.as_deref(), Some("Codex"));

        let cli = Cli::try_parse_from(["vehicle", "policy", "s-1", "co-drive"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Commands::Policy {
                policy: PolicyArg::CoDrive,
                ..
            })
        ));
        assert!(Cli::try_parse_from(["vehicle", "room", "s-1", "--new"]).is_err());
        assert!(Cli::try_parse_from(["vehicle", "policy", "s-1", "automatic"]).is_err());
    }

    #[test]
    fn a_default_author_is_a_name_the_room_accepts() {
        let author = default_author();
        assert!(!author.is_empty() && author.len() <= 64);
        assert!(
            author
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        );
    }

    #[test]
    fn room_client_ids_are_unique_to_the_process() {
        let client_id = process_client_id("room");
        assert!(client_id.starts_with(&format!("vehicle-room-{}-", std::process::id())));
        assert!(client_id.len() <= 80);
    }
}
