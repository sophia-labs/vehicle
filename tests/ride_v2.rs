//! Vehicle's ride v2 client and commands against a real `vehicle-host` (pi's faux model) behind a
//! gardend-shaped front: sessions, the stream, steer and abort, the lease, chimes under each room policy,
//! the long-poll fallback, and the JSONL ride an agent uses.

mod support;

use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    process::Stdio,
    time::{Duration, Instant},
};
use support::{FauxHost, GRAPH, MEMBER_TOKEN, OWNER_KEY, host_available, send_line, wait_for};
use vehicle::ride::{
    ChimeRequest, CreateSession, Delivery, StreamItem, WatchMode, WatchMsg, Watcher, is_ride_error,
    mint_id, ride_error, short_session_id,
};

const LONG: Duration = Duration::from_secs(20);

fn new_session(client: &vehicle::ride::RideClient) -> String {
    client
        .create_session(&CreateSession {
            request_id: mint_id("test-new"),
            title: None,
            model: None,
            profile: None,
            claim: true,
        })
        .unwrap()
        .session_id
}

fn chime(author: &str, delivery: Delivery, text: &str) -> ChimeRequest {
    ChimeRequest {
        request_id: mint_id("test-chime"),
        author: author.to_string(),
        delivery,
        text: text.to_string(),
    }
}

#[test]
fn a_new_session_streams_a_turn_through_gardends_shape() {
    if !host_available("a_new_session_streams_a_turn_through_gardends_shape") {
        return;
    }
    let host = FauxHost::start(true);
    let driver = host.owner("room-1");
    let session_id = new_session(&driver);

    let listed = driver.list_sessions().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].session_id, session_id);
    assert_eq!(listed[0].graph_id, GRAPH, "the graph came from the path");
    assert_eq!(
        listed[0]
            .lease
            .as_ref()
            .map(|lease| lease.client_id.as_str()),
        Some("room-1")
    );
    assert_eq!(listed[0].room_policy, "suggest");

    let stream = driver
        .open_stream(&session_id, 0)
        .unwrap()
        .expect("the front streams");
    let accepted = driver
        .say(&session_id, Delivery::Prompt, "hello there")
        .unwrap();
    assert_eq!(accepted["value"]["command"]["disposition"], "started");

    let mut deltas = String::new();
    let mut answer = None;
    let mut last_seq = 0;
    for item in stream {
        match item.unwrap() {
            StreamItem::Delta(delta) => deltas.push_str(&delta),
            StreamItem::Event(event) => {
                assert!(event.seq > last_seq, "events arrive once, in order");
                last_seq = event.seq;
                if event.kind == "message.completed" && event.payload["role"] == "assistant" {
                    answer = event.payload["text"].as_str().map(str::to_string);
                }
                if event.kind == "run.settled" {
                    break;
                }
            }
        }
    }
    assert_eq!(answer.as_deref(), Some("faux heard: hello there"));
    assert_eq!(
        deltas, "faux heard: hello there",
        "the text streamed as deltas"
    );

    let snapshot = driver.inspect(&session_id).unwrap();
    let said: Vec<(&str, &str)> = snapshot
        .transcript
        .iter()
        .map(|item| (item.role.as_str(), item.text.as_str()))
        .collect();
    assert_eq!(
        said,
        vec![
            ("user", "hello there"),
            ("assistant", "faux heard: hello there")
        ]
    );
    assert_eq!(snapshot.session.preview.as_deref(), Some("hello there"));
}

#[test]
fn steer_lands_inside_the_run_and_abort_stops_it() {
    if !host_available("steer_lands_inside_the_run_and_abort_stops_it") {
        return;
    }
    let host = FauxHost::start(true);
    let driver = host.owner("room-1");
    let session_id = new_session(&driver);

    driver
        .say(&session_id, Delivery::Prompt, "[slow 1500] a long task")
        .unwrap();
    let (started, _) = wait_for(&driver, &session_id, 0, LONG, |event| {
        event.kind == "run.started"
    });
    let steer = driver
        .say(&session_id, Delivery::Steer, "only the power parts")
        .unwrap();
    assert_eq!(steer["value"]["command"]["status"], "queued");
    wait_for(&driver, &session_id, started.seq, LONG, |event| {
        event.kind == "run.settled"
    });
    let snapshot = driver.inspect(&session_id).unwrap();
    let run_of = |op: &str| {
        snapshot
            .commands
            .iter()
            .find(|command| command.op == op)
            .and_then(|command| command.run_id.clone())
    };
    assert_eq!(
        run_of("steer"),
        run_of("prompt"),
        "the steer was delivered inside the running run"
    );
    let answers: Vec<&str> = snapshot
        .transcript
        .iter()
        .filter(|item| item.role == "assistant")
        .map(|item| item.text.as_str())
        .collect();
    assert_eq!(
        answers,
        vec![
            "faux heard: [slow 1500] a long task",
            "faux heard: only the power parts"
        ]
    );

    let cursor = snapshot.cursor;
    driver
        .say(&session_id, Delivery::Prompt, "[hold] wait for me")
        .unwrap();
    wait_for(&driver, &session_id, cursor, LONG, |event| {
        event.kind == "run.started"
    });
    let aborted = driver.abort(&session_id).unwrap();
    assert_eq!(aborted["value"]["command"]["result"]["abortedRun"], true);
    let (settled, _) = wait_for(&driver, &session_id, cursor, LONG, |event| {
        event.kind == "run.settled"
    });
    assert_eq!(settled.payload["aborted"], true);
}

#[test]
fn one_driver_at_a_time() {
    if !host_available("one_driver_at_a_time") {
        return;
    }
    let host = FauxHost::start(true);
    let room = host.owner("room-1");
    let other_terminal = host.owner("terminal-2");
    let session_id = new_session(&room);

    let refused = other_terminal
        .say(&session_id, Delivery::Prompt, "let me drive")
        .unwrap_err();
    let refusal = ride_error(&refused).expect("a ride refusal");
    assert_eq!(refusal.code, "lease_held");
    assert_eq!(
        refusal.details.as_ref().unwrap()["holder"]["clientId"],
        "room-1"
    );
    assert!(is_ride_error(
        &other_terminal
            .claim(&session_id, &mint_id("claim"))
            .unwrap_err(),
        "lease_held"
    ));
    room.release(&session_id, &mint_id("release")).unwrap();
    other_terminal
        .claim(&session_id, &mint_id("claim"))
        .unwrap();
    assert!(is_ride_error(
        &room
            .say(&session_id, Delivery::Prompt, "mine?")
            .unwrap_err(),
        "lease_held"
    ));
    // Another principal cannot even read it.
    assert!(is_ride_error(
        &host.member("m").inspect(&session_id).unwrap_err(),
        "not_found"
    ));
}

#[test]
fn chimes_go_where_the_room_policy_says() {
    if !host_available("chimes_go_where_the_room_policy_says") {
        return;
    }
    let host = FauxHost::start(true);
    let driver = host.owner("room-1");
    let collaborator = host.member("codex-1");
    let session_id = new_session(&driver);

    // suggest (the default): held for the driver, who accepts it.
    let pending = collaborator
        .chime(
            &session_id,
            &chime("Codex", Delivery::Prompt, "check the fence first"),
        )
        .unwrap();
    assert_eq!(pending.disposition, "pending");
    assert_eq!(pending.policy.as_deref(), Some("suggest"));
    let snapshot = driver.inspect(&session_id).unwrap();
    assert_eq!(snapshot.chimes.len(), 1);
    assert_eq!(snapshot.chimes[0].author, "Codex");
    assert_eq!(snapshot.chimes[0].principal, "token:member-1");
    assert_eq!(snapshot.chimes[0].text, "check the fence first");
    let chime_id = pending.chime_id.unwrap();
    assert!(
        is_ride_error(
            &collaborator
                .resolve_chime(&session_id, &chime_id, true)
                .unwrap_err(),
            "not_found"
        ),
        "a collaborator cannot accept its own chime"
    );
    driver.resolve_chime(&session_id, &chime_id, true).unwrap();
    wait_for(&driver, &session_id, 0, LONG, |event| {
        event.kind == "run.settled"
    });
    let snapshot = driver.inspect(&session_id).unwrap();
    assert!(snapshot.chimes.is_empty());
    assert_eq!(
        snapshot.transcript[0].text, "[Codex collaborator]\ncheck the fence first",
        "the collaborator is named, never the driver"
    );
    assert_eq!(
        snapshot.transcript[1].text,
        "faux heard: [Codex collaborator]\ncheck the fence first"
    );

    // suggest, rejected: nothing reaches the model.
    let second = collaborator
        .chime(&session_id, &chime("Codex", Delivery::Steer, "ignore me"))
        .unwrap();
    driver
        .resolve_chime(&session_id, second.chime_id.as_deref().unwrap(), false)
        .unwrap();
    let cursor = driver.inspect(&session_id).unwrap().cursor;

    // co-drive: delivered at once, under the driver's lease.
    driver.set_room_policy(&session_id, "co-drive").unwrap();
    let submitted = collaborator
        .chime(
            &session_id,
            &chime("Codex", Delivery::FollowUp, "and the charger?"),
        )
        .unwrap();
    assert_eq!(submitted.disposition, "submitted");
    assert!(submitted.command_id.is_some());
    wait_for(&driver, &session_id, cursor, LONG, |event| {
        event.kind == "run.settled"
    });

    // mute and observe: refused.
    for policy in ["mute", "observe"] {
        driver.set_room_policy(&session_id, policy).unwrap();
        let refused = collaborator
            .chime(&session_id, &chime("Codex", Delivery::Prompt, "hello?"))
            .unwrap();
        assert_eq!(refused.disposition, "rejected", "{policy}");
        assert_eq!(refused.policy.as_deref(), Some(policy));
    }
    let users: Vec<String> = driver
        .inspect(&session_id)
        .unwrap()
        .transcript
        .iter()
        .filter(|item| item.role == "user")
        .map(|item| item.text.clone())
        .collect();
    assert_eq!(
        users,
        vec![
            "[Codex collaborator]\ncheck the fence first",
            "[Codex collaborator]\nand the charger?"
        ]
    );
    // Only the driver sets the policy.
    assert!(
        collaborator
            .set_room_policy(&session_id, "co-drive")
            .is_err()
    );
}

#[test]
fn the_watcher_streams_and_falls_back_to_long_poll() {
    if !host_available("the_watcher_streams_and_falls_back_to_long_poll") {
        return;
    }
    for stream in [true, false] {
        let host = FauxHost::start(stream);
        let driver = host.owner("room-1");
        let session_id = new_session(&driver);
        if !stream {
            assert!(
                driver.open_stream(&session_id, 0).unwrap().is_none(),
                "the front refuses streams"
            );
        }
        let watcher = Watcher::start(driver.clone(), session_id.clone(), 0, WatchMode::Stream);
        driver
            .say(&session_id, Delivery::Prompt, "are you there")
            .unwrap();
        let deadline = Instant::now() + LONG;
        let mut modes = Vec::new();
        let mut seqs = Vec::new();
        let mut deltas = 0;
        while Instant::now() < deadline {
            match watcher.messages.recv_timeout(Duration::from_secs(1)) {
                Ok(WatchMsg::Mode(mode)) => modes.push(mode),
                Ok(WatchMsg::Delta(_)) => deltas += 1,
                Ok(WatchMsg::Event(event)) => {
                    seqs.push(event.seq);
                    if event.kind == "run.settled" {
                        break;
                    }
                }
                Ok(WatchMsg::Problem(problem)) => panic!("{problem}"),
                Err(_) => {}
            }
        }
        let expected: Vec<u64> = (1..=seqs.len() as u64).collect();
        assert_eq!(seqs, expected, "every event once, in order, from 1");
        if stream {
            assert_eq!(modes, vec![WatchMode::Stream]);
            assert!(deltas > 0, "live text over SSE");
        } else {
            assert_eq!(modes, vec![WatchMode::Poll]);
            assert_eq!(deltas, 0, "long-poll carries no deltas");
        }
    }
}

#[test]
fn a_dropped_stream_resumes_from_its_cursor_with_no_gap_and_no_repeat() {
    if !host_available("a_dropped_stream_resumes_from_its_cursor_with_no_gap_and_no_repeat") {
        return;
    }
    // Every event stream is cut 300 ms after it opens; the turns take longer than that.
    let host = FauxHost::start_with(true, Some(Duration::from_millis(300)));
    let driver = host.owner("room-1");
    let session_id = new_session(&driver);
    let watcher = Watcher::start(driver.clone(), session_id.clone(), 0, WatchMode::Stream);
    let mut seqs = Vec::new();
    let mut settled = 0;
    let deadline = Instant::now() + LONG;
    driver
        .say(&session_id, Delivery::Prompt, "[slow 900] first")
        .unwrap();
    while settled < 2 && Instant::now() < deadline {
        if let Ok(WatchMsg::Event(event)) = watcher.messages.recv_timeout(Duration::from_secs(1)) {
            seqs.push(event.seq);
            if event.kind == "run.settled" {
                settled += 1;
                if settled == 1 {
                    driver
                        .say(&session_id, Delivery::Prompt, "[slow 900] second")
                        .unwrap();
                }
            }
        }
    }
    assert_eq!(settled, 2, "both runs were seen to the end");
    let expected: Vec<u64> = (1..=seqs.len() as u64).collect();
    assert_eq!(
        seqs, expected,
        "across the cuts: every event once, in order"
    );
}

#[test]
fn the_cli_lists_chimes_and_sets_the_policy() {
    if !host_available("the_cli_lists_chimes_and_sets_the_policy") {
        return;
    }
    let host = FauxHost::start(true);
    let driver = host.owner("room-1");
    let session_id = new_session(&driver);

    let listed = host.vehicle(&["sessions", "--json"]).output().unwrap();
    assert!(listed.status.success(), "{listed:?}");
    let listed: Value = serde_json::from_slice(&listed.stdout).unwrap();
    assert_eq!(listed[0]["sessionId"], session_id.as_str());

    let pending = host
        .vehicle(&[
            "chime",
            &session_id,
            "--author",
            "Codex",
            "--delivery",
            "steer",
            "look",
            "here",
        ])
        .output()
        .unwrap();
    assert!(pending.status.success(), "{pending:?}");
    let said = String::from_utf8_lossy(&pending.stdout);
    assert!(said.starts_with("pending chime-"), "{said}");
    assert_eq!(
        driver.inspect(&session_id).unwrap().chimes[0].delivery,
        "steer"
    );

    // The room (room-1) drives: another client cannot set the policy...
    let refused = host
        .vehicle(&["policy", &session_id, "mute"])
        .output()
        .unwrap();
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("type /policy in its room"));
    // ...but the room's own client id can.
    let shared = host
        .vehicle(&["policy", &session_id, "mute", "--client-id", "room-1"])
        .output()
        .unwrap();
    assert!(shared.status.success(), "{shared:?}");
    let muted = host
        .vehicle(&["chime", &session_id, "--author", "Codex", "hello?"])
        .output()
        .unwrap();
    assert!(!muted.status.success(), "a refused chime fails");
    assert!(String::from_utf8_lossy(&muted.stderr).contains("the room is muted"));

    // Nobody drives: the CLI claims, sets and lets go.
    driver.release(&session_id, &mint_id("release")).unwrap();
    let alone = host
        .vehicle(&["policy", &session_id, "co-drive"])
        .output()
        .unwrap();
    assert!(alone.status.success(), "{alone:?}");
    let session = driver.inspect(&session_id).unwrap().session;
    assert_eq!(session.room_policy, "co-drive");
    assert!(session.lease.is_none(), "the CLI gave the wheel back");

    // A wrong key is gardend's refusal, said plainly.
    let wrong = host
        .vehicle(&["sessions"])
        .env("VEHICLE_TOKEN", "not-a-token")
        .output()
        .unwrap();
    assert!(!wrong.status.success());
    assert!(String::from_utf8_lossy(&wrong.stderr).contains("gardend refused the credential"));
}

#[test]
fn an_agent_rides_over_jsonl() {
    if !host_available("an_agent_rides_over_jsonl") {
        return;
    }
    let host = FauxHost::start(true);
    let mut ride = host
        .vehicle(&["ride", "--new", "--graph", GRAPH, "--client-id", "agent-7"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = ride.stdin.take().unwrap();
    let mut frames = BufReader::new(ride.stdout.take().unwrap()).lines();
    let mut next = || -> Value { serde_json::from_str(&frames.next().unwrap().unwrap()).unwrap() };

    let ready = next();
    assert_eq!(ready["protocol"], "sophia.vehicle-ride.v2");
    assert_eq!(ready["type"], "ready");
    assert_eq!(ready["claimed"], true);
    assert_eq!(ready["session"]["lease"]["clientId"], "agent-7");
    let session_id = ready["session"]["sessionId"].as_str().unwrap().to_string();

    send_line(
        &mut stdin,
        r#"{"op":"prompt","requestId":"r1","text":"inspect the failing test"}"#,
    );
    let accepted = next();
    assert_eq!(accepted["type"], "command.accepted");
    assert_eq!(accepted["requestId"], "r1");

    let mut settled = false;
    for round in 0..20 {
        send_line(
            &mut stdin,
            &json!({"op": "watch", "requestId": format!("w{round}"), "waitMs": 2000}).to_string(),
        );
        let batch = next();
        assert_eq!(batch["type"], "watch.completed");
        let events = batch["value"]["events"].as_array().unwrap();
        if events.iter().any(|event| event["type"] == "run.settled") {
            settled = true;
            break;
        }
    }
    assert!(settled, "the run settled within the watches");

    send_line(&mut stdin, r#"{"op":"inspect","requestId":"i1"}"#);
    let snapshot = next();
    assert_eq!(snapshot["type"], "session.snapshot");
    assert_eq!(snapshot["requestId"], "i1");
    assert_eq!(
        snapshot["value"]["transcript"][1]["text"],
        "faux heard: inspect the failing test"
    );

    send_line(&mut stdin, r#"{"op":"capsule","requestId":"c1"}"#);
    let capsule = next();
    assert_eq!(capsule["type"], "session.capsule");
    assert_eq!(capsule["value"]["authority"]["mutations"], false);

    send_line(&mut stdin, r#"{"op":"steer","requestId":"bad"}"#);
    let refused = next();
    assert_eq!(refused["type"], "error");
    assert_eq!(refused["requestId"], "bad");
    send_line(&mut stdin, r#"{"op":"prompt"}"#);
    assert_eq!(next()["code"], "invalid_request");
    send_line(&mut stdin, "not json");
    assert_eq!(next()["code"], "invalid_json");

    drop(stdin);
    let closed = next();
    assert_eq!(closed["type"], "closed");
    assert_eq!(closed["reason"], "stdin_closed");
    assert!(ride.wait().unwrap().success());
    let lease = host
        .owner("observer")
        .inspect(&session_id)
        .unwrap()
        .session
        .lease;
    assert!(lease.is_none(), "the ride gave the lease back at the end");
}

#[test]
fn a_ride_opened_by_id_binds_the_sessions_graph_so_its_tools_get_a_token() {
    if !host_available("a_ride_opened_by_id_binds_the_sessions_graph_so_its_tools_get_a_token") {
        return;
    }
    let host = FauxHost::start_delegating();
    let driver = host.owner("room-1");
    let session_id = new_session(&driver);
    driver
        .say(&session_id, Delivery::Prompt, "before the restart")
        .unwrap();
    wait_for(&driver, &session_id, 0, LONG, |event| {
        event.kind == "run.settled"
    });
    driver.release(&session_id, &mint_id("release")).unwrap();

    // The host restarts: the delegation token died with it. Unbound, gardend hands none.
    let host = host.restart();
    let unbound = host.client(OWNER_KEY, None, "terminal-2");
    unbound.claim(&session_id, &mint_id("claim")).unwrap();
    let refused = unbound
        .say(&session_id, Delivery::Prompt, "unbound")
        .unwrap_err();
    assert!(
        is_ride_error(&refused, "delegation_required"),
        "{refused:#}"
    );
    unbound.release(&session_id, &mint_id("release")).unwrap();

    // The ride, opened by id without --graph, binds the session's graph and drives it.
    let mut ride = host
        .vehicle(&["ride", "--session", &session_id, "--client-id", "agent-7"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = ride.stdin.take().unwrap();
    let mut frames = BufReader::new(ride.stdout.take().unwrap()).lines();
    let mut next = || -> Value { serde_json::from_str(&frames.next().unwrap().unwrap()).unwrap() };
    let ready = next();
    assert_eq!(ready["claimed"], true, "{ready}");
    let mut cursor = ready["cursor"].as_u64().unwrap();
    send_line(
        &mut stdin,
        r#"{"op":"prompt","requestId":"r1","text":"after the restart"}"#,
    );
    let accepted = next();
    assert_eq!(accepted["type"], "command.accepted", "{accepted}");
    let mut settled = false;
    for round in 0..20 {
        send_line(
            &mut stdin,
            &json!({"op": "watch", "requestId": format!("w{round}"), "since": cursor, "waitMs": 2000})
                .to_string(),
        );
        let batch = next();
        // Follow the cursor, so each watch waits for what is new (a fixed cursor answers at once, every time).
        cursor = batch["value"]["cursor"].as_u64().unwrap_or(cursor);
        if batch["value"]["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["type"] == "run.settled")
        {
            settled = true;
            break;
        }
    }
    assert!(settled);
    drop(stdin);
    assert_eq!(next()["type"], "closed");
    assert!(ride.wait().unwrap().success());
    let transcript = host
        .owner("observer")
        .inspect(&session_id)
        .unwrap()
        .transcript;
    assert_eq!(
        transcript.last().unwrap().text,
        "faux heard: after the restart"
    );
}

#[test]
fn an_agent_session_runs_its_shell_in_a_box() {
    if !host_available("an_agent_session_runs_its_shell_in_a_box") {
        return;
    }
    let host = FauxHost::start(true);
    // The host's data dir, beside this session's own folders: hidden (seatbelt) or a read-only tmpfs (bwrap) in the
    // box. (Not /tmp: on Linux that is the box's own private tmpfs.)
    let outside = host
        .dir
        .path()
        .join("data")
        .join("sessions")
        .join("outside-the-box.txt");
    let mut ride = host
        .vehicle(&[
            "ride",
            "--new",
            "--graph",
            GRAPH,
            "--profile",
            "agent",
            "--client-id",
            "agent-box",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = ride.stdin.take().unwrap();
    let mut frames = BufReader::new(ride.stdout.take().unwrap()).lines();
    let mut next = || -> Value { serde_json::from_str(&frames.next().unwrap().unwrap()).unwrap() };

    let ready = next();
    assert_eq!(ready["type"], "ready", "{ready}");
    assert_eq!(ready["session"]["profile"], "agent");
    let expected_box = if cfg!(target_os = "macos") {
        "seatbelt"
    } else {
        "bwrap"
    };
    assert_eq!(ready["session"]["isolation"], expected_box);

    let script = format!(
        "[tool bash {}] [tool bash {}]",
        json!({"command": "echo from-the-box > note.txt && cat note.txt"}),
        json!({"command": format!("echo escaped > '{}' && echo WROTE || echo REFUSED", outside.display())}),
    );
    send_line(
        &mut stdin,
        &json!({"op": "prompt", "requestId": "r1", "text": script}).to_string(),
    );
    assert_eq!(next()["type"], "command.accepted");
    let mut results = Vec::new();
    let mut since = 0;
    for round in 0..30 {
        send_line(
            &mut stdin,
            &json!({"op": "watch", "requestId": format!("w{round}"), "since": since, "waitMs": 2000}).to_string(),
        );
        let batch = next();
        let events = batch["value"]["events"].as_array().unwrap().clone();
        since = batch["value"]["cursor"].as_u64().unwrap_or(since);
        for event in &events {
            if event["type"] == "tool.result" {
                results.push(event["payload"]["text"].as_str().unwrap_or("").to_string());
            }
        }
        if events.iter().any(|event| event["type"] == "run.settled") {
            break;
        }
    }
    assert_eq!(results.len(), 2, "{results:?}");
    assert!(results[0].contains("from-the-box"), "{}", results[0]);
    assert!(results[1].contains("REFUSED"), "{}", results[1]);
    assert!(
        !outside.exists(),
        "a write outside the box reached the host"
    );
    drop(stdin);
    assert_eq!(next()["type"], "closed");
    assert!(ride.wait().unwrap().success());

    // A member is not the graph's owner: no agent session for them.
    let member = host.client(MEMBER_TOKEN, Some(GRAPH), "member-box");
    let refused = member.create_session(&CreateSession {
        request_id: mint_id("member-agent"),
        title: None,
        model: None,
        profile: Some("agent".to_string()),
        claim: true,
    });
    let error = format!("{:#}", refused.unwrap_err());
    assert!(
        error.contains("forbidden_profile") || error.contains("owner"),
        "{error}"
    );
}

#[test]
fn an_agent_renames_and_deletes_over_jsonl() {
    if !host_available("an_agent_renames_and_deletes_over_jsonl") {
        return;
    }
    let host = FauxHost::start(true);
    let mut ride = host
        .vehicle(&["ride", "--new", "--graph", GRAPH, "--client-id", "agent-8"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = ride.stdin.take().unwrap();
    let mut frames = BufReader::new(ride.stdout.take().unwrap()).lines();
    let mut next = || -> Value { serde_json::from_str(&frames.next().unwrap().unwrap()).unwrap() };
    let session_id = next()["session"]["sessionId"].as_str().unwrap().to_string();

    send_line(
        &mut stdin,
        r#"{"op":"rename","requestId":"n1","title":"named by an agent"}"#,
    );
    let renamed = next();
    assert_eq!(renamed["type"], "session.renamed", "{renamed}");
    let observer = host.owner("observer");
    assert_eq!(
        observer
            .inspect(&session_id)
            .unwrap()
            .session
            .title
            .as_deref(),
        Some("named by an agent")
    );

    send_line(&mut stdin, r#"{"op":"delete","requestId":"d1"}"#);
    let deleted = next();
    assert_eq!(deleted["type"], "session.deleted", "{deleted}");
    assert_eq!(deleted["requestId"], "d1");
    let closed = next();
    assert_eq!(closed["type"], "closed");
    assert_eq!(closed["reason"], "deleted");
    assert!(ride.wait().unwrap().success());
    assert!(is_ride_error(
        &observer.inspect(&session_id).unwrap_err(),
        "not_found"
    ));
}

/// Say `text` as the driver and wait for its run to settle.
fn turn(client: &vehicle::ride::RideClient, session_id: &str, text: &str) {
    let mark = client
        .watch(session_id, 0, 0)
        .unwrap()
        .events
        .last()
        .map_or(0, |event| event.seq);
    client.say(session_id, Delivery::Prompt, text).unwrap();
    wait_for(client, session_id, mark, LONG, |event| {
        event.kind == "run.settled"
    });
}

fn said(client: &vehicle::ride::RideClient, session_id: &str) -> Vec<String> {
    client
        .inspect(session_id)
        .unwrap()
        .transcript
        .iter()
        .map(|item| item.text.clone())
        .collect()
}

#[test]
fn the_cli_branches_and_duplicates_a_session_and_lists_its_lineage() {
    if !host_available("the_cli_branches_and_duplicates_a_session_and_lists_its_lineage") {
        return;
    }
    let host = FauxHost::start(true);
    let driver = host.owner("room-1");
    let source = new_session(&driver);
    turn(&driver, &source, "first question");
    turn(&driver, &source, "second question");
    let transcript = driver.inspect(&source).unwrap().transcript;
    let users: Vec<_> = transcript
        .iter()
        .filter(|item| item.role == "user")
        .collect();
    assert_eq!(users.len(), 2);

    // A branch before message 2, by number, as the person sees it; no --graph: the CLI binds the session's.
    let branched = host
        .vehicle(&["branch", &source, "--before", "2"])
        .output()
        .unwrap();
    assert!(branched.status.success(), "{branched:?}");
    let out = String::from_utf8_lossy(&branched.stdout).to_string();
    let mut lines = out.lines();
    let first = lines.next().unwrap();
    assert!(
        first.starts_with("branched ")
            && first.ends_with(&format!(
                "from \"first question\" ({}) before message 2",
                short_session_id(&source)
            )),
        "{out}"
    );
    let branch = first.split_whitespace().nth(1).unwrap().to_string();
    assert_eq!(lines.next(), Some("  > second question"), "{out}");
    assert_eq!(
        lines.next(),
        Some(
            format!("continue it: vehicle room {branch} (edit that message there and send it)")
                .as_str()
        )
    );

    // The branch holds the history before that message; it is its own conversation, and its wheel is free.
    let snapshot = driver.inspect(&branch).unwrap();
    assert_eq!(
        said(&driver, &branch),
        vec!["first question", "faux heard: first question"]
    );
    let parent = snapshot
        .session
        .parent_ref()
        .expect("a branch names its source");
    assert_eq!(parent.session_id, source);
    assert_eq!(parent.kind, "fork");
    assert_eq!(parent.entry_id.as_deref(), Some(users[1].entry_id.as_str()));
    assert!(
        snapshot.session.lease.is_none(),
        "a one-off command gives the branch's wheel back"
    );
    assert_eq!(snapshot.session.graph_id, GRAPH);
    // Another client drives it: a different second question, answered in the branch only.
    let elsewhere = host.owner("room-2");
    elsewhere.claim(&branch, &mint_id("claim")).unwrap();
    turn(&elsewhere, &branch, "another second question");
    assert_eq!(
        said(&driver, &branch),
        vec![
            "first question",
            "faux heard: first question",
            "another second question",
            "faux heard: another second question"
        ]
    );
    assert_eq!(
        said(&driver, &source),
        vec![
            "first question",
            "faux heard: first question",
            "second question",
            "faux heard: second question"
        ],
        "the source is untouched"
    );

    // By the message's id, as JSON; with --client-id that client keeps the new wheel.
    let by_id = host
        .vehicle(&[
            "branch",
            &source,
            "--before",
            &users[0].entry_id,
            "--json",
            "--client-id",
            "room-3",
        ])
        .output()
        .unwrap();
    assert!(by_id.status.success(), "{by_id:?}");
    let by_id: Value = serde_json::from_slice(&by_id.stdout).unwrap();
    assert_eq!(by_id["kind"], "fork");
    assert_eq!(by_id["before"]["number"], 1);
    assert_eq!(by_id["selectedText"], "first question");
    assert_eq!(by_id["leaseKept"], true);
    let early = by_id["sessionId"].as_str().unwrap().to_string();
    assert!(
        said(&driver, &early).is_empty(),
        "before the first message: nothing yet"
    );
    assert_eq!(
        driver
            .inspect(&early)
            .unwrap()
            .session
            .lease
            .map(|lease| lease.client_id),
        Some("room-3".to_string())
    );

    // A message that is not there is said plainly.
    let missing = host
        .vehicle(&["branch", &source, "--before", "9"])
        .output()
        .unwrap();
    assert!(!missing.status.success());
    assert!(
        String::from_utf8_lossy(&missing.stderr)
            .contains("there is no message 9: this session has 2"),
        "{missing:?}"
    );

    // Duplicate: the whole history, "Copy of" its source.
    let copied = host
        .vehicle(&["duplicate", &source, "--json"])
        .output()
        .unwrap();
    assert!(copied.status.success(), "{copied:?}");
    let copied: Value = serde_json::from_slice(&copied.stdout).unwrap();
    assert_eq!(copied["kind"], "clone");
    let copy = copied["sessionId"].as_str().unwrap().to_string();
    assert_eq!(copied["session"]["title"], "Copy of first question");
    assert_eq!(said(&driver, &copy), said(&driver, &source));
    assert_eq!(
        driver
            .inspect(&copy)
            .unwrap()
            .session
            .parent_ref()
            .unwrap()
            .kind,
        "clone"
    );
    let plain = host.vehicle(&["duplicate", &copy]).output().unwrap();
    assert!(plain.status.success(), "{plain:?}");
    assert!(
        String::from_utf8_lossy(&plain.stdout).starts_with("duplicated "),
        "{plain:?}"
    );

    // `vehicle sessions` shows where each came from.
    let listed = host.vehicle(&["sessions"]).output().unwrap();
    assert!(listed.status.success(), "{listed:?}");
    let listed = String::from_utf8_lossy(&listed.stdout).to_string();
    let short = short_session_id(&source);
    assert_eq!(
        listed
            .matches(&format!("↳ branched from \"first question\" ({short})"))
            .count(),
        2,
        "{listed}"
    );
    assert!(
        listed.contains(&format!("↳ duplicated from \"first question\" ({short})")),
        "{listed}"
    );
    assert!(
        listed.contains(&format!(
            "↳ duplicated from \"Copy of first question\" ({})",
            short_session_id(&copy)
        )),
        "{listed}"
    );

    // Once the source is deleted, its branches say so.
    driver
        .exchange(
            reqwest::Method::DELETE,
            &format!("/sessions/{source}"),
            None,
        )
        .unwrap();
    let after = host.vehicle(&["sessions"]).output().unwrap();
    let after = String::from_utf8_lossy(&after.stdout).to_string();
    assert_eq!(
        after
            .matches("↳ branched from a deleted conversation")
            .count(),
        2,
        "{after}"
    );
    assert!(
        after.contains("↳ duplicated from a deleted conversation"),
        "{after}"
    );
}

/// An agent given only a public Sophia's address: as a visitor (no credential, its own visitor id), refused
/// without a model key with both doors named; with its own key (from the environment, never the command line)
/// it creates a session, asks, and comes back to it in a second ride; another visitor never sees it.
#[test]
fn an_anonymous_agent_rides_a_public_sophia_on_its_own_key() {
    if !host_available("an_anonymous_agent_rides_a_public_sophia_on_its_own_key") {
        return;
    }
    let host = FauxHost::start_public();
    let visitor = "agent-visitor-0123456789abcdef";
    let ride = |args: &[&str], key: Option<&str>| {
        let mut command = host.vehicle(args);
        command
            .env_remove("VEHICLE_KEY_FILE")
            .args(["--anonymous", "--visitor-id", visitor])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        if let Some(key) = key {
            command.env("VEHICLE_MODEL_KEY", key);
        }
        command.spawn().unwrap()
    };

    let mut refused = ride(&["ride", "--new", "--graph", GRAPH], None);
    drop(refused.stdin.take());
    let mut lines = BufReader::new(refused.stdout.take().unwrap()).lines();
    let frame: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
    assert_eq!(frame["type"], "error", "{frame}");
    assert_eq!(frame["code"], "model_key_required", "{frame}");
    assert!(
        frame["message"]
            .as_str()
            .unwrap()
            .contains("OpenRouter key"),
        "{frame}"
    );
    assert!(frame["details"]["doors"]["account"].is_object(), "{frame}");
    let _ = refused.wait();

    let mut first = ride(
        &["ride", "--new", "--graph", GRAPH, "--client-id", "agent-1"],
        Some("sk-or-v1-agents-own-key-0001"),
    );
    let mut stdin = first.stdin.take().unwrap();
    let mut frames = BufReader::new(first.stdout.take().unwrap()).lines();
    let mut next = || -> Value { serde_json::from_str(&frames.next().unwrap().unwrap()).unwrap() };
    let ready = next();
    assert_eq!(ready["type"], "ready", "{ready}");
    let session_id = ready["session"]["sessionId"].as_str().unwrap().to_string();
    send_line(
        &mut stdin,
        r#"{"op":"prompt","requestId":"q1","text":"how many dairy cows in Florida?"}"#,
    );
    assert_eq!(next()["type"], "command.accepted");
    let mut settled = false;
    for round in 0..20 {
        send_line(
            &mut stdin,
            &json!({"op": "watch", "requestId": format!("w{round}"), "waitMs": 2000}).to_string(),
        );
        let batch = next();
        if batch["value"]["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["type"] == "run.settled")
        {
            settled = true;
            break;
        }
    }
    assert!(settled);
    drop(stdin);
    assert_eq!(next()["type"], "closed");
    assert!(first.wait().unwrap().success());

    // Coming back: the same visitor, a new ride, the same session and what was said in it.
    let mut again = ride(
        &["ride", "--session", &session_id, "--client-id", "agent-2"],
        Some("sk-or-v1-agents-own-key-0001"),
    );
    let mut stdin = again.stdin.take().unwrap();
    let mut frames = BufReader::new(again.stdout.take().unwrap()).lines();
    let mut next = || -> Value { serde_json::from_str(&frames.next().unwrap().unwrap()).unwrap() };
    let ready = next();
    assert_eq!(ready["type"], "ready", "{ready}");
    assert_eq!(ready["session"]["sessionId"], session_id.as_str());
    send_line(&mut stdin, r#"{"op":"inspect","requestId":"i1"}"#);
    let snapshot = next();
    assert_eq!(
        snapshot["value"]["transcript"][1]["text"], "faux heard: how many dairy cows in Florida?",
        "{snapshot}"
    );
    assert!(
        !snapshot
            .to_string()
            .contains("sk-or-v1-agents-own-key-0001")
    );
    drop(stdin);
    let _ = next();
    let _ = again.wait();

    // Another visitor does not see it.
    let mut stranger = host.vehicle(&["ride", "--session", &session_id]);
    stranger
        .env_remove("VEHICLE_KEY_FILE")
        .args(["--anonymous", "--visitor-id", "some-other-visitor-000000"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    let mut stranger = stranger.spawn().unwrap();
    drop(stranger.stdin.take());
    let mut lines = BufReader::new(stranger.stdout.take().unwrap()).lines();
    let frame: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
    assert_eq!(frame["code"], "not_found", "{frame}");
    let _ = stranger.wait();
}
