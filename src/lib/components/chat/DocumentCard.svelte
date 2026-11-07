<script lang="ts">
import FileText from "@lucide/svelte/icons/file-text";
import Sheet from "@lucide/svelte/icons/sheet";
import * as m from "$lib/paraglide/messages";

/**
 * A document the model wrote, as a download (docx or csv).
 *
 * The link is same-origin and owner-scoped; the server answers with an
 * attachment, so the browser saves the file rather than opening it. No preview:
 * the file is meant for Word or a spreadsheet, and rendering its insides here
 * would be a second parser of model output for no gain. If the pupil has since
 * deleted it from Creations, the link answers 404 and this card stays as it is.
 */
interface Props {
  documentId: string;
  title: string;
  format: "docx" | "csv";
}

let { documentId, title, format }: Props = $props();

const formatLabel = $derived(
  format === "csv" ? m.chat_document_format_csv() : m.chat_document_format_docx(),
);
</script>

<a
  href="/api/documents/{documentId}"
  download
  class="my-1 flex max-w-sm items-center gap-2.5 rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-secondary"
  data-document-format={format}
>
  {#if format === "csv"}
    <Sheet class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
  {:else}
    <FileText class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
  {/if}
  <span class="flex min-w-0 flex-1 flex-col">
    <span class="truncate font-medium text-foreground">{title}</span>
    <span class="text-xs text-muted-foreground">{formatLabel}</span>
  </span>
  <span class="shrink-0 text-xs text-primary">{m.chat_document_download()}</span>
</a>
