use super::*;
use std::io::{Read, Write};

#[test]
fn exe_name_per_os() {
    assert_eq!(engine_exe_name("windows"), "las-engine.exe");
    assert_eq!(engine_exe_name("macos"), "las-engine");
    assert_eq!(engine_exe_name("linux"), "las-engine");
    for os in ["windows", "macos", "linux"] {
        // Another app's `pkill -f api-server` / `taskkill /IM api-server.exe`
        // must not match this app's engine.
        assert!(!engine_exe_name(os).contains("api-server"));
    }
    assert_eq!(engine_exe_name(std::env::consts::OS), if cfg!(windows) { "las-engine.exe" } else { "las-engine" });
}

#[test]
fn picked_port_is_free_and_never_the_legacy_or_avoided_one() {
    // A port held by "another program" is never handed out.
    let held = TcpListener::bind("127.0.0.1:0").unwrap();
    let held_port = held.local_addr().unwrap().port();
    let mut seen = Vec::new();
    for _ in 0..20 {
        let p = pick_free_port(&[held_port]).unwrap();
        assert_ne!(p, 0);
        assert_ne!(p, held_port);
        assert_ne!(p, LEGACY_FIXED_PORT);
        seen.push(p);
    }
    // The picked port really can be bound by the engine.
    let p = pick_free_port(&[]).unwrap();
    TcpListener::bind(("127.0.0.1", p)).expect("picked port is bindable");
    // Avoid list is honoured even if the OS would offer that port again.
    let avoid: Vec<u16> = seen.clone();
    let q = pick_free_port(&avoid).unwrap();
    assert!(!avoid.contains(&q));
    drop(held);
}

#[test]
fn tokens_are_long_random_hex() {
    let a = new_token();
    let b = new_token();
    assert_eq!(a.len(), 64);
    assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(a, b);
}

#[test]
fn health_verdicts() {
    let tok = "abc123";
    // What the other app's engine answers: status ok, nothing else.
    assert!(matches!(verify_health(r#"{"status":"ok"}"#, Some(tok)), Verdict::Foreign(_)));
    assert!(matches!(verify_health(r#"{"status":"ok"}"#, None), Verdict::Foreign(_)));
    // 404 body, HTML, empty.
    assert!(matches!(verify_health(r#"{"detail":"Not Found"}"#, Some(tok)), Verdict::Foreign(_)));
    assert!(matches!(verify_health("<html>hi</html>", Some(tok)), Verdict::Foreign(_)));
    assert!(matches!(verify_health("", None), Verdict::Foreign(_)));
    // Our app, but another launch (wrong / missing token).
    let other = r#"{"status":"ok","app":"lab-analysis-suite","token":"zzz"}"#;
    assert!(matches!(verify_health(other, Some(tok)), Verdict::Foreign(_)));
    let none = r#"{"status":"ok","app":"lab-analysis-suite"}"#;
    assert!(matches!(verify_health(none, Some(tok)), Verdict::Foreign(_)));
    let empty = r#"{"status":"ok","app":"lab-analysis-suite","token":""}"#;
    assert!(matches!(verify_health(empty, Some("")), Verdict::Foreign(_)));
    // Ours.
    let ours = r#"{"status":"ok","app":"lab-analysis-suite","token":"abc123"}"#;
    assert_eq!(verify_health(ours, Some(tok)), Verdict::Ours);
    // Dev engine started by hand: no token expected, the app name must match.
    assert_eq!(verify_health(none, None), Verdict::Ours);
    assert_eq!(verify_health(ours, None), Verdict::Ours);
    let wrong_app = r#"{"status":"ok","app":"multi-panel-figure","token":"abc123"}"#;
    assert!(matches!(verify_health(wrong_app, Some(tok)), Verdict::Foreign(_)));
    let not_ok = r#"{"status":"starting","app":"lab-analysis-suite","token":"abc123"}"#;
    assert!(matches!(verify_health(not_ok, Some(tok)), Verdict::Foreign(_)));
    // The detail text never echoes the token.
    if let Verdict::Foreign(why) = verify_health(other, Some(tok)) {
        assert!(!why.contains(tok) && !why.contains("zzz"), "{why}");
    }
}

#[test]
fn respawn_backoff_policy() {
    let p = RespawnPolicy::default(); // 5 within 120 s, 1 s doubling, cap 16 s
    let s = |n: u64| Duration::from_secs(n);
    assert_eq!(respawn_delay(&[1_000], 1_000, &p), Some(s(1)));
    assert_eq!(respawn_delay(&[1_000, 2_000], 2_000, &p), Some(s(2)));
    assert_eq!(respawn_delay(&[1_000, 2_000, 3_000], 3_000, &p), Some(s(4)));
    assert_eq!(respawn_delay(&[1_000, 2_000, 3_000, 4_000], 4_000, &p), Some(s(8)));
    assert_eq!(respawn_delay(&[1_000, 2_000, 3_000, 4_000, 5_000], 5_000, &p), Some(s(16)));
    // Sixth exit within two minutes: give up.
    assert_eq!(respawn_delay(&[1_000, 2_000, 3_000, 4_000, 5_000, 6_000], 6_000, &p), None);
    // Exits older than the window no longer count: a crash a day is restarted.
    let old: Vec<u64> = vec![0, 10_000, 20_000, 30_000, 40_000];
    assert_eq!(respawn_delay(&[old.clone(), vec![200_000]].concat(), 200_000, &p), Some(s(1)));
    // Cap.
    let p2 = RespawnPolicy { max_restarts: 50, ..p };
    let many: Vec<u64> = (0..40).map(|i| i * 10).collect();
    assert_eq!(respawn_delay(&many, 400, &p2), Some(s(16)));
    // No exits recorded counts as the first.
    assert_eq!(respawn_delay(&[], 5, &p), Some(s(1)));
}

#[test]
fn liveness_policy() {
    let l = Liveness::default(); // boot 240 s, 18 failed checks
    let s = Duration::from_secs;
    // Starting: fine until the boot deadline, hung from then on.
    assert_eq!(liveness_verdict(false, s(10), 0, &l), None);
    assert_eq!(liveness_verdict(false, s(239), 0, &l), None);
    assert!(liveness_verdict(false, s(240), 0, &l).unwrap().contains("did not answer within 240 s"));
    // Ready: the boot deadline no longer applies; only failed checks in a row.
    assert_eq!(liveness_verdict(true, s(10_000), 0, &l), None);
    assert_eq!(liveness_verdict(true, s(10_000), 17, &l), None);
    assert!(liveness_verdict(true, s(10_000), 18, &l).unwrap().contains("stopped answering"));
    // ~3 minutes without any answer before a ready engine is called hung.
    let quiet = l.probe_every * l.max_failed_probes;
    assert!(quiet >= s(180), "{quiet:?}");
}

#[test]
fn requests_only_reach_a_confirmed_engine() {
    use ExternalVerdict::*;
    assert_eq!(request_gate(&Status::Ready, Unknown), Ok(()));
    assert_eq!(request_gate(&Status::External, Ours), Ok(()));
    // Another program on a dev engine's port, or not checked: nothing is sent.
    assert!(request_gate(&Status::External, Foreign).unwrap_err().contains("Another program"));
    assert!(request_gate(&Status::External, Unknown).is_err());
    // A supervised engine not (yet) confirmed by its token: nothing is sent,
    // whatever answers on the port.
    assert!(request_gate(&Status::Starting, Unknown).is_err());
    assert!(request_gate(&Status::Restarting { attempt: 1 }, Unknown).is_err());
    assert!(request_gate(&Status::Down("x".into()), Unknown).is_err());
    assert!(request_gate(&Status::Stopped, Unknown).is_err());
}

#[test]
fn health_says_ok_only_when_requests_are_let_through() {
    // Our engine answered, but the supervisor has not confirmed it yet: the
    // proxy would refuse requests, so the frontend must not see "ok" yet.
    assert_eq!(state_when_ours(&Status::Starting), "starting");
    assert!(request_gate(&Status::Starting, ExternalVerdict::Unknown).is_err());
    assert_eq!(state_when_ours(&Status::Ready), "ok");
    assert!(request_gate(&Status::Ready, ExternalVerdict::Unknown).is_ok());
    // Debug build's dev engine: its own health answer is the confirmation.
    assert_eq!(state_when_ours(&Status::External), "ok");
}

#[test]
fn an_engine_that_could_not_be_set_up_is_down_not_starting() {
    let e = Engine::failed("Failed to resolve resource dir: nope".into());
    assert_eq!(e.status(), Status::Down("Failed to resolve resource dir: nope".into()));
    assert_eq!(e.last_error().as_deref(), Some("Failed to resolve resource dir: nope"));
    assert!(e.may_send().is_err());
    assert!(!e.restart(), "nothing to restart without a launch spec");
}

#[test]
fn external_engine_found_foreign_gets_no_requests() {
    let e = Engine::external(5);
    assert!(e.external_unchecked());
    assert!(e.may_send().is_err());
    e.note_external(ExternalVerdict::Ours);
    assert!(!e.external_unchecked());
    assert!(e.may_send().is_ok());
    e.note_external(ExternalVerdict::Foreign);
    assert!(e.may_send().is_err());
    // A supervised engine is never "unchecked" in this sense.
    let spec = LaunchSpec { program: "x".into(), pre_args: vec![], cwd: None, r_env_dir: None };
    assert!(!Engine::supervised(spec, RespawnPolicy::default()).external_unchecked());
}

#[test]
fn parses_http_responses() {
    let plain = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 15\r\n\r\n{\"status\":\"ok\"}";
    assert_eq!(parse_http_response(plain).as_deref(), Some("{\"status\":\"ok\"}"));
    let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{\"a\":1,\r\n5\r\n\"b\":2\r\n1\r\n}\r\n0\r\n\r\n";
    assert_eq!(parse_http_response(chunked).as_deref(), Some("{\"a\":1,\"b\":2}"));
    let nf = b"HTTP/1.1 404 Not Found\r\ncontent-length: 22\r\n\r\n{\"detail\":\"Not Found\"}";
    assert_eq!(parse_http_response(nf), None);
    assert_eq!(parse_http_response(b"garbage"), None);
}

/// A stand-in for another app's engine: answers every request with `body`.
fn fake_server(body: &'static str) -> (u16, std::thread::JoinHandle<()>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let h = std::thread::spawn(move || {
        for _ in 0..3 {
            let Ok((mut s, _)) = l.accept() else { return };
            // Read the whole request head before answering.
            let mut got = Vec::new();
            let mut buf = [0u8; 2048];
            while !got.windows(4).any(|w| w == b"\r\n\r\n") {
                match s.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => got.extend_from_slice(&buf[..n]),
                }
            }
            let _ = write!(
                s,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
        }
    });
    (port, h)
}

#[test]
fn another_programs_engine_is_never_ours() {
    let (port, _h) = fake_server(r#"{"status":"ok"}"#);
    let body = http_get_local(port, "/api/health", Duration::from_secs(2)).unwrap();
    assert_eq!(body, r#"{"status":"ok"}"#);
    assert!(matches!(verify_health(&body, Some(&new_token())), Verdict::Foreign(_)));
    assert!(matches!(verify_health(&body, None), Verdict::Foreign(_)));
}

// ── Supervisor with a real child process (unix; needs python3) ─────────────

#[cfg(unix)]
mod supervisor {
    use super::*;

    const FAKE_ENGINE: &str = r#"
import os, sys, json, http.server
port = int(sys.argv[sys.argv.index('--port') + 1])
tok = os.environ.get('LAS_ENGINE_TOKEN', '')
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b = json.dumps({'status': 'ok', 'app': 'lab-analysis-suite', 'token': tok}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def log_message(self, *a):
        pass
if 'spawn-child' in sys.argv:
    import subprocess
    subprocess.Popen(['sleep', '300'])  # stands in for an R job
http.server.HTTPServer(('127.0.0.1', port), H).serve_forever()
"#;

    fn python3() -> Option<PathBuf> {
        let o = Command::new("python3").arg("-c").arg("import sys; print(sys.executable)").output().ok()?;
        o.status.success().then(|| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()))
    }

    fn alive(pid: u32) -> bool {
        let o = Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
        let stat = String::from_utf8_lossy(&o.stdout).trim().to_string();
        !stat.is_empty() && !stat.starts_with('Z')
    }

    fn wait_until(secs: u64, mut f: impl FnMut() -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(secs) {
            if f() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    fn fast() -> RespawnPolicy {
        RespawnPolicy { max_restarts: 3, window: Duration::from_secs(60), base: Duration::from_millis(50), cap: Duration::from_millis(200) }
    }

    #[test]
    fn restarts_a_killed_engine_and_stop_is_final() {
        let Some(py) = python3() else {
            eprintln!("python3 not found; skipping");
            return;
        };
        let spec = LaunchSpec { program: py, pre_args: vec!["-c".into(), FAKE_ENGINE.into()], cwd: None, r_env_dir: None };
        let eng = Engine::supervised(spec, fast());
        eng.start();
        assert!(wait_until(20, || eng.status() == Status::Ready), "never ready: {:?}", eng.status());
        let (pid1, port1, tok1) = (eng.pid().unwrap(), eng.port(), eng.token().unwrap());
        assert_eq!(eng.generation(), 1);
        let body = http_get_local(port1, "/api/health", Duration::from_secs(2)).unwrap();
        assert_eq!(verify_health(&body, Some(&tok1)), Verdict::Ours);

        // Killed from outside (as another app's pkill would): restarted on a
        // new port with a new token.
        Command::new("kill").args(["-9", &pid1.to_string()]).status().unwrap();
        assert!(
            wait_until(20, || eng.status() == Status::Ready && eng.pid().is_some_and(|p| p != pid1)),
            "not restarted: {:?}",
            eng.status()
        );
        let (pid2, port2, tok2) = (eng.pid().unwrap(), eng.port(), eng.token().unwrap());
        assert_ne!(port2, port1);
        assert_ne!(tok2, tok1);
        assert_eq!(eng.generation(), 2);
        let body = http_get_local(port2, "/api/health", Duration::from_secs(2)).unwrap();
        assert_eq!(verify_health(&body, Some(&tok2)), Verdict::Ours);
        assert!(matches!(verify_health(&body, Some(&tok1)), Verdict::Foreign(_)));

        // Quit: stopped for good, nothing restarted.
        eng.stop();
        assert!(wait_until(5, || !alive(pid2)), "engine survived stop");
        std::thread::sleep(Duration::from_millis(800));
        assert_eq!(eng.pid(), None);
        assert_eq!(eng.status(), Status::Stopped);
    }

    #[test]
    fn gives_up_after_repeated_exits() {
        // An "engine" that dies at once (e.g. its port was taken).
        let spec = LaunchSpec {
            program: PathBuf::from("sh"),
            pre_args: vec!["-c".into(), "echo boom >&2; exit 3".into(), "las-engine".into()],
            cwd: None,
            r_env_dir: None,
        };
        let eng = Engine::supervised(spec, fast());
        eng.start();
        assert!(wait_until(10, || matches!(eng.status(), Status::Down(_))), "{:?}", eng.status());
        let Status::Down(msg) = eng.status() else { unreachable!() };
        assert!(msg.contains("was not restarted"), "{msg}");
        assert!(eng.last_error().unwrap_or_default().contains("exited unexpectedly"));
        eng.stop();
    }

    fn quick_liveness() -> Liveness {
        Liveness {
            boot_deadline: Duration::from_millis(1500),
            probe_every: Duration::from_millis(300),
            probe_timeout: Duration::from_millis(300),
            max_failed_probes: 3,
            max_boot_timeouts: 2,
        }
    }

    fn py_spec(py: PathBuf, extra: &[&str]) -> LaunchSpec {
        let mut pre_args = vec!["-c".to_string(), FAKE_ENGINE.to_string()];
        pre_args.extend(extra.iter().map(|s| s.to_string()));
        LaunchSpec { program: py, pre_args, cwd: None, r_env_dir: None }
    }

    #[test]
    fn hung_at_boot_is_restarted_then_given_up_and_restart_works() {
        // An "engine" that runs but never listens.
        let spec = LaunchSpec {
            program: PathBuf::from("sh"),
            pre_args: vec!["-c".into(), "sleep 60".into(), "las-engine".into()],
            cwd: None,
            r_env_dir: None,
        };
        let eng = Engine::supervised_with(spec, fast(), quick_liveness());
        eng.start();
        assert!(wait_until(5, || eng.generation() >= 2), "hung boot was not restarted: {:?}", eng.status());
        assert!(wait_until(10, || matches!(eng.status(), Status::Down(_))), "{:?}", eng.status());
        let Status::Down(msg) = eng.status() else { unreachable!() };
        assert!(msg.contains("did not start 2 times in a row"), "{msg}");
        assert_eq!(eng.generation(), 2);
        assert_eq!(eng.pid(), None, "the hung process was not stopped");
        assert!(eng.last_error().unwrap_or_default().contains("did not answer within"));

        // Try again after giving up: a fresh start (and only one supervisor).
        assert!(eng.restart());
        assert!(!eng.restart(), "a second restart while one runs must be refused");
        assert!(wait_until(5, || eng.generation() == 3), "{:?}", eng.status());
        eng.stop();
        assert!(!eng.restart(), "no restart after quit");
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(eng.pid(), None);
        assert_eq!(eng.status(), Status::Stopped);
    }

    #[test]
    fn hung_after_ready_is_restarted() {
        let Some(py) = python3() else {
            eprintln!("python3 not found; skipping");
            return;
        };
        let eng = Engine::supervised_with(py_spec(py, &[]), fast(), quick_liveness());
        eng.start();
        assert!(wait_until(20, || eng.status() == Status::Ready), "never ready: {:?}", eng.status());
        let pid1 = eng.pid().unwrap();
        // Frozen: alive, but answers nothing.
        Command::new("kill").args(["-STOP", &pid1.to_string()]).status().unwrap();
        assert!(
            wait_until(20, || eng.status() == Status::Ready && eng.pid().is_some_and(|p| p != pid1)),
            "hung engine not replaced: {:?}",
            eng.status()
        );
        assert!(wait_until(5, || !alive(pid1)), "hung engine still alive");
        assert_eq!(eng.generation(), 2);
        eng.stop();
    }

    #[test]
    fn jobs_of_an_engine_killed_from_outside_are_stopped() {
        let Some(py) = python3() else {
            eprintln!("python3 not found; skipping");
            return;
        };
        let eng = Engine::supervised(py_spec(py, &["spawn-child"]), fast());
        eng.start();
        assert!(wait_until(20, || eng.status() == Status::Ready), "never ready: {:?}", eng.status());
        let pid1 = eng.pid().unwrap();
        assert!(wait_until(5, || !engineproc::descendants_of(pid1).is_empty()));
        let job1 = engineproc::descendants_of(pid1)[0];

        Command::new("kill").args(["-9", &pid1.to_string()]).status().unwrap();
        assert!(wait_until(5, || !alive(job1)), "the killed engine's job survived");
        assert!(wait_until(20, || eng.status() == Status::Ready && eng.pid().is_some_and(|p| p != pid1)));
        let pid2 = eng.pid().unwrap();
        assert!(wait_until(5, || !engineproc::descendants_of(pid2).is_empty()));
        let job2 = engineproc::descendants_of(pid2)[0];

        eng.stop();
        assert!(wait_until(5, || !alive(pid2) && !alive(job2)), "engine or its job survived stop");
    }

    #[test]
    fn stop_before_first_spawn_spawns_nothing() {
        let spec = LaunchSpec { program: PathBuf::from("sleep"), pre_args: vec!["30".into()], cwd: None, r_env_dir: None };
        let eng = Engine::supervised(spec, fast());
        eng.stop();
        eng.start();
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(eng.pid(), None);
        assert_eq!(eng.status(), Status::Stopped);
    }
}
