import type { SuperValidated } from "sveltekit-superforms";
import type * as v from "valibot";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import type { AliasSchema } from "$lib/server/classroom/schemas";
import AliasStep from "./AliasStep.svelte";

/**
 * Step 3 of the first-run wizard (plan 6.1, PRD §9, §16, §22).
 *
 * The form is built by hand rather than through `superValidate`, which would
 * pull a server module into a browser test. `superForm` only needs the shape,
 * and the shape is what the component reads.
 */

type AliasData = v.InferOutput<typeof AliasSchema>;

const DATA: AliasData = {
  name: "",
  gatewayModelId: "",
  dialect: "openai",
  available: true,
  dataProtection: false,
  supportsImageInput: false,
  supportsImageGeneration: false,
  inputPricePerMillion: null,
  outputPricePerMillion: null,
  contextWindowTokens: null,
  isUtility: true,
};

function form(over: Partial<SuperValidated<AliasData>> = {}): SuperValidated<AliasData> {
  return {
    id: "setup-alias",
    valid: true,
    posted: false,
    errors: {},
    data: DATA,
    ...over,
  } as SuperValidated<AliasData>;
}

describe("AliasStep", () => {
  it("collects the friendly name and the gateway identifier separately (§9)", async () => {
    render(AliasStep, { data: form() });

    // Students only ever see the friendly name; the identifier is the gateway's.
    await expect.element(page.getByLabelText(m.educator_alias_name_label())).toBeInTheDocument();
    await expect.element(page.getByLabelText(m.educator_alias_gateway_label())).toBeInTheDocument();
  });

  it("states that this model is the utility alias instead of asking (§9, §10)", async () => {
    render(AliasStep, { data: form() });

    // On a fresh installation there is exactly one alias, so offering the choice
    // would be offering a question with one answer.
    await expect.element(page.getByText(m.setup_alias_utility_note())).toBeInTheDocument();
    await expect
      .element(page.getByLabelText(m.educator_alias_utility_label()))
      .not.toBeInTheDocument();
  });

  it("shows the data-protection flag on the form, unopened (§16)", async () => {
    render(AliasStep, { data: form() });

    await expect.element(page.getByLabelText(m.educator_alias_dpa_label())).toBeInTheDocument();
  });

  it("submits to the alias action, so a browser without JavaScript still works", async () => {
    render(AliasStep, { data: form() });

    const submit = page.getByRole("button", { name: m.setup_alias_submit() });
    await expect.element(submit).toBeInTheDocument();

    // The action is on the form, not on a click handler: progressive
    // enhancement is what makes the wizard work on a machine with a broken
    // bundle, which is exactly the machine being set up.
    const owner = submit.element().closest("form");
    expect(owner?.getAttribute("method")).toBe("POST");
    expect(owner?.getAttribute("action")).toBe("?/alias");
  });

  it("renders the server's field errors rather than a generic failure", async () => {
    render(AliasStep, {
      data: form({ valid: false, posted: true, errors: { name: ["Invalid length"] } }),
    });

    await expect.element(page.getByText("Invalid length")).toBeInTheDocument();
  });

  it("prefills the alias already created, so going back edits rather than duplicates", async () => {
    render(AliasStep, {
      data: form({ data: { ...DATA, name: "Balanceret", gatewayModelId: "gpt-5" } }),
    });

    await expect
      .element(page.getByLabelText(m.educator_alias_name_label()))
      .toHaveValue("Balanceret");
    await expect
      .element(page.getByLabelText(m.educator_alias_gateway_label()))
      .toHaveValue("gpt-5");
  });
});
