import type { SubmitFunction } from "$app/forms";

/**
 * `use:enhance` that applies the result to the page the form is on, as SvelteKit 2 did.
 *
 * SvelteKit 3 navigates an enhanced form to the page its action lands on whenever that
 * is not the current URL. `action="?/name"` lands on the current path *without* the
 * current query string, so on a page whose state lives in the query the submission
 * now moves somewhere else: the setup wizard's `?step=students` re-resolved to the
 * finish step and lost the credential cards it had just minted, and the roster's
 * `?removed=1` view snapped back to hiding removed pupils. Forms on those pages use
 * this instead; `navigate: false` is SvelteKit 3's documented way back to the old
 * behaviour (redirects are still followed).
 */
export const stayOnPage: SubmitFunction =
  () =>
  async ({ update }) => {
    await update({ navigate: false });
  };
