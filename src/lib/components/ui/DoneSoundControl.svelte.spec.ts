import { beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import { DONE_SOUND_STORAGE_KEY } from "$lib/state/done-sound.svelte";
import DoneSoundControlHost from "./DoneSoundControlHost.test.svelte";

/**
 * The pupil's switch for the done sound (PRD §20).
 *
 * Easy to turn off is the requirement: twenty-five laptops chiming at once is a
 * real risk in a classroom. It shows what this device will do, whichever of the
 * classroom and the pupil decided it.
 */
describe("DoneSoundControl", () => {
  beforeEach(() => localStorage.removeItem(DONE_SOUND_STORAGE_KEY));

  it("shows the classroom's default until the pupil chooses", async () => {
    render(DoneSoundControlHost, { classroomDefault: "off" });

    await expect
      .element(page.getByRole("switch", { name: m.chat_done_sound_label() }))
      .toHaveAttribute("aria-checked", "false");
  });

  it("turns the sound off in one click, and remembers it on this device", async () => {
    render(DoneSoundControlHost, { classroomDefault: "on" });
    const control = page.getByRole("switch", { name: m.chat_done_sound_label() });

    await expect.element(control).toHaveAttribute("aria-checked", "true");
    await control.click();

    await expect.element(control).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem(DONE_SOUND_STORAGE_KEY)).toBe("off");
  });
});
