import { error } from "@sveltejs/kit";
import { dev } from "$app/env";

/**
 * The stack validation page is development tooling, not a feature (PRD §21).
 *
 * It renders the design system's primitives so a stack misconfiguration —
 * an unresolved UnoCSS token, a radius scale silently replaced by presetWind4's
 * defaults — is visible rather than merely wrong. That is a thing to look at
 * while building Setun, and nothing a school deployment has any use for.
 *
 * It exposed no data and answered anonymously, so this closes a small surface
 * rather than a leak: an unauthenticated route in a production build is one
 * more thing an operator has to reason about, and this one earns nothing there.
 *
 * The route file stays in the repository. It is still the worked example for
 * the "no bare strings in components" convention, and `bun run dev` still
 * serves it.
 */
export const load = () => {
  if (!dev) error(404, "Not found");
};
