//! Terminal drawer — a bottom drawer running a real PTY shell.
//!
//! Primary backend (default): `alacritty_terminal 0.26` + `portable-pty`.
//! portable-pty provides the pty sizing model; alacritty's `tty` module spawns
//! the login shell, its `EventLoop` thread feeds the VTE parser into a
//! `Term` shared behind `Arc<FairMutex<Term<TerminalListener>>>` (the Zed
//! architecture: IO thread → channel → foreground watcher → `cx.notify`), and
//! a custom GPUI [`TerminalElement`] paints the visible grid as per-row
//! `StyledText` runs with a theme-derived ANSI palette.
//!
//! Fallback backend (`simple: true` in [`TerminalDeps`]): a portable-pty shell
//! session whose raw byte stream is rendered through a minimal VT100 parser
//! ([`SimpleParser`], ANSI-stripping monospace scrollback). Still real shell
//! I/O, degraded rendering — kept as a compile-time-safe escape hatch.
//!
//! Keyboard input is translated to bytes ([`keystroke_bytes`]) and written to
//! the pty; Escape closes the drawer instead of reaching the shell.

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use aiden_data::config_store::ConfigStore;

use alacritty_terminal::{
    event::{Event, EventListener, WindowSize},
    event_loop::{EventLoop, EventLoopSender, Msg},
    grid::{Dimensions, Scroll},
    sync::FairMutex,
    term::{cell::Flags, Config, Term, TermMode},
    tty::{self, Options as PtyOptions, Shell},
    vte::ansi::Color,
};
use gpui::{
    div, point, px, relative, size as gpui_size, App, AppContext as _, Bounds, Context, Element,
    ElementId, FocusHandle, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement as _,
    Pixels, Render, Rgba, ScrollDelta, ScrollWheelEvent, SharedString, StatefulInteractiveElement,
    Style, Styled, TextRun, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex, v_flex, ActiveTheme, Disableable as _, Icon, IconName, Sizable as _,
};

const MAX_SESSIONS: usize = 8;
const MAX_PANES: usize = 4;
const MAX_INPUT_BYTES: usize = 64_000;
const MIN_COLUMNS: usize = 20;
const MAX_COLUMNS: usize = 500;
const MIN_ROWS: usize = 4;
const MAX_ROWS: usize = 300;
const MIN_DRAWER_HEIGHT: f32 = 152.0;
const DEFAULT_DRAWER_HEIGHT: f32 = 232.0;
const MAX_DRAWER_RATIO: f32 = 0.5;
const MIN_CHAT_HEIGHT: f32 = 320.0;
const DRAWER_HEIGHT_SETTINGS_KEY: &str = "terminal.drawerHeight";
static DRAWER_HEIGHT_GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SplitDirection {
    Single,
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalLayout {
    pub(crate) direction: SplitDirection,
    pub(crate) ids: Vec<u64>,
}

impl Default for TerminalLayout {
    fn default() -> Self {
        Self {
            direction: SplitDirection::Single,
            ids: Vec::new(),
        }
    }
}

impl TerminalLayout {
    fn select(&mut self, id: u64) {
        if !self.ids.contains(&id) {
            self.direction = SplitDirection::Single;
            self.ids = vec![id];
        }
    }

    fn append_split(&mut self, active_id: Option<u64>, id: u64, direction: SplitDirection) -> bool {
        let mut base = active_id
            .filter(|active| self.ids.contains(active))
            .map(|_| self.ids.clone())
            .or_else(|| active_id.map(|active| vec![active]))
            .unwrap_or_default();
        if base.len() >= MAX_PANES {
            return false;
        }
        base.push(id);
        self.direction = direction;
        self.ids = base;
        true
    }

    fn remove(&mut self, id: u64) {
        self.ids.retain(|candidate| *candidate != id);
        if self.ids.len() <= 1 {
            self.direction = SplitDirection::Single;
        }
    }
}

pub(crate) fn max_drawer_height(viewport_height: f32) -> f32 {
    MIN_DRAWER_HEIGHT
        .max((viewport_height * MAX_DRAWER_RATIO).min(viewport_height - MIN_CHAT_HEIGHT))
}

pub(crate) fn clamp_drawer_height(height: f32, viewport_height: f32) -> f32 {
    let height = if height.is_finite() {
        height
    } else {
        DEFAULT_DRAWER_HEIGHT
    };
    height
        .round()
        .clamp(MIN_DRAWER_HEIGHT, max_drawer_height(viewport_height))
}

pub(crate) fn keyboard_resize_height(
    height: f32,
    key: &str,
    shift: bool,
    viewport_height: f32,
) -> Option<f32> {
    let step = if shift { 40.0 } else { 16.0 };
    match key {
        "up" => Some(clamp_drawer_height(height + step, viewport_height)),
        "down" => Some(clamp_drawer_height(height - step, viewport_height)),
        "home" => Some(MIN_DRAWER_HEIGHT),
        "end" => Some(max_drawer_height(viewport_height)),
        _ => None,
    }
}

fn load_drawer_height(config: Option<&ConfigStore>) -> f32 {
    config
        .and_then(|config| config.get_settings().ok())
        .and_then(|settings| {
            settings
                .get(DRAWER_HEIGHT_SETTINGS_KEY)
                .and_then(|value| value.as_f64())
        })
        .map(|height| height as f32)
        .filter(|height| height.is_finite())
        .unwrap_or(DEFAULT_DRAWER_HEIGHT)
}

fn persist_drawer_height(config: Arc<ConfigStore>, height: f32, cx: &mut App) {
    let generation = next_persist_generation(&DRAWER_HEIGHT_GENERATION);
    cx.background_spawn(async move {
        let mut patch = serde_json::Map::new();
        patch.insert(DRAWER_HEIGHT_SETTINGS_KEY.into(), serde_json::json!(height));
        let current = || persist_generation_is_current(&DRAWER_HEIGHT_GENERATION, generation);
        if let Err(error) = config.set_settings(&patch, &current) {
            if current() {
                tracing::warn!(%error, "failed to persist terminal drawer height");
            }
        }
    })
    .detach();
}

fn next_persist_generation(counter: &AtomicU64) -> u64 {
    counter.fetch_add(1, Ordering::AcqRel).wrapping_add(1)
}

fn persist_generation_is_current(counter: &AtomicU64, generation: u64) -> bool {
    counter.load(Ordering::Acquire) == generation
}

fn fallback_after_session_removal(
    active_id: Option<u64>,
    removed_id: u64,
    layout_ids: &[u64],
    session_ids: &[u64],
    choose_fallback: bool,
) -> Option<u64> {
    if active_id != Some(removed_id) {
        return active_id;
    }
    choose_fallback
        .then(|| {
            layout_ids
                .first()
                .copied()
                .or_else(|| session_ids.first().copied())
        })
        .flatten()
}

/// Events flowing from the pty thread to the foreground watcher.
#[derive(Debug, Clone)]
pub enum TerminalEvent {
    /// New terminal content is available (repaint).
    Update,
    /// The child process changed the window title.
    Title(String),
    /// The child process exited.
    ChildExit,
}

const MAX_TERMINAL_TITLE_CHARS: usize = 120;

fn terminal_title_character_is_unsafe(character: char) -> bool {
    character.is_control()
        || matches!(
            character,
            '\u{061c}'
                | '\u{200e}'..='\u{200f}'
                | '\u{2028}'..='\u{202e}'
                | '\u{2066}'..='\u{2069}'
        )
}

fn normalize_terminal_title(title: &str) -> String {
    let normalized = title
        .chars()
        .filter(|character| !terminal_title_character_is_unsafe(*character))
        .take(MAX_TERMINAL_TITLE_CHARS)
        .collect::<String>();
    let normalized = normalized.trim();
    if normalized.is_empty() {
        "Terminal".into()
    } else {
        normalized.into()
    }
}

fn terminal_tab_label(number: usize) -> String {
    format!("Terminal {number}")
}

/// Listener handed to alacritty (runs on the pty IO thread).
#[derive(Clone)]
struct TerminalListener {
    tx: tokio::sync::mpsc::UnboundedSender<TerminalEvent>,
}

impl EventListener for TerminalListener {
    fn send_event(&self, event: Event) {
        let message = match event {
            Event::Wakeup | Event::Bell | Event::CursorBlinkingChange => {
                Some(TerminalEvent::Update)
            }
            Event::Title(title) => Some(TerminalEvent::Title(normalize_terminal_title(&title))),
            Event::Exit | Event::ChildExit(_) => Some(TerminalEvent::ChildExit),
            _ => None,
        };
        if let Some(message) = message {
            let _ = self.tx.send(message);
        }
    }
}

// ===========================================================================
// Minimal VT100 parser (fallback backend)
// ===========================================================================

/// A color the simple parser tracked for a span of text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SimpleColor {
    #[default]
    Default,
    Red,
    Green,
    Yellow,
    Blue,
    Magenta,
    Cyan,
    White,
    BrightRed,
    BrightGreen,
    BrightYellow,
    BrightBlue,
    BrightMagenta,
    BrightCyan,
    BrightWhite,
}

impl SimpleColor {
    fn from_ansi(code: u16) -> SimpleColor {
        match code {
            30 | 37 => SimpleColor::White,
            31 => SimpleColor::Red,
            32 => SimpleColor::Green,
            33 => SimpleColor::Yellow,
            34 => SimpleColor::Blue,
            35 => SimpleColor::Magenta,
            36 => SimpleColor::Cyan,
            90 | 91 => SimpleColor::BrightRed,
            92 => SimpleColor::BrightGreen,
            93 => SimpleColor::BrightYellow,
            94 => SimpleColor::BrightBlue,
            95 => SimpleColor::BrightMagenta,
            96 => SimpleColor::BrightCyan,
            97 => SimpleColor::BrightWhite,
            _ => SimpleColor::Default,
        }
    }
}

/// One rendered line in the simple scrollback.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SimpleLine {
    pub text: String,
    /// Color overrides, expressed as char ranges (empty for default).
    pub spans: Vec<(std::ops::Range<usize>, SimpleColor)>,
}

/// ANSI-stripping monospace scrollback parser with cursor tracking. Handles
/// `\r \n \t \b`, the common CSI sequences (CUU/CUD/CUF/CUB, ED/J, EL/K,
/// SGR colors, cursor-to-column), and ignores everything else it cannot
/// interpret — enough to render a shell session readably.
#[derive(Debug, Default)]
pub struct SimpleParser {
    lines: Vec<SimpleLine>,
    row: usize,
    col: usize,
    cols: usize,
    max_lines: usize,
    escape: Vec<u8>,
    current_color: SimpleColor,
}

impl SimpleParser {
    pub fn new(cols: usize, max_lines: usize) -> Self {
        Self {
            lines: vec![SimpleLine::default()],
            cols,
            max_lines,
            ..Self::default()
        }
    }

    pub fn lines(&self) -> &[SimpleLine] {
        &self.lines
    }

    fn push_char(&mut self, character: char) {
        if self.col >= self.cols {
            self.push_newline();
        }
        if self.lines.is_empty() {
            self.lines.push(SimpleLine::default());
        }
        let current_color = self.current_color;
        let start = self
            .lines
            .last_mut()
            .map(|line| line.text.len())
            .unwrap_or(0);
        if let Some(line) = self.lines.last_mut() {
            line.text.push(character);
            if current_color != SimpleColor::Default {
                if let Some(last) = line.spans.last_mut() {
                    if last.1 == current_color && last.0.end == start {
                        last.0.end = line.text.len();
                        self.col += 1;
                        return;
                    }
                }
                line.spans.push((start..line.text.len(), current_color));
            }
        }
        self.col += 1;
    }

    fn push_newline(&mut self) {
        if self.lines.len() >= self.max_lines {
            self.lines.remove(0);
        }
        self.lines.push(SimpleLine::default());
        self.row = self.lines.len().saturating_sub(1);
        self.col = 0;
    }

    fn backspace(&mut self) {
        if self.col > 0 {
            self.col -= 1;
        } else if self.row > 0 {
            self.row -= 1;
        }
    }

    fn clear_screen(&mut self) {
        self.lines.clear();
        self.lines.push(SimpleLine::default());
        self.row = 0;
        self.col = 0;
    }

    fn clear_line_from_cursor(&mut self) {
        if let Some(line) = self.lines.last_mut() {
            if self.col < line.text.len() {
                line.text.truncate(self.col);
                line.spans.retain(|span| span.0.start < self.col);
            }
        }
    }

    fn move_cursor(&mut self, up: usize, down: usize, right: usize, left: usize) {
        self.row = self.row.saturating_sub(up);
        self.row = self
            .row
            .saturating_add(down)
            .min(self.max_lines.saturating_sub(1));
        self.col = self.col.saturating_sub(left);
        self.col = self
            .col
            .saturating_add(right)
            .min(self.cols.saturating_sub(1));
    }

    /// Feed raw pty bytes; returns `true` when visible content changed.
    pub fn feed(&mut self, bytes: &[u8]) -> bool {
        let mut changed = false;
        for &byte in bytes {
            changed = self.feed_byte(byte) || changed;
        }
        changed
    }

    fn feed_byte(&mut self, byte: u8) -> bool {
        if !self.escape.is_empty() {
            return self.feed_escape(byte);
        }
        match byte {
            0x1b => {
                self.escape.push(byte);
                false
            }
            0x0d => {
                self.col = 0;
                true
            }
            0x0a => {
                self.push_newline();
                true
            }
            0x08 => {
                self.backspace();
                true
            }
            0x09 => {
                let next = (self.col / 8 + 1) * 8;
                while self.col < next {
                    self.push_char(' ');
                }
                true
            }
            _ if byte < 0x20 => false,
            _ => {
                self.push_char(byte as char);
                true
            }
        }
    }

    fn feed_escape(&mut self, byte: u8) -> bool {
        self.escape.push(byte);
        if self.escape.len() < 2 {
            return false;
        }
        if self.escape[1] != b'[' {
            // ESC + single char (ESC7/ESC8, OSC introducers we don't support).
            self.escape.clear();
            return false;
        }
        if self.escape.len() < 3 || !(0x40..=0x7e).contains(&byte) {
            // Keep collecting the CSI parameter/final bytes.
            return false;
        }
        let sequence = std::mem::take(&mut self.escape);
        let body = std::str::from_utf8(&sequence[2..]).unwrap_or("");
        let final_char = body.chars().last().unwrap_or(' ');
        let params = &body[..body.len().saturating_sub(final_char.len_utf8())];
        self.apply_csi(params, final_char)
    }

    fn apply_csi(&mut self, params: &str, final_char: char) -> bool {
        let first = params
            .split(';')
            .next()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(1)
            .max(1);
        match final_char {
            'A' => {
                self.move_cursor(first, 0, 0, 0);
                true
            }
            'B' => {
                self.move_cursor(0, first, 0, 0);
                true
            }
            'C' => {
                self.move_cursor(0, 0, first, 0);
                true
            }
            'D' => {
                self.move_cursor(0, 0, 0, first);
                true
            }
            'G' => {
                self.col = first.saturating_sub(1).min(self.cols.saturating_sub(1));
                true
            }
            'J' => {
                if params == "2" || params == "3" {
                    self.clear_screen();
                }
                true
            }
            'K' => {
                if params.is_empty() || params == "0" || params == "2" {
                    self.clear_line_from_cursor();
                }
                true
            }
            'm' => {
                self.apply_sgr(params);
                true
            }
            _ => false,
        }
    }

    fn apply_sgr(&mut self, params: &str) {
        if params.is_empty() {
            self.current_color = SimpleColor::Default;
            return;
        }
        let codes: Vec<u16> = params
            .split(';')
            .map(|part| part.parse::<u16>().unwrap_or(0))
            .collect();
        let mut index = 0;
        while index < codes.len() {
            match codes[index] {
                0 => self.current_color = SimpleColor::Default,
                30..=37 | 90..=97 => {
                    self.current_color = SimpleColor::from_ansi(codes[index]);
                }
                38 if codes.get(index + 1) == Some(&5) => {
                    // 38;5;<n> indexed color — approximate to a base color.
                    self.current_color =
                        indexed_simple_color(codes.get(index + 2).copied().unwrap_or(0));
                    index += 2;
                }
                38 => {}
                _ => {}
            }
            index += 1;
        }
    }
}

fn indexed_simple_color(index: u16) -> SimpleColor {
    match index {
        0 | 7 => SimpleColor::White,
        1 => SimpleColor::Red,
        2 => SimpleColor::Green,
        3 => SimpleColor::Yellow,
        4 => SimpleColor::Blue,
        5 => SimpleColor::Magenta,
        6 => SimpleColor::Cyan,
        9..=15 => SimpleColor::BrightWhite,
        196..=199 => SimpleColor::BrightRed,
        208..=215 | 226..=231 => SimpleColor::BrightYellow,
        46..=51 | 82..=87 => SimpleColor::BrightGreen,
        21..=27 => SimpleColor::BrightBlue,
        200..=207 => SimpleColor::BrightMagenta,
        44..=45 | 122..=123 => SimpleColor::BrightCyan,
        _ => SimpleColor::Default,
    }
}

// ===========================================================================
// Backends
// ===========================================================================

enum Backend {
    Alacritty(AlacrittyBackend),
    Simple(SimpleBackend),
}

type EventLoopJoin = std::thread::JoinHandle<(
    EventLoop<tty::Pty, TerminalListener>,
    alacritty_terminal::event_loop::State,
)>;

struct AlacrittyBackend {
    term: Arc<FairMutex<Term<TerminalListener>>>,
    sender: EventLoopSender,
    /// Joined by a bounded background reaper after shutdown.
    join: Option<EventLoopJoin>,
}

struct SimpleBackend {
    parser: Arc<std::sync::Mutex<SimpleParser>>,
    writer: Box<dyn std::io::Write + Send>,
    child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
}

impl Drop for AlacrittyBackend {
    fn drop(&mut self) {
        let _ = self.sender.send(Msg::Shutdown);
        if let Some(join) = self.join.take() {
            // The alacritty Pty drop sends SIGHUP and waits for the direct
            // child. Never make the GPUI foreground wait on an uncooperative
            // shell; the dedicated reaper owns the join to completion.
            let _ = std::thread::Builder::new()
                .name("aiden-terminal-reaper".into())
                .spawn(move || {
                    let _ = join.join();
                });
        }
    }
}

impl Drop for SimpleBackend {
    fn drop(&mut self) {
        let process_group = self.child.as_ref().and_then(|child| child.process_id());
        terminate_process_group(process_group);
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = std::thread::Builder::new()
                .name("aiden-simple-terminal-reaper".into())
                .spawn(move || {
                    let _ = child.wait();
                });
        }
    }
}

#[cfg(unix)]
fn terminate_process_group(process_group: Option<u32>) {
    if let Some(process_group) = process_group.and_then(|id| i32::try_from(id).ok()) {
        // Each PTY starts a new session/process group. HUP the entire group so
        // grandchildren cannot outlive their workspace-owned terminal.
        unsafe {
            libc::kill(-process_group, libc::SIGHUP);
        }
    }
}

#[cfg(not(unix))]
fn terminate_process_group(_process_group: Option<u32>) {}

/// Terminal grid size used to size alacritty's `Term` (we size by pixels from
/// the element, so only columns/rows matter).
struct TermGridSize {
    columns: usize,
    screen_lines: usize,
}

impl Dimensions for TermGridSize {
    fn total_lines(&self) -> usize {
        self.screen_lines
    }

    fn screen_lines(&self) -> usize {
        self.screen_lines
    }

    fn columns(&self) -> usize {
        self.columns
    }
}

// ===========================================================================
// The drawer entity
// ===========================================================================

/// Configuration for the terminal session.
#[derive(Debug, Clone, Default)]
pub struct TerminalDeps {
    pub shell: Option<String>,
    pub cwd: Option<PathBuf>,
    /// Force the degraded portable-pty + ANSI-stripping backend.
    pub simple: bool,
}

impl TerminalDeps {
    #[allow(dead_code)] // standalone/demo scaffolding
    pub fn demo() -> Self {
        Self::default()
    }
}

struct TerminalSession {
    id: u64,
    owner_generation: u64,
    title: String,
    backend: Backend,
    focus: FocusHandle,
    _watcher: gpui::Task<()>,
}

pub struct TerminalDrawer {
    sessions: Vec<TerminalSession>,
    active_id: Option<u64>,
    layout: TerminalLayout,
    next_session_id: u64,
    owner_generation: u64,
    workspace_id: Option<String>,
    shell: Option<String>,
    cwd: Option<PathBuf>,
    simple: bool,
    config: Option<Arc<ConfigStore>>,
    pub(crate) open: bool,
    pub(crate) height: f32,
    drawer_error: Option<String>,
    pub(crate) input_focus: FocusHandle,
    drawer_focus: FocusHandle,
    resize_focus: FocusHandle,
    restore_toggle_focus: bool,
    #[cfg(test)]
    fail_spawn: bool,
    #[cfg(test)]
    spawn_attempts: usize,
}

impl Drop for TerminalDrawer {
    fn drop(&mut self) {
        // App/window teardown and process quit both release the retained
        // entity. Explicitly drop every backend here so owned PTYs begin
        // shutdown before the remaining focus/config state is destroyed.
        self.owner_generation = self.owner_generation.wrapping_add(1).max(1);
        self.sessions.clear();
    }
}

impl TerminalDrawer {
    pub(crate) fn new_owned(
        cx: &mut Context<Self>,
        deps: TerminalDeps,
        workspace_id: Option<String>,
        config: Option<Arc<ConfigStore>>,
    ) -> Self {
        let height = load_drawer_height(config.as_deref());
        Self {
            sessions: Vec::new(),
            active_id: None,
            layout: TerminalLayout::default(),
            next_session_id: 1,
            owner_generation: 1,
            workspace_id,
            shell: deps.shell,
            cwd: deps.cwd,
            simple: deps.simple,
            config,
            open: false,
            height,
            drawer_error: None,
            input_focus: cx.focus_handle(),
            drawer_focus: cx.focus_handle(),
            resize_focus: cx.focus_handle().tab_stop(true),
            restore_toggle_focus: false,
            #[cfg(test)]
            fail_spawn: false,
            #[cfg(test)]
            spawn_attempts: 0,
        }
    }

    fn create_session(&mut self, cx: &mut Context<Self>) -> Result<u64, String> {
        #[cfg(test)]
        {
            self.spawn_attempts += 1;
            if self.fail_spawn {
                return Err("The shell could not be started.".into());
            }
        }
        if self.sessions.len() >= MAX_SESSIONS {
            return Err(format!(
                "A workspace can have up to {MAX_SESSIONS} terminal sessions."
            ));
        }
        let shell = resolve_shell(self.shell.as_deref())?;
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<TerminalEvent>();
        let backend = if !self.simple {
            spawn_alacritty(Some(shell.clone()), self.cwd.clone(), tx.clone())
                .map(Backend::Alacritty)
        } else {
            None
        }
        .or_else(|| {
            spawn_simple(Some(shell), self.cwd.clone(), 80, tx)
                .ok()
                .map(Backend::Simple)
        })
        .ok_or_else(|| "The shell could not be started.".to_string())?;

        let id = self.next_session_id;
        self.next_session_id = self.next_session_id.wrapping_add(1).max(1);
        let owner_generation = self.owner_generation;
        let watcher = cx.spawn(async move |this, cx| {
            let mut rx = rx;
            while let Some(event) = rx.recv().await {
                this.update(cx, |this, cx| {
                    if this.owner_generation != owner_generation {
                        return;
                    }
                    let Some(index) = this.sessions.iter().position(|session| {
                        session.id == id && session.owner_generation == owner_generation
                    }) else {
                        return;
                    };
                    match event {
                        TerminalEvent::Update => cx.notify(),
                        TerminalEvent::Title(title) => {
                            this.sessions[index].title = title;
                            cx.notify();
                        }
                        TerminalEvent::ChildExit => this.remove_session(id, true, cx),
                    }
                })
                .ok();
            }
        });
        self.sessions.push(TerminalSession {
            id,
            owner_generation,
            title: "Terminal".into(),
            backend,
            focus: cx.focus_handle(),
            _watcher: watcher,
        });
        self.active_id = Some(id);
        self.drawer_error = None;
        Ok(id)
    }

    pub(crate) fn new_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match self.create_session(cx) {
            Ok(id) => {
                self.layout = TerminalLayout {
                    direction: SplitDirection::Single,
                    ids: vec![id],
                };
                self.open = true;
                self.focus_session(id, window);
            }
            Err(error) => self.drawer_error = Some(error),
        }
        cx.notify();
    }

    pub(crate) fn split(
        &mut self,
        direction: SplitDirection,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let visible_count = if self.layout.ids.is_empty() {
            usize::from(self.active_id.is_some())
        } else {
            self.layout.ids.len()
        };
        if visible_count >= MAX_PANES || direction == SplitDirection::Single {
            return;
        }
        let previous_active = self.active_id;
        match self.create_session(cx) {
            Ok(id) => {
                let _ = self.layout.append_split(previous_active, id, direction);
                self.open = true;
                self.focus_session(id, window);
            }
            Err(error) => self.drawer_error = Some(error),
        }
        cx.notify();
    }

    pub(crate) fn select_session(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        if self.sessions.iter().any(|session| session.id == id) {
            self.active_id = Some(id);
            self.layout.select(id);
            self.focus_session(id, window);
            cx.notify();
        }
    }

    pub(crate) fn close_session(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        self.remove_session(id, true, cx);
        if let Some(active_id) = self.active_id {
            self.focus_session(active_id, window);
        }
    }

    fn remove_session(&mut self, id: u64, choose_fallback: bool, cx: &mut Context<Self>) {
        self.sessions.retain(|session| session.id != id);
        self.layout.remove(id);
        let session_ids = self
            .sessions
            .iter()
            .map(|session| session.id)
            .collect::<Vec<_>>();
        self.active_id = fallback_after_session_removal(
            self.active_id,
            id,
            &self.layout.ids,
            &session_ids,
            choose_fallback,
        );
        if self.layout.ids.is_empty() {
            self.layout.ids = self.active_id.into_iter().collect();
        }
        cx.notify();
    }

    pub(crate) fn clear_active_view(&mut self, cx: &mut Context<Self>) {
        let Some(session) = self
            .active_id
            .and_then(|id| self.sessions.iter_mut().find(|session| session.id == id))
        else {
            return;
        };
        match &mut session.backend {
            Backend::Alacritty(backend) => backend.term.lock_unfair().grid_mut().clear_viewport(),
            Backend::Simple(backend) => {
                if let Ok(mut parser) = backend.parser.lock() {
                    parser.clear_screen();
                }
            }
        }
        cx.notify();
    }

    pub fn toggle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.open {
            self.restore_toggle_focus = self.drawer_focus.contains_focused(window, cx);
            self.open = false;
        } else {
            if self.sessions.is_empty() && self.drawer_error.is_none() {
                if let Err(error) = self.create_session(cx) {
                    tracing::warn!(%error, "failed to start terminal shell");
                    self.drawer_error = Some(
                        "The shell could not be started. Check your shell and workspace, then try again."
                            .into(),
                    );
                    self.restore_toggle_focus = false;
                    self.open = true;
                    cx.notify();
                    return;
                }
            }
            if self.layout.ids.is_empty() {
                self.layout.ids = self.active_id.into_iter().collect();
            }
            self.restore_toggle_focus = false;
            self.open = true;
            let focus = self
                .active_id
                .and_then(|id| self.sessions.iter().find(|session| session.id == id))
                .map(|session| session.focus.clone())
                .unwrap_or_else(|| self.input_focus.clone());
            cx.defer_in(window, move |_this, window, _cx| {
                focus.focus(window);
            });
        }
        cx.notify();
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    pub(crate) fn should_restore_toggle_focus(&self) -> bool {
        self.restore_toggle_focus
    }

    fn focus_session(&self, id: u64, window: &mut Window) {
        if let Some(session) = self.sessions.iter().find(|session| session.id == id) {
            session.focus.focus(window);
        }
    }

    /// Tear down all workspace-owned PTYs before accepting a new workspace.
    pub fn set_cwd(&mut self, cwd: PathBuf, cx: &mut Context<Self>) {
        self.owner_generation = self.owner_generation.wrapping_add(1).max(1);
        self.sessions.clear();
        self.active_id = None;
        self.layout = TerminalLayout::default();
        self.cwd = Some(cwd);
        self.open = false;
        self.drawer_error = None;
        cx.notify();
    }

    pub(crate) fn set_workspace(
        &mut self,
        workspace_id: String,
        cwd: PathBuf,
        cx: &mut Context<Self>,
    ) {
        if self.workspace_id.as_deref() == Some(workspace_id.as_str())
            && self.cwd.as_ref() == Some(&cwd)
        {
            return;
        }
        self.workspace_id = Some(workspace_id);
        self.set_cwd(cwd, cx);
    }

    pub(crate) fn clear_workspace(&mut self, cx: &mut Context<Self>) {
        if self.workspace_id.is_none()
            && self.cwd.is_none()
            && self.sessions.is_empty()
            && self.active_id.is_none()
            && self.layout.ids.is_empty()
            && !self.open
            && self.drawer_error.is_none()
        {
            return;
        }
        self.owner_generation = self.owner_generation.wrapping_add(1).max(1);
        self.sessions.clear();
        self.active_id = None;
        self.layout = TerminalLayout::default();
        self.workspace_id = None;
        self.cwd = None;
        self.open = false;
        self.drawer_error = None;
        self.restore_toggle_focus = false;
        cx.notify();
    }

    pub(crate) fn set_height(&mut self, height: f32, viewport_height: f32, cx: &mut Context<Self>) {
        self.height = clamp_drawer_height(height, viewport_height);
        cx.notify();
    }

    pub(crate) fn persist_height(&self, cx: &mut App) {
        if let Some(config) = self.config.clone() {
            persist_drawer_height(config, self.height, cx);
        }
    }

    /// Send bytes to the pty.
    pub fn write_bytes(&mut self, bytes: &[u8]) {
        let Some(session) = self
            .active_id
            .and_then(|id| self.sessions.iter_mut().find(|session| session.id == id))
        else {
            return;
        };
        let bytes = &bytes[..bytes.len().min(MAX_INPUT_BYTES)];
        match &mut session.backend {
            Backend::Alacritty(backend) => {
                let _ = backend.sender.send(Msg::Input(bytes.to_vec().into()));
            }
            Backend::Simple(backend) => {
                let _ = backend.writer.write_all(bytes);
            }
        }
    }

    /// Route one keystroke to the shell; Escape hides the drawer.
    pub fn handle_input(
        &mut self,
        key: &str,
        key_char: Option<&str>,
        modifiers: &gpui::Modifiers,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if key == "escape" {
            self.restore_toggle_focus = self.drawer_focus.contains_focused(_window, cx);
            self.open = false;
            cx.notify();
            return;
        }
        if let Some(bytes) = keystroke_bytes(key, key_char, modifiers) {
            self.write_bytes(&bytes);
        }
    }
}

/// Translate a keystroke into pty bytes (terminal escape conventions).
pub fn keystroke_bytes(
    key: &str,
    key_char: Option<&str>,
    modifiers: &gpui::Modifiers,
) -> Option<Vec<u8>> {
    let control = modifiers.control;
    let alt = modifiers.alt;
    let shift = modifiers.shift;
    let platform = modifiers.platform;

    let basic = match key {
        "enter" | "secondary-enter" => Some(b"\r".to_vec()),
        "backspace" => Some(b"\x7f".to_vec()),
        "tab" if !shift => Some(b"\t".to_vec()),
        "tab" => Some(b"\x1b[Z".to_vec()),
        "up" => Some(b"\x1b[A".to_vec()),
        "down" => Some(b"\x1b[B".to_vec()),
        "right" => Some(b"\x1b[C".to_vec()),
        "left" => Some(b"\x1b[D".to_vec()),
        "home" => Some(b"\x1b[H".to_vec()),
        "end" => Some(b"\x1b[F".to_vec()),
        "pageup" => Some(b"\x1b[5~".to_vec()),
        "pagedown" => Some(b"\x1b[6~".to_vec()),
        "delete" => Some(b"\x1b[3~".to_vec()),
        _ => None,
    };
    if let Some(bytes) = basic {
        return Some(bytes);
    }

    if control && !platform {
        if let Some(character) = key_char.and_then(|value| value.chars().next()) {
            if character.is_ascii_alphabetic() {
                return Some(vec![character.to_ascii_lowercase() as u8 - b'a' + 1]);
            }
        }
        return match key {
            "[" => Some(vec![0x1b]),
            "\\" => Some(vec![0x1c]),
            "]" => Some(vec![0x1d]),
            "6" => Some(vec![0x1e]),
            "2" => Some(vec![0x00]),
            "3" => Some(vec![0x1f]),
            _ => None,
        };
    }

    if let Some(character) = key_char {
        if platform {
            // Command-key combinations belong to the app, not the shell.
            return None;
        }
        let character_bytes = character.as_bytes();
        if character_bytes
            .iter()
            .all(|byte| *byte >= 0x20 || *byte == b'\t')
        {
            let mut bytes = character_bytes.to_vec();
            if alt && !control {
                bytes.insert(0, 0x1b);
            }
            return Some(bytes);
        }
    }
    None
}

// ===========================================================================
// Backend spawners
// ===========================================================================

fn resolve_shell(requested: Option<&str>) -> Result<String, String> {
    let mut candidates = Vec::new();
    if let Some(requested) = requested {
        candidates.push(requested.to_string());
    } else if let Ok(shell) = std::env::var("SHELL") {
        candidates.push(shell);
    }
    candidates.extend(["/bin/zsh".into(), "/bin/bash".into(), "/bin/sh".into()]);
    candidates
        .into_iter()
        .find(|candidate| shell_is_executable(Path::new(candidate)))
        .ok_or_else(|| "No supported executable shell is available.".to_string())
}

#[cfg(unix)]
fn shell_is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;

    path.is_absolute()
        && std::fs::metadata(path)
            .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

#[cfg(not(unix))]
fn shell_is_executable(path: &Path) -> bool {
    path.is_absolute() && path.is_file()
}

fn spawn_alacritty(
    shell: Option<String>,
    cwd: Option<PathBuf>,
    tx: tokio::sync::mpsc::UnboundedSender<TerminalEvent>,
) -> Option<AlacrittyBackend> {
    let listener = TerminalListener { tx };
    let size = TermGridSize {
        columns: 80,
        screen_lines: 24,
    };
    let term = Term::new(Config::default(), &size, listener.clone());
    let term = Arc::new(FairMutex::new(term));

    let pty_options = PtyOptions {
        shell: shell.map(|program| Shell::new(program, Vec::new())),
        working_directory: cwd,
        ..PtyOptions::default()
    };
    let pty = tty::new(
        &pty_options,
        WindowSize {
            num_lines: 24,
            num_cols: 80,
            cell_width: 7,
            cell_height: 14,
        },
        0,
    )
    .ok()?;
    let event_loop = EventLoop::new(term.clone(), listener, pty, false, false).ok()?;
    let sender = event_loop.channel();
    let join = event_loop.spawn();
    Some(AlacrittyBackend {
        term,
        sender,
        join: Some(join),
    })
}

fn spawn_simple(
    shell: Option<String>,
    cwd: Option<PathBuf>,
    cols: usize,
    tx: tokio::sync::mpsc::UnboundedSender<TerminalEvent>,
) -> Result<SimpleBackend, String> {
    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(portable_pty::PtySize {
            rows: 24,
            cols: cols as u16,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;

    let program =
        shell.unwrap_or_else(|| std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()));
    let mut command = portable_pty::CommandBuilder::new(&program);
    if let Some(cwd) = cwd {
        command.cwd(cwd);
    }
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| error.to_string())?;

    let parser = Arc::new(std::sync::Mutex::new(SimpleParser::new(cols, 2_000)));
    let thread_parser = parser.clone();
    std::thread::Builder::new()
        .name("aiden-simple-pty".to_string())
        .spawn(move || {
            let mut buffer = [0u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => {
                        let _ = tx.send(TerminalEvent::ChildExit);
                        break;
                    }
                    Ok(n) => {
                        if let Ok(mut parser) = thread_parser.lock() {
                            let _ = parser.feed(&buffer[..n]);
                        }
                        let _ = tx.send(TerminalEvent::Update);
                    }
                }
            }
        })
        .map_err(|error| error.to_string())?;

    Ok(SimpleBackend {
        parser,
        writer,
        child: Some(child),
    })
}

// ===========================================================================
// Custom element painting the alacritty grid
// ===========================================================================

struct CellSnapshot {
    character: char,
    fg: Color,
    bg: Color,
    flags: Flags,
}

struct RowSnapshot {
    text: String,
    runs: Vec<TextRun>,
}

/// Theme-derived ANSI palette (16 colors + indexed/rgb truecolor).
struct AnsiPalette {
    base: [Hsla; 16],
    default_fg: Hsla,
    default_bg: Hsla,
}

impl AnsiPalette {
    fn from_theme(theme: &gpui_component::Theme) -> Self {
        let base_hues = [
            theme.muted,
            theme.danger,
            theme.success,
            theme.warning,
            theme.info,
            theme.accent,
            theme.link,
            theme.muted_foreground,
        ];
        let mut base = [Hsla::default(); 16];
        for index in 0..8 {
            base[index] = base_hues[index];
            // Bright variants: lift the lightness toward the foreground.
            base[index + 8] = mix(base_hues[index], theme.foreground, 0.55);
        }
        Self {
            base,
            default_fg: theme.foreground,
            default_bg: theme.transparent,
        }
    }

    fn resolve(&self, color: Color) -> Hsla {
        use alacritty_terminal::vte::ansi::NamedColor;
        match color {
            Color::Named(named) => match named {
                NamedColor::Foreground => self.default_fg,
                NamedColor::Background => self.default_bg,
                NamedColor::Cursor => self.default_bg,
                NamedColor::BrightForeground => self.base[15],
                NamedColor::DimForeground => self.default_fg.opacity(0.65),
                NamedColor::Black => self.base[0],
                NamedColor::Red => self.base[1],
                NamedColor::Green => self.base[2],
                NamedColor::Yellow => self.base[3],
                NamedColor::Blue => self.base[4],
                NamedColor::Magenta => self.base[5],
                NamedColor::Cyan => self.base[6],
                NamedColor::White => self.base[7],
                NamedColor::BrightBlack => self.base[8],
                NamedColor::BrightRed => self.base[9],
                NamedColor::BrightGreen => self.base[10],
                NamedColor::BrightYellow => self.base[11],
                NamedColor::BrightBlue => self.base[12],
                NamedColor::BrightMagenta => self.base[13],
                NamedColor::BrightCyan => self.base[14],
                NamedColor::BrightWhite => self.base[15],
                NamedColor::DimBlack => self.base[0].opacity(0.65),
                NamedColor::DimRed => self.base[1].opacity(0.65),
                NamedColor::DimGreen => self.base[2].opacity(0.65),
                NamedColor::DimYellow => self.base[3].opacity(0.65),
                NamedColor::DimBlue => self.base[4].opacity(0.65),
                NamedColor::DimMagenta => self.base[5].opacity(0.65),
                NamedColor::DimCyan => self.base[6].opacity(0.65),
                NamedColor::DimWhite => self.base[7].opacity(0.65),
            },
            Color::Spec(rgb) => Hsla::from(Rgba {
                r: rgb.r as f32 / 255.0,
                g: rgb.g as f32 / 255.0,
                b: rgb.b as f32 / 255.0,
                a: 1.0,
            }),
            Color::Indexed(index) => match index {
                0 => self.base[0],
                1 => self.base[4],
                2 => self.base[2],
                3 => self.base[6],
                4 => self.base[1],
                5 => self.base[5],
                6 => self.base[3],
                7 => self.base[7],
                8 => self.base[8],
                9..=15 => self.base[index as usize],
                16..=231 => {
                    let value = index - 16;
                    let channel = |component: u32| {
                        if component == 0 {
                            0.0
                        } else {
                            (55 + component * 40) as f32 / 255.0
                        }
                    };
                    Hsla::from(Rgba {
                        r: channel(((value / 36) % 6) as u32),
                        g: channel(((value / 6) % 6) as u32),
                        b: channel((value % 6) as u32),
                        a: 1.0,
                    })
                }
                232..=255 => {
                    let level = (index - 232) as f32 / 23.0;
                    Hsla::from(Rgba {
                        r: level,
                        g: level,
                        b: level,
                        a: 1.0,
                    })
                }
            },
        }
    }
}

pub(crate) struct TerminalElement {
    id: ElementId,
    term: Arc<FairMutex<Term<TerminalListener>>>,
    sender: EventLoopSender,
    /// (columns, rows) used for the last grid snapshot.
    dims: (usize, usize),
    cell_width: f32,
    line_height: f32,
    accent: Hsla,
}

pub(crate) struct TerminalLayoutState {
    rows: Vec<RowSnapshot>,
    /// (row, col, color) for non-default cell backgrounds + the cursor cell.
    backgrounds: Vec<(usize, usize, Hsla)>,
    cursor: Option<(usize, usize)>,
    row_width: f32,
}

pub(crate) struct TerminalPaintState {}

impl IntoElement for TerminalElement {
    type Element = Self;
    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for TerminalElement {
    type RequestLayoutState = TerminalLayoutState;
    type PrepaintState = TerminalPaintState;

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        global_id: Option<&gpui::GlobalElementId>,
        inspector_id: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut gpui::App,
    ) -> (gpui::LayoutId, Self::RequestLayoutState) {
        let theme = cx.theme().clone();
        let (cols, rows) = self.dims;

        // Snapshot the visible grid under the term lock.
        let mut cell_grid: Vec<Vec<CellSnapshot>> = Vec::new();
        let mut cursor = None;
        {
            let term = self.term.lock_unfair();
            let screen_lines = term.screen_lines().min(rows);
            let columns = term.columns().min(cols);
            for _ in 0..screen_lines {
                cell_grid.push(Vec::new());
            }
            let content = term.renderable_content();
            let show_cursor = content.mode.contains(TermMode::SHOW_CURSOR);
            let cursor_line = content.cursor.point.line.0;
            let cursor_column = content.cursor.point.column.0;
            for indexed in content.display_iter {
                let line = indexed.point.line.0;
                let column = indexed.point.column.0;
                if line < 0 || (line as usize) >= screen_lines || column >= columns {
                    continue;
                }
                let cell = indexed.cell;
                cell_grid[line as usize].push(CellSnapshot {
                    character: cell.c,
                    fg: cell.fg,
                    bg: cell.bg,
                    flags: cell.flags,
                });
            }
            if show_cursor
                && cursor_line >= 0
                && (cursor_line as usize) < screen_lines
                && cursor_column < columns
            {
                cursor = Some((cursor_line as usize, cursor_column));
            }
        }

        // Build per-row text + styled runs.
        let palette = AnsiPalette::from_theme(&theme);
        let mut text_style = window.text_style();
        text_style.font_family = theme.mono_font_family.clone();
        let mut rows_data = Vec::new();
        let mut backgrounds = Vec::new();
        for (row_index, cells) in cell_grid.iter().enumerate() {
            let mut text = String::new();
            let mut runs = Vec::new();
            for cell in cells {
                let bg = palette.resolve(cell.bg);
                if !is_transparent(&bg) {
                    backgrounds.push((row_index, text.len(), bg));
                }
                let fg = palette.resolve(cell.fg);
                let mut style = text_style.clone();
                style.color = if cell.flags.contains(Flags::INVERSE) {
                    if is_transparent(&bg) {
                        self.default_bg(&theme)
                    } else {
                        bg
                    }
                } else {
                    fg
                };
                if cell.flags.contains(Flags::BOLD) {
                    style.font_weight = FontWeight::BOLD;
                }
                if cell.flags.contains(Flags::ITALIC) {
                    style.font_style = gpui::FontStyle::Italic;
                }
                if cell.flags.contains(Flags::DIM) {
                    style.color = style.color.opacity(0.65);
                }
                runs.push(style.to_run(1));
                text.push(if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    ' '
                } else {
                    cell.character
                });
            }
            rows_data.push(RowSnapshot { text, runs });
        }

        // Request the layout of each row's styled text, positioned absolutely.
        let mut child_ids = Vec::new();
        for (row_index, row) in rows_data.iter_mut().enumerate() {
            if row.text.is_empty() {
                continue;
            }
            let mut styled =
                gpui::StyledText::new(row.text.clone()).with_runs(std::mem::take(&mut row.runs));
            let (text_id, _) = styled.request_layout(global_id, inspector_id, window, cx);
            let wrapper_id = window.request_layout(
                Style {
                    position: gpui::Position::Absolute,
                    inset: gpui::Edges {
                        top: px(row_index as f32 * self.line_height).into(),
                        right: px(0.).into(),
                        bottom: px(0.).into(),
                        left: px(0.).into(),
                    },
                    size: gpui_size(px(TERMINAL_ROW_WIDTH).into(), px(self.line_height).into()),
                    ..Style::default()
                },
                vec![text_id],
                cx,
            );
            child_ids.push(wrapper_id);
        }

        let layout_id = window.request_layout(
            Style {
                flex_grow: 1.0,
                size: gpui_size(relative(1.0).into(), relative(1.0).into()),
                ..Style::default()
            },
            child_ids,
            cx,
        );

        (
            layout_id,
            TerminalLayoutState {
                rows: rows_data,
                backgrounds,
                cursor,
                row_width: 640.0,
            },
        )
    }

    fn prepaint(
        &mut self,
        global_id: Option<&gpui::GlobalElementId>,
        inspector_id: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        state: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut gpui::App,
    ) -> Self::PrepaintState {
        // Recompute the grid size from the actual bounds and resize the pty
        // when the drawer changed size.
        let width_f32: f32 = bounds.size.width.into();
        let height_f32: f32 = bounds.size.height.into();
        let cols = ((width_f32 / self.cell_width).floor() as usize).clamp(MIN_COLUMNS, MAX_COLUMNS);
        let rows = ((height_f32 / self.line_height).floor() as usize).clamp(MIN_ROWS, MAX_ROWS);
        if (cols, rows) != self.dims {
            self.dims = (cols, rows);
            {
                let mut term = self.term.lock_unfair();
                term.resize(TermGridSize {
                    columns: cols,
                    screen_lines: rows,
                });
            }
            let _ = self.sender.send(Msg::Resize(WindowSize {
                num_lines: rows as u16,
                num_cols: cols as u16,
                cell_width: self.cell_width as u16,
                cell_height: self.line_height as u16,
            }));
            // Repaint next frame so request_layout picks up the new dims.
            window.request_animation_frame();
        }

        state.row_width = bounds.size.width.into();

        // Prepaint each row text at its grid position.
        for (row_index, row) in state.rows.iter_mut().enumerate() {
            if row.text.is_empty() {
                continue;
            }
            let row_bounds = Bounds::new(
                point(px(0.), px(row_index as f32 * self.line_height)),
                gpui_size(px(state.row_width), px(self.line_height)),
            );
            let mut styled =
                gpui::StyledText::new(row.text.clone()).with_runs(std::mem::take(&mut row.runs));
            styled.prepaint(global_id, inspector_id, row_bounds, &mut (), window, cx);
        }

        // Scroll wheel over the terminal adjusts the grid viewport.
        window.on_mouse_event({
            let term = self.term.clone();
            move |event: &ScrollWheelEvent, _phase, window, cx| {
                if let ScrollDelta::Lines(delta) = event.delta {
                    let lines = delta.y.round() as i32;
                    if lines != 0 {
                        term.lock_unfair().scroll_display(Scroll::Delta(lines));
                        window.request_animation_frame();
                        cx.stop_propagation();
                    }
                }
            }
        });

        TerminalPaintState {}
    }

    fn paint(
        &mut self,
        global_id: Option<&gpui::GlobalElementId>,
        inspector_id: Option<&gpui::InspectorElementId>,
        _bounds: Bounds<Pixels>,
        state: &mut Self::RequestLayoutState,
        _paint_state: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut gpui::App,
    ) {
        // Paint non-default cell backgrounds.
        for (row, column, color) in &state.backgrounds {
            let cell = Bounds::new(
                point(
                    px(*column as f32 * self.cell_width),
                    px(*row as f32 * self.line_height),
                ),
                gpui_size(px(self.cell_width), px(self.line_height)),
            );
            window.paint_quad(gpui::quad(
                cell,
                px(0.),
                *color,
                gpui::Edges::all(px(0.)),
                gpui::Hsla::default(),
                gpui::BorderStyle::Solid,
            ));
        }
        // Paint the cursor block.
        if let Some((row, column)) = state.cursor {
            let cell = Bounds::new(
                point(
                    px(column as f32 * self.cell_width),
                    px(row as f32 * self.line_height),
                ),
                gpui_size(px(self.cell_width), px(self.line_height)),
            );
            window.paint_quad(gpui::quad(
                cell,
                px(0.),
                self.accent.opacity(0.22),
                gpui::Edges::all(px(0.)),
                gpui::Hsla::default(),
                gpui::BorderStyle::Solid,
            ));
        }

        // Paint each row's text.
        for (row_index, row) in state.rows.iter_mut().enumerate() {
            if row.text.is_empty() {
                continue;
            }
            let row_bounds = Bounds::new(
                point(px(0.), px(row_index as f32 * self.line_height)),
                gpui_size(px(state.row_width), px(self.line_height)),
            );
            let mut styled =
                gpui::StyledText::new(row.text.clone()).with_runs(std::mem::take(&mut row.runs));
            styled.paint(
                global_id,
                inspector_id,
                row_bounds,
                &mut (),
                &mut (),
                window,
                cx,
            );
        }
        let _ = cx;
    }
}

/// Rows are laid out at this width so a single logical line never wraps.
const TERMINAL_ROW_WIDTH: f32 = 4096.0;

impl TerminalElement {
    fn default_bg(&self, theme: &gpui_component::Theme) -> Hsla {
        theme.background
    }
}

fn is_transparent(color: &Hsla) -> bool {
    color.a <= 0.001
}

fn mix(left: Hsla, right: Hsla, amount: f32) -> Hsla {
    Hsla {
        h: left.h + (right.h - left.h) * amount,
        s: left.s + (right.s - left.s) * amount,
        l: left.l + (right.l - left.l) * amount,
        a: left.a + (right.a - left.a) * amount,
    }
}

// ===========================================================================
// Render
// ===========================================================================

#[derive(Clone)]
struct TerminalResizeDrag {
    start_height: f32,
    start_y: Rc<Cell<Option<f32>>>,
}

struct TerminalResizeDragView;

impl Render for TerminalResizeDragView {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_0()
    }
}

fn pointer_resized_height(
    start_height: f32,
    start_y: f32,
    current_y: f32,
    viewport_height: f32,
) -> f32 {
    clamp_drawer_height(start_height + start_y - current_y, viewport_height)
}

impl Render for TerminalDrawer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let viewport_height: f32 = window.viewport_size().height.into();
        self.height = clamp_drawer_height(self.height, viewport_height);
        let height = px(self.height);
        let tabs = self
            .sessions
            .iter()
            .enumerate()
            .map(|(index, session)| {
                (
                    session.id,
                    index + 1,
                    session.title.clone(),
                    self.active_id == Some(session.id),
                )
            })
            .collect::<Vec<_>>();
        let mut tab_elements = Vec::with_capacity(tabs.len());
        for (id, number, title, selected) in tabs {
            let mut tab = h_flex()
                .id(SharedString::from(format!("terminal-tab-{id}")))
                .h(px(28.))
                .px_1()
                .gap_1()
                .items_center()
                .rounded_md()
                .border_1()
                .border_color(if selected {
                    theme.border
                } else {
                    theme.transparent
                })
                .text_color(if selected {
                    theme.foreground
                } else {
                    theme.muted_foreground
                });
            if selected {
                tab = tab.bg(theme.secondary);
            }
            tab_elements.push(
                tab.child(
                    Button::new(SharedString::from(format!("terminal-select-{id}")))
                        .ghost()
                        .xsmall()
                        .icon(IconName::SquareTerminal)
                        .label(terminal_tab_label(number))
                        .tooltip(title)
                        .on_click(cx.listener(move |this, _event, window, cx| {
                            this.select_session(id, window, cx);
                        })),
                )
                .child(
                    Button::new(SharedString::from(format!("terminal-close-{id}")))
                        .ghost()
                        .xsmall()
                        .icon(IconName::Close)
                        .tooltip(format!("Close Terminal {number}"))
                        .on_click(cx.listener(move |this, _event, window, cx| {
                            this.close_session(id, window, cx);
                        })),
                )
                .into_any_element(),
            );
        }

        let visible_ids = if self.layout.ids.is_empty() {
            self.active_id.into_iter().collect::<Vec<_>>()
        } else {
            self.layout
                .ids
                .iter()
                .copied()
                .filter(|id| self.sessions.iter().any(|session| session.id == *id))
                .collect::<Vec<_>>()
        };
        let can_split = visible_ids.len() < MAX_PANES && !self.sessions.is_empty();
        let mut panes = Vec::with_capacity(visible_ids.len());
        for id in visible_ids {
            let Some(session) = self.sessions.iter().find(|session| session.id == id) else {
                continue;
            };
            let pane_focus = session.focus.clone();
            let selected = self.active_id == Some(id);
            let surface = self.terminal_surface(id, window, cx);
            panes.push(
                div()
                    .id(SharedString::from(format!("terminal-pane-{id}")))
                    .relative()
                    .min_w(px(0.))
                    .min_h(px(0.))
                    .flex_1()
                    .overflow_hidden()
                    .bg(theme.background)
                    .border_1()
                    .border_color(if selected {
                        theme.accent.opacity(0.35)
                    } else {
                        theme.transparent
                    })
                    .focusable()
                    .track_focus(&pane_focus)
                    .on_mouse_down(
                        gpui::MouseButton::Left,
                        cx.listener(move |this, _event, window, cx| {
                            this.select_session(id, window, cx);
                        }),
                    )
                    .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                        this.handle_input(
                            &event.keystroke.key,
                            event.keystroke.key_char.as_deref(),
                            &event.keystroke.modifiers,
                            window,
                            cx,
                        );
                    }))
                    .child(surface)
                    .into_any_element(),
            );
        }

        let body =
            if panes.is_empty() {
                v_flex()
                    .id("terminal-empty")
                    .flex_1()
                    .min_h(px(0.))
                    .items_center()
                    .justify_center()
                    .gap_2()
                    .child(div().text_sm().text_color(theme.muted_foreground).child(
                        self.drawer_error.clone().unwrap_or_else(|| {
                            "Open a terminal tab to work in this workspace.".into()
                        }),
                    ))
                    .child(
                        Button::new("terminal-empty-new")
                            .primary()
                            .small()
                            .icon(IconName::Plus)
                            .label("New terminal")
                            .disabled(self.sessions.len() >= MAX_SESSIONS)
                            .on_click(cx.listener(|this, _event, window, cx| {
                                this.new_terminal(window, cx);
                            })),
                    )
                    .into_any_element()
            } else {
                match self.layout.direction {
                    SplitDirection::Vertical => v_flex()
                        .id("terminal-panes")
                        .flex_1()
                        .min_h(px(0.))
                        .min_w(px(0.))
                        .gap(px(1.))
                        .bg(theme.border)
                        .children(panes)
                        .into_any_element(),
                    SplitDirection::Single | SplitDirection::Horizontal => h_flex()
                        .id("terminal-panes")
                        .flex_1()
                        .min_h(px(0.))
                        .min_w(px(0.))
                        .gap(px(1.))
                        .bg(theme.border)
                        .children(panes)
                        .into_any_element(),
                }
            };

        let resize_drag = TerminalResizeDrag {
            start_height: self.height,
            start_y: Rc::new(Cell::new(None)),
        };
        let drawer = cx.weak_entity();
        let resize_focus_color = theme.accent.opacity(0.25);
        let resize_handle = div()
            .id("terminal-resize-separator")
            .absolute()
            .top_0()
            .left_0()
            .right_0()
            .h(px(8.))
            .cursor_row_resize()
            .track_focus(&self.resize_focus)
            .tab_stop(true)
            .focus(move |style| style.bg(resize_focus_color))
            .on_mouse_down(gpui::MouseButton::Left, |_event, _window, cx| {
                cx.stop_propagation();
            })
            .on_drag(resize_drag, |drag, position, _window, cx| {
                drag.start_y.set(Some(position.y.into()));
                cx.stop_propagation();
                cx.new(|_| TerminalResizeDragView)
            })
            .on_drag_move({
                let drawer = drawer.clone();
                move |event: &gpui::DragMoveEvent<TerminalResizeDrag>, window, cx| {
                    let drag = event.drag(cx);
                    let Some(start_y) = drag.start_y.get() else {
                        return;
                    };
                    let current_y: f32 = event.event.position.y.into();
                    let viewport_height: f32 = window.viewport_size().height.into();
                    let height = pointer_resized_height(
                        drag.start_height,
                        start_y,
                        current_y,
                        viewport_height,
                    );
                    let _ = drawer.update(cx, |this, cx| {
                        this.set_height(height, viewport_height, cx);
                    });
                }
            })
            .on_mouse_up(gpui::MouseButton::Left, {
                let drawer = drawer.clone();
                move |_event, _window, cx| {
                    let _ = drawer.update(cx, |this, cx| this.persist_height(cx));
                }
            })
            .on_mouse_up_out(gpui::MouseButton::Left, {
                let drawer = drawer.clone();
                move |_event, _window, cx| {
                    let _ = drawer.update(cx, |this, cx| this.persist_height(cx));
                }
            })
            .on_key_down({
                let drawer = drawer.clone();
                move |event: &gpui::KeyDownEvent, window, cx| {
                    let viewport_height: f32 = window.viewport_size().height.into();
                    let key = event.keystroke.key.clone();
                    let shift = event.keystroke.modifiers.shift;
                    let changed = drawer
                        .update(cx, |this, cx| {
                            let Some(height) =
                                keyboard_resize_height(this.height, &key, shift, viewport_height)
                            else {
                                return false;
                            };
                            this.set_height(height, viewport_height, cx);
                            this.persist_height(cx);
                            true
                        })
                        .unwrap_or(false);
                    if changed {
                        cx.stop_propagation();
                    }
                }
            });

        v_flex()
            .id("terminal-drawer")
            .relative()
            .w_full()
            .bg(theme.popover)
            .border_t_1()
            .border_color(theme.border)
            .h(height)
            .track_focus(&self.drawer_focus)
            .child(
                h_flex()
                    .id("terminal-header")
                    .w_full()
                    .h(px(44.))
                    .px_3()
                    .gap_1()
                    .items_center()
                    .border_b_1()
                    .border_color(theme.border)
                    .child(
                        h_flex()
                            .id("terminal-tabs")
                            .min_w(px(0.))
                            .flex_1()
                            .gap_1()
                            .overflow_x_scroll()
                            .children(tab_elements)
                            .child(
                                Button::new("terminal-new")
                                    .ghost()
                                    .xsmall()
                                    .icon(IconName::Plus)
                                    .tooltip("New terminal tab")
                                    .disabled(self.sessions.len() >= MAX_SESSIONS)
                                    .on_click(cx.listener(|this, _event, window, cx| {
                                        this.new_terminal(window, cx);
                                    })),
                            ),
                    )
                    .child(
                        Button::new("terminal-split-horizontal")
                            .ghost()
                            .xsmall()
                            .icon(IconName::PanelRight)
                            .tooltip("Split terminal horizontally")
                            .disabled(!can_split)
                            .on_click(cx.listener(|this, _event, window, cx| {
                                this.split(SplitDirection::Horizontal, window, cx);
                            })),
                    )
                    .child(
                        Button::new("terminal-split-vertical")
                            .ghost()
                            .xsmall()
                            .icon(IconName::PanelBottom)
                            .tooltip("Split terminal vertically")
                            .disabled(!can_split)
                            .on_click(cx.listener(|this, _event, window, cx| {
                                this.split(SplitDirection::Vertical, window, cx);
                            })),
                    )
                    .child(
                        Button::new("terminal-clear")
                            .ghost()
                            .xsmall()
                            .icon(IconName::Minus)
                            .tooltip("Clear terminal view")
                            .disabled(self.active_id.is_none())
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.clear_active_view(cx);
                            })),
                    )
                    .child(
                        Button::new("terminal-hide")
                            .ghost()
                            .xsmall()
                            .icon(IconName::PanelBottomOpen)
                            .tooltip("Hide terminal (Esc)")
                            .on_click(cx.listener(|this, _event, window, cx| {
                                this.toggle(window, cx);
                            })),
                    ),
            )
            .child(body)
            .child(resize_handle)
    }
}

impl TerminalDrawer {
    fn terminal_surface(
        &self,
        session_id: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = cx.theme().clone();
        let active_session = self
            .sessions
            .iter()
            .find(|session| session.id == session_id);
        if let Some(error) = self.drawer_error.as_ref() {
            return v_flex()
                .id("terminal-error")
                .size_full()
                .items_center()
                .justify_center()
                .gap_1()
                .child(
                    Icon::new(IconName::TriangleAlert)
                        .small()
                        .text_color(theme.danger),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.foreground)
                        .child("The shell could not be started."),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(error.clone()),
                )
                .into_any_element();
        }

        match active_session.map(|session| &session.backend) {
            Some(Backend::Alacritty(backend)) => {
                let cell_metrics = cell_metrics(window, cx);
                TerminalElement {
                    id: ElementId::Name(SharedString::from(format!("terminal-grid-{session_id}"))),
                    term: backend.term.clone(),
                    sender: backend.sender.clone(),
                    dims: (80, 24),
                    cell_width: cell_metrics.0,
                    line_height: cell_metrics.1,
                    accent: theme.accent,
                }
                .into_any_element()
            }
            Some(Backend::Simple(_)) => {
                let lines = self.simple_lines_for(session_id);
                let row_height = 16.0_f32;
                let visible = (self.height / row_height).floor() as usize;
                v_flex()
                    .id("terminal-simple")
                    .size_full()
                    .overflow_y_scroll()
                    .font_family(theme.mono_font_family.clone())
                    .children(lines.into_iter().take(visible.max(1)).map(|line| {
                        if line.text.is_empty() {
                            div().h(px(row_height)).child(" ").into_any_element()
                        } else {
                            div()
                                .h(px(row_height))
                                .text_xs()
                                .text_color(theme.foreground)
                                .child(line.text)
                                .into_any_element()
                        }
                    }))
                    .into_any_element()
            }
            None => v_flex()
                .id("terminal-idle")
                .size_full()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child("Terminal is ready."),
                )
                .into_any_element(),
        }
    }

    fn simple_lines_for(&self, session_id: u64) -> Vec<SimpleLine> {
        match self
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .map(|session| &session.backend)
        {
            Some(Backend::Simple(backend)) => backend
                .parser
                .lock()
                .map(|parser| parser.lines().to_vec())
                .unwrap_or_default(),
            _ => Vec::new(),
        }
    }
}

/// Compute the monospace cell size from the window text metrics.
fn cell_metrics(window: &Window, cx: &gpui::App) -> (f32, f32) {
    let theme = cx.theme().clone();
    let text_style = window.text_style();
    let rem_size = window.rem_size();
    let font_size = text_style.font_size.to_pixels(rem_size);
    let line_height = text_style
        .line_height
        .to_pixels(gpui::AbsoluteLength::Pixels(font_size), rem_size);
    let font_id = window
        .text_system()
        .resolve_font(&gpui::font(theme.mono_font_family.clone()));
    let cell_width: f32 = window
        .text_system()
        .advance(font_id, font_size, ' ')
        .map(|size| size.width.into())
        .unwrap_or(7.0);
    let line_height: f32 = line_height.into();
    (cell_width, line_height)
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::Modifiers;

    struct TerminalFocusHarness {
        drawer: FocusHandle,
        pane: FocusHandle,
        outside: FocusHandle,
    }

    impl Render for TerminalFocusHarness {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
                .child(
                    div()
                        .track_focus(&self.drawer)
                        .child(div().track_focus(&self.pane).tab_stop(true)),
                )
                .child(div().track_focus(&self.outside).tab_stop(true))
        }
    }

    #[cfg(unix)]
    fn process_alive(pid: u32) -> bool {
        i32::try_from(pid)
            .ok()
            .is_some_and(|pid| unsafe { libc::kill(pid, 0) } == 0)
    }

    #[cfg(unix)]
    fn wait_until_process_is_gone(pid: u32) {
        for _ in 0..100 {
            if !process_alive(pid) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(!process_alive(pid), "terminal child {pid} was not reaped");
    }

    #[test]
    fn simple_parser_renders_plain_text_and_newlines() {
        let mut parser = SimpleParser::new(40, 100);
        parser.feed(b"hello\r\nworld");
        let lines = parser.lines();
        assert_eq!(lines[0].text, "hello");
        assert_eq!(lines[1].text, "world");
    }

    #[test]
    fn simple_parser_strips_ansi_colors_but_keeps_text() {
        let mut parser = SimpleParser::new(40, 100);
        parser.feed(b"\x1b[31mred\x1b[0m plain");
        let lines = parser.lines();
        assert_eq!(lines[0].text, "red plain");
        assert_eq!(lines[0].spans.len(), 1);
        assert_eq!(lines[0].spans[0].0, 0..3);
        assert_eq!(lines[0].spans[0].1, SimpleColor::Red);
    }

    #[test]
    fn simple_parser_handles_clear_and_tabs() {
        let mut parser = SimpleParser::new(20, 100);
        parser.feed(b"abc\x1b[2Jdef");
        assert_eq!(parser.lines().len(), 1);
        assert_eq!(parser.lines()[0].text, "def");

        let mut parser = SimpleParser::new(20, 100);
        parser.feed(b"\tX");
        assert_eq!(parser.lines()[0].text, "        X");
    }

    #[test]
    fn simple_parser_bounds_scrollback() {
        let mut parser = SimpleParser::new(20, 3);
        for index in 0..5 {
            parser.feed(format!("line-{index}\r\n").as_bytes());
        }
        assert!(parser.lines().len() <= 3);
        assert!(parser
            .lines()
            .iter()
            .any(|line| line.text.contains("line-4")));
        assert!(parser
            .lines()
            .iter()
            .any(|line| line.text.contains("line-3")));
        assert!(!parser
            .lines()
            .iter()
            .any(|line| line.text.contains("line-2")));
    }

    #[test]
    fn osc_title_is_bounded_and_sanitized_at_the_event_boundary() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let listener = TerminalListener { tx };
        let hostile = format!(
            "  safe\u{1b}\u{202e}\n{}\u{0085}\u{2066}\u{2028}spoof  ",
            "x".repeat(10_000)
        );

        listener.send_event(Event::Title(hostile));
        let TerminalEvent::Title(title) = rx.try_recv().expect("bounded title event") else {
            panic!("expected a title event");
        };

        assert!(title.starts_with("safex"));
        assert!(title.chars().count() <= MAX_TERMINAL_TITLE_CHARS);
        assert!(!title.chars().any(terminal_title_character_is_unsafe));
        assert_eq!(terminal_tab_label(3), "Terminal 3");
        assert_eq!(normalize_terminal_title("\u{1b}\n\u{202e}"), "Terminal");
    }

    #[test]
    fn keystroke_bytes_maps_terminal_keys() {
        let none = Modifiers::none();
        assert_eq!(
            keystroke_bytes("enter", Some("\r"), &none),
            Some(b"\r".to_vec())
        );
        assert_eq!(keystroke_bytes("up", None, &none), Some(b"\x1b[A".to_vec()));
        assert_eq!(
            keystroke_bytes("backspace", None, &none),
            Some(b"\x7f".to_vec())
        );
        assert_eq!(keystroke_bytes("a", Some("a"), &none), Some(b"a".to_vec()));
        assert_eq!(keystroke_bytes("escape", None, &none), None);

        let control = Modifiers {
            control: true,
            ..Modifiers::none()
        };
        assert_eq!(keystroke_bytes("c", Some("c"), &control), Some(vec![0x03]));

        let alt = Modifiers {
            alt: true,
            ..Modifiers::none()
        };
        assert_eq!(
            keystroke_bytes("x", Some("x"), &alt),
            Some(vec![0x1b, b'x'])
        );
    }

    #[test]
    fn keystroke_bytes_never_forwards_command_combos() {
        let cmd = Modifiers {
            platform: true,
            ..Modifiers::none()
        };
        assert_eq!(keystroke_bytes("k", Some("k"), &cmd), None);
        let shift_tab = Modifiers {
            shift: true,
            ..Modifiers::none()
        };
        assert_eq!(
            keystroke_bytes("tab", None, &shift_tab),
            Some(b"\x1b[Z".to_vec())
        );
    }

    #[test]
    fn canonical_layout_select_split_close_and_limits_are_coherent() {
        let mut layout = TerminalLayout::default();
        layout.select(1);
        assert_eq!(layout.ids, [1]);
        assert!(layout.append_split(Some(1), 2, SplitDirection::Horizontal));
        assert!(layout.append_split(Some(2), 3, SplitDirection::Vertical));
        assert!(layout.append_split(Some(3), 4, SplitDirection::Horizontal));
        assert!(!layout.append_split(Some(4), 5, SplitDirection::Vertical));
        assert_eq!(layout.ids, [1, 2, 3, 4]);

        // Selecting a tab outside the visible group collapses to one pane.
        layout.select(8);
        assert_eq!(layout.direction, SplitDirection::Single);
        assert_eq!(layout.ids, [8]);

        layout = TerminalLayout {
            direction: SplitDirection::Horizontal,
            ids: vec![1, 2, 3],
        };
        layout.remove(2);
        assert_eq!(layout.ids, [1, 3]);
        let fallback = fallback_after_session_removal(Some(2), 2, &layout.ids, &[1, 3, 8], true);
        assert_eq!(fallback, Some(1));
        layout.remove(1);
        assert_eq!(layout.direction, SplitDirection::Single);
    }

    #[test]
    fn drawer_height_matches_electron_bounds_pointer_and_keyboard_steps() {
        assert_eq!(max_drawer_height(1_000.0), 500.0);
        assert_eq!(max_drawer_height(600.0), 280.0);
        assert_eq!(clamp_drawer_height(f32::NAN, 1_000.0), 232.0);
        assert_eq!(clamp_drawer_height(90.0, 1_000.0), 152.0);
        assert_eq!(pointer_resized_height(232.0, 400.0, 360.0, 1_000.0), 272.0);
        assert_eq!(
            keyboard_resize_height(232.0, "up", false, 1_000.0),
            Some(248.0)
        );
        assert_eq!(
            keyboard_resize_height(232.0, "down", true, 1_000.0),
            Some(192.0)
        );
        assert_eq!(
            keyboard_resize_height(232.0, "home", false, 1_000.0),
            Some(152.0)
        );
        assert_eq!(
            keyboard_resize_height(232.0, "end", false, 1_000.0),
            Some(500.0)
        );
        assert_eq!(
            keyboard_resize_height(232.0, "escape", false, 1_000.0),
            None
        );
    }

    #[test]
    fn persisted_height_accepts_only_newest_intent() {
        let generation = AtomicU64::new(0);
        let first = next_persist_generation(&generation);
        assert!(persist_generation_is_current(&generation, first));
        let second = next_persist_generation(&generation);
        assert!(!persist_generation_is_current(&generation, first));
        assert!(persist_generation_is_current(&generation, second));
    }

    #[gpui::test]
    fn drawer_focus_ownership_excludes_external_toggle_focus(cx: &mut gpui::TestAppContext) {
        let (view, cx) = cx.add_window_view(|_, cx| TerminalFocusHarness {
            drawer: cx.focus_handle(),
            pane: cx.focus_handle(),
            outside: cx.focus_handle(),
        });
        cx.update(|window, app| {
            let harness = view.read(app);
            harness.pane.focus(window);
            assert!(harness.drawer.contains_focused(window, app));
            harness.outside.focus(window);
            assert!(!harness.drawer.contains_focused(window, app));
        });
    }

    #[gpui::test]
    fn first_toggle_lazily_creates_exactly_one_terminal(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx) = cx.add_window_view(|_, cx| {
            TerminalDrawer::new_owned(
                cx,
                TerminalDeps {
                    shell: Some("/bin/sh".into()),
                    cwd: None,
                    simple: true,
                },
                Some("workspace-a".into()),
                None,
            )
        });
        cx.update(|window, app| {
            assert!(view.read(app).sessions.is_empty());
            view.update(app, |this, cx| this.toggle(window, cx));
            let drawer = view.read(app);
            assert!(drawer.open);
            assert_eq!(drawer.sessions.len(), 1);
            assert_eq!(drawer.spawn_attempts, 1);
            assert_eq!(drawer.layout.ids, [drawer.sessions[0].id]);
        });
    }

    #[gpui::test]
    fn failed_first_toggle_attempt_is_once_and_visible_until_explicit_retry(
        cx: &mut gpui::TestAppContext,
    ) {
        cx.update(gpui_component::init);
        let (view, cx) = cx.add_window_view(|_, cx| {
            let mut drawer = TerminalDrawer::new_owned(
                cx,
                TerminalDeps {
                    shell: Some("/definitely/not/a/shell".into()),
                    cwd: None,
                    simple: true,
                },
                Some("workspace-a".into()),
                None,
            );
            drawer.fail_spawn = true;
            drawer
        });
        cx.update(|window, app| {
            view.update(app, |this, cx| this.toggle(window, cx));
            {
                let drawer = view.read(app);
                assert!(drawer.open);
                assert!(drawer.sessions.is_empty());
                assert_eq!(drawer.spawn_attempts, 1);
                assert_eq!(
                    drawer.drawer_error.as_deref(),
                    Some(
                        "The shell could not be started. Check your shell and workspace, then try again."
                    )
                );
            }
            view.update(app, |this, cx| this.toggle(window, cx));
            view.update(app, |this, cx| this.toggle(window, cx));
            assert_eq!(view.read(app).spawn_attempts, 1);
        });
    }

    #[gpui::test]
    fn repeated_ineligible_projection_clears_workspace_only_once(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx) = cx.add_window_view(|_, cx| TerminalDrawer {
            sessions: Vec::new(),
            active_id: None,
            layout: TerminalLayout::default(),
            next_session_id: 1,
            owner_generation: 9,
            workspace_id: Some("workspace-a".into()),
            shell: None,
            cwd: Some(PathBuf::from("/tmp/workspace-a")),
            simple: false,
            config: None,
            open: false,
            height: DEFAULT_DRAWER_HEIGHT,
            drawer_error: None,
            input_focus: cx.focus_handle(),
            drawer_focus: cx.focus_handle(),
            resize_focus: cx.focus_handle(),
            restore_toggle_focus: false,
            fail_spawn: false,
            spawn_attempts: 0,
        });
        cx.update(|_, app| {
            view.update(app, |this, cx| this.clear_workspace(cx));
            let after_first = view.read(app).owner_generation;
            assert_eq!(after_first, 10);
            view.update(app, |this, cx| this.clear_workspace(cx));
            assert_eq!(view.read(app).owner_generation, after_first);
        });
    }

    #[test]
    fn alacritty_late_drop_never_signals_a_cached_raw_pid() {
        let source = include_str!("terminal_drawer.rs");
        let drop_body = source
            .split("impl Drop for AlacrittyBackend")
            .nth(1)
            .and_then(|source| source.split("impl Drop for SimpleBackend").next())
            .expect("alacritty drop implementation");
        assert!(!drop_body.contains("terminate_process_group"));
        assert!(!drop_body.contains("libc::kill"));
        assert!(!drop_body.contains("child_process_group"));

        let drawer_drop = source
            .split("impl Drop for TerminalDrawer")
            .nth(1)
            .and_then(|source| source.split("impl TerminalDrawer").next())
            .expect("terminal drawer drop implementation");
        assert!(drawer_drop.contains("self.sessions.clear()"));
    }

    #[cfg(unix)]
    #[test]
    fn independent_real_pty_children_are_retained_and_reaped_on_drop() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let first = spawn_simple(Some("/bin/sh".into()), None, 80, tx.clone()).unwrap();
        let second = spawn_simple(Some("/bin/sh".into()), None, 80, tx).unwrap();
        let first_pid = first
            .child
            .as_ref()
            .and_then(|child| child.process_id())
            .unwrap();
        let second_pid = second
            .child
            .as_ref()
            .and_then(|child| child.process_id())
            .unwrap();
        assert_ne!(first_pid, second_pid);
        assert!(process_alive(first_pid));
        assert!(process_alive(second_pid));

        drop(first);
        wait_until_process_is_gone(first_pid);
        assert!(process_alive(second_pid));
        drop(second);
        wait_until_process_is_gone(second_pid);
    }

    #[cfg(unix)]
    #[gpui::test]
    fn clearing_workspace_reaps_all_real_sessions(cx: &mut gpui::TestAppContext) {
        let drawer = cx.new(|cx| {
            TerminalDrawer::new_owned(
                cx,
                TerminalDeps {
                    shell: Some("/bin/sh".into()),
                    cwd: None,
                    simple: true,
                },
                Some("workspace-a".into()),
                None,
            )
        });
        cx.update(|app| {
            drawer.update(app, |this, cx| {
                let id = this.create_session(cx).unwrap();
                this.layout.ids = vec![id];
            });
        });
        let pid = cx.update(|app| {
            let drawer = drawer.read(app);
            match &drawer.sessions[0].backend {
                Backend::Simple(backend) => backend
                    .child
                    .as_ref()
                    .and_then(|child| child.process_id())
                    .unwrap(),
                Backend::Alacritty(_) => panic!("simple backend requested"),
            }
        });
        assert!(process_alive(pid));
        cx.update(|app| {
            drawer.update(app, |this, cx| this.clear_workspace(cx));
            assert!(drawer.read(app).sessions.is_empty());
        });
        cx.run_until_parked();
        wait_until_process_is_gone(pid);
    }

    #[cfg(unix)]
    #[gpui::test]
    fn same_workspace_permission_reenable_restores_exact_cwd_without_stale_session(
        cx: &mut gpui::TestAppContext,
    ) {
        cx.update(gpui_component::init);
        let workspace = tempfile::tempdir().unwrap();
        let workspace_path = workspace.path().to_path_buf();
        let expected_pwd = workspace_path.to_string_lossy().into_owned();
        let (drawer, cx) = cx.add_window_view({
            let workspace_path = workspace_path.clone();
            move |_, cx| {
                TerminalDrawer::new_owned(
                    cx,
                    TerminalDeps {
                        shell: Some("/bin/sh".into()),
                        cwd: Some(workspace_path),
                        simple: true,
                    },
                    Some("workspace-a".into()),
                    None,
                )
            }
        });

        // Permission none clears ownership without destroying the retained UI
        // entity. Re-enabling the same id must restore the exact cwd even
        // though the app-level workspace id did not change.
        cx.update(|_, app| drawer.update(app, |this, cx| this.clear_workspace(cx)));
        cx.update(|_, app| {
            drawer.update(app, |this, cx| {
                this.set_workspace("workspace-a".into(), workspace_path.clone(), cx)
            });
            let state = drawer.read(app);
            assert_eq!(state.workspace_id.as_deref(), Some("workspace-a"));
            assert_eq!(state.cwd.as_ref(), Some(&workspace_path));
            assert!(state.sessions.is_empty());
        });
        cx.update(|window, app| drawer.update(app, |this, cx| this.toggle(window, cx)));
        let (first_id, first_pid) = cx.update(|_, app| {
            let state = drawer.read(app);
            let session = &state.sessions[0];
            let pid = match &session.backend {
                Backend::Simple(backend) => backend
                    .child
                    .as_ref()
                    .and_then(|child| child.process_id())
                    .unwrap(),
                Backend::Alacritty(_) => panic!("simple backend requested"),
            };
            (session.id, pid)
        });
        cx.update(|_, app| drawer.update(app, |this, _| this.write_bytes(b"pwd\r")));
        let mut saw_exact_cwd = false;
        for _ in 0..100 {
            let output = cx.update(|_, app| {
                drawer
                    .read(app)
                    .simple_lines_for(first_id)
                    .into_iter()
                    .map(|line| line.text)
                    .collect::<Vec<_>>()
                    .join("\n")
            });
            if output.contains(&expected_pwd) {
                saw_exact_cwd = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(saw_exact_cwd, "first PTY did not report the workspace cwd");

        cx.update(|_, app| drawer.update(app, |this, cx| this.clear_workspace(cx)));
        wait_until_process_is_gone(first_pid);
        cx.update(|_, app| {
            drawer.update(app, |this, cx| {
                this.set_workspace("workspace-a".into(), workspace_path.clone(), cx)
            });
        });
        cx.update(|window, app| drawer.update(app, |this, cx| this.toggle(window, cx)));
        let (second_id, second_pid) = cx.update(|_, app| {
            let state = drawer.read(app);
            assert_eq!(state.sessions.len(), 1);
            let session = &state.sessions[0];
            let pid = match &session.backend {
                Backend::Simple(backend) => backend
                    .child
                    .as_ref()
                    .and_then(|child| child.process_id())
                    .unwrap(),
                Backend::Alacritty(_) => panic!("simple backend requested"),
            };
            (session.id, pid)
        });
        assert_ne!(first_id, second_id);
        assert_ne!(first_pid, second_pid);
        cx.update(|_, app| drawer.update(app, |this, cx| this.clear_workspace(cx)));
        wait_until_process_is_gone(second_pid);
    }
}
