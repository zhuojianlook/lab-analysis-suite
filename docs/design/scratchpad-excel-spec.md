# Scratchpad: grid lines, function autocomplete, point mode, reference colours — build spec

User request (verbatim): "The scratchpad needs to have row lines and function like excel where if I type e.g. =avg in a cell it allows click to populate from e.g. AVERAGE and then you can click on the cells that you want to average which would be highlighted. When the average cell is selected, the cells that are used are highlighted just like in excel."

Scope: `TauriApp/src/components/graph/scratchpad/`. Build on top of the Phase 3 working tree (read-only mode: `readOnly`, `roRef`, `refused()` in SheetGrid.tsx; `session.readOnly` in sheetSession.ts). Line numbers below are for the working-tree SheetGrid.tsx (1057 lines).

Everything in sections 0 and 9 marked "probed" was run against @ironcalc/wasm 0.9.1 in node. Nothing in this spec has been run in the app.

---

## 0. Engine facts this design relies on (probed)

| Call | Result |
|---|---|
| `getTokens("=SUM( A1 : B2 ,c3)")` | `=`@0-1, Ident SUM@1-4, `(`@4-5, **Reference A1@5-8, Colon@8-10, Reference B2@10-13**, Comma@13-15, Reference C3@15-17, `)` |
| `getTokens("=$A$1:B$3")` | one `Range` token @1-9 (no spaces → Range; with spaces → Reference, Colon, Reference) |
| `getTokens("=A1#+  B2 ")` | Reference@1-3, Spill@3-4, Add@4-5, Reference@5-9 (start includes **leading** whitespace only; end excludes trailing) |
| `getTokens("=LOG10+LOG10(A1)")` | first LOG10 is a Reference (row 10, column 8509); second is Ident |
| `getTokens("=A:A+3:5")` | Range rows 1..1048576; Range columns 1..16384 |
| `getTokens("=Sheet1!A1+Sheet2!B2")` | References with `sheet:"Sheet1"` / `sheet:"Sheet2"` |
| `getTokens('="😀"&A1')` | String@1-4, And@4-5, Reference@5-7 → offsets are **code points** |
| `getFormulaCompletion(0,1,1,'="😀"&av',cursor)` | cursor 7 or 8 → FunctionName "av"; cursor 6 → "a" → `cursor` is in **code points**; `replace_from` 4 = code points into the body (after `=`) |
| `getFormulaCompletion(…,"=SUM(A1,B2)",5)` | `[Argument SUM 1, Range]` → only the text before the cursor is analysed |
| `"=SUM(A1, "` (space after comma) | includes `Range` |
| `"=SUM(A1 "`, `"=SUM(A1"`, `"=A1"`, `"=SUM(A1:A2)"`, `"=1"`, `"=A1%"`, `"=SUM(A1;"` | no `Range` |
| `"="`, `"=-"`, `"=("`, `"=A1+ "`, `"={1,"`, `"=@"`, `"=SUM(1,2)*"` | include `Range` |
| `"=SUM(1,2)*"` | also reports `Argument ["SUM",2]` — **wrong** (the call is closed). Do not use the engine's `Argument`; compute it ourselves (section 4.3) |
| `"=SUM(A1:B"` | `FunctionName "B"` (a half-typed range end looks like a name) |
| `"=TRUE"` | `[Other]` (no FunctionName); `"=TRU"` gives FunctionName |
| `"=LET(x,1,x"` | `FunctionName "x"` |
| `setUserInput("=SUM(1,2")` | stored as `=SUM(1,2)` → the engine closes a missing `)` itself |
| `cycleReference("=SUM(A1:B2",10,10)` | `["=SUM($A$1:$B$2", 14, 14]` |

---

## 1. Module layout

New files (all in `scratchpad/`):

| File | Kind | Contents |
|---|---|---|
| `functionCatalog.data.ts` | data | **Ready-made**: copy `/private/tmp/claude-501/-Users-zhuojianlook-Library-CloudStorage-Dropbox-GitHub-Repos-Webtools-Analysis/90ad6687-9e70-49b7-a233-23429ecd07f0/scratchpad/scx-design/functionCatalog.data.ts` verbatim. 493 rows `NAME\|args\|description`. |
| `functionCatalog.ts` | pure TS, no wasm | parse rows, ranking, search, signature parts |
| `formulaRefs.ts` | pure TS + `getTokens` from `@ironcalc/wasm` | references in a formula with positions, ranges, colours; text segments; `pointRefName` |
| `formulaEdit.ts` | pure TS (engine injected) | assist context (can-point, function partial, current argument), `applyCompletion`, `insertReference` |
| `FormulaAssist.tsx` | React | `FunctionListPopup`, `ArgHintPopup`, `ColouredText` (the mirror) |
| `__tests__/formulaRefs.test.ts`, `formulaEdit.test.ts`, `functionCatalog.test.ts` | vitest | under `src/components/graph/__tests__/`, same wasm bootstrap as `readonly.sheet.test.ts` (lines 1-16) |

Changed: `SheetGrid.tsx` only. `sheetSession.ts`, `excelText.ts`, `ScratchpadTab.tsx` need no change (formulaEdit imports `tokenize` from excelText; export it if it is not exported).

One optional text fix: `GraphView.tsx:192` says "AGGREGATE and GROWTH aren't available". GROWTH works in 0.9.1. Change to "AGGREGATE isn't available". That file has Phase 3 edits; touch only that string.

---

## 2. Grid lines

Problem: row lines are one `repeating-linear-gradient` on a 120000px element in `#3a3a3c` on `#1f1f21` (1.45:1). Faint in Chromium, most likely missing in WKWebView.

Changes in SheetGrid.tsx:

1. Colours (line 30-32):
   - `C_LINE = "#4e4e53"` (was `#3a3a3c`; 1.99:1 on `C_CELL`). Used for body grid lines, the formula-bar input border and the corner box.
   - New `C_HEAD_LINE = "#5a5a5f"` for the header cell separators (`borderRight` of column headers at 846, `borderBottom` of row headers at 863, and the three header `Box` borders at 964-973).
2. Remove the `backgroundImage` from the sizer div (983-986).
3. In the `lines` array (827-830) render explicit elements, columns and rows, in one memoised block (see section 8):
   - Column line for `c = c0..c1`: `left: Math.round(colX[c]) - 1, top: (r0-1)*ROW_H, width: 1, height: (r1-r0+1)*ROW_H`.
   - Row line for `r = r0..r1`: `left: colX[c0-1], top: r*ROW_H - 1, width: colX[c1] - colX[c0-1], height: 1`.
   - Both: `position: absolute; background: C_LINE; pointerEvents: none`. Keys `c${c}` / `r${r}`.
   - Do not use `transform`, `opacity` or sub-pixel sizes on them (WebKit drops hairlines).
4. Order inside the sizer (DOM order is the paint order; do not add z-index to lines): lines → cells → reference highlights (section 6) → selection fill → active-cell border → marquee → fill preview → fill handle (zIndex 2) → mirror + editor (zIndex 3/4). So the selection outline and the reference outlines sit above the lines.
5. Cells stay `width: w-1, height: ROW_H-1` (they already leave the 1px for the lines).

---

## 3. Function catalog (`functionCatalog.ts`)

```ts
export interface FnArg { name: string; optional: boolean }
export interface FnEntry {
  name: string;          // "AVERAGE"
  args: FnArg[];         // without the "...N" marker
  repeat: number;        // 0, or how many trailing args repeat (1 for SUM, 2 for SUMIFS)
  desc: string;
  constant: boolean;     // TRUE, FALSE: inserted without "("
  rank: number;          // index in COMMON, or COMMON.length when not listed
}
export const FUNCTIONS: readonly FnEntry[];              // parsed once at module load, sorted by name
export function findFunction(name: string): FnEntry | undefined;   // case-insensitive
export function searchFunctions(query: string, limit = 50): FnEntry[];
/** "AVERAGE(number1, [number2], …)" split so the UI can bold one part. */
export function signatureParts(fn: FnEntry, argIndex?: number): { text: string; current: boolean }[];
```

Parsing a row: split on `|` into 3. Args: split on `,`; a last item matching `^\.\.\.(\d)$` sets `repeat`; `[x]` → optional. `constant` = name is `TRUE` or `FALSE`.

`COMMON` (rank order, lab use first):

```
AVERAGE, SUM, STDEV.S, STDEV, COUNT, MEDIAN, MIN, MAX, ROUND, IF, LOG, LOG10, LN, EXP, POWER, SQRT, ABS,
STDEV.P, VAR.S, COUNTA, COUNTIF, SUMIF, AVERAGEIF, T.TEST, CORREL, SLOPE, INTERCEPT, RSQ, GEOMEAN,
ROUNDUP, ROUNDDOWN, INT, MOD, PRODUCT, SUMPRODUCT, IFERROR, AND, OR, NOT, PERCENTILE.INC, QUARTILE.INC,
LARGE, SMALL, RANK.EQ, TRIMMEAN, CONFIDENCE.T, LINEST, TREND, FORECAST.LINEAR, VLOOKUP, XLOOKUP, INDEX,
MATCH, CONCAT, TEXT, VALUE, LEFT, RIGHT, MID, LEN, TRIM, COUNTIFS, SUMIFS, AVERAGEIFS, IFS, TODAY, NOW,
PI, SEQUENCE, TRANSPOSE, UNIQUE, SORT, FILTER
```

`ALIASES` (query prefix → name prefix, tried longest key first): `AVG→AVERAGE`, `MEAN→AVERAGE`, `STDDEV→STDEV`, `STD→STDEV`, `SD→STDEV`, `VARIANCE→VAR`, `SEM→STDEV` (no SEM function exists; this surfaces STDEV.S), `TTEST→T.TEST`, `SQUARE→SQRT`.

`searchFunctions(query)`:
- `q = query.toUpperCase()`; empty → `[]`.
- Tier 0: `name.startsWith(q)`.
- Tier 1: for the first alias key `k` with `q.startsWith(k)`: `name.startsWith(ALIASES[k] + q.slice(k.length))` (so `avg` → AVERAGE…, `avgif` → AVERAGEIF, AVERAGEIFS). Skip names already in tier 0.
- Tier 2 (only when `q.length >= 2`): `name.includes(q)` and not in tiers 0/1.
- Sort inside a tier: `rank` ascending, then `name.length` ascending, then name A–Z. Concatenate tiers, cut to `limit`.
- Expected: `av` → AVERAGE, AVERAGEIF, AVERAGEIFS, AVEDEV, AVERAGEA (the first three are in COMMON). `avg` → AVERAGE, AVERAGEIF, AVERAGEIFS, AVERAGEA (alias tier). `s` → SUM, STDEV.S, STDEV, SQRT, …. `dev` → DEVSQ (prefix), then the contains tier: STDEV.S, STDEV, STDEV.P, AVEDEV, ….

`signatureParts(fn, argIndex)` produces `NAME(` + args joined by `, ` + (`, …` when `repeat > 0`) + `)`. Optional args print as `[name]`. Constants print as just the name; zero-arg functions as `NAME()`.
Which part is `current` for 1-based `argIndex = i`, with `n = args.length`:
- `i <= n` → `args[i-1]`.
- `i > n` and `repeat > 0` → `args[n - repeat + ((i - n - 1) % repeat)]`.
- otherwise none.

---

## 4. Pure text logic

### 4.1 `formulaRefs.ts`

```ts
export const REF_COLORS = ["#6ea8ff", "#ff7b72", "#c39bff", "#5fd38a", "#ff8ad1", "#ffb057", "#4fd1d9"] as const;
// blue, red, purple, green, pink, orange, teal (Excel's order). Contrast on #1f1f21: 6.5–9.1; on the editor's #2a3442: 5.0–7.0.
export interface FormulaRef {
  start: number; end: number;   // UTF-16 offsets into the full text (leading whitespace trimmed off)
  range: CellRange;             // normalised and clamped to 1..SCRATCH_ROWS / 1..SCRATCH_COLS
  color: number;                // index into REF_COLORS
}
export function formulaRefs(text: string): FormulaRef[];
export function segments(text: string, refs: FormulaRef[]): { text: string; color?: number }[];
export function uniqueRanges(refs: FormulaRef[]): { range: CellRange; color: number }[];
export function pointRefName(g: CellRange): string;
export function cpToUtf16(text: string, cp: number): number;   // also used by formulaEdit
export function utf16ToCp(text: string, i: number): number;
```

`formulaRefs(text)`:
1. Return `[]` unless `text.startsWith("=")`. Call `getTokens(text)` (pass the full text; offsets are then relative to it) inside try/catch → `[]` on a throw.
2. Walk the tokens:
   - `Range` → one ref.
   - `Reference`, `Colon`, `Reference` as three consecutive tokens with the same `sheet` (or the second without one) → one ref from the first token's trimmed start to the third token's end. Consume all three.
   - Other `Reference` → single-cell ref.
3. Sheet: keep a ref only when `sheet` is undefined or equals `"Sheet1"` case-insensitively. References to any other sheet name are skipped (no colour, no highlight).
4. Range: normalise corners (`norm`). Drop the ref when `r1 > SCRATCH_ROWS` or `c1 > SCRATCH_COLS` (this removes a bare `LOG10`, `XFD1`). Clamp `r2`, `c2` to the grid (whole column `A:A` → rows 1..5000; whole row → cols 1..300).
5. Offsets: trim leading whitespace from `start` (advance while the code point is a space/tab/newline), then convert code points → UTF-16. Fast path: when `!/[\uD800-\uDBFF]/.test(text)` the two units are equal.
6. Colour: key = `r1,c1,r2,c2` (so `A1` and `$A$1` share a colour, as in Excel). The n-th distinct key in order of appearance gets `n % 7`.

`segments` cuts the text into runs for the mirror: plain runs (no `color`) and ref runs. Concatenating all `text` gives back the input exactly.

`uniqueRanges` returns one entry per distinct key, first colour wins.

`pointRefName(g)` (text inserted by point mode; always relative):
- one cell → `A1`; otherwise `A1:B5`;
- `r1 === 1 && r2 === SCRATCH_ROWS` → `A:A` / `A:C`;
- `c1 === 1 && c2 === SCRATCH_COLS` (and not whole-column) → `3:3` / `3:5`.

### 4.2 `formulaEdit.ts` — insert and complete

```ts
export interface Pending { start: number; end: number; anchor: Pos; focus: Pos }   // the reference just pointed at
export function insertReference(
  text: string, selStart: number, selEnd: number, pending: Pending | null, ref: string,
  how: "insert" | "replace" | "union",
): { text: string; start: number; end: number };   // [start,end) = the new reference; caret goes to end
export function applyCompletion(text: string, start: number, caret: number, fn: FnEntry): { text: string; caret: number };
```

`insertReference`:
- `"replace"` (needs `pending`): replace `[pending.start, pending.end)`.
- `"union"`: insert `","+ref` at `selEnd`; `start` is after the comma.
- `"insert"`: replace `[selStart, selEnd)`.

`applyCompletion` replaces `[start, caret)`:
- constant → `NAME`, caret after it;
- `text[caret] === "("` → `NAME`, caret after that existing `(`;
- no args → `NAME()`, caret after `)`;
- otherwise → `NAME(`, caret after `(`. Never add a closing `)` (the engine closes it on commit, as Excel does).

### 4.3 `formulaEdit.ts` — assist context

```ts
export type Complete = (formula: string, cursorCp: number) => { expecting: unknown[]; replace_from: number };
export interface Assist {
  canPoint: boolean;                                        // a reference may go at the caret
  fn: { partial: string; start: number } | null;            // function name being typed; start = UTF-16 offset
  arg: { name: string; index: number } | null;              // innermost enclosing function call, 1-based argument
  afterRef: boolean;                                        // the caret is directly after a reference (for Cmd/Ctrl-click)
}
export function assist(text: string, selStart: number, selEnd: number, complete: Complete): Assist;
export const NO_ASSIST: Assist;
```

SheetGrid passes `complete = (f, cur) => session.model.getFormulaCompletion(0, 1, 1, f, cur)` (sheet 0, any cell; wrap in try/catch → `NO_ASSIST`).

Rules:
- Not a formula (`!text.startsWith("=")`) → `NO_ASSIST`.
- `ctx = complete(text, utf16ToCp(text, selStart))`.
- `canPoint` = `ctx.expecting` includes the string `"Range"`.
- `fn`: only when `selStart === selEnd` and `expecting` has `{FunctionName: p}` with `p.length >= 1`.
  - `start = cpToUtf16(text, ctx.replace_from + 1)`; require `text.slice(start, selStart).toUpperCase() === p.toUpperCase()`, else null.
  - Null when the character at the caret matches `[A-Za-z0-9_.]` (caret in the middle of a name).
  - Null when the last non-space character before `start` is `:` (a half-typed range end such as `A1:B`).
- `arg` (do not use the engine's `Argument`): run `tokenize(text.slice(1, selStart))` from excelText and keep a stack:
  - `(` → push `{ name, index: 1, brace: 0 }`, where `name` is the previous token's text upper-cased when that token is an `id` that ends exactly where `(` starts, else `null`;
  - `,` → `top.index++` when `top.brace === 0`;
  - `{` / `}` → `top.brace ±1`;
  - `)` → pop.
  - Result: the nearest frame from the top with a non-null `name` that `findFunction` knows; else null.
- `afterRef`: `selStart === selEnd` and some `formulaRefs(text)` entry has `end === selStart`.

---

## 5. SheetGrid: editing behaviour

### 5.1 New state and helpers

- `pointRef` becomes `useRef<Pending | null>` (adds `focus`). Everything that sets it to null today keeps doing so.
- `const [caret, setCaret] = useState({ s: 0, e: 0 })`. `syncCaret(el)` sets it from `el.selectionStart/End` (functional update that returns the old object when unchanged). Call it from the editor's and the bar's `onSelect`, `onKeyUp`, `onMouseUp`, after `onChange`, and in the `pendingCaret` layout effect (233-239) after `setSelectionRange`. Also in `onSelect`: if `pointRef.current` and the caret is not at `pointRef.current.end`, set `pointRef.current = null`.
- `activeEl()` = `edit.origin === "bar" ? barRef.current : proxyRef.current`.
- `assistNow()` = `assist(ed.text, el.selectionStart, el.selectionEnd, complete)` read straight from the element. Use this in event handlers (never the `caret` state, which can be one event behind).
- Render-time: `const as = useMemo(() => edit && !readOnly ? assist(edit.text, caret.s, caret.e, complete) : NO_ASSIST, [edit?.text, caret.s, caret.e, readOnly])`.
- `const [acIndex, setAcIndex] = useState(0)`; `acDismissed = useRef<string | null>(null)` (the editor text for which Escape closed the list).
- `const items = useMemo(() => as.fn ? searchFunctions(as.fn.partial) : [], [as.fn?.partial])`.
- `listOpen = !!edit && !readOnly && items.length > 0 && acDismissed.current !== edit.text`.
- Reset `acIndex` to 0 whenever `as.fn?.partial` changes. Clear `acDismissed` in both `onChange` handlers.
- `IS_MAC`: derive once (e.g. `/Mac|iPhone|iPad/.test(navigator.platform)`); "modifier-click" below means `e.metaKey` on macOS and `e.ctrlKey` elsewhere. Do not treat Ctrl-click as a modifier-click on macOS (it opens the context menu).

### 5.2 Point mode: when a click inserts a reference and when it commits

`pointable()` (replaces 620-630; delete `POINT_AFTER`):

```
ed = editRef.current; if (!ed || roRef.current || !ed.text.startsWith("=")) → null
el = activeEl(); a = assistNow(); pr = pointRef.current
atPending = pr && el.selectionStart === el.selectionEnd && el.selectionStart === pr.end
if (atPending || a.canPoint) → { el, origin, atPending, afterRef: a.afterRef }
else if (a.afterRef) → { …, unionOnly: true }      // only a modifier-click may insert here
else → null
```

`onBodyMouseDown` (648-668), after the "click inside the editor" early return and `e.preventDefault()`:

| Situation (editing a formula, not read-only) | Result |
|---|---|
| Shift-click, `atPending` | Replace the pending reference with the range `pending.anchor → clicked cell`; dragging keeps extending. |
| Modifier-click, `atPending` or `afterRef` | Union: insert `,` + the clicked cell after the caret; it becomes the new pending reference; dragging extends it. |
| Plain click, `atPending` | Replace the pending reference with the clicked cell (Excel: clicking another cell swaps the reference just inserted); dragging makes a range. |
| Plain click, `canPoint` (after `=`, `(`, `,`, an operator, `:` …) | Insert the clicked cell at the caret (replacing a selected stretch of text); dragging makes a range. |
| Anything else (caret after a finished reference, number, `)`, or the text is not a formula) | Existing behaviour: commit the edit; if the commit succeeds, select the clicked cell. |

Details:
- Every insertion goes through `insertReference(...)` + `pointRefName(norm(anchor→focus))`, then `pointRef.current = { start, end, anchor, focus }`, `setEdit({ ...ed, text })`, `pendingCaret.current = { el: origin, pos: end }`. One code path (`pointTo(anchor, focus, how)`) for mouse, keyboard and headers.
- Dragging uses the existing `drag()` helper and always `"replace"`. The grid selection and active cell do not change in point mode.
- The edit `mode` is left as it is.
- Headers: at the top of `headerMouseDown` (689), before the commit: `const pt = pointable(); if (pt && !pt.unionOnly) { … }` → point at the whole column(s)/row(s) (`A:A`, `3:5`), dragging extends, then `return`. Otherwise existing behaviour.
- Double-click while editing: unchanged (ignored).
- Typing any character clears the pending reference (existing `pointRef.current = null` in both `onChange` handlers). So `=SUM(` click A1 → type `,` → click B2 gives `=SUM(A1,B2`.

### 5.3 Point mode: keyboard

In `editKey` (448-486), the arrow-key case becomes:

```
if (listOpen) → handled by the list (5.4)
pt = (ed.mode === "enter" && !e.altKey) ? pointable() : null
if (pt && !pt.unionOnly):
   base = pt.atPending ? pointRef.current.focus : { r: ed.r, c: ed.c }
   next = mod ? jump(base, dr, dc) : { r: clampR(base.r + dr), c: clampC(base.c + dc) }
   anchor = (e.shiftKey && pt.atPending) ? pointRef.current.anchor : next
   pointTo(anchor, next, pt.atPending ? "replace" : "insert"); scrollIntoView(next); return true
else → the existing logic unchanged (edit mode / bar / modifier → caret moves; enter mode → commit and move)
```

- This applies to both origins. The bar opens in mode "edit", so arrows move the caret there until F2 switches to "enter" (existing F2 toggle at 468-470). F2 again returns to caret movement. Typing into a cell starts in "enter"; double-click and F2 start in "edit".
- Shift+arrow with no pending reference: starts a single-cell reference at the neighbour (same as a plain arrow).
- Enter / Tab / Cmd-Enter: commit as today (clear `pointRef`).
- Escape: cancels the edit (after first closing the function list, 5.4).
- F4 (`cycleRef`, 437-445): unchanged call. Afterwards, if there was a pending reference, re-find it: the `formulaRefs(newText)` entry whose `start === pending.start`; set `pending.end` to its `end` (keep anchor/focus), or clear `pointRef` if none. So F4 right after pointing turns `A1:B2` into `$A$1:$B$2` and the next click still replaces it.
- No other-sheet references (one sheet).

### 5.4 Function autocomplete

Trigger: `listOpen` (5.1). In words: editing a formula (cell or bar), not read-only, the caret is collapsed at the end of a name being typed, at least one function matches, and the list was not dismissed for this exact text. `=` alone shows nothing. `=avg`, `=SUM(av`, `=A1+lo` show the list. `=A1`, `="av`, `=A1:B` do not.

Keys while the list is open (checked first in `editKey`, for both origins):

| Key | Action |
|---|---|
| ArrowDown / ArrowUp | Move the highlight, wrapping. |
| PageDown / PageUp | Move by 8, clamped. |
| Enter (no Alt, no Cmd/Ctrl) or Tab | Accept the highlighted function. Does not commit the cell. |
| Escape | Close the list (`acDismissed.current = ed.text`, re-render). The edit stays open; a second Escape cancels the edit. |
| anything else | Falls through to normal handling; typing keeps filtering. |

Accept (`acceptFn(fn)`): `applyCompletion(ed.text, as.fn.start, caret, fn)` → `setEdit({ ...ed, text })`, `pendingCaret = { el: origin, pos: caret }`, `pointRef.current = null`. Mode unchanged, so after `=avg` → Enter the text is `=AVERAGE(` with the caret inside, and a click or an arrow key points at cells straight away.

Mouse: `onMouseDown` on an option → `e.preventDefault()` (the editor keeps focus) and accept. `onMouseMove` on an option sets the highlight (not `onMouseEnter`, so scrolling the list under a still pointer does not change it).

`FunctionListPopup` (in `FormulaAssist.tsx`):
- MUI `Popper`, `open={listOpen}`, `anchorEl={activeEl()}`, `placement="bottom-start"`, modifiers: `offset [0, 2]`, `flip` with `fallbackPlacements: ["top-start"]`, `preventOverflow` with `padding: 8, altAxis: true`. `sx={{ zIndex: theme.zIndex.tooltip }}`. It is portalled to `body`, so the grid's `overflow` does not clip it and it never leaves the window. Call `popperRef.current?.update()` in a layout effect when `edit.text` changes (the in-cell editor grows).
- Panel: `Paper`, `elevation 8`, `bgcolor #2c2c2e`, `border 1px solid C_LINE`, width `min(460px, 100vw - 16px)`, font 12px.
- List: `role="listbox"`, `id="scratch-fn-list"`, `aria-label="Functions"`, `maxHeight: 8 * 26`, `overflowY: auto`. Each row 26px: `role="option"`, `id={"scratch-fn-" + i}`, `aria-selected`, name (weight 600, the typed prefix part in `primary.light` when the match is a prefix match) at a fixed 150px min-width, then the description in `text.secondary`, one line, ellipsis. Highlighted row: `rgba(90,127,168,0.35)`. Keep the highlighted row in view (`scrollIntoView({ block: "nearest" })` in an effect).
- Footer (1px top border): the highlighted function's signature from `signatureParts(fn)`, e.g. `AVERAGE(number1, [number2], …)`.

Accessibility (on whichever editor has focus, the textarea or the bar input), only while the list is open: `role="combobox"`, `aria-autocomplete="list"`, `aria-haspopup="listbox"`, `aria-expanded="true"`, `aria-controls="scratch-fn-list"`, `aria-activedescendant={"scratch-fn-" + acIndex}`. When closed, none of these attributes are set (the elements keep their native roles).

### 5.5 Argument hint

`ArgHintPopup`: shown when editing, not read-only, the list is closed, and `as.arg` is non-null. Same `Popper` anchor/placement/modifiers as the list. Content: `signatureParts(findFunction(as.arg.name), as.arg.index)` on one line, the current part in weight 700 and `text.primary`, the rest in `text.secondary`; below it the description in a caption line. `role="tooltip"`, `pointerEvents: "none"` (clicks go through to the cells underneath, which matters because the hint sits over the row below the editor), `bgcolor #2c2c2eee`, 1px `C_LINE` border, padding `2px 8px`.

Examples: `=AVERAGE(` → **number1** bold. `=AVERAGE(A1:A5,` → `[number2]` bold. `=AVERAGE(A1,B1,C1,` → `[number2]` bold (repeat). `=SUMIFS(A:A,B:B,1,C:C,` → `[criteria2]` bold. `=SUM(1,2)*` → no hint. `=IF(A1>1,SUM(` → SUM hint; after `=IF(A1>1,SUM(B1),` → IF hint with `[value_if_false]` bold.

---

## 6. Reference colours

### 6.1 Which text is analysed

```
actInput = session.input(act.r, act.c)           // already computed at 880
hlText   = edit ? edit.text : (!multi ? actInput : "")
refs     = useMemo(() => formulaRefs(hlText), [hlText])
```

- Editing (typed, F2, double-click, formula bar): highlights follow the text live.
- Not editing: only when the selection is a single cell that holds a formula. A multi-cell selection shows no reference highlights. A spill child (`input` is `""`) shows none.
- Works in read-only mode (it only reads).
- Recomputed after paste / fill / undo / redo because `actInput` is re-read on every `rev` render.

### 6.2 On the grid

For each `uniqueRanges(refs)` entry render one div inside the sizer, after the cells and before the selection divs: `position: absolute; ...rect(range); boxSizing: border-box; pointerEvents: none`.

| State | Border | Fill |
|---|---|---|
| Editing | `2px solid REF_COLORS[i]` | that colour at alpha 0.16 |
| Editing, and this is the pending reference (same range as `pointRef.current`'s anchor→focus) | `2px dashed` | alpha 0.16 |
| Cell selected, not editing | `1px solid` | alpha 0.10 |

Build the fill as `rgba(r,g,b,a)` from the hex (small helper). Give the divs `data-ref-color={i}` for the browser checks. No drag handles on the outlines (moving a range by dragging its outline is out of scope).

### 6.3 In the text (`ColouredText` mirror)

A textarea/input cannot colour parts of its text, so draw a mirror on top and make the real text transparent.

`ColouredText({ text, refs, scrollLeft, scrollTop, style })`: an `aria-hidden` div, `pointerEvents: none`, `overflow: hidden`, `whiteSpace: pre`, containing one inner span with `display: inline-block; transform: translate(-scrollLeft px, -scrollTop px)` that holds the `segments(text, refs)` runs (`<span style={{ color: REF_COLORS[i] }}>`; plain runs in `theme.palette.text.primary`).

Use it only when `refs.length > 0`; otherwise render no mirror and leave the editors exactly as they are today.

In-cell editor (1008-1030), when `editing && refs.length > 0`:
- textarea: `color: "transparent"`, `WebkitTextFillColor: "transparent"`, `caretColor: theme.palette.text.primary`. Everything else unchanged.
- mirror: a sibling right after the textarea with the same `left, top, width (edWidth), height (ROW_H)`, `boxSizing: border-box`, `padding: "0 4px"`, `border: "2px solid transparent"`, `lineHeight: ROW_H - 2 px`, `font: inherit`, `fontSize: FONT_PX`, `zIndex: 4`.

Formula bar (939-949): wrap the bar `<input>` in `<span style={{ position: "relative", flexGrow: 1, minWidth: 0, display: "flex" }}>`. When `refs.length > 0` (editing or just selected): input gets the same transparent-text styles; the mirror is `position: absolute; inset: 0`, `padding: "0 6px"`, `border: "1px solid transparent"`, `lineHeight: "22px"`, `font: inherit`, `fontVariantNumeric: tabular-nums`. Check the padding against the computed style of the input (`px: 0.75`) in the browser and match it exactly.

Scroll sync: keep `edScroll` / `barScroll` state `{ left, top }`. Update from the element (`el.scrollLeft/scrollTop`, bail when equal) in `onScroll`, `onSelect`, `onKeyUp`, and in a layout effect after every render while a mirror is shown. Needed for a long formula in the bar.

Text selection inside the editor still shows (the selection background is painted by the real element under the mirror).

---

## 7. Other behaviour

- **Double-click a formula cell**: existing `startEdit("edit")`; highlights and coloured text appear because `hlText` is the edit text. No change needed beyond section 6.
- **Commit**: unchanged (`session.setInput`). A formula with a missing `)` such as `=AVERAGE(A1:A5` is accepted (the engine closes it; confirm in the browser check that `checkInput` does not refuse it; if it does, append the missing `)` characters in `commit()` before `setInput`).
- **Undo**: point and autocomplete only change the editor text; the commit is one `setInput`, so one undo step. No session change.
- **Copy / cut / paste**: the proxy's clipboard handlers already ignore events while editing, so native paste into the editor works; it goes through `onChange` (clears the pending reference, re-colours). The copy marquee and the reference outlines can show together.
- **Fill handle / Cmd+D / Cmd+R**: unchanged. The handle is already hidden while editing. After a fill the selection is multi-cell, so no reference highlights.
- **Read-only** (`readOnly` true): `startEdit` and typing are already refused, so the list, the hint and point mode cannot start. Additionally `pointable()` returns null and `as` is `NO_ASSIST` when `roRef.current` is true, which covers a guard that arrives while an edit is open (the open editor then commits to a "readonly" refusal as today). Selected-cell highlights and the coloured bar text still render.
- **Name box, context menus, column resize, select-all**: unchanged.
- **Out of scope**: dragging a coloured outline to move/resize a reference, named ranges, other-sheet references, a function-arguments dialog, table references.

---

## 8. Performance

Today every keystroke re-runs the whole render, including the `session.display` loop for all visible cells. Fix that so a keystroke only re-renders the editor, the mirror, the highlights and the popups:

- Wrap in `useMemo`: `cells` (deps `session, rev, r0, r1, c0, c1, colX, measure, range.r1, range.c1, range.r2, range.c2`), `lines` (`r0, r1, c0, c1, colX`), `colHeads` and `rowHeads` (their window + `range` + `colX` + `theme`). None depend on `edit`, `caret` or `acIndex`.
- `refs`, `as`, `items` are memoised on text/caret as specified. `assist` is one wasm call plus one `tokenize` per keystroke or caret move; `formulaRefs` is one wasm call per text change.
- `searchFunctions` scans 493 entries; no index needed.
- Do not put reference highlights in per-cell styles; they are a handful of overlay divs.
- A whole-column highlight is one 120000px-tall div; that is fine (no gradient, no per-row elements).

---

## 9. Function table

`functionCatalog.data.ts` is generated and ready at
`/private/tmp/claude-501/-Users-zhuojianlook-Library-CloudStorage-Dropbox-GitHub-Repos-Webtools-Analysis/90ad6687-9e70-49b7-a233-23429ecd07f0/scratchpad/scx-design/functionCatalog.data.ts` (38 KB; source rows in `catalog.src` next to it; `check.mjs` is the arity probe).

- 493 names = the 497 names ironcalc 0.9.1 resolves, minus the four `FORECAST.ETS*` (they return `#N/IMPL!`). Name set checked against the investigator's list: nothing missing, nothing extra, no duplicates.
- Argument counts were probed for every function up to XNPV (calls with min, min−1, max, max+1 arguments of `1`; `#ERROR!` = wrong count). One correction came out of it: the engine needs two arguments for `IF` (`IF(logical_test, value_if_true, [value_if_false])`). The probe crashed the engine at XNPV, so XOR, YEAR, YEARFRAC, YIELD, YIELDDISC, YIELDMAT, Z.TEST and ZTEST were not probed; their signatures are Excel's.
- Remaining differences are type effects of passing `1`, not count errors, and were left as Excel documents them: ACCRINTM accepts 3 arguments, HEX2DEC / OCT2DEC / INDEX / NA / NOW / TODAY tolerate one extra.
- Descriptions and argument names were written from Excel's documentation from memory; they are hints, not checked text.

---

## 10. Tests

### 10.1 vitest (new files under `src/components/graph/__tests__/`, wasm bootstrap copied from `readonly.sheet.test.ts`)

`functionCatalog.test.ts`
- `FUNCTIONS.length === 493`; names unique, upper-case, sorted; every row has a description; no `FORECAST.ETS*`.
- Engine check: for every non-constant entry, `=NAME(` + (min required args × `1`) + `)` set in a `Model` does not display `#NAME?` (wrap each call in try/catch and use a fresh `Model` after a throw; XNPV can panic the instance).
- `searchFunctions("av")` → `[AVERAGE, AVERAGEIF, AVERAGEIFS, AVEDEV, AVERAGEA]`.
- `searchFunctions("avg")` → `[AVERAGE, AVERAGEIF, AVERAGEIFS, AVERAGEA]`.
- `searchFunctions("s")[0..3]` → SUM, STDEV.S, STDEV, SQRT. `searchFunctions("std")[0]` → STDEV.S. `searchFunctions("zzz")` → `[]`. `searchFunctions("")` → `[]`.
- `searchFunctions("dev")`: DEVSQ first (prefix), then STDEV.S, STDEV … (contains).
- `signatureParts`: AVERAGE idx 1 → `number1` current; idx 2 and idx 5 → `[number2]`; SUMIFS idx 4 → `[criteria_range2]`, idx 7 → `[criteria2]`; ROUND idx 3 → none; PI → text `PI()`.

`formulaRefs.test.ts`
- `=SUM(A1:A3,A5)*$A$2` → 3 refs, ranges A1:A3 / A5 / A2, colours 0,1,2, offsets slice back to `A1:A3`, `A5`, `$A$2`.
- `=A1+$A$1+a1` → three refs, all colour 0; `uniqueRanges` length 1.
- `=SUM( A1 : B2 ,c3)` → first ref range A1:B2 with `text.slice(start,end) === "A1 : B2"`; second C3.
- `=B3:A1` → range r1 1, c1 1, r2 3, c2 2.
- `=A:A` → rows 1..5000; `=3:5` → cols 1..300.
- `=LOG10+LOG10(A1)` → one ref (A1). `=XFD1` → none.
- `=Sheet1!D4+Sheet2!B2` → one ref (D4). `="A1"&B2` → one ref (B2).
- `="😀"&A1` → ref with `start === 6, end === 8` (UTF-16).
- `=SUM(A1:` → one ref A1. `abc`, `A1` (no `=`) → none.
- Eight distinct refs → colours 0..6 then 0.
- `segments` round-trips the text for each case above.
- `pointRefName`: A1; A1:B5; whole column → `B:B`, `B:D`; whole row → `3:3`.

`formulaEdit.test.ts` (with `complete` bound to a real `Model`)
- `canPoint` true for: `=`, `=SUM(`, `=SUM(A1,`, `=SUM(A1, `, `=A1+`, `=SUM(A1:`, `=1+(`, `=-`, `=IF(A1>`, and `=SUM()` with the caret at 5.
- `canPoint` false for: `=A1`, `=SUM(A1`, `=SUM(A1 `, `=SUM(A1:A2)`, `=1`, `="a`, `abc`.
- `fn`: `=av` → partial `av`, start 1; `=SUM(A1:B2)+av` → start 12; `="é😀"&av` → start 7 (UTF-16); `=A1:B` → null; `=av` with caret at 2 → null (mid-name); `=A1` → null; `abc` → null.
- `arg`: `=AVERAGE(` → AVERAGE 1; `=AVERAGE(A1,` → 2; `=SUM(1,2)*` → null; `=IF(A1>1,SUM(` → SUM 1; `=IF(A1>1,SUM(B1),` → IF 3; `=SUM({1,2},` → SUM 2; `=SUM((A1+` → SUM 1; `=FOO(` → null.
- `afterRef`: `=SUM(A1` → true; `=SUM(A1,` → false.
- `insertReference`: insert into `=SUM(` at 5 → `=SUM(A1`, start 5, end 7; replace pending with `A1:A4` → `=SUM(A1:A4`; union after `=SUM(A1` with `B2` → `=SUM(A1,B2`, start 8; insert over a selected stretch replaces it; insert in the middle (`=SUM()` at 5) → `=SUM(A1)`.
- `applyCompletion`: `=av` → `=AVERAGE(` caret 9; `=SUM(av)` at 7 → `=SUM(AVERAGE()` caret 13; `=av(` with caret 3 → `=AVERAGE(` caret 9 (no doubled paren); PI → `=PI()` caret 5; TRUE → `=TRUE` caret 5.

Run from the scratch copy only: `npx vitest run src/components/graph/__tests__/` and `npx tsc --noEmit`.

### 10.2 Browser pane (scratch copy; private Vite `cacheDir` + `resolve.dedupe` + `--force` as in the investigator's `vite.study.config.ts`; open Graphs → Column → "Start with sample data" → Scratchpad)

Setup: type 1,2,3,4,5 into A1:A5 and 10,20,30 into B1:B3 (use key "Return" to commit, not "\n").

1. **Grid lines**: screenshot the empty area. Horizontal and vertical lines are clearly visible and evenly spaced; `document.querySelector('[data-scratchpad]')` sizer has no `background-image`; scroll to row 3000 and column 200, lines still there; the selection outline is drawn over them.
2. **Autocomplete**: select C1, type `=avg`. A list appears under the cell with AVERAGE highlighted first, each row with a description, and the signature in the footer. The textarea has `aria-activedescendant="scratch-fn-0"` and `role="combobox"`. ArrowDown moves the highlight (attribute becomes `scratch-fn-1`), ArrowUp back. Press Tab → text is `=AVERAGE(`, the list closes, the hint `AVERAGE(number1, [number2], …)` shows with `number1` bold.
3. **Click to point**: click A1 → text `=AVERAGE(A1`, A1 has a dashed blue outline and light fill, `A1` in the editor is blue. Click A3 → text `=AVERAGE(A3` (replaced). Drag A1→A5 → `=AVERAGE(A1:A5`, the range outlined.
4. **Second reference**: type `,` → hint bolds `[number2]`. Click B1, drag to B3 → `=AVERAGE(A1:A5,B1:B3`; second range is red in text and grid, first is solid blue. Press Return → C1 shows 9.375 (the mean of the eight numbers), selection moves to C2.
5. **Selected-cell highlight**: click C1. A1:A5 is outlined blue and B1:B3 red (1px, light fill); the formula bar shows the formula with the same colours. Click C2 (empty) → highlights gone. Drag-select C1:D2 → no highlights.
6. **Double-click edit**: double-click C1 → editor opens with coloured references and 2px outlines. Press Escape → back to the 1px selected-state outlines, value unchanged.
7. **Arrow pointing**: select C2, type `=sum(`, press ArrowUp ArrowLeft → `=sum(B1`… (first ArrowUp gives C1, ArrowLeft gives B1). Shift+ArrowDown twice → `=sum(B1:B3`. Return → 60.
8. **Modifier-click**: select C3, type `=SUM(`, click A1, Cmd-click (Ctrl-click off macOS) A3 → `=SUM(A1,A3`. Return → 4.
9. **F4**: select C4, type `=`, click A2, press F4 → `=$A$2`; click A4 → `=A4` (still replaces). Return.
10. **Enter with list open**: select C5, type `=med`, press Return → text `=MEDIAN(` (not committed). Type `A1:A5)` Return → 3.
11. **Escape**: select D1, type `=su` → list open; Escape → list closed, editor still open with `=su`; Escape → edit cancelled, D1 empty.
12. **Not pointable commits**: select D2, type `=A1`, click B2 → D2 committed as 1 and B2 selected (no reference inserted).
13. **Formula bar**: select D3, click the formula bar, type `=max(`, click A1 and drag to A5 → bar shows `=max(A1:A5` coloured, grid outlined. Return → 5. Type a long formula in the bar (wider than the bar) and check the coloured text stays aligned with the caret while it scrolls.
14. **Popup placement**: scroll so the active cell is on the last visible row; type `=av` → the list opens above the cell and stays inside the window. Resize the pane to 700×400 and repeat.
15. **Undo / paste / fill**: Cmd+Z once removes the D3 formula as one step. Copy C1, paste to E1 → select E1: highlights shifted two columns (C1:C5 and D1:D3). Select C1, drag the fill handle to C1:C2 … fills; selecting one filled cell shows its own precedents.
16. **Read-only**: in the dev "Other computer (test)" panel make the analysis read-only. Select C1 → precedents still outlined and bar text coloured. Type `=`: no editor, no list. Click cells: selection only.
17. **Performance**: with the editor open, hold a letter key for ~3 s: no visible lag; in the React profiler (or by a `console.count` temporarily placed in the `cells` memo) the cell loop does not run per keystroke.
18. **Console**: no errors or React warnings (in particular no "Invalid hook call"; that is the shared Vite cache, see the investigator's note).

Finish: reset the viewport, close the tab, kill the engine and Vite processes. Do not touch port 8765.

---

## 11. Acceptance checklist

- [ ] Row and column grid lines are visible in the dark theme at any scroll position; no gradient background remains; selection and reference outlines draw above the lines.
- [ ] Typing `=avg` lists AVERAGE first with AVERAGEIF, AVERAGEIFS, AVERAGEA; each item has a description; the footer shows the signature. Only catalogued (engine-supported) functions appear.
- [ ] Prefix matches rank before alias matches before contains matches; common lab functions rank first inside a tier.
- [ ] Up/Down/PageUp/PageDown move, Enter/Tab/click accept (inserting `NAME(` with the caret inside), Escape closes the list without cancelling the edit, typing keeps filtering.
- [ ] The list and the hint are placed under the editor, flip above when there is no room, never leave the window, and the hint does not block clicks.
- [ ] The argument hint shows the enclosing function's signature with the current argument bold, including repeating arguments and nested calls, and is absent after the call is closed.
- [ ] At a reference position a click inserts the cell, a drag inserts a range, clicking another cell replaces the reference just inserted, Shift-click extends it, modifier-click adds `,ref`, header clicks insert `A:A` / `3:3`.
- [ ] Where no reference may go, a click commits the edit and selects the cell (as before).
- [ ] In enter mode the arrow keys point (Shift extends, Cmd/Ctrl jumps); F2 switches between pointing and caret movement; F4 cycles `$` on the pointed reference; Enter commits; Escape cancels.
- [ ] Each distinct reference has one colour from the 7-colour cycle (blue, red, purple, green, pink, orange, teal), identical in the editor text, the formula bar and the grid outline + fill; the pending reference is dashed.
- [ ] Selecting a single formula cell outlines its precedents (1px + light fill) and colours the bar text; multi-cell selections and non-formula cells show none; double-click editing shows the editing style.
- [ ] Works the same from the formula bar; long bar text stays aligned with its colours.
- [ ] One undo step per committed formula; copy/paste/fill unchanged; highlights refresh after paste, fill, undo, redo.
- [ ] Read-only: no list, no hint, no point insertion, no edits; selected-cell highlights still show.
- [ ] A keystroke does not re-run the visible-cell loop.
- [ ] `aria-activedescendant`, `aria-controls`, `aria-expanded` and `role="combobox"` are set on the focused editor while the list is open; the list is `role="listbox"` with `role="option"` rows.
- [ ] `tsc --noEmit` clean; the three new vitest files and the existing suite pass; no console errors in the browser run.
