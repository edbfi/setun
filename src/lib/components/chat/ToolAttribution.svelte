<script lang="ts">
import * as m from "$lib/paraglide/messages";

/**
 * Who is asking (PRD §11).
 *
 * "Permission requests are rendered with the same unmissable server attribution
 * as elicitation." Unmissable is the requirement, so attribution is a *structural*
 * device rather than a line of small print: a rule down the left edge and an
 * eyebrow naming the source, repeated identically on every tool prompt and every
 * tool trace, so the shape itself comes to mean "this is not the assistant
 * talking — something else is asking".
 *
 * A dotted rule means the turn is waiting on the pupil; a solid one means it has
 * already happened. Nothing else changes between the two states, which is what
 * makes the difference legible at a glance on a small screen (§20).
 */
interface Props {
  /** The MCP server's own label, or null for a tool built into Setun (§11). */
  serverLabel: string | null;
  /** Waiting on the pupil, rather than reporting what happened. */
  pending?: boolean;
}

let { serverLabel, pending = false }: Props = $props();
</script>

<span
  class={[
  "flex items-center gap-2 border-l-2 pl-2 text-[0.6875rem] font-medium uppercase tracking-[0.12em]",
  pending
    ? "border-dotted border-primary text-primary"
    : "border-solid border-border text-muted-foreground",
]}
>
  {serverLabel ? m.chat_permission_from({ server: serverLabel }) : m.chat_permission_internal()}
</span>
