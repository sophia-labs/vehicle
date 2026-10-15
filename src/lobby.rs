//! The lobby: pick one of your ride sessions (or start one) before entering its room.

use anyhow::Result;
use ratatui_core::{
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    terminal::Frame,
    text::{Line, Span, Text},
};
use ratatui_crossterm::crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui_widgets::{block::Block, borders::Borders, paragraph::Paragraph};
use std::time::{Duration, Instant};
use vehicle::ride::{RideClient, SessionSummary};

use crate::tui::{TerminalGuard, short_time, truncate};

const REFRESH_EVERY: Duration = Duration::from_secs(3);

pub enum LobbyChoice {
    Open(String),
    New,
    Quit,
}

pub fn select(client: &RideClient) -> Result<LobbyChoice> {
    let mut lobby = Lobby {
        client,
        sessions: Vec::new(),
        selected: 0,
        status: String::new(),
        last_refresh: Instant::now(),
    };
    lobby.refresh();
    let mut terminal = TerminalGuard::enter()?;
    loop {
        if lobby.last_refresh.elapsed() >= REFRESH_EVERY {
            lobby.refresh();
        }
        terminal.terminal.draw(|frame| lobby.render(frame))?;
        if !event::poll(Duration::from_millis(100))? {
            continue;
        }
        let Event::Key(key) = event::read()? else {
            continue;
        };
        if key.kind == KeyEventKind::Release {
            continue;
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        match key.code {
            KeyCode::Char('c') if ctrl => return Ok(LobbyChoice::Quit),
            KeyCode::Char('q') | KeyCode::Esc => return Ok(LobbyChoice::Quit),
            KeyCode::Up | KeyCode::Char('k') => lobby.selected = lobby.selected.saturating_sub(1),
            KeyCode::Down | KeyCode::Char('j') => {
                lobby.selected = (lobby.selected + 1).min(lobby.sessions.len().saturating_sub(1));
            }
            KeyCode::Char('r') => lobby.refresh(),
            KeyCode::Char('n') => {
                if client.endpoint().graph_id.is_some() {
                    return Ok(LobbyChoice::New);
                }
                lobby.status = "a new session needs a graph: run `vehicle room --new --graph <id>`"
                    .to_string();
            }
            KeyCode::Enter => {
                if let Some(session) = lobby.sessions.get(lobby.selected) {
                    return Ok(LobbyChoice::Open(session.session_id.clone()));
                }
            }
            _ => {}
        }
    }
}

struct Lobby<'a> {
    client: &'a RideClient,
    sessions: Vec<SessionSummary>,
    selected: usize,
    status: String,
    last_refresh: Instant,
}

impl Lobby<'_> {
    fn refresh(&mut self) {
        self.last_refresh = Instant::now();
        match self.client.list_sessions() {
            Ok(sessions) => {
                self.sessions = sessions;
                self.selected = self.selected.min(self.sessions.len().saturating_sub(1));
            }
            Err(error) => self.status = format!("list failed: {error:#}"),
        }
    }

    fn render(&self, frame: &mut Frame<'_>) {
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(1),
                Constraint::Min(4),
                Constraint::Length(1),
            ])
            .split(frame.area());
        let endpoint = self.client.endpoint();
        let header = format!(
            " vehicle lobby  gardend={}  graph={}  {} sessions ",
            endpoint.gardend_url,
            endpoint.graph_id.as_deref().unwrap_or("all"),
            self.sessions.len()
        );
        frame.render_widget(
            Paragraph::new(header).style(
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::White)
                    .add_modifier(Modifier::BOLD),
            ),
            rows[0],
        );
        let mut lines = vec![Line::from(Span::styled(
            format!(
                "  {:<15} {:<8} {:<9} {:<22} {:<20} {}",
                "updated", "status", "policy", "driver", "graph", "session"
            ),
            Style::default().fg(Color::DarkGray),
        ))];
        if self.sessions.is_empty() {
            lines.push(Line::from(
                "  no sessions yet: press n to start one on --graph",
            ));
        }
        for (index, session) in self.sessions.iter().enumerate() {
            let chosen = index == self.selected;
            let style = if chosen {
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            let driver = session
                .lease
                .as_ref()
                .map_or("-".to_string(), |lease| truncate(&lease.client_id, 22));
            lines.push(Line::from(Span::styled(
                format!(
                    "{} {:<15} {:<8} {:<9} {:<22} {:<20} {}",
                    if chosen { ">" } else { " " },
                    short_time(&session.updated_at),
                    session.status,
                    session.room_policy,
                    driver,
                    truncate(&session.graph_id, 20),
                    truncate(
                        &format!(
                            "{}{}",
                            if session.parent.is_some() { "↳ " } else { "" },
                            session.label().replace('\n', " ")
                        ),
                        60
                    )
                ),
                style,
            )));
        }
        frame.render_widget(
            Paragraph::new(Text::from(lines))
                .block(Block::default().borders(Borders::ALL).title("sessions")),
            rows[1],
        );
        frame.render_widget(
            Paragraph::new(format!(
                " {} │ Enter open · n new · r refresh · q quit",
                self.status
            ))
            .style(Style::default().fg(Color::DarkGray)),
            rows[2],
        );
    }
}
