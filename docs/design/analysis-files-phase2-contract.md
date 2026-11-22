# Phase 2 contract — Versions and combining

Binding for the four phase 2 implementers: **merge** (pure TS engine), **rust**, **session** (wires combining into `useFileSession`), **ui** (Versions panel, combine dialog, banners). They work in parallel and cannot talk, so everything at a boundary is decided here. Sources: the approved plan (`analysis-files-plan.md` §0–9, 13, 14, 19), the phase 1 contract (`analysis-files-phase1-contract.md`, with every "CHANGED BY" note) and the phase 1 code as released in exp-0.2.20.

- **Normative TypeScript shapes:** `TauriApp/src/components/graph/file/contract.ts`, section 6 ("Phase 2") plus the members marked "Phase 2" in the phase 1 unions. It is already in the repo and compiles (`tsc --noEmit`, vitest 13 files / 339 tests green with it). Nobody edits it. If something in it is wrong, say so in your final report and work around it.
- "Repo" = `/Users/zhuojianlook/Library/CloudStorage/Dropbox/GitHub Repos/Webtools/Analysis/TauriApp`. All paths below are relative to it unless they start with `/`.
- Phase 1 behaviour that this document does not mention stays exactly as it is.
- Words: the code says revision / head / journal / merge. **The UI never does**: it says *version*, *combine*, *saved copy*, *this computer*. The banned-word test of phase 1 (`files-ui/text.test.ts`, "never uses internal words") stays and gains `merge` and `LCA`.
- Not in phase 2: who-is-editing notes and read-only check-out (phase 3), cell-level combining (phase 4).
- Where this contract narrows the plan on purpose: §9.

---

## 1. The version model

### 1.1 What is in a file today (phase 1, unchanged)

`manifest.json` → `Manifest` (`file/format.ts`):

| field | meaning |
|---|---|
| `analysis_id` | shared by every copy of one analysis |
| `head` | id of the newest version in this file |
| `revisions[]` | **every** version this file has ever known, as `Revision`; entries are never removed |
| `forked_from` | `{analysis_id, revision_id}` when the file was made a separate analysis |
| `format_version` 1, `min_reader_version` 1, `features` 1, `app`, `created`, `template`, `x` | as phase 1 |

`Revision`: `id` (`r-<ulid>` for a save, `r-m-<26 hex>` for a two-parent version), `parents` (0 = first version, 1 = save, 2 = combine), `time` (ISO, **display only**), `user_name`, `device_id`, `device_name`, `session_id`, `app_version`, `kind` (`save | merge | restore | import`), `summary`, `sections` (`{table, analysis, figure, scratchpad}` → `PartRef {part, sha256, bytes}`; **`null` = the content of this version is no longer stored**, the entry stays), `content_hash` (SHA-256 over the four section hashes joined with `\n`).

Parts are `parts/<sha256>.json`, canonical JSON, one per section, shared between versions with the same section.

### 1.2 What phase 2 adds

Everything is optional and additive (`RevisionP2` in contract.ts):

| addition | where | meaning |
|---|---|---|
| `kind: "restore"` | revision | written by **Bring this version back**. One parent (the head at that moment). Phase 1 defined the value and never wrote it. |
| `restored_from: "<revision id>"` | revision, kind `restore` | the version whose content this one has again |
| `kind: "merge"` | revision | a combine (two parents). Phase 1 already writes it for "Keep mine". |
| `auto: true` | revision, kind `merge` | combined without anyone choosing; the revision then has **no device-specific content** (§3.4.4) |
| `sections_from: {figure: "<parent id>", …}` | revision, kind `merge` | for each section that differed between the two parents: the parent whose section the result has |
| `summary` texts | revision | the fixed phrases of `SUMMARY` / `SECTION_PHRASE` (contract.ts), §3.5 |
| first-seen record | **local**, `<state>/graph-seen.json` (`SeenMap`) | when *this computer* first saw each version id; used only by retention (§3.3). Never in the file. |

Nothing else changes in the file: no new part, no new manifest field, `features` stays `1` (2 is reserved for phase 3), `manifest.x` stays `{}`.

### 1.3 Compatibility

- **A phase 1 app opens, edits and saves a phase 2 file.** `format_version` and `min_reader_version` stay `1`. Phase 1 code never rebuilds an existing revision object (it spreads them: `withRevision`, `unionManifests`, `pruneSnapshots`, `withAbsentSnapshotsDropped`), `canonicalJson` writes every key, and Rust writes `manifestText` byte for byte, so `restored_from`, `auto` and `sections_from` survive a phase 1 save. A phase 1 app shows a `restore` version like any save and an automatic combine as saved by "someone else" (blank names). It may drop the stored content of an old version that phase 2 would have kept; the entry stays and phase 2 shows it as "Too old to open".
- **A phase 2 app opens phase 1 files** unchanged. A phase 1 "Keep mine" version (kind `merge`, two parents, no `auto`) is shown with the chip *Combined*. Phase 1 summaries ("Changed data, graph.", "Saved.") are shown as stored, without the trailing full stop.
- **Rule for the session implementer:** never rebuild a revision that is already in a manifest; always carry the parsed object along. session ships a test that a revision with an unknown field `zz: 1` is still there, unchanged, after open → edit → save → combine → bring back.
- The merge id formula is the phase 1 one, byte for byte (§3.4.3), so a phase 1 "Keep mine" and a phase 2 combine of the same two parents with the same content get the same id.

---

## 2. Sections

### 2.1 The sections

There are exactly **four**, the file's parts, in the fixed order `SECTION_NAMES`:

| key | part of the file | what it holds | in a sentence (`SECTION_PHRASE`) | as a title (UI) |
|---|---|---|---|---|
| `table` | `sections.table` | the data table (`FileTable`: cells, titles, X values, row / column ids, template) | the table | Data table |
| `analysis` | `sections.analysis` | test settings (`FileAnalysis`: control and pairs by id) | the analysis settings | Analysis settings |
| `figure` | `sections.figure` | graph settings (`FileFigure`: series colour / label by column id) | the graph | Graph |
| `scratchpad` | `sections.scratchpad` | the Scratchpad sheet, or `null` | the scratchpad | Scratchpad |

There is **no "name" section**: an analysis's name is its file name and is not in the file. `manifest.template` always follows the result's table (`content.doc.template`).

### 2.2 One pipeline for base, mine and theirs

`normaliseSections(raw)` (graphMerge.ts) is the only way a side enters a comparison:

1. `c = contentOfSections(raw)` (docCodec.ts: `idMap.fromFileSections` → `openContent` = migrate → defaults → clean-up). `null` → the side is not a Graphs document.
2. `sections = sectionsOf(c)` (back to file form through `idMap.toFileSections`).
3. `parts = await partsOf(sections)` (canonical text and SHA-256 per section).

Two sections are **the same** when their `parts.refs[key].sha256` are equal after this, never by comparing stored hashes of raw parts (a different app version may have stored a different but equivalent text). The one allowed shortcut: when the *stored* hashes of a section are equal on all sides being compared, it is the same and the pipeline result need not be compared.

> CHANGED BY fixer (merge F5): `normaliseSections` runs the pipeline twice and returns `null` when the two results differ (rows / columns without valid ids get new random ids each time — only in damaged or hand-made files). Such a mine / theirs is `unreadable` (phase 1 fallback); such a base means a two-way comparison. Files the app writes are unaffected.

### 2.3 What counts as an automatic repair

Sections depend on each other (the graph and the analysis name table columns by id). After the result's four sections are put together from the two sides (§3.4), it goes through the pipeline once more:

`re = normaliseSections(assembled)`; every section whose hash in `re` differs from the hash of the section that was picked for it is a **repair** (`CombineResult.repairs`; UI: "Adjusted automatically"). The result's content is always `re` (the repaired form).

- A side being changed by the pipeline in step 2.2 is **not** a repair (all sides get the same treatment).
- `re == null` → no result (`applyChoices` returns `null`; `combine` reports the plan without a result and with `autoApplicable: false`).
- Any repair → `autoApplicable: false`: the person sees the dialog and presses Apply.

---

## 3. Pure TypeScript modules (owner: merge)

New files in `src/components/graph/file/`, each with a `*.test.ts` beside it. No I/O, no clock, no randomness, no store access; `async` only where hashing needs it. Each module exports functions with **exactly** the names and types of its interface in contract.ts and checks it at compile time:

```ts
// at the end of revisions.ts
({ unionRevisions, isAncestor, isAncestorOrSelf, relation, lowestCommonAncestors, findBase, tips, newestFirst, snapshotPool, survivorPath }) satisfies RevisionsApi;
```

| file | interface | may import |
|---|---|---|
| `revisions.ts` | `RevisionsApi` | `format.ts` |
| `retention.ts` | `RetentionApi` | `format.ts`, `revisions.ts`, `LIMITS_P2` |
| `graphMerge.ts` | `GraphMergeApi` | `format.ts`, `docCodec.ts` (`contentOfSections`, `sectionsOf`, `partsOf`, `mergeRevisionId`, `makeRevision`, types), `SUMMARY` |
| `summaries.ts` | `SummariesApi` | `format.ts`, `docCodec.ts` types, `SUMMARY`, `SECTION_PHRASE`, `LIMITS_P2` |
| `laneGraph.ts` | `LaneGraphApi` | `revisions.ts` |

`format.ts`, `docCodec.ts`, `idMap.ts`, `paths.ts`, `libraryExport.ts` are **read-only for everyone** in phase 2 (the golden fixtures depend on them). `docCodec.pruneSnapshots` and `docCodec.summaryOf` stay where they are; session stops calling them (§5.9).

### 3.1 Ancestry (`revisions.ts`)

All functions take a plain list of revisions (usually `unionRevisions(a, b, …)`), so history that only one file has is still walked.

- `unionRevisions(...manifests)`: by id; a revision with `sections != null` replaces the same id without; order of first appearance.
- `isAncestor(revs, a, r)`: strict. `isAncestorOrSelf`: also true for `a === r` (when `r` is known). Unknown ids → `false`. Iterative (no recursion; histories can have thousands of entries); each revision visited once.
- `relation(revs, mine, other)`: `same` | `older` (`other` is a strict ancestor of `mine`) | `newer` (`mine` is a strict ancestor of `other`) | `diverged`.
- `lowestCommonAncestors(revs, a, b)`: `CA` = ancestors-or-self of `a` ∩ ancestors-or-self of `b`; result = members of `CA` that are not a strict ancestor of another member; sorted by id.
- `tips(revs)`: ids no revision names as a parent, sorted.
- `newestFirst(revs, key)`: a topological order, every revision before all of its parents. Among the revisions that may come next (all children already placed), the one with the larger `key(r)` first; equal keys → the larger id (plain string compare) first. `NaN` keys count as `-Infinity`. Same input in any array order → same output.
- `snapshotPool(files)`: revision id → parsed sections, from every revision of every file whose `sections` is set and whose four parts are in **that** file and parse as JSON. First file wins.
- `survivorPath(paths)`: compare file names (text after the last `/`): shortest (UTF-16 length) wins; ties → smallest name by plain string compare; still tied → smallest full path. (Sync-conflict copies always have longer names.)

### 3.2 The base rule — `findBase(revs, mine, theirs, stored)`

`stored(id)` = "the content of that version can be had" (the caller's `SnapshotPool.has`).

1. `mine === theirs`, or one is an ancestor of the other → `{kind: "notDiverged", relation}` (relation of `theirs` to `mine`).
2. `L = lowestCommonAncestors(revs, mine, theirs)`.
3. `L.length === 1 && stored(L[0])` → `{kind: "lca", id: L[0]}`.
4. `L.length > 1` and at least one is stored → `{kind: "ambiguous", id: <smallest stored id in L>}`.
5. Otherwise, among **all** common ancestors that are stored: those that are not a strict ancestor of another stored common ancestor; any → `{kind: "nearest", id: <smallest id among them>}`.
6. Otherwise `{kind: "none"}` (two-way).

Only `lca` allows an automatic combine. `ambiguous` and `nearest` still give a three-way comparison for the dialog's presets, but always show the dialog (with an older-than-lowest base a deliberate put-back on one side would look like "only the other side changed it").

**Where the content is looked for** (session builds the pool; plan §9.3 "both files and the local journal"): `snapshotPool([mineFile, theirsFile, …journalCopies])` where `journalCopies` = `readJournal(aid, id)` for every id in `L` that neither file stores, plus, only if step 3 fails after that, the newest `LIMITS_P2.baseScanCopies` (10) saved copies this computer has for the analysis (`journalHeads(aid)` without a path, newest `first_seen` first).

### 3.3 Retention — `keptSnapshots` / `applyRetention` (`retention.ts`, plan §7.2)

A version keeps its content when **any** of these holds (a version whose `sections` is already `null` is never in the set):

1. it is `m.head`;
2. it is among the first `LIMITS_P2.snapshotsKept` (20) of `newestFirst(m.revisions, r => ctx.firstSeen[r.id] ?? ctx.now)` — by count and by when **this computer** first saw it; `Revision.time` is never read;
3. it is a parent of a revision with two or more parents (both parents of every combine);
4. **hand-over point**: it has a child `c` with `c.device_id !== ""` and `c.device_id !== its own device_id`, and `ctx.now − (ctx.firstSeen[id] ?? ctx.now) < LIMITS_P2.handoverKeepMs` (180 days of locally observed time);
5. it is in `ctx.beaconHeads` (always `[]` in phase 2; the rule is implemented and tested now);
6. it is in `ctx.unconfirmedHeads` (heads this computer's saved copies hold that no later version on disk has confirmed);
7. it is in `ctx.pinned`.

> CHANGED BY merge: rule 2 counts only versions that still have their content: the order is `newestFirst` over all of `m.revisions`, and the first 20 of them **that have content** keep it. Counting entries without content would leave fewer than 20 versions openable (D4) and would contradict M7 "≤ 20 stored → same object".

`applyRetention(m, ctx)` returns `m` with `sections: null` on every other revision; the same object when nothing changes. It never removes an entry, never changes any other field and never touches `head`.

### 3.4 Combining (`graphMerge.ts`, plan §9.3, section level)

#### 3.4.1 `combine({base, baseKind, mine, theirs})`

1. `M = normaliseSections(mine)`, `T = normaliseSections(theirs)`. Either `null` → `{ok: false, reason: "unreadable", side}`.
2. `B = base ? normaliseSections(base) : null`. `B == null` → two-way: `baseKind` becomes `"none"`.
3. Per section `k`, with `m`, `t`, `b` the hashes:

   | condition | `status` | `pick` |
   |---|---|---|
   | `m === t` | `same` | `mine` |
   | three-way, `t === b` (and `m !== b`) | `mine` | `mine` |
   | three-way, `m === b` (and `t !== b`) | `theirs` | `theirs` |
   | otherwise (three-way: both differ from `b` and from each other; two-way: they differ) | `both` | `null` |

   `autoResolvable = status !== "both"`.
4. `needsChoice` = any `both`. When `needsChoice` is false: `result = await applyChoices(plan, {})`.
5. `autoApplicable = baseKind === "lca" && !needsChoice && result != null && result.repairs.length === 0`.

> CHANGED BY merge: `baseKind: "none"` with a `base` given → the base is ignored (two-way), so `twoWay` and `baseKind` never disagree. A repair never sets `needsChoice` (that means a `both` section); it only makes `autoApplicable` false, so the dialog is shown.

#### 3.4.2 `applyChoices(plan, choices)`

For each section the side is `choices[k] ?? plan.sections[k].pick`; a `both` section without a choice → `null`. `assembled[k]` = that side's **normalised** section object. Then §2.3: `re = normaliseSections(assembled)`; `null` → `null`. Result: `{content: re.content, sections: re.sections, parts: re.parts, from, repairs}` with `from[k]` = `"same"` when the status is `same`, else the side taken.

Properties the tests must hold (§8, M-tests): `combine(b, x, b)` → result content hash = `x`'s; `combine(b, x, x)` = `x`; conflict-free `combine(b, x, y)` and `combine(b, y, x)` give the same `parts.contentHash`; `applyChoices` with all-mine choices = mine, all-theirs = theirs (when no repair).

#### 3.4.3 The id of a combined version

Unchanged from phase 1 (`docCodec.mergeRevisionId`, used as it is):

```
id = "r-m-" + lowercaseHex(SHA-256(UTF8( sortedParents.join("\n") + "\n" + content_hash ))).slice(0, 26)
```

`sortedParents` = the two parent ids in plain string order (`[...parents].sort()`); `content_hash` = the result's `parts.contentHash` (64 lowercase hex). No other byte goes in. Every two-parent version uses it, automatic or chosen.

#### 3.4.4 `combineRevision({mine, theirs, result, auto, author?, time?})`

Common: `id` as above from `[mine.id, theirs.id]` and `result.parts.contentHash`; `parents` = the two ids **sorted**; `kind: "merge"`; `sections` = `result.parts.refs`; `content_hash`; `sections_from` = for each section whose stored hash differs between the two parents, the parent id whose hash the result has (left out when the result matches neither, i.e. it was repaired).

- `auto: true` → the **deterministic form**: `auto: true`, `user_name`, `device_id`, `device_name`, `session_id`, `app_version` all `""`, `time` = the larger of `mine.time` and `theirs.time` by plain string compare, `summary` = `SUMMARY.combinedAuto`. Two computers combining the same pair produce the same object, key for key.
- `auto: false` → `author` and `time` required; fields from them as `docCodec.makeRevision` does; `summary` = `SUMMARY.combinedChosen`; no `auto` key.

> CHANGED BY merge (detail): `sections_from` is always written (in `SECTION_NAMES` key order; `{}` when no stored section hash differs between the parents). Key order of the whole object: the `makeRevision` keys, then `auto` (automatic form only), then `sections_from`. `combineRevision` with `auto: false` and no `author` / `time` rejects.

`auto` is `true` exactly when the plan was `autoApplicable` and nobody changed a choice.

#### 3.4.5 `combineDelayMs(deviceId)`

`LIMITS_P2.combineDelayMinMs + (parseInt(sha256Hex(deviceId).slice(0, 8), 16) % (combineDelayMaxMs − combineDelayMinMs + 1))` → 2000 … 10000 ms, fixed per device.

### 3.5 Summaries and comparing (`summaries.ts`)

`summaryText({kind, root, auto, prev, next})` → the text stored in `Revision.summary`:

| case | text |
|---|---|
| `kind "import"` | `SUMMARY.imported` — "From the old library" |
| `kind "restore"` | `SUMMARY.broughtBack` — "Brought back an earlier version" |
| `kind "merge"`, `auto` | `SUMMARY.combinedAuto` — "Combined changes from two computers" |
| `kind "merge"`, not auto | `SUMMARY.combinedChosen` — "Combined two versions" |
| `root` (no parents) | `SUMMARY.first` — "First version" |
| `prev` unknown | `SUMMARY.saved` — "Saved" |
| nothing differs | `SUMMARY.noChanges` — "No changes" |
| else | `SUMMARY.changedPrefix + sectionList(changedSections(prev, next))` — "Changed the table", "Changed the table and the graph", "Changed the table, the analysis settings and the graph" |

`sectionList`: phrases from `SECTION_PHRASE` in `SECTION_NAMES` order; one → itself; two → "a and b"; more → "a, b and c".

`displaySummary(rev, firstParent)`: kinds `import` / `restore` / `merge` → as the table (merge: `auto` flag from the revision; a phase 1 merge → `SUMMARY.combinedChosen`); else when `rev.sections` and `firstParent?.sections` are both set → the "Changed …" / "No changes" text worked out from them; no parents → `SUMMARY.first`; else the stored `summary` with trailing `.` removed, or `SUMMARY.saved` when empty.

> CHANGED BY merge: one addition — a save whose content equals its first parent's and whose stored summary is `SUMMARY.separated` shows `SUMMARY.separated` ("Made a separate analysis") instead of "No changes".

`compareSections(a, b)` → `CompareResult` (contract.ts): `sections[].same` by canonical text; `table`: rows and columns matched by id (`row_ids` / `col_ids`), cells compared as text per replicate, counts plus the first `LIMITS_P2.compareCells` changed cells in `b`'s table order; `changedTitles` counts row titles, column titles and X values that differ for ids present in both; `settings`: top-level fields of the analysis and figure sections whose canonical JSON differs, `a` / `b` as short text (strings as they are, numbers / booleans via `String`, anything else canonical JSON cut to 60 characters), at most `LIMITS_P2.compareSettings`, in key order; `scratchpadCells`: number of cell addresses whose stored value differs (any stable definition over the scratchpad object; `0` iff the section is the same, at least `1` otherwise).

### 3.6 The lane graph — `layoutLanes(nodes, head)` (`laneGraph.ts`)

Pure: versions in → rows with a lane, edges, colours by device out. The UI only draws.

- **Rows:** `newestFirst(nodes, n => Date.parse(n.time))`; `row` = index (0 = top). (Parents missing from `nodes` are ignored.)
- **Lane 0** = `head` and its first-parent chain (`parents[0]` repeatedly). `head == null` or unknown → the chain of row 0.
- **Other lanes:** walking rows top to bottom, a node not yet in a lane starts a line in the lowest lane ≥ 1 that is free; its first parent continues that line unless the parent already has a lane (then the line ends there). A lane is **free** for a line when no other line or edge uses it between the rows the line will span. Guarantee the UI relies on: *for every edge, lane `max(fromLane, toLane)` holds no other row strictly between `fromRow` and `toRow`.*
- **Edges:** one per (child, parent) pair with both in `nodes`; `dashed` = the child is `foreign`; `colorIndex` = that of the end that is not in lane 0 when the lanes differ, else the child's.
- **Colours:** `devices` = device ids in order of first appearance from the **bottom** row up, `""` left out; `colorIndex` = index in it, `-1` for `""`. (The UI maps indices to a fixed palette of 8, wrapping, and `-1` to grey.)
- `laneCount` = highest lane used + 1.

> CHANGED BY merge: two more places end a line in a lane ≥ 1 (lane 0 is unchanged: the head's whole first-parent chain): **at a combine** (a version with two parents; its parents continue in lines of their own, often in the same lane), and **before a parent that has another child higher up** than the line's node. Without these the guarantee cannot hold (an edge arriving from a combine would pass the line's own versions in that lane). Lanes are given to lines in the order they were started; a line reserves its rows plus every edge it may carry (edges to lines in lower lanes and to lines not placed yet), with half-open edge ends so the next line can continue in the same lane where one ends. Edge colour when neither end is in lane 0: the end in the higher lane. The guarantee holds for every history where no combine has one parent that is an ancestor of its other parent (never so for a real combine, which only joins diverged versions).

Test invariants: one row per node, children above parents; linear history → `laneCount 1`; one divergence and its combine → `laneCount 2`, the combine row has two edges, the lanes join there; `k` branches alive at once → `laneCount ≤ k`; lane 0 is the head's first-parent chain even when a copy has newer versions; deterministic under shuffling the input; the edge guarantee above; 2,000 nodes lay out in under 200 ms.

---

## 4. Rust (owner: rust)

Four commands, one menu item. No new crate; `Cargo.lock` unchanged; `cargo build --locked` keeps working. All commands follow phase 1 §1.2 (async, `spawn_blocking`, 15 s timeout, typed `FileErr`). Names and shapes: `CMD`, `Commands`, `PeekReply`, `RemoveCopyArgs`, `RemoveCopyReply`, `RemoveRefusal`, `SeenMap` in contract.ts (camelCase envelopes; `SeenMap` passes through as it is).

### 4.1 `graphfile_peek { path } → PeekReply`

The full validation of a read (phase 1 §1.3 steps 1–10, same errors, `Dataless` without a download request), returning `{manifestText, stat, readOnly}` and **no parts**. It does not journal, does not set the validation record and does not touch any track. Used for files that are not open: separated analyses in the folder (Versions panel) and re-checks.

### 4.2 `graphfile_remove_copy { req: RemoveCopyArgs } → RemoveCopyReply` (plan §9.4)

Moves an extra copy into `<state>/displaced/`, never deletes. In this order, under the path mutexes of **both** files (taken in sorted path order):

1. `Invalid` unless both paths end in `.lag`. No state folder → `NoStateDir`, nothing touched.
2. `req.path` is a tracked path (`graphfile_track`) → `{kind:"refused", reason:"open"}`.
3. **Re-read both files now** (full validation; missing → `NotFound`, online-only → `Dataless`, not valid yet → `Incomplete`; nothing moved on any error).
4. Same file (device + inode on unix, case-insensitive path compare elsewhere; phase 1 `is_same_file`) → refused `sameFile`.
5. Either `analysis_id` ≠ `req.analysisId` → refused `otherAnalysis`.
6. The copy's head must be the keeper's head or one of its ancestors **in the keeper's manifest** (`is_ancestor_or_self(keeper, copy_head, keeper_head)`), else refused `notOlder`. Refusals carry both heads.
7. `stat` the copy again; size or mtime differ from step 3 → start again at step 3 once; still different → `Incomplete`.
8. Move to `displaced/<x-uuid>.lag`: `rename`; when that fails across volumes (`EXDEV` / "not same device"), write the bytes read in step 3 with the atomic writer, verify their SHA-256, then remove the original. Add `DisplacedEntry {id, original: req.path, analysis_id, head, reason: "removedCopy", at: now}` to `displaced/index.json`.
9. Drop the path from every track's copy table and sibling memory (so nothing is reported about it).
10. Reply `{kind:"removed", displacedId, head}`.

The phase 1 startup pruning deletes displaced entries older than 30 days (`LIMITS_P2.removedKeepMs`); it applies to `removedCopy` entries as it is. `graphfile_list_displaced` / `graphfile_read_displaced` already serve them. Nothing else in the app ever removes a user's file.

### 4.3 `appstate_read_seen → SeenMap`, `appstate_write_seen { seen } → null`

File `<state>/graph-seen.json`, stored as `serde_json::Value` like the session. Read: missing → `{"v":1,"analyses":{}}`; unparsable or `analyses` not an object → rename to `graph-seen.json.bad-<ms>` and return the default. Write: `Invalid` unless `seen.analyses` is an object; atomic.

### 4.4 Menu

One new item in the File menu, id `file.versions` (`MENU.versions`), label **Versions**, no shortcut, placed after "Close Tab" and before "Recover Unsaved Work…", enabled when `MenuState.hasDoc`. It emits `app://menu {id:"file.versions", path:null}` like the others.

### 4.5 What does not change

`graphfile_save`, the poll thread, the events, the journal (combine bases are read with the existing `graphfile_journal_heads {analysisId, path: null}` and `graphfile_read_journal`), journal pruning (unconfirmed heads and the newest 10 per analysis are kept, which is what combine bases need). `dev_e2e_fs`: check that `copyOver` also creates a target that does not exist and that `dev_e2e_script` passes an unknown `phase` through untouched (the session implementer adds phase `"combine"`, §8 E-tests); fix either if not.

> CHANGED BY rust: both checks hold as phase 1 wrote them (no change). E4 names a `dev_e2e_fs` op `menu` that phase 1 did not have; it now exists: `dev_e2e_fs({op: "menu", path: "file.versions", to: null})` emits `app://menu {id: "file.versions", path: null}` exactly as a click on that item does (any id `resolve_click` knows; `app.quit` is refused — use `dev_e2e_quit`; `path` is the menu id, not checked against `roots`). Debug builds only, like the rest of `deve2e.rs`.
>
> CHANGED BY rust (detail, no shape change): `graphfile_remove_copy` also rejects with `Invalid` when either path is not absolute or the copy is a symbolic link; "still different" in step 7 (and a copy that changes in the instant of the move) rejects with `Incomplete` and `data.reason: "changing"`; the displaced record is written just before the move and dropped again if the move fails; the second path lock is only tried (both released and retried, up to 10 s, then `Io`), so it cannot deadlock with a save holding the other path. A command timeout cancels the move like a save's.

### 4.6 Tests rust must ship (`cargo test --locked`; today 77 passed / 1 ignored)

Remove copy: older copy removed (bytes in `displaced/` identical by SHA-256, index entry with reason `removedCopy`, keeper untouched, original gone); equal heads removed; **refused** and nothing moved for: diverged copy, newer copy, other analysis (either side), same file through a hard link, tracked path; copy changed between the read and the move (test hook) is re-read and then judged again; truncated copy → `Incomplete`, nothing moved; no state folder → `NoStateDir`. Pruning: a `removedCopy` entry 29 days old stays, 31 days old goes. Peek: returns the stored manifest text byte for byte, no journal entry appears, a truncated file → `Incomplete`. Seen map: default, round trip, bad file moved aside. Menu: `resolve_click("file.versions", …)` → `{id:"file.versions", path:null}`.

---

## 5. The session controller (owner: session)

`useFileSession` becomes `create<FileSessionStateP2>` (`FileSessionStateP2 extends FileSessionState`; phase 1 UI code keeps compiling). The backend type becomes `FileBackendP2`.

### 5.1 Other files session changes

- `backend.ts`: re-export `FileBackendP2`; `SessionTab` gains optional `asides?: string[]` (files this computer saved beside the file because it could not be checked), `carry_heads?: string[]` (§5.5 B), `combine_pending?: {theirs: string; source: "disk" | "journal"}` (an automatic combine that was waiting when the app closed; re-evaluated on restore).
- `memoryBackend.ts`: `MemoryDevice implements FileBackendP2` — `peek` (as `read` without parts and without journaling), `removeCopy` (the rules of §4.2 steps 2–8 on the simulated disk, entries expire after 30 simulated days), `readSeen` / `writeSeen`; all in `exportState` / `importState`. Helper `removedCopies()` for the simulator.
- `tauriBackend.ts`: thin mappings — `peek` → `graphfile_peek` (parse `manifestText`; reject → `FileError`); `removeCopy` → `graphfile_remove_copy` (`removed` → `ok:true`, `refused` → `ok:false, kind:"refused"`, reject → `kind:"error"`); `readSeen` / `writeSeen` (chained like `writeSession`). Tested with the fake `invoke` like phase 1.
- `graphStore.ts` (additive): `replaceContent` and the labelled undo step (§5.7).
- `devSim.ts`: `DevSimApiP2` (§6.6). `previewBackend.ts`: nothing but what the above needs.
- `e2e.ts`: phase `"combine"` (§8 E-tests).

**While the merge modules do not exist**, session builds against scratch-only stand-ins `revisions.ts`, `retention.ts`, `graphMerge.ts`, `summaries.ts`, `laneGraph.ts` that satisfy the contract.ts interfaces and follow §3 (the section-level rules are short), and does **not** copy them to the repo. session's tests assert only behaviour this document defines, so they pass with the real modules. Likewise **ui** builds against a scratch-only stub of `session.ts` typed `FileSessionStateP2`.

### 5.2 State

Public: `versions: VersionsState | null`; dialog kinds `combine` and `bringBackDirty`; `FileTab.combining`, `FileTab.updating`; banner kind `combined`; banner field `state` on `savedOver`; banner actions `combine`, `remove`, `keep`, `whatChanged`, `undo`; toasts `combined`, `broughtBack`, `copyRemoved`, `savedAsNew`.

Internal per tab: the combine context (plan, both files, my working revision, base choice, choices, queue of copies), the automatic-combine timer, the held-back replace, the pre-combine head for Undo, `asides`, `carry_heads`. Global: the `SeenMap` (read at init; every manifest the controller reads or writes adds ids it does not have yet with `deps.now()`; written `LIMITS_P2.seenDebounceMs` after the last change and in the quit flush; per analysis at most `LIMITS_P2.seenPerAnalysis` ids, smallest times dropped).

### 5.3 Actions

| action | does |
|---|---|
| `openVersions(key?)` | untitled → nothing. Switches to the tab if needed, builds the list (§5.8), sets `versions`. `menu(MENU.versions)` toggles it for the active tab. |
| `closeVersions()` | `versions = null`. Also on tab switch, close tab, start screen. |
| `selectVersion(id \| null)` | sets `selectedId`; `preview = {id, loading: true, …}` then the version's content through the load pipeline (`openFile(file, id)`; source order: this file, an extra copy that has it, this computer's saved copy with that head). `WORKING_ROW` → the tab's content. Not openable → `content: null`. Turning to another row keeps `comparing`. |
| `compareWithCurrent(on?)` | toggles `comparing`; when on: `preview.compare = compareSections(sectionsOf(preview.content), sectionsOf(current))`, `preview.current` = the tab's content now (unsaved changes included; scratchpad flushed first). |
| `bringBack(id)` | §5.10 |
| `saveVersionAsNew(id)` | pick a place (suggested `<title> (earlier version).lag`, start folder = the file's); `buildNewFile({content, analysisId: new, forkedFrom: {analysis_id, revision_id: id}})`; `save({expectedHead: null, replaceExisting: true})`; open it in a new tab (as `duplicate()` does); add the path to `known_copies`; toast `savedAsNew {name}`. The current tab is untouched. |
| `startCombine(key, source)` | §5.4 |
| `setSectionChoice(section, choice)` | in the dialog: store the choice, `applyChoices` → `adjusted` = its repairs, `canApply`. Nothing is written. |
| `applyCombine()` | §5.4 step 7. |
| `cancelCombine()` | closes the dialog, clears the queue. Origin `save` → tab stays `notSaved` with banner `notSaved` (action `choose` reopens the same combine). Other origins → the banner that led here comes back. |
| `keepBothAsSeparate()` | closes the dialog. Source `disk` → phase 1 `separateCopy` (pick a place, mine becomes a new analysis there, the tab moves to it, this file is left as it is). Source `copy` → `markDifferentAnalysis(key, path)`. Source `journal` → that version is written beside the file as a new analysis `<stem> (version from <its computer>).lag` (`forked_from` = this analysis and that version), added to `known_copies`, the head marked settled. |
| `undoCombine(key)` | `bringBack(<my head from before the combine>)` (asks first when the tab has unsaved changes). Removes the `combined` banner on success. |
| `showWhatChanged(key)` | `openVersions(key)`, select the combined version, `compareWithCurrent(true)`. |
| `removeExtraCopy(key, path)` | §5.6 |
| `markDifferentAnalysis(key, path)` | phase 1 `makeSeparate` (what `separate` / `notSame` do), with summary `SUMMARY.separated`. |
| `useEarlierVersion(key)`, `goBackToMyLatest(key)` | what the phase 1 banner actions `useEarlier` / `backToLatest` do (the banner actions call these). `useEarlierVersion` additionally records the dropped heads in `carry_heads`. |
| `holdReplace(reason)` | counts holds; returns the release function. While the count is above zero no content is replaced in the active tab (§5.7). |

> CHANGED BY session: `showWhatChanged` selects **my version from before the combine** (the one `undoCombine` brings back) when it is a row, else the combined version. Right after a combine the combined version *is* the current content, so comparing it with current would show "Same" everywhere; my earlier version against current shows exactly what came in. `startCombine` resolves after the dialog opened or the combine was written (its `SaveOutcome` is internal; `applyCombine` and `save` return theirs).

`bannerAction` routes the new actions: `combine` → `startCombine(key, <the source the banner stands for>)` (`newerOnDisk` and `savedOver` → `{kind:"disk"}` or the stored journal source; `extraCopy` → `{kind:"copy", path}`); `remove` → `removeExtraCopy`; `keep` → add the path to `known_copies`, drop the banner; `whatChanged` → `showWhatChanged`; `undo` → `undoCombine`; `notSame` → `markDifferentAnalysis`.

### 5.4 Combining

**Sides.** *Mine* is always the tab: its base version `R` when the tab is clean, or my working copy `W` when it has unsaved changes (`W` = a real revision, `parents: [R]`, built by `workingOf`, **written to the journal first**, exactly as phase 1 does before the conflict sheet). *Theirs* is one version: the head of the file on disk (`disk`), the head of an extra copy (`copy`), or a version this computer has a saved copy of (`journal`).

**Procedure** (`startCombine`, and every automatic entry):

1. Skip while the tab is `saving` or shows a card. A combine occupies the tab's save slot (`savesInFlight`): a Save pressed meanwhile gets the combine's outcome.
2. Flush the scratchpad (`commitEdit: true`). Read theirs fresh (`read` for `disk` / `copy`, `readJournal` for `journal`). Not readable → banner `saveFailed` "The other version can't be read yet. Try again in a moment."; too new (`readOnly`) → banner `tooNew`; stop.
3. `revs = unionRevisions(mine manifest (+W), theirs manifest)`; `findBase(...)` with the pool of §3.2. `notDiverged` → not a combine: `newer` → treat as a newer version (§5.5 table A), `older` / `same` → nothing to do (drop the banner).
4. `plan = combine({base, baseKind, mine, theirs})`. `ok: false` → **phase 1 fallback**: the conflict sheet (`disk`), or the phase 1 copy behaviour (`journal`: my version written beside the file; `copy`: banner stays with `notSame` / `later` only).
5. `plan.autoApplicable` → write at once (step 7) with `auto: true`. For an entry nobody asked for (§5.5: "automatic"), first wait the device-ordered delay (§5.4.1).
6. Otherwise open the dialog: `dialog = {kind: "combine", state}` with the presets of the plan; tab `notSaved: true` when the origin is `save`. Automatic entries never open a dialog by themselves: they set banner `savedOver {state: "choose"}` with action `combine`.
7. **Write** (`applyCombine`, or directly):
   1. If the tab's `editSerial` (or kept-changes sequence) changed since `W` was built: rebuild `W`, journal it, redo steps 3–4. If any section's status changed, the dialog stays open with the new state and nothing is written.

> CHANGED BY fixer (merge F1, F3, safety F8): (a) when Save hands its `W` to the combine, the context's markers (`serial`, kept-changes sequence) are `W`'s, so an edit typed during the failed save or the re-read makes the context stale (it was silently dropped before). (b) After a rebuild the person looks again (dialog, nothing written) when a status changed, **or** when the write was going to be automatic and the new plan is no longer `autoApplicable`, **or** when a section with an explicit choice changed on either side since the choice; an automatic write stays automatic only while the new plan allows it. (c) `W` is reused (same id) while its content hash and base are unchanged, so retries and Cancel → Save don't fill this computer's saved copies with copies of the same work.
   2. `result` = the plan's, or `applyChoices(plan, choices)`.
   3. **Target file** = `survivorPath([tab path, copy path])` for source `copy`, else the tab's path. `target` = the file now at the target (its manifest and parts), `expected` = its head.
   4. `M = combineRevision({mine: R or W, theirs, result, auto, author, time})`.
   5. `manifest = applyRetention(withRevision(unionManifests(target.manifest, <the other side's manifest>, + W), M, author, result.content.doc.template), ctx)` with `ctx.pinned = [mine id, theirs id, base id]`; parts completed with `completeParts` from both files, `W`'s parts, the result's parts and the journal.
   6. `save({path: target, expectedHead: expected, analysisId, docKey, manifest, newParts: partsNotIn(parts, target)})`.
   7. `saved` → §5.4.2. `conflict` → start again at step 2 with the new head (at most 3 rounds, then banner `savedOver {state: "choose"}`). `savedButDisplaced`, `savedAside`, `missing`, errors → as a normal save (§5.5 C).

Nothing is written before step 7.6, except `W` into this computer's own journal.

> CHANGED BY fixer (merge F2, safety F3, safety F5): before combining with an **extra copy**, the tab first takes in its own file when the file has a version the tab doesn't (clean tab + newer → shown at once; unsaved changes or diverged → the disk combine of table A, which may ask). Only then the copy is combined; when the disk step needs the person, the copy's banner stays for later. A write into the tab's own path that finds the file ahead returns to this step (bounded) instead of retrying into "The file keeps changing…"; a copy that still can't be combined after 3 rounds gets its own banner back (never `savedOver`). A copy that is gone (`NotFound`) when its banner is pressed, when the combine reads it, on Remove it, or when an event of the tab's file arrives, loses its banner quietly.

#### 5.4.1 Automatic combines and the device-ordered delay

Only for a **clean** tab, only for sources `disk` and `journal`, only when `plan.autoApplicable`. Never for an extra copy (the person presses Combine…), never while the tab has unsaved changes (then a banner offers it and Save does it — at once, without delay, because `W` exists only on this computer).

1. Banner `savedOver {state: "combining"}` (no buttons), `tab.combining = true`, `combine_pending` in the session.
2. Wait `combineDelayMs(device_id)` on `deps.timers`.
3. **Re-check:** read the target again.
   - Its head descends from both parents (the result, or more, already arrived from the other computer) → no write; treat as a newer version (reload in place).
   - Its head is still what it was → write (step 7).
   - Anything else → run the routing of §5.5 again from the top.
   - The tab got unsaved changes meanwhile → cancel; banner `savedOver {state: "choose"}` with action `combine`.
4. Clear `combining` / `combine_pending`; remove the `combining` banner.

The timer is cancelled by: closing the tab, Save, a manual `startCombine`, the app quitting (it is re-evaluated at the next start from `combine_pending`). Two computers that both write produce the same version id (§3.4.3–3.4.4), so the second write is seen as "same version" by the first.

#### 5.4.2 After a combine is saved

- Tab base = `M`; kept changes deleted; `tab.notSaved = false`; the manifest kept for the tab = the one written.
- Loaded tab: `replaceContent` with the result's content and **one labelled undo step** `Undo: combine with {who}'s changes` (§5.7). Because the person's own action led here (Apply, Save, a banner button) it is applied at once; after an automatic combine it obeys the hold rules of §5.7.
- Source `journal`: that head goes into `settled_heads`. Source `copy` with a target other than the tab's path: the tab re-points to the target (`repoint`, Recent replaced, track / untrack, toast `renamed`), the old file is now an older copy → banner `extraCopy` (older) for it.
- Banner `combined {version: theirs, sections: <sections with from === "theirs">}`, actions `whatChanged`, `undo`, dismissible; it stays until dismissed. Remove banners `newerOnDisk`, `notSaved`, `savedOver`, `saveFailed`.
- When more diverged copies wait (the queue), the next one starts (`index + 1` of `total`), with mine = the version just saved.
- Remember "my head before the combine" (`R`, or `W`) for `undoCombine`.

> CHANGED BY session: when `replaceContent` refuses after the combine was written because something was typed during the write (S18), the typing is not dropped and their changes are not lost from the tab: the current content is combined three-way onto the result (base = the side the combine used as mine, the same pipeline) and shown as unsaved changes on top of the combined version — `graphStore.replaceContent` takes an optional `working` (content shown on top of the new baseline) for this. If that typing touched a section the result took from the other side, the tab keeps its content on its old base and gets `newerOnDisk` (with `combine`) for the combined version. The same for a background tab's kept changes.

> CHANGED BY fixer (merge F4, ux F6a): typing that only fits on top of the result **with an automatic repair** is not rebased silently (the tab keeps its content, the combined version is offered as newer). The `combined` banner is removed by the tab's next save or in-place reload (its Undo would no longer mean that combine). When the other side is this computer's own replaced save (journal source, `theirs.mine`), the undo label is "Undo: combine with your earlier save", the banner "Combined with your earlier save.", the toast "Combined with your earlier save".

**Several copies ("Copy 2 of 3").** Pressing Combine… on any extra-copy banner queues *every* diverged extra copy of that tab (answered "same" or with a sync-conflict name), sorted by file name; `CombineState.index` / `total` say where it is. Copies that combine without a choice are applied without a dialog and still count. Cancel ends the queue.

### 5.5 Routing — replaces the tables of phase 1 §4.7 and §4.9

`R` = the tab's base, `H` = the head read from disk, *clean* / *unsaved* = the tab's state. All checks are skipped while the tab is `saving`.

**A. The file changed (`changed` / `back` / `moved` with another head, and on open)**

| relation of `H` to `R` | clean tab | tab with unsaved changes |
|---|---|---|
| `H = R` | nothing | nothing |
| `H` **newer** (descends from `R`) | reload in place with `replaceContent` (§5.7), toast `reloaded`; background tab: base updated | banner `newerOnDisk {version}` — actions **`combine`**, `later`. `combine` → `startCombine(key, {kind:"disk"})`. **Save does the same** (table C). |
| `H` **older** than a head this computer saved for the path, and `H ≠ accepted_head` | banner `rolledBack` — `useEarlier`, `backToLatest`; no automatic action (unchanged) | same |
| **diverged** (another computer's save replaced mine) | **automatic** combine of `R` with `H` (§5.4.1). Needs a choice → banner `savedOver {state:"choose", version}` — action `combine`. The tab keeps showing my version until it is combined. | banner `savedOver {state:"choose", version}` — action `combine` (mine = my working copy). Save does the same. Never automatic. |

The phase 1 behaviour for the diverged case (my version written beside the file as a copy, banner `savedOver` with `openCopy`) happens only through the fallback of §5.4 step 4.

**B. The journal check (plan §8; `invariantCheck`, on open and on every table-A event)** — for the newest head `J` this computer saved for the path that is unconfirmed, not settled and not an ancestor-or-self of `H`:

| `H` vs `J` | action |
|---|---|
| `H` descends from `J` | nothing (Rust marks `J` confirmed) |
| `H` is a strict ancestor of `J` | table A "older": banner `rolledBack`. `useEarlier` stores `accepted_head = H` and puts `J` (and other dropped heads) into `carry_heads`; **the next save unions their history into the file** (`unionManifests` with the journal copy's manifest, parts through `completeParts`), then clears `carry_heads`. `backToLatest` as phase 1. |
| diverged, and `J = R` | table A "diverged" |
| diverged, and `J ≠ R` (the tab already shows `H` or something newer) | combine with source `{kind:"journal", revisionId: J}`: clean tab → automatic (§5.4.1); needs a choice or unsaved changes → banner `savedOver {state:"choose"}` — action `combine`. After a combine or "Keep both as separate files" `J` is settled. |

> CHANGED BY session: the parenthesis of the last row is the condition: the journal combine runs only when `H` is `R` or an ancestor of it. When the tab is on another version that `H` replaced (three computers with last-writer-wins: my save `R` replaced by B's, then by C's; `J` = B's, which this computer read), table A combines `R` with `H` first and `J` is looked at again afterwards. Without this, a combine with `J` would be written against a file whose head is neither side.

> CHANGED BY fixer (safety F1, F4, ux F3): what this computer decided about a file is kept **per file**, not only per tab: `GraphSession.files[path] = {analysis_id, settled_heads, accepted_head, carry_heads}` (backend.ts `FileMemo`, at most 100 files × 200 heads), written with the session, updated when a tab closes and read when a tab opens that file. So a choice made (combined, Keep both, Use the earlier version, a working copy built for a dialog that was cancelled or discarded) is not offered again — and never written in automatically — after the tab is closed and reopened. A saved-copy head that is already in the file's revision list (taken in by Use the earlier version + Save, or a side branch) counts as settled. "Keep both as separate files" (disk source) settles the base it was made on for the old path.

> CHANGED BY fixer (safety F2, F6): `useEarlier` on a tab **with unsaved changes** moves the tab's base to `H` (the old base goes into `carry_heads`; draft rewritten) instead of a `newerOnDisk` banner, so the next Save is ordinary; a Save whose conflict head equals `accepted_head` does the same and saves again once. `backToLatest` re-reads the file: when its head is not an ancestor-or-self of the journal head (another computer saved on top of the earlier version), nothing is overwritten — the banner goes and my latest version is combined with the file (`startCombine` disk when the tab is on it, else journal); otherwise it writes `unionManifests(journal copy, file)` through retention. `onHead` drops a `rolledBack` banner once the file's head is no longer an ancestor-or-self of the journal head it stands for.

**C. Save**

| `backend.save` result | action |
|---|---|
| `saved` | as phase 1 (summary text from `summaryText`, manifest through `applyRetention`) |
| `conflict {head T}` | read theirs; `T` is a strict ancestor of `R` → banner `rolledBack` (table A), tab `notSaved`. Otherwise combine, mine = `W`, source `disk`, origin `save`: applicable without a choice → written at once (no delay) → banner `combined` and outcome `{ok: true}`. Else the combine dialog; outcome `{ok:false, reason:"conflict"}`; tab `notSaved`. |
| `savedButDisplaced {displacedHead D}` | as `saved`, then combine with source `{kind:"journal", revisionId: D}`: automatic (§5.4.1) when no choice is needed, else banner `savedOver {state:"choose", version: D}`. (Phase 1 wrote `D` beside the file as a copy; that is now only the fallback.) |
| `savedAside` | as phase 1, but the aside path goes into `asides` (not `known_copies`): once the file can be read again it is handled as an extra copy with a sync-conflict name (table D) |
| `missing`, errors | as phase 1 |

The phase 1 conflict sheet (`ConflictSheet`, `resolveConflict`, `ConflictChoice`) stays in the code and is reached only through the fallback of §5.4 step 4.

**D. Extra copies (plan §9.4; on `sibling`, on open, after every save)** — first the phase 1 copy question (`copyQuestion`: `separate` / `same`) where it applies (unchanged). Then, by the relation of the copy's head to the tab's base:

| copy is | banner `extraCopy` | actions |
|---|---|---|
| older or same | "'{name}' is an older copy of this analysis." | **`remove`**, **`keep`** |
| newer (strictly ahead of mine) | "A second copy of this analysis, '{name}', has changes by {who}." | `updateMine` (phase 1: take its versions into my file), `notSame`, `later` — unchanged |
| diverged | same text | **`combine`**, `notSame`, `later` |

`keep` and `notSame` are remembered (`known_copies`), `later` comes back at the next event. Nothing is ever removed or combined without a click.

> CHANGED BY session: (1) the copy question is not asked for an **older** copy (its newest version is a strict ancestor of the tab's base): everything in it is in this file, so it gets `remove` / `keep` at once — plan §9.4 "older copy → [Remove it] [Keep]", and what the simulator's "Add an older copy" (`<name> (old copy).lag`, not a sync-conflict name) needs for U9. A copy with the same head (a Finder duplicate made now) is still asked about, as in phase 1. (2) When "Remove it" is refused with `notOlder`, the copy is recorded as "the same analysis" (`copy_answer`), so the diverged / newer banner of §5.6 step 4 follows without a question. (3) Save on a clean tab while an automatic combine is waiting does that combine now (no delay) instead of only cancelling it.

> CHANGED BY fixer (safety F9, ux F5): `keep` also records the copy's head (`SessionTab.kept_heads`); the copy is quiet only while its head is that head or an ancestor-or-self of the tab's base, otherwise it is reported again. After every successful save, the copies seen beside the file (`seen_copies`, `asides`) are looked at again, so a copy answered **Later** comes back then.

**E. Same analysis at another path, drafts on open, rename follow, cards, Find it…** — unchanged from phase 1. One addition: a draft whose base is an ancestor of the file's head (phase 1 §4.6 second bullet) now leads to the table-A `newerOnDisk` banner with `combine`.

### 5.6 Remove an extra copy — `removeExtraCopy(key, path)`

1. Refuse (toast `error`: "'{name}' is open in a tab. Close it first.") when the path is open in a tab.
2. `backend.removeCopy({path, keeper: <the tab's path>, analysisId})`. The backend re-reads both immediately before and enforces the ancestor rule (§4.2); the controller does not decide it.
3. `removed` → drop the banner, forget the path in `known_copies` / `seen_copies` / `asides` / Recent, toast `copyRemoved {name}`.
4. `refused` → toast `error`: `notOlder` "'{name}' has changes that aren't in this file, so it wasn't removed." (and the banner is replaced by the diverged / newer one); `open` as step 1; others "'{name}' couldn't be removed."
5. Error → toast `error` "'{name}' couldn't be removed."

### 5.7 Reload in place — `replaceContent` (plan §9.2)

`graphStore.replaceContent(p) → boolean`:

```ts
replaceContent(p: {
  docKey: string; expectedBase: string | null; expectedEditSerial: number;
  file: FileRef; name: string;
  doc: GraphDoc; analysis?: Partial<GraphAnalysis>; figure?: Partial<GraphFigure>; scratch?: unknown;
  /** After a combine: one undo step that puts back what was there, with this label. */
  undo?: { label: string };
}): boolean
```

- Applies only if `state.file?.docKey === docKey && state.file.baseRevision === expectedBase && state.editSerial === expectedEditSerial` **at commit**; otherwise returns `false` and changes nothing (the controller then takes the unsaved-changes path: banner `newerOnDisk`).
- One store update sets: the content through the load pipeline (`openContent`) and the baseline taken **after** it (`savedSnapshot`, `savedScratch`), `file`, `name` / `savedName`, `lastEditKey: null`, and the undo stack: empty, or — with `undo` — exactly one step holding the whole previous content (table, analysis, figure, scratchpad) and the label.
- `docSerial` is **not** bumped. `scratch` keeps its identical string when the new text equals the old one, so the Scratchpad's sheet session survives; when it differs the Scratchpad rebuilds from the new text as it does for any outside change.
- New store members: `undoLabel(): string | null` (label of the top undo step, `null` for ordinary steps) and the "whole content" kind of undo step. Undoing it restores all four parts; the tab is then "unsaved" on top of the combined version, and saving it makes a new version (history is never rewritten).

The controller uses `replaceContent` (never `loadFile({inPlace})`) for: a newer version on a clean tab, the result of a combine, Bring back, "Use the earlier version", "Go back to my latest", "Update my file with it".

**Held back.** Content arriving on its own (table A "newer", an automatic combine) is not applied while any of these holds; the controller sets `tab.updating = true` and retries every `LIMITS_P2.replaceRetryMs`:
- `holdReplace` count > 0 (the UI wraps exports);
- `deps.interactionBusy()` — new dependency, default (DOM): the focused element is an `input`, `textarea` or `contenteditable` inside the Graphs region; or a primary mouse button is down (tracked with `pointerdown` / `pointerup` on `window`); or a menu, list box, popover or dialog is open (`[role="menu"], [role="listbox"], [role="dialog"], .MuiPopover-root`).

> CHANGED BY fixer (ux F1): a focused field counts as busy only while it is being typed in: the window has the keyboard (`document.hasFocus()`) and a `keydown` / `input` / `paste` / `cut` came within `TYPING_QUIET_MS` (2 s), or an input method is composing. A caret merely resting in a grid cell (the grid keeps a cell focused after every committed value) no longer holds newer versions back indefinitely. Mouse button down, open menu / list box / popover / dialog and the export hold are unchanged. On window `focus` and `visibilitychange` → visible, held content is tried at once. A held reload whose tab was left meanwhile takes the background path (base moves, no banner) when the tab has no kept changes.

When it is finally applied the three expectations are checked again. Content the person asked for by a click is applied at once.

### 5.8 Building the Versions list (`openVersions`, and again after every save, reload, combine or copy event of that tab while the panel is open)

1. `file = read(tab.path)`; `revs` = its revisions.
2. Extra copies: files of the folder with the same analysis id (`scanDir` + header), `read` each; `revs = unionRevisions(file, …copies)`. A revision that is not in `file`'s list → `foreign: true`. The row of each copy's head gets `copyName` / `copyPath`.
3. Separated analyses: paths in `known_copies` plus up to `LIMITS_P2.branchScanFiles` other `.lag` files of the folder with another analysis id → `peek`; `forked_from.analysis_id` = this analysis and `forked_from.revision_id` is a row → `VersionStub {from, name, path}`.
4. Unsaved changes → a first node `{id: WORKING_ROW, parents: [base], time: now, deviceId: mine}`.
5. `layout = layoutLanes(nodes, tab.baseRevision)`; `rows[i]` for `layout.rows[i]`:
   - `summary = displaySummary(rev, first parent)`; working row: "Unsaved changes".
   - `who = versionInfo(...)`; `null` for the working row and for `auto` combines.
   - `openable`: its content is in the file, in a read copy, or this computer has a saved copy with that head (`journalHeads(aid)`).
   - `chips`, in this order: `unsaved` (working row); `current` (id = the tab's base); `combined` (two or more parents); `broughtBack` (kind `restore`); `fromOldLibrary` (kind `import`); `tooOld` (not openable).
6. `devices` from `layout.devices` with the newest name seen for each id; `tooOld` = number of rows with that chip.
7. Keep `selectedId` when that row still exists, else clear it and the preview.

> CHANGED BY fixer (ux F6b, merge F7; narrows §9.10): while my last save is replaced and not combined yet (the tab's base is not in the file, or a `savedOver` banner stands for a saved copy of mine), that version is listed from the tab's history / this computer's saved copy as a foreign row with the summary "Your last save — not in the file yet" (the tab's base keeps the *Current* chip). When that version was saved by another computer the summary is "Shown in this tab — not in the file now" instead (release fix N2). For the layout only, at a combine the parent saved by this computer is put first, so lane 0 follows this computer's line.

### 5.9 Phase 1 behaviours that change, and those that stay

Change: `newerOnDisk` gets `combine` instead of `choose`; a save conflict combines instead of opening the conflict sheet; `savedOver` and `savedButDisplaced` combine instead of writing a copy; older extra copies get `remove` / `keep`; diverged ones get `combine`; every manifest the controller writes goes through `applyRetention` (with `SeenMap`, the unconfirmed journal heads of the analysis and `beaconHeads: []`) instead of `pruneSnapshots`; summaries come from `summaryText`; in-place reloads go through `replaceContent`; `makeSeparate` writes `SUMMARY.separated`; library export / import roots keep kind `import` with `SUMMARY.imported`.

Stay: everything about tabs, drafts ("unsaved changes"), session, Recent, cards, Find it…, Save As, Duplicate, close and quit, the copy question, `newerCopy` / `olderCopy`, `updateMine`, `rolledBack` and its two actions, `savedAside`, the conflict sheet as the fallback, the journaling of `W` before any choice, "one save per tab at a time", and the rule that edits typed during a save are never dropped (`refreshConflict` logic now also guards §5.4 step 7.1).

Existing phase 1 tests that assert a changed behaviour (the conflict sheet opening on a save conflict, the copy written for a replaced save, `choose` on `newerOnDisk`) are rewritten by session to the new behaviour; the conflict-sheet tests are kept by forcing the fallback (a side that does not normalise).

### 5.10 Bring back — `bringBack(id)`

1. Tab has unsaved changes → dialog `bringBackDirty`; `saveFirst` → `save(key)`, continue only when it succeeded; `cancel` → `{ok:false, reason:"cancelled"}`.
2. The version's content (source order of `selectVersion`). Not openable → toast `error` "This version can no longer be opened.", `{ok:false, reason:"failed"}`.
3. Its `content_hash` equals the head's → toast `error` (tone `info`) "That version is the same as the current one.", `{ok:false, reason:"nothing"}`.
4. New revision: `id r-<ulid>`, `parents: [R]`, `kind: "restore"`, `restored_from: id`, `summary: SUMMARY.broughtBack`, `sections` = that version's refs, this computer as author. Manifest through `applyRetention` with `pinned: [id]`; parts the file lacks are sent as `newParts`.
5. `save({expectedHead: R})`. `saved` → `replaceContent` (no undo step), toast `broughtBack {version}`, list rebuilt. `conflict` → nothing written; the newer version is handled by table A; toast `error` "The file was changed on another computer. Try again." Other results as a save.

---

## 6. UI (owner: ui)

All new components in `src/components/graph/files-ui/`. MUI like the rest. Every interactive element gets the `data-testid` shown. Texts live in `files-ui/text.ts`.

### 6.1 Components and placement

| file | what | where |
|---|---|---|
| `DocBar.tsx` (changed) | a **clock button** (`doc-versions`, MUI `HistoryIcon`, tooltip "Versions") between Save and the File menu button; disabled for an untitled document; pressed look while the panel is open → `openVersions()` / `closeVersions()` | — |
| `FileMenu.tsx` (changed) | item **Versions** (`MENU.versions`) after Close Tab | — |
| `VersionsPanel.tsx` | right-hand side panel (`versions-panel`, 380 px, not modal, under the document bar, beside the workspace): header "Versions" + close (`versions-close`); the list; the legend; the footer line | `GraphView`, when `versions?.tabKey === activeKey` |
| `LaneGraph.tsx` | the SVG lane graph for `layout` (`versions-graph`): one `<circle>` per row (`data-testid="lane-dot"`, `data-id`, `data-lane`), one `<path>` per edge (`lane-edge`, `data-dashed`), stubs as short dashed lines with their label (`lane-stub`). Row height 44 px, lane width 16 px. Colours: palette of 8 by `colorIndex` (wrapping), grey for `-1`. The row's text sits to the right of the widest lane. | in `VersionsPanel` |
| `VersionRowView` (in `VersionsPanel.tsx`) | one row (`version-row`, `data-id`, `aria-selected`): line 1 `summary`; line 2 `{name} · {computer} · {when}` ("you · This Mac · 2 h ago"; for a version combined automatically: "Combined automatically · {when}"); chips (`version-chip`, `data-chip`); for a copy's newest version the label "In '{copyName}'" | — |
| `VersionPreview.tsx` | covers the workspace (not the document bar, not the panel) while a row is selected (`version-preview`): header "{summary} — {who}, {when}" + chip "Read only"; tabs **Graph** / **Table** / **Scratchpad** (read-only renderings of `preview.content`; the graph through the existing plot request, with "The graph can't be shown right now." when the engine does not answer); buttons **Compare with current** (`version-compare`, a toggle), **Bring this version back** (`version-bring-back`), **Save this version as a new analysis…** (`version-save-as-new`), **Close** (`version-preview-close` → `selectVersion(null)`). Not openable → the body is the "too old" text and the three action buttons are disabled. The workspace stays mounted underneath. | `GraphView` |
| `CompareView.tsx` | shown inside `VersionPreview` when `comparing` (`version-compare-view`): per section a line with chip "Same" / "Different" (`compare-section`, `data-key`, `data-same`); the table with changed cells highlighted (from `compare.table.cells`, "and {n} more" beyond the list); changed settings as "{field}: {a} → {b}"; the two graphs side by side ("This version" / "Current") | — |
| `CombineDialog.tsx` | dialog `combine` (`combine-dialog`), §6.4 | `FilesHost` |
| `BringBackDialog.tsx` | dialog `bringBackDirty` (`bringback-dialog`; buttons `bringback-save`, `bringback-cancel`) | `FilesHost` |
| `BannerSlot.tsx`, `text.ts` (changed) | the new banner kind, actions and states (§6.3) | — |
| `SimPanel.tsx` (changed) | new buttons (§6.6) | — |
| `GraphView.tsx` (changed) | mounts `VersionsPanel` and `VersionPreview`; an "Updating…" veil over the graph (`graph-updating`) while `tab.updating`; wraps figure exports in `holdReplace("export")`; Edit → Undo shows `undoLabel()` as its tooltip / menu text when set | — |

The UI calls only `useFileSession` (now `FileSessionStateP2`) and `devSim()`; it does not import the merge modules.

> CHANGED BY ui (no shape change): (1) `VersionRow` carries no time when `who` is null, so the "when" of an automatic combine is worked out in the UI as the later of its parents' times (what §3.4.4 stores). (2) There is no in-window Edit menu and the native one is Rust's, so `undoLabel()` is shown as a button in the canvas tab strip ("Undo: combine with …", tooltip with ⌘Z) while it is set. (3) Exports are wrapped through a new optional `hold` prop of `components/shared/PlotResult.tsx` (the download buttons live there). (4) When the space beside the document is under 1220 px the Versions panel lies over the workspace's right edge instead of squeezing it (1280 px and wider: beside it). (5) The panel asks for a fresh list (`openVersions(tabKey)`) when the tab's unsaved state, base, path or banners change, and the preview re-runs `compareWithCurrent(true)` when the current content changes, because the list is otherwise not rebuilt for a dirty tab or a `newerOnDisk` banner. (6) Stub labels are drawn as text on the row's second line (with the dashed stub in the SVG), not inside the SVG. (7) The list uses `role="list"`, not `listbox`, because `domInteractionBusy` treats any open `[role="listbox"]` as "busy" and would hold back every reload while the panel is open.

### 6.2 Versions panel wording

| where | text |
|---|---|
| panel title | Versions |
| empty / loading | Loading versions… |
| chips | `current` → **Current** · `combined` → **Combined** · `broughtBack` → **Brought back** · `fromOldLibrary` → **From old library** · `tooOld` → **Too old to open** · `unsaved` → **Not saved yet** |
| working row | Unsaved changes — line 2: "you · {this computer} · now" |
| row, automatic combine | line 2: "Combined automatically · {when}" |
| copy label | In '{copyName}' |
| stub label | Separate analysis: '{name}' |
| legend title | Computers |
| footer, when `tooOld > 0` | Older versions are listed but can no longer be opened. |
| preview header chip | Read only |
| preview, too old | This version is too old to open. Its entry is kept so you can see who saved it and when. |
| buttons | Compare with current · Bring this version back · Save this version as a new analysis… · Close |
| compare | Same · Different · This version · Current · "{n} cells differ" · "and {n} more" |
| bring back with unsaved changes (dialog) | title "Bring back the version from {when}?" · body "You have unsaved changes. They are saved as a version first, so nothing is lost." · buttons **Save, then bring it back** · Cancel |

`{when}` = `whenText` ("2 h ago"; a date when older than a day). `{who}` = `whoText`.

### 6.3 Banners and toasts

| kind | severity | text | buttons (action → label) |
|---|---|---|---|
| `newerOnDisk` (changed) | info | {Who} saved a newer version. | `combine` → **Combine my changes with it** · `later` → Later |
| `savedOver`, `state: "combining"` | info | Another computer saved over your last save. Nothing is lost — combining both now. | — |
| `savedOver`, `state: "choose"` | warning | Another computer saved over your last save. Nothing is lost. Choose what to keep. | `combine` → **Choose…** |
| `savedOver`, no `state` | warning | (phase 1 text, unchanged) | (unchanged) |
| `combined` (new) | success | Combined with the version saved by {who}. Taken from it: {section list}. (second sentence left out when `sections` is empty) | `whatChanged` → **What changed** · `undo` → **Undo** |
| `extraCopy`, older / same (changed) | info | '{name}' is an older copy of this analysis. | `remove` → **Remove it** · `keep` → **Keep** |
| `extraCopy`, diverged (changed) | warning | A second copy of this analysis, '{name}', has changes by {who}. | `combine` → **Combine…** · `notSame` → This is a different analysis · `later` → Later |
| `extraCopy`, newer | warning | (unchanged) | (unchanged) |
| `notSaved` | warning | (unchanged) — `choose` reopens the combine dialog | |

`bannerActionLabel`: `combine` → "Combine my changes with it" (`newerOnDisk`), "Choose…" (`savedOver`), "Combine…" (`extraCopy`); `remove` → "Remove it"; `keep` → "Keep"; `whatChanged` → "What changed"; `undo` → "Undo". `{section list}` = `SECTION_PHRASE` joined like `sectionList` (§3.5). contract.ts already added `combined` to `BANNER_ORDER` (release fix N1: moved to after `newerCopy`, so it never hides a banner that asks for a choice); `text.ts` already has its severity and text so the baseline compiles — ui owns and may reword it.

Toasts: `combined` → "Combined with {who}'s changes" · `broughtBack` → "Brought back the version from {when}" · `copyRemoved` → "Removed '{name}'. It is kept for 30 days." · `savedAsNew` → "Saved as a new analysis: '{name}'".

> CHANGED BY fixer (ux F7, ux F4): toast `copyRemoved` → "Removed '{name}'. The app keeps it for 30 days." The combine dialog for a saved copy of my own that was replaced (journal source, `theirs.mine`) names the sides by what they are: "In the file now: saved by {who}" / "Your save that was replaced ({when})", buttons **In the file now** / **Your save**. After Bring this version back succeeds, the read-only preview closes.

Undo step label (built by session, shown by ui): `Undo: combine with {who}'s changes` — `{who}` as `whoText` without a leading capital ("Alice (Office iMac)", "you on Office iMac", "another computer" when the name is blank).

### 6.4 The combine dialog (plan §9.3)

`combine-dialog`, from `CombineState s`:

- **Title:** three-way → "Two versions of '{name}' changed since {since: when}". Two-way → "Two versions of '{name}'".
- **Sub-line:** "Mine: {this computer}{, with unsaved changes}" · "Theirs: {who}" (`combine-mine`, `combine-theirs`). For a copy: "Theirs: '{copyName}', saved by {who}".
- **"Copy {index} of {total}"** (`combine-queue`) when `total > 1`.
- **Two-way note** (`combine-twoway`) when `s.twoWay`: "These two copies were last the same too long ago to compare part by part. Choose which to keep for each part that differs."
- **Section list** (`combine-section`, `data-key`, `data-status`), one row per section in order, title from §2.1:
  - `same` → chip **Unchanged**; collapsed under "Not changed ({n})".
  - `mine` / `theirs` → chip **Combined** with "from mine" / "from {who}"; collapsed under "Combined automatically ({n})" (`combine-auto-group`); expanding shows them and lets the choice be changed.
  - `both` → chip **Choose** (warning) and two buttons **Mine** (`combine-pick-mine`) / **Theirs** (`combine-pick-theirs`, labelled with the user name when known: "Alice's"); the chosen one is filled. Header counter: "{n} to choose".
- **Side-by-side pane** (`combine-compare`) for the focused section: mine left, theirs right, differences highlighted from `s.compare` (table: changed cells; settings: "{field}: {a} → {b}"; graph: both images; scratchpad: "{n} cells differ").
- **Adjusted automatically** (`combine-adjusted`), when `s.adjusted` is not empty: "Adjusted automatically: {section list}. Some settings pointed at rows or columns that are no longer in the table. Check the result after applying."
- **Error** (`combine-error`): `s.error`.
- **Footer:** **Cancel** (`combine-cancel` → `cancelCombine()`) · **Keep both as separate files** (`combine-keep-both` → `keepBothAsSeparate()`) · **Apply** (`combine-apply`, primary, disabled until `s.canApply`, spinner while `s.applying` → `applyCombine()`).
- Footnote: "Nothing is saved until you press Apply. Both versions stay in the file's history."

Closing with Esc or the backdrop = Cancel.

### 6.5 Words

Never in the UI: revision, head, journal, hash, manifest, draft, sibling, displaced, analysis id, **merge, LCA, base, ancestor, lane, snapshot** (a section is called by its title). ui extends the phase 1 test: `merge` and `lca` join the banned list, and every new banner state, toast and dialog string is included in the sweep.

### 6.6 Simulator additions (browser preview)

`devSim()` returns `DevSimApiP2`. New `SimPanel` buttons, each acting on the picked file:

| button (`data-testid`) | label | calls |
|---|---|---|
| `sim-edit-table` | Edit table and save | `remoteEdit(path, {section: "table"})` |
| `sim-edit-graph` | Edit graph and save | `remoteEdit(path, {section: "figure"})` |
| `sim-edit-analysis` | Edit analysis settings and save | `remoteEdit(path, {section: "analysis"})` |
| `sim-edit-scratch` | Edit scratchpad and save | `remoteEdit(path, {section: "scratchpad"})` |
| `sim-diverge-copy-table` / `sim-diverge-copy-graph` | Make a diverged copy (table / graph) | `remoteDiverge(path, {section, how: "copy"})` |
| `sim-saveover-table` / `sim-saveover-graph` | Save over my last save (table / graph) | `remoteDiverge(path, {section, how: "saveOver"})` |
| `sim-older-copy` | Add an older copy | `olderCopy(path)` |
| `sim-rollback` (exists) | Put back earlier version | `rollback(path)` |
| `sim-many` | Save 25 more versions | `remoteEditMany(path, 25)` |
| `sim-removed` | shows the count of `removed()` in the panel's note line | — |

The phase 1 `sim-edit` button becomes `sim-edit-table`. Section-level auto-combine vs a needed choice is exercised by pairing an own edit with the matching button: own table edit + "Edit graph and save" → combines by itself; own table edit + "Edit table and save" → the dialog.

`remoteDiverge` and `olderCopy` need a previous version: when the file has only one version they first make one (`remoteEdit` on the table) and resolve after it.

> CHANGED BY session: `remoteEdit(…, {section: "analysis"})` switches the significance level (`alpha` 0.05 ↔ 0.01): the centre / error-bar setting named in contract.ts is a field of the **graph** section (`GraphFigure.center`), so it would not change the analysis section. Scratchpad cell A1 is `[1, 1]` (scratchpad rows and columns are 1-based). The other computer's saves (`remoteEdit`, `remoteEditMany`) go through `applyRetention` as its app would, so "Save 25 more versions" leaves only the newest contents in the file and this computer shows *Too old to open* for versions it never had (versions this computer read or saved stay openable from its saved copies, §5.8 `openable`). `combine_pending` is not taken back into memory at restore: the journal check that runs when the tab is opened finds the same divergence again (that is the re-evaluation).

---

## 7. File ownership (no overlaps)

| implementer | owns |
|---|---|
| **merge** | new files `src/components/graph/file/revisions.ts`, `retention.ts`, `graphMerge.ts`, `summaries.ts`, `laneGraph.ts` and their `*.test.ts`; new fixture files under `src/components/graph/file/fixtures-p2/` if wanted |
| **rust** | `src-tauri/**` |
| **session** | `src/components/graph/file/session.ts`, `backend.ts`, `memoryBackend.ts`, `previewBackend.ts`, `tauriBackend.ts`, `devSim.ts`, `e2e.ts`, `testkit.ts`, their existing tests, new test files `combine.test.ts`, `versions.test.ts`, `combine.multidevice.test.ts`; `src/store/graphStore.ts` |
| **ui** | `src/components/graph/files-ui/**` (including `text.ts`, `text.test.ts`), `src/components/graph/GraphView.tsx`, `GraphLibrary.tsx`, `src/App.tsx`, `src/components/layout/AppShell.tsx` |
| **nobody** (read-only) | `contract.ts`, `format.ts`, `docCodec.ts`, `idMap.ts`, `paths.ts`, `libraryExport.ts`, `goldens.test.ts`, `DataGrid.tsx`, the scratchpad, `graphModel.ts`, the Python sidecar, CI, `package.json` |

Already done by the contract author: the phase 2 section and marked members in `contract.ts`; in `files-ui/text.ts` the severity and text of the banner kind `combined` (3 small edits, so that `Record<BannerKind, …>` and `text.test.ts` keep passing).

---

## 8. Acceptance checklist

Where it runs: **V** = vitest (scratch copy), **C** = `cargo test --locked`, **B** = browser preview with the simulator, **E** = real-app self-test (`LAS_E2E_SCRIPT`, phase `"combine"`). Baseline that must stay green throughout: `tsc --noEmit`, `vite build`, vitest (13 files / 339 tests + the new ones), `graph-fe-tests/run.sh`, `graph-tests/run_all.sh`, `cargo test --locked` (77 passed / 1 ignored + the new ones), `cargo check --locked --release`.

### Pure engine (merge) — V

1. **M1** `isAncestor` / `isAncestorOrSelf` / `relation` on linear, forked, combined and criss-cross histories; unknown ids; a 5,000-entry chain without stack overflow.
2. **M2** `lowestCommonAncestors`: one for a simple fork; two for a criss-cross; the fork point itself when one side is an ancestor.
3. **M3** `findBase`: `lca` when stored; `nearest` when the lowest common ancestor's content is gone but an older common one is stored; `ambiguous` for a criss-cross; `none` when nothing is stored; `notDiverged` with the right relation; content found only in a third file (the journal copy) counts.
4. **M4** `unionRevisions`: a stored entry wins over the same id without content, from either side.
5. **M5** `survivorPath`: shortest name; alphabetical tie; same answer for every ordering of the input.
6. **M6** `newestFirst`: children before parents under ±2 h clock skew; deterministic under shuffling.
7. **M7** Retention: head kept; newest 20 by first-seen (a version with an old `time` but seen recently is kept, one with a new `time` but seen long ago is not); both parents of every combine; hand-over point kept at 179 days and dropped at 181 days of *local* time, whatever its own `time`; `beaconHeads`, `unconfirmedHeads`, `pinned` kept; entries never removed; content never comes back; ≤ 20 stored → same object returned.
8. **M8** Property tests over generated documents (all three templates, random single- and multi-section edits; at least 200 cases, fixed seed): `combine(b, x, b)` = `x`; `combine(b, b, x)` = `x`; `combine(b, x, x)` = `x`; conflict-free `combine(b, x, y)` and `combine(b, y, x)` have the same content hash; **same result id from both sides** (`combineRevision` with `auto: true` gives deep-equal objects when mine and theirs are swapped).
9. **M9** Section statuses: each of `same` / `mine` / `theirs` / `both`, three-way and two-way; both sides making the *same* change → `same`.
10. **M10** Repairs: mine deletes a column, theirs recolours that column's series → the plan has a result with `repairs` naming the graph and `autoApplicable: false`; mine edits cells, theirs changes the title → no repair, `autoApplicable: true`.

    > CHANGED BY merge: at section level, deleting a column also drops that column's entry from the graph section, so "mine deletes a column, theirs recolours it" makes the graph `both` (no result without a choice); choosing theirs for it gives a result with `repairs: ["figure"]`. The case where the plan itself has a result with a repair: mine deletes a column, theirs adds an analysis pair naming it → `repairs: ["analysis"]`, `autoApplicable: false`. Both are tested.
11. **M11** Same pipeline: a section stored in an older form (missing a field the defaults add) on one side and in the current form on the other is `same`.
12. **M12** `applyChoices`: all mine = mine, all theirs = theirs; a missing choice → `null`; an overridden preset is honoured.
13. **M13** `mergeRevisionId` bytes: a hand-computed vector (two fixed parent ids, a fixed content hash → the expected `r-m-…`), parents in either order.
14. **M14** `combineRevision` auto form: blank author fields, sorted parents, `time` = the later parent time, `sections_from` right; chosen form carries the author.
15. **M15** `combineDelayMs`: within 2000–10000, stable per id, different for two sample ids.
16. **M16** Summaries: every row of the §3.5 table; `displaySummary` for a phase 1 revision ("Changed data, graph." → shown without the full stop).
17. **M17** `compareSections`: counts and cell list for changed cells, added / removed rows and columns, a changed setting, an unchanged scratchpad (`0`).
18. **M18** Lane graph: every invariant of §3.6, plus a golden layout for: linear; fork + combine; fork + combine + a foreign copy branch; three computers.

### Rust — C

19. **R1–R9** the tests of §4.6 (remove: success, equal, diverged, newer, other analysis, same file, tracked, changed in the gap, truncated; pruning at 29 / 31 days; peek; seen map; menu).
20. **R10** `cargo build --locked` with an unchanged `Cargo.lock`; `cargo check --locked --release`.

### Controller (session) — V, two or three `MemoryDevice`s with the `ManualClock`

21. **S1** Unsaved table edit here, the other computer saves a graph edit → banner `newerOnDisk` with `combine`; pressing it writes one two-parent version at once, the tab shows both changes, banner `combined` lists the graph; the other computer just reloads.
22. **S2** The same through **Save** (conflict → combined in one step, outcome `ok: true`).
23. **S3** Both changed the table → Save opens the combine dialog (`sections.table.status === "both"`, `canApply` false); nothing on disk changes until `applyCombine`; choosing Mine / Theirs gives the expected table; `cancelCombine` leaves `notSaved` and the file untouched.
24. **S4** `keepBothAsSeparate` for each source (`disk`: new analysis elsewhere, file as they saved it; `copy`: the copy gets a new analysis id; `journal`: a new file beside it).
25. **S5** Last-writer-wins (`lww`) replaced my save, clean tab, different sections → banner `savedOver {state:"combining"}`, **nothing written before the device delay**, then one combined version; with the same section → banner `savedOver {state:"choose"}` and no write.
26. **S6** Device order: two clean computers see the same diverged pair; the one with the shorter delay writes, the other finds the result at its re-check and writes nothing; when both are forced to write (delays equal), both produce the **same id** and the file ends with one combine.
27. **S7** `savedButDisplaced` → combined with the displaced version instead of a copy beside the file.
28. **S8** Extra copies: older → `remove` moves it (backend entry with reason `removedCopy`), `keep` remembers it; diverged → `combine` writes into the survivor (shortest name) and the tab re-points when its own file was the longer name; a copy that gained changes between the banner and the click is **not** removed (`notOlder`); three diverged copies → `index` / `total` run 1…3.
29. **S9** Rollback: banner, no automatic action; "Use the earlier version" then Save carries the dropped versions into the file's history (their ids are in the manifest again).
30. **S10** `replaceContent`: refuses when base or `editSerial` moved (an edit typed between read and apply is kept and the banner appears); after a combine exactly one undo step with the label; undoing it brings my content back as unsaved changes and does **not** remove their version from the file; the scratchpad string object is identical when its text did not change; `docSerial` unchanged; held back while `interactionBusy()` or a hold is active (`tab.updating`), applied after release.
31. **S11** Open or `replaceContent` of every fixture leaves the tab clean (phase 1 test extended to `replaceContent`).
32. **S12** Bring back: new version of kind `restore` with `restored_from`, parent = the old head, content equal to the chosen version, history length +1; with unsaved changes the dialog saves first; same content → nothing written.
33. **S13** Save this version as a new analysis: new id, `forked_from` names the version, opens in a new tab, current tab untouched.
34. **S14** Versions list: rows newest first, chips for current / combined / brought back / from old library / too old / unsaved; after 25 saves the oldest rows are `tooOld` and `versions.tooOld > 0` while every entry is still listed; an extra copy's own versions are `foreign` with `copyName`; a separated file appears as a stub.
35. **S15** Compatibility: a revision with an unknown field survives open → save → combine → bring back unchanged; a phase 1 fixture file opens and lists.
36. **S16** Fallback: an unreadable side (`combine` → `ok: false`) opens the phase 1 conflict sheet, and each of its three choices still loses nothing.
37. **S17** Retention wiring: manifests written by save, combine and bring back keep the two combine parents and at most the allowed contents; `SeenMap` gets every new id once and is written.
38. **S18** In-flight: a second Save during a combine returns the same outcome; an edit typed while the combine is being written is still in the tab afterwards and the tab is "unsaved".
39. **S19 Multi-device scenarios** (`combine.multidevice.test.ts`; plan §13). For each of: conflict modes `dropbox`, `onedrive`, `lww`; sync delays 0 s, 5 s, 60 s; one computer offline then back; partial delivery (incomplete file first); delete-then-create delivery; wake-before-sync (edit made on an old base after a long clock jump); rename on one computer while the other edits; duplicate device id; ±2 h clock skew; three computers — two (or three) computers edit **different sections**, save, and the world settles (copies combined by pressing `combine` where the service made a copy). Assertions, by helper:
    - **no version is ever lost**: every head any computer ever wrote is in the history of a file on disk or in a journal (`writtenHeads` ⊆ `keptRevisions`);
    - **all computers end on the same head** for the file, and their tabs show the same content hash;
    - **at most one combine version per pair of heads**: among all revisions of all files, no two two-parent revisions have the same sorted parents;
    - **no file is removed unless its head is an ancestor-or-self of a surviving file's head** (checked for every `removedCopy` entry at the moment of removal and at the end).

    The same matrix with **the same section** edited: at least one computer shows the dialog or the `choose` banner, nothing is written without `applyCombine`, and after one choice all computers converge with the same four assertions.

### UI — V (text) and B (browser preview: `las.activeTool = "graph"`, simulator panel)

40. **U1** (V) Wording table of §6.2–6.4 for every new banner state, action label, toast and dialog string; the banned-word sweep including `merge` and `lca`.
41. **U2** (B) Clock button opens the panel; rows newest first with summary · name · computer · time; a second lane appears after "Make a diverged copy (graph)"; after Combine… the lanes join at a row with the *Combined* chip; dots of the two computers have different colours; the legend names both.
42. **U3** (B) Select a row → read-only preview (Graph / Table); **Compare with current** shows "Different" for the changed section and highlights the changed cell; Close returns to the workspace with nothing changed (the tab is still clean).
43. **U4** (B) **Bring this version back** → a new top row with *Brought back*, the table shows the old value, the row count grew by one. With unsaved changes the "Save, then bring it back" dialog appears first.
44. **U5** (B) **Save this version as a new analysis…** → path picker, a new tab with the old content; back in the first file's panel a stub "Separate analysis: '…'" hangs off that version.
45. **U6** (B) Own table edit (unsaved) + "Edit graph and save" → banner "Alice (Office iMac) saved a newer version." [Combine my changes with it] [Later]; pressing it → banner "Combined with the version saved by Alice (Office iMac). Taken from it: the graph." [What changed] [Undo]; **What changed** opens the panel with compare on; **Undo** adds a *Brought back* version with my pre-combine content.
46. **U7** (B) Own table edit + "Edit table and save" + Save → the combine dialog: title with "changed since", "1 to choose", Apply disabled; pick Theirs → Apply enabled → after Apply the table has their value; before Apply the simulated file's head is unchanged (`__lasSim.files()`).
47. **U8** (B) "Save over my last save (graph)" on a clean tab → "…combining both now." appears, then (after "+10 s") the `combined` banner; with "(table)" after an own table save → "Choose what to keep." [Choose…].
48. **U9** (B) "Add an older copy" → banner "'… (old copy)' is an older copy of this analysis." [Remove it] [Keep]; Remove it → toast "Removed '…'. It is kept for 30 days.", the file is gone from the path picker and `sim-removed` counts 1. "Make a diverged copy (table)" → [Combine…] [This is a different analysis] [Later].
49. **U10** (B) "Put back earlier version" → the rollback banner with both buttons, nothing happens by itself.
50. **U11** (B) "Save 25 more versions" → the oldest rows show *Too old to open*, the footer line "Older versions are listed but can no longer be opened." is shown, selecting one shows the too-old text with the action buttons disabled.
51. **U12** (B) While a table cell is being typed in, "Edit graph and save" on a clean tab does not interrupt the editor; the graph shows "Updating…" and the new version appears after the cell is committed (if the commit changed the value, the tab counts as having unsaved changes and gets the newer-version banner instead).
52. **U13** (B) No horizontal jump of the workspace when a banner changes; the panel and preview work at 1280 × 800; viewport reset to desktop and the preview tab closed afterwards.

### Real app — E (debug build, `LAS_E2E_SCRIPT`, phase `"combine"`, folders under the scratch area; one run also in `~/Library/CloudStorage/Dropbox/LAS-phase2-test-DELETE-ME`, moved to the Trash afterwards)

53. **E1** Another computer's graph save (staged file copied over) while this tab has an unsaved table edit → Save → one file on disk whose head has two parents and both changes; the journal folder holds my working version.
54. **E2** A diverged copy placed beside the file (sync-conflict name) → `startCombine` with source `copy` → combined into the shorter-named file; `removeExtraCopy` → the copy is in `LAS_STATE_DIR/displaced/` with an index entry `removedCopy` and gone from the folder; a second diverged copy is **refused**.
55. **E3** Bring back → the file on disk has a `restore` version with `restored_from`; reopening after a restart shows the same list (`graph-seen.json` exists in `LAS_STATE_DIR`).
56. **E4** File menu → Versions toggles the panel (`dev_e2e_fs` op `menu` with `file.versions`).
57. **E5** A file written by this build opens in the released exp-0.2.20 app (manual: open it there, edit, save, reopen here — the combined and brought-back versions are still listed). If the released app cannot be run by the implementer, say so.

> CHANGED BY integrator (tests only, no shape change): phase `"combine"` also runs E6–E11 on a second file "E2E P2b": E6 another computer's save replaced my last save on a clean tab → `savedOver {state:"combining"}`, nothing written before `combineDelayMs`, then one `auto` combine with `sections_from`; E7 an older copy → `remove` from the banner (in `displaced/`, `removedCopy`); E8 a rollback delivered by `copyOver` → `rolledBack`, nothing automatic, `useEarlier` + Save puts the dropped version back into the history; E9 the same section on both sides → `savedOver {state:"choose"}`, nothing written, `combine` → theirs → Apply; E10 its Versions list; E11 a phase 1 file (the phase 1 Rust golden `save-02-next.lag`, placed by the runner as "E2E golden p1.lag") opens, combines on Save, and its old version entries are unchanged. E5's file-level half is covered by a scratch harness instead of the released app: files written by this build are read by the phase 1 Rust reader (commit 8b3cb8a) and saved with the phase 1 save path (phase 1 TS code + phase 1 Rust), and every phase 2 field (`restored_from`, `auto`, `sections_from`, an unknown field) survives.

---

## 9. Where this contract narrows or changes the plan (on purpose)

1. **Sections are the four parts**; there is no separate "names" section (the name is the file name).
2. **Automatic combines need the true lowest common version** (`lca`). With an older stand-in base or two candidate bases the dialog is always shown, presets filled in.
3. **Extra copies are never combined without a click** (plan §9.4), also when nothing needs a choice; then the click applies at once.
4. **The device-ordered delay applies only to combines nobody asked for** (clean tab; another computer's save replaced or raced mine). A combine started by Save or a button is written at once: my unsaved changes exist only here, so no other computer can produce the same result.
5. **Automatic combine revisions carry no author** (blank names); the panel shows "Combined automatically". A combine with a choice carries the chooser.
6. **"Undo" on the combined banner is Bring back** of my pre-combine version (a new version), as the plan says; the in-editor undo step with the label exists as well.
7. **Reload in place**: anchoring selection and scroll by row / column id, and carrying the Scratchpad's scroll position over a changed scratchpad, are not in phase 2 (the grid and the Scratchpad are nobody's files in this phase). An unchanged scratchpad keeps its session, as the plan requires.
8. **"Is something being edited?"** is detected from the page (focused input, mouse button down, open menu / popover / dialog) plus an explicit hold for exports, instead of hooks inside the grid.
9. **First-seen times** live in one local file (`graph-seen.json`). On the first phase 2 start every known version counts as seen now, so hand-over points are kept at least 180 days from then.
10. **Versions that exist only in this computer's saved copies** (a lost save not yet combined) are not rows of the panel; the `savedOver` banner handles them.
11. **A removed copy can be listed** (`graphfile_list_displaced`) but there is no "put it back" button yet; it is kept 30 days.
12. **Preview of a version** is a read-only rendering (graph, table, scratchpad), not the full editor in a read-only mode (that mode is phase 3).
