//! macOS: route Dock Quit, logout, shutdown and AppleScript quit through the
//! quit handshake (phase1-contract.md §6.2).
//!
//! tao's app delegate class (`TaoAppDelegateParent`, private; `--locked` pins
//! tao 0.34.6) has no `applicationShouldTerminate:`, so AppKit terminates at
//! once. We add the method at runtime: it answers NSTerminateLater (2) while
//! the frontend writes its unsaved work and asks the person, and the routine
//! later calls `replyToApplicationShouldTerminate:`. The quit driver's
//! watchdog guarantees that reply always comes.

use crate::quit::QuitDriver;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::MainThreadMarker;
use objc2_app_kit::NSApplication;
use std::sync::{Arc, OnceLock};

static DRIVER: OnceLock<Arc<QuitDriver>> = OnceLock::new();

extern "C" fn should_terminate(_this: *mut AnyObject, _sel: Sel, _sender: *mut AnyObject) -> usize {
    match DRIVER.get() {
        Some(d) => {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| d.should_terminate())).unwrap_or(1);
            log::info!("[quit] applicationShouldTerminate → {}", if r == 1 { "now" } else { "later" });
            r
        }
        None => 1, // NSTerminateNow
    }
}

/// Install the hook. Must run on the main thread (the setup hook does).
/// Returns a line for the startup log.
pub fn install(driver: Arc<QuitDriver>) -> Result<String, String> {
    let _ = DRIVER.set(driver);
    let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
    let app = NSApplication::sharedApplication(mtm);
    // SAFETY: plain Objective-C runtime calls on the live app delegate; the
    // added method's signature (Q@:@) matches `should_terminate`.
    unsafe {
        let delegate: *mut AnyObject = objc2::msg_send![&*app, delegate];
        if delegate.is_null() {
            return Err("the app has no delegate".into());
        }
        let cls = objc2::ffi::object_getClass(delegate as *const _) as *mut AnyClass;
        if cls.is_null() {
            return Err("the app delegate has no class".into());
        }
        let name = (*cls).name().to_string_lossy().into_owned();
        let sel = objc2::sel!(applicationShouldTerminate:);
        let imp: Imp = std::mem::transmute::<extern "C" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize, Imp>(should_terminate);
        let added = objc2::ffi::class_addMethod(cls, sel, imp, c"Q@:@".as_ptr());
        if added.as_bool() {
            Ok(format!("applicationShouldTerminate: hook installed on {name}"))
        } else {
            Err(format!("{name} already has applicationShouldTerminate: (tao changed?); the hook was not installed"))
        }
    }
}

/// `replyToApplicationShouldTerminate:` (main thread).
pub fn reply_terminate(app: &tauri::AppHandle, ok: bool) {
    let _ = app.run_on_main_thread(move || {
        if let Some(mtm) = MainThreadMarker::new() {
            NSApplication::sharedApplication(mtm).replyToApplicationShouldTerminate(ok);
        }
    });
}
