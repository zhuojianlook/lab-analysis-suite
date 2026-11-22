//! Stopping the engine this app started, and nothing else.
//!
//! The engine used to be stopped with `pkill -f api-server` (`taskkill /IM
//! api-server.exe` on Windows), which also killed every other process whose
//! command line contains "api-server": another installed copy of this app, a
//! different app that bundles an engine of the same name, or the installed app
//! when a debug build quits. Now only the process this app spawned and the
//! processes below it are stopped. A debug build spawns no engine (unless its
//! LAS_DEV_ENGINE_CMD hook asks for one), so it normally stops nothing. The
//! engine is also no longer called "api-server" but "las-engine", so another
//! app's `pkill -f api-server` cannot stop it (engine.rs).

use std::process::{Child, Command};

/// Kill `child` and every process started below it, then reap it.
pub fn kill_tree(child: &mut Child) {
    let pid = child.id();
    #[cfg(unix)]
    {
        // Collected first: once the engine is gone its children are re-parented
        // and can no longer be found from its pid.
        let below = descendants_of(pid);
        let _ = child.kill();
        if !below.is_empty() {
            let mut cmd = Command::new("kill");
            cmd.arg("-9");
            for p in &below {
                cmd.arg(p.to_string());
            }
            let _ = cmd.output();
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // /T: this pid and the processes it started; nothing chosen by name.
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output();
        let _ = child.kill();
    }
    let _ = child.wait();
}

/// Kill every process in the process group `pgid` (unix). The engine is
/// started as the leader of its own group (engine.rs `spawn_once`), so this
/// reaches the R processes it started even after the engine itself died and
/// they were re-parented. Only ever called with the pid of an engine this app
/// spawned, right after it exited or before it is reaped: while any member of
/// the group lives, no new process can get that id. Does nothing on Windows
/// (taskkill /T in `kill_tree` covers a live engine's tree there).
pub fn kill_group(pgid: u32) {
    #[cfg(unix)]
    {
        if pgid > 1 {
            // SAFETY: plain syscall; ESRCH (no such group) is ignored.
            unsafe {
                libc::killpg(pgid as libc::pid_t, libc::SIGKILL);
            }
        }
    }
    #[cfg(not(unix))]
    let _ = pgid;
}

/// Every process below `pid` (children, grandchildren, ...), breadth first.
#[cfg(unix)]
pub fn descendants_of(pid: u32) -> Vec<u32> {
    let mut out: Vec<u32> = Vec::new();
    let mut queue = vec![pid];
    while let Some(p) = queue.pop() {
        let Ok(o) = Command::new("pgrep").arg("-P").arg(p.to_string()).output() else { continue };
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            if let Ok(c) = line.trim().parse::<u32>() {
                if c != pid && !out.contains(&c) {
                    out.push(c);
                    queue.push(c);
                }
            }
        }
        if out.len() > 4096 {
            break; // runaway guard
        }
    }
    out
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn alive(pid: u32) -> bool {
        // A zombie still answers kill -0; ask ps for its state instead.
        let o = Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
        let stat = String::from_utf8_lossy(&o.stdout).trim().to_string();
        !stat.is_empty() && !stat.starts_with('Z')
    }

    fn wait_until(mut f: impl FnMut() -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            if f() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn kills_the_tree_and_leaves_other_processes_alone() {
        // An unrelated process whose command line contains "api-server" (what
        // the old pkill pattern matched), standing in for another app's engine.
        let mut decoy = Command::new("sh").args(["-c", "sleep 30; : api-server", "api-server"]).spawn().unwrap();
        // The "engine": a shell with a child that has a child of its own.
        let mut engine = Command::new("sh")
            .args(["-c", "sh -c 'sleep 30 & wait' & sleep 30 & wait"])
            .spawn()
            .unwrap();
        assert!(wait_until(|| descendants_of(engine.id()).len() >= 3), "tree did not start");
        let below = descendants_of(engine.id());
        let root = engine.id();

        kill_tree(&mut engine);

        assert!(wait_until(|| !alive(root) && below.iter().all(|p| !alive(*p))), "tree survived: {below:?}");
        assert!(alive(decoy.id()), "the unrelated process was killed");
        let _ = decoy.kill();
        let _ = decoy.wait();
    }

    #[test]
    fn group_kill_reaches_children_of_an_engine_killed_from_outside() {
        use std::os::unix::process::CommandExt;
        // An unrelated process outside the group must survive.
        let mut decoy = Command::new("sleep").arg("30").spawn().unwrap();
        let mut engine = Command::new("sh").args(["-c", "sleep 30 & wait"]).process_group(0).spawn().unwrap();
        assert!(wait_until(|| !descendants_of(engine.id()).is_empty()), "child did not start");
        let orphan = descendants_of(engine.id())[0];
        let pgid = engine.id();
        // Killed from outside: its child is re-parented and survives.
        Command::new("kill").args(["-9", &pgid.to_string()]).status().unwrap();
        let _ = engine.wait();
        std::thread::sleep(Duration::from_millis(200));
        assert!(alive(orphan), "test setup: the orphan should still run");

        kill_group(pgid);

        assert!(wait_until(|| !alive(orphan)), "the dead engine's child survived");
        assert!(alive(decoy.id()), "a process outside the group was killed");
        let _ = decoy.kill();
        let _ = decoy.wait();
    }
}
