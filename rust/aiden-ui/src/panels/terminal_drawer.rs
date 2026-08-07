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

use std::path::PathBuf;
use std::sync::Arc;

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
    div, point, px, relative, size as gpui_size, Bounds, Context, Element, ElementId, FocusHandle,
    FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement as _, Pixels, Render, Rgba,
    ScrollDelta, ScrollWheelEvent, SharedString, StatefulInteractiveElement, Style, Styled,
    TextRun, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex, v_flex, ActiveTheme, Icon, IconName, Sizable as _,
};

/// Events flowing from the pty thread to the foreground watcher.
#[derive(Debug, Clone)]
pub enum TerminalEvent {
    /// New terminal content is available (repaint).
    Update,
    /// The child process changed the window title.
    Title(String),
    /// The child process exited.
    ChildExit,
    /// The pty/shell failed to start.
    Failed(String),
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
            Event::Title(title) => Some(TerminalEvent::Title(title)),
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
    /// Kept alive so the pty reader thread stays alive.
    _join: Option<EventLoopJoin>,
}

struct SimpleBackend {
    parser: Arc<std::sync::Mutex<SimpleParser>>,
    writer: Box<dyn std::io::Write + Send>,
}

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

pub struct TerminalDrawer {
    backend: Option<Backend>,
    pub(crate) open: bool,
    /// Drawer height as a fraction of the window height (0.2 .. 0.8).
    pub(crate) height_fraction: f32,
    pub(crate) title: String,
    pub(crate) shell_error: Option<String>,
    pub(crate) input_focus: FocusHandle,
    _watcher: Option<gpui::Task<()>>,
}

impl TerminalDrawer {
    pub fn new(cx: &mut Context<Self>, deps: TerminalDeps) -> Self {
        let mut this = Self {
            backend: None,
            open: false,
            height_fraction: 0.35,
            title: "Terminal".to_string(),
            shell_error: None,
            input_focus: cx.focus_handle(),
            _watcher: None,
        };
        this.spawn_backend(cx, &deps);
        this
    }

    /// Spawn the shell backend; the fallback is used when requested or when
    /// the alacritty path cannot be constructed.
    fn spawn_backend(&mut self, cx: &mut Context<Self>, deps: &TerminalDeps) {
        let shell = deps.shell.clone();
        let cwd = deps.cwd.clone();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<TerminalEvent>();

        let alacritty = if !deps.simple {
            spawn_alacritty(shell.clone(), cwd.clone(), tx.clone())
        } else {
            None
        };

        match alacritty {
            Some(backend) => self.backend = Some(Backend::Alacritty(backend)),
            None => match spawn_simple(shell, cwd, 80, tx.clone()) {
                Ok(simple) => self.backend = Some(Backend::Simple(simple)),
                Err(error) => {
                    self.shell_error = Some(error.clone());
                    let _ = tx.send(TerminalEvent::Failed(error));
                }
            },
        }

        let watcher = cx.spawn(async move |this, cx| {
            let mut rx = rx;
            while let Some(event) = rx.recv().await {
                this.update(cx, |this, cx| match event {
                    TerminalEvent::Update => cx.notify(),
                    TerminalEvent::Title(title) => {
                        this.title = title;
                        cx.notify();
                    }
                    TerminalEvent::ChildExit => {
                        this.title = "Terminal (exited)".to_string();
                        cx.notify();
                    }
                    TerminalEvent::Failed(error) => {
                        this.shell_error = Some(error);
                        cx.notify();
                    }
                })
                .ok();
            }
        });
        self._watcher = Some(watcher);
    }

    pub fn toggle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open = !self.open;
        if self.open {
            let focus = self.input_focus.clone();
            cx.defer_in(window, move |_this, window, _cx| {
                focus.focus(window);
            });
        }
        cx.notify();
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    #[allow(dead_code)] // resize affordance; the drawer uses the default fraction
    pub fn set_height_fraction(&mut self, fraction: f32, cx: &mut Context<Self>) {
        self.height_fraction = fraction.clamp(0.2, 0.8);
        cx.notify();
    }

    /// Send bytes to the pty.
    pub fn write_bytes(&mut self, bytes: &[u8]) {
        match &mut self.backend {
            Some(Backend::Alacritty(backend)) => {
                let _ = backend.sender.send(Msg::Input(bytes.to_vec().into()));
            }
            Some(Backend::Simple(backend)) => {
                let _ = backend.writer.write_all(bytes);
            }
            None => {}
        }
    }

    /// Scroll the grid viewport.
    #[allow(dead_code)] // the alacritty grid scrolls via the mouse wheel today
    pub fn scroll(&mut self, delta: i32) {
        if let Some(Backend::Alacritty(backend)) = &self.backend {
            backend
                .term
                .lock_unfair()
                .scroll_display(Scroll::Delta(delta));
        }
    }

    /// Route one keystroke to the shell; Escape closes the drawer.
    pub fn handle_input(
        &mut self,
        key: &str,
        key_char: Option<&str>,
        modifiers: &gpui::Modifiers,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if key == "escape" {
            self.open = false;
            cx.notify();
            return;
        }
        if let Some(bytes) = keystroke_bytes(key, key_char, modifiers) {
            self.write_bytes(&bytes);
        }
    }

    /// The simple backend's rendered lines (fallback path).
    pub(crate) fn simple_lines(&self) -> Vec<SimpleLine> {
        match &self.backend {
            Some(Backend::Simple(backend)) => {
                let guard = backend.parser.lock();
                guard
                    .map(|parser| parser.lines().to_vec())
                    .unwrap_or_default()
            }
            _ => Vec::new(),
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
        _join: Some(join),
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
    drop(child);

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

    Ok(SimpleBackend { parser, writer })
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
        let cols = (width_f32 / self.cell_width).floor().max(1.0) as usize;
        let rows = (height_f32 / self.line_height).floor().max(1.0) as usize;
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

impl Render for TerminalDrawer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let height = self.height_fraction * window.viewport_size().height;
        let focus = self.input_focus.clone();

        v_flex()
            .id("terminal-drawer")
            .w_full()
            .bg(theme.popover)
            .border_t_1()
            .border_color(theme.border)
            .h(height)
            .child(
                h_flex()
                    .id("terminal-header")
                    .w_full()
                    .h(px(28.))
                    .px_2()
                    .gap_2()
                    .items_center()
                    .border_b_1()
                    .border_color(theme.border)
                    .child(Icon::new(IconName::SquareTerminal).xsmall())
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .truncate()
                            .child(self.title.clone()),
                    )
                    .child(div().flex_1())
                    .child(
                        Button::new("terminal-close")
                            .ghost()
                            .xsmall()
                            .icon(IconName::Close)
                            .tooltip("Close terminal (Esc)")
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.open = false;
                                cx.notify();
                            })),
                    ),
            )
            .child(
                div()
                    .id("terminal-body")
                    .flex_1()
                    .w_full()
                    .overflow_hidden()
                    .bg(theme.background)
                    .focusable()
                    .track_focus(&focus)
                    .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                        this.handle_input(
                            &event.keystroke.key,
                            event.keystroke.key_char.as_deref(),
                            &event.keystroke.modifiers,
                            window,
                            cx,
                        );
                    }))
                    .child(self.terminal_surface(window, cx)),
            )
    }
}

impl TerminalDrawer {
    fn terminal_surface(&self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        if let Some(error) = &self.shell_error {
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

        match &self.backend {
            Some(Backend::Alacritty(backend)) => {
                let cell_metrics = cell_metrics(window, cx);
                TerminalElement {
                    id: ElementId::Name(SharedString::from("terminal-grid")),
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
                let lines = self.simple_lines();
                let row_height = 16.0_f32;
                let visible = (self.height_fraction * window.viewport_size().height
                    / px(row_height))
                .floor() as usize;
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
}
