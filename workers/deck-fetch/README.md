# Deck-link fetcher (Cloudflare Worker)

The published build at https://currentsbtw.github.io/proving-grounds/ is static, so it has no
`/api/deck` to call. This Worker is that route for the published build. Locally nothing here is
needed: `npm run play` (or `npm run judge` on its own) already serves `/api/deck`.

It reads the same `server/deckFetch.ts` the local proxy does, holds no state, and has no
credential of its own. Deploying it is optional — without it, a pasted link on the published
build fails and the app tells the player to export the list and paste the text.

## Deploy

1. **Install wrangler.** `npm i -g wrangler`, or use `npx wrangler` in place of `wrangler` below
   (nothing is added to this repo's `package.json`).
2. **Log in.** `wrangler login` — it opens a browser and asks you to authorise. Create the
   Cloudflare account first if you do not have one; the free plan is enough (this Worker is one
   small JSON fetch per pasted link).
3. **Deploy from this folder.**

   ```
   cd workers/deck-fetch
   wrangler deploy
   ```

   It prints the deployed URL, of the form
   `https://proving-grounds-deck-fetch.<your-subdomain>.workers.dev`. Check it with a browser or
   curl: `<that URL>/?url=https://archidekt.com/decks/1` should return deck JSON.
4. **Optional — Moxfield.** Moxfield's API refuses automated reads unless the user agent has been
   whitelisted by their support. Once you have one:

   ```
   wrangler secret put MOXFIELD_USER_AGENT
   ```

   and paste the string when prompted. Until then Archidekt links work and Moxfield links answer
   501, which the app shows as "export the list and paste it".
5. **Point the Pages build at it.** In GitHub: repository → Settings → Secrets and variables →
   Actions → Variables → New repository variable, named `DECK_FETCH_URL`, with the workers.dev URL
   from step 3 as its value. The Pages workflow passes it to the Vite build as
   `VITE_DECK_FETCH_URL`. Re-run the Pages workflow (or push) so the build picks it up. With the
   variable unset the build falls back to `/api/deck`, which does not exist on Pages, and the app
   shows the paste instruction.

## Configuration

| Name | Kind | Default | What it does |
| --- | --- | --- | --- |
| `ALLOWED_ORIGINS` | var (`wrangler.toml`) | the Pages origin plus `localhost:5173` and `localhost:4173` | Comma-separated origins that get CORS headers back. Anything else can call the Worker but a browser will not let the page read the reply. |
| `MOXFIELD_USER_AGENT` | secret | unset | The user agent Moxfield whitelisted. Unset means Moxfield links answer 501. |

Edit `ALLOWED_ORIGINS` in `wrangler.toml` and redeploy if the app is ever served from another
origin.

## Routes

`GET /?url=<deck link>` (and `/deck`, `/api/deck`, so the same deployment works behind a route
with a path). `OPTIONS` answers 204 for the preflight; anything else answers 405.

Replies are the same as the local proxy's: `200` with the normalised deck, or
`{ error, code }` with `400` (not a deck link), `404` (private or missing), `429` (the site is
rate-limiting), `501` (no fetcher for that site on this deployment), `502` (unreachable, or the
read was refused).

## Logs

`wrangler tail` streams requests while it runs. Nothing in the fetcher logs a URL or a decklist.
