<script lang="ts">
import type { DoneSound } from "$lib/server/db/schema";
import { provideDoneSound } from "$lib/state/done-sound.svelte";
import DoneSoundControl from "./DoneSoundControl.svelte";

/**
 * The container the root layout provides, for a test that renders the control
 * on its own. A fixture, hence `.test.svelte`.
 */
let { classroomDefault }: { classroomDefault: DoneSound } = $props();

const doneSound = provideDoneSound();

$effect(() => doneSound.start());
</script>

<DoneSoundControl {classroomDefault} />
