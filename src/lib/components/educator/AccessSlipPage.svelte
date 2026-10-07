<script lang="ts">
import { fitTextSize, type QrPath } from "$lib/access-slips";
import type { CredentialCard } from "$lib/credentials";

interface PreparedSlip extends CredentialCard {
  readonly qr: QrPath | null;
}

interface Props {
  cards: readonly PreparedSlip[];
  classroomName: string;
  loginAddress: string;
  signInInstruction: string;
  codeInstruction: string;
  keepInstruction: string;
  pageLabel: string;
}

let {
  cards,
  classroomName,
  loginAddress,
  signInInstruction,
  codeInstruction,
  keepInstruction,
  pageLabel,
}: Props = $props();

const SLIP_WIDTH = 95;
const SLIP_HEIGHT = 69.25;
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 210 297"
  width="210mm"
  height="297mm"
  role="img"
  aria-label={pageLabel}
  data-access-slip-page
>
  <rect width="210" height="297" fill="#fff" />
  {#each cards as card, index (card.label)}
    {@const x = 10 + (index % 2) * SLIP_WIDTH}
    {@const y = 10 + Math.floor(index / 2) * SLIP_HEIGHT}
    {@const nicknameSize = fitTextSize(card.label, {
      maxWidth: 75,
      preferred: 5.2,
      minimum: 3.2,
    })}
    {@const codeSize = fitTextSize(card.code, {
      maxWidth: 84,
      preferred: 5.2,
      minimum: 3.4,
      widthFactor: 0.62,
    })}
    {@const classroomSize = fitTextSize(classroomName, {
      maxWidth: 36,
      preferred: 3.2,
      minimum: 2.2,
    })}
    {@const addressSize = fitTextSize(loginAddress, {
      maxWidth: 53,
      preferred: 2.7,
      minimum: 1.9,
    })}
    {@const signInSize = fitTextSize(signInInstruction, {
      maxWidth: 53,
      preferred: 2.8,
      minimum: 1.6,
    })}
    {@const codeInstructionSize = fitTextSize(codeInstruction, {
      maxWidth: 53,
      preferred: 2.8,
      minimum: 1.6,
    })}
    {@const keepInstructionSize = fitTextSize(keepInstruction, {
      maxWidth: 82,
      preferred: 2.4,
      minimum: 1.4,
      widthFactor: 0.7,
    })}
    <g transform={`translate(${x} ${y})`}>
      <title>{card.label}: {card.code}</title>
      <rect
        x="0.25"
        y="0.25"
        width="94.5"
        height="68.75"
        rx="1"
        fill="#fff"
        stroke="#999"
        stroke-width="0.35"
        stroke-dasharray="2 1.5"
      />

      <g transform="translate(5 4.5) scale(0.265625)">
        <rect width="32" height="32" rx="7" fill="#111" />
        <g fill="#fff">
          <rect x="12" y="8.6" width="8" height="2.8" rx="1.4" />
          <circle cx="16" cy="15.8" r="2.1" />
          <rect x="12" y="21.4" width="8" height="2.8" rx="1.4" />
          <rect x="14.6" y="19.6" width="2.8" height="6.4" rx="1.4" />
        </g>
      </g>
      <text
        x="15"
        y="10.6"
        fill="#111"
        font-family="Helvetica, Arial, sans-serif"
        font-size="4.3"
        font-weight="700"
      >
        Setun
      </text>
      <text
        x="90"
        y="9.8"
        fill="#444"
        text-anchor="end"
        font-family="Helvetica, Arial, sans-serif"
        font-size={classroomSize}
      >
        {classroomName}
      </text>

      <text
        data-slip-label
        x="5"
        y="21"
        fill="#111"
        font-family="Helvetica, Arial, sans-serif"
        font-size={nicknameSize}
        font-weight="700"
      >
        {card.label}
      </text>
      <text
        data-slip-code
        x="5"
        y="30"
        fill="#000"
        font-family="Courier, monospace"
        font-size={codeSize}
        font-weight="700"
        letter-spacing="0.12"
      >
        {card.code}
      </text>

      <text
        x="5"
        y="38"
        fill="#222"
        font-family="Helvetica, Arial, sans-serif"
        font-size={signInSize}
      >
        {signInInstruction}
      </text>
      <text
        x="5"
        y="43"
        fill="#222"
        font-family="Helvetica, Arial, sans-serif"
        font-size={codeInstructionSize}
      >
        {codeInstruction}
      </text>
      <text
        x="5"
        y="49"
        fill="#111"
        font-family="Helvetica, Arial, sans-serif"
        font-size={addressSize}
        font-weight="700"
      >
        {loginAddress}
      </text>
      <text
        x="5"
        y="65"
        fill="#444"
        font-family="Helvetica, Arial, sans-serif"
        font-size={keepInstructionSize}
      >
        {keepInstruction}
      </text>

      {#if card.qr}
        {@const qrScale = 27 / card.qr.size}
        <g transform={`translate(63 34) scale(${qrScale})`}>
          <rect width={card.qr.size} height={card.qr.size} fill="#fff" />
          <path d={card.qr.path} fill="#000" />
        </g>
      {/if}
    </g>
  {/each}
</svg>
