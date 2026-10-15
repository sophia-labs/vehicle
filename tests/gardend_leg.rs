//! The ride through a real gardend: `VEHICLE_TEST_GARDEND=<path to a gardend binary>` starts it on a
//! throwaway profile and a free port, with the faux `vehicle-host` as its service `vehicle`
//! (`GARDEN_VEHICLE_MANIFEST`). gardend authenticates the key and a member token, mints identity, binds the
//! graph and streams; the room, the chimes and the JSONL ride go through it as they would on a laptop.
//! Without the variable the test says SKIPPED.

mod support;

use serde_json::{Value, json};
use std::{
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use support::{Tty, faux_service_script, host_available, repo_root, wait_for};
use vehicle::ride::{
    ChimeRequest, CreateSession, Credential, Delivery, RideClient, RideEndpoint, StreamItem,
    is_ride_error, mint_id,
};

const GRAPH: &str = "gardend-leg";

struct Gardend {
    child: Child,
    binary: PathBuf,
    url: String,
    dir: tempfile::TempDir,
}

impl Gardend {
    fn start(binary: PathBuf) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let host_dir = repo_root().join("ts/packages/vehicle-host");
        let manifest = dir.path().join("vehicle-service.json");
        std::fs::write(
            &manifest,
            json!({
                "serviceId": "vehicle",
                "command": "node",
                "args": ["--conditions=sophia-source", faux_service_script()],
                "workingDir": host_dir,
                "healthPath": "/health",
                "proxyMount": "/services/vehicle",
                "memberAccess": "all",
            })
            .to_string(),
        )
        .unwrap();
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let mut command = Command::new(&binary);
        command
            .args(["serve", "--profile"])
            .arg(dir.path().join("profile"))
            .args(["--port", &port.to_string()])
            .env("GARDEN_VEHICLE_MANIFEST", &manifest)
            .env("GARDEN_CHOREOGRAPH_AUTOSTART", "0")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for (name, _) in std::env::vars() {
            if name.starts_with("GARDEN_") && name != "GARDEN_VEHICLE_MANIFEST" {
                command.env_remove(name);
            }
        }
        let child = command.spawn().expect("start gardend");
        let gardend = Self {
            child,
            binary,
            url: format!("http://127.0.0.1:{port}"),
            dir,
        };
        // gardend says "running" once the process starts; the host answers its health a moment later. Its health
        // through gardend's proxy is the readiness (`/self-host.json` is served only with a UI in newer gardends).
        let deadline = Instant::now() + Duration::from_secs(60);
        let http = reqwest::blocking::Client::new();
        loop {
            let healthy = Credential::from_key_file(&gardend.key_file()).is_ok_and(|key| {
                http.get(format!("{}/services/vehicle/health", gardend.url))
                    .header("authorization", key.bearer_header())
                    .send()
                    .is_ok_and(|response| response.status().is_success())
            });
            if healthy {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "gardend did not serve vehicle in time"
            );
            thread::sleep(Duration::from_millis(250));
        }
        gardend
    }

    fn profile(&self) -> PathBuf {
        self.dir.path().join("profile")
    }

    fn key_file(&self) -> PathBuf {
        self.profile().join("selfhost-key.json")
    }

    fn client(&self, credential: Credential, graph: Option<&str>, client_id: &str) -> RideClient {
        RideClient::new(RideEndpoint::new(&self.url, graph, credential, client_id).unwrap())
            .unwrap()
    }

    /// A `--grant member` token: another person (or agent) on this gardend.
    fn member_token(&self) -> Credential {
        let output = Command::new(&self.binary)
            .args([
                "token", "create", "--label", "leg", "--grant", "member", "--json",
            ])
            .arg("--profile-dir")
            .arg(self.profile())
            .output()
            .unwrap();
        assert!(output.status.success(), "token create failed");
        let created: Value = serde_json::from_slice(&output.stdout).unwrap();
        Credential::new(created["token"].as_str().unwrap()).unwrap()
    }
}

impl Drop for Gardend {
    fn drop(&mut self) {
        // SIGTERM: gardend stops its services (the faux host) before it exits.
        let _ = Command::new("kill")
            .args(["-TERM", &self.child.id().to_string()])
            .status();
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn gardend_binary(test: &str) -> Option<PathBuf> {
    if !host_available(test) {
        return None;
    }
    match std::env::var_os("VEHICLE_TEST_GARDEND") {
        Some(path) if Path::new(&path).is_file() => Some(PathBuf::from(path)),
        _ => {
            eprintln!("SKIPPED {test}: set VEHICLE_TEST_GARDEND to a gardend binary");
            None
        }
    }
}

#[test]
fn rooms_chimes_and_rides_go_through_gardend() {
    let Some(binary) = gardend_binary("rooms_chimes_and_rides_go_through_gardend") else {
        return;
    };
    let gardend = Gardend::start(binary);
    let owner_key = Credential::from_key_file(&gardend.key_file()).unwrap();
    let driver = gardend.client(owner_key.clone(), Some(GRAPH), "leg-room");

    // A session on the graph gardend binds from the path; the principal is gardend's ("owner").
    let session = driver
        .create_session(&CreateSession {
            request_id: mint_id("leg"),
            title: Some("gardend leg".to_string()),
            model: None,
            profile: None,
            claim: true,
        })
        .unwrap();
    assert_eq!(session.graph_id, GRAPH);
    let session_id = session.session_id;

    // SSE through gardend's proxy, with the live text.
    let stream = driver
        .open_stream(&session_id, 0)
        .unwrap()
        .expect("gardend streams");
    driver
        .say(&session_id, Delivery::Prompt, "through gardend")
        .unwrap();
    let mut deltas = String::new();
    for item in stream {
        match item.unwrap() {
            StreamItem::Delta(delta) => deltas.push_str(&delta),
            StreamItem::Event(event) if event.kind == "run.settled" => break,
            StreamItem::Event(_) => {}
        }
    }
    assert_eq!(deltas, "faux heard: through gardend");

    // A member chimes; gardend minted its principal, and it cannot read the owner's session.
    let member = gardend.client(gardend.member_token(), None, "codex");
    assert!(is_ride_error(
        &member.inspect(&session_id).unwrap_err(),
        "not_found"
    ));
    let pending = member
        .chime(
            &session_id,
            &ChimeRequest {
                request_id: mint_id("leg-chime"),
                author: "Codex".to_string(),
                delivery: Delivery::FollowUp,
                text: "from a member".to_string(),
            },
        )
        .unwrap();
    assert_eq!(pending.disposition, "pending");
    let waiting = driver.inspect(&session_id).unwrap().chimes;
    assert!(waiting[0].principal.starts_with("token:"), "{waiting:?}");
    let cursor = driver.inspect(&session_id).unwrap().cursor;
    driver
        .resolve_chime(&session_id, pending.chime_id.as_deref().unwrap(), true)
        .unwrap();
    wait_for(
        &driver,
        &session_id,
        cursor,
        Duration::from_secs(20),
        |event| event.kind == "run.settled",
    );
    let transcript = driver.inspect(&session_id).unwrap().transcript;
    assert_eq!(
        transcript.last().unwrap().text,
        "faux heard: [Codex collaborator]\nfrom a member"
    );
    driver
        .release(&session_id, &mint_id("leg-release"))
        .unwrap();

    // The room, in a terminal, through gardend: it claims, drives a turn, and leaves the wheel free.
    let mut room = Tty::spawn(
        &gardend.url,
        &gardend.key_file(),
        &["room", &session_id, "--client-id", "leg-tty"],
    );
    room.wait_text("driver=you");
    room.wait_text("from a member");
    room.type_keys("the room through gardend\r");
    room.wait_text("faux heard: the room through gardend");
    room.frame("08-gardend-room");
    room.type_keys("\x03");
    let deadline = Instant::now() + Duration::from_secs(10);
    while room.child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "the room did not leave");
        thread::sleep(Duration::from_millis(50));
    }
    assert!(driver.inspect(&session_id).unwrap().session.lease.is_none());
}
