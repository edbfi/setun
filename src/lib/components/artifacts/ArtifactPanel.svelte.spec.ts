import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import { type ArtifactView, ArtifactWorkspace } from "$lib/state/artifacts.svelte";
import ArtifactPanel from "./ArtifactPanel.svelte";

/**
 * The build pane's interaction logic (plan 4.3, PRD §13, §20, §22).
 *
 * What is under test is the pane's own behaviour — what a keystroke does, what a
 * commit point does, what the tabs show — not the sandbox, which has its own
 * end-to-end suite on a real second origin (§14), and not the workspace geometry,
 * which belongs to `WorkspaceShell`.
 *
 * `about:blank` stands in for the sandbox origin: a component test has no second
 * origin to serve, and the frame's contents are not what these assertions are
 * about.
 */

const SANDBOX = "about:blank";

const BASE_VERSION = {
  id: "version-1",
  revision: 1,
  source: "<button>Klik</button>",
  entry: "index.html",
  files: { "index.html": "<button>Klik</button>" },
  authoredBy: "model" as const,
  createdAt: new Date(0).toISOString(),
};

function artifact(overrides: Partial<ArtifactView> = {}): ArtifactView {
  return {
    id: "artifact-1",
    language: "html",
    title: "Klikkeren",
    ...overrides,
    // Merged after the spread, not before it: an override that names `latest`
    // states only the fields it cares about, and replacing the whole of it would
    // leave the artifact without the files every reader now expects.
    latest: { ...BASE_VERSION, ...overrides.latest },
  };
}

/** Every request body the panel has sent, in the order it sent them. */
function sentBodies(fetched: { mock: { calls: unknown[][] } }): string[] {
  return fetched.mock.calls.map(([, init]) =>
    String((init as RequestInit | undefined)?.body ?? ""),
  );
}

/** The status strip's own sentence, read whole rather than as a substring. */
function statusStrip(): string | undefined {
  return document.querySelector('[role="status"]')?.textContent?.trim();
}

function openWorkspace(items: ArtifactView[] = [artifact()]): ArtifactWorkspace {
  const workspace = new ArtifactWorkspace();
  workspace.items = items;
  workspace.reveal();
  return workspace;
}

describe("ArtifactPanel", () => {
  it.each(["version-1", "version-2"])(
    "retries a failed %s diff snapshot without reloading the cached side",
    async (failedId) => {
      const latest = { ...BASE_VERSION, id: "version-2", revision: 2 };
      const requests = new Map<string, number>();
      const fetched = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url = String(input);
        if (url.includes("/versions/")) {
          const id = url.split("/").at(-1) ?? "";
          const count = (requests.get(id) ?? 0) + 1;
          requests.set(id, count);
          if (id === failedId && count === 1)
            return Promise.resolve(new Response(null, { status: 503 }));
          return Promise.resolve(Response.json(id === "version-1" ? BASE_VERSION : latest));
        }
        return Promise.resolve(
          Response.json({
            versions: [BASE_VERSION, latest].map((version) => ({
              ...version,
              files: [{ path: "index.html", bytes: 20, change: "unchanged" }],
            })),
          }),
        );
      });
      try {
        render(ArtifactPanel, {
          workspace: openWorkspace([artifact({ latest })]),
          sandboxOrigin: SANDBOX,
        });
        await page.getByRole("tab", { name: m.artifact_tab_history() }).click();
        await expect.element(page.getByText(m.artifact_history_load_failed())).toBeVisible();
        expect(requests.get(failedId)).toBe(1);
        await page.getByRole("button", { name: m.artifact_history_retry() }).click();
        await expect
          .element(page.getByText(m.artifact_diff_unchanged({ path: "index.html" })))
          .toBeVisible();
        await expect
          .element(page.getByText(m.artifact_history_load_failed()))
          .not.toBeInTheDocument();
        expect(requests.get(failedId)).toBe(2);
        expect(requests.get(failedId === "version-1" ? "version-2" : "version-1")).toBe(1);
      } finally {
        fetched.mockRestore();
      }
    },
  );

  it("waits for both diff snapshots and abandons a restore after switching artifacts", async () => {
    const first = artifact({ latest: { ...BASE_VERSION, id: "version-2", revision: 2 } });
    const second = artifact({ id: "artifact-2", title: "Other" });
    const workspace = openWorkspace([first, second]);
    workspace.select(first.id);
    const pending = new Map<string, ((response: Response) => void)[]>();
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/versions/")) {
        return new Promise<Response>((resolve) => {
          pending.set(url, [...(pending.get(url) ?? []), resolve]);
        });
      }
      return Promise.resolve(
        Response.json({
          versions: [BASE_VERSION, first.latest].map((version) => ({
            ...version,
            files: [{ path: "index.html", bytes: 20, change: "modified" }],
          })),
        }),
      );
    });
    try {
      render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });
      await page.getByRole("tab", { name: m.artifact_tab_history() }).click();
      await expect.element(page.getByRole("button", { name: m.artifact_restore() })).toBeVisible();
      await expect
        .element(page.getByText(m.artifact_diff_deleted({ path: "index.html" })))
        .not.toBeInTheDocument();

      for (const resolve of pending.get("/api/artifacts/artifact-1/versions/version-2") ?? []) {
        resolve(Response.json(first.latest));
      }
      await new Promise(requestAnimationFrame);
      await expect
        .element(page.getByText(m.artifact_diff_added({ path: "index.html" })))
        .not.toBeInTheDocument();

      await page.getByText(m.artifact_version_label({ revision: 1 })).click();
      await page.getByRole("button", { name: m.artifact_restore() }).click();
      workspace.select(second.id);
      for (const resolve of pending.get("/api/artifacts/artifact-1/versions/version-1") ?? []) {
        resolve(Response.json({ ...BASE_VERSION, files: { "index.html": "old source" } }));
      }
      await new Promise(requestAnimationFrame);
      expect(workspace.openId).toBe(second.id);
      expect(workspace.files).toEqual(second.latest.files);
      expect(fetched.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    } finally {
      fetched.mockRestore();
    }
  });

  it("says what to ask for when nothing has been built", async () => {
    const workspace = new ArtifactWorkspace();
    workspace.reveal();

    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

    // "A prominent Build entry point makes artifact work discoverable rather
    // than an obscure toggle" — so it opens with nothing built (§13).
    await expect.element(page.getByText(m.artifact_empty_heading())).toBeVisible();
  });

  it("shows the artifact's own name and the three views", async () => {
    render(ArtifactPanel, { workspace: openWorkspace(), sandboxOrigin: SANDBOX });

    await expect.element(page.getByText("Klikkeren")).toBeVisible();
    await expect.element(page.getByRole("tab", { name: m.artifact_tab_preview() })).toBeVisible();
    await expect.element(page.getByRole("tab", { name: m.artifact_tab_code() })).toBeVisible();
    await expect.element(page.getByRole("tab", { name: m.artifact_tab_history() })).toBeVisible();
  });

  it("offers no list while there is only one thing to list", async () => {
    render(ArtifactPanel, { workspace: openWorkspace(), sandboxOrigin: SANDBOX });

    await expect
      .element(page.getByRole("tab", { name: m.artifact_tab_builds({ count: 1 }) }))
      .not.toBeInTheDocument();
  });

  it("lists every build of the conversation, and opens the one chosen", async () => {
    const second: ArtifactView = {
      ...artifact(),
      id: "artifact-2",
      title: "Quizzen",
      latest: { ...artifact().latest, id: "version-2", source: "<p>quiz</p>" },
    };
    const workspace = openWorkspace([artifact(), second]);

    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

    // Several things built is a question the header's `<select>` used to answer
    // one name at a time; the list answers it with state and identity (§13).
    await expect
      .element(page.getByRole("tab", { name: m.artifact_tab_builds({ count: 2 }) }))
      .toBeVisible();

    await page.getByRole("tab", { name: m.artifact_tab_builds({ count: 2 }) }).click();
    await page.getByText("Quizzen").click();

    expect(workspace.openId).toBe("artifact-2");
    expect(workspace.tab).toBe("preview");
  });

  it("names an untitled artifact by its language rather than inventing one", async () => {
    const workspace = openWorkspace([{ ...artifact(), title: null }]);

    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

    await expect.element(page.getByText(m.artifact_untitled({ language: "html" }))).toBeVisible();
  });

  it("keeps the preview frame mounted while the source is being read", async () => {
    const workspace = openWorkspace();
    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

    await page.getByRole("tab", { name: m.artifact_tab_code() }).click();

    // Reloading the artifact because a pupil looked at its source would throw
    // away whatever state it had built up (§13).
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("does not compile on a keystroke", async () => {
    const workspace = openWorkspace();
    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

    workspace.edit("<button>Min knap</button>");

    // "Compilation is triggered by an explicit Run action or a heavily debounced
    // idle, never per keystroke" (§13) — so the running source has not moved.
    expect(workspace.running?.files).toEqual({ "index.html": "<button>Klik</button>" });
    await expect.element(page.getByText(m.artifact_status_unsaved())).toBeVisible();
  });

  it("runs and stores the edit when Run is pressed", async () => {
    const workspace = openWorkspace();
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "version-2",
            revision: 2,
            entry: "index.html",
            files: { "index.html": "<button>Min knap</button>" },
            source: "<button>Min knap</button>",
            authoredBy: "student",
            createdAt: new Date(1).toISOString(),
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    try {
      render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });
      workspace.edit("<button>Min knap</button>");

      await page.getByRole("button", { name: m.artifact_run() }).click();

      expect(workspace.running?.files).toEqual({ "index.html": "<button>Min knap</button>" });
      // Local: a version, not a model request (§13).
      expect(fetched).toHaveBeenCalledWith(
        "/api/artifacts/artifact-1/versions",
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      fetched.mockRestore();
    }
  });

  it("tells the student their edit will travel with the next message", async () => {
    const workspace = openWorkspace([
      { ...artifact(), latest: { ...artifact().latest, authoredBy: "student" } },
    ]);

    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

    await expect.element(page.getByText(m.artifact_edit_carried())).toBeVisible();
  });

  it("shows a build failure as text", async () => {
    const workspace = openWorkspace();
    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

    workspace.status = "failed";
    workspace.error = "Line 3: Unexpected <";

    // The compiler's own words, rendered as text and never as markup (§13, §21).
    await expect.element(page.getByText("Line 3: Unexpected <")).toBeVisible();
  });

  it("shows the artifact's id in the mono identity line", async () => {
    const workspace = openWorkspace([{ ...artifact(), key: "side" }]);
    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

    await expect.element(page.getByText("id=side · html · v1")).toBeVisible();
  });

  it("derives an id for a row that stores none, so the line is never blank", async () => {
    render(ArtifactPanel, { workspace: openWorkspace(), sandboxOrigin: SANDBOX });

    await expect.element(page.getByText("id=html-artifact-1 · html · v1")).toBeVisible();
  });

  it("offers to hand a failure back to the model", async () => {
    const workspace = openWorkspace();
    const asked = vi.fn();
    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX, onaskforhelp: asked });

    workspace.status = "failed";
    workspace.error = "Line 3: Unexpected <";
    // Already reported, so the button is not waiting on a PATCH.
    workspace.applyBuildStatus({
      artifactId: "artifact-1",
      versionId: "version-1",
      status: "failed",
      message: "Line 3: Unexpected <",
    });

    await page.getByRole("button", { name: m.artifact_ask_fix() }).click();
    expect(asked).toHaveBeenCalledWith("failed");
  });

  it("tells a page that mounted and then threw from one that never ran", async () => {
    const workspace = openWorkspace();
    const asked = vi.fn();
    // Resolved by hand, so the order the two PATCHes are *sent* in is observable.
    const settle: ((response: Response) => void)[] = [];
    const fetched = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => new Promise((resolve) => settle.push(resolve)));

    try {
      render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX, onaskforhelp: asked });

      // The mount ack, then the click handler throwing a moment later.
      workspace.status = "running";
      workspace.recordOutcome("ok", null);
      await vi.waitFor(() => expect(fetched).toHaveBeenCalledTimes(1));

      workspace.error = "TypeError: t.score is not a function";
      workspace.recordOutcome("threw", "TypeError: t.score is not a function");

      // Serialised: `v:ok` then `v:threw` landing out of order would leave the
      // server disagreeing with what the pupil is looking at.
      expect(fetched).toHaveBeenCalledTimes(1);
      settle[0]?.(new Response("{}", { status: 200 }));
      await vi.waitFor(() => expect(fetched).toHaveBeenCalledTimes(2));
      settle[1]?.(new Response("{}", { status: 200 }));

      // The page is still on screen, so the strip and the trit say it ran and
      // then stopped rather than that it never ran (§13).
      await expect.element(page.getByText("TypeError: t.score is not a function")).toBeVisible();
      await expect.element(page.getByText(m.artifact_status_threw())).toBeVisible();
      await expect
        .element(page.getByRole("img", { name: m.artifact_status_threw() }).first())
        .toBeInTheDocument();

      await vi.waitFor(() => expect(workspace.pendingBuildReport).toBeNull());
      await page.getByRole("button", { name: m.artifact_ask_fix() }).click();
      // The pupil's sentence has to agree with the note beside it.
      expect(asked).toHaveBeenCalledWith("threw");
    } finally {
      fetched.mockRestore();
    }
  });

  it("marks a version that ran and then stopped in the history list", async () => {
    const workspace = openWorkspace();
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      Promise.resolve(
        // The revision's own files, fetched once the pupil's selection lands on
        // it: the history list carries paths and sizes and nothing more.
        String(input).includes("/versions/")
          ? new Response(
              JSON.stringify({
                id: "version-1",
                revision: 1,
                entry: "index.html",
                files: { "index.html": "<button>Klik</button>" },
                source: "<button>Klik</button>",
                authoredBy: "model",
                buildStatus: "threw",
                buildMessage: "TypeError",
                createdAt: new Date(0).toISOString(),
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            )
          : new Response(
              JSON.stringify({
                id: "artifact-1",
                language: "html",
                title: "Klikkeren",
                key: "klikkeren",
                versions: [
                  {
                    id: "version-1",
                    revision: 1,
                    entry: "index.html",
                    files: [{ path: "index.html", bytes: 1, change: "added" }],
                    authoredBy: "model",
                    buildStatus: "threw",
                    buildMessage: "TypeError",
                    createdAt: new Date(0).toISOString(),
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
      ),
    );

    try {
      render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });
      await page.getByRole("tab", { name: m.artifact_tab_history() }).click();

      await expect.element(page.getByText(m.artifact_version_build_threw())).toBeVisible();
    } finally {
      fetched.mockRestore();
    }
  });

  it("shows what the artifact printed, as text", async () => {
    const workspace = openWorkspace();
    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

    workspace.appendConsole([
      { level: "log", text: "point: 3" },
      { level: "warn", text: "<b>ikke markup</b>" },
    ]);

    await page.getByRole("button", { name: m.artifact_console_label({ count: 2 }) }).click();

    const log = page.getByRole("log");
    await expect.element(log).toBeVisible();
    // Generated output, so it is text at every hop (§13, §21).
    await expect.element(page.getByText("<b>ikke markup</b>", { exact: false })).toBeVisible();
  });

  it("marks a version that did not run in the history list", async () => {
    const workspace = openWorkspace();
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      Promise.resolve(
        // The revision's own files, fetched once the pupil's selection lands on
        // it: the history list carries paths and sizes and nothing more.
        String(input).includes("/versions/")
          ? new Response(
              JSON.stringify({
                id: "version-1",
                revision: 1,
                entry: "index.html",
                files: { "index.html": "<button>Klik</button>" },
                source: "<button>Klik</button>",
                authoredBy: "model",
                buildStatus: "failed",
                buildMessage: "boom",
                createdAt: new Date(0).toISOString(),
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            )
          : new Response(
              JSON.stringify({
                id: "artifact-1",
                language: "html",
                title: "Klikkeren",
                key: "klikkeren",
                versions: [
                  {
                    id: "version-1",
                    revision: 1,
                    entry: "index.html",
                    files: [{ path: "index.html", bytes: 1, change: "added" }],
                    authoredBy: "model",
                    buildStatus: "failed",
                    buildMessage: "boom",
                    createdAt: new Date(0).toISOString(),
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
      ),
    );

    try {
      render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });
      await page.getByRole("tab", { name: m.artifact_tab_history() }).click();

      await expect.element(page.getByText(m.artifact_version_build_failed())).toBeVisible();
    } finally {
      fetched.mockRestore();
    }
  });

  it("reports a run onto the version it ran, once per outcome", async () => {
    const workspace = openWorkspace();
    const fetched = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    try {
      render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

      workspace.recordOutcome("failed", "Line 3: Unexpected <");
      await vi.waitFor(() =>
        expect(fetched).toHaveBeenCalledWith(
          "/api/artifacts/artifact-1/versions/version-1",
          expect.objectContaining({ method: "PATCH" }),
        ),
      );

      // The stored status now says so, so nothing further is owed.
      await vi.waitFor(() => expect(workspace.pendingBuildReport).toBeNull());

      const calls = fetched.mock.calls.length;
      workspace.recordOutcome("failed", "Line 3: Unexpected <");
      expect(fetched.mock.calls.length).toBe(calls);
    } finally {
      fetched.mockRestore();
    }
  });

  it("sends a superseded report once, when the one before it did not land", async () => {
    const workspace = openWorkspace();

    // The mount's `ok` is held open until the `threw` behind it is queued, so
    // the refusal lands while the second report is the one the panel owes.
    let refuse!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      refuse = resolve;
    });

    const fetched = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(held)
      .mockResolvedValue(new Response("{}", { status: 200 }));

    try {
      render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

      workspace.recordOutcome("ok", null);
      await vi.waitFor(() => expect(fetched).toHaveBeenCalledTimes(1));

      // Reports travel one chain, so this one waits on the held request.
      workspace.recordOutcome("threw", "TypeError");
      await vi.waitFor(() => expect(workspace.pendingBuildReport?.status).toBe("threw"));

      refuse(new Response("nej", { status: 500 }));
      await vi.waitFor(() => expect(workspace.open?.latest.buildStatus).toBe("threw"));

      // A sentinel behind everything already queued. Reports travel one chain in
      // the order they were raised, so a duplicate queued by the refusal above
      // must have been sent before this one is — no sleep needed to see it.
      workspace.recordOutcome("failed", "boom");
      await vi.waitFor(() =>
        expect(sentBodies(fetched).some((body) => body.includes("failed"))).toBe(true),
      );

      // Clearing the stamp on the refusal would have reopened the effect on the
      // stamp the throw already held, and sent the throw a second time.
      expect(sentBodies(fetched).filter((body) => body.includes("threw"))).toHaveLength(1);
    } finally {
      fetched.mockRestore();
    }
  });

  it("says a stored run threw rather than only that it ran", async () => {
    // Reopened later: nothing is running, so the strip has only the stored
    // status to read — and the trit beside it already says `threw` (§13, §20).
    const workspace = openWorkspace([
      artifact({ latest: { buildStatus: "threw", buildMessage: "TypeError" } as never }),
    ]);

    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

    // Read exactly: "It ran" is a prefix of "It ran, then stopped", so a
    // substring match would pass on the wrong sentence.
    await vi.waitFor(() => expect(statusStrip()).toBe(m.artifact_status_threw()));
  });

  it("says a stored run failed rather than that it ran", async () => {
    const workspace = openWorkspace([
      artifact({ latest: { buildStatus: "failed", buildMessage: "boom" } as never }),
    ]);

    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

    await vi.waitFor(() => expect(statusStrip()).toBe(m.artifact_status_failed()));
  });

  it("reports nothing for a draft the version does not hold", async () => {
    const workspace = openWorkspace();
    const fetched = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    try {
      render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

      // A pupil running something no version holds: stamping the stored revision
      // with that result would tell the model a lie about its own code (§13).
      workspace.running = { entry: "index.html", files: { "index.html": "<p>udkast</p>" } };
      workspace.recordOutcome("failed", "boom");

      expect(workspace.pendingBuildReport).toBeNull();
      expect(fetched).not.toHaveBeenCalledWith(
        expect.stringContaining("/versions/version-1"),
        expect.objectContaining({ method: "PATCH" }),
      );
    } finally {
      fetched.mockRestore();
    }
  });
});

describe("the frame's renders", () => {
  /** Say `ready` as the runner does, so the frame will send a render at all. */
  function announceReady(): HTMLIFrameElement {
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel: "setun-artifact", type: "ready" },
        source: frame.contentWindow,
      }),
    );
    return frame;
  }

  it("does not re-render the artifact when a build status is recorded", async () => {
    const workspace = openWorkspace();
    // The frame is sandboxed without `allow-same-origin`, so its `postMessage`
    // is unreachable from here — but a render mints exactly one run id, and that
    // is countable (§14).
    const minted = vi.spyOn(crypto, "randomUUID");

    try {
      render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });
      announceReady();

      await vi.waitFor(() => expect(minted).toHaveBeenCalled());
      const before = minted.mock.calls.length;

      // Recording an outcome replaces the artifact list, so every value the
      // frame reads comes from a new object — and re-sending the render tears
      // the document down, losing whatever state the artifact had built up.
      // With two outcomes in one run it also fed itself: the fresh mount
      // reported `ok` over the `threw` that caused it, and round again (§13).
      workspace.applyBuildStatus({
        artifactId: "artifact-1",
        versionId: "version-1",
        status: "threw",
        message: "TypeError",
      });
      await vi.waitFor(() => expect(workspace.open?.latest.buildStatus).toBe("threw"));

      expect(minted.mock.calls.length).toBe(before);
    } finally {
      minted.mockRestore();
    }
  });
});

describe("restoring a revision written under another language", () => {
  /** An artifact the model has since rewritten as a component. */
  function rewritten(): ArtifactView {
    return {
      ...artifact(),
      language: "svelte",
      latest: {
        ...artifact().latest,
        id: "version-2",
        revision: 2,
        source: "<p>komponent</p>",
        language: "svelte",
      },
    };
  }

  const older = {
    id: "version-1",
    revision: 1,
    entry: "index.html",
    files: [{ path: "index.html", bytes: 1, change: "added" }],
    source: "<button>Klik</button>",
    language: "html" as const,
    authoredBy: "model" as const,
    createdAt: new Date(0).toISOString(),
  };

  it("reads the artifact's own tag when the version names none", () => {
    const workspace = openWorkspace([
      { ...artifact(), latest: { ...artifact().latest, language: null } },
    ]);

    // Null means "whatever the artifact says", which is every row that predates
    // the column (§13).
    expect(workspace.language).toBe("html");
  });

  it("stores the tag the restored revision was written under", async () => {
    const workspace = openWorkspace([rewritten()]);
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);

      // The revision the pupil selects, fetched for its files: the history list
      // carries paths and sizes and reaches for content only when it needs it.
      if (url.endsWith("/versions/version-1")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "version-1",
              revision: 1,
              entry: "index.html",
              files: { "index.html": older.source },
              source: older.source,
              language: "html",
              authoredBy: "model",
              createdAt: new Date(0).toISOString(),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }

      if (url.endsWith("/versions/version-2")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "version-2",
              revision: 2,
              entry: "index.html",
              files: { "index.html": "<p>komponent</p>" },
              source: "<p>komponent</p>",
              language: "svelte",
              authoredBy: "model",
              createdAt: new Date(1).toISOString(),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }

      if (url.endsWith("/versions")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "version-3",
              revision: 3,
              entry: "index.html",
              files: { "index.html": older.source },
              source: older.source,
              language: "html",
              authoredBy: "student",
              createdAt: new Date(2).toISOString(),
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
        );
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "artifact-1",
            language: "svelte",
            title: "Klikkeren",
            key: "klikkeren",
            versions: [
              older,
              {
                id: "version-2",
                revision: 2,
                entry: "index.html",
                files: [{ path: "index.html", bytes: 1, change: "modified" }],
                language: "svelte",
                authoredBy: "model",
                createdAt: new Date(1).toISOString(),
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });

    try {
      render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });
      await page.getByRole("tab", { name: m.artifact_tab_history() }).click();

      // The oldest revision, restored onto an artifact the row now calls svelte.
      await page.getByText(m.artifact_version_label({ revision: 1 })).click();
      await page.getByRole("button", { name: m.artifact_restore() }).click();

      const posted = fetched.mock.calls.find(
        ([url, init]) => String(url).endsWith("/versions") && init?.method === "POST",
      );
      // A Restore states the whole project: the revision it brings back may lack
      // files the current one holds (§13).
      expect(JSON.parse(String(posted?.[1]?.body))).toEqual({
        files: { "index.html": older.source },
        deletes: [],
        replace: true,
        entry: "index.html",
        language: "html",
      });

      // And it runs as html: through the Svelte compiler it does not run at all.
      await vi.waitFor(() => expect(workspace.runningLanguage).toBe("html"));
    } finally {
      fetched.mockRestore();
    }
  });

  it("commits a restore that changes only the language", () => {
    const same = {
      ...artifact(),
      language: "svelte" as const,
      latest: { ...artifact().latest, language: "svelte" as const },
    };
    const workspace = openWorkspace([same]);

    // Same text under a different tag is a different pipeline, so the commit
    // point must not short-circuit on the source alone (§13).
    workspace.restore({ ...same.latest, id: "version-0", revision: 0, language: "html" });
    workspace.commit();

    expect(workspace.runningLanguage).toBe("html");
    expect(workspace.status).toBe("compiling");
  });
});
