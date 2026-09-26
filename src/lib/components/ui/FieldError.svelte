<script lang="ts">
/**
 * One field's validation message (PRD §20, §21).
 *
 * Every one of these carries `role="alert"`, which is the whole point of the
 * component. Before it, a rejected form said what was wrong in red text that no
 * screen reader announced: the only live region on the page carried the page
 * title, so a pupil or an educator using one was told a form had been submitted
 * and never told it had been refused.
 *
 * A component rather than a convention, because a convention is what forty
 * hand-written spans had already failed to keep — one of them had the role and
 * the rest did not.
 *
 * `role="alert"` rather than `aria-live="polite"`: a validation message is the
 * answer to something the reader just did, and waiting for a pause to say a
 * field was rejected is waiting too long.
 */

interface Props {
  /**
   * Superforms hands an array of messages per field; a plain string is what the
   * hand-rolled actions return. Null, undefined and empty render nothing.
   */
  message?: string | readonly string[] | null;
  /** Set where a field points at its message with `aria-describedby`. */
  id?: string;
  /** `sm` for a form whose fields are `text-sm`; `xs` is the dense panel default. */
  size?: "xs" | "sm";
}

let { message, id, size = "xs" }: Props = $props();

const text = $derived(
  Array.isArray(message) ? (message[0] ?? null) : ((message as string) ?? null),
);
</script>

{#if text}
  <span
    {id}
    role="alert"
    class={size === "sm" ? "text-sm text-destructive" : "text-xs text-destructive"}
  >
    {text}
  </span>
{/if}
