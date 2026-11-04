import { getContext, setContext } from "svelte";
import type { DoneSound } from "$lib/server/db/schema";

/**
 * Whether this device chimes when an answer finishes (PRD §20).
 *
 * The classroom sets the default — a quiet room turns it off for everybody at
 * once — and a pupil can override it either way on their own device. Like the
 * theme and the thinking switch it belongs to the browser, not the account:
 * nothing about it is sent to the server or recorded against the pupil (§16).
 *
 * `auto` is "whatever the classroom says", and is stored as the absence of a
 * choice, so a pupil who never touched the switch follows the educator when the
 * educator changes their mind.
 *
 * The type import is erased at compile time.
 */

export const DONE_SOUND_PREFERENCES = ["auto", "on", "off"] as const;
export type DoneSoundPreference = (typeof DONE_SOUND_PREFERENCES)[number];

export const DONE_SOUND_STORAGE_KEY = "setun:done-sound";

export function isDoneSoundPreference(value: unknown): value is DoneSoundPreference {
  return typeof value === "string" && (DONE_SOUND_PREFERENCES as readonly string[]).includes(value);
}

/** The classroom's default and the device's choice, resolved to one answer. */
export function effectiveDoneSound(classroom: DoneSound, preference: DoneSoundPreference): boolean {
  return (preference === "auto" ? classroom : preference) === "on";
}

/**
 * Storage, where the browser allows it.
 *
 * A managed Chromebook profile can block site data so that the property access
 * itself throws; a blocked browser gets a choice that lasts as long as the page.
 */
function readStored(): string | null {
  try {
    return localStorage.getItem(DONE_SOUND_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(preference: DoneSoundPreference): void {
  try {
    if (preference === "auto") localStorage.removeItem(DONE_SOUND_STORAGE_KEY);
    else localStorage.setItem(DONE_SOUND_STORAGE_KEY, preference);
  } catch {
    // Nothing persists; the choice still holds for this document.
  }
}

export class DoneSoundState {
  preference = $state<DoneSoundPreference>("auto");

  /** Adopt the stored choice. No work on the server, where there is no storage. */
  start(): void {
    if (typeof window === "undefined") return;

    const stored = readStored();
    if (isDoneSoundPreference(stored)) this.preference = stored;
  }

  set(preference: DoneSoundPreference): void {
    this.preference = preference;
    writeStored(preference);
  }

  /**
   * Flip what this device does, as an explicit choice.
   *
   * Explicit rather than back to `auto`: a pupil who turned the sound off in a
   * room that chimes wants it off, not "off until the educator says otherwise".
   */
  toggle(classroom: DoneSound): void {
    this.set(effectiveDoneSound(classroom, this.preference) ? "off" : "on");
  }
}

const DONE_SOUND_KEY = Symbol("setun:done-sound");

/** One instance per render, in context: a module singleton is shared across SSR requests. */
export function provideDoneSound(): DoneSoundState {
  return setContext(DONE_SOUND_KEY, new DoneSoundState());
}

export function getDoneSound(): DoneSoundState {
  return getContext<DoneSoundState>(DONE_SOUND_KEY);
}
