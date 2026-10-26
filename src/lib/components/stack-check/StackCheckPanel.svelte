<script lang="ts">
import { Button } from "$lib/components/ui/button/index.js";
import * as Dialog from "$lib/components/ui/dialog/index.js";
import * as m from "$lib/paraglide/messages";

let open = $state(false);
</script>

<section class="flex flex-col gap-6">
  <div class="flex flex-col gap-2">
    <h2 class="text-lg font-semibold text-foreground">{m.stack_check_variant_heading()}</h2>
    <div class="flex flex-wrap items-center gap-2">
      <Button>{m.stack_check_open_dialog()}</Button>
      <Button variant="secondary">{m.stack_check_open_dialog()}</Button>
      <Button variant="outline">{m.stack_check_open_dialog()}</Button>
      <Button variant="ghost">{m.stack_check_open_dialog()}</Button>
      <Button variant="destructive">{m.stack_check_open_dialog()}</Button>
      <Button variant="link">{m.stack_check_open_dialog()}</Button>
    </div>
  </div>

  <div class="flex flex-col gap-2">
    <h2 class="text-lg font-semibold text-foreground">{m.stack_check_colour_heading()}</h2>
    <div class="flex flex-wrap items-center gap-3">
      <div class="size-12 rounded-md bg-primary" data-testid="swatch-primary"></div>
      <div class="size-12 rounded-md bg-sidebar" data-testid="swatch-sidebar"></div>
      <div class="size-12 rounded-md bg-chart-1" data-testid="swatch-chart-1"></div>
    </div>
  </div>

  <div class="flex flex-col gap-2">
    <h2 class="text-lg font-semibold text-foreground">{m.stack_check_radius_heading()}</h2>
    <div class="flex flex-wrap items-center gap-3">
      <div class="size-12 rounded-sm bg-primary" data-testid="radius-sm"></div>
      <div class="size-12 rounded-md bg-primary" data-testid="radius-md"></div>
      <div class="size-12 rounded-lg bg-primary" data-testid="radius-lg"></div>
      <div class="size-12 rounded-xl bg-primary" data-testid="radius-xl"></div>
    </div>
  </div>

  <div class="flex flex-col gap-2">
    <h2 class="text-lg font-semibold text-foreground">{m.stack_check_font_heading()}</h2>
    <p class="font-sans text-foreground" data-testid="font-sans">{m.stack_check_font_sans()}</p>
    <p class="font-mono text-foreground" data-testid="font-mono">{m.stack_check_font_mono()}</p>
    <p class="font-serif text-foreground" data-testid="font-serif">{m.stack_check_font_serif()}</p>
  </div>

  <Dialog.Root bind:open>
    <Dialog.Trigger>
      {#snippet child({ props })}
        <Button {...props} data-testid="dialog-trigger">{m.stack_check_open_dialog()}</Button>
      {/snippet}
    </Dialog.Trigger>
    <Dialog.Content>
      <Dialog.Header>
        <Dialog.Title>{m.stack_check_dialog_title()}</Dialog.Title>
        <Dialog.Description>{m.stack_check_dialog_description()}</Dialog.Description>
      </Dialog.Header>
      <Dialog.Footer>
        <Button variant="secondary" data-testid="dialog-close" onclick={() => (open = false)}>
          {m.stack_check_dialog_close()}
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
</section>
