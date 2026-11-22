//! The analysis engine: which port it listens on, how the app knows the
//! process answering there is really its own engine, and keeping it running.
//!
//! Why this exists: release builds used to start the engine on the fixed port
//! 8765 under the process name `api-server`. Another app with an engine of the
//! same name on the same port (and a quit routine running `pkill -f
//! api-server`) killed this app's engine, kept the port, and this app then
//! talked to that other engine — whose /api/health said "ok" while most
//! endpoints answered 404, so the R-gated tools waited forever. Now:
//!
//! * Each launch of the engine gets a free port picked by the OS
//!   (`pick_free_port`), so no other program's port is ever assumed.
//! * Each launch gets a random token (env `LAS_ENGINE_TOKEN`, never an argument,
//!   a URL or a log line). The engine echoes it in `GET /api/health` together
//!   with `"app": "lab-analysis-suite"`; an answer without both is "another
//!   program on the engine's port", never a ready engine (`verify_health`).
//!   The token is an identity marker only, not a secret: any local program can
//!   read it from the health answer (or the engine's initial environment), so
//!   it must never be used to authorize anything.
//! * The executable is called `las-engine` (`engine_exe_name`).
//! * If the engine exits while the app runs (killed, crashed), the supervisor
//!   starts it again on a new port with a new token, with bounded retries and
//!   backoff (`respawn_delay`). The proxy reads the port per request, so the
//!   frontend follows without a restart. `Engine::stop` (quit, updater
//!   relaunch) stops it for good.
//! * An engine that never answers while starting (`Liveness::boot_deadline`)
//!   or stops answering once ready (`Liveness::max_failed_probes`) is killed
//!   and goes through the same restart path (`liveness_verdict`).
//! * On unix the engine runs in its own process group, so the R processes it
//!   started are stopped with it even when it was killed from outside (they
//!   are re-parented then and cannot be found from its pid any more).
//! * The proxy only forwards requests to a confirmed engine
//!   (`request_gate`): nothing is sent to another program on the port.
//!
//! Debug builds keep using a dev engine started by hand on `LAS_SIDECAR_PORT`
//! (`Engine::external`, see devenv.rs); its health answer must still name this
//! app, it just carries no token.

use std::io::{BufRead, BufReader};
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::engineproc;

/// `app` value the engine reports in GET /api/health (api_server.py ENGINE_APP_ID).
pub const ENGINE_APP_ID: &str = "lab-analysis-suite";
/// Environment variable carrying the per-launch token to the engine.
pub const ENV_ENGINE_TOKEN: &str = "LAS_ENGINE_TOKEN";
/// The port release builds used to hard-code (and other apps still use).
/// Never picked, even if the OS offered it.
pub const LEGACY_FIXED_PORT: u16 = crate::devenv::RELEASE_SIDECAR_PORT;

/// File name of the bundled engine executable on `os` (std::env::consts::OS).
/// Deliberately not "api-server": another app's `pkill -f api-server` must not
/// match it.
pub fn engine_exe_name(os: &str) -> &'static str {
    if os == "windows" {
        "las-engine.exe"
    } else {
        "las-engine"
    }
}

/// A free TCP port on 127.0.0.1, chosen by the OS (bind to port 0), that is
/// not in `avoid`. The listener is closed before returning, so the engine can
/// bind it; if something takes it in between, the engine fails to start and
/// the supervisor tries again on another port.
pub fn pick_free_port(avoid: &[u16]) -> std::io::Result<u16> {
    let mut last_err = None;
    for _ in 0..32 {
        match TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))) {
            Ok(l) => {
                let port = l.local_addr()?.port();
                drop(l);
                if port != 0 && port != LEGACY_FIXED_PORT && !avoid.contains(&port) {
                    return Ok(port);
                }
            }
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("no free port found")))
}

/// A new random per-launch token (256 bits from the OS RNG, hex).
pub fn new_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// What a GET /api/health answer says about who is listening.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// This app's engine (and, when a token is expected, this launch of it).
    Ours,
    /// Something answered, but it is not this app's engine. The text says what
    /// it was, for the status detail (never contains the token).
    Foreign(String),
}

/// Judge a health response body. `expected_token`: the token this launch
/// passed to the engine, or `None` for a dev engine started by hand (then the
/// app name alone must match).
pub fn verify_health(body: &str, expected_token: Option<&str>) -> Verdict {
    let v: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return Verdict::Foreign("its health answer is not JSON".into()),
    };
    if v.get("status").and_then(|s| s.as_str()) != Some("ok") {
        return Verdict::Foreign("its health answer is not \"ok\"".into());
    }
    if v.get("app").and_then(|s| s.as_str()) != Some(ENGINE_APP_ID) {
        return Verdict::Foreign("it does not identify as Lab Analysis Suite's engine".into());
    }
    match expected_token {
        None => Verdict::Ours,
        Some(want) => {
            let got = v.get("token").and_then(|s| s.as_str()).unwrap_or("");
            if !got.is_empty() && constant_time_eq(got.as_bytes(), want.as_bytes()) {
                Verdict::Ours
            } else {
                Verdict::Foreign("it is a different copy of Lab Analysis Suite's engine".into())
            }
        }
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Restart limits: at most `max_restarts` restarts within `window`; the n-th
/// restart in the window waits `base * 2^(n-1)`, capped at `cap`.
#[derive(Debug, Clone, Copy)]
pub struct RespawnPolicy {
    pub max_restarts: usize,
    pub window: Duration,
    pub base: Duration,
    pub cap: Duration,
}

impl Default for RespawnPolicy {
    fn default() -> Self {
        RespawnPolicy {
            max_restarts: 5,
            window: Duration::from_secs(120),
            base: Duration::from_secs(1),
            cap: Duration::from_secs(16),
        }
    }
}

/// How long to wait before the next restart, or `None` to give up.
/// `exits`: when the engine exited unexpectedly (ms on any monotonic clock),
/// including the exit being handled now; `now`: the same clock.
pub fn respawn_delay(exits: &[u64], now: u64, p: &RespawnPolicy) -> Option<Duration> {
    let window = p.window.as_millis() as u64;
    let recent = exits.iter().filter(|&&t| t <= now && now - t < window).count().max(1);
    if recent > p.max_restarts {
        return None;
    }
    let factor = 1u32.checked_shl((recent - 1) as u32).unwrap_or(u32::MAX);
    Some(p.base.saturating_mul(factor).min(p.cap))
}

/// When a live engine process counts as hung (and is killed and restarted).
#[derive(Debug, Clone, Copy)]
pub struct Liveness {
    /// A launch that has not answered its health check with our token by
    /// then is hung. A first start of the frozen engine can take 30-90 s
    /// (macOS scans it, it imports pandas/scipy), so this is generous.
    pub boot_deadline: Duration,
    /// Once ready: how often the engine's health is checked.
    pub probe_every: Duration,
    /// Timeout of one of those checks.
    pub probe_timeout: Duration,
    /// Once ready: this many failed checks in a row = hung. /api/health is
    /// answered on the engine's event loop, so even a busy engine answers;
    /// with the defaults it takes ~3 minutes without any answer (killing a
    /// slow but working engine loses the user's work, so this is generous).
    pub max_failed_probes: u32,
    /// Give up after this many launches in a row that hung while starting
    /// (they are minutes apart, so `RespawnPolicy`'s window never sees them).
    pub max_boot_timeouts: u32,
}

impl Default for Liveness {
    fn default() -> Self {
        Liveness {
            boot_deadline: Duration::from_secs(240),
            probe_every: Duration::from_secs(10),
            probe_timeout: Duration::from_secs(5),
            max_failed_probes: 18,
            max_boot_timeouts: 3,
        }
    }
}

/// Is a still-running engine hung? `ready`: it has answered with our token;
/// `since_spawn`: how long ago it was started; `failed_probes`: health checks
/// failed in a row since it was ready. Returns why it is hung, or `None`.
pub fn liveness_verdict(ready: bool, since_spawn: Duration, failed_probes: u32, l: &Liveness) -> Option<String> {
    if !ready && since_spawn >= l.boot_deadline {
        return Some(format!(
            "the engine did not answer within {} s of starting",
            l.boot_deadline.as_secs()
        ));
    }
    if ready && failed_probes >= l.max_failed_probes {
        return Some(format!("the engine stopped answering ({failed_probes} health checks in a row failed)"));
    }
    None
}

/// Where the supervisor is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    /// Debug build: a dev engine started by hand; only live checks apply.
    External,
    /// Spawned, not yet confirmed by a health answer with our token.
    Starting,
    /// Confirmed by a health answer with our token.
    Ready,
    /// Exited unexpectedly; restart `attempt` is pending.
    Restarting { attempt: u32 },
    /// Gave up (or could not start); the text is for the user.
    Down(String),
    /// Stopped on purpose (quit, updater relaunch).
    Stopped,
}

/// How to start the engine.
#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub program: PathBuf,
    /// Arguments before the ones the app adds (a debug hook's script path).
    pub pre_args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub r_env_dir: Option<String>,
}

pub struct Engine {
    port: AtomicU16,
    /// Counts engine launches; lets the frontend notice a restart that
    /// happened between two of its health polls.
    generation: AtomicU32,
    token: Mutex<Option<String>>,
    status: Mutex<Status>,
    child: Mutex<Option<Child>>,
    stopping: AtomicBool,
    /// The current launch's stderr (bounded) plus exit notes, for diagnostics.
    last_error: Arc<Mutex<Option<String>>>,
    launch: Option<LaunchSpec>,
    policy: RespawnPolicy,
    liveness: Liveness,
    /// Debug builds' external engine: what the last health check of it found
    /// (`ExternalVerdict` as u8). The proxy sends nothing to another program.
    external_verdict: AtomicU8,
}

/// What the last health check of a debug build's external engine found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExternalVerdict {
    /// Not checked yet (the proxy checks before its first request).
    Unknown = 0,
    Ours = 1,
    Foreign = 2,
}

impl ExternalVerdict {
    fn from_u8(v: u8) -> Self {
        match v {
            1 => ExternalVerdict::Ours,
            2 => ExternalVerdict::Foreign,
            _ => ExternalVerdict::Unknown,
        }
    }
}

/// May the proxy send a request to the engine now? Only to an engine this
/// launch confirmed (`Ready`), or — debug builds — a dev engine whose health
/// answer named this app. Anything else could reach another program that
/// answers on the port (and an upload would hand it the user's data).
pub fn request_gate(status: &Status, external: ExternalVerdict) -> Result<(), &'static str> {
    match (status, external) {
        (Status::Ready, _) => Ok(()),
        (Status::External, ExternalVerdict::Ours) => Ok(()),
        (Status::External, ExternalVerdict::Foreign) => {
            Err("Another program is answering on the engine's port; nothing was sent to it.")
        }
        (Status::External, ExternalVerdict::Unknown) => Err("It did not answer its health check."),
        (Status::Starting | Status::Restarting { .. }, _) => Err("It may be starting or restarting; try again in a moment."),
        (Status::Down(_) | Status::Stopped, _) => Err("It is not running."),
    }
}

/// What `engine_health` reports when this app's engine answered its health
/// check. A supervised engine still `Starting` is reported as "starting" until
/// the supervisor has confirmed it (`Ready`, at most ~0.5 s later): until then
/// `request_gate` refuses requests, and an early "ok" would send the R probe
/// and the package checks into that refusal right at start-up.
pub fn state_when_ours(status: &Status) -> &'static str {
    match status {
        Status::Starting => "starting",
        _ => "ok",
    }
}

impl Engine {
    /// A dev engine someone started on `port` (debug builds).
    pub fn external(port: u16) -> Arc<Engine> {
        Arc::new(Engine {
            port: AtomicU16::new(port),
            generation: AtomicU32::new(0),
            token: Mutex::new(None),
            status: Mutex::new(Status::External),
            child: Mutex::new(None),
            stopping: AtomicBool::new(false),
            last_error: Arc::new(Mutex::new(None)),
            launch: None,
            policy: RespawnPolicy::default(),
            liveness: Liveness::default(),
            external_verdict: AtomicU8::new(ExternalVerdict::Unknown as u8),
        })
    }

    /// No engine could be set up at all (release build without a resource
    /// folder): reported as down with `msg`, never as "starting".
    pub fn failed(msg: String) -> Arc<Engine> {
        let e = Engine::external(0);
        *e.status.lock().unwrap() = Status::Down(msg.clone());
        e.set_error(msg);
        e
    }

    /// An engine this app starts and keeps running. Call `start` next.
    pub fn supervised(spec: LaunchSpec, policy: RespawnPolicy) -> Arc<Engine> {
        Engine::supervised_with(spec, policy, Liveness::default())
    }

    pub fn supervised_with(spec: LaunchSpec, policy: RespawnPolicy, liveness: Liveness) -> Arc<Engine> {
        Arc::new(Engine {
            port: AtomicU16::new(0),
            generation: AtomicU32::new(0),
            token: Mutex::new(None),
            status: Mutex::new(Status::Starting),
            child: Mutex::new(None),
            stopping: AtomicBool::new(false),
            last_error: Arc::new(Mutex::new(None)),
            launch: Some(spec),
            policy,
            liveness,
            external_verdict: AtomicU8::new(ExternalVerdict::Unknown as u8),
        })
    }

    /// Record what a health check of an external (debug) engine found.
    pub fn note_external(&self, v: ExternalVerdict) {
        self.external_verdict.store(v as u8, Ordering::SeqCst);
    }

    /// An external engine that has not been health-checked yet.
    pub fn external_unchecked(&self) -> bool {
        self.status() == Status::External
            && ExternalVerdict::from_u8(self.external_verdict.load(Ordering::SeqCst)) == ExternalVerdict::Unknown
    }

    /// `request_gate` for the current state.
    pub fn may_send(&self) -> Result<(), &'static str> {
        request_gate(&self.status(), ExternalVerdict::from_u8(self.external_verdict.load(Ordering::SeqCst)))
    }

    /// The port the engine listens on now (it changes when it is restarted).
    pub fn port(&self) -> u16 {
        self.port.load(Ordering::SeqCst)
    }

    /// Number of engine processes started so far (0 for an external engine).
    pub fn generation(&self) -> u32 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }

    pub fn token(&self) -> Option<String> {
        self.token.lock().unwrap().clone()
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().unwrap().clone()
    }

    pub fn set_error(&self, msg: String) {
        *self.last_error.lock().unwrap() = Some(msg);
    }

    /// The pid of the running engine, if any.
    #[allow(dead_code)] // tests and diagnostics
    pub fn pid(&self) -> Option<u32> {
        self.child.lock().unwrap().as_ref().map(|c| c.id())
    }

    fn set_status(&self, s: Status) {
        let mut cur = self.status.lock().unwrap();
        // Once stopped, stay stopped (a late supervisor update must not undo it).
        if *cur != Status::Stopped {
            *cur = s;
        }
    }

    /// Start the supervisor thread (spawns the engine, restarts it when it
    /// exits unexpectedly). Does nothing for an external engine.
    pub fn start(self: &Arc<Self>) {
        if self.launch.is_none() {
            return;
        }
        let me = self.clone();
        std::thread::Builder::new()
            .name("engine-supervisor".into())
            .spawn(move || me.supervise())
            .expect("spawn engine supervisor");
    }

    /// After the supervisor gave up (`Down`), start it again with a fresh
    /// restart history (the gate's Try again). False when there is nothing to
    /// restart: not down, stopping, or no engine this app starts.
    pub fn restart(self: &Arc<Self>) -> bool {
        if self.launch.is_none() || self.stopping() {
            return false;
        }
        {
            // Checked and changed under one lock, so two calls cannot start
            // two supervisors. `Down` is set only right before the supervisor
            // thread returns, so none is running now.
            let mut st = self.status.lock().unwrap();
            if !matches!(*st, Status::Down(_)) {
                return false;
            }
            *st = Status::Starting;
        }
        eprintln!("[las-engine] restarting the engine on request");
        self.start();
        true
    }

    /// Stop the engine for good: no restart afterwards. Kills only the process
    /// this app spawned and the processes below it (engineproc.rs).
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        *self.status.lock().unwrap() = Status::Stopped;
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                eprintln!("[las-engine] stopping engine process {}", child.id());
                kill_engine(&mut child);
            }
        }
    }

    fn stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    /// Spawn one engine process on `port` with `token`. Holds the child lock
    /// while checking `stopping`, so a concurrent `stop` either prevents the
    /// spawn or kills what was spawned.
    fn spawn_once(&self, port: u16, token: &str) -> Result<(), String> {
        let spec = self.launch.as_ref().ok_or("no launch spec")?;
        let mut guard = self.child.lock().unwrap();
        if self.stopping() {
            return Err("stopping".into());
        }
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.pre_args);
        cmd.arg("--port").arg(port.to_string());
        // The engine exits by itself if this process dies without a clean
        // quit (crash, force-quit), so no orphan is left behind.
        cmd.arg("--parent-pid").arg(std::process::id().to_string());
        if let Some(dir) = &spec.r_env_dir {
            cmd.arg("--r-env-dir").arg(dir);
        }
        // The token goes through the environment, not the command line (which
        // other local users can read with ps).
        cmd.env(ENV_ENGINE_TOKEN, token);
        if let Some(dir) = &spec.cwd {
            cmd.current_dir(dir);
        }
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        // Its own process group (pgid = its pid): the R processes it starts
        // can be stopped with it even after it died (engineproc::kill_group).
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start the analysis engine ({}): {e}", spec.program.display()))?;
        eprintln!("[las-engine] started process {} on port {}", child.id(), port);
        self.generation.fetch_add(1, Ordering::SeqCst);
        *self.last_error.lock().unwrap() = None;
        if let Some(out) = child.stdout.take() {
            std::thread::spawn(move || {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    eprintln!("[las-engine] {line}");
                }
            });
        }
        if let Some(err) = child.stderr.take() {
            let sink = self.last_error.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    eprintln!("[las-engine stderr] {line}");
                    if let Ok(mut e) = sink.lock() {
                        let cur = e.get_or_insert_with(String::new);
                        if cur.len() < 2000 {
                            cur.push_str(&line);
                            cur.push('\n');
                        }
                    }
                }
            });
        }
        *guard = Some(child);
        Ok(())
    }

    fn supervise(self: Arc<Self>) {
        let started = Instant::now();
        let now_ms = || started.elapsed().as_millis() as u64;
        let mut exits: Vec<u64> = Vec::new();
        let mut prev_port: u16 = 0;
        let mut attempt: u32 = 0;
        // Launches in a row that hung while starting.
        let mut boot_timeouts: u32 = 0;
        loop {
            if self.stopping() {
                return;
            }
            let launched = pick_free_port(&[prev_port])
                .map_err(|e| format!("No free local port for the analysis engine: {e}"))
                .and_then(|port| {
                    let token = new_token();
                    // Publish port + token before the process can answer.
                    *self.token.lock().unwrap() = Some(token.clone());
                    self.port.store(port, Ordering::SeqCst);
                    self.spawn_once(port, &token).map(|_| port)
                });
            let why = match launched {
                Ok(port) => {
                    prev_port = port;
                    self.set_status(Status::Starting);
                    match self.watch(port) {
                        None => return, // stopped on purpose
                        Some(end) => {
                            if end.was_ready {
                                boot_timeouts = 0;
                            } else if end.boot_timeout {
                                boot_timeouts += 1;
                            }
                            end.why
                        }
                    }
                }
                Err(e) => {
                    if self.stopping() {
                        return;
                    }
                    eprintln!("[las-engine] {e}");
                    self.set_error(e.clone());
                    e
                }
            };
            if self.stopping() {
                return;
            }
            exits.push(now_ms());
            let delay = if boot_timeouts >= self.liveness.max_boot_timeouts {
                None
            } else {
                respawn_delay(&exits, now_ms(), &self.policy)
            };
            match delay {
                Some(delay) => {
                    attempt += 1;
                    eprintln!("[las-engine] {why}; restarting in {} ms (attempt {attempt})", delay.as_millis());
                    self.set_status(Status::Restarting { attempt });
                    if !self.sleep_unless_stopping(delay) {
                        return;
                    }
                }
                None => {
                    let msg = if boot_timeouts >= self.liveness.max_boot_timeouts {
                        format!(
                            "The analysis engine did not start {boot_timeouts} times in a row and was not restarted again ({why}). Try again, or quit and reopen the app."
                        )
                    } else {
                        format!(
                            "The analysis engine stopped {} times within {} s and was not restarted again ({why}). Try again, or quit and reopen the app.",
                            self.policy.max_restarts + 1,
                            self.policy.window.as_secs()
                        )
                    };
                    eprintln!("[las-engine] {msg}");
                    self.set_status(Status::Down(msg));
                    return;
                }
            }
        }
    }

    /// Wait for the running engine to end. Confirms readiness on the way,
    /// then keeps checking that it answers. `None`: stopped on purpose;
    /// `Some`: it exited unexpectedly, or hung and was killed here.
    fn watch(&self, port: u16) -> Option<WatchEnd> {
        let spawned = Instant::now();
        let mut ready = false;
        let mut failed_probes: u32 = 0;
        let mut last_probe = Instant::now() - Duration::from_secs(3600);
        loop {
            std::thread::sleep(Duration::from_millis(200));
            if self.stopping() {
                return None;
            }
            {
                let mut guard = self.child.lock().unwrap();
                match guard.as_mut() {
                    None => return None, // taken by stop()
                    Some(child) => match child.try_wait() {
                        Ok(Some(st)) => {
                            let pid = child.id();
                            *guard = None;
                            drop(guard);
                            // What it started (R jobs) would otherwise run on
                            // unsupervised: re-parented, unreachable from its pid.
                            engineproc::kill_group(pid);
                            let why = format!("engine process {pid} exited unexpectedly ({st})");
                            self.note_exit(&why);
                            return Some(WatchEnd { why, was_ready: ready, boot_timeout: false });
                        }
                        Ok(None) => {}
                        Err(e) => {
                            eprintln!("[las-engine] cannot check the engine process: {e}");
                        }
                    },
                }
            }
            if let Some(hung) = liveness_verdict(ready, spawned.elapsed(), failed_probes, &self.liveness) {
                // Killed under the child lock: a concurrent stop() waits for
                // this and then finds nothing left to stop.
                let mut guard = self.child.lock().unwrap();
                let Some(mut child) = guard.take() else { return None };
                if self.stopping() {
                    *guard = Some(child); // stop() is about to kill it
                    return None;
                }
                let pid = child.id();
                kill_engine(&mut child);
                drop(guard);
                let why = format!("engine process {pid} was stopped: {hung}");
                self.note_exit(&why);
                return Some(WatchEnd { why, was_ready: ready, boot_timeout: !ready });
            }
            let every = if ready { self.liveness.probe_every } else { Duration::from_millis(500) };
            if last_probe.elapsed() >= every {
                last_probe = Instant::now();
                let token = self.token();
                let timeout = if ready { self.liveness.probe_timeout } else { Duration::from_secs(2) };
                let ours = http_get_local(port, "/api/health", timeout)
                    .map(|body| verify_health(&body, token.as_deref()) == Verdict::Ours)
                    .unwrap_or(false);
                if ours {
                    failed_probes = 0;
                    if !ready {
                        ready = true;
                        eprintln!("[las-engine] ready on port {port}");
                        self.set_status(Status::Ready);
                    }
                } else if ready {
                    failed_probes += 1;
                    if failed_probes == 1 || failed_probes % 4 == 0 {
                        eprintln!("[las-engine] health check failed ({failed_probes} in a row)");
                    }
                }
            }
        }
    }

    fn note_exit(&self, why: &str) {
        let mut e = self.last_error.lock().unwrap();
        let cur = e.get_or_insert_with(String::new);
        cur.push_str(&format!("[{why}]\n"));
    }

    /// Sleep `d`, waking early when stopping. False when stopping.
    fn sleep_unless_stopping(&self, d: Duration) -> bool {
        let until = Instant::now() + d;
        while Instant::now() < until {
            if self.stopping() {
                return false;
            }
            std::thread::sleep(Duration::from_millis(50).min(until.saturating_duration_since(Instant::now())));
        }
        !self.stopping()
    }
}

/// How one engine launch ended (other than a deliberate stop).
struct WatchEnd {
    why: String,
    /// It had answered with our token at some point.
    was_ready: bool,
    /// It never answered and was killed at the boot deadline.
    boot_timeout: bool,
}

/// Kill the engine process, the processes below it, and (unix) its process
/// group — the group first, while the engine is not yet reaped, so its pid
/// (= the group id) cannot have been reused.
fn kill_engine(child: &mut Child) {
    engineproc::kill_group(child.id());
    engineproc::kill_tree(child);
}

/// Minimal blocking HTTP/1.1 GET to 127.0.0.1:`port` (no proxy, no runtime),
/// for the supervisor thread's readiness probe. Returns the body of a 200.
pub fn http_get_local(port: u16, path: &str, timeout: Duration) -> std::io::Result<String> {
    use std::io::{Read, Write};
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut s = std::net::TcpStream::connect_timeout(&addr, timeout)?;
    s.set_read_timeout(Some(timeout))?;
    s.set_write_timeout(Some(timeout))?;
    // One write: a server that answers after its first read must not be left
    // with unread request bytes (it would reset the connection on close).
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nAccept: application/json\r\n\r\n");
    s.write_all(req.as_bytes())?;
    let mut raw = Vec::new();
    s.take(1 << 20).read_to_end(&mut raw)?;
    parse_http_response(&raw).ok_or_else(|| std::io::Error::other("unexpected HTTP answer"))
}

/// The body of a raw HTTP/1.x 200 response (handles chunked encoding).
pub fn parse_http_response(raw: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(raw);
    let (head, body) = text.split_once("\r\n\r\n")?;
    let status_ok = head.lines().next().map(|l| l.split_whitespace().nth(1) == Some("200")).unwrap_or(false);
    if !status_ok {
        return None;
    }
    let chunked = head
        .lines()
        .any(|l| l.to_ascii_lowercase().starts_with("transfer-encoding:") && l.to_ascii_lowercase().contains("chunked"));
    if !chunked {
        return Some(body.to_string());
    }
    let mut out = String::new();
    let mut rest = body;
    loop {
        let (size_line, after) = rest.split_once("\r\n")?;
        let size = usize::from_str_radix(size_line.split(';').next()?.trim(), 16).ok()?;
        if size == 0 {
            return Some(out);
        }
        out.push_str(after.get(..size)?);
        rest = after.get(size..)?.strip_prefix("\r\n")?;
    }
}

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;
