<script lang="ts">
import { type SuperValidated, superForm } from "sveltekit-superforms";
import type * as v from "valibot";
import { ATTACHMENT_MEDIA_TYPES, type AttachmentMediaType } from "$lib/attachments";
import FieldError from "$lib/components/ui/FieldError.svelte";
import * as m from "$lib/paraglide/messages";
import type { ToolPolicySchema } from "$lib/server/classroom/schemas";

/**
 * What a class may do with tools, skills and files (PRD §11, §12, §15).
 *
 * The permission mode carries a prominent warning on Open, because §11 asks for
 * one at the point of selection — an educator choosing it should read what it
 * means without opening anything.
 *
 * Byte caps are shown in megabytes and kilobytes because that is how an educator
 * thinks about a photograph and a code file; the conversion happens here rather
 * than in the schema, which stays in the unit the validator enforces.
 */

type ToolPolicyData = v.InferOutput<typeof ToolPolicySchema>;

interface Props {
  data: SuperValidated<ToolPolicyData>;
}

let { data }: Props = $props();

// svelte-ignore state_referenced_locally
const { form, errors, enhance, submitting } = superForm(data, {
  id: "tool-policy",
  /**
   * An edit form, so it must not reset (PRD §8).
   *
   * Superforms resets to the data it was initialised with after a successful
   * submit unless told otherwise, which on a settings form means the teacher
   * types a new value, presses Save, and watches the field snap back to the old
   * one. The write had in fact succeeded; only the screen disagreed, and the
   * natural reading is that saving does not work.
   */
  resetForm: false,
});

/**
 * One sentence per media type, keyed by the server's own union — so a format
 * added to the sniffer without a label here fails `svelte-check` rather than
 * showing an educator a raw MIME type (§21).
 */
const ATTACHMENT_TYPE_LABELS: Record<AttachmentMediaType, () => string> = {
  "image/png": m.educator_attachment_type_image_png,
  "image/jpeg": m.educator_attachment_type_image_jpeg,
  "image/webp": m.educator_attachment_type_image_webp,
  "image/gif": m.educator_attachment_type_image_gif,
  "text/plain": m.educator_attachment_type_text_plain,
};

const MB = 1024 * 1024;
const KB = 1024;

const field = "rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground";
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-sm font-medium text-foreground">{m.educator_tool_policy_title()}</h2>

  <form method="POST" action="?/saveToolPolicy" use:enhance class="flex flex-col gap-4">
    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">{m.educator_permission_mode_label()}</span>
      <select name="permissionMode" bind:value={$form.permissionMode} class="h-9 {field}">
        <option value="strict">{m.educator_permission_strict()}</option>
        <option value="standard">{m.educator_permission_standard()}</option>
        <option value="open">{m.educator_permission_open()}</option>
      </select>
    </label>

    {#if $form.permissionMode === "open"}
      <!-- "Selecting it shows a prominent warning in the panel" (§11). -->
      <p
        class="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        role="status"
      >
        {m.educator_permission_open_warning()}
      </p>
    {/if}

    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">{m.educator_skill_authoring_label()}</span>
      <select
        name="skillAuthoringPolicy"
        bind:value={$form.skillAuthoringPolicy}
        class="h-9 {field}"
      >
        <option value="immediate">{m.educator_skill_authoring_immediate()}</option>
        <option value="pre-approval">{m.educator_skill_authoring_pre_approval()}</option>
        <option value="disabled">{m.educator_skill_authoring_disabled()}</option>
      </select>
    </label>

    <label class="flex items-center gap-2">
      <input
        type="checkbox"
        name="attachmentsEnabled"
        bind:checked={$form.attachmentsEnabled}
        class="size-4"
      >
      <span class="text-sm text-foreground">{m.educator_attachments_enabled_label()}</span>
    </label>

    <!--
      Which types, from the fixed set the sniffer can recognise (§10). A type it
      cannot produce would be an allowlist entry that never matches, so this is
      checkboxes rather than free text: an educator cannot be led to believe they
      have allowed something the pipeline has no handling for.
    -->
    <fieldset class="flex flex-col gap-1.5">
      <legend class="text-xs text-muted-foreground">{m.educator_attachment_types_label()}</legend>
      <div class="flex flex-wrap gap-x-5 gap-y-1.5">
        {#each ATTACHMENT_MEDIA_TYPES as mediaType (mediaType)}
          <label class="flex items-center gap-2">
            <input
              type="checkbox"
              name="attachmentTypes"
              value={mediaType}
              checked={$form.attachmentTypes.includes(mediaType)}
              onchange={(event) => {
  $form.attachmentTypes = event.currentTarget.checked
    ? [...$form.attachmentTypes, mediaType]
    : $form.attachmentTypes.filter((type) => type !== mediaType);
}}
              class="size-4"
            >
            <span class="text-sm text-foreground">{ATTACHMENT_TYPE_LABELS[mediaType]()}</span>
          </label>
        {/each}
      </div>
      <FieldError message={$errors.attachmentTypes?._errors} />
    </fieldset>

    <div class="grid gap-3 sm:grid-cols-3">
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">{m.educator_attachment_image_cap_label()}</span>
        <input
          type="number"
          min="1"
          value={Math.round($form.attachmentImageMaxBytes / MB)}
          oninput={(event) => {
  $form.attachmentImageMaxBytes = Math.max(1, Number(event.currentTarget.value)) * MB;
}}
          class="h-9 {field}"
        >
        <input type="hidden" name="attachmentImageMaxBytes" value={$form.attachmentImageMaxBytes}>
        <FieldError message={$errors.attachmentImageMaxBytes} />
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">{m.educator_attachment_text_cap_label()}</span>
        <input
          type="number"
          min="1"
          value={Math.round($form.attachmentTextMaxBytes / KB)}
          oninput={(event) => {
  $form.attachmentTextMaxBytes = Math.max(1, Number(event.currentTarget.value)) * KB;
}}
          class="h-9 {field}"
        >
        <input type="hidden" name="attachmentTextMaxBytes" value={$form.attachmentTextMaxBytes}>
        <FieldError message={$errors.attachmentTextMaxBytes} />
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">{m.educator_attachment_count_label()}</span>
        <input
          name="attachmentMaxPerMessage"
          type="number"
          bind:value={$form.attachmentMaxPerMessage}
          class="h-9 {field}"
        >
        <FieldError message={$errors.attachmentMaxPerMessage} />
      </label>
    </div>

    <label class="flex flex-col gap-1 sm:max-w-xs">
      <span class="text-xs text-muted-foreground">{m.educator_image_tokens_label()}</span>
      <input
        name="imageTokenEquivalent"
        type="number"
        bind:value={$form.imageTokenEquivalent}
        class="h-9 {field}"
      >
      <FieldError message={$errors.imageTokenEquivalent} />
    </label>

    <button
      type="submit"
      disabled={$submitting}
      class="h-9 self-start rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
    >
      {m.educator_save()}
    </button>
  </form>
</section>
