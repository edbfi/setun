import { beforeEach, describe, expect, it } from "vitest";
import { DONE_SOUND_STORAGE_KEY, DoneSoundState, effectiveDoneSound } from "./done-sound.svelte";

/**
 * Whether an answer finishing chimes (PRD §16, §20, §22).
 *
 * The classroom sets the default; the pupil's device can override it either
 * way, and that choice lives in this browser and nowhere else.
 */

beforeEach(() => {
  localStorage.removeItem(DONE_SOUND_STORAGE_KEY);
});

describe("effectiveDoneSound", () => {
  it("follows the classroom until the pupil chooses", () => {
    expect(effectiveDoneSound("on", "auto")).toBe(true);
    expect(effectiveDoneSound("off", "auto")).toBe(false);
  });

  it("lets the pupil override the classroom either way", () => {
    expect(effectiveDoneSound("on", "off")).toBe(false);
    expect(effectiveDoneSound("off", "on")).toBe(true);
  });
});

describe("DoneSoundState", () => {
  it("starts on the classroom's default, stored as no choice at all", () => {
    const state = new DoneSoundState();
    state.start();

    expect(state.preference).toBe("auto");
    expect(localStorage.getItem(DONE_SOUND_STORAGE_KEY)).toBeNull();
  });

  it("turns off a chiming room's sound as an explicit choice, and back on", () => {
    const state = new DoneSoundState();

    state.toggle("on");
    expect(state.preference).toBe("off");
    expect(localStorage.getItem(DONE_SOUND_STORAGE_KEY)).toBe("off");

    state.toggle("on");
    expect(state.preference).toBe("on");
  });

  it("adopts what this browser already held, and ignores what it cannot read", () => {
    localStorage.setItem(DONE_SOUND_STORAGE_KEY, "off");
    const kept = new DoneSoundState();
    kept.start();
    expect(kept.preference).toBe("off");

    localStorage.setItem(DONE_SOUND_STORAGE_KEY, "loud");
    const ignored = new DoneSoundState();
    ignored.start();
    expect(ignored.preference).toBe("auto");
  });
});
