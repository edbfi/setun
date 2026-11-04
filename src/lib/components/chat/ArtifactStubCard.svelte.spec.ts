import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import type { StreamingDisplay } from "$lib/artifacts/segments";
import * as m from "$lib/paraglide/messages";
import ArtifactStubCard from "./ArtifactStubCard.svelte";

/** The text of the n-th file row of the write card on screen. */
function rowText(index: number): string {
  return page.getByRole("listitem").elements()[index]?.textContent ?? "";
}

type Write = Extract<StreamingDisplay, { kind: "write" }>;

function write(overrides: Partial<Write> = {}): Write {
  return {
    kind: "write",
    key: "tidslinje",
    title: null,
    language: "tsx",
    fileKind: "tsx",
    files: [],
    writing: true,
    ...overrides,
  };
}

it("does not label an anonymous runnable fence as a project file", async () => {
  render(ArtifactStubCard, {
    write: write({
      key: null,
      title: "Page",
      language: "html",
      fileKind: "html",
      files: [
        { path: "src/page.html", fileKind: "html", state: "writing", deleted: false, lines: 3 },
      ],
    }),
  });

  await expect.element(page.getByText("Page")).toBeVisible();
  await expect.element(page.getByText(m.artifact_write_writing())).toBeVisible();
  expect(document.body.textContent).not.toContain("src/page.html");
});

it("lists one write's files as rows, each with its own state", async () => {
  render(ArtifactStubCard, {
    write: write({
      title: "Tidslinje",
      files: [
        { path: "src/App.tsx", fileKind: "tsx", state: "written", deleted: false, lines: 40 },
        { path: "src/old.ts", fileKind: "ts", state: "written", deleted: true, lines: 0 },
        { path: "src/styles.css", fileKind: "css", state: "writing", deleted: false, lines: 12 },
      ],
    }),
  });

  await expect.element(page.getByRole("list", { name: m.artifact_write_files() })).toBeVisible();
  expect(rowText(0)).toContain("src/App.tsx");
  expect(rowText(0)).toContain(m.artifact_file_lines({ lines: 40 }));
  expect(rowText(1)).toContain(m.artifact_write_deleted());
  expect(rowText(2)).toContain(m.artifact_write_writing());
  expect(rowText(2)).toContain(m.artifact_file_lines({ lines: 12 }));
});

it("names a revision by the title the conversation already knows", async () => {
  // A revision's fences carry no title of their own.
  render(ArtifactStubCard, {
    write: write({
      language: null,
      fileKind: "css",
      files: [
        { path: "src/styles.css", fileKind: "css", state: "writing", deleted: false, lines: 2 },
      ],
    }),
    knownTitle: "Tidslinje",
  });

  await expect.element(page.getByText("Tidslinje")).toBeVisible();
  await expect.element(page.getByText("id=tidslinje · css")).toBeVisible();
});

it("says the write is done once its last file closed", async () => {
  render(ArtifactStubCard, {
    write: write({
      title: "Tidslinje",
      writing: false,
      files: [
        { path: "src/App.tsx", fileKind: "tsx", state: "written", deleted: false, lines: 40 },
      ],
    }),
  });

  await expect.element(page.getByText(m.artifact_write_written())).toBeVisible();
  await expect.element(page.getByText(m.artifact_write_writing())).not.toBeInTheDocument();
});
