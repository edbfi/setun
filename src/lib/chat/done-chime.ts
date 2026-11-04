/**
 * The sound an answer finishing makes (PRD §20).
 *
 * Synthesised rather than fetched: no asset, no request, nothing that leaves
 * the page — and a sound file is one more thing a strict school proxy can
 * block. Two soft sine notes a fourth apart, under half a second, quiet enough
 * that one laptop is a cue and not an alarm.
 *
 * Best effort by design. A browser that has no Web Audio, refuses to start a
 * context, or blocks sound until the page is touched simply stays silent: the
 * visible "Done" is the cue that always works, and this is the one that can
 * be heard from across the room.
 */

/** The notes, in hertz, and when each starts relative to the first. */
const NOTES = [
  { frequency: 659.25, at: 0 }, // E5
  { frequency: 880, at: 0.12 }, // A5
] as const;

/** Peak gain. Deliberately low: the room is full of laptops. */
const PEAK = 0.06;
const NOTE_SECONDS = 0.32;

type AudioContextConstructor = new () => AudioContext;

let shared: AudioContext | null = null;

function context(): AudioContext | null {
  if (shared) return shared;
  if (typeof window === "undefined") return null;

  const Constructor =
    (window as unknown as { AudioContext?: AudioContextConstructor }).AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
  if (!Constructor) return null;

  try {
    shared = new Constructor();
  } catch {
    return null;
  }
  return shared;
}

/**
 * Warm the audio context up from a user gesture (pressing Send).
 *
 * Autoplay policy lets a page start sound only after the pupil has interacted
 * with it; resuming the context inside the click is what makes the chime at
 * the end of a forty-second answer allowed to play.
 */
export function primeDoneChime(): void {
  const audio = context();
  if (audio?.state === "suspended") void audio.resume().catch(() => {});
}

export function playDoneChime(): void {
  const audio = context();
  if (!audio) return;

  try {
    if (audio.state === "suspended") void audio.resume().catch(() => {});
    const start = audio.currentTime + 0.02;

    for (const note of NOTES) {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const at = start + note.at;

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(note.frequency, at);

      // A short attack and an exponential tail: a chime rather than a beep.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(PEAK, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_SECONDS);

      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(at);
      oscillator.stop(at + NOTE_SECONDS + 0.05);
    }
  } catch {
    // Silent is an acceptable outcome; see above.
  }
}
