import { Suspense, lazy, useEffect } from "react";
import { useFileSession } from "../file/session";
import { MENU, type MenuId } from "../file/contract";
import { ConflictSheet } from "./ConflictSheet";
import { SaveAsKindDialog } from "./SaveAsKindDialog";
import { CloseDirtyDialog } from "./CloseDirtyDialog";
import { QuitDialog } from "./QuitDialog";
import { FindDialog } from "./FindDialog";
import { SettingsDialog } from "./SettingsDialog";
import { ExportLibraryDialog } from "./ExportLibraryDialog";
import { OldLibraryDialog } from "./OldLibraryDialog";
import { RecoverDialog } from "./RecoverDialog";
import { Toasts } from "./Toasts";
import { CombineDialog } from "./CombineDialog";
import { BringBackDialog } from "./BringBackDialog";
import { EditAnywayDialog } from "./EditAnywayDialog";
import { ResumeDialog } from "./ResumeDialog";
import { SharingDialog } from "./SharingDialog";

// Browser preview only: kept out of the desktop app's main chunk.
const PathPicker = lazy(() => import("./PathPicker").then((m) => ({ default: m.PathPicker })));
const SimPanel = lazy(() => import("./SimPanel").then((m) => ({ default: m.SimPanel })));

/** Is the Graphs tool on screen? (Tools stay mounted, hidden, when another tool is shown.) */
function graphsVisible(): boolean {
  const el = document.querySelector<HTMLElement>('[role="region"][aria-label="Graphs"]');
  return !!el && !el.hidden && el.offsetParent !== null;
}

/** Mounted once at the app root (contract §5.1): starts the files controller and
 *  shows its dialogs, the preview's path picker, toasts and the simulator. */
export function FilesHost() {
  const ready = useFileSession((s) => s.ready);
  const desktop = useFileSession((s) => s.desktop);
  const dialog = useFileSession((s) => s.dialog);
  const pathPicker = useFileSession((s) => s.pathPicker);

  useEffect(() => {
    void useFileSession.getState().init().then(() => {
      // Debug builds only (dropped from production bundles): the desktop self-test, run when
      // the debug app was started with LAS_E2E_SCRIPT (see file/e2e.ts, src-tauri/src/deve2e.rs).
      if (import.meta.env.DEV) void import("../file/e2e").then((m) => m.runE2EIfAsked()).catch(() => undefined);
    });
  }, []);

  // The browser preview has no native menu: its shortcuts live here. (The desktop
  // app's File menu has the accelerators, so the page never sees these keys there.)
  useEffect(() => {
    if (desktop) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      let id: MenuId | null = null;
      if (k === "s") id = e.shiftKey ? MENU.saveAs : MENU.save;
      else if (k === "o" && !e.shiftKey) id = MENU.open;
      else if (k === "n" && !e.shiftKey) id = MENU.new;
      if (!id) return;
      // Saving from another tool would be surprising; opening brings the Graphs tool forward.
      if ((id === MENU.save || id === MENU.saveAs) && !graphsVisible()) return;
      if (useFileSession.getState().dialog || useFileSession.getState().pathPicker) return;
      e.preventDefault();
      void useFileSession.getState().menu(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [desktop]);

  let modal = null;
  if (dialog) {
    switch (dialog.kind) {
      case "conflict": modal = <ConflictSheet info={dialog.info} />; break;
      case "saveAsKind": modal = <SaveAsKindDialog key={dialog.path} d={dialog} />; break;
      case "closeDirty": modal = <CloseDirtyDialog title={dialog.title} />; break;
      case "quit": modal = <QuitDialog dirty={dialog.dirty} />; break;
      case "find": modal = <FindDialog key={`${dialog.find.tabKey}:${dialog.find.dir}`} find={dialog.find} />; break;
      case "settings": modal = <SettingsDialog />; break;
      case "export": modal = <ExportLibraryDialog state={dialog.state} />; break;
      case "recover": modal = <RecoverDialog drafts={dialog.drafts} />; break;
      case "oldLibrary": modal = <OldLibraryDialog />; break;
      case "combine": modal = <CombineDialog key={`${dialog.state.tabKey}:${dialog.state.index}:${dialog.state.theirs.head}`} s={dialog.state} />; break;
      case "bringBackDirty": modal = <BringBackDialog version={dialog.version} />; break;
      case "editAnyway": modal = <EditAnywayDialog peers={dialog.peers} />; break;
      case "resumeConfirm": modal = <ResumeDialog key={dialog.what} what={dialog.what} />; break;
      case "sharing": modal = <SharingDialog tabKey={dialog.tabKey} title={dialog.title} sharing={dialog.sharing} />; break;
    }
  }

  return (
    <>
      {modal}
      {pathPicker && !desktop && (
        <Suspense fallback={null}><PathPicker key={`${pathPicker.mode}:${pathPicker.title}:${pathPicker.startDir}`} req={pathPicker} /></Suspense>
      )}
      <Toasts />
      {ready && !desktop && import.meta.env.DEV && (
        <Suspense fallback={null}><SimPanel /></Suspense>
      )}
    </>
  );
}
