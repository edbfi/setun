import type { FrameLocator, Page } from "@playwright/test";
import { defaultPathFor } from "../../src/lib/artifacts/project";
import type { ArtifactLanguage } from "../../src/lib/artifacts/types";
import { SANDBOX_ORIGIN } from "../../playwright.config";

/**
 * Put an artifact into the sandbox, from a page on the application origin.
 *
 * The same arrangement the application uses: an iframe pointing at the sandbox
 * hostname, sandboxed to allow scripts but *not* same-origin, driven entirely by
 * message passing (PRD §14). Injecting it from a real, signed-in application
 * page is the point of the escape suite — the session cookie is present, and the
 * artifact still cannot reach it.
 */

export const HOST_FRAME_ID = "e2e-artifact-host";

/**
 * Everything the runner posted up, so a test can assert what did *not* cross.
 *
 * The storage snapshot is the case this exists for: it stops at the runner by
 * design, and "nothing reaches the application" is only checkable by recording
 * everything that did (§13, §14).
 */
declare global {
  interface Window {
    __setunSandboxMessages?: { type?: string }[];
  }
}

/**
 * What the harness renders: a project, or the single source that stands for one.
 *
 * The escape suite says `{ language, source }` and means "one file", and it is
 * about the origin boundary rather than about file layout — so that shape is
 * still accepted and expanded here rather than rewritten across every test.
 */
export interface RenderInput {
  language: string;
  source?: string;
  entry?: string;
  files?: Record<string, string>;
  artifactId?: string;
}

function projectOf(input: RenderInput): { entry: string; files: Record<string, string> } {
  if (input.files) {
    const entry = input.entry ?? Object.keys(input.files)[0];
    return { entry, files: input.files };
  }

  const entry = input.entry ?? defaultPathFor(input.language as ArtifactLanguage);
  return { entry, files: { [entry]: input.source ?? "" } };
}

export async function mountArtifact(page: Page, input: RenderInput): Promise<FrameLocator> {
  const project = projectOf(input);

  await page.evaluate(
    async ({ origin, language, entry, files, id, artifactId }) => {
      document.getElementById(id)?.remove();
      window.__setunSandboxMessages = [];

      const frame = document.createElement("iframe");
      frame.id = id;
      frame.src = origin;
      // Scripts, but no same-origin: the frame's document gets an opaque origin.
      frame.setAttribute("sandbox", "allow-scripts allow-pointer-lock");
      frame.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:99999";
      document.body.appendChild(frame);

      // The sandbox does not fetch its own pinned files: its origin is opaque,
      // and the application serves them on its behalf (see
      // src/lib/artifacts/assets.ts). This harness stands in for the
      // application, so it has to answer the same way ArtifactFrame does —
      // including the path check, which is the whole of the bound.
      const safe = /^(?:runtimes|assets)\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|json|wasm)$/;

      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        const data = event.data as { channel?: string; type?: string; path?: string };
        if (data?.channel !== "setun-artifact") return;

        window.__setunSandboxMessages?.push({ type: data.type });
        if (data.type !== "need-asset") return;

        const path = data.path ?? "";
        void (async () => {
          try {
            if (!safe.test(path)) throw new Error(`refused ${path}`);
            const response = await fetch(`${origin}/${path}`);
            if (!response.ok) throw new Error(String(response.status));
            const bytes = await response.arrayBuffer();
            frame.contentWindow?.postMessage(
              { channel: "setun-artifact", type: "asset", path, ok: true, bytes },
              "*",
              [bytes],
            );
          } catch (cause) {
            frame.contentWindow?.postMessage(
              { channel: "setun-artifact", type: "asset", path, ok: false, message: String(cause) },
              "*",
            );
          }
        })();
      });

      await new Promise<void>((resolve) => {
        window.addEventListener("message", function ready(event) {
          if (event.source !== frame.contentWindow) return;
          const data = event.data as { channel?: string; type?: string };
          if (data?.channel !== "setun-artifact" || data.type !== "ready") return;

          window.removeEventListener("message", ready);
          resolve();
        });
      });

      frame.contentWindow?.postMessage(
        {
          channel: "setun-artifact",
          type: "render",
          runId: "e2e",
          artifactId,
          language,
          entry,
          files,
        },
        "*",
      );
    },
    {
      origin: SANDBOX_ORIGIN,
      language: input.language,
      entry: project.entry,
      files: project.files,
      id: HOST_FRAME_ID,
      artifactId: input.artifactId ?? "e2e-artifact",
    },
  );

  // The runner, and then the artifact's own document one frame further down.
  return page.frameLocator(`#${HOST_FRAME_ID}`).frameLocator("#stage");
}

/**
 * Run something else in the frame that is already mounted.
 *
 * A second `mountArtifact` would replace the frame, and the storage snapshots
 * live in the runner page — so re-running the *same* frame is the only way to
 * ask whether an artifact finds what it saved (§13).
 */
export async function rerenderArtifact(
  page: Page,
  input: RenderInput & { runId?: string },
): Promise<FrameLocator> {
  const project = projectOf(input);

  await page.evaluate(
    ({ id, language, entry, files, artifactId, runId }) => {
      const frame = document.getElementById(id) as HTMLIFrameElement | null;
      frame?.contentWindow?.postMessage(
        { channel: "setun-artifact", type: "render", runId, artifactId, language, entry, files },
        "*",
      );
    },
    {
      id: HOST_FRAME_ID,
      language: input.language,
      entry: project.entry,
      files: project.files,
      artifactId: input.artifactId ?? "e2e-artifact",
      runId: input.runId ?? `e2e-${Math.random()}`,
    },
  );

  return page.frameLocator(`#${HOST_FRAME_ID}`).frameLocator("#stage");
}

/** Ask the runner to put the keyboard in the artifact, as the panel does (§13). */
export async function focusArtifact(page: Page): Promise<void> {
  await page.evaluate((id) => {
    const frame = document.getElementById(id) as HTMLIFrameElement | null;
    frame?.contentWindow?.postMessage({ channel: "setun-artifact", type: "focus" }, "*");
  }, HOST_FRAME_ID);
}

/** The message types the runner has posted up to the application so far. */
export async function sandboxMessageTypes(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window.__setunSandboxMessages ?? []).map((message) => message.type ?? ""),
  );
}
