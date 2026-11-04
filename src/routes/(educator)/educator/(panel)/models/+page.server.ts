import { fail as kitFail } from "@sveltejs/kit";
import { fail, setError, superValidate } from "sveltekit-superforms";
import { valibot } from "sveltekit-superforms/adapters";
import * as v from "valibot";
import * as m from "$lib/paraglide/messages";
import {
  forgetAlias,
  invalidateModelListing,
  resolveContextWindow,
} from "$lib/server/agent/context-window";
import { requireEducatorPage } from "$lib/server/auth/guards";
import { getDb, getGatewayAdapter } from "$lib/server/boot";
import { AliasSchema } from "$lib/server/classroom/schemas";
import { isForeignKeyViolation, isUniqueViolation } from "$lib/server/db/constraints";
import {
  createAlias,
  deleteAlias,
  designateUtilityAlias,
  listAliases,
  updateAlias,
} from "$lib/server/db/queries/model-aliases";
import type { Actions, PageServerLoad } from "./$types";

/** The first message Superforms recorded, whichever field it belongs to. */
function firstMessage(errors: Record<string, unknown>): string | null {
  for (const value of Object.values(errors)) {
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  }
  return null;
}

/**
 * Model alias management (PRD §9, §17).
 *
 * "Aliases are managed in the educator panel: name, gateway model identifier,
 * dialect, availability, a data-protection flag… and optional per-million-token
 * prices."
 *
 * Thin by §6.1. The one piece of judgement that does not belong in a query
 * module lives here and is one line: designating a utility alias is exclusive,
 * so it goes through `designateUtilityAlias` rather than a plain column write.
 */

const adapter = valibot(AliasSchema);

const AliasIdSchema = v.object({ aliasId: v.pipe(v.string(), v.uuid()) });

export const load: PageServerLoad = async () => {
  const aliases = listAliases(getDb());
  // What each alias's model can read, and where that figure came from, so an
  // educator can see when Setun is only assuming (§9, §10). One gateway listing
  // serves every row, and an unreachable gateway reads as "assumed".
  const windows = await Promise.all(
    aliases.map(
      async (alias) => [alias.id, await resolveContextWindow(getGatewayAdapter(), alias)] as const,
    ),
  );

  return {
    form: await superValidate(adapter),
    aliases,
    contextWindows: Object.fromEntries(windows),
  };
};

/** Parse the alias id a row's form carries, refusing anything else (§5). */
async function aliasIdFrom(request: Request): Promise<string | null> {
  const data = await request.formData();
  const parsed = v.safeParse(AliasIdSchema, { aliasId: data.get("aliasId") });
  return parsed.success ? parsed.output.aliasId : null;
}

export const actions: Actions = {
  create: async ({ request, locals }) => {
    requireEducatorPage(locals);

    const form = await superValidate(request, adapter);
    if (!form.valid) return fail(400, { form });

    // `model_alias.name` is unique, and reusing a name is an ordinary mistake
    // rather than a fault: without this it escaped as an unhandled constraint
    // error, so the educator got a 500 and the page showed nothing at all.
    // A model added to CPA a moment ago should be looked up afresh.
    invalidateModelListing();
    try {
      const alias = createAlias(getDb(), { ...form.data, isUtility: false });
      if (form.data.isUtility) designateUtilityAlias(getDb(), alias.id);
    } catch (cause) {
      if (isUniqueViolation(cause)) return setError(form, "name", m.educator_alias_name_taken());
      throw cause;
    }

    return { form };
  },

  update: async ({ request, locals }) => {
    requireEducatorPage(locals);

    // The row's own form carries the id alongside the fields, so it is read once
    // from the same body Superforms validates.
    const body = await request.formData();
    const id = v.safeParse(AliasIdSchema, { aliasId: body.get("aliasId") });
    if (!id.success) return kitFail(400, { invalid: true });

    const form = await superValidate(body, adapter);
    if (!form.valid) {
      // The row forms are plain `use:enhance`, not bound to the create form's
      // Superforms instance, so returning `{ form }` here would put the errors
      // somewhere nothing renders. Name the row and the first message instead.
      return kitFail(400, {
        aliasId: id.output.aliasId,
        message: firstMessage(form.errors) ?? m.educator_alias_save_failed(),
      });
    }

    invalidateModelListing();
    try {
      forgetAlias(id.output.aliasId);
      updateAlias(getDb(), {
        aliasId: id.output.aliasId,
        values: { ...form.data, isUtility: false },
      });
      if (form.data.isUtility) designateUtilityAlias(getDb(), id.output.aliasId);
    } catch (cause) {
      if (isUniqueViolation(cause)) {
        return kitFail(400, {
          aliasId: id.output.aliasId,
          message: m.educator_alias_name_taken(),
        });
      }
      throw cause;
    }

    return { form };
  },

  delete: async ({ request, locals }) => {
    requireEducatorPage(locals);

    const aliasId = await aliasIdFrom(request);
    if (!aliasId) return kitFail(400, { invalid: true });

    // `usage_event.modelAliasId` references this row with no cascade, on
    // purpose: an alias a pupil has used cannot be removed without discarding
    // the accounting that names it. Retiring a model is the normal case, so it
    // gets a sentence rather than a 500.
    try {
      deleteAlias(getDb(), aliasId);
    } catch (cause) {
      if (isForeignKeyViolation(cause)) {
        return kitFail(409, { aliasId, message: m.educator_alias_in_use() });
      }
      throw cause;
    }

    return { deleted: true };
  },
};
