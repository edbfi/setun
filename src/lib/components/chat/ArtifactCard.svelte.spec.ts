import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import type { MessageArtifactRef } from "$lib/state/conversation.svelte";
import ArtifactCard from "./ArtifactCard.svelte";

/**
 * The artifact card in the transcript (PRD §13, §20, §22).
 *
 * The card is the route from "here is the page" to the page. It is one control
 * rather than a label with a button parked on its end, and it says when it is
 * the thing currently on screen — which is what turns a column of similar cards
 * into a way of moving between builds.
 */

function ref(overrides: Partial<MessageArtifactRef> = {}): MessageArtifactRef {
  return {
    artifactId: "artifact-1",
    versionId: "version-1",
    revision: 2,
    key: "klikkeren",
    language: "html",
    title: "Klikkeren",
    buildStatus: "ok",
    ...overrides,
  };
}

describe("ArtifactCard", () => {
  it("names what was built and the identity the model reuses", async () => {
    render(ArtifactCard, { artifact: ref() });

    await expect
      .element(page.getByRole("button", { name: m.artifact_card_label({ title: "Klikkeren" }) }))
      .toBeVisible();
    // Identity is always the mono face, so code-things read as code-things.
    await expect.element(page.getByText("id=klikkeren · html · v2")).toBeVisible();
  });

  it("opens the artifact from the whole card", async () => {
    const opened = vi.fn();
    render(ArtifactCard, { artifact: ref(), onopen: opened });

    await page.getByRole("button", { name: m.artifact_card_label({ title: "Klikkeren" }) }).click();

    expect(opened).toHaveBeenCalledWith("artifact-1");
  });

  it("says when it is the one already on screen", async () => {
    render(ArtifactCard, { artifact: ref(), active: true });

    await expect.element(page.getByText(m.artifact_showing())).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: m.artifact_card_label({ title: "Klikkeren" }) }))
      .toHaveAttribute("aria-current", "true");
  });

  it("names an untitled artifact by its language rather than inventing one", async () => {
    render(ArtifactCard, { artifact: ref({ title: null }) });

    const title = m.artifact_untitled({ language: "html" });
    await expect
      .element(page.getByRole("button", { name: m.artifact_card_label({ title }) }))
      .toBeVisible();
  });
});

/**
 * What one write did, on the card it settled into (§13, §20).
 *
 * The same rows the write showed while it streamed, so the unit a pupil watched
 * arrive is the unit they open.
 */
describe("ArtifactCard — the write", () => {
  it("says a first revision is new and a later one updated", async () => {
    const first = await render(ArtifactCard, { artifact: ref({ revision: 1 }) });
    await expect
      .element(page.getByText(m.artifact_write_created(), { exact: false }))
      .toBeVisible();
    first.unmount();

    render(ArtifactCard, { artifact: ref({ revision: 2, modified: 1 }) });
    await expect
      .element(
        page.getByText(
          `${m.artifact_write_updated()} · ${m.artifact_history_modified({ count: 1 })}`,
        ),
      )
      .toBeVisible();
  });

  it("lists the files the write named, with the removed ones marked", async () => {
    render(ArtifactCard, {
      artifact: ref(),
      files: ["src/App.tsx", "src/old.ts"],
      deletes: ["src/old.ts"],
    });

    const rows = document.querySelectorAll("[data-file-state]");
    await expect.element(page.getByText("src/App.tsx")).toBeVisible();
    expect([...rows].map((row) => row.getAttribute("data-file-state"))).toEqual([
      "written",
      "deleted",
    ]);
    expect(rows[1].textContent).toContain(m.artifact_write_deleted());
    // Still one control: the rows are inside the card's button, not beside it.
    expect(rows[0].closest("button")).not.toBeNull();
  });

  it("shows no rows for a single-file page", async () => {
    render(ArtifactCard, { artifact: ref() });

    await expect.element(page.getByText("id=klikkeren · html · v2")).toBeVisible();
    expect(document.querySelectorAll("[data-file-state]")).toHaveLength(0);
  });
});
