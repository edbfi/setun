/**
 * The application's public origin: the address people open in the browser (PRD §6.2).
 *
 * Setun prints it on access slips and QR codes and in the first-run banner, and SvelteKit checks
 * writes against the same origin through the front in `server.js`. One setting is enough:
 * `bun ./server.js` takes ORIGIN, or SETUN_APP_ORIGIN when ORIGIN is unset, and exports the
 * canonical value as ORIGIN before the app loads. So ORIGIN comes first here too, and an app-level
 * setting never replaces it; SETUN_APP_ORIGIN alone, or ORIGIN alone, both work.
 *
 * Kept free of `$app/*` imports so `bun test` can cover it.
 */

/** The Vite dev server's address, used only under `bun run dev`. */
export const DEV_APP_ORIGIN = "http://localhost:5173";

const present = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * ORIGIN, else SETUN_APP_ORIGIN, else (only under `bun run dev`) the dev server's address.
 *
 * `undefined` outside dev when neither is set: a production server has no other way to know the
 * address a pupil's QR code must point at, and `validateConfig()` reports it as required rather
 * than printing slips for localhost.
 */
export function resolveAppOrigin(values: {
  origin?: string;
  appOrigin?: string;
  dev: boolean;
}): string | undefined {
  return (
    present(values.origin) ?? present(values.appOrigin) ?? (values.dev ? DEV_APP_ORIGIN : undefined)
  );
}
