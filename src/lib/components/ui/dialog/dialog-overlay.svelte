<script lang="ts">
import { Dialog as DialogPrimitive } from "bits-ui";
import { cn } from "$lib/utils.js";

let {
  ref = $bindable(null),
  class: className,
  ...restProps
}: DialogPrimitive.OverlayProps = $props();
</script>

<!--
	No backdrop blur: it is the compositing effect §20 names by name, and on a
	dual-core Celeron it costs a full-screen filter pass every frame the dialog
	animates. A heavier scrim reads the same and is free.
-->
<DialogPrimitive.Overlay
  bind:ref
  data-slot="dialog-overlay"
  class={cn(
  "bg-black/40 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 isolate z-50",
  className,
)}
  {...restProps}
/>
