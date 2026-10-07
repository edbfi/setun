<script lang="ts">
import * as m from "$lib/paraglide/messages";
import type { SetupStep } from "$lib/server/setup/state";
import { setupStepLabel } from "./labels";

/**
 * Where the operator is, and how much is left (PRD §17).
 *
 * A list rather than links: the steps a person may jump to are decided by what
 * has been persisted, and a nav that offered a step the server would refuse
 * would be a nav that lies. Moving between steps happens through each step's own
 * back and continue controls, which the server has already agreed to.
 */

interface Props {
  steps: SetupStep[];
  current: SetupStep;
}

let { steps, current }: Props = $props();

const position = $derived(steps.indexOf(current) + 1);
</script>

<nav class="flex flex-col gap-2" aria-label={m.setup_title()}>
  <p class="text-xs uppercase tracking-[0.12em] text-muted-foreground">
    {m.setup_step_position({ current: position, total: steps.length })}
  </p>
  <ol class="flex flex-wrap gap-x-4 gap-y-1">
    {#each steps as step, index (step)}
      <li
        class={[
          "text-xs",
          step === current ? "font-medium text-foreground" : "text-muted-foreground",
        ]}
        aria-current={step === current ? "step" : undefined}
      >
        {index + 1}. {setupStepLabel(step)}
      </li>
    {/each}
  </ol>
</nav>
