//! The room as a person uses it: the `vehicle` binary in a real pseudo-terminal, keys typed into it, the
//! screen read back through a terminal emulator (vt100), against a real `vehicle-host` (pi's faux model).
//! A second process chimes with `vehicle chime` while the room is open.

mod support;

use std::{
    thread,
    time::{Duration, Instant},
};
use support::{FauxHost, GRAPH, Tty, host_available};
use vehicle::ride::short_session_id;

fn count(screen: &str, needle: &str) -> usize {
    screen.matches(needle).count()
}

#[test]
fn a_room_drives_takes_chimes_steers_and_aborts() {
    if !host_available("a_room_drives_takes_chimes_steers_and_aborts") {
        return;
    }
    let host = FauxHost::start(true);
    let mut room = Tty::spawn(
        &host.front_url,
        &host.key_file,
        &["room", "--new", "--graph", GRAPH, "--client-id", "tty-room"],
    );
    room.wait_text("driver=you");
    room.wait_text("sse");
    let observer = host.owner("observer");
    let session_id = observer.list_sessions().unwrap()[0].session_id.clone();

    // A turn: typed, streamed, answered.
    room.type_keys("hello room\r");
    room.wait_text("faux heard: hello room");
    room.frame("01-turn");

    // suggest: a chime from another terminal waits for the driver, who accepts it.
    let chimed = host
        .vehicle(&[
            "chime",
            &session_id,
            "--author",
            "Codex",
            "look",
            "at",
            "the",
            "fence",
        ])
        .output()
        .unwrap();
    assert!(chimed.status.success(), "{chimed:?}");
    assert!(String::from_utf8_lossy(&chimed.stdout).starts_with("pending"));
    room.wait_text("chimes=1");
    room.wait_text("Codex chimes a prompt");
    room.frame("02-chime-pending");
    room.type_keys("/accept\r");
    room.wait_text("Codex · collaborator");
    room.wait_text("faux heard: [Codex collaborator]");
    room.wait_text("chimes=0");
    room.frame("03-chime-accepted");

    // co-drive: delivered at once.
    room.type_keys("/policy co-drive\r");
    room.wait_text("policy=co-drive");
    let submitted = host
        .vehicle(&[
            "chime",
            &session_id,
            "--author",
            "Codex",
            "--delivery",
            "follow-up",
            "and",
            "the",
            "charger",
        ])
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&submitted.stdout).starts_with("submitted"));
    room.wait_for("the co-drive chime answered", |screen| {
        count(screen, "and the charger") >= 2
    });
    room.frame("04-co-drive");

    // mute: refused at the door.
    room.type_keys("/policy mute\r");
    room.wait_text("policy=mute");
    let muted = host
        .vehicle(&["chime", &session_id, "--author", "Codex", "hello?"])
        .output()
        .unwrap();
    assert!(!muted.status.success());
    assert!(String::from_utf8_lossy(&muted.stderr).contains("the room is muted"));

    // A steer while the run goes: Enter steers.
    room.type_keys("[slow 2500] list the parts\r");
    room.wait_text("steer: running");
    room.type_keys("only the power ones\r");
    room.wait_text("faux heard: only the power ones");
    room.frame("05-steer");

    // Esc stops a run.
    room.type_keys("[hold] wait for me\r");
    room.wait_text("steer: running");
    room.type_keys("\x1b");
    room.wait_text("run aborted");
    room.frame("06-abort");
    let commands = observer.inspect(&session_id).unwrap().commands;
    let status_of = |op: &str| {
        commands
            .iter()
            .filter(|command| command.op == op)
            .map(|command| command.status.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(status_of("steer"), vec!["completed"]);
    assert_eq!(status_of("abort"), vec!["completed"]);
    assert!(status_of("prompt").contains(&"aborted".to_string()));

    // Leaving gives the wheel back.
    room.type_keys("\x03");
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = room.child.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "the room did not leave");
        thread::sleep(Duration::from_millis(50));
    };
    assert!(status.success());
    assert!(
        observer
            .inspect(&session_id)
            .unwrap()
            .session
            .lease
            .is_none(),
        "the room released its lease"
    );
}

#[test]
fn a_second_room_watches_read_only_and_the_lobby_lists_sessions() {
    if !host_available("a_second_room_watches_read_only_and_the_lobby_lists_sessions") {
        return;
    }
    let host = FauxHost::start(false);
    let mut first = Tty::spawn(
        &host.front_url,
        &host.key_file,
        &[
            "room",
            "--new",
            "--graph",
            GRAPH,
            "--title",
            "the board",
            "--client-id",
            "first",
        ],
    );
    first.wait_text("driver=you");
    first.wait_text("long-poll");

    // The lobby: the session is listed; Enter opens it in a second, read-only room.
    let mut second = Tty::spawn(
        &host.front_url,
        &host.key_file,
        &["room", "--client-id", "second"],
    );
    second.wait_text("vehicle lobby");
    second.wait_text("the board");
    second.type_keys("\r");
    second.wait_text("driver=first");
    // The same person, another client: read-only, and told it may take the wheel.
    second.wait_text("read-only: you drive this from first");
    second.type_keys("may I?\r");
    second.wait_text("/take to take the wheel here");

    // The driver's turn shows in both rooms (the second by long-poll: no live text, the whole message).
    first.type_keys("both of you\r");
    first.wait_text("faux heard: both of you");
    second.wait_text("faux heard: both of you");
    second.frame("07-read-only-second-room");

    // The first lets go; the second claims and drives.
    first.type_keys("/release\r");
    second.wait_text("driver=nobody");
    second.type_keys("/claim\r");
    second.wait_text("driver=you");
    second.type_keys("now me\r");
    second.wait_text("faux heard: now me");
    first.wait_text("faux heard: now me");

    // The same person in the first terminal takes the wheel back (B's takeover); the second sees it go.
    first.type_keys("may I?\r");
    first.wait_text("/take to take the wheel here");
    first.type_keys("/take\r");
    first.wait_text("driver=you");
    second.wait_text("first took the wheel from you");
    second.wait_text("driver=first");
    first.type_keys("mine again\r");
    first.wait_text("faux heard: mine again");
    second.frame("09-taken-over");
    first.type_keys("\x03");
    second.type_keys("\x03");
}

#[test]
fn closing_the_terminal_gives_the_wheel_back() {
    if !host_available("closing_the_terminal_gives_the_wheel_back") {
        return;
    }
    let host = FauxHost::start(true);
    let mut room = Tty::spawn(
        &host.front_url,
        &host.key_file,
        &["room", "--new", "--graph", GRAPH, "--client-id", "hung-up"],
    );
    room.wait_text("driver=you");
    let observer = host.owner("observer");
    let session_id = observer.list_sessions().unwrap()[0].session_id.clone();
    let pid = room.child.process_id().expect("the room's pid");
    // The terminal window closes: the room gets SIGHUP.
    assert!(
        std::process::Command::new("kill")
            .args(["-HUP", &pid.to_string()])
            .status()
            .unwrap()
            .success()
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while room.child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "the room did not leave");
        thread::sleep(Duration::from_millis(50));
    }
    assert!(
        observer
            .inspect(&session_id)
            .unwrap()
            .session
            .lease
            .is_none(),
        "a hung-up room released its lease"
    );
}

#[test]
fn a_room_opened_by_id_after_a_restart_still_drives() {
    if !host_available("a_room_opened_by_id_after_a_restart_still_drives") {
        return;
    }
    let host = FauxHost::start_delegating();
    let driver = host.owner("first-room");
    let session_id = driver
        .create_session(&vehicle::ride::CreateSession {
            request_id: vehicle::ride::mint_id("pty-new"),
            title: Some("before".to_string()),
            model: None,
            profile: None,
            claim: false,
        })
        .unwrap()
        .session_id;
    // The host restarts (the delegation token dies with it); the room opens by id, without --graph.
    let host = host.restart();
    let mut room = Tty::spawn(
        &host.front_url,
        &host.key_file,
        &["room", &session_id, "--client-id", "by-id"],
    );
    room.wait_text("driver=you");
    room.type_keys("after the restart\r");
    room.wait_text("faux heard: after the restart");
    room.type_keys("\x03");
}

#[test]
fn a_room_branches_before_a_message_and_duplicates() {
    if !host_available("a_room_branches_before_a_message_and_duplicates") {
        return;
    }
    let host = FauxHost::start(true);
    let mut room = Tty::spawn(
        &host.front_url,
        &host.key_file,
        &["room", "--new", "--graph", GRAPH, "--client-id", "tty-room"],
    );
    room.wait_text("driver=you");
    let observer = host.owner("observer");
    let source = observer.list_sessions().unwrap()[0].session_id.clone();

    // Two messages, numbered as /branch takes them.
    room.type_keys("first question\r");
    room.wait_text("faux heard: first question");
    room.type_keys("second question\r");
    room.wait_text("faux heard: second question");
    room.wait_text("you · #1");
    room.wait_text("you · #2");
    room.frame("b1-two-messages");

    // /branch 2: the room moves to a branch holding the first exchange, with message 2's words in the composer.
    room.type_keys("/branch 2\r");
    let screen = room.wait_text("branched from");
    assert!(
        screen.contains(&format!("branched from {}", short_session_id(&source))),
        "{screen}"
    );
    assert!(screen.contains("before #2"), "{screen}");
    room.wait_for("the branch's chat, without the second exchange", |screen| {
        !screen.contains("faux heard: second question")
            && screen.contains("faux heard: first question")
    });
    room.frame("b2-branched");
    let listed = observer.list_sessions().unwrap();
    let branch = listed
        .iter()
        .find(|session| {
            session
                .parent_ref()
                .is_some_and(|parent| parent.kind == "fork")
        })
        .expect("the branch is listed")
        .clone();
    assert_eq!(branch.parent_ref().unwrap().session_id, source);
    assert_eq!(
        branch.lease.as_ref().map(|lease| lease.client_id.as_str()),
        Some("tty-room"),
        "the room drives the branch"
    );
    assert!(
        listed
            .iter()
            .find(|session| session.session_id == source)
            .unwrap()
            .lease
            .is_none(),
        "and let go of the source"
    );

    // Edit the words and send them: answered in the branch only.
    room.type_keys(", edited\r");
    room.wait_text("faux heard: second question, edited");
    room.frame("b3-resent");
    let said = |session_id: &str| {
        observer
            .inspect(session_id)
            .unwrap()
            .transcript
            .iter()
            .map(|item| item.text.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        said(&branch.session_id),
        vec![
            "first question",
            "faux heard: first question",
            "second question, edited",
            "faux heard: second question, edited"
        ]
    );
    assert_eq!(said(&source).len(), 4, "the source is untouched");
    assert_eq!(said(&source)[2], "second question");

    // /duplicate: a copy of the branch, and the room moves there.
    room.type_keys("/duplicate\r");
    room.wait_text("duplicated");
    room.frame("b4-duplicated");
    let copy = observer
        .list_sessions()
        .unwrap()
        .into_iter()
        .find(|session| {
            session
                .parent_ref()
                .is_some_and(|parent| parent.kind == "clone")
        })
        .expect("the copy is listed");
    assert_eq!(copy.parent_ref().unwrap().session_id, branch.session_id);
    assert_eq!(said(&copy.session_id), said(&branch.session_id));
    assert_eq!(
        copy.lease.as_ref().map(|lease| lease.client_id.as_str()),
        Some("tty-room")
    );
    room.wait_text("Copy of");

    // A number that is not there is said, and nothing moves.
    room.type_keys("/branch 7\r");
    room.wait_text("there is no message 7");

    // The lobby marks a branch; `vehicle sessions` says where each came from.
    let sessions = host.vehicle(&["sessions"]).output().unwrap();
    let sessions = String::from_utf8_lossy(&sessions.stdout).to_string();
    assert!(
        sessions.contains(&format!(
            "↳ branched from \"first question\" ({})",
            short_session_id(&source)
        )),
        "{sessions}"
    );
    assert!(
        // A fork is listed by what was said in it: here, the edited message.
        sessions.contains(&format!(
            "↳ duplicated from \"second question, edited\" ({})",
            short_session_id(&branch.session_id)
        )),
        "{sessions}"
    );

    room.type_keys("\x03");
    let deadline = Instant::now() + Duration::from_secs(10);
    while room.child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "the room did not leave");
        thread::sleep(Duration::from_millis(50));
    }
    assert!(
        observer
            .inspect(&copy.session_id)
            .unwrap()
            .session
            .lease
            .is_none(),
        "leaving gave the copy's wheel back"
    );
}
