//! The app menu (phase1-contract.md §6.1). Custom items emit `app://menu`
//! `{id, path}` to the frontend; `app.quit` also starts the quit handshake.
//! Cmd+W is Close Tab (no predefined Close Window), Cmd+Q is a custom item.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

pub const EVT_MENU: &str = "app://menu";

pub const ABOUT: &str = "app.about";
pub const SETTINGS: &str = "app.settings";
pub const QUIT: &str = "app.quit";
pub const NEW: &str = "file.new";
pub const OPEN: &str = "file.open";
pub const OPEN_RECENT: &str = "file.open_recent";
pub const CLEAR_RECENT: &str = "file.clear_recent";
pub const SAVE: &str = "file.save";
pub const SAVE_AS: &str = "file.save_as";
pub const DUPLICATE: &str = "file.duplicate";
pub const CLOSE_TAB: &str = "file.close_tab";
pub const RECOVER: &str = "file.recover";
pub const EXPORT_LIBRARY: &str = "file.export_library";
pub const OLD_LIBRARY: &str = "file.old_library";
/// Phase 2: open / close the Versions panel (phase2-contract.md §4.4).
pub const VERSIONS: &str = "file.versions";
/// Phase 3: "Show Others When I'm Editing…" for the active tab (phase3-contract.md §3.10).
pub const SHARING: &str = "file.sharing";
const NO_RECENT: &str = "file.open_recent.none";

/// `MenuState` of contract.ts.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuState {
    pub has_doc: bool,
    pub can_save: bool,
    #[serde(default)]
    pub recent: Vec<RecentItem>,
    pub can_export_library: bool,
    pub has_old_library: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RecentItem {
    pub path: String,
    pub label: String,
}

/// `MenuEvent` of contract.ts.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MenuEvent {
    pub id: String,
    pub path: Option<String>,
}

/// Items whose enabled state follows `MenuState`, and the state's value.
pub fn enabled_flags(s: &MenuState) -> [(&'static str, bool); 8] {
    [
        (SAVE, s.can_save),
        (SAVE_AS, s.has_doc),
        (DUPLICATE, s.has_doc),
        (CLOSE_TAB, s.has_doc),
        (VERSIONS, s.has_doc),
        (SHARING, s.has_doc),
        (EXPORT_LIBRARY, s.can_export_library),
        (OLD_LIBRARY, s.has_old_library),
    ]
}

/// The Open Recent entries: (menu id, text), at most 10.
pub fn recent_entries(s: &MenuState) -> Vec<(String, String)> {
    s.recent.iter().take(10).enumerate().map(|(i, r)| (format!("{OPEN_RECENT}.{i}"), r.label.clone())).collect()
}

/// A click → the event for the frontend (None for predefined / inert items).
pub fn resolve_click(id: &str, recent: &[String]) -> Option<MenuEvent> {
    if id == NO_RECENT {
        return None;
    }
    if let Some(rest) = id.strip_prefix(&format!("{OPEN_RECENT}.")) {
        let i: usize = rest.parse().ok()?;
        return recent.get(i).map(|p| MenuEvent { id: OPEN_RECENT.into(), path: Some(p.clone()) });
    }
    const IDS: [&str; 16] = [
        ABOUT, SETTINGS, QUIT, NEW, OPEN, OPEN_RECENT, CLEAR_RECENT, SAVE, SAVE_AS, DUPLICATE, CLOSE_TAB, RECOVER,
        EXPORT_LIBRARY, OLD_LIBRARY, VERSIONS, SHARING,
    ];
    IDS.contains(&id).then(|| MenuEvent { id: id.to_string(), path: None })
}

/// Handles kept to update the menu from `app_set_menu_state`.
pub struct MenuHandles<R: Runtime> {
    items: Vec<(&'static str, MenuItem<R>)>,
    recent_menu: Submenu<R>,
    recent_paths: Mutex<Vec<String>>,
}

fn item<R: Runtime>(h: &AppHandle<R>, id: &str, text: &str, accel: Option<&str>, enabled: bool) -> tauri::Result<MenuItem<R>> {
    let mut b = MenuItemBuilder::with_id(id, text).enabled(enabled);
    if let Some(a) = accel {
        b = b.accelerator(a);
    }
    b.build(h)
}

pub fn build<R: Runtime>(h: &AppHandle<R>) -> tauri::Result<(Menu<R>, MenuHandles<R>)> {
    let mac = cfg!(target_os = "macos");
    let new = item(h, NEW, "New", Some("CmdOrCtrl+N"), true)?;
    let open = item(h, OPEN, "Open…", Some("CmdOrCtrl+O"), true)?;
    let recent_menu = SubmenuBuilder::with_id(h, OPEN_RECENT, "Open Recent").build()?;
    let save = item(h, SAVE, "Save", Some("CmdOrCtrl+S"), false)?;
    let save_as = item(h, SAVE_AS, "Save As…", Some("CmdOrCtrl+Shift+S"), false)?;
    let duplicate = item(h, DUPLICATE, "Duplicate as a New Analysis…", None, false)?;
    let close_tab = item(h, CLOSE_TAB, "Close Tab", Some("CmdOrCtrl+W"), false)?;
    let versions = item(h, VERSIONS, "Versions", None, false)?;
    let sharing = item(h, SHARING, "Show Others When I'm Editing…", None, false)?;
    let recover = item(h, RECOVER, "Recover Unsaved Work…", None, true)?;
    let old_library = item(h, OLD_LIBRARY, "Old Library…", None, false)?;
    let export = item(h, EXPORT_LIBRARY, "Export Library to Files…", None, false)?;
    let settings = item(h, SETTINGS, "Settings…", Some("CmdOrCtrl+,"), true)?;
    let about = item(h, ABOUT, "About Lab Analysis Suite", None, true)?;
    let quit = if mac {
        item(h, QUIT, "Quit Lab Analysis Suite", Some("CmdOrCtrl+Q"), true)?
    } else if cfg!(windows) {
        item(h, QUIT, "Exit", None, true)?
    } else {
        item(h, QUIT, "Quit", Some("CmdOrCtrl+Q"), true)?
    };

    let mut file = SubmenuBuilder::new(h, "File")
        .item(&new)
        .item(&open)
        .item(&recent_menu)
        .separator()
        .item(&save)
        .item(&save_as)
        .item(&duplicate)
        .separator()
        .item(&close_tab)
        .item(&versions)
        .item(&sharing)
        .separator()
        .item(&recover)
        .item(&old_library)
        .item(&export);
    if !mac {
        file = file.separator().item(&settings).separator().item(&quit);
    }
    let file = file.build()?;
    let edit = SubmenuBuilder::new(h, "Edit").undo().redo().separator().cut().copy().paste().select_all().build()?;
    let window = SubmenuBuilder::new(h, "Window")
        .item(&PredefinedMenuItem::minimize(h, None)?)
        .item(&PredefinedMenuItem::maximize(h, None)?)
        .build()?;

    let menu = if mac {
        let app_menu = SubmenuBuilder::new(h, "Lab Analysis Suite")
            .item(&about)
            .separator()
            .item(&settings)
            .separator()
            .item(&PredefinedMenuItem::services(h, None)?)
            .separator()
            .item(&PredefinedMenuItem::hide(h, None)?)
            .item(&PredefinedMenuItem::hide_others(h, None)?)
            .item(&PredefinedMenuItem::show_all(h, None)?)
            .separator()
            .item(&quit)
            .build()?;
        let view = SubmenuBuilder::new(h, "View").item(&PredefinedMenuItem::fullscreen(h, None)?).build()?;
        Menu::with_items(h, &[&app_menu, &file, &edit, &view, &window])?
    } else {
        let help = SubmenuBuilder::new(h, "Help").item(&about).build()?;
        Menu::with_items(h, &[&file, &edit, &window, &help])?
    };

    let handles = MenuHandles {
        items: vec![
            (SAVE, save),
            (SAVE_AS, save_as),
            (DUPLICATE, duplicate),
            (CLOSE_TAB, close_tab),
            (VERSIONS, versions),
            (SHARING, sharing),
            (EXPORT_LIBRARY, export),
            (OLD_LIBRARY, old_library),
        ],
        recent_menu,
        recent_paths: Mutex::new(Vec::new()),
    };
    fill_recent(h, &handles, &MenuState::default())?;
    Ok((menu, handles))
}

fn fill_recent<R: Runtime>(h: &AppHandle<R>, m: &MenuHandles<R>, s: &MenuState) -> tauri::Result<()> {
    while m.recent_menu.remove_at(0)?.is_some() {}
    let entries = recent_entries(s);
    if entries.is_empty() {
        m.recent_menu.append(&item(h, NO_RECENT, "No Recent Files", None, false)?)?;
    } else {
        for (id, text) in &entries {
            m.recent_menu.append(&item(h, id, text, None, true)?)?;
        }
    }
    m.recent_menu.append(&PredefinedMenuItem::separator(h)?)?;
    m.recent_menu.append(&item(h, CLEAR_RECENT, "Clear Menu", None, !entries.is_empty())?)?;
    *crate::graphfile::lk(&m.recent_paths) = s.recent.iter().take(10).map(|r| r.path.clone()).collect();
    Ok(())
}

/// `app_set_menu_state`.
pub fn apply_state<R: Runtime>(h: &AppHandle<R>, m: &MenuHandles<R>, s: &MenuState) -> tauri::Result<()> {
    for (id, on) in enabled_flags(s) {
        if let Some((_, it)) = m.items.iter().find(|(i, _)| *i == id) {
            it.set_enabled(on)?;
        }
    }
    fill_recent(h, m, s)
}

/// A menu click: emit `app://menu`; returns true for Quit (the caller starts
/// the quit handshake).
pub fn on_click<R: Runtime>(h: &AppHandle<R>, m: Option<&MenuHandles<R>>, id: &str) -> bool {
    let recent = m.map(|m| crate::graphfile::lk(&m.recent_paths).clone()).unwrap_or_default();
    if let Some(ev) = resolve_click(id, &recent) {
        let _ = h.emit(EVT_MENU, &ev);
    }
    id == QUIT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clicks_resolve() {
        let recent = vec!["/a/x.lag".to_string(), "/b/y.lag".to_string()];
        assert_eq!(resolve_click("file.save", &recent), Some(MenuEvent { id: "file.save".into(), path: None }));
        assert_eq!(
            resolve_click("file.open_recent.1", &recent),
            Some(MenuEvent { id: "file.open_recent".into(), path: Some("/b/y.lag".into()) })
        );
        assert_eq!(resolve_click("file.open_recent.5", &recent), None);
        assert_eq!(resolve_click("file.open_recent.none", &recent), None);
        assert_eq!(resolve_click("file.open_recent.x", &recent), None);
        assert_eq!(resolve_click("app.quit", &recent).unwrap().id, "app.quit");
        assert_eq!(resolve_click("something-predefined", &recent), None);
        // phase 2
        assert_eq!(resolve_click("file.versions", &recent), Some(MenuEvent { id: "file.versions".into(), path: None }));
        // phase 3 (R11)
        assert_eq!(resolve_click("file.sharing", &recent), Some(MenuEvent { id: "file.sharing".into(), path: None }));
        let v = serde_json::to_value(MenuEvent { id: "file.new".into(), path: None }).unwrap();
        assert_eq!(v, serde_json::json!({"id": "file.new", "path": null}));
    }

    #[test]
    fn state_maps_to_items() {
        let s: MenuState = serde_json::from_value(serde_json::json!({
            "hasDoc": true, "canSave": false, "canExportLibrary": true, "hasOldLibrary": false,
            "recent": (0..14).map(|i| serde_json::json!({"path": format!("/p{i}.lag"), "label": format!("p{i} — Lab")})).collect::<Vec<_>>()
        }))
        .unwrap();
        let f = enabled_flags(&s);
        assert!(f.contains(&(SAVE, false)) && f.contains(&(SAVE_AS, true)) && f.contains(&(CLOSE_TAB, true)));
        assert!(f.contains(&(EXPORT_LIBRARY, true)) && f.contains(&(OLD_LIBRARY, false)));
        assert!(f.contains(&(VERSIONS, true)), "Versions follows hasDoc");
        assert!(f.contains(&(SHARING, true)), "Show Others When I'm Editing… follows hasDoc");
        let r = recent_entries(&s);
        assert_eq!(r.len(), 10);
        assert_eq!(r[3], ("file.open_recent.3".to_string(), "p3 — Lab".to_string()));
        let d = MenuState::default();
        assert!(enabled_flags(&d).iter().all(|(_, on)| !on), "everything off before the first call");
    }
}
