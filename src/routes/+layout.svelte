<script lang="ts">
// The single UnoCSS entry point. presetWind4 ships its own preflight, so the
// Wind3 reset is deliberately not imported on top of it.
import "virtual:uno.css";
import "../app.css";
import { provideDoneSound } from "$lib/state/done-sound.svelte";
import { provideTheme } from "$lib/state/theme.svelte";
import { provideThinking } from "$lib/state/thinking.svelte";

let { children } = $props();

/**
 * Light or dark, for every route under this layout.
 *
 * Provided here rather than imported as a module singleton: a singleton in a
 * `.svelte.ts` module is shared across every SSR request on the server. The
 * inline script in `src/app.html` has already painted the right theme; this
 * takes over from it and follows the device while the tab is open.
 */
const theme = provideTheme();

$effect(() => theme.start());
$effect(() => theme.apply());

/**
 * Whether the pupil wants to see the model reason (§20).
 *
 * Beside the theme, for the same reasons — a device setting, held in context
 * rather than as a module singleton. There is no boot script for this one:
 * thinking does not affect first paint, so reading it in an effect is soon
 * enough, and the classroom's policy is enforced on the server regardless.
 */
const thinking = provideThinking();

$effect(() => thinking.start());

/** Whether this device chimes when an answer is done (§20): a device setting, beside these. */
const doneSound = provideDoneSound();

$effect(() => doneSound.start());
</script>

{@render children()}
