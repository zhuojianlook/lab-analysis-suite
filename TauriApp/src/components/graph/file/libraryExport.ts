/* One-time export of the old in-app library to analysis files (plan §12,
   contract §8). Uses only the existing library endpoints (read-only) and the
   file backend; the SQLite library is never changed. Row and column ids, and
   the analysis id, are minted once per library row and kept in export-map.json,
   so running the export again writes nothing new for rows already exported and
   never makes look-alike duplicates. */

import type { GraphSaved, GraphSummary } from "../../../api/graph";
import { openContent, type DocContent } from "../../../store/graphStore";
import { isValidId, migrateDoc, withIds } from "../graphModel";
import type { ExportMap, ExportRow, FileErrorCode } from "./backend";
import type { ExportState, FileBackendP1 } from "./contract";
import {
  buildNewFile, buildNextFile, newAnalysisId, newDocKey, partsNotIn, partsOf, revisionOf, sectionsOf, type Author,
} from "./docCodec";
import type { GraphFileData } from "./format";
import { folderLabel, graphPath, safeFileName } from "./paths";

export interface LibraryApi {
  /** The library's rows (throws while the engine is not reachable). */
  list(): Promise<GraphSummary[]>;
  /** One analysis, or null when it can't be read. */
  get(id: number): Promise<GraphSaved | null>;
}

export interface ExportDeps {
  backend: FileBackendP1;
  library: LibraryApi;
  now(): number;
  author(): Author;
  homeDir: string;
}

/** Plain reasons for the export summary ("name — reason"). */
export function exportReason(code: FileErrorCode | "conflict" | "missing" | "unknown"): string {
  switch (code) {
    case "PermissionDenied": return "the folder can't be written to";
    case "OfflineOrTimeout": return "the folder didn't answer in time";
    case "NotFound": return "the folder doesn't exist any more";
    case "Io": return "the file couldn't be written (is the disk full?)";
    case "IdentityMismatch": case "conflict": return "a different file is in the way";
    case "TooNew": return "a file made by a newer version is in the way";
    default: return "the file couldn't be written";
  }
}

const exportedAt = (row: GraphSummary) => String(row.updated_at);

/** Is this library row exported at its current version? */
export const isExported = (map: ExportMap, row: GraphSummary) => {
  const m = map.rows[String(row.id)];
  return !!m && m.status === "done" && m.saved_at === exportedAt(row);
};

export async function libraryStatus(deps: Pick<ExportDeps, "backend" | "library">): Promise<{ rows: GraphSummary[]; map: ExportMap; total: number; unexported: number }> {
  const rows = await deps.library.list();
  const map = await deps.backend.readExportMap();
  return { rows, map, total: rows.length, unexported: rows.filter((r) => !isExported(map, r)).length };
}

/** A library row's content in the open form, with the row / column ids recorded for it (if any). */
export function rowContent(saved: GraphSaved, m: ExportRow | undefined): { content: DocContent; rowIds: string[]; colIds: string[] } | null {
  const doc0 = migrateDoc(saved.table);
  if (!doc0) return null;
  const doc = { ...doc0 };
  if (m?.row_ids && m.row_ids.length === doc.cells.length && m.row_ids.every((id) => isValidId(id, "row"))) doc.row_ids = [...m.row_ids];
  if (m?.col_ids && m.col_ids.length === doc.col_titles.length && m.col_ids.every((id) => isValidId(id, "col"))) doc.col_ids = [...m.col_ids];
  const withI = withIds(doc);
  const content = openContent({ doc: withI, analysis: saved.analysis, figure: saved.figure, scratch: saved.scratchpad ?? null });
  return { content, rowIds: content.doc.row_ids, colIds: content.doc.col_ids };
}

/** Where a row goes: the path recorded for it when it still holds this analysis; else a free
 *  name in `dir` (a file there with the same analysis is reused, another one is skipped). */
async function targetFor(deps: ExportDeps, dir: string, name: string, aid: string, m: ExportRow | undefined): Promise<{ path: string; base: GraphFileData | null }> {
  if (m?.path) {
    const r = await deps.backend.read(m.path);
    if (r.ok && r.file.manifest.analysis_id === aid) return { path: m.path, base: r.file };
  }
  const stem = safeFileName(name);
  for (let i = 1; i < 1000; i++) {
    const p = graphPath(dir, i === 1 ? stem : `${stem} ${i}`);
    const h = await deps.backend.header(p);
    if (!h.ok && h.code === "NotFound") return { path: p, base: null };
    if (h.ok && h.header.analysis_id === aid) {
      const r = await deps.backend.read(p);
      if (r.ok) return { path: p, base: r.file };
    }
  }
  return { path: graphPath(dir, `${stem} ${Date.now()}`), base: null };
}

export interface ExportRun {
  state: ExportState;
  /** Files written or confirmed in this run (for Recent). */
  exported: { path: string; analysisId: string }[];
}

/** Export every library row not yet exported at its current version into `dir`. */
export async function runExport(deps: ExportDeps, dir: string, onProgress: (s: ExportState) => void): Promise<ExportRun> {
  const rows = await deps.library.list();
  const map = await deps.backend.readExportMap();
  const state: ExportState = {
    phase: "running", total: rows.length, already: 0, done: 0, failed: [], dir, folderLabel: folderLabel(graphPath(dir, "x"), deps.homeDir),
  };
  const exported: ExportRun["exported"] = [];
  onProgress({ ...state });
  for (const row of rows) {
    const key = String(row.id);
    const m = map.rows[key];
    if (m?.status === "done" && m.saved_at === exportedAt(row) && m.path) {
      const h = await deps.backend.header(m.path);
      if (h.ok && h.header.analysis_id === m.analysis_id) {
        state.already++;
        state.done++;
        onProgress({ ...state });
        continue;
      }
    }
    const fail = async (reason: string, extra: Partial<ExportRow> = {}) => {
      map.rows[key] = { ...(map.rows[key] ?? { saved_at: exportedAt(row), analysis_id: m?.analysis_id ?? newAnalysisId(), path: null }), ...extra, status: "failed", error: reason };
      state.failed.push({ id: row.id, name: row.name, reason });
      await deps.backend.writeExportMap(map).catch(() => undefined);
      onProgress({ ...state, failed: [...state.failed] });
    };
    let saved: GraphSaved | null = null;
    try { saved = await deps.library.get(row.id); } catch { saved = null; }
    if (!saved) { await fail("it couldn't be read from the old library"); continue; }
    const rc = rowContent(saved, m);
    if (!rc) { await fail("it was made by a newer version"); continue; }
    const aid = m?.analysis_id ?? newAnalysisId();
    const { path, base } = await targetFor(deps, dir, row.name, aid, m);
    // Recorded before the file is written: a crash cannot mint other ids for this row.
    map.rows[key] = {
      saved_at: exportedAt(row), analysis_id: aid, path, status: "failed", error: "not finished", row_ids: rc.rowIds, col_ids: rc.colIds,
    };
    await deps.backend.writeExportMap(map);
    const time = deps.now();
    const author = deps.author();
    let res;
    if (base) {
      const parts = await partsOf(sectionsOf(rc.content));
      if (revisionOf(base.manifest, base.manifest.head)?.content_hash === parts.contentHash) {
        res = { ok: true as const };
      } else {
        const next = await buildNextFile(base, rc.content, { time, author, kind: "import", summary: "From the old library" });
        res = await deps.backend.save({
          path, expectedHead: base.manifest.head, analysisId: aid, docKey: newDocKey(), manifest: next.manifest, newParts: partsNotIn(next.parts, base),
        });
      }
    } else {
      const file = await buildNewFile({ content: rc.content, analysisId: aid, forkedFrom: null, time, author, kind: "import", summary: "From the old library" });
      res = await deps.backend.save({ path, expectedHead: null, analysisId: aid, docKey: newDocKey(), manifest: file.manifest, newParts: file.parts });
    }
    if (res.ok) {
      const finalPath = "path" in res && typeof res.path === "string" && res.kind !== "savedAside" ? res.path : path;
      map.rows[key] = { saved_at: exportedAt(row), analysis_id: aid, path: finalPath, status: "done", row_ids: rc.rowIds, col_ids: rc.colIds };
      await deps.backend.writeExportMap(map);
      exported.push({ path: finalPath, analysisId: aid });
      state.done++;
      onProgress({ ...state });
    } else {
      await fail(exportReason(res.kind === "error" ? res.code : res.kind), { path });
    }
  }
  state.phase = "done";
  onProgress({ ...state, failed: [...state.failed] });
  return { state, exported };
}
