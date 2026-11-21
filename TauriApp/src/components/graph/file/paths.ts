/* Path helpers for the files UI (pure): the folder line under a tab title, the
   cloud service a path is in, temporary locations, safe file names. Paths are
   absolute with "/" separators (contract §0.5). */

import { GRAPH_EXT, fileStem, parentDir } from "./format";

/** Cloud folders under the home folder, most specific first: [prefix relative to
 *  home, service name, path segments to drop after the prefix]. */
const CLOUD_ROOTS: { re: RegExp; service: string }[] = [
  { re: /^Library\/CloudStorage\/Dropbox(?:[- ][^/]*)?(?=\/|$)/, service: "Dropbox" },
  { re: /^Library\/CloudStorage\/OneDrive(?:[- ][^/]*)?(?=\/|$)/, service: "OneDrive" },
  { re: /^Library\/CloudStorage\/GoogleDrive-[^/]*(?:\/My Drive)?(?=\/|$)/, service: "Google Drive" },
  { re: /^Library\/CloudStorage\/Box(?:[- ][^/]*)?(?=\/|$)/, service: "Box" },
  { re: /^Library\/Mobile Documents\/com~apple~CloudDocs(?=\/|$)/, service: "iCloud Drive" },
  { re: /^Dropbox(?: \([^/]*\))?(?=\/|$)/, service: "Dropbox" },
  { re: /^OneDrive(?:[- ][^/]*)?(?=\/|$)/, service: "OneDrive" },
  { re: /^Google Drive(?=\/|$)/, service: "Google Drive" },
];

const trimSlash = (p: string) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);

/** The part of `path` below `home` ("" = home itself), or null when outside. */
function underHome(path: string, home: string): string | null {
  const h = trimSlash(home);
  if (!h || h === "/") return null;
  if (path === h) return "";
  return path.startsWith(h + "/") ? path.slice(h.length + 1) : null;
}

/** "Dropbox", "OneDrive", "Google Drive", "iCloud Drive", "Box", or null. */
export function cloudServiceOf(path: string, home: string): string | null {
  const rel = underHome(path, home);
  if (rel === null) return null;
  for (const r of CLOUD_ROOTS) if (r.re.test(rel)) return r.service;
  return null;
}

/** The folder a file is in, for people: "Dropbox › Lab", "Documents", "Home",
 *  "Volumes › Data › Results". At most three parts ("… › a › b"). */
export function folderLabel(path: string, home: string): string {
  const dir = parentDir(path);
  const rel = underHome(dir, home);
  let parts: string[];
  if (rel === null) parts = dir.split("/").filter(Boolean);
  else {
    const root = CLOUD_ROOTS.find((r) => r.re.test(rel));
    if (root) {
      const rest = rel.replace(root.re, "").split("/").filter(Boolean);
      parts = [root.service, ...rest];
    } else parts = rel ? rel.split("/").filter(Boolean) : ["Home"];
  }
  if (!parts.length) return "/";
  return parts.length > 3 ? ["…", ...parts.slice(-2)].join(" › ") : parts.join(" › ");
}

/** In a folder whose files should be moved before editing (system temp, Mail downloads, Downloads)? */
export function isTempLocation(path: string, tempDirs: readonly string[]): boolean {
  return tempDirs.some((d) => {
    const t = trimSlash(d);
    return !!t && (path === t || path.startsWith(t + "/"));
  });
}

/** A file name stem that every supported file system accepts: no path separators,
 *  reserved or control characters, no leading dot / tilde, at most 120 characters. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.~]+/, "")
    .replace(/[. ]+$/, "")
    .slice(0, 120)
    .trim();
  return cleaned || "Untitled";
}

/** "<dir>/<stem>.lag". */
export const graphPath = (dir: string, stem: string) => `${trimSlash(dir)}/${stem}.${GRAPH_EXT}`;

/** Adds ".lag" when the name has no such extension. */
export function withGraphExt(path: string): string {
  return path.toLowerCase().endsWith(`.${GRAPH_EXT}`) ? path : `${path}.${GRAPH_EXT}`;
}

/** File names that sync services and this app give to extra copies of a file:
 *  Dropbox / Google Drive "conflicted copy", "(conflict …)", this app's "(unsynced from …)",
 *  "(my version from …)" and "(version from …)", OneDrive's "<stem>-<DEVICE>" (only
 *  recognised next to the original stem). */
export function isConflictCopyName(path: string, originalStem?: string): boolean {
  const stem = fileStem(path);
  if (/conflicted copy|conflict|\((?:unsynced|my version|version) from /i.test(stem)) return true;
  return !!originalStem && stem.startsWith(`${originalStem}-`) && stem.length > originalStem.length + 1
    && !/\s/.test(stem.slice(originalStem.length + 1));
}

export { fileStem, parentDir };
