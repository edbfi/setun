import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import { StreamingTurn } from "$lib/state/streaming-turn.svelte";
import StreamingMessage from "./StreamingMessage.svelte";

/**
 * The streaming message (plan 1.8, PRD §10, §20, §22).
 */

describe("StreamingMessage", () => {
  it("settles each reasoning block with its own duration, including a reasoning-only ending", async () => {
    let clock = 0;
    const turn = new StreamingTurn(() => clock);
    turn.begin("turn-1");
    turn.apply({ type: "thinking-delta", text: "First" }, 0);
    clock = 2_000;
    turn.apply({ type: "tool-result", toolCallId: "tool-1", result: "Found", isError: false }, 1);
    clock = 5_000;
    turn.apply({ type: "thinking-delta", text: "Second" }, 2);
    clock = 9_000;
    turn.apply({ type: "done", reason: "stop" }, 3);
    render(StreamingMessage, { turn });

    await expect.element(page.getByText(m.chat_thoughts_elapsed({ seconds: 2 }))).toBeVisible();
    await expect.element(page.getByText(m.chat_thoughts_elapsed({ seconds: 4 }))).toBeVisible();
  });

  it("renders nothing before a turn starts", async () => {
    const turn = new StreamingTurn();
    render(StreamingMessage, { turn });

    await expect.element(page.getByRole("article")).not.toBeInTheDocument();
  });

  it("shows a thinking placeholder until the first delta lands", async () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    render(StreamingMessage, { turn });

    // The static label is what assistive technology reads; the rotating line
    // beside it is `aria-hidden`, so it never interrupts (§20).
    await expect.element(page.getByRole("status")).toHaveTextContent(m.chat_thinking());
    await expect.element(page.getByText(m.chat_status_reading())).toBeVisible();
  });

  /**
   * A reasoning model can spend forty seconds before its first word, and a line
   * that never changes for forty seconds reads as a stall (§20).
   */
  it("moves through the statuses as the wait goes on, and stops on the last", async () => {
    let clock = 1_000;
    const turn = new StreamingTurn(() => clock);
    turn.begin("turn-1");
    render(StreamingMessage, { turn, now: () => clock });

    await expect.element(page.getByText(m.chat_status_reading())).toBeVisible();

    clock = 1_000 + 5_000;
    await expect.element(page.getByText(m.chat_status_planning())).toBeVisible();

    clock = 1_000 + 13_000;
    await expect.element(page.getByText(m.chat_status_writing())).toBeVisible();

    // Clamped, never cycling: going back to "Reading your message…" after
    // sixteen seconds would say the model had started over.
    clock = 1_000 + 60_000;
    await expect.element(page.getByText(m.chat_status_writing())).toBeVisible();
  });

  it("gives way the moment the reasoning itself is on screen", async () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    render(StreamingMessage, { turn });

    turn.apply({ type: "thinking-delta", text: "Overvejer opgaven" }, 0);

    // The block is collapsed, so its summary is what shows; the placeholder has
    // nothing left to say once the model is visibly reasoning.
    await expect.element(page.getByText(m.chat_status_reading())).not.toBeInTheDocument();
    expect(document.querySelector("summary")?.textContent).toContain("Overvejer opgaven");
  });

  it("keeps the placeholder when the classroom or the pupil hides the reasoning", async () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    render(StreamingMessage, { turn, showThinking: false });

    turn.apply({ type: "thinking-delta", text: "Overvejer opgaven" }, 0);

    await expect.element(page.getByText("Overvejer opgaven")).not.toBeInTheDocument();
    await expect.element(page.getByText(m.chat_status_reading())).toBeVisible();
  });

  it("drops the placeholder as soon as the answer begins", async () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    render(StreamingMessage, { turn });

    turn.apply({ type: "thinking-delta", text: "Overvejer" }, 0);
    turn.apply({ type: "text-delta", text: "Et loop" }, 1);

    await expect.element(page.getByText("Et loop")).toBeVisible();
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  });

  it("accumulates deltas into the streamed text", async () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    render(StreamingMessage, { turn });

    turn.apply({ type: "text-delta", text: "Et " }, 0);
    turn.apply({ type: "text-delta", text: "loop" }, 1);

    await expect.element(page.getByText("Et loop")).toBeVisible();
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  });

  it("renders streamed markdown as plain text, not as HTML", async () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    render(StreamingMessage, { turn });

    // While streaming, text stays preformatted — no markdown parsing per delta (§20).
    turn.apply({ type: "text-delta", text: "**fed** tekst" }, 0);

    await expect.element(page.getByText("**fed** tekst")).toBeVisible();
    expect(document.querySelector("strong")).toBeNull();
  });

  it("shows a stub while an artifact streams, and names it once the fence closes", async () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    render(StreamingMessage, { turn });

    turn.apply(
      { type: "text-delta", text: 'Her er siden:\n```html id=side title="Min side"\n<h1>' },
      0,
    );

    // Mid-fence: the pupil is told something is being built rather than shown
    // the markup arriving a word at a time (§13, §20).
    await expect
      .element(page.getByText(m.artifact_card_building({ title: "Min side" }), { exact: false }))
      .toBeVisible();
    await expect.element(page.getByText("Her er siden:")).toBeVisible();

    // The stub appearing is half of it. A partial leak — the card above the
    // markup it stood in for — would satisfy every assertion around this one,
    // and is the regression the stub exists to prevent.
    expect(document.body.textContent).not.toContain("<h1>");

    turn.apply({ type: "text-delta", text: "</h1>\n```\nFærdig." }, 1);

    await expect
      .element(page.getByText(m.artifact_card_building({ title: "Min side" }), { exact: false }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText("Min side")).toBeVisible();
    await expect.element(page.getByText("Færdig.")).toBeVisible();

    // Closed, the fence body is still the card's and not the prose's.
    expect(document.body.textContent).not.toContain("<h1>");
    expect(document.body.textContent).not.toContain("</h1>");
  });

  it("never renders model output as live HTML", async () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    render(StreamingMessage, { turn });

    turn.apply({ type: "text-delta", text: "<img src=x onerror=alert(1)>" }, 0);

    // Model output is untrusted source; the streaming view escapes it (§5, §21).
    expect(document.querySelector("img")).toBeNull();
    await expect.element(page.getByText("<img src=x onerror=alert(1)>")).toBeVisible();
  });

  it("tells the student when they stopped the answer", async () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    render(StreamingMessage, { turn });

    turn.apply({ type: "text-delta", text: "halvvejs" }, 0);
    turn.apply({ type: "done", reason: "aborted" }, 1);

    await expect.element(page.getByText(m.chat_notice_aborted())).toBeVisible();
    // Partial content is preserved, not discarded (§10).
    await expect.element(page.getByText("halvvejs")).toBeVisible();
  });

  it("tells the student when a restart cut the answer short", async () => {
    const turn = new StreamingTurn();
    turn.resume("turn-1", -1);
    render(StreamingMessage, { turn });

    turn.apply({ type: "done", reason: "interrupted" }, 0);

    await expect.element(page.getByText(m.chat_notice_interrupted())).toBeVisible();
  });

  it("names the allowance that ran out mid-answer", async () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    render(StreamingMessage, { turn });

    turn.apply({ type: "text-delta", text: "halvvejs" }, 0);
    turn.apply({ type: "done", reason: "student-allowance-exhausted" }, 1);

    await expect.element(page.getByText(m.chat_notice_student_allowance_exhausted())).toBeVisible();
    await expect.element(page.getByText("halvvejs")).toBeVisible();
  });

  it("names the class's cap when that is what ran out", async () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    render(StreamingMessage, { turn });

    turn.apply({ type: "done", reason: "classroom-cap-exhausted" }, 0);

    await expect.element(page.getByText(m.chat_notice_classroom_cap_exhausted())).toBeVisible();
  });

  it("tells the student when the model hit its own length limit", async () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    render(StreamingMessage, { turn });

    turn.apply({ type: "done", reason: "truncated" }, 0);

    await expect.element(page.getByText(m.chat_notice_truncated())).toBeVisible();
  });

  it("tells the student when a checkpoint went unanswered", async () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    render(StreamingMessage, { turn });

    turn.apply({ type: "done", reason: "budget" }, 0);

    await expect.element(page.getByText(m.chat_notice_budget())).toBeVisible();
  });

  it("shows a friendly notice on gateway failure, never a raw error", async () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    render(StreamingMessage, { turn });

    turn.apply({ type: "error", message: "gateway-detail-that-must-not-render" }, 0);
    turn.apply({ type: "done", reason: "error" }, 1);

    await expect.element(page.getByText(m.chat_notice_error())).toBeVisible();
    // The event's own message never surfaces: the student sees the localised
    // notice, and the internal detail stays server-side (§9, §21).
    expect(document.body.textContent).not.toContain("gateway-detail-that-must-not-render");
  });
});
