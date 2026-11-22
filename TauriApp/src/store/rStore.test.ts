import { beforeEach, describe, expect, it, vi } from "vitest";

const checkR = vi.fn();
vi.mock("../api/client", () => ({ checkR: () => checkR() }));

import { useRStore } from "./rStore";

const R = { installed: true, version: "4.4.1", path: "/usr/local/bin/Rscript" };

describe("rStore.recheck", () => {
  beforeEach(() => {
    checkR.mockReset();
    useRStore.setState({ state: null, checking: false, failed: false, lastPath: "" });
  });

  it("keeps what is known when a probe fails (open tools stay open), and marks it for a retry", async () => {
    checkR.mockResolvedValueOnce(R);
    await useRStore.getState().recheck();
    expect(useRStore.getState()).toMatchObject({ state: R, failed: false, lastPath: R.path });

    checkR.mockRejectedValueOnce(new Error("The analysis engine isn't answering."));
    await useRStore.getState().recheck();
    expect(useRStore.getState()).toMatchObject({ state: R, failed: true, lastPath: R.path, checking: false });

    checkR.mockResolvedValueOnce(R);
    await useRStore.getState().recheck();
    expect(useRStore.getState().failed).toBe(false);
  });

  it("with nothing known yet, a failed probe reads as R not found (and is retried)", async () => {
    checkR.mockRejectedValueOnce(new Error("boom"));
    await useRStore.getState().recheck();
    expect(useRStore.getState()).toMatchObject({ state: { installed: false, path: "" }, failed: true, lastPath: "" });
  });

  it("a different R path replaces the key; an empty one does not", async () => {
    checkR.mockResolvedValueOnce(R);
    await useRStore.getState().recheck();
    checkR.mockResolvedValueOnce({ installed: false, version: "", path: "" });
    await useRStore.getState().recheck();
    expect(useRStore.getState().lastPath).toBe(R.path);
    useRStore.getState().setState({ ...R, path: "/opt/R/bin/Rscript" });
    expect(useRStore.getState().lastPath).toBe("/opt/R/bin/Rscript");
  });
});
