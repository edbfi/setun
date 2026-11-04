/**
 * What an answer finishing should do on this device (PRD §20).
 *
 * Pure, so the branches the chat page acts on are testable without a page: a
 * chime where the classroom's default and this device agree it is on, and a ✓
 * in the tab title while the tab is in the background.
 *
 * Neither for a turn that did not deliver an answer — the pupil stopped it, it
 * failed, or the server restarted under it. A pleasant "done" over an error
 * reads as success. A turn cut short by a cap or the model's own length limit
 * still cues: its partial answer is on screen, and the notice says why it
 * stopped.
 */
const NO_ANSWER: ReadonlySet<string> = new Set(["aborted", "error", "interrupted"]);

export interface DoneCue {
  readonly chime: boolean;
  /** Mark the tab title until the pupil comes back to it. */
  readonly badge: boolean;
}

export function doneCue(
  reason: string,
  device: { readonly soundOn: boolean; readonly hidden: boolean },
): DoneCue {
  if (NO_ANSWER.has(reason)) return { chime: false, badge: false };
  return { chime: device.soundOn, badge: device.hidden };
}
