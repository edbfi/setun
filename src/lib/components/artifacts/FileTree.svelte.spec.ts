import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import FileTree from "./FileTree.svelte";

/**
 * The Build panel's file list (PRD §13, §20, §22).
 *
 * What is under test is which file a tap or an arrow lands on, and that a
 * keyboard user passing a five-file project spends one tab stop on it — not how
 * wide anything is, which is CSS.
 */

const PATHS = ["src/App.tsx", "src/lib/data.ts", "styles.css"];

function tree(overrides: Partial<Parameters<typeof render<typeof FileTree>>[1]> = {}) {
  return render(FileTree, {
    paths: PATHS,
    active: "src/App.tsx",
    entry: "src/App.tsx",
    onselect: () => {},
    ...overrides,
  });
}

describe("FileTree", () => {
  it("lists every file under the folders that hold them", async () => {
    tree();

    await expect.element(page.getByRole("tree")).toBeVisible();
    await expect.element(page.getByRole("treeitem", { name: /App\.tsx/ })).toBeVisible();
    await expect.element(page.getByRole("treeitem", { name: /data\.ts/ })).toBeVisible();
    await expect.element(page.getByRole("treeitem", { name: /styles\.css/ })).toBeVisible();
  });

  it("says which file runs", async () => {
    tree();

    const entry = page.getByRole("treeitem", { name: /App\.tsx/ });
    await expect.element(entry.getByText(m.artifact_file_entry(), { exact: true })).toBeVisible();
  });

  it("marks the files the pupil has edited", async () => {
    tree({ changed: ["styles.css"] });

    await expect
      .element(
        page
          .getByRole("treeitem", { name: /styles\.css/ })
          .getByText(m.artifact_file_changed(), { exact: true }),
      )
      .toBeVisible();
    await expect
      .element(
        page
          .getByRole("treeitem", { name: /App\.tsx/ })
          .getByText(m.artifact_file_changed(), { exact: true }),
      )
      .not.toBeInTheDocument();
  });

  it("hands the tapped file back", async () => {
    const onselect = vi.fn();
    tree({ onselect });

    await page.getByRole("treeitem", { name: /styles\.css/ }).click();

    expect(onselect).toHaveBeenCalledWith("styles.css");
  });

  it("collapses a folder and takes its files off the list", async () => {
    tree();

    await page
      .getByRole("treeitem", { name: m.artifact_file_folder_toggle({ name: "src" }) })
      .click();

    await expect.element(page.getByRole("treeitem", { name: /App\.tsx/ })).not.toBeInTheDocument();
    await expect.element(page.getByRole("treeitem", { name: /styles\.css/ })).toBeVisible();
  });

  /**
   * One tab stop, and the arrows move within it: three tabbable files cost a
   * keyboard user three stops on the way past a list they are usually not
   * looking for (§20).
   */
  it("is one tab stop, and the arrows walk it", async () => {
    const onselect = vi.fn();
    tree({ onselect });

    const active = page.getByRole("treeitem", { name: /App\.tsx/ });
    await expect.element(active).toHaveAttribute("tabindex", "0");
    await expect
      .element(page.getByRole("treeitem", { name: /styles\.css/ }))
      .toHaveAttribute("tabindex", "-1");

    await active.element().focus();
    await userEvent.keyboard("{ArrowDown}");

    // In the order the tree shows them — folders before files, so `src/lib`
    // comes before `src/App.tsx`, and the file after it is at the root.
    expect(onselect).toHaveBeenCalledWith("styles.css");
  });

  it("leaves the horizontal arrows to the editor beside it", async () => {
    const onselect = vi.fn();
    tree({ onselect });

    await page
      .getByRole("treeitem", { name: /App\.tsx/ })
      .element()
      .focus();
    await userEvent.keyboard("{ArrowRight}");

    expect(onselect).not.toHaveBeenCalled();
  });

  it("roves through folders and retains one tab stop after collapsing the active file", async () => {
    const onselect = vi.fn();
    tree({ onselect });
    const folder = page.getByRole("treeitem", {
      name: m.artifact_file_folder_toggle({ name: "src" }),
      exact: true,
    });
    expect(document.querySelectorAll('[role="tree"] button[tabindex="0"]')).toHaveLength(1);
    await expect.element(folder).toHaveAttribute("tabindex", "-1");
    await expect.element(folder).toHaveAttribute("aria-expanded", "true");
    const groupId = folder.element().getAttribute("aria-owns");
    expect(groupId).not.toBeNull();
    expect(document.getElementById(groupId ?? "")?.getAttribute("role")).toBe("group");
    await folder.element().focus();
    await userEvent.keyboard("{ArrowDown}");
    await expect
      .element(page.getByRole("treeitem", { name: m.artifact_file_folder_toggle({ name: "lib" }) }))
      .toHaveFocus();
    expect(onselect).not.toHaveBeenCalled();
    await folder.click();
    await expect.element(folder).toHaveAttribute("aria-expanded", "false");
    await expect.element(folder).not.toHaveAttribute("aria-owns");
    await expect.element(folder).toHaveAttribute("tabindex", "0");
    expect(document.querySelectorAll('[role="tree"] button[tabindex="0"]')).toHaveLength(1);
    await userEvent.keyboard("{ArrowDown}");
    expect(onselect).toHaveBeenCalledWith("styles.css");
    await expect.element(page.getByRole("treeitem", { name: /styles\.css/ })).toHaveFocus();
  });
});
