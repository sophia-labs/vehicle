//! A real `vehicle-host` for Vehicle's tests: `ts/packages/vehicle-host/test/faux-service.ts`, the host with
//! pi's faux provider (a scripted model: no key, no cost), behind a gardend-shaped front that authenticates a
//! bearer token, drops the caller's identity, mints gardend's and binds a graph-scoped path. The tests drive
//! it through the same client and the same `vehicle` binary a person uses against gardend.
//!
//! It needs `node` (22.19+) and the TS workspace installed (`pnpm install` in `ts/`). Without them the tests
//! say SKIPPED; with `VEHICLE_REQUIRE_HOST_TESTS=1` they fail instead.

#![allow(dead_code)]

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};
use vehicle::ride::{Credential, RideClient, RideEndpoint, RideEvent};

pub const GRAPH: &str = "test-graph";
pub const OWNER_KEY: &str = "owner-key-0123456789";
pub const MEMBER_TOKEN: &str = "member-token-0123456789";

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

pub fn faux_service_script() -> PathBuf {
    repo_root().join("ts/packages/vehicle-host/test/faux-service.ts")
}

/// Whether the real host can run here; prints why not.
pub fn host_available(test: &str) -> bool {
    let installed = repo_root()
        .join("ts/packages/vehicle-host/node_modules/@earendil-works/pi-ai")
        .exists();
    let node = Command::new("node")
        .arg("--version")
        .output()
        .is_ok_and(|output| output.status.success());
    if installed && node {
        return true;
    }
    let why = if node {
        "the TS workspace is not installed (pnpm install in ts/)"
    } else {
        "node is not on PATH"
    };
    if std::env::var("VEHICLE_REQUIRE_HOST_TESTS").as_deref() == Ok("1") {
        panic!("{test}: {why}");
    }
    eprintln!("SKIPPED {test}: {why}");
    false
}

pub struct FauxHost {
    child: Child,
    _stdin: ChildStdin,
    pub host_url: String,
    pub front_url: String,
    pub dir: tempfile::TempDir,
    pub key_file: PathBuf,
    delegating: bool,
    public: bool,
}

impl FauxHost {
    /// Start the host and its front. `stream: false` makes the front refuse event streams (501).
    pub fn start(stream: bool) -> Self {
        Self::start_with(stream, None)
    }

    /// As [`FauxHost::start`]; `cut_streams` drops every event stream that long after it opens.
    pub fn start_with(stream: bool, cut_streams: Option<Duration>) -> Self {
        Self::spawn(
            tempfile::tempdir().unwrap(),
            stream,
            cut_streams,
            false,
            false,
        )
    }

    /// The host behind a public gardend's front (public mode): a request with no bearer is a visitor,
    /// `anon:<hash of X-Visitor-Id>`, a viewer; `X-Model-Key` reaches the host.
    pub fn start_public() -> Self {
        Self::spawn(tempfile::tempdir().unwrap(), true, None, false, true)
    }

    /// The host as under a gardend with `/mcp`: a body starts only with its owner's delegation token, which
    /// the front mints on graph-scoped requests.
    pub fn start_delegating() -> Self {
        Self::spawn(tempfile::tempdir().unwrap(), true, None, true, false)
    }

    /// Stop the host and start it again on the same data dir (new ports): tokens die with it, as in gardend.
    pub fn restart(mut self) -> Self {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let dir = std::mem::replace(&mut self.dir, tempfile::tempdir().unwrap());
        let (delegating, public) = (self.delegating, self.public);
        drop(self);
        Self::spawn(dir, true, None, delegating, public)
    }

    fn spawn(
        dir: tempfile::TempDir,
        stream: bool,
        cut_streams: Option<Duration>,
        delegating: bool,
        public: bool,
    ) -> Self {
        let key_file = dir.path().join("selfhost-key.json");
        std::fs::write(
            &key_file,
            format!(r#"{{"key":"{OWNER_KEY}","createdAt":"test","note":"test"}}"#),
        )
        .unwrap();
        let tokens = serde_json::json!({
            OWNER_KEY: {"principal": "owner", "role": "owner"},
            MEMBER_TOKEN: {"principal": "token:member-1", "role": "editor"},
        });
        let mut command = Command::new("node");
        command
            .arg("--conditions=sophia-source")
            .arg(faux_service_script())
            .current_dir(repo_root().join("ts/packages/vehicle-host"))
            .env("VEHICLE_FAUX_FRONT_TOKENS", tokens.to_string())
            .env("DATA_DIR", dir.path().join("data"))
            .env_remove("PORT")
            .env_remove("MNEMOSYNE_INTERNAL_SERVICE_SECRET")
            .env_remove("GARDEN_SERVICE_ID")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        if !stream {
            command.env("VEHICLE_FAUX_FRONT_NO_SSE", "1");
        }
        if delegating {
            command.env("VEHICLE_FAUX_DELEGATION", "1");
        }
        if public {
            command.env("VEHICLE_FAUX_FRONT_PUBLIC", "1");
        }
        if let Some(cut) = cut_streams {
            command.env(
                "VEHICLE_FAUX_FRONT_CUT_STREAMS_MS",
                cut.as_millis().to_string(),
            );
        }
        let mut child = command.spawn().expect("spawn node faux-service.ts");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let mut lines = BufReader::new(stdout).lines();
            if let Some(Ok(line)) = lines.next() {
                let _ = sender.send(line);
            }
            for _ in lines {}
        });
        let ready = receiver
            .recv_timeout(Duration::from_secs(60))
            .expect("the faux service did not start");
        let ready: Value = serde_json::from_str(&ready).unwrap();
        Self {
            child,
            _stdin: stdin,
            host_url: ready["host"].as_str().unwrap().to_string(),
            front_url: ready["front"].as_str().unwrap().to_string(),
            dir,
            key_file,
            delegating,
            public,
        }
    }

    pub fn client(&self, secret: &str, graph: Option<&str>, client_id: &str) -> RideClient {
        RideClient::new(
            RideEndpoint::new(
                &self.front_url,
                graph,
                Credential::new(secret).unwrap(),
                client_id,
            )
            .unwrap(),
        )
        .unwrap()
    }

    pub fn owner(&self, client_id: &str) -> RideClient {
        self.client(OWNER_KEY, Some(GRAPH), client_id)
    }

    pub fn member(&self, client_id: &str) -> RideClient {
        self.client(MEMBER_TOKEN, None, client_id)
    }

    /// The `vehicle` binary, pointed at this host's front with the owner's key file.
    pub fn vehicle(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_vehicle"));
        command
            .args(args)
            .env("VEHICLE_GARDEND", &self.front_url)
            .env("VEHICLE_KEY_FILE", &self.key_file)
            .env_remove("VEHICLE_TOKEN")
            .env_remove("VEHICLE_GRAPH")
            .env_remove("VEHICLE_CLIENT_ID")
            .env_remove("VEHICLE_AUTHOR")
            .env_remove("VEHICLE_MODEL_KEY")
            .env_remove("VEHICLE_ANONYMOUS")
            .env_remove("VEHICLE_VISITOR_ID");
        command
    }
}

impl Drop for FauxHost {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Long-poll until an event matches (or panic after `timeout`); returns it and every event seen.
pub fn wait_for(
    client: &RideClient,
    session_id: &str,
    since: u64,
    timeout: Duration,
    predicate: impl Fn(&RideEvent) -> bool,
) -> (RideEvent, Vec<RideEvent>) {
    let deadline = Instant::now() + timeout;
    let mut cursor = since;
    let mut seen = Vec::new();
    while Instant::now() < deadline {
        let batch = client.watch(session_id, cursor, 1_000).unwrap();
        for event in batch.events {
            cursor = event.seq;
            seen.push(event.clone());
            if predicate(&event) {
                return (event, seen);
            }
        }
    }
    panic!(
        "timed out on {session_id}; saw {:?}",
        seen.iter()
            .map(|event| event.kind.as_str())
            .collect::<Vec<_>>()
    );
}

/// Write one line to a child's stdin.
pub fn send_line(stdin: &mut impl Write, line: &str) {
    stdin.write_all(line.as_bytes()).unwrap();
    stdin.write_all(b"\n").unwrap();
    stdin.flush().unwrap();
}

const ROWS: u16 = 44;
const COLS: u16 = 160;

/// A terminal a test types into and reads back, as a person would.
pub struct Tty {
    parser: Arc<Mutex<vt100::Parser>>,
    writer: Box<dyn Write + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
    _master: Box<dyn MasterPty + Send>,
    frames: Option<PathBuf>,
}

impl Tty {
    /// The `vehicle` binary in a pseudo-terminal, pointed at `gardend` (or a front) with `key_file`.
    pub fn spawn(gardend: &str, key_file: &Path, args: &[&str]) -> Self {
        let pty = native_pty_system()
            .openpty(PtySize {
                rows: ROWS,
                cols: COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new(env!("CARGO_BIN_EXE_vehicle"));
        command.args(args);
        command.env("TERM", "xterm-256color");
        command.env("VEHICLE_GARDEND", gardend);
        command.env("VEHICLE_KEY_FILE", key_file);
        command.env_remove("VEHICLE_TOKEN");
        command.env_remove("VEHICLE_CLIENT_ID");
        let child = pty.slave.spawn_command(command).unwrap();
        drop(pty.slave);
        let mut reader = pty.master.try_clone_reader().unwrap();
        let writer = pty.master.take_writer().unwrap();
        let parser = Arc::new(Mutex::new(vt100::Parser::new(ROWS, COLS, 0)));
        let sink = Arc::clone(&parser);
        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            while let Ok(read) = reader.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                sink.lock().unwrap().process(&buffer[..read]);
            }
        });
        Self {
            parser,
            writer,
            child,
            _master: pty.master,
            frames: std::env::var_os("VEHICLE_FRAMES_DIR").map(PathBuf::from),
        }
    }

    pub fn screen(&self) -> String {
        self.parser.lock().unwrap().screen().contents()
    }

    pub fn wait_for(&self, what: &str, done: impl Fn(&str) -> bool) -> String {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let screen = self.screen();
            if done(&screen) {
                return screen;
            }
            if Instant::now() > deadline {
                panic!("the room never showed {what}; the screen:\n{screen}");
            }
            thread::sleep(Duration::from_millis(40));
        }
    }

    pub fn wait_text(&self, needle: &str) -> String {
        self.wait_for(needle, |screen| screen.contains(needle))
    }

    pub fn type_keys(&mut self, keys: &str) {
        self.writer.write_all(keys.as_bytes()).unwrap();
        self.writer.flush().unwrap();
        // Let the room read a burst before the next one (it polls the terminal every 40 ms).
        thread::sleep(Duration::from_millis(120));
    }

    pub fn frame(&self, name: &str) {
        if let Some(dir) = &self.frames {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join(format!("{name}.txt")), self.screen()).unwrap();
        }
    }
}
