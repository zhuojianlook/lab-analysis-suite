//! Quit handshake (phase1-contract.md §6.3).
//!
//! Every way of quitting — the Quit menu item / Cmd+Q, the window's close
//! button, Dock Quit / logout / AppleScript (`applicationShouldTerminate:`,
//! quit_macos.rs) and any other exit request — asks the frontend first
//! (`app://quit-requested`). The frontend writes its unsaved work to disk,
//! says `flushed`, may show a dialog, then says `proceed` or `cancel`. A
//! watchdog always ends the wait: 5 s without any answer (a hung page), or
//! 60 s for a quit asked by the system once the work is flushed. The engine
//! is stopped only when the quit really happens.
//!
//! The updater's restart (exit code i32::MAX) never starts the routine: the
//! frontend ran it before calling relaunch.

use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const EVT_QUIT_REQUESTED: &str = "app://quit-requested";
pub const FLUSH_MS: u64 = 5_000;
pub const SYSTEM_ANSWER_MS: u64 = 60_000;
pub const RESTART_EXIT_CODE: i32 = i32::MAX;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum QuitSource {
    Menu,
    Window,
    System,
    Exit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Flushed,
    Proceed,
    Cancel,
}

impl Stage {
    pub fn parse(s: &str) -> Option<Stage> {
        match s {
            "flushed" => Some(Stage::Flushed),
            "proceed" => Some(Stage::Proceed),
            "cancel" => Some(Stage::Cancel),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum QState {
    Idle,
    Asked { id: u64, source: QuitSource, since: u64, flushed_at: Option<u64>, system_since: Option<u64> },
    Allowed,
}

/// How a finished routine ends the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinishHow {
    /// `replyToApplicationShouldTerminate(true)` (a system quit is waiting).
    ReplyTerminate,
    /// `app.exit(0)`.
    Exit,
    /// The caller lets the pending exit go on itself (hook returning NSTerminateNow).
    None,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Act {
    Emit { id: u64, source: QuitSource },
    StartWatchdog(u64),
    /// Stop the engine, then end as said.
    Finish(FinishHow),
    /// `replyToApplicationShouldTerminate(false)`: the system quit was cancelled.
    CancelTerminate,
}

/// The pure state machine; times are ms on any monotonic clock.
#[derive(Debug)]
pub struct QuitMachine {
    pub state: QState,
    pub frontend_ready: bool,
    next_id: u64,
}

impl Default for QuitMachine {
    fn default() -> Self {
        QuitMachine { state: QState::Idle, frontend_ready: false, next_id: 1 }
    }
}

impl QuitMachine {
    pub fn allowed(&self) -> bool {
        self.state == QState::Allowed
    }

    fn finish(&mut self, how_default: FinishHow) -> Vec<Act> {
        let system = matches!(self.state, QState::Asked { system_since: Some(_), .. });
        self.state = QState::Allowed;
        vec![Act::Finish(if system { FinishHow::ReplyTerminate } else { how_default })]
    }

    /// A quit was asked for. An empty list while `Allowed` means "let it go on".
    pub fn request(&mut self, source: QuitSource, now: u64) -> Vec<Act> {
        match &mut self.state {
            QState::Allowed => vec![],
            QState::Asked { system_since, .. } => {
                if source == QuitSource::System && system_since.is_none() {
                    *system_since = Some(now);
                }
                vec![]
            }
            QState::Idle => {
                if !self.frontend_ready {
                    // Nothing to flush yet (quit during startup).
                    self.state = QState::Allowed;
                    let how = if source == QuitSource::System { FinishHow::None } else { FinishHow::Exit };
                    return vec![Act::Finish(how)];
                }
                let id = self.next_id;
                self.next_id += 1;
                self.state = QState::Asked {
                    id,
                    source,
                    since: now,
                    flushed_at: None,
                    system_since: (source == QuitSource::System).then_some(now),
                };
                vec![Act::Emit { id, source }, Act::StartWatchdog(id)]
            }
        }
    }

    /// `applicationShouldTerminate:` → (NSTerminateNow = 1 / NSTerminateLater = 2, actions).
    pub fn should_terminate(&mut self, now: u64) -> (usize, Vec<Act>) {
        if self.allowed() {
            return (1, vec![]);
        }
        let acts = self.request(QuitSource::System, now);
        if acts.contains(&Act::Finish(FinishHow::None)) {
            (1, acts)
        } else {
            (2, acts)
        }
    }

    /// `app_quit_reply`; a stale id is ignored.
    pub fn reply(&mut self, id: u64, stage: Stage, now: u64) -> Vec<Act> {
        let QState::Asked { id: cur, flushed_at, system_since, .. } = &mut self.state else { return vec![] };
        if *cur != id {
            return vec![];
        }
        match stage {
            Stage::Flushed => {
                flushed_at.get_or_insert(now);
                vec![]
            }
            Stage::Proceed => self.finish(FinishHow::Exit),
            Stage::Cancel => {
                let system = system_since.is_some();
                self.state = QState::Idle;
                if system {
                    vec![Act::CancelTerminate]
                } else {
                    vec![]
                }
            }
        }
    }

    /// Watchdog check for request `id`: (actions, keep watching).
    pub fn watchdog(&mut self, id: u64, now: u64) -> (Vec<Act>, bool) {
        let QState::Asked { id: cur, since, flushed_at, system_since, .. } = self.state.clone() else { return (vec![], false) };
        if cur != id {
            return (vec![], false);
        }
        match (flushed_at, system_since) {
            (None, _) if now.saturating_sub(since) >= FLUSH_MS => (self.finish(FinishHow::Exit), false),
            (Some(f), Some(s)) if now.saturating_sub(f.max(s)) >= SYSTEM_ANSWER_MS => (self.finish(FinishHow::Exit), false),
            _ => (vec![], true),
        }
    }
}

/// The machine plus what it acts on.
pub struct QuitDriver {
    pub machine: Mutex<QuitMachine>,
    epoch: Instant,
    perform: Box<dyn Fn(&Arc<QuitDriver>, Act) + Send + Sync>,
}

impl QuitDriver {
    pub fn new(perform: Box<dyn Fn(&Arc<QuitDriver>, Act) + Send + Sync>) -> Arc<Self> {
        Arc::new(QuitDriver { machine: Mutex::new(QuitMachine::default()), epoch: Instant::now(), perform })
    }

    pub fn now(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }

    fn run(self: &Arc<Self>, acts: Vec<Act>) {
        for a in acts {
            match a {
                Act::StartWatchdog(id) => {
                    let me = self.clone();
                    std::thread::spawn(move || loop {
                        std::thread::sleep(Duration::from_millis(200));
                        let (acts, more) = crate::graphfile::lk(&me.machine).watchdog(id, me.now());
                        me.run(acts);
                        if !more {
                            break;
                        }
                    });
                }
                other => (self.perform)(self, other),
            }
        }
    }

    pub fn allowed(&self) -> bool {
        crate::graphfile::lk(&self.machine).allowed()
    }

    pub fn set_frontend_ready(&self) {
        crate::graphfile::lk(&self.machine).frontend_ready = true;
    }

    /// Returns true when the exit may go on now (state Allowed).
    pub fn request(self: &Arc<Self>, source: QuitSource) -> bool {
        let acts = {
            let mut m = crate::graphfile::lk(&self.machine);
            if m.allowed() {
                return true;
            }
            m.request(source, self.now())
        };
        self.run(acts);
        false
    }

    pub fn reply(self: &Arc<Self>, id: u64, stage: Stage) {
        let acts = crate::graphfile::lk(&self.machine).reply(id, stage, self.now());
        self.run(acts);
    }

    /// For the macOS hook: 1 = NSTerminateNow, 2 = NSTerminateLater.
    pub fn should_terminate(self: &Arc<Self>) -> usize {
        let (r, acts) = crate::graphfile::lk(&self.machine).should_terminate(self.now());
        self.run(acts);
        r
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuitRequest {
    pub request_id: u64,
    pub source: QuitSource,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready() -> QuitMachine {
        QuitMachine { frontend_ready: true, ..Default::default() }
    }

    #[test]
    fn menu_quit_flushed_then_proceed() {
        let mut m = ready();
        let acts = m.request(QuitSource::Menu, 0);
        assert_eq!(acts, vec![Act::Emit { id: 1, source: QuitSource::Menu }, Act::StartWatchdog(1)]);
        assert!(m.request(QuitSource::Window, 10).is_empty(), "no second emit");
        assert!(m.reply(1, Stage::Flushed, 100).is_empty());
        // person looks at the dialog: no limit
        assert_eq!(m.watchdog(1, 1_000_000), (vec![], true));
        assert_eq!(m.reply(99, Stage::Proceed, 200), vec![], "stale id ignored");
        assert_eq!(m.reply(1, Stage::Proceed, 200), vec![Act::Finish(FinishHow::Exit)]);
        assert!(m.allowed());
        assert!(m.request(QuitSource::Exit, 300).is_empty(), "allowed: let it go");
        assert_eq!(m.watchdog(1, 300), (vec![], false));
    }

    #[test]
    fn cancel_returns_to_idle_and_next_request_gets_new_id() {
        let mut m = ready();
        m.request(QuitSource::Window, 0);
        m.reply(1, Stage::Flushed, 10);
        assert_eq!(m.reply(1, Stage::Cancel, 20), vec![]);
        assert_eq!(m.state, QState::Idle);
        assert_eq!(m.watchdog(1, 99_999), (vec![], false));
        assert_eq!(m.request(QuitSource::Menu, 30)[0], Act::Emit { id: 2, source: QuitSource::Menu });
    }

    #[test]
    fn watchdog_always_replies_when_page_is_hung() {
        let mut m = ready();
        m.request(QuitSource::Menu, 1000);
        assert_eq!(m.watchdog(1, 5999), (vec![], true));
        assert_eq!(m.watchdog(1, 6000), (vec![Act::Finish(FinishHow::Exit)], false));
        assert!(m.allowed());
    }

    #[test]
    fn system_quit_hook_paths() {
        // not ready: terminate now
        let mut m = QuitMachine::default();
        let (r, acts) = m.should_terminate(0);
        assert_eq!((r, acts), (1, vec![Act::Finish(FinishHow::None)]));
        // ready: later, then reply true after proceed
        let mut m = ready();
        let (r, acts) = m.should_terminate(0);
        assert_eq!(r, 2);
        assert_eq!(acts[0], Act::Emit { id: 1, source: QuitSource::System });
        assert_eq!(m.should_terminate(5).0, 2, "asked again while waiting: still later, no emit");
        m.reply(1, Stage::Flushed, 100);
        assert_eq!(m.reply(1, Stage::Proceed, 200), vec![Act::Finish(FinishHow::ReplyTerminate)]);
        assert_eq!(m.should_terminate(300), (1, vec![]));
        // cancel → reply false
        let mut m = ready();
        m.should_terminate(0);
        m.reply(1, Stage::Flushed, 10);
        assert_eq!(m.reply(1, Stage::Cancel, 20), vec![Act::CancelTerminate]);
        // flushed + system: 60 s for the person, then quit keeping drafts
        let mut m = ready();
        m.should_terminate(0);
        m.reply(1, Stage::Flushed, 1000);
        assert_eq!(m.watchdog(1, 60_999), (vec![], true));
        assert_eq!(m.watchdog(1, 61_000), (vec![Act::Finish(FinishHow::ReplyTerminate)], false));
        // a menu quit already showing its dialog, then Dock Quit: 60 s from the system ask
        let mut m = ready();
        m.request(QuitSource::Menu, 0);
        m.reply(1, Stage::Flushed, 100);
        assert_eq!(m.should_terminate(10_000).0, 2);
        assert_eq!(m.watchdog(1, 69_999), (vec![], true));
        assert_eq!(m.watchdog(1, 70_000), (vec![Act::Finish(FinishHow::ReplyTerminate)], false));
    }

    #[test]
    fn quit_before_frontend_ready_finishes_at_once() {
        let mut m = QuitMachine::default();
        assert_eq!(m.request(QuitSource::Window, 0), vec![Act::Finish(FinishHow::Exit)]);
        assert!(m.allowed());
    }

    #[test]
    fn driver_runs_watchdog_and_always_finishes() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let finished = Arc::new(AtomicUsize::new(0));
        let emitted = Arc::new(AtomicUsize::new(0));
        let (f2, e2) = (finished.clone(), emitted.clone());
        let d = QuitDriver::new(Box::new(move |_, a| match a {
            Act::Emit { .. } => {
                e2.fetch_add(1, Ordering::SeqCst);
            }
            Act::Finish(_) => {
                f2.fetch_add(1, Ordering::SeqCst);
            }
            _ => {}
        }));
        d.set_frontend_ready();
        assert!(!d.request(QuitSource::Menu));
        assert_eq!(emitted.load(Ordering::SeqCst), 1);
        let t0 = Instant::now();
        while finished.load(Ordering::SeqCst) == 0 && t0.elapsed() < Duration::from_secs(8) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(finished.load(Ordering::SeqCst), 1, "the watchdog ended the hung quit");
        assert!(t0.elapsed() >= Duration::from_millis(4800));
        assert!(d.allowed());
        assert!(d.request(QuitSource::Exit), "allowed afterwards");
    }

    #[test]
    fn wire_shapes() {
        let v = serde_json::to_value(QuitRequest { request_id: 3, source: QuitSource::System }).unwrap();
        assert_eq!(v, serde_json::json!({"requestId": 3, "source": "system"}));
        assert_eq!(Stage::parse("flushed"), Some(Stage::Flushed));
        assert_eq!(Stage::parse("nope"), None);
        assert_eq!(RESTART_EXIT_CODE, tauri::RESTART_EXIT_CODE);
    }
}
