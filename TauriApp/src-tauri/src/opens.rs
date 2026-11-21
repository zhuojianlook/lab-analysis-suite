//! Files opened from Finder / the command line (phase1-contract.md §2.3).
//!
//! `RunEvent::Opened` arrives before setup and before the window exists, so
//! paths are buffered until the frontend calls `take_pending_opens` (its "I am
//! listening" signal). After that they go out live as `app://open-files`.

use crate::graphfile::lk;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const EVT_OPEN_FILES: &str = "app://open-files";

#[derive(Debug, Default)]
pub struct Pending {
    ready: bool,
    paths: Vec<String>,
}

impl Pending {
    /// Buffer the paths, or hand them back for a live event when ready.
    pub fn push(&mut self, paths: Vec<String>) -> Option<Vec<String>> {
        if paths.is_empty() {
            return None;
        }
        if self.ready {
            Some(paths)
        } else {
            for p in paths {
                if !self.paths.contains(&p) {
                    self.paths.push(p);
                }
            }
            None
        }
    }
    /// Drain the buffer and mark the frontend ready.
    pub fn take(&mut self) -> Vec<String> {
        self.ready = true;
        std::mem::take(&mut self.paths)
    }
}

static PENDING: Mutex<Pending> = Mutex::new(Pending { ready: false, paths: Vec::new() });

fn is_lag(p: &Path) -> bool {
    p.extension().map(|e| e.to_string_lossy().eq_ignore_ascii_case("lag")).unwrap_or(false)
}

/// `file://` URLs → `.lag` paths.
#[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
pub fn paths_from_urls(urls: &[url::Url]) -> Vec<String> {
    urls.iter()
        .filter(|u| u.scheme() == "file")
        .filter_map(|u| u.to_file_path().ok())
        .filter(|p| is_lag(p))
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// Process arguments that are existing `.lag` files (made absolute).
pub fn paths_from_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(&a);
            if p.is_absolute() {
                p
            } else {
                cwd.join(p)
            }
        })
        .filter(|p| is_lag(p) && p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// Buffer (before ready) or return the paths to emit now.
pub fn offer(paths: Vec<String>) -> Option<Vec<String>> {
    lk(&PENDING).push(paths)
}

/// `take_pending_opens`.
pub fn take() -> Vec<String> {
    lk(&PENDING).take()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffer_before_and_after_ready() {
        let mut p = Pending::default();
        assert_eq!(p.push(vec!["/a.lag".into()]), None);
        assert_eq!(p.push(vec!["/a.lag".into(), "/b.lag".into()]), None);
        assert_eq!(p.take(), vec!["/a.lag".to_string(), "/b.lag".to_string()]);
        assert_eq!(p.push(vec!["/c.lag".into()]), Some(vec!["/c.lag".to_string()]));
        assert!(p.take().is_empty());
        assert_eq!(p.push(vec![]), None);
    }

    #[test]
    fn urls_and_args() {
        let urls = vec![
            url::Url::parse("file:///Users/me/Dropbox/Lab/Dose%20response.LAG").unwrap(),
            url::Url::parse("file:///Users/me/x.txt").unwrap(),
            url::Url::parse("https://example.com/a.lag").unwrap(),
        ];
        assert_eq!(paths_from_urls(&urls), vec!["/Users/me/Dropbox/Lab/Dose response.LAG".to_string()]);
        let d = std::env::temp_dir().join(format!("las-p1-opens-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("a.lag"), b"x").unwrap();
        let args = vec!["app".to_string(), "-psn_0_1".into(), "a.lag".into(), "missing.lag".into(), d.join("a.lag").to_string_lossy().into()];
        let got = paths_from_args(args, &d);
        assert_eq!(got.len(), 2);
        assert!(got.iter().all(|p| p.ends_with("a.lag") && Path::new(p).is_absolute()));
        let _ = std::fs::remove_dir_all(&d);
    }
}
