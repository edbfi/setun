import { describe, expect, it } from "bun:test";
import { doneCue } from "./done-cue";

describe("doneCue", () => {
  it("chimes for a finished answer when sound is on, and badges a background tab", () => {
    expect(doneCue("stop", { soundOn: true, hidden: false })).toEqual({
      chime: true,
      badge: false,
    });
    expect(doneCue("stop", { soundOn: true, hidden: true })).toEqual({ chime: true, badge: true });
  });

  it("stays silent where the classroom or the pupil turned the sound off, but still badges", () => {
    expect(doneCue("stop", { soundOn: false, hidden: true })).toEqual({
      chime: false,
      badge: true,
    });
  });

  it("does neither when no answer was delivered", () => {
    for (const reason of ["aborted", "error", "interrupted"]) {
      expect(doneCue(reason, { soundOn: true, hidden: true })).toEqual({
        chime: false,
        badge: false,
      });
    }
  });

  it("cues an answer a cap or the length limit cut short: it is on screen", () => {
    for (const reason of ["truncated", "budget", "student-allowance-exhausted"]) {
      expect(doneCue(reason, { soundOn: true, hidden: false }).chime).toBe(true);
    }
  });
});
