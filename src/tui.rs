//! What the room and the lobby share: the terminal guard, key translation, wrapping, and small renderers.

use anyhow::{Context, Result};
use ratatui_core::{
    style::{Color, Modifier, Style},
    terminal::Terminal,
    text::{Line, Span},
};
use ratatui_crossterm::{
    CrosstermBackend, crossterm,
    crossterm::{
        event::{KeyCode, KeyEvent, KeyModifiers},
        terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
    },
};
use ratatui_textarea::{Input, Key};
use serde_json::Value;
use std::io::{self, Stdout};
use unicode_width::UnicodeWidthChar;

/// Raw mode and the alternate screen for as long as it lives; restored on drop (a panic included).
pub struct TerminalGuard {
    pub terminal: Terminal<CrosstermBackend<Stdout>>,
}

impl TerminalGuard {
    pub fn enter() -> Result<Self> {
        enable_raw_mode().context("failed to enable terminal raw mode")?;
        let mut stdout = io::stdout();
        crossterm::execute!(stdout, EnterAlternateScreen)
            .context("failed to enter alternate screen")?;
        let backend = CrosstermBackend::new(stdout);
        let terminal = Terminal::new(backend).context("failed to initialize terminal")?;
        Ok(Self { terminal })
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = self.terminal.show_cursor();
        let _ = disable_raw_mode();
        let _ = crossterm::execute!(self.terminal.backend_mut(), LeaveAlternateScreen);
    }
}

pub fn key_event_input(key: KeyEvent) -> Input {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    if key.code == KeyCode::BackTab {
        return Input {
            key: Key::Tab,
            ctrl,
            alt,
            shift: true,
        };
    }
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);
    let key = match key.code {
        KeyCode::Backspace => Key::Backspace,
        KeyCode::Enter => Key::Enter,
        KeyCode::Left => Key::Left,
        KeyCode::Right => Key::Right,
        KeyCode::Up => Key::Up,
        KeyCode::Down => Key::Down,
        KeyCode::Home => Key::Home,
        KeyCode::End => Key::End,
        KeyCode::PageUp => Key::PageUp,
        KeyCode::PageDown => Key::PageDown,
        KeyCode::Tab => Key::Tab,
        KeyCode::Delete => Key::Delete,
        KeyCode::F(number) => Key::F(number),
        KeyCode::Char(character) => Key::Char(character),
        KeyCode::Esc => Key::Esc,
        _ => Key::Null,
    };
    Input {
        key,
        ctrl,
        alt,
        shift,
    }
}

/// Word-wrap styled lines to `width` columns. A continuation keeps the line's leading indent (up to 4).
pub fn wrap_lines(lines: Vec<Line<'static>>, width: usize) -> Vec<Line<'static>> {
    lines
        .into_iter()
        .flat_map(|line| wrap_line(line, width))
        .collect()
}

fn wrap_line(line: Line<'static>, width: usize) -> Vec<Line<'static>> {
    if width == 0 || line.width() <= width {
        return vec![line];
    }
    let cell_width = |c: char| c.width().unwrap_or(0);
    let cells: Vec<(char, Style)> = line
        .spans
        .iter()
        .flat_map(|span| span.content.chars().map(move |c| (c, span.style)))
        .collect();
    let indent = cells.iter().take_while(|(c, _)| *c == ' ').count().min(4);
    let indent = if indent * 2 >= width { 0 } else { indent };

    let mut rows: Vec<Vec<(char, Style)>> = Vec::new();
    let mut row: Vec<(char, Style)> = Vec::new();
    let mut row_width = 0;
    // Where the row may break: just after its last space past the indent.
    let mut last_space: Option<usize> = None;
    for (c, style) in cells {
        let w = cell_width(c);
        if row_width + w > width && row.len() > indent {
            let mut carry = match last_space {
                Some(space) => row.split_off(space + 1),
                None => Vec::new(),
            };
            let carried: usize = carry.iter().map(|(c, _)| cell_width(*c)).sum();
            if indent + carried + w > width {
                // The word would not fit a fresh row either: break it here instead.
                row.append(&mut carry);
            }
            rows.push(std::mem::take(&mut row));
            row = vec![(' ', Style::default()); indent];
            row.append(&mut carry);
            row_width = indent
                + row[indent..]
                    .iter()
                    .map(|(c, _)| cell_width(*c))
                    .sum::<usize>();
            last_space = None;
            if c == ' ' && row.len() == indent {
                continue;
            }
        }
        if c == ' ' && row.len() >= indent {
            last_space = Some(row.len());
        }
        row.push((c, style));
        row_width += w;
    }
    rows.push(row);
    rows.into_iter().map(cells_to_line).collect()
}

fn cells_to_line(cells: Vec<(char, Style)>) -> Line<'static> {
    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut text = String::new();
    let mut current: Option<Style> = None;
    for (c, style) in cells {
        if current.is_some_and(|current| current != style) {
            spans.push(Span::styled(
                std::mem::take(&mut text),
                current.unwrap_or_default(),
            ));
        }
        current = Some(style);
        text.push(c);
    }
    if !text.is_empty() {
        spans.push(Span::styled(text, current.unwrap_or_default()));
    }
    Line::from(spans)
}

pub fn section_line(label: &str) -> Line<'static> {
    Line::from(Span::styled(
        format!("-- {label} --"),
        Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::BOLD),
    ))
}

pub fn push_field(lines: &mut Vec<Line<'static>>, key: &str, value: &str) {
    if value.is_empty() {
        return;
    }
    lines.push(Line::from(vec![
        Span::styled(format!("{key}: "), Style::default().fg(Color::Cyan)),
        Span::raw(value.to_string()),
    ]));
}

pub fn json_value_lines(value: &Value, max_lines: usize) -> Vec<Line<'static>> {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| compact_json(value, 2000));
    let mut lines = text
        .lines()
        .take(max_lines)
        .map(|line| json_source_line(line, "  "))
        .collect::<Vec<_>>();
    if text.lines().count() > max_lines {
        lines.push(Line::from(Span::styled(
            "...",
            Style::default().fg(Color::DarkGray),
        )));
    }
    lines
}

fn json_source_line(line: &str, prefix: &str) -> Line<'static> {
    let mut spans = vec![Span::styled(
        prefix.to_string(),
        Style::default().fg(Color::DarkGray),
    )];
    let trimmed = line.trim_start();
    let indent_len = line.len() - trimmed.len();
    if indent_len > 0 {
        spans.push(Span::raw(" ".repeat(indent_len)));
    }
    if trimmed.starts_with('"')
        && let Some(colon_index) = trimmed.find("\":")
    {
        let (key, rest) = trimmed.split_at(colon_index + 2);
        spans.push(Span::styled(
            key.to_string(),
            Style::default().fg(Color::Cyan),
        ));
        spans.push(Span::styled(
            rest.to_string(),
            Style::default().fg(json_value_color(rest)),
        ));
        return Line::from(spans);
    }
    spans.push(Span::styled(
        trimmed.to_string(),
        Style::default().fg(json_value_color(trimmed)),
    ));
    Line::from(spans)
}

fn json_value_color(value: &str) -> Color {
    let trimmed = value.trim_start();
    if trimmed.starts_with('"') {
        Color::Green
    } else if trimmed.starts_with("true")
        || trimmed.starts_with("false")
        || trimmed.starts_with("null")
    {
        Color::Magenta
    } else if trimmed.starts_with('{')
        || trimmed.starts_with('}')
        || trimmed.starts_with('[')
        || trimmed.starts_with(']')
    {
        Color::DarkGray
    } else {
        Color::Yellow
    }
}

pub fn value_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(|field| match field {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    })
}

pub fn compact_json(value: &Value, max_len: usize) -> String {
    let text = match value.as_str() {
        Some(text) => text.to_string(),
        None => serde_json::to_string(value).unwrap_or_else(|_| "<json>".to_string()),
    };
    truncate(&text, max_len)
}

pub fn truncate(value: &str, max_len: usize) -> String {
    if value.chars().count() <= max_len {
        return value.to_string();
    }
    let mut text = value
        .chars()
        .take(max_len.saturating_sub(3))
        .collect::<String>();
    text.push_str("...");
    text
}

/// `2026-10-14T00:43:25.275Z` → `10-14 00:43:25`.
pub fn short_time(ts: &str) -> String {
    match (ts.get(5..10), ts.get(11..19)) {
        (Some(day), Some(time)) => format!("{day} {time}"),
        _ => ts.to_string(),
    }
}

/// The first eight characters of an id.
pub fn short_id(id: &str) -> String {
    vehicle::ride::short_session_id(id).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(lines: &[Line<'static>]) -> Vec<String> {
        lines.iter().map(|line| line.to_string()).collect()
    }

    #[test]
    fn wrapping_breaks_at_spaces_keeps_the_indent_and_the_style() {
        let line = Line::from(vec![
            Span::raw("  "),
            Span::styled(
                "the buck-boost converter is the TPS63020 from Texas Instruments",
                Style::default().fg(Color::Cyan),
            ),
        ]);
        let wrapped = wrap_line(line, 24);
        assert_eq!(
            text(&wrapped),
            vec![
                "  the buck-boost ",
                "  converter is the ",
                "  TPS63020 from Texas ",
                "  Instruments"
            ]
        );
        assert!(wrapped.iter().all(|line| line.width() <= 24));
        assert_eq!(wrapped[1].spans[1].style.fg, Some(Color::Cyan));

        let unbroken = wrap_line(Line::from("x".repeat(30)), 12);
        assert_eq!(
            text(&unbroken),
            vec!["x".repeat(12), "x".repeat(12), "x".repeat(6)]
        );
        assert_eq!(text(&wrap_line(Line::from("short"), 12)), vec!["short"]);
    }

    #[test]
    fn short_forms_of_times_and_ids() {
        assert_eq!(short_time("2026-10-14T00:43:25.275Z"), "10-14 00:43:25");
        assert_eq!(short_id("4dfec34f-7ba9-44b8-9c1d-0e2f3a4b5c6d"), "3a4b5c6d");
    }
}
