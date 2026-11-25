# Phase 4 contract — Fine-level combining

Binding for the four phase 4 implementers: **mergeTable** (pure TS: the data table), **mergeFields** (pure TS: analysis settings, graph settings, scratchpad, automatic adjustments), **session** (puts the pure modules together in `graphMerge.ts` and wires them into the existing combine flow), **ui** (the combine dialog's fine-level panes, banners, simulator panel). They work in parallel and cannot talk, so everything at a boundary is decided here. Sources: the approved plan (`analysis-files-plan.md` §9, §13, §14, §16 D8 / D11, §17), the phase 2 contract (`analysis-files-phase2-contract.md`, with every "CHANGED BY" note), the phase 3 contract §5 (`analysis-files-phase3-contract.md`), and the code as released in exp-0.2.25 (commit f0add9e).

- **Normative TypeScript shapes:** `TauriApp/src/components/graph/file/contract.ts`, section 8 ("Phase 4") plus the two members marked "Phase 4" in `TabBanner`. It is already in the repo and compiles (`tsc --noEmit` and vitest green with it). Nobody edits it. If something in it is wrong, say so in your final report and work around it.
- "Repo" = `/Users/zhuojianlook/Library/CloudStorage/Dropbox/GitHub Repos/Webtools/Analysis/TauriApp`. Paths below are relative to it unless they start with `/`.
- Phase 1–3 behaviour that this document does not mention stays exactly as it is. In particular: the file format, the id formula of a combined version, the base rule (`findBase`, journal included), the device-ordered delay and its re-check, the routing tables A–E, `replaceContent` with one labelled undo step, "Copy 2 of 3", retention, and everything about read-only tabs.
- Words: the code says revision / head / merge / conflict / base. **The UI never does.** It says *version*, *combine*, *row*, *column*, *setting*, *cell*, *to choose*. The banned-word sweep of `files-ui/text.test.ts` stays and covers every new string (§6.8).
- There is **no Rust change** in phase 4 (`cargo test --locked` stays at 144 passed / 2 ignored).
- Where this contract narrows the plan on purpose: §9.

---

## 1. What is combined, and how it is keyed

### 1.1 The four sections as stored (unchanged)

A version's content is four parts in file form (`docCodec.FileSections4`, built by `idMap.toFileSections`):

| section | type | content | keyed for combining by |
|---|---|---|---|
| `table` | `idMap.FileTable` | `{v: 2, template, col_titles[], row_titles[], x_title, n_rep, x[], cells[row][col][rep], row_ids[], col_ids[]}`. Every value is text exactly as typed. `row_ids[i]` / `col_ids[j]` are the hidden ids (`row-…` / `col-…`, `graphModel.ID_RE`) that follow a row or column through every structural edit. | rows by `row_ids`, columns by `col_ids`; a **cell** by `(row id, col id, replicate index)`; a **row title** and an **X value** by row id; a **column title** by col id; `x_title` and `n_rep` as single fields; `template` must be equal |
| `analysis` | `idMap.FileAnalysis` | `test, posthoc, compare, control, pairs, alpha, within, family, correlation` (plus any field a newer app added). `control` is an id or `null`; `pairs` is a list of `[id, id]`. The ids are column ids, or row ids when the table is grouped and `within === "columns"` (`idMap.entityIds`). | top-level field name; `pairs` as a **set of unordered id pairs** |
| `figure` | `idMap.FileFigure` | every `GraphFigure` field except `colors`, `labels`, `prism_palette`, plus `series: {<col id>: {color, label}}` with one entry per table column, in column order. | top-level field name, with three **atomic groups** (§2.4); `series[c].color` belongs to the colours group; `series[c].label` by col id |
| `scratchpad` | parsed `scratchModel.ScratchDoc` or `null` | `{v: 1, cells: [[row, col, input] or [row, col, input, numFmt], …], cols?: {<col number>: width}}`, cells sorted row-major, rows / columns 1-based; `null` = empty sheet | a **cell** by address `(row, col)`, its value being the pair `(input, numFmt or "")`; a **column width** by column number |

Trailing blank rows of the table (the editor always keeps at least `MIN_ROWS` = 10 rows and one blank row after the last filled one, each with a freshly made random id) are padding, not content: §2.2.5.

### 1.2 One pipeline for base, mine and theirs (unchanged)

`graphMerge.normaliseSections(raw)` (phase 2 §2.2: `contentOfSections` → `sectionsOf` → `partsOf`, run twice, `null` when the two runs differ) is the only way a side enters a comparison. The fine-level modules only ever see `NormalisedSide.sections.<section>`: the file form *after* the pipeline. So all three sides have valid unique ids, `cells` of exactly rows × columns × `n_rep` strings, `x[i] === ""` on non-XY tables, `n_rep === 1` on column tables, every settings field present, one `series` entry per column, and a canonical scratchpad object or `null`.

Sections are compared by `parts.refs[k].sha256` after the pipeline, as in phase 2. The fine-level modules are called **only for a section whose status is `both`** (both sides differ from the base and from each other) in a three-way comparison.

### 1.3 After the sections are put together (extended)

The assembled result goes through `normaliseSections` once more (phase 2 §2.3). Whatever that changes, and whatever the plot request would silently change (`effectiveAnalysis`), is an **automatic adjustment** (§2.6). Every fine-level module must return its section **already in pipeline form**, so that the pipeline changes nothing in a section unless another section forces it (a setting pointing at a column that is gone). A module whose output the pipeline changes on its own is a bug; tests T12 / F5 / X8 check it.

---

## 2. Pure modules

New files in `src/components/graph/file/`, each with a `*.test.ts` beside it. No I/O, no clock, no randomness, no store access, no device-specific data. Each module ends with a compile-time check against its interface in contract.ts:

```ts
({ mergeTable, mergeOrder }) satisfies MergeTableApi;                                    // mergeTable.ts
({ mergeAnalysis, mergeFigure, detectAdjustments, shortText }) satisfies MergeFieldsApi;  // mergeFields.ts
({ mergeScratch, shiftCheck, shiftFormula, sideBySide }) satisfies MergeScratchApi;      // mergeScratch.ts
({ normaliseSections, combine, applyChoices, combineRevision, combineDelayMs,
   combineFine, applyFineChoices, peersCombineAlike }) satisfies GraphMergeApiP4;        // graphMerge.ts
```

| file | owner | may import |
|---|---|---|
| `mergeTable.ts` | mergeTable | `contract.ts` (types, `LIMITS_P4`), `format.ts` (`sha256Hex`, `canonicalJson`), `idMap.ts` (types), `../graphModel` (`MAX_COLS`, `MAX_ROWS`, `MIN_ROWS`, `isBlank`) |
| `mergeFields.ts` | mergeFields | `contract.ts`, `format.ts` (`canonicalJson`), `idMap.ts` (types), `docCodec.ts` (types), `../graphModel` (`toNumericTable`, `effectiveAnalysis`, `TWO_GROUP_TESTS`) |
| `mergeScratch.ts` | mergeFields | `contract.ts`, `../scratchpad/scratchModel` (`canonScratch`, `sanitizeScratch`, `cellName`, `colName`, `colNumber`, `SCRATCH_COLS`, `SCRATCH_ROWS`) — **not** the formula engine (`@ironcalc/wasm`), which is not in the main bundle |
| `graphMerge.ts` | session | the three modules above, and what it imports today |

### 2.1 Shared rules

1. **Module shape.** Every module function takes the three sides and an optional `choices: FineChoices` (conflict id → `"mine" | "theirs" | "both"`), and returns a `FineMerge<T>` (contract.ts): `conflicts` (always all of them, whatever the choices), `value` (the combined section, or `null` while a conflict has no valid choice), `combined` / `auto` (what was taken without a choice), `orderChecks`, `adjustments`. It is called again whenever a choice changes; it must be cheap (T13) and must not keep state between calls.
2. **The three-way rule for one value** (`b`, `m`, `t`; equality is exact string equality for table texts and `canonicalJson` equality for everything else; "not there" is a value of its own):
   - `m = t` → that value (`from: "same"` when it differs from `b`);
   - `m = b` → `t` (`from: "theirs"`); `t = b` → `m` (`from: "mine"`);
   - otherwise a **conflict**; with a choice the result is that side's value.
3. **Conflict ids** are exactly the strings given with `FineConflictKind` in contract.ts (`table:row:<row id>`, `figure:group:yRange`, `scratchpad:cell:B12`, …). They contain nothing but the section name, a fixed word and ids / field names / addresses, so they are the same on every computer and from both sides.
4. **Symmetry.** Swapping mine and theirs (values and `SideKey`s) must give: the same `value` bytes for conflict-free input; the same conflict ids; `items[].mine` / `.theirs`, `deletedBy`, `auto[].from` swapped; and, with every choice swapped (`mine` ↔ `theirs`), the same `value` bytes. The only place the result depends on *which* side is which is the order rule, and that is decided by `SideKey`, never by the words "mine" / "theirs".
5. **Texts for display** (`FineItem.base / mine / theirs`, `FineAuto.before / after`, `FineAdjustment.from / to`): `null` when the place is not there on that side. Table texts and scratchpad inputs as they are, uncut. Settings through `shortText(v)`: a string as it is; a number or boolean through `String`; `null` → `""`; anything else its `canonicalJson`, cut to 60 characters (the rule `summaries.compareSections` uses).
6. **Lists are capped for display only**: `FineConflict.items` at `LIMITS_P4.conflictItems` (`more` = the rest), `auto` at `LIMITS_P4.autoItems` (`combined` = the true count). The caps never change `value`.
7. **`both`** is a valid choice only for a conflict whose `options` include it (the scratchpad's shift choice). Any choice that is not among a conflict's `options` counts as "no choice".

### 2.2 The data table — `mergeTable(input, choices?)` (owner: mergeTable)

Input: `base`, `mine`, `theirs` (`FileTable` after the pipeline), `mineKey`, `theirsKey` (`SideKey`). Async only because blank rows it has to add get hashed ids (§2.2.6).

**First and second side.** `first` is the side with the smaller `deviceId` (plain string compare); equal → the smaller `revisionId`; still equal → mine. The other is `second`. (Plan: "same-place insertions ordered by `device_id`".)

#### 2.2.1 Values

- `cell(S, r, c, k)` = `S.cells[row of r][col of c][k]` when side `S` has row `r` and column `c` and `k < S.n_rep`; `""` when it has both but `k ≥ S.n_rep` (a replicate a side does not have is blank there — so lowering the replicate count means "cleared those values", raising it "added blank ones"); **not there** when `S` lacks the row or the column.
- For the base, a cell that is not there counts as `""`.
- `K = max(mine.n_rep, theirs.n_rep)` replicates are looked at.

#### 2.2.2 Which rows and columns the result has

For every row id in any of the three `row_ids` (and the same table for columns with `col_ids`):

| in base | in mine | in theirs | result |
|---|---|---|---|
| no | yes | no | kept — added by mine (`rowAdded`) |
| no | no | yes | kept — added by theirs |
| no | yes | yes | kept — one row (the same id); its cells are combined against a blank base |
| yes | yes | yes | kept |
| yes | no | no | removed (`rowRemoved`, `from: "same"`) |
| yes | only one side, `O`, has it; the other, `D`, deleted it | | **`O` changed nothing in it** → removed (`rowRemoved`, `from: D`): the deletion wins. **`O` changed something in it** → conflict `rowDeleted` (`table:row:<id>`, `deletedBy: D`), except the blank-row case below. |

"`O` changed something in the row" = its row title differs from the base's, or its X value does, or `cell(O, r, c, k) ≠ cell(base, r, c, k)` for any column `c` that `O` has (columns `O` added included) and any `k < K`. For a column: its title differs, or any cell differs in any row that `O` has (rows `O` added included).

**Blank-row case (rows only):** when the row has no data in the base (blank title, blank X, all cells blank) and `O` changed something in it, the row is kept with `O`'s values and there is no conflict (it counts as `O`'s `rowAdded`). A blank row somebody removed and somebody else typed into is not worth a question, and nothing is lost.

Choice for `rowDeleted` / `colDeleted`: the side `deletedBy` → the row / column is removed; the other side → it is kept with that side's values (cells in columns / rows that side lacks are `""`). `items` lists what `O` changed (`mine` / `theirs` = that side's text, `null` on the side that deleted it).

> **CHANGED BY fixer (finding M1):** **A row without data in the base that both sides typed into, differently, is two added rows, not one row.** (The editor keeps one blank row at the end whose id is in the common version, so two people adding data both type into that same id; combining it as one row mixed two entries, could pair them silently on a paired table, and forced an either/or that dropped one side's new values.) Before anything else, for every row id `R` of the base with no data in the base that both sides have, each with data, where the two rows differ (`rowKey`: `JSON.stringify([title, x (XY only), [[col id, replicate, text] for every text that is not "", sorted by col id then replicate]])`, plain string compare): one side, the **keeper**, keeps its values in `R`; the other, the **leaver**, is treated as if its row `R` read as in the base and its own values sat in a new row directly after `R` with the id `"row-" + sha256Hex("las-split\n" + R + "\n" + rowKey(leaver's row)).slice(0, LIMITS_P4.fillIdHex)` (`"\n1"`, `"\n2"`, … appended while that id is taken, unless the keeper already holds it with that content). The keeper is the side that already holds the other's split row (same id, same `rowKey` — a combined version combined again, so T7 holds), else the **first** side (§2.2). Everything else (§2.2.2–2.2.9) then runs on these sides unchanged, so the new row is an ordinary `rowAdded` of the leaver, placed by the order rule. For the order checks the split row `R` counts as new on the keeper's side only, so `R` and the leaver's row form an insertion in the same place by both: an `OrderCheck` (matters on grouped and XY tables, columns, and — by §2.7 — paired tests; an unpaired column table combines by itself, every value kept). No conflict is made for such a row. Identical rows (same `rowKey`) are still one row. §9.1 and T10 change accordingly.

> **CHANGED BY fixer round 2 (finding RV-1):** **A row an earlier combine moved is matched by its new id.** After a split (M1), the computer whose entry moved (the leaver) still has it in `R` until the combined version reaches it; when it keeps typing there, the next combine's base is its own save (where `R` holds its entry), and the plain rules put its new values into the other computer's entry in `R`, without a question (or asked about `R` and stored its values under the other's title). Now, **before the M1 split**, for every row `R` of the base with data that at least one side changed (a missing row counts as changed), a row `X` is looked for that holds the base's row `R` under a new id; when found, `R` is renamed `X` in the base and in each side that does not have `X` (that side's later changes of `R` are then changes of `X`), and a side's own row `R` is an ordinary row it added (`rowAdded`, no order check). `X` is, in this order: **(1)** `splitIdOf(R, rowKey(base's row R), n)` for `n` = 0…3 (the plain id and the `"\n1"` … variants), not in the base and held by a side, when the side without it changed `R` (when both hold it: both changed `R`); else among the rows a side added right after its row `R` (up to its next row of the base) whose id has the form of an id the combine makes (`row-` + `LIMITS_P4.fillIdHex` hex digits) and that have data: **(2)** the first that reads exactly as the base's row `R` (`rowKey`), the other side having changed `R` — or, held by one side only, reads exactly as the other side's row `R` (not a row that still holds exactly what a split moved there, i.e. whose id is `splitIdOf(R, its own rowKey, n)`); when the two sides give different rows, none; **(3)** only when both sides changed `R` and both still have `R`: the row (not such an intact split row) with the largest gain `same(base R, X) + same(other side's R, X) − same(base R, side's R) − same(other side's R, side's R)` (`same` = places — title, X, cells by column id and replicate — with the same text that is not `""`; for a row both sides have: `same(base R, mine's X) + same(base R, theirs' X) − same(base R, mine's R) − same(base R, theirs' R)`), ids in plain string order, when that gain is `> 0` and only one row has it. When the largest gain is `≥ 0` but no single row wins and one of the rows that reach it is held by one side only, `R` is **unsure**: the row is one choice **as a whole** (as VUX-1: every value the sides have differently is in the `row` conflict), so two entries are never mixed and nothing is combined by itself. All of this looks at the sides only, never at which is mine or the first side, so both computers do the same; the result is the same bytes for the same pair, and re-combining a result with either side changes nothing (T7). The rows renamed on a side are reported as `TableMerge.rowNotes.moved` (`{id: X, was: R, side}`, display only, §5.2). What is left open: a chain in which the other computer changed the moved row so much that (3) can't tell it apart gives the whole-row choice above (no silent mixing, but either answer drops one entry's last changes); and when one computer deletes the other's moved row while the other keeps typing into it, nothing finds it (the plain rules apply).
>
> **CHANGED BY fixer round 2 (finding RV-3):** a row both typed into that is split counts, in `auto`, as a `rowAdded` of its keeper (`from` = the keeper) instead of its cells / title / X taken from the keeper; the leaver's new row stays a `rowAdded` of the leaver. The rows split are reported as `TableMerge.rowNotes.split` (the shared ids `R`, base order). `rowNotes` is left out when both lists are empty.

> **CHANGED BY fixer round 3 (findings RV2-1, RV2-2, RV2-4; the safety net).** Rule RV-1 above changes in four places, and a last rule is added. **(a) RV2-1, both sides hold `X`.** Three computers typed into one blank row; two of them each combined with the first one's version before seeing each other, so both moved its entry to the same `X` and each kept its own entry in `R`. Renaming the base's `R` to `X` made `R` a row "added by both" under one id, so the two new entries were combined place by place into one row without a question (or a whole-row choice that dropped one). Now, when **both sides hold** the `X` found (by any of (1)–(3)), nothing is renamed: the base gets `X`, with the content of its row `R`, right after `R`, and — when both sides changed `R` — the base's `R` itself is read as a row without data. The two entries in `R` are then two things typed into a blank row and are split by M1 (each its own row, an order check where order matters); `X` is combined against its own common version. Rule (1) with both holding `X` no longer needs both to have changed `R` (then only `X` is added to the base, `R` keeps its content), so that a later re-combine also finds `X`'s common version. **(b) RV2-2, the side without `X` already has the row `R` of the side holding `X`** — exactly the same `rowKey`, or more places in common with it than with the base's row `R` (`same` as in (3)). That side is a version that came from that combine and then lost `X` (the computer whose entry moved deleted it). Its `R` is not renamed: with `X` found by the hash, the base's `R` is still renamed `X`, so `X` is a row that side deleted; with `X` found by likeness ((2), (3)) nothing is renamed at all. Before, combining the result again with the version that still had `X` renamed the result's `R` to `X` and showed the other entry twice. **(c) RV2-4, in (3):** a row that still holds exactly what a split moved there (not a candidate before) is taken as well, but only when no other row is found (and nothing is unsure), when the side holding it has, in its own `R`, nothing in common with the base's row `R` (another entry is there), only the one side holds it, and it alone has the largest gain `> 0`; it never makes `R` unsure. **(d) The safety net** (`entryInQuestion` in `mergeTable.ts`), after all of the above, for every row both sides have outside padding and not split: never two people's new entries in one row. Places are the title, X (XY) and the cells of the columns both sides have (a column one side deleted is its own question). When both sides have data in the row and it differs, the row is **one choice as a whole** (as VUX-1; also its cells in a column only one side has: blank when the other side is chosen) when **(i)** the base's row has no data (and M1 did not split it), or **(ii)** the base has no such row and its id has the form of an id the combine makes, or the two rows have no value in common (same place, same text), or **(iii)** the base's row has **two or more** values, one of them its **label** (a grouped row's title, an XY row's X: what names an entry), and one side kept none of them (the label and every other non-empty place of the base's row are changed or empty on that side: possibly another entry under the same id) while the other side changed a place that side left as in the base, or changed a place that side changed too, to something else. (A base row without a label — any column-table row — or with one value is left to the plain rules: changing all its values is most likely fixing them, and two people fixing different values of a row still combine by themselves.) Two people fixing different values of an existing entry keep values in common with the base, and a side whose changes the other already has (a combined version combined again) changes nothing, so neither is caught. §8 T10 / T7 and the generated-table oracle (`mergeTable.props.test.ts`) follow this; `mergeTable.entities.test.ts` checks it over whole three-computer histories with every value tagged by its entry. **What is left open:** (1) combining a result again with the side that deleted a row an earlier combine had moved (or a side that holds such a row twice) can ask about that row or bring it back — nothing shows the move any more, and such a pair never meets in a real history (the result descends from that side); (2) a row of the base without a label (a column table) or with one value, that one side rewrote while the other side added or changed a value in it, is still combined place by place (it can't be told from fixing the values: if it was in fact another entry under the same id, which only an earlier combine can cause, two entries end up in one row — by itself, or after a choice of only the place both changed); (3) RV2-3: the order of rows (and so the ids of the blank rows a combine adds) can differ when a result is combined again with a side that reordered rows (no value changes; the order check is shown on the first combine).

#### 2.2.3 Cells, titles, X, single fields

For every kept row `r`, kept column `c` and `k < K`:

- both sides have the cell → the three-way rule (§2.1.2) on `cell(·, r, c, k)`;
- exactly one side has it (the other lacks the row or the column) → that side's text, no conflict;
- neither has it (the row is from one side, the column from the other) → `""`.

Row title and X value (XY tables only; `""` otherwise): the three-way rule per row id when both sides have the row (base not there → `""`), else the having side's. Column title: the same per col id. `x_title`: the three-way rule; conflict `table:field:x_title` (kind `tableField`).

**Conflicts are per row** (plan: "conflicts shown per row"): all cells, the row title and the X value of one row that conflict form **one** conflict `table:row:<row id>` (kind `row`); its `items` are the conflicting values (`what: "rowTitle"`, `"x"`, then `"cell"` in mine's column order — columns mine lacks after, in theirs' order — then replicate). One choice takes that side's text for every conflicting value of the row; the row's non-conflicting changes stay combined. A conflicting column title is its own conflict `table:coltitle:<col id>` (kind `colTitle`).

> **CHANGED BY fixer (finding VUX-1):** when a row's **title or X value** is among its conflicting values (outside padding), the row itself is in question, and the choice takes the **whole row**: every value of the row that both sides have and that differs between them (title, X, cells) is in the conflict's `items` and follows the choice — also the ones only one side changed. (Otherwise choosing "mine" for a dose stored the other computer's readings at my dose.) Rows whose title and X agree keep the rule above (non-conflicting changes stay combined); the dialog says how many such values are kept and, once everything is chosen, shows the row as it will be saved (§6.2).

A row or column that is itself in a `rowDeleted` / `colDeleted` conflict never has cell conflicts (only one side has it).

#### 2.2.4 Order — `mergeOrder(base, first, second, kept)`

Used for rows (the full `row_ids` lists) and for columns:

1. `R` = `first`'s ids that are in `kept`, in `first`'s order.
2. Walk `second`'s ids in order, with `anchor = none`. For each id `y` that is in `kept`: if `y` is already in `R` → `anchor = y`. Otherwise insert `y` into `R` at position `p` = just after `anchor` (the start when there is none), moved forward past every id that directly follows there and is **new on the first side only** (in `first`, not in `second`, not in `base`); then `anchor = y`.

So ids both sides share keep `first`'s order, and where both added rows in the same place, **the first side's come first, then the second side's**, each run in its own order. With `theirs = base` the result is `mine`'s order and vice versa (as long as the shared ids are in the same relative order on both sides, which every app version so far guarantees: there is no "move row").

**Order checks.** In the final list (after §2.2.5–6), take every maximal run of neighbouring ids that are each new on exactly one side (not in `base`, in exactly one of `first` / `second`). A run with at least one id from each side — for rows: at least one row **with data** from each side — gives one `OrderCheck {axis, ids: <the run>, matters}`. `matters`: columns → `true`; rows → `template !== "column"` (the composition in §2.7 also sets it for paired tests). If the ids both sides share are not in the same relative order on both sides, `first`'s order is used and one `OrderCheck {ids: [], matters: true}` is added for that axis.

#### 2.2.5 Trailing blank rows are padding

After the cells are combined: a row **has data** when its title, its X value or any of its cells is not blank (`graphModel.isBlank`). A side's **tail** is its maximal run of rows without data at the end.

A result row is **padding** when it has no data in the result, is not in the base or is in the base's tail, and is in the tail of every side that has it. Padding rows:

- never produce a conflict, an `auto` entry, a `combined` count or an order check (two computers each got a fresh blank row at the end — that is not two insertions);
- when one of them ends up **before the last result row with data** (the other side typed further down), it is moved to the very end, keeping the padding rows' relative order. Padding rows that are already after the last row with data stay where the order rule put them.

> **CHANGED BY impl:mergeTable:** (1) Padding that ends up above the last row with data is moved to **just after that row** (the moved rows in their relative order, ahead of the padding rows already below it), not to the very end. With "the very end", T7 fails: a side's blank row inserted above its own blank tail rows is moved past them, so combining the result again with that side (`merge(y, r, y)`) puts it back above them (found by the seeded T7 search; the changed rule passed 16 000 generated T7 cases). (2) Padding rows also take no part in the "shared ids in a different relative order" check of §2.2.4 (they never give an order check). (3) Which rows are padding is decided before choices from the sides alone (not in the base or in its tail, and in the tail of every side that has it); such a row has no data on any side, so it has none in the result either. Where its texts still differ on both sides (blanks that are not the same, e.g. `" "` against `""`), the first side's text is taken, without a conflict. (4) §2.2.9's "rows with data" is counted before choices: a row counts when it has data on whichever side is chosen at a place that differs (a superset of what any choice gives). (5) §2.2.7's order in full: columns added (result order), columns removed (base order), column titles (result order), the X title, the replicate count, then per row in result order its `rowAdded` and its title / X / cell entries, then rows removed (base order). Title / X / cell entries are counted only in rows and columns that are in the base and on both sides.

#### 2.2.6 The result is in pipeline form

In this order, after choices are applied:

1. `n_rep`: the three-way rule on the number; both changed it differently → the larger (never a conflict). Then `n_rep = max(that, 1 + the highest replicate index holding a non-blank result cell)`. When this step raised it, one adjustment `{section: "table", kind: "replicates", from: <three-way value>, to: <final>}` (plan: "larger wins unless values would be dropped" — no value is ever dropped by a replicate count). Column tables: always `1`.
2. Rows: when there are more than `MAX_ROWS` (500), rows without data are dropped from the end until it fits (if rows with data alone exceed it, §2.2.9 already made the table a whole choice).
3. When the last row has data and there are fewer than `MAX_ROWS` rows, one blank row is added; while there are fewer than `MIN_ROWS` (10), blank rows are added. **A row the combine adds gets the id** `"row-" + sha256Hex("las-fill\n" + <the result's row ids so far, joined with "\n">).slice(0, LIMITS_P4.fillIdHex)`; should that id already be in the list (never expected), hash again with `"\n1"`, `"\n2"`, … appended. No random id is ever made (`graphModel.ensureRows` would make random ones, and then two computers would not get the same bytes).
4. The object is exactly `{v: 2, template, col_titles, row_titles, x_title, n_rep, x, cells, row_ids, col_ids}` with `cells[row][col]` an array of `n_rep` strings and `x[i] = ""` on non-XY tables.

`normaliseSections` of a document holding this table must give back the same table text (T12).

#### 2.2.7 What is counted as combined automatically

One `FineAuto` (and `combined += 1`) for each: cell / row title / X / column title / `x_title` taken from one side or changed the same way by both (`before` = base text, `after` = result text); row or column added; row or column removed; `replicates` when the result's count differs from the base's. Padding rows and cells of added rows / columns are not counted separately. Order: columns, titles, then rows in result order.

> **CHANGED BY fixer round 2 (finding RV-3):** a row split by §2.2.2 (M1) is one `rowAdded` for each side ("Row added (mine)" / "Row added ({name})"), not cell entries.

#### 2.2.8 Order of `conflicts`

`colDeleted` (in the column order of the side that still has the column), `colTitle` (mine's column order), `tableField`, then `row` and `rowDeleted` in mine's row order, rows mine lacks after them in theirs' order.

> **CHANGED BY impl:mergeTable:** (clarification) `colDeleted` conflicts: first the columns mine still has (mine's order), then those theirs still has (theirs' order). While a choice is missing (`value: null`), `orderChecks` and `adjustments` are `[]`; `auto` / `combined` are then worked out with the undecided rows and columns counted as kept and the replicate count by the three-way rule.

#### 2.2.9 When the table is one whole choice

`whole: "table"`, `conflicts = [{id: "table:section", section: "table", kind: "section", reason: "table", options: ["mine", "theirs"], items: [], more: 0}]`, `combined: 0`, and `value` = that side's table as it is (`null` without a choice), when any of these holds — all decided before choices, so the dialog never changes shape while someone chooses:

- the three `template`s are not all the same;
- with every `colDeleted` conflict resolved as "removed" the result would have **no column**; or with every one resolved as "kept" it would have more than `MAX_COLS` (26);
- with every `rowDeleted` conflict resolved as "kept" there would be more than `MAX_ROWS` (500) rows with data.

### 2.3 Analysis settings — `mergeAnalysis(input, choices?)` (owner: mergeFields)

- Fields = the union of the own keys of the three objects, in sorted order. Each field except `pairs`: the three-way rule on its `canonicalJson` ("not there" is a value). Conflict `analysis:field:<key>` (kind `field`, one `FineItem {what: "field", field}`), options mine / theirs.
- **`pairs` as a set** (plan). A pair's key is its two ids in plain string order joined with `"|"`, so `[a, b]` and `[b, a]` are the same pair. When `pairs` is the same list (`canonicalJson`) on two of the three sides, the plain three-way rule applies to the whole list (so an unchanged side never reorders anything). Otherwise the result set is `(mine ∩ theirs) ∪ (mine − base) ∪ (theirs − base)`: what either side removed is gone, what either side added is there. Order: the base's pairs that remain, in the base's order and orientation; then the added ones sorted by key, each as the side that added it wrote it (both added it → the one whose `canonicalJson` is smaller). **Never a conflict.** One `auto` entry `{what: "field", field: "pairs"}`.
- The result object has every field whose result value is there. `control` and the ids inside `pairs` are **not** checked against the table here: a control or pair pointing at a row / column the combined table no longer has is dropped by the pipeline afterwards and shows up as an automatic adjustment (§2.6), as in phase 2.
- `conflicts` in sorted key order; no order checks; no adjustments of its own.

> **CHANGED BY impl:mergeFields:** (1) In the set rule for `pairs`, a base pair that remains is written as a side that **turned it round** has it (`[b, a]` for the base's `[a, b]`; both turned it → that way, since there are only two; neither → the base's), still in the base's order. With "the base's orientation" alone, property T7 fails: mine turns one pair round, theirs another, the set result equals the base, and combining that result again with mine gives mine's list (the plain rule), not the result. (2) The `pairs` auto entry is left out when the set result equals the base's list; its `from` is `"mine"` / `"theirs"` when the result is exactly that side's list, else `"same"` (shown as "(both)").

### 2.4 Graph settings — `mergeFigure(input, choices?)` (owner: mergeFields)

`colIds` = the result table's column ids in order (`null` → `value: null`; conflicts are still returned, they do not depend on it).

- **Atomic groups** (`FIGURE_GROUPS` in contract.ts): a group is compared and taken as one value.
  - `colours`: `palette`, `palette_colors`, `palette_reverse`, `palette_edited`, `axis_scheme`, **and the colour of every column both sides have** (`C` = the ids that are keys of both `mine.series` and `theirs.series`, sorted; the base's colour of such a column is "not there" when the base lacks it). A column only one side has does not take part: adding or deleting a column does not count as changing the colours.
  - `size`: `width`, `height`, `dpi`.
  - `yRange`: `y_min`, `y_max`.

  The group's value on a side = `canonicalJson` of its members in the listed order (colours: then the colours of `C` in order; "not there" as `null`). The three-way rule on that value; conflict `figure:group:<group>` (kind `group`; `items` = one `{what: "field", field}` per member that differs between mine and theirs, and one `{what: "seriesColor", colId}` per differing colour). Taking a side = all the group's fields as that side has them (a field that side lacks is left out) and, for `colours`, that side's colour for every column in `C`.
- **Legend labels**: `series[c].label` per column in `C`, the three-way rule (base not there → `""`); conflict `figure:label:<col id>` (kind `seriesLabel`).
- **Every other top-level field** except `series` (including fields this app does not know): the three-way rule on its `canonicalJson`; conflict `figure:field:<key>` (kind `field`).
- **`series` of the result**: one `{color, label}` per id of `colIds`, in that order. For a column in `C`: as decided above. For a column only one side's `series` has: that side's entry. For a column neither has (not expected): `{color: "", label: ""}`. Entries for columns that are not in `colIds` are left out — a colour or label somebody gave to a column the combined table no longer has goes with the column; that is not a conflict and not an adjustment.
- `auto`: one entry per group / field / label taken from one side or changed alike by both. `conflicts` order: groups (`colours`, `size`, `yRange`), fields in sorted key order, labels in sorted id order.

> **CHANGED BY impl:mergeFields:** `C` for the **colours group** leaves out a column the base lacks when mine and theirs give it **the same colour** (it still gets that colour; labels still use all of `C`). Such a column arises when a combined version is combined again (T7: `merge(b, r, y)` where `r` holds a column `y` added); with its base colour "not there" it made both sides look changed, so a combine that has nothing to decide asked about the colours. A column the base lacks with different colours on the two sides stays in the group as written.

### 2.5 Scratchpad — `mergeScratch(input, choices?)` (owner: mergeFields)

Sides are the section in file form: a canonical `ScratchDoc` object or `null` (= no cells, no widths).

#### 2.5.1 Cells by address

Value of a cell = the pair `[input, numFmt or ""]`; "not there" when the address has no cell. For every address in any side: the three-way rule on the pair. Conflict `scratchpad:cell:<A1>` (kind `cell`, with `addr`, `row`, `col`; `items`: `{what: "scratch", addr}` with the three inputs, plus `{what: "scratchFormat", addr}` when the formats differ). Options mine / theirs. `conflicts` in row-major order.

Column widths (`cols`): the three-way rule per column number; both changed one differently → the larger width (never a conflict). `auto`: `{what: "scratch", addr}` per cell, `{what: "colWidth", field: <column letter>}` per width.

`value` = `JSON.parse(canonScratch({cells, cols}))`, or `null` when that text is `""` — exactly what `sanitizeScratch` gives back, so the pipeline changes nothing.

> **CHANGED BY impl:mergeFields:** (1) The `scratchFormat` item is added when `numFmt or ""` differs, a missing cell counting as `""` (so "cleared on one side" does not add an empty format line). (2) `mergeScratch` itself runs the shift check only when mine, theirs and the base are three different sheets (§9.7), so `merge(b, x, b)` = `x` also for a rearranged `x` (T1 / T2 on the module).

#### 2.5.2 The shift check — `shiftCheck(base, side)`

Addresses compare **inputs only** (formats ignored). `nB` = number of base cells; `changed` = the base addresses whose input on `side` is different or gone.

- **Rule A (much changed):** `nB ≥ LIMITS_P4.shiftMinBaseCells` (10) and `changed.length > LIMITS_P4.shiftChangedShare × nB` (30 %).
- **Rule B (content moved):** `changed.length ≥ LIMITS_P4.shiftOffsetMinCells` (5) and there is an offset `(dr, dc) ≠ (0, 0)` for which at least `max(5, ceil(LIMITS_P4.shiftOffsetShare × changed.length))` of the changed addresses `a` satisfy: `side[a + offset]` has the input `base[a]`, and `base[a + offset]` does not have that input. Offsets are collected per changed cell from the `side` cells holding the same input, at most `LIMITS_P4.shiftSameInputCap` (50) per cell, in row-major order.

> **CHANGED BY fixer (finding M2):** a row inserted or deleted near the end of a block moves only the few cells below it (formulas that move read the same at their new place, so they do not count as changed), which rule B with 5 cells missed — the other side's cells were then combined by address next to different data, or a formula pointed at the wrong row. Now: **rule B** needs `changed.length ≥ 2` and an offset with at least `max(2, ceil(LIMITS_P4.shiftOffsetShare × counted))` moved cells, where `counted` = the changed addresses minus base **formulas that are simply gone** on the side (the edge rows of an insert / delete). `LIMITS_P4.shiftOffsetMinCells` (contract.ts, read-only) is no longer used; the 2 is `SHIFT_MOVED_MIN` in `mergeScratch.ts`. **Rule C** (in `mergeScratch`, it needs both sides): a side `S` moved content out of a place it emptied (a changed base cell `a` with no cell at `a` on `S` whose input stands on `S` at `a + offset` where the base had something else — even a single cell), and the other side changed or added a cell at one of `S`'s changed addresses or at such an `a + offset`, or wrote a formula whose cells, ranges or whole columns cover one of them → `shift: true` (the whole choice). An edit that keeps its cell (a value changed in place) is never moved content. X3's "4 moved → false" becomes "4 moved → true, 1 moved → false".

`mergeScratch` runs the check on mine and on theirs. If either is `true`: `shift: true`, and the section is one whole choice — `conflicts = [{id: "scratchpad:section", section: "scratchpad", kind: "section", reason: "shift", options: ["mine", "theirs", "both"], items: [], more: 0}]` (without `"both"` when it does not fit, §2.5.4), `combined: 0`.

> **CHANGED BY impl:mergeFields:** imports from `scratchModel` also include `DEFAULT_COL_WIDTH` (a width that is not stored is the default one, for "the larger width") and `SCRATCH_INPUT_MAX` (below).

#### 2.5.3 Choices for the shift conflict

`mine` → mine's object; `theirs` → theirs' object; `both` → `sideBySide(mine, theirs)`.

#### 2.5.4 "Both side by side" — `sideBySide(mine, theirs)`

Mine stays where it is; theirs is placed **to the right of mine**, rows unchanged:

- `d` = (the highest column number of any mine cell) + `LIMITS_P4.bothGapCols` (1), so one blank column lies between the two. `d = 0` when mine has no cell.
- Every theirs cell `[r, c, input, fmt]` becomes `[r, c + d, shiftFormula(input, d), fmt]`; every theirs width moves to column `c + d`. Mine's cells and widths are kept as they are.
- `null` (and `"both"` is then left out of `options`) when any moved cell or any shifted reference would lie beyond column `SCRATCH_COLS` (300).

`shiftFormula(input, d)`: text that does not start with `=` is returned unchanged. In a formula, outside double-quoted strings (`"…"`, `""` = a quote inside), every cell reference `[$]<letters 1–3>[$]<digits 1–5>` and every whole-column reference `[$]<letters>:[$]<letters>` has its column letters moved `d` columns to the right — absolute (`$`) ones too, because the whole sheet moved. A token counts as a reference only when it is not preceded by a letter, digit, `_` or `.` and not followed by a letter, digit, `_` or `(` (so `LOG10(` and names are left alone); a sheet prefix (`Sheet1!`) is kept. Whole-row references (`3:5`) are unchanged. `null` when a column would pass `SCRATCH_COLS`.

> **CHANGED BY impl:mergeFields:** refinements of §2.5.4 that keep the result in pipeline form and keep formulas intact: `shiftFormula` also leaves a quoted sheet name (`'…'`, `''` = a quote inside) alone, keeps a lower-case reference lower-case, and treats a token whose row is `0` or past `SCRATCH_ROWS` as a name (left as typed). `sideBySide` returns `null` also when a moved input would be longer than `SCRATCH_INPUT_MAX` (sanitizeScratch would cut it); a **width** of theirs that would land past column 300 is left out instead of making it `null` (a width holds no value), and where a width of theirs lands on a column mine has a width for, mine's is kept.

### 2.6 Automatic adjustments — `detectAdjustments(p)` (owner: mergeFields)

`p.assembled` = the four sections as put together, before the pipeline; `p.result` = `normaliseSections(assembled)`; `p.mine` / `p.theirs` = the normalised sides. Returns, in this order, at most `LIMITS_P4.adjustments` entries:

1. **Stored form** (what `normalizeAnalysis` through `normalizeSettings`, the id map and `resizeSeries` change): for `analysis` and `figure`, every top-level field (and every `series.<col id>` entry) whose `canonicalJson` differs between `assembled[k]` and `result.sections[k]` → `{section: k, kind: "setting", field, from, to}` (short texts). For `table` / `scratchpad`: when the section's canonical text differs → `{section, kind: "table" | "scratchpad", from: null, to: null}`.
2. **The plot request** (`effectiveAnalysis(content.analysis, toNumericTable(content.doc))`, for the result and for both sides):
   - *hidden test*: the stored `test` is not `"none"` but the effective one is. Reported as `{section: "analysis", kind: "testNotRun", field: "test", from: <stored test>, to: "none"}` when it holds for the result and **not for both** mine and theirs (if both sides already had a test that could not run, nothing new happened).
   - *dropped comparisons*: the effective `control` is `null` while the stored one is not, or the effective `pairs` are fewer than the stored ones (not counted on a column table with a two-group test, where the pair is always worked out from the data). Reported as `{section: "analysis", kind: "comparisons", field: "control" | "pairs", from, to}` under the same "not for both sides" rule.

The table's own `replicates` adjustment (§2.2.6) is added by the composition, in front.

**Any adjustment forces a review**: `autoApplicable` is `false`, the dialog (or the `review` banner) is shown, and the list is under "Adjusted automatically" (§6.4).

### 2.7 Composition — `graphMerge.ts` (owner: session)

`combine` and `applyChoices` **stay exactly as they are** (the section-level rules of phase 2). They are what an older app computes; the tests use them to play an exp-0.2.25 computer, and `rebaseOnto` keeps using them (§9.6).

#### 2.7.1 `combineFine({base, baseKind, mine, theirs, mineKey, theirsKey})`

1. `M`, `T`, `B` and `baseKind` as `combine` steps 1–2 (`unreadable`, two-way).
2. Section `status` and `pick` by hashes, exactly as `combine` step 3.
3. For every section with status `both`:
   - **two-way** (`B == null`) → `level: "whole"`, `conflicts = [{id: "<k>:section", section: k, kind: "section", reason: "twoWay", options: ["mine", "theirs"], items: [], more: 0}]`;
   - `table` → `mergeTable({base, mine, theirs (the three table sections), mineKey, theirsKey})`; `whole` set → `level: "whole"`, else `"fine"`;
   - `analysis` → `mergeAnalysis`; `figure` → `mergeFigure` (with `colIds: null` at this point); `scratchpad` → `mergeScratch` (`shift` → `level: "whole"`, else `"fine"`).

   Every other section: `level: "whole"`, `conflicts: []`, `combined: 0`, `auto: []`, `orderChecks: []`. A `both` section's `conflicts`, `combined`, `auto`, `orderChecks` are the module's (called without choices).
4. `autoResolvable = conflicts.length === 0`. Plan: `needsChoice` = any section has a conflict; `level` = `"fine"` when any section is `both`, else `"section"`.
5. `needsChoice` false → `result = applyFineChoices(plan, {})`.
6. `autoApplicable = baseKind === "lca" && !needsChoice && result != null && result.repairs.length === 0 && result.adjustments.length === 0 && !result.orderChecks.some((o) => o.matters)`.

When `plan.level === "section"`, `result` (content, parts, `from`, `repairs`) is **byte for byte** what `combine` gives for the same input, and `autoApplicable` is never `true` where `combine`'s is `false` (G2).

#### 2.7.2 `applyFineChoices(plan, choices)`

For each section `k`, in the order table, analysis, figure, scratchpad:

1. `choices.sections?.[k]` is `mine` / `theirs` → that side's normalised section, whole (whatever its status or conflicts).
2. else status is not `both` → the `pick` side's section.
3. else `level: "whole"` → `choices.fine["<k>:section"]`: `mine` / `theirs` → that side's section; `both` (scratchpad shift only) → `sideBySide(mine, theirs)`; no valid choice → return `null`.
4. else (`fine`) → the module again with `choices.fine` (figure: `colIds` = the column ids of the table decided in this call); `value == null` → return `null`.

Then `re = normaliseSections(assembled)`; `null` → `null`. Result (`CombineResultP4`):

- `content`, `sections`, `parts` from `re`;
- `repairs` = sections where `re`'s hash differs from the SHA-256 of `canonicalJson(assembled[k])` (for whole sections this is the phase 2 definition);
- `adjustments` = the table module's own + `detectAdjustments({assembled, result: re, mine: plan.mine, theirs: plan.theirs})`;
- `orderChecks` = those of the fine modules whose value was used; row checks get `matters: true` as well when `re.content.analysis.test` is `"paired_t"` or `"wilcoxon"`;
- `from[k]`: `"same"` for status `same`; otherwise by the result's hash — equal to mine's → `"mine"`, equal to theirs' → `"theirs"`, neither → `"mine"` **and `k` is listed in `mixed`**.

> **CHANGED BY impl:session:** (1) `from[k]` of a section that is taken **as a whole** from one side (status `mine` / `theirs`, a whole-section choice `choices.sections[k]`, or a `section` conflict chosen `mine` / `theirs`) is that side, exactly as phase 2 `applyChoices` does; the hash rule (and `mixed`) applies only to a section that was combined inside (a module's value, or "Both side by side"). With the hash rule for whole sections a repaired section could come out `"theirs"` or land in `mixed` where `combine` says `"mine"`, which breaks "byte for byte what `combine` gives" (G2 compares `from` too). (2) `repairs` uses `canonicalJson(assembled[k] ?? null)` (an empty scratchpad is `null`). (3) Row order checks are reported on the table section's `orderChecks` in the dialog state (the only module that makes them).

#### 2.7.3 `combineRevision` and `peersCombineAlike`

`combineRevision` is the phase 2 function with one addition: unless `legacy: true`, the revision gets `combine_v: COMBINE_V` (also in the automatic form — a constant, so two computers still build the same object). Id formula, parents, `time`, blank author fields, `summary`, `sections_from` (left out for a section whose result matches neither parent, i.e. every `mixed` section) are unchanged.

`peersCombineAlike(mine, theirs)` = `mine.combine_v === COMBINE_V && theirs.combine_v === COMBINE_V` (read from the revision objects as stored).

---

## 3. One result per pair: determinism and mixed app versions

### 3.1 The same bytes on every computer

For the same pair of versions and the same base, `combineFine` gives the same `result.parts` (all four canonical texts and the content hash) on every computer and whichever of the two is called "mine". This rests on:

- **canonical text**: every section is stored through `format.canonicalJson` (sorted keys, no whitespace); the content hash is the phase 1 one;
- **no local input**: no clock, no random id (§2.2.6 step 3), no user or computer name, no locale-dependent comparison (plain `<` on strings everywhere, never `localeCompare`), no dependence on the key order of an input object (iterate sorted keys, or ids in list order);
- **the order rule** uses `SideKey` = the `device_id` and `id` of each side's *revision*. Both computers read the same two revisions, so both name the same side `first`. The computer that happens to do the combining never enters;
- **the base** is the one `findBase` rule; an automatic combine needs `baseKind: "lca"`, so both computers compare against the same version.

### 3.2 The id is unchanged — and why the rules' version is not in it

`id = "r-m-" + sha256(sortedParents.join("\n") + "\n" + content_hash).slice(0, 26)` (phase 2 §3.4.3), for every combine, fine or not. The version of the rules (`COMBINE_V`) is deliberately **not** part of the id: two computers that reach the same content must get the same id (that is what makes a double write harmless), and two that reach different content already get different ids through `content_hash`. Putting the rules' version in would only split identical results — in particular the whole-section results an older app and this build both compute. It also keeps one formula across phases 1–4.

### 3.3 The mixed-version rule

Every version this build makes carries `combine_v: COMBINE_V` (§5.6). A combine **nobody asked for** (phase 2 §5.4.1: clean tab, device-ordered delay) is written only when

```
plan.autoApplicable && (plan.level === "section" || peersCombineAlike(mineRev, theirsRev))
```

Otherwise nothing is written by itself: the tab gets the banner `savedOver {state: "review"}` when there is nothing to choose (one click combines), or `{state: "choose"}` when there is (§4.2).

Why this gives at most one automatic result per pair:

- **Against exp-0.2.21 … 0.2.25** (section-level): such an app combines by itself only when no section is `both`. In exactly that case this build computes the same bytes (§2.7.1, G2), hence the same id. When a section is `both`, the older app never writes by itself (it shows "Choose what to keep"), so this build's fine result is the only automatic one — and it is written unprompted only if both versions of the pair were made by a phase 4 app.
- **Against a later build whose rules differ** (`COMBINE_V` 2): one of the two versions lacks this build's number → neither build writes a fine combine by itself for that pair.
- **Between two builds with the same `COMBINE_V`**: same bytes, same id; the device-ordered delay and the re-check make a double write rare, the id makes it harmless.

A combine the person started (Save with unsaved changes, a banner button, the dialog) is **not** held back by `peersCombineAlike`: with unsaved changes my side exists on this computer only, and after a click the person is looking. It is written at once when `plan.autoApplicable`, as in phase 2.

What the rule cannot know is the app version of a *third* computer that merely has one of the two versions open. There the phase 2 net holds: delay, re-check, and — if two different combined versions of one pair ever exist — `findBase` answers `ambiguous` for them, which never combines by itself, so a person looks. Nothing is lost in any of these cases.

### 3.4 Scenarios (P3 = exp-0.2.21 … 0.2.25, P4 = this build)

| # | situation | P4 computer | P3 computer | versions written for the pair |
|---|---|---|---|---|
| 1 | Two computers changed **different sections**; one save replaced the other (clean tabs) | the whole-section result, after its delay unless the result is already there | the same result, same id | one (same id from both; the two entries differ only by `combine_v`; entries are matched by id) |
| 2 | **Same section, different cells**; the P4 computer's save was replaced by the P3 computer's | fine plan, nothing to choose, but theirs has no `combine_v` → banner `review`: "…both sets of changes can be combined." **Combine** → one click writes it | it is on the newest version; sees the combined version arrive as a newer one | one, after a click |
| 3 | Same section, different cells; the P3 computer's save was replaced by the P4 computer's | on the newest version; nothing to do | the section is `both` → "Choose what to keep" → whole-section Mine / Theirs (as today). The side not chosen stays in the history. | one, chosen on P3 |
| 4 | P4 has **unsaved** changes, P3 saved a newer version (same section, different cells) | Save (or "Combine my changes with it") → fine combine at once, banner `combined` | reloads | one |
| 5 | P3 has unsaved changes, P4 saved a newer version, same section | reloads later | Save → the phase 2 dialog, whole section | one, chosen |
| 6 | Two or three **P4** computers, same section, different cells, a save was replaced | every clean computer that has the replaced version waits its delay; the first writes, the others find it at the re-check; a forced double write → same id | — | one |
| 7 | As 6, but the same cell on both | banner `choose` → the dialog with one row to choose | — | one per choice made (as phase 2) |
| 8 | P4 and a later build with other rules | no unprompted fine combine on either (numbers differ) → `review` / `choose` | — | at most one, after a click |
| 9 | A P3 app opens, edits and saves a file holding P4 versions | — | `combine_v` is an unknown field of a revision and is carried along unchanged (phase 2 §1.3); nothing else is new in the file. An automatic fine combine is listed as "Combined" with a blank author; its `sections_from` simply lacks the combined-inside section. | — |
| 10 | A P4 app opens a file last saved by P3 | opens and saves as always; versions without `combine_v` are older-app versions | — | — |

### 3.5 No format break

`format_version`, `min_reader_version`, `features` (2), the parts, the manifest fields and the id formula are unchanged. The only addition to a file is the optional revision field `combine_v`. `format.ts`, `docCodec.ts`, `idMap.ts` are read-only for everyone.

---

## 4. When a combine is applied without asking (D8)

### 4.1 The rule

A combine may be written without the dialog only when **nothing conflicts and nothing was adjusted**:

`plan.autoApplicable` (§2.7.1 step 6) = the true lowest common version is the base (`lca`) · no conflict in any section · a result exists · the pipeline changed no section · no automatic adjustment (§2.6) · no order check that matters.

Everything else shows the dialog (or a banner leading to it), with every non-conflicting change already combined and listed under "Combined automatically".

The stored form: `auto` is `true` exactly when the plan was `autoApplicable` and nobody changed a choice (phase 2 §3.4.4) — then the revision has blank author fields, `summary: SUMMARY.combinedAuto` ("Combined changes from two computers") and `combine_v`. Any choice → the chooser is the author, `SUMMARY.combinedChosen`.

### 4.2 How each entry behaves

| entry (phase 2 §5.5) | plan is `autoApplicable` | it is not |
|---|---|---|
| **Save** with unsaved changes (conflict head) · **Combine my changes with it** · **Combine…** on an extra copy · the button of a `savedOver` banner | written at once, no delay (unchanged) | the dialog |
| **Nobody asked** (clean tab; another computer's save replaced mine, or a saved copy of mine was replaced) | §3.3 holds → banner `savedOver {state: "combining"}`, device-ordered delay, re-check, write (all unchanged). §3.3 fails (a version without `combine_v`) → banner `savedOver {state: "review"}`, nothing written. | no conflict (something adjusted, an order to check, base not `lca`) → `savedOver {state: "review"}`; a conflict → `savedOver {state: "choose"}`. Nothing written. |

`review` and `choose` both carry the action `combine` → `startCombine`, which writes at once when the plan is `autoApplicable` and opens the dialog otherwise.

> **CHANGED BY fixer (finding VUX-9):** the `review` banner is **not dismissible** (`choose` stays as it is). Closed, it left the tab reading "All changes saved" while the file held the other computer's version without my save.

### 4.3 Two-way

No common version with content (`baseKind: "none"`): no fine-level comparison. Every differing section is one whole choice with the plan's wording (§6.3): **"These two copies were last the same too long ago to compare cell by cell. Keep: [Mine] [Bob's] [Both as separate files]"**. "Both as separate files" is `keepBothAsSeparate()`. Never automatic.

`ambiguous` / `nearest` bases: the fine comparison is done against that base and shown, never applied without the dialog (unchanged from phase 2 §3.2).

### 4.4 Unchanged from phase 2

The base rule and where content is looked for (both files, the local journal, the newest saved copies), `combineDelayMs`, the re-check before an unprompted write ("the head descends from both parents → no write"), what cancels the timer, `combine_pending`, the routing tables, the queue of copies, `survivorPath`, retention with both parents and the base pinned, and the rule that my working copy is journaled before anything is shown.

---

## 5. The session controller (owner: session)

`useFileSession` becomes `create<FileSessionStateP4>`. The changes are deliberately small: the combine procedure calls the fine merge, and the dialog state holds per-conflict choices.

### 5.1 The procedure (phase 2 §5.4), what changes

- **Step 4** (`prepareCombine`): `combineFine({…, mineKey: {deviceId: mineRev.device_id, revisionId: mineRev.id}, theirsKey: {deviceId: theirsRev.device_id, revisionId: theirsRev.id}})` instead of `combine`. `ok: false` → the phase 1 fallback, unchanged.
- **The context's choices** become `CombineChoices` (`{sections, fine}`), empty at the start.
- **Steps 5 / 6**: as §4.2.
- **Step 7.1** (the tab changed since my side was put together — rebuild and compare): the person looks again (dialog, nothing written) when a section's status changed, **or the set of conflict ids changed**, or the write was going to be without the dialog and the new plan is no longer `autoApplicable`, or a conflict somebody chose for is no longer the same (`canonicalJson` of the `FineConflict`), or (as before) a section with a whole-section choice changed on either side. Choices are carried over for conflicts that are still the same.

> **CHANGED BY fixer (findings VS-1, VS-2, VUX-6):** (1) also when, for a write through the dialog (not automatic), the result's adjustments, repairs or order checks that matter (`canonicalJson`) differ between the context the person looked at and the rebuilt one with the carried choices — an adjustment that appears after the person looked is shown before it is written. (2) When Apply brings the dialog back this way, its `error` line says why: "A newer version arrived. Nothing was saved yet — please check again." (the other side moved on) or "Your document changed meanwhile. Nothing was saved yet — please check again." (typing). (3) After a write, the tab's combine context is cleared also when 7.1 replaced it with the rebuilt one (it stayed set, and the tab then ignored every later version).
- **Step 7.2**: `applyFineChoices(plan, choices)`.
- **Step 7.4**: `combineRevision` (now with `combine_v`).
- **§5.4.2 after the save**: banner `combined {version, sections, mixed}` with `sections` = sections whose `from` is `"theirs"`, `mixed` = `result.mixed`. Everything else (base, `replaceContent` with the one labelled undo step, toast, queue, `undoCombine`) unchanged.
- `rebaseOnto` (typing during the write) keeps the section-level `combine` (§9.6).

### 5.2 Dialog state — `CombineStateP4`

`dialog = {kind: "combine", state}` where `state` is always a `CombineStateP4` (the union member's declared type stays `CombineState`; the UI reads it as `CombineStateP4`).

- `sections[k]`: the phase 2 fields (`key`, `status`, `choice` = `choices.sections[k] ?? pick`, so `null` for a `both` section without a whole-section choice) plus `level`, `conflicts`, `choices` (this section's entries of `choices.fine`), `left` (conflicts without a valid choice; `0` when `choices.sections[k]` is set), `combined`, `auto`, `orderChecks` (of the current result; `[]` while a choice is missing).
- `result = applyFineChoices(plan, choices)` whenever no conflict is left; `adjusted` = `result.repairs` (phase 2 field, kept), `adjustments` = `result.adjustments`, `resultContent` = `result.content`, `canApply` = `result != null`.
- `toChoose` = the sum of `left`; `combinedCount` = the sum of `combined` over fine sections + 1 for every whole section with status `mine` / `theirs`.
- `compare`, `mineContent`, `theirsContent`, `since`, `twoWay`, `index` / `total`: unchanged.

> **CHANGED BY fixer round 2 (findings RV-1, RV-3):** the table's `sections[k].rowNotes` (= the plan's `CombineSectionP4.rowNotes`, from `TableMerge.rowNotes`; `contract.ts` additive, `TableRowNotes`) is set when it is not empty. Then, for display only: in `mineContent` / `theirsContent` a row of `rowNotes.moved` is shown under its new id on the side that still has the old one, and `compare` compares the tables that way, with each split row (`rowNotes.split`) compared as a row added on each side (no changed cells in it). The plan, the result and what is written are not affected. (finding RV-2) When Apply is refused because the tab became read-only while the dialog was open, the dialog's `error` line says "Another computer is editing this file. Nothing was saved — try again in a moment." (`APPLY_READ_ONLY` in `session.ts`); the read-only notice was behind the dialog and toasts are hidden while it is open.

### 5.3 Actions

| action | does |
|---|---|
| `setConflictChoice(id, choice)` | stores `choices.fine[id]` (ignored when `choice` is not among the conflict's `options`); removes a whole-section choice of that conflict's section; rebuilds the state. Nothing is written. |
| `setAllInSection(section, side)` | sets `choices.fine[id] = side` for **every conflict of the section** (also those beyond what the dialog draws) and removes a whole-section choice of it. The section's automatically combined changes stay. |
| `setSectionChoice(section, side)` (phase 2, kept) | stores `choices.sections[section]`: the whole section from that side. The UI offers it only for sections without conflicts (to turn round an automatic pick, as in phase 2); it keeps working for any section, which is what the phase 2 tests use. |
| `applyCombine`, `cancelCombine`, `keepBothAsSeparate`, `startCombine`, `undoCombine`, `showWhatChanged` | unchanged |

> **CHANGED BY fixer (findings VUX-3, VUX-4):** (1) `cancelCombine` (Esc, Cancel) keeps the choices made; when the dialog opens again for the same version of the other side, choices are carried for the conflicts that are still the same (`carryChoices`). A click beside the window no longer closes it. (2) New action **`setRestInSection(section, side)`** — "Use mine / {theirs} for the rest": that side for every conflict of the section **without** a choice (also those not drawn); the choices already made stay. `contract.ts` is read-only, so it is on the store as `useFileSession.dialogExtras.setRestInSection` (typed in `session.ts`'s `FileSessionStore`), not on `FileSessionStateP4`. The UI shows the two buttons next to "Use … for all" when some, but not all, conflicts of the part have a choice.

### 5.4 Banners and summaries

- `savedOver {state: "review"}` (new): actions `["combine"]`, dismissible like `choose`. Used as §4.2 says. `bannerAction` routes `combine` as for `choose`.
- `combined`: gains `mixed`. Its buttons, the undo label ("Undo: combine with {who}'s changes") and the toast are unchanged.
- **Stored summaries are unchanged**: `SUMMARY.combinedAuto` / `SUMMARY.combinedChosen`. `summaries.ts` is not changed: the Versions panel shows a fine combine like any combined version (chip *Combined*, "Combined automatically · {when}" for the automatic form), and **What changed** / **Compare with current** already compare cell by cell.

### 5.5 Read-only tabs (phase 3 §5.5, §5.8) — unchanged

A read-only tab never writes a combine: `startCombine`, `applyCombine` and the unprompted combine refuse or wait exactly as today (`reason: "readOnly"`; the unprompted one stays pending and is looked at again when the guard clears).

> **CHANGED BY fixer (finding VS-3):** before an unprompted combine parks on a read-only tab, the file is read once more: when its head already descends from both versions (somebody wrote the combine) or is no longer the one expected, the waiting combine is called off and the tab is brought up to date at once (read-only tabs show newer versions) instead of staying on the old version until the guard clears. A tab with unsaved changes is never read-only, so combining on Save and the dialog work the same while `bothEditing`. `setConflictChoice` / `setAllInSection` only change dialog state and need no guard of their own.

### 5.6 `combine_v` on everything this build writes

Every revision object the controller creates gets `combine_v: COMBINE_V`: saves, the working copy `W`, brought-back versions, the first version of a new file / Save As / separated analysis, and combines (through `combineRevision`). `docCodec.ts` is read-only, so the controller adds the field to what `makeRevision` / `buildNewFile` / `buildNextFile` return (a revision's id and `content_hash` never depend on its other fields). Revisions already in a manifest are never rebuilt (phase 2 §1.3), so older ones stay without it.

### 5.7 Playing an older app in tests

`SessionDeps` gains `combineLevel?: "fine" | "section"` (default `"fine"`). With `"section"` the controller behaves like exp-0.2.25: it calls `combine` / `applyChoices`, writes no `combine_v` (`combineRevision({legacy: true})`), and applies the phase 2 rule for unprompted combines. Production code never sets it. `devSim.setOldApp(true)` makes the simulated other computer's saves carry no `combine_v` (in addition to what it does in phase 3).

> **CHANGED BY impl:session:** (1) With `combineLevel: "section"` the controller wraps the phase 2 plan in the `CombinePlanP4` form (`level: "section"`, every section `level: "whole"`, `conflicts: []`, `combined: 0`); in the dialog state such a `both` section without a whole-section choice counts `left: 1`, so `toChoose` / `canApply` behave as in phase 2. (2) The fallbacks of an unprompted combine that was already waiting (the tab got unsaved changes during the delay, the file could not be read at the re-check, the write failed), and the paths that never had a plan (a replaced save found by the journal check with unsaved changes), keep the phase 2 `choose` banner; `review` is used exactly where §4.2 says (a plan with nothing to choose that is not written by itself). (3) G2's "pairs that changed different sections" are pairs whose **normalised** statuses have no `both`: an edit of one section can change another one through the load pipeline (a table edit that changes which tests can run), and such a pair is a fine plan; the test skips it.

### 5.8 Other files session changes

- `graphMerge.ts`: §2.7 (plus tests).
- `devSim.ts`, `previewBackend.ts`, `memoryBackend.ts`: the simulator edits of §6.7 (`DevSimApiP4`); the simulated computers' saves carry `combine_v` unless "older app".
- `testkit.ts`: helpers for the new tests (edit a given cell, add / insert / delete a row, delete a column, set the Y range, set scratchpad cells).
- `e2e.ts`: phase `"combineFine"` (§8 E-tests).
- `graphStore.ts`: no change expected (`replaceContent` already takes the whole content).

**While the pure modules do not exist**, session builds against scratch-only stand-ins `mergeTable.ts`, `mergeFields.ts`, `mergeScratch.ts` that satisfy the contract.ts interfaces for the simple cases its tests use (one cell each in different rows, the same cell, an added row, a deleted column, the Y range, scratchpad cells, a shifted scratchpad), and does **not** copy them to the repo. session's tests assert only behaviour this document defines, so they pass with the real modules. Likewise **ui** builds against a scratch-only stub of `session.ts` typed `FileSessionStateP4`.

---

## 6. UI (owner: ui)

Everything in `src/components/graph/files-ui/`. The UI calls only `useFileSession` (now `FileSessionStateP4`) and `devSim()` (`DevSimApiP4`); it does not import the merge modules. Texts live in `files-ui/text.ts`. `{theirs}` below is the existing short name of the other side ("Alice's"; "Theirs" when no name is known; the own-replaced-save wording of phase 2 keeps its "In the file now" / "Your save").

### 6.1 The dialog's frame (changes to phase 2 §6.4)

- **Header**: title, "Mine: …" / "Theirs: …" and "Copy {i} of {n}" unchanged. The counter chip (`combine-to-choose`) shows `s.toChoose`: "{n} to choose".
- **Section list** (left, `combine-section`, `data-key`, `data-status`, new `data-level`, `data-left`), one row per section. Chips (plan: combined / n to choose / unchanged):
  - `left > 0` → **{n} to choose** (warning);
  - status `same` → **Unchanged**;
  - otherwise → **Combined** (success). Sub-line: a whole section → "from mine" / "from {who}" (phase 2); combined inside → "{n} changes combined" ("1 change combined").
  - Sections with something to choose come first. The rest that changed sit under the collapsed group **"Combined automatically ({s.combinedCount})"** (`combine-auto-group`); unchanged ones under "Not changed ({n})" (`combine-same-group`).
  - A section **without conflicts** and status `mine` / `theirs` keeps the phase 2 buttons **Mine** / **{theirs}** (`combine-pick-mine`, `combine-pick-theirs` → `setSectionChoice`) inside the expanded group. Sections with conflicts have no whole-section buttons here.
- **Pane** (right, `combine-compare`, `data-key`) for the focused section: §6.2. A section without conflicts shows the phase 2 side-by-side view (mine left, theirs right) followed by its "Combined automatically" list.
- **Adjusted automatically** (`combine-adjusted`, above the footer, only when `s.adjustments.length > 0`): §6.4.
- **Footer** unchanged: **Cancel** · **Keep both as separate files** · **Apply** (disabled until `s.canApply`), and the footnote "Nothing is saved until you press Apply. Both versions stay in the file's history."

> **CHANGED BY fixer (findings VUX-3, VUX-8, VUX-10):** a click on the dimmed area beside the dialog does nothing (Esc and Cancel still cancel; the choices are kept, §5.3). The left-hand group reads "Combined automatically ({n} part(s))", counting the parts it lists (it counted changes). Toasts are not shown while the combine dialog is open (they appear, and time out, after it closes), so they never cover the footer. A banner whose text is cut short in the document bar (narrow windows) opens in full in a popover when its text is clicked (`banner-full`); the full text is also its tooltip, as before.
- The left-hand two-way note (`combine-twoway`) becomes: "These two copies were last the same too long ago to compare cell by cell. Choose which to keep for each part that differs."

### 6.2 The pane for a section with conflicts

Top line: the section title, then **Use mine for all** (`combine-all-mine`) and **Use {theirs} for all** (`combine-all-theirs`) → `setAllInSection(key, side)`; shown when the section has two or more conflicts and `level: "fine"`.

Then one block per conflict (`combine-conflict`, `data-id`, `data-kind`, `data-choice` = the choice or `""`), at most `LIMITS_P4.dialogConflicts` (200); beyond that a line "and {n} more — use the buttons above to choose for all of them" (`combine-more`). Each block has a heading, the values, and the choice buttons `combine-conflict-mine` / `combine-conflict-theirs` (/ `combine-conflict-both`) → `setConflictChoice(id, …)`; the chosen one is filled, and a block without a choice has the warning tint.

| kind | heading | values | buttons |
|---|---|---|---|
| `row` | "Row {n}" + " · {row title}" when it has one. `{n}` = the row's 1-based position in mine's table (theirs' when mine lacks it). | a **mini-table** (`combine-conflict-table`): header = the column titles (the row-title column and, on XY tables, X first when they differ), one line **Mine** and one line **{theirs}**, each cell showing that side's text (`combine-conflict-cell`, `data-side`, `data-col`, `data-rep`; `data-diff="true"` and highlighted for the values in `items`). Columns shown: those with a differing value plus up to 6 neighbours; replicates as sub-cells. Read from `s.mineContent.doc` / `s.theirsContent.doc` by row and column id. | **Mine** · **{theirs}** |
| `rowDeleted` | `deletedBy` mine: "Row {n} — deleted on this computer, changed by {who}". `deletedBy` theirs: "Row {n} — deleted by {who}, changed on this computer". | the mini-table with the one line of the side that still has the row; the values in `items` highlighted | on the deleting side's button: **Delete the row**; on the other: **Keep the row** (test ids by side, as above) |
| `colDeleted` | "Column '{title}' — deleted on this computer, changed by {who}" / "… deleted by {who}, changed on this computer" | "{n} values changed" and the first few `items` as "Row {n}: {before} → {after}" | **Delete the column** · **Keep the column** |
| `colTitle` | "Column title" | "Mine: '{a}' · {theirs}: '{b}'" | **Mine** · **{theirs}** |
| `tableField` | "X title" | as `colTitle` | **Mine** · **{theirs}** |
| `field` | the setting's name (`fieldLabel(field)`, the helper `CompareView` already has) | "Mine: {a} · {theirs}: {b}" (short texts; an empty text as "(empty)") | **Mine** · **{theirs}** |
| `group` | `colours` → "Colours" · `size` → "Size" · `yRange` → "Y axis range" | one line per item: "{setting}: mine {a} · {theirs} {b}"; colours as small swatches with the column title | **Mine** · **{theirs}** |
| `seriesLabel` | "Legend label of '{column title}'" | as `colTitle` | **Mine** · **{theirs}** |
| `cell` | the address ("B12") | "Mine: {input} · {theirs}: {input}" (monospace; "(empty)" when not there); a second line for the number format when it differs | **Mine** · **{theirs}** |

Under the conflicts, for the graph section: the two graphs side by side as in phase 2 (they help choosing). Under everything: the section's **"Combined automatically ({combined})"** list (`combine-auto-list`, collapsed while the section has conflicts), one line per `auto` entry (`combine-auto-item`), e.g. "Row 3, Group A: 5.1 → 5.4 (mine)", "Row added ({who})", "Column 'KO' removed (mine)", "Title: '' → 'Dose' ({who})", "B2: 1 → 2 (mine)", "Replicates: 3 → 4 ({who})"; `from: "same"` → "(both)". When `combined > auto.length`: "and {n} more".

> **CHANGED BY fixer (findings VUX-1, VUX-5, VUX-7):** the `row` block's heading adds "{n} values to choose" (secondary) when more than one; the mini-table shows the differing columns plus neighbours only up to about a dozen values in all (`floor(12 / replicates) − differing`, at most 6), and the row-title column only when the title is to choose or differs between the sides; under it, while nothing is chosen, "{n} other value(s) in this row changed on one side only and is/are kept whichever you choose." when there are any; once every choice is made, a third line **Combined** (`combine-conflict-result`) shows the row as it will be saved, values not from the chosen side marked (`data-other`). The part's summary line counts added / removed rows **with data** only (each computer's own blank row at the end is not "1 row added · 1 row removed").

> **CHANGED BY fixer round 2 (finding RV-3):** a row both typed into that is kept as two rows shows no changed cells in the two tables (no "→" marks; §5.2 `compare`), and the part's summary line counts it as a row added on each side ("1 row added · 1 row removed", as two rows each computer added).

### 6.3 A section that is one whole choice (`level: "whole"` with a `section` conflict)

Block `combine-whole` (`data-reason`), same buttons / test ids as a conflict:

| reason | text | buttons |
|---|---|---|
| `twoWay` | "These two copies were last the same too long ago to compare cell by cell. Keep:" | **Mine** · **{theirs}** · **Both as separate files** (`combine-keep-separate` → `keepBothAsSeparate()`) |
| `shift` | "The scratchpad was rearranged on one computer, so it can't be combined cell by cell. Keep:" | **Mine** · **{theirs}** · **Both side by side** (`combine-conflict-both`; only when `options` has `both`), with the caption "Both side by side puts the other sheet to the right of yours." |
| `table` | "These two tables are too different to combine row by row. Keep:" | **Mine** · **{theirs}** |

Below it the phase 2 side-by-side view of the two versions of that section.

### 6.4 "Adjusted automatically" and "Row order — please check"

`combine-adjusted` (warning): heading "Adjusted automatically ({n})", one line per entry (`combine-adjusted-item`, `data-kind`), then "Check the result after applying."

| kind | line |
|---|---|
| `setting` | "{setting name}: {from} → {to}" (`series.<col id>` as "Colour and label of '{column title}'") |
| `testNotRun` | "The chosen test ({test name}) can't run on the combined table." |
| `comparisons` | "Some chosen comparisons are not used with the combined table." |
| `replicates` | "Replicates kept at {to} so no values are dropped." |
| `table` | "The table was tidied up." |
| `scratchpad` | "The scratchpad was tidied up." |

`combine-order-check` (`data-axis`; info, at the top of the table pane, one for every `orderChecks` entry of the section with `matters`): rows → **"Row order — please check. Both computers added rows in the same place."**; columns → "Column order — please check. Both computers added columns in the same place." The rows / columns named in `ids` get a small marker in the side-by-side table. (While a choice is missing, `orderChecks` is empty and the note is not shown; it appears as soon as the result exists, before Apply can be pressed.)

> **CHANGED BY fixer (finding VUX-2):** the row note names the rows by their place in the combined table: "Row order — please check (rows 81–82). Both computers added rows in the same place." ("row 5" for one). When a marked row lies beyond the first 60 rows a table shows, that table shows the marked rows with three rows either side instead, with "Showing the rows to check and the rows around them." (`table-near-marked`).

### 6.5 Banners and toasts

| kind | severity | text | buttons |
|---|---|---|---|
| `savedOver`, `state: "review"` (new) | info | Another computer saved over your last save. Nothing is lost — both sets of changes can be combined. | `combine` → **Combine** |
| `savedOver`, `combining` / `choose` | | unchanged | unchanged |
| `combined` (changed) | success | Combined with the version saved by {who}. Taken from it: {section list}. Changes from both are in {section list of `mixed`}. — each of the last two sentences only when its list is not empty | unchanged (**What changed** · **Undo**) |
| `newerOnDisk` | | unchanged ("{Who} saved a newer version." **Combine my changes with it** · Later) | |

`bannerActionLabel("combine")` for `savedOver` → "Combine" when `state === "review"`, "Choose…" otherwise. Toasts, the undo button and its label are unchanged.

### 6.6 `CompareView.tsx`

Its Versions use (Compare with current) is unchanged. It keeps exporting the helpers the dialog uses (`cellMarks`, `fieldLabel`, `shortValue`, `tableChangeLines`) and may gain the mini-table and the row / column marker used by §6.2 and §6.4, so the dialog and the Versions compare draw a row the same way.

### 6.7 Simulator additions (browser preview)

`devSim()` returns `DevSimApiP4`. `SimPanel` gets a group **"Small changes"** with a selector (`sim-fine-how`): **saves a newer version** (`remoteEdit(path, {fine})`) · **saves over my last save** (`remoteDiverge(path, {fine, how: "saveOver"})`) · **makes a conflicted copy** (`remoteDiverge(path, {fine, how: "copy"})`), and one button per change:

| button (`data-testid`) | label | `fine` | the other computer does exactly this |
|---|---|---|---|
| `sim-fine-cell` | Change the first value | `cell` | row 1, column 1, replicate 1: a number + 1, else "1" (the phase 2 table edit) |
| `sim-fine-cell-other` | Change a value in row 3 | `cellOther` | the same in row 3, column 1 |
| `sim-fine-add-row` | Add a row of values | `addRow` | types "7" into replicate 1 of every column (and X on XY tables) of the first row without data — the shared blank row, as a person would |
| `sim-fine-insert-row` | Insert a row at the top | `insertRow` | `insertRow(doc, 0)` (a new id) and "3" in every column of it (and X on XY tables) |
| `sim-fine-delete-row` | Delete row 1 | `deleteRow` | `deleteRow(doc, 0)` |
| `sim-fine-delete-col` | Delete the last column | `deleteCol` | `deleteCol(doc, last)` with the analysis and graph settings following (`remapAnalysis`, `remapFigure`), as the editor does |
| `sim-fine-rename-col` | Rename the first column | `renameCol` | first column title + " *" |
| `sim-fine-yrange` | Set the Y axis range | `yRange` | `y_min: 0`, `y_max: 100` (50 when it is already 100) |
| `sim-fine-title` | Change the graph title | `graphTitle` | the phase 2 graph edit |
| `sim-fine-alpha` | Change the significance level | `alpha` | the phase 2 analysis edit (0.05 ↔ 0.01) |
| `sim-fine-scratch` | Edit scratchpad cells | `scratchCells` | B2: a number + 1, else "1"; B3: `=B2*2` |
| `sim-fine-scratch-shift` | Insert a scratchpad row | `scratchShift` | every cell moves one row down (inputs unchanged), A1 gets "Inserted" |

`remoteDiverge` needs a previous version (phase 2 rule). `scratchShift` needs content to move: when the scratchpad has fewer than 12 cells, the simulator first saves a version of its own that fills A1:B6 with numbers and resolves after it. The phase 3 "older app" switch (`setOldApp`) now also means: no `combine_v` on that computer's saves. `peerSaves` accepts `fine` too.

The cases the panel must be able to produce: own edit of another cell + `cell` → combines by itself; own edit of the same cell + `cell` → one row to choose; own values typed into the first blank row + `addRow` → that row to choose; *(CHANGED BY fixer, M1: → two rows, nothing to choose; "Row order — please check" on grouped / XY tables, combined by itself on a column table)* own inserted row at the top + `insertRow` → "Row order — please check" on an XY table; own edit in the last column + `deleteCol` → "Column … deleted by …, changed on this computer"; own Y range + `yRange` → "Y axis range" to choose; own graph title + `yRange` → combines by itself; own B2 + `scratchCells` → cell B2 to choose; own scratchpad edit + `scratchShift` → the three-button whole choice; any conflict-free one with "older app" on and "saves over my last save" → the `review` banner.

### 6.8 Words

Never in a string the person sees (in addition to the phase 2 / 3 lists, which already ban merge, base, ancestor, lca, revision, head, journal), as whole words: **conflict** (except "conflicted copy"), **three-way**, **two-way**, **fine-level**, **atomic**, **shift**, **offset**, **replicate index**. New strings also say *setting* (not "field") and *part* or the part's title (not "section"), and never show a row / column id. ui extends the sweep of `text.test.ts` with the bold words and includes every string of §6; "field" and "section" are checked for the new strings only (older strings are not reworded in this phase).

---

## 7. File ownership (no overlaps)

| implementer | owns |
|---|---|
| **mergeTable** | new: `src/components/graph/file/mergeTable.ts`, `mergeTable.test.ts` (and `mergeTable.props.test.ts` if wanted) |
| **mergeFields** | new: `src/components/graph/file/mergeFields.ts`, `mergeFields.test.ts`, `mergeScratch.ts`, `mergeScratch.test.ts` |
| **session** | `src/components/graph/file/graphMerge.ts` (+ `graphMerge.test.ts`), `session.ts`, `backend.ts`, `memoryBackend.ts`, `previewBackend.ts`, `devSim.ts`, `e2e.ts`, `testkit.ts`, their existing tests, new tests `graphMerge.fine.test.ts`, `combine.fine.test.ts`, `combine.fine.multidevice.test.ts`; `src/store/graphStore.ts` only if unavoidable |
| **ui** | `src/components/graph/files-ui/**` only (`CombineDialog.tsx`, `CompareView.tsx`, `BannerSlot.tsx`, `SimPanel.tsx`, `ReadOnlyViews.tsx`, `text.ts`, `text.test.ts`, new components) |
| **nobody** (read-only) | `contract.ts`, `format.ts`, `docCodec.ts`, `idMap.ts`, `revisions.ts`, `retention.ts`, `summaries.ts`, `laneGraph.ts`, `presence.ts`, `paths.ts`, `goldens.test.ts`, `graphModel.ts`, the scratchpad, `DataGrid.tsx`, `GraphView.tsx`, `src-tauri/**`, the Python sidecar, CI, `package.json` |

Already done by the contract author: section 8 of `contract.ts`, the `TabBanner.state` member `"review"` and the field `TabBanner.mixed`.

---

## 8. Acceptance checklist

Where it runs: **V** = vitest (scratch copy), **B** = browser preview with the simulator, **E** = real-app self-test (`LAS_E2E_SCRIPT`, phase `"combineFine"`). Baseline that must stay green throughout: `tsc --noEmit`, `vite build` (no `dev_e2e_` in `dist`), vitest (41 files / 937 tests + the new ones), `graph-fe-tests/run.sh`, `graph-tests/run_all.sh`, `cargo test --locked` (144 passed / 2 ignored, unchanged), `cargo check --locked --release`.

Property tests use generated documents (all three templates; random edits: cell, row title, X, column title, add / insert / delete row, add / delete column, replicate count, typing into the trailing blank row), a fixed seed, at least 300 cases each. "= x" always means **the same canonical text** (and so the same hash).

### Data table (mergeTable) — V

1. **T1** `merge(b, x, b)` = `x` and `merge(b, b, x)` = `x`, for every generated `x` (including `x` with more / fewer rows, a lower replicate count, cleared rows at the end, a blank row inserted in the tail).
2. **T2** `merge(b, x, x)` = `x`.
3. **T3** Symmetry: conflict-free `merge(b, x, y)` and `merge(b, y, x)` (keys swapped with the sides) give the same text; with conflicts, the same conflict ids, and the same text when every choice is swapped.
4. **T4** No cell edit is lost: in a conflict-free result, every cell / title / X value that exactly one side changed, in a row and column the result has, carries that side's text; and a row or column is missing from the result only when one side deleted it and the other changed nothing in it.
5. **T5** A deletion never silently loses an edit: whenever one side deleted a row / column and the other changed something in it, there is a `rowDeleted` / `colDeleted` conflict (or, for a row blank in the base, the row is kept); choosing the deleting side removes it, choosing the other keeps it with every one of that side's values.
6. **T6** All-mine: with every conflict chosen `mine`, every conflicted place (each `items` entry; each deleted-or-kept row / column) is as mine has it; all-theirs likewise. Non-conflicting changes of the other side are still there.
7. **T7** Idempotent re-merge: with `r = merge(b, x, y)` conflict-free, `merge(x, r, x)` = `r`, `merge(y, r, y)` = `r`, `merge(b, r, x)` = `r` and `merge(b, r, y)` = `r`.
8. **T8** Fixtures: different cells of one row → combined, no conflict; the same cell → one `row` conflict listing that cell; two cells and the title of one row → one conflict with three items; a column title on both → `colTitle`; `x_title` on both → `tableField`.
9. **T9** Order: both insert rows after the same row → the first side's (smaller `deviceId`; tie → smaller `revisionId`) first, an `OrderCheck` with those ids, `matters` false on a column table and true on grouped / XY; the same result with the sides swapped; rows inserted at different places → no check; columns → check with `matters: true`.
10. **T10** Trailing blanks: both sides typed into the shared blank last row in different columns → one row, no conflict; in the same cell → one `row` conflict; *(CHANGED BY fixer, M1: → two rows, the first side's values in the shared row, the other's in the hashed split row right after it, an order check on grouped / XY; in the same cell likewise two rows and no conflict)* each side got its own new blank row → no order check, no `auto` entry; a side's blank padding never lands between rows with data; the result has at least 10 rows and ends with a blank row; ids of added rows are the §2.2.6 hash (a hand-computed vector) and equal from both sides.
11. **T11** Replicates: one side raises 3 → 4 and fills → 4; one side lowers 3 → 2, other unchanged → 2; one lowers, the other edits a third replicate → `row` conflict, and choosing the editing side gives `n_rep` 3 with a `replicates` adjustment; both change → the larger.
12. **T12** Pipeline form: for every generated case, `normaliseSections` of a document with the result table returns the same table text (no random ids, no reshaping). The whole-choice cases of §2.2.9 (templates differ; no column; 27 columns; 501 rows with data) each give `whole: "table"`.
13. **T13** A 500 × 26 × 3 table with 200 scattered changes per side combines in under 50 ms per call (after warm-up).

### Settings and scratchpad (mergeFields) — V

14. **F1** Analysis: per-field three-way (one side, both alike, both differently → `analysis:field:<key>`); an unknown field is carried; the properties T1–T3, T6, T7 for generated analysis objects.
15. **F2** `pairs`: one side adds a pair, the other removes another → both effects, no conflict; `[a, b]` and `[b, a]` are one pair; an unchanged side's list comes back byte for byte; symmetric.
16. **F3** Figure groups: mine changes `y_min`, theirs `y_max` → **conflict** `figure:group:yRange` (not a silent mix); mine changes `width`, theirs `title` → combined; a palette on one side and a hand-picked colour on the other → `figure:group:colours`; taking a side takes all its members.
17. **F4** Figure and columns: mine deletes a column, theirs recolours another → combined without conflict, `series` has exactly the `colIds` in order; mine adds a column, theirs switches palette → no conflict, the new column keeps mine's colour; the label of one column on both → `figure:label:<id>`; `colIds: null` → `value: null` with the same conflicts.
18. **F5** Properties T1–T3, T6, T7 for generated figure objects (with `colIds` = the result's columns), and pipeline form: `normaliseSections` of a document with the result's analysis / figure and a matching table returns the same texts.
19. **F6** `detectAdjustments`: a pair naming a column the combined table lacks → `setting` on `pairs`; a test that can run on each side but not on the result → `testNotRun`; a test that already could not run on both sides → nothing; no difference → `[]`.
20. **F7** `shortText` table (string, number, boolean, null, an object cut at 60).
21. **X1** Scratchpad cells: different cells → combined; the same cell differently → `scratchpad:cell:<A1>`; the same cell alike → combined (`from: "same"`); one clears, the other edits → conflict; widths never conflict (larger wins); properties T1–T3, T6, T7.
22. **X2** Shift check rule A: 10 base cells, 4 changed → true; 3 changed → false; 9 base cells, all changed → false by A.
23. **X3** Shift check rule B: a row inserted above 20 cells → true; 6 cells moved one column right among 40 → true; a column of identical values scrolled by one → false; 4 moved cells → false.
24. **X4** A shifted side → `shift: true`, the single `scratchpad:section` conflict with `both` offered; `mine` / `theirs` give that side's object.
25. **X5** `sideBySide`: theirs' cells and widths land `d` columns right with `d` = mine's last used column + 1; mine untouched; `null` (and no `both` option) when it would pass column 300.
26. **X6** `shiftFormula` table: `=A1+$B$2` → shifted; `=SUM(A1:A5)`; `=A:A`; `="A1"&B1` (the string untouched); `=LOG10(C3)` (the function name untouched); `=Sheet1!A1`; `=3:5` unchanged; plain text and numbers unchanged; overflow → `null`.
27. **X7** `null` sides (an empty scratchpad) in each of the three positions.
28. **X8** Pipeline form: `sanitizeScratch` of every result gives the same text.

### Composition (session: graphMerge) — V

29. **G1** `combineFine` on the phase 2 generated documents: `(b, x, b)` = `x`, `(b, x, x)` = `x`, a symmetric content hash when conflict-free, and `combineRevision({auto: true})` deep-equal with the sides swapped (now including `combine_v`).
30. **G2** **Same as the older rules when no section is `both`**: for at least 300 generated pairs that changed different sections, `combineFine(…).result.parts.contentHash === combine(…).result.parts.contentHash`, the same `repairs`, the same merge id, and `autoApplicable` is never true where `combine`'s is false.
31. **G3** Fine cases end to end: different cells of the table on both sides → `level: "fine"`, no conflict, `autoApplicable`, `mixed: ["table"]`, `sections_from` without `table`; the same cell → `needsChoice`, `result: null`; `applyFineChoices` with the row chosen → a result; `choices.sections.table = "theirs"` → theirs' table whole.
32. **G4** Cross-section: mine deletes a column, theirs adds a pair naming it → a result with a `setting` adjustment, not `autoApplicable`; mine deletes a column, theirs recolours another column and edits a cell → `autoApplicable`.
33. **G5** Order checks: an XY table with same-place insertions → not `autoApplicable`; a column table → `autoApplicable`; the same column table with `test: "paired_t"` → not.
34. **G6** Two-way: every differing section is `level: "whole"` with reason `twoWay`; `ambiguous` / `nearest` → a fine plan, never `autoApplicable`.
35. **G7** `peersCombineAlike`: both `combine_v: 1` → true; one missing → false; one `2` → false.
36. **G8** Idempotent across a combine: with `r` the conflict-free result of `(b, x, y)`, `combineFine({base: x, mine: r, theirs: x})` and `combineFine({base: y, mine: r, theirs: y})` give `r`'s content hash.

### Controller (session) — V, `MemoryDevice`s on the `ManualClock`

37. **S1** An unsaved edit of cell A here, the other computer saves an edit of cell B (same table) → `newerOnDisk`; **Combine my changes with it** (and, separately, **Save**) writes one two-parent version at once, the tab shows both cells, banner `combined` with `mixed: ["table"]`; the version has `combine_v` and `auto: true`.
38. **S2** Both edit the same cell → Save opens the dialog: `toChoose === 1`, one conflict `table:row:<id>`, `canApply` false; nothing on disk changes; `setConflictChoice(id, "theirs")` → `canApply`, `resultContent` has their value and my other edits; `applyCombine` writes it (author = me, no `auto`).
39. **S3** `setAllInSection("table", "mine")` with three conflicts → `toChoose === 0`; `setSectionChoice("table", "theirs")` afterwards → theirs' whole table; `setConflictChoice` after that removes the whole-section choice.
40. **S4** Unprompted, both P4: my save replaced by a save that changed another cell → `savedOver {state: "combining"}`, nothing written before the delay, then one combined version with both cells.
41. **S5** Unprompted, the other version without `combine_v` (same edits as S4) → `savedOver {state: "review"}`, **no write** however long the clock runs; `combine` on the banner writes it at once without a dialog.
42. **S6** Unprompted with something adjusted or an order to check → `review`, no write; pressing `combine` opens the dialog with the adjustment / note listed and Apply enabled.
43. **S7** Unprompted with a conflict → `choose`, no write.
44. **S8** Rebuild while the dialog is open (phase 2 step 7.1): I type in another cell → choices kept, written with the new edit included; I type in a cell of a row I had chosen for → the dialog stays with the new state and nothing is written.
45. **S9** Scratchpad: different cells → combined on Save; the same cell → a conflict; a shifted sheet on the other side while I edited the scratchpad → the whole choice with `both`; choosing `both` writes a sheet with mine in place and theirs to the right.
46. **S10** Two-way (no stored common version) → every differing section one whole choice; `keepBothAsSeparate` as in phase 2.
47. **S11** Read-only: a read-only tab refuses `startCombine` / `applyCombine` (`reason: "readOnly"`) and its unprompted fine combine waits until the guard clears (the phase 3 S13 case with a fine plan).
48. **S12** Every version this build writes carries `combine_v` (save, the working copy in the journal, bring back, Save As new, separate copy, combine); a version already in the file is not touched; a revision with an unknown field `zz: 1` survives open → edit → save → fine combine → bring back.
49. **S13** With `combineLevel: "section"` the controller reproduces phase 2: the phase 2 cases S3 / S5 / S6 pass as written, and no `combine_v` is written.
50. **S14** All phase 2 and phase 3 session tests still pass. Where a phase 2 test built "both changed the table" by editing the same first cell on both sides, it still gets a dialog (one row to choose) and its `setSectionChoice` still decides it; tests that relied on *different* places of one section needing a choice are rewritten to the new behaviour and listed in the final report.

### Multi-device scenarios (session) — V (`combine.fine.multidevice.test.ts`)

Two or three computers, conflict modes `dropbox` / `onedrive` / `lww`, sync delays 0 s / 5 s / 60 s, one computer offline and back, ±2 h clock skew, duplicate device id. Edits are **inside one section**: different cells; different rows added; a column deleted on one and a cell elsewhere on the other; a graph title and a Y range; different scratchpad cells. The world settles (copies combined by pressing `combine` where the service made one). Assertions, with the phase 2 helpers:

51. **D1 No edit is ever lost**: every cell / setting / scratchpad value any computer typed is in the final content on every computer (conflict-free scenarios), and every head ever written is in a file's history or a journal (`writtenHeads ⊆ keptRevisions`).
52. **D2 One head**: all computers end on the same head and show the same content hash.
53. **D3 At most one automatic combine per pair**: among all revisions of all files, no two revisions with `auto: true` have the same sorted parents; and (the phase 2 assertion) no two two-parent revisions have the same sorted parents in scenarios where at most one person chose.
54. **D4 Forced double write**: two computers with equal delays both write → the same id, deep-equal revision objects, one combine in the file.
55. **D5 With an older app**: the same matrix with one computer on `combineLevel: "section"` (its saves without `combine_v`). Different sections → both compute the same id (D3 holds; the entries are equal up to `combine_v`). Same section, different cells → the P4 computer never writes unprompted (`review`), the older one shows `choose` when it is the one whose save was replaced; after **one** click on the P4 computer all converge with both edits (D1, D2, D3). After one whole-section choice on the older computer instead: all converge on that choice, D2 and D3 hold, and the side not chosen is still in the history.
56. **D6 The same place on both** (the same cell): at least one computer shows the dialog or `choose`, nothing is written without `applyCombine`, and after one choice all converge (D2, D3).
57. **D7 Three P4 computers**, one replaced save: exactly one writes the combine (the shortest delay), the others reload; no `review` / `choose` banner is left anywhere.

### UI — V (text) and B (browser preview: `las.activeTool = "graph"`, the simulator panel)

58. **U1** (V) Every string of §6 (chips, headings, buttons, whole-choice texts, adjusted lines, order notes, the `review` banner, the `combined` banner with `mixed`), the label of `combine` per state, and the word sweep of §6.8.
59. **U2** (B) Own edit of row 2 + "Change the first value" (saves a newer version) → "Alice … saved a newer version." → **Combine my changes with it** → no dialog; banner "Combined with the version saved by Alice (Office iMac). Changes from both are in the table."; the table shows both values; **Undo** brings my version back.
60. **U3** (B) Own edit of the first value + "Change the first value" + Save → the dialog: "1 to choose", the table part first with the chip "1 to choose", one block "Row 1" with the mini-table (two lines, the differing cell highlighted on both), Apply disabled; **{theirs}** → Apply enabled; before Apply the simulated file's head is unchanged; after Apply the cell has their value and my other edit is still there.
61. **U4** (B) Three own cell edits in rows the other computer also changed → "Use mine for all" sets all three; the counter goes to 0.
62. **U5** (B) Own edit in the last column + "Delete the last column" → block "Column '…' — deleted by Alice (Office iMac), changed on this computer" with **Delete the column** / **Keep the column**; Keep → the column is there after Apply.
63. **U6** (B) XY table: own inserted row at the top + "Insert a row at the top" → the dialog opens with nothing to choose, "Row order — please check. Both computers added rows in the same place.", Apply enabled.
64. **U7** (B) Own Y range + "Set the Y axis range" → the graph part with one block "Y axis range"; own graph title + "Set the Y axis range" → combines by itself.
65. **U8** (B) Own scratchpad cell B2 + "Edit scratchpad cells" → block "B2"; own scratchpad edit + "Insert a scratchpad row" → the three-button whole choice; **Both side by side** → after Apply the Scratchpad shows mine and, to the right, theirs.
66. **U9** (B) "saves over my last save" with "older app" on, different cells → the `review` banner with **Combine**; nothing happens for 30 simulated seconds; the click combines. With "older app" off → "…combining both now." and, after the delay, the `combined` banner.
67. **U10** (B) A column deleted here + a comparison naming it added there (set up through `__lasSim`) → the dialog lists "Adjusted automatically (1)".
68. **U11** (B) The dialog at 1280 × 800: 200 blocks scroll without the footer leaving the screen; Esc = Cancel; viewport reset to desktop and the preview tab closed afterwards.

### Real app — E (debug build, `LAS_E2E_SCRIPT`, phase `"combineFine"`; folders under the scratch area; one run also in `~/Library/CloudStorage/Dropbox/LAS-phase4-test-DELETE-ME`, moved to the Trash afterwards)

69. **E1** An unsaved edit of one cell here + a staged file from "another computer" (written by this build's code, so with `combine_v`) that changed another cell → Save → one file whose head has two parents, both cells, `auto: true`, `combine_v: 1`; my working version is in the journal folder.
70. **E2** Both changed the same cell → Save → dialog state with one `table:row:…` conflict; nothing on disk changes; `setConflictChoice(…, "theirs")` + `applyCombine` → the file has their value and my other edit.
71. **E3** My save replaced by a staged file with `combine_v` (another cell) on a clean tab → `savedOver {state: "combining"}`, nothing written before `combineDelayMs`, then one automatic combine. The same with a staged file **without** `combine_v` → `savedOver {state: "review"}`, nothing written for 15 s, `combine` writes it.
72. **E4** A file holding fine-combined versions goes through the older reader / save path (the phase 2 E5 scratch harness with the released TS + Rust code of exp-0.2.25) and `combine_v`, `auto`, `sections_from` survive. If the harness cannot be run, say so.
73. **E5** The phase 2 `"combine"` and phase 3 `"presence"` self-tests still pass unchanged.

---

## 9. Where this contract narrows or changes the plan (on purpose)

1. **A row is the unit of choice for cells**; a column title and `x_title` are their own. There is no per-cell choice inside a row, and no "keep both rows" when two computers typed different values into the same blank last row (it is one row with one choice). Typing into the shared blank row at the end on both computers is therefore the most common case that asks. **CHANGED BY fixer (M1, VUX-1):** two computers typing different things into the same blank row now give **two rows** (no choice; an order to check where order matters), and a row whose title or X is to choose is chosen whole (§2.2.2, §2.2.3 notes).
2. **A replicate count never conflicts and never drops a value** (three-way, the larger when both changed it, raised when a kept value needs it — the raise is listed under "Adjusted automatically").
3. **"Row order — please check" forces a review only where order means something**: grouped and XY tables, paired tests, and columns (the plan names paired and XY tables; grouped rows and columns are drawn in order, so they are included). On an unpaired column table same-place rows combine silently.
4. **A blank row one side removed and the other typed into is kept without asking**; padding rows at the end are never treated as insertions.
5. **Colours of a column only one side has do not belong to the colours group**, and a colour / label for a column the combined table dropped goes with the column without a question.
6. **Typing during the write of a combine** (`rebaseOnto`, phase 2 S18) is still put on top by whole sections; if it touches a section the result changed, the tab keeps its content and is offered the combined version as newer (unchanged).
7. **The scratchpad's shift check needs at least 10 cells in the common version for the 30 % rule** (three cells with one edit is not a rearranged sheet) and 5 moved cells for the offset rule. The check runs only when both sides changed the scratchpad.
8. **"Both side by side" moves references by text**, without the formula engine: cell and whole-column references are shifted, whole-row references and anything unusual are left as typed. It is always a person's choice, never automatic.
9. **A cell's input and its number format are one value** in the scratchpad (one side changing the format and the other the input of the same cell asks).
10. **The table falls back to one whole choice** when templates differ or the combined table would not fit (no column, more than 26 columns, more than 500 rows with data).
11. **Unprompted fine combines need both versions to come from a phase 4 app** (§3.3). Next to an older app the same result is one click away (`review` banner) instead of automatic. A third computer of another version that only *holds* one of the two versions is not detected; the delay, the re-check and the "ambiguous → ask" rule cover it.
12. **No new stored summary text and no change to the Versions panel**: a fine combine reads "Combined changes from two computers" / "Combined two versions" like any other; what it combined is shown by the `combined` banner ("Changes from both are in …") and by What changed.
13. **The older-app notice is not extended**: a P4 computer does not tell the person that the other computer's app combines only whole parts.
14. **No Rust, no file-format change**; `features` stays 2.
