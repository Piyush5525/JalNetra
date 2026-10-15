import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify } from "../src/monitor.js";

const P = { id: 7, river: "Test", near: "Here", state: "X", glat: 0, glng: 0, p50: 100, p90: 200, max: 300 };
const days = ["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"];
const today = "2026-10-11";
const flow = (v: number[]) => [50, 50, ...v]; // two past days, then today onwards

describe("river classification", () => {
  it("flags DANGER above the 2025 maximum", () => assert.equal(classify(P, days, flow([120, 150, 320, 310, 200, 150, 120, 100]), today)[1], "DANGER"));
  it("flags WARNING above a high monsoon day", () => assert.equal(classify(P, days, flow([120, 150, 220, 210, 200, 150, 120, 100]), today)[1], "WARNING"));
  it("flags RISING for a quick rise above a normal day", () => assert.equal(classify(P, days, flow([100, 110, 130, 150, 160, 150, 120, 100]), today)[1], "RISING"));
  it("keeps a steady river NORMAL", () => assert.equal(classify(P, days, flow([100, 100, 105, 100, 100, 100, 100, 100]), today)[1], "NORMAL"));
  it("does not flag a trickle even when it beats a tiny baseline", () => {
    const small = { ...P, p50: 4, p90: 8, max: 14 };
    assert.equal(classify(small, days, flow([21, 21, 20, 18, 17, 16, 15, 14]), today)[1], "NORMAL");
  });
  it("reports a rising trend with the peak day", () => {
    const r = classify(P, days, flow([100, 110, 130, 150, 160, 150, 120, 100]), today);
    assert.equal(r[6], "rising"); assert.equal(r[4], 4);
  });
});
