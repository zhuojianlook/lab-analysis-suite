import { describe, expect, it } from "vitest";
import { engineStatusLine, isFreshOk, judgeHealthBody, nextPollDelayMs, START_GRACE_MS, wasRestarted } from "./engineHealth";

describe("judgeHealthBody (browser preview)", () => {
  it("another app's engine answering {status: ok} is not ours", () => {
    expect(judgeHealthBody('{"status":"ok"}').state).toBe("foreign");
    expect(judgeHealthBody('{"detail":"Not Found"}').state).toBe("foreign");
    expect(judgeHealthBody("<html>").state).toBe("foreign");
    expect(judgeHealthBody("null").state).toBe("foreign");
  });
  it("this app's engine is ok", () => {
    expect(judgeHealthBody('{"status":"ok","app":"lab-analysis-suite"}').state).toBe("ok");
    expect(judgeHealthBody('{"status":"ok","app":"lab-analysis-suite","token":"x"}').state).toBe("ok");
  });
});

describe("nextPollDelayMs", () => {
  it("keeps watching once ok, polls fast while not ok", () => {
    expect(nextPollDelayMs("ok", 0)).toBe(10_000);
    expect(nextPollDelayMs("starting", 5_000)).toBe(1_000);
    expect(nextPollDelayMs("restarting", 5_000)).toBe(1_000);
    expect(nextPollDelayMs("down", 5_000)).toBe(2_000);
    expect(nextPollDelayMs("foreign", START_GRACE_MS + 1)).toBe(5_000);
  });
});

describe("engineStatusLine", () => {
  it("never shows ready for another program", () => {
    const l = engineStatusLine({ state: "foreign", detail: "Another program is answering on the engine's port 8765" }, 0, "");
    expect(l.tone).toBe("error");
    expect(l.label).not.toMatch(/ready/i);
  });
  it("reflects starting, restarting, down", () => {
    expect(engineStatusLine({ state: "ok" }, 0, "").label).toBe("Engine ready");
    expect(engineStatusLine({ state: "starting" }, 1_000, "").label).toBe("Engine starting…");
    const late = engineStatusLine({ state: "starting" }, START_GRACE_MS + 1, "Traceback: boom");
    // Still starting after the grace period: not claimed to be down (the app
    // restarts a hung engine and reports "down" itself if that fails).
    expect(late).toMatchObject({ label: "Engine slow to start", tone: "warn", detail: "Traceback: boom" });
    expect(engineStatusLine({ state: "restarting" }, 0, "").label).toBe("Engine restarting…");
    expect(engineStatusLine({ state: "down", detail: "The analysis engine isn't answering." }, 0, "").tone).toBe("error");
  });
});

describe("isFreshOk", () => {
  it("counts coming up, coming back, and a restart between two polls", () => {
    expect(isFreshOk({ state: "checking" }, { state: "ok", generation: 1 })).toBe(true);
    expect(isFreshOk({ state: "restarting" }, { state: "ok", generation: 2 })).toBe(true);
    expect(isFreshOk({ state: "ok", generation: 1 }, { state: "ok", generation: 2 })).toBe(true);
    expect(isFreshOk({ state: "ok", generation: 2 }, { state: "ok", generation: 2 })).toBe(false);
    expect(isFreshOk({ state: "ok" }, { state: "ok" })).toBe(false); // browser preview: no generation
    expect(isFreshOk({ state: "ok", generation: 2 }, { state: "down" })).toBe(false);
  });
});

describe("wasRestarted", () => {
  it("is true only for a new engine generation after an earlier ok", () => {
    expect(wasRestarted(undefined, { state: "ok", generation: 1 })).toBe(false); // first start
    expect(wasRestarted(1, { state: "ok", generation: 1 })).toBe(false); // same engine back after a blip
    expect(wasRestarted(1, { state: "ok", generation: 2 })).toBe(true);
    expect(wasRestarted(1, { state: "down", generation: 2 })).toBe(false);
    expect(wasRestarted(1, { state: "ok" })).toBe(false); // browser preview
  });
});
