/* Saved Graphs records as they can arrive from the library or a draft: old and
   new shapes, settings that the automatic clean-up changes on open, odd and
   damaged fields. Plain data — no app imports — so the same list can be fed
   to older builds to record their results (golden.json). */

export interface Fixture {
  id: string;
  table: unknown;
  analysis?: unknown;
  figure?: unknown;
  scratchpad?: unknown;
}

const A = (over: Record<string, unknown> = {}) => ({
  test: "none", posthoc: "none", compare: "all", control: null, pairs: [], alpha: 0.05,
  within: "rows", family: "all", correlation: "none", ...over,
});

const col = (vals: (number | string | null)[][]) =>
  // vals[col][row] → cells[row][col][0]
  Array.from({ length: Math.max(...vals.map((c) => c.length)) }, (_, r) => vals.map((c) => [c[r] == null ? "" : String(c[r])]));

export const FIXTURES: Fixture[] = [
  {
    id: "column-anova-dunnett",
    table: {
      v: 1, template: "column", col_titles: ["Control", "Drug A", "Drug B"], row_titles: [], x_title: "X", n_rep: 1, x: [],
      cells: col([[4.17, 5.58, 5.18, 6.11, 4.5], [4.81, 4.17, 4.41, 3.59, 5.87], [6.31, 5.12, 5.54, 5.5, 5.37]]),
    },
    analysis: A({ test: "anova", posthoc: "dunnett", compare: "control", control: 0 }),
    figure: {
      graph_type: "bar", center: "mean_sem", title: "Growth", colors: ["#5a7fa8", "#63a66a", "#c1666b"], labels: ["", "", ""],
      palette: "app:Default", palette_reverse: false, palette_edited: false, axis_scheme: false, fig_label: "Fig. 2", n_unit: "plant",
    },
    scratchpad: { v: 1, cells: [[1, 1, "5"], [2, 1, "=A1*2"]] },
  },
  {
    // Two filled groups but a three-group test: the clean-up switches it to the
    // two-group default. Saved before palettes were named.
    id: "column-two-groups-stale-test",
    table: {
      v: 1, template: "column", col_titles: ["WT", "KO", "Group C"], row_titles: [], x_title: "X", n_rep: 1, x: [],
      cells: col([[1, 2, 3, 4], [2, 3, 4, 5.5], []]),
    },
    analysis: A({ test: "anova", posthoc: "tukey", compare: "all" }),
    figure: { graph_type: "dot", colors: ["#0072B2", "#E69F00", "#009E73"], labels: ["Wild type", "", ""] },
  },
  {
    id: "grouped-within-columns",
    table: {
      v: 1, template: "grouped", col_titles: ["WT", "KO"], row_titles: ["0 h", "24 h", "48 h"], x_title: "X", n_rep: 3, x: [],
      cells: [
        [["1.02", "0.95", "1.08"], ["0.98", "1.05", "0.93"]],
        [["1.85", "2.04", "1.71"], ["1.21", "1.33", "1.12"]],
        [["3.12", "2.88", "3.35"], ["1.52", "1.66", "1.41"]],
      ],
    },
    analysis: A({ test: "two_way", posthoc: "sidak", compare: "selected", within: "columns", control: 1, pairs: [[0, 2], [1, 2]] }),
    figure: { graph_type: "gbar", colors: ["#1b9e77", "#d95f02"], labels: ["", ""], palette: "app:Dark2" },
  },
  {
    // A control index past the last group: the clean-up drops it.
    id: "grouped-control-out-of-range",
    table: {
      v: 1, template: "grouped", col_titles: ["A", "B", "C"], row_titles: ["d1", "d2"], x_title: "X", n_rep: 2, x: [],
      cells: [[["1", "2"], ["3", "4"], ["5", "6"]], [["2", "3"], ["4", "5"], ["6", "7"]]],
    },
    analysis: A({ test: "two_way", posthoc: "bonferroni", compare: "control", control: 7, pairs: [[0, 1], [0, 5]] }),
    figure: { graph_type: "gdot", colors: [], labels: [] },
  },
  {
    // A graph type of another template: repaired on open.
    id: "xy-wrong-graph-type",
    table: {
      v: 1, template: "xy", col_titles: ["Response"], row_titles: [], x_title: "Dose", n_rep: 1,
      x: ["1", "2", "3", "4", "5", "6"], cells: col([[2.1, 3.9, 6.2, 7.8, 10.1, 11.8]]),
    },
    analysis: A({ test: "linreg", correlation: "pearson" }),
    figure: { graph_type: "bar", xlabel: "Dose", ylabel: "Y", colors: ["#5a7fa8"], labels: [""] },
  },
  {
    // A record written by this version: ids are stored and kept.
    id: "xy-replicates-with-ids",
    table: {
      v: 1, template: "xy", col_titles: ["S1", "S2"], row_titles: ["", "", ""], x_title: "Time", n_rep: 2, x: ["0", "1", "2"],
      cells: [[["1", "1.1"], ["2", "2.2"]], [["2", "2.1"], ["3", "3.3"]], [["3", "3.2"], ["4", "4.1"]]],
      row_ids: ["row-aaaaaaaaaa", "row-bbbbbbbbbb", "row-cccccccccc"], col_ids: ["col-aaaaaaaaaa", "col-bbbbbbbbbb"],
    },
    analysis: A({ test: "linreg", correlation: "spearman" }),
    figure: { graph_type: "xy_line", colors: ["#4477aa", "#ee6677"], labels: ["first", "second"], palette: "app:Tol bright" },
  },
  {
    id: "column-empty",
    table: { v: 1, template: "column", col_titles: ["Group A", "Group B", "Group C"], row_titles: [], x_title: "X", n_rep: 1, x: [], cells: [] },
    analysis: {},
    figure: {},
  },
  {
    // Bare values instead of replicate lists, numbers instead of text, fewer
    // titles than data columns, no x_title.
    id: "legacy-bare-values",
    table: {
      template: "column", col_titles: ["One"], n_rep: 1,
      cells: [[1, 2, 3], [4, 5, 6], [7, null, 9]],
    },
    analysis: A({ test: "kruskal", posthoc: "dunn", compare: "control", control: 2 }),
    figure: { colors: ["#123456"], labels: ["one"] },
  },
  {
    // Damaged ids: duplicates, wrong count, non-strings.
    id: "ids-damaged",
    table: {
      v: 1, template: "column", col_titles: ["P", "Q"], row_titles: [], x_title: "X", n_rep: 1, x: [],
      cells: col([[1, 2, 3], [3, 4, 5]]),
      row_ids: ["row-dupdupdup0", "row-dupdupdup0", 42], col_ids: [null, "col-okokokokok", "col-extraextra"],
    },
    analysis: A({ test: "welch_t" }),
    figure: { graph_type: "box", colors: ["#111111", "#222222"], labels: ["", ""] },
  },
  {
    // A ggprism palette with its colour scheme, more colours than groups.
    id: "prism-palette-scheme",
    table: {
      v: 1, template: "column", col_titles: ["a", "b"], row_titles: [], x_title: "X", n_rep: 1, x: [],
      cells: col([[1, 2, 3], [2, 3, 5]]),
    },
    analysis: A({ test: "unpaired_t" }),
    figure: {
      graph_type: "violin", theme: "prism", palette: "prism:candy_bright", axis_scheme: true, palette_reverse: true,
      palette_colors: ["#FFC20A", "#0C7BDC", "#994F00"], colors: ["#0c7bdc", "#ffc20a", "#994f00", "#000000"], labels: ["x", "y", "z", "w"],
      prism_palette: "candy_bright",
    },
  },
  {
    // Duplicate, reversed, self and out-of-range pairs.
    id: "column-pairs-messy",
    table: {
      v: 1, template: "column", col_titles: ["A", "B", "C", "D"], row_titles: [], x_title: "X", n_rep: 1, x: [],
      cells: col([[1, 2, 3], [2, 3, 4], [5, 6, 7], [8, 9, 9.5]]),
    },
    analysis: A({ test: "anova", posthoc: "sidak", compare: "selected", pairs: [[0, 1], [1, 0], [2, 2], [0, 9], [3, 1]] }),
    figure: { graph_type: "dot", show_legend: false },
  },
  {
    // Typed but not yet a full table: one group with numbers keeps "none".
    id: "column-one-group",
    table: {
      v: 1, template: "column", col_titles: ["Only", "Group B", "Group C"], row_titles: [], x_title: "X", n_rep: 1, x: [],
      cells: col([[1, "abc", 3]]),
    },
    analysis: A({ test: "welch_t" }),
    figure: { graph_type: "bar" },
  },
];

/** Store calls replayed on every fixture (golden.json holds what the build
 *  before row/column ids produced at each step). */
export const EDIT_SCRIPT: [string, ...unknown[]][] = [
  ["setCell", 0, 0, 0, "7.5"],
  ["insertRow", 1],
  ["setCell", 1, 0, 0, "3"],
  ["setCell", 1, 0, 0, "3.25"],
  ["insertCol", 1],
  ["setColTitle", 1, "New"],
  ["paste", { row: 0, fc: 0 }, "9\t8\n7\t6\n5\t4"],
  ["setNRep", 2],
  ["deleteRow", 0],
  ["deleteCol", 0],
  ["clearRow", 0],
  ["undo"],
  ["sendBlock", { row: -1, fc: 0 }, "T1\tT2\tT3\n1\t2\t3\n4\t5\t6", true],
  ["clearCol", 0],
  ["undo"],
  ["undo"],
  ["setX", 0, "0.5"],
  ["setRowTitle", 0, "first"],
  ["setXTitle", "Conc"],
  ["setAnalysis", { within: "columns" }],
  ["insertRow", 0],
  ["deleteRow", 2],
  ["setAnalysis", { within: "rows", control: 1 }],
  ["insertCol", 0],
  ["deleteCol", 2],
  ["paste", { row: 2, fc: 1 }, "1\t2\t3\t4\t5\t6\t7\t8\t9\t10\t11\t12\t13\t14\t15\t16\t17\t18\t19\t20\t21\t22\t23\t24\t25\t26\t27\t28\t29\t30"],
  ["paste", { row: 497, fc: 0 }, "1\n2\n3\n4\n5"],
  ["setNRep", 1],
  ["undo"],
  ["deleteCol", 3],
  ["undo"],
  ["undo"],
];
