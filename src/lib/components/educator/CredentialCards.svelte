<script lang="ts">
import {
  type AccessSlipScope,
  accessSlipFilename,
  accessSlipLoginUrl,
  createQrPath,
  paginateAccessSlips,
  type QrPath,
} from "$lib/access-slips";
import type { CredentialCard } from "$lib/credentials";
import * as m from "$lib/paraglide/messages";
import type { Locale } from "$lib/paraglide/runtime";
import AccessSlipPage from "./AccessSlipPage.svelte";

interface PreparedSlip extends CredentialCard {
  readonly qr: QrPath | null;
}

interface Props {
  cards: CredentialCard[];
  classroomName: string;
  locale: Locale;
  appOrigin: string;
  scope?: AccessSlipScope;
}

let { cards, classroomName, locale, appOrigin, scope = "classroom" }: Props = $props();

let previewRoot = $state<HTMLDivElement>();
let downloading = $state(false);
let pdfFailed = $state(false);

const cardLocale = $derived({ locale });
const loginAddress = $derived(new URL("/login", appOrigin).toString());
const prepared = $derived.by(() => {
  let qrFailed = false;
  const slips: PreparedSlip[] = cards.map((card) => {
    try {
      return { ...card, qr: createQrPath(accessSlipLoginUrl(appOrigin, card.code)) };
    } catch {
      qrFailed = true;
      return { ...card, qr: null };
    }
  });
  return { pages: paginateAccessSlips(slips), qrFailed };
});
const filename = $derived(
  accessSlipFilename({
    scope,
    classroomName,
    nickname: cards.length === 1 ? cards[0]?.label : undefined,
  }),
);

async function downloadPdf(): Promise<void> {
  downloading = true;
  pdfFailed = false;
  try {
    if (!previewRoot) throw new Error("access-slip preview is unavailable");
    const pageElements = previewRoot.querySelectorAll<SVGSVGElement>("svg[data-access-slip-page]");
    const { createAccessSlipPdf } = await import("$lib/access-slip-pdf");
    const blob = await createAccessSlipPdf([...pageElements]);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch {
    pdfFailed = true;
  } finally {
    downloading = false;
  }
}
</script>

{#if cards.length > 0}
  <section class="print-cards flex flex-col gap-4 rounded-md border border-primary p-4">
    <div class="no-print flex flex-col gap-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-col gap-1">
          <h2 class="text-sm font-medium text-foreground">{m.educator_slips_title()}</h2>
          <p class="text-xs text-muted-foreground">
            {scope === "student"
              ? m.educator_slip_ready_student({ label: cards[0]?.label ?? "" })
              : m.educator_slip_ready_classroom({ count: cards.length })}
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            onclick={() => window.print()}
            class="h-9 rounded-md border border-input px-3 text-sm font-medium text-foreground hover:bg-secondary"
          >
            {m.educator_print()}
          </button>
          <button
            type="button"
            onclick={downloadPdf}
            disabled={downloading}
            class="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {downloading ? m.educator_slip_downloading() : m.educator_slip_download()}
          </button>
        </div>
      </div>

      <p class="text-xs text-destructive">{m.educator_cards_once()}</p>
      <p class="text-xs text-muted-foreground">{m.educator_slip_security()}</p>
      {#if prepared.qrFailed}
        <p class="text-xs text-destructive" role="alert">{m.educator_slip_qr_warning()}</p>
      {/if}
      {#if pdfFailed}
        <p class="text-xs text-destructive" role="alert">{m.educator_slip_pdf_failed()}</p>
      {/if}
    </div>

    <div class="page-stack flex flex-col items-center gap-4" bind:this={previewRoot}>
      {#each prepared.pages as page, index (`${index}-${page[0]?.label}`)}
        <div class="access-slip-page w-full overflow-hidden bg-white shadow-sm">
          <AccessSlipPage
            cards={page}
            {classroomName}
            {loginAddress}
            signInInstruction={m.educator_slip_sign_in_instruction({}, cardLocale)}
            codeInstruction={m.educator_slip_code_instruction({}, cardLocale)}
            keepInstruction={m.educator_slip_keep_instruction({}, cardLocale)}
            pageLabel={m.educator_slip_page_label({
              page: index + 1,
              pages: prepared.pages.length,
            })}
          />
        </div>
      {/each}
    </div>
  </section>
{/if}

<style>
.access-slip-page {
  max-inline-size: 210mm;
  aspect-ratio: 210 / 297;
}

.access-slip-page :global(svg) {
  display: block;
  inline-size: 100%;
  block-size: auto;
}

@media print {
  @page {
    size: A4;
    margin: 0;
  }

  :global(body *) {
    visibility: hidden;
  }

  .print-cards,
  .print-cards * {
    visibility: visible;
  }

  .print-cards {
    position: absolute;
    inset: 0;
    gap: 0;
    inline-size: 210mm;
    margin: 0;
    padding: 0;
    border: 0;
  }

  .no-print {
    display: none;
  }

  .page-stack {
    gap: 0;
  }

  .access-slip-page {
    inline-size: 210mm;
    block-size: 297mm;
    max-inline-size: none;
    break-after: page;
    box-shadow: none;
  }

  .access-slip-page:last-child {
    break-after: auto;
  }
}
</style>
