# Deployment

Before deploying, in the main project folder:

```powershell
npm ci
npm run check
```

The Cloudflare build goes to `dist/server` and `dist/client`; the bundler
creates these folders, so there is no need to touch them by hand. The Worker configuration for deployment is
`dist/server/wrangler.json`.

## Publishing on Cloudflare

The app is a Cloudflare Worker: `worker/index.ts` serves the pages, `dist/client`
is served as static assets, and the D1 database is attached through the `DB` binding. Other hosting would
require rewriting the server side.

These steps are done once, by the owner of the Cloudflare account.

**1. Sign in.** A browser window opens; confirm access there:

```
npx wrangler login
```

**2. Database.** Creates an empty database and prints its ID:

```
npx wrangler d1 create aedexa
```

Put the resulting `database_id` into `wrangler.jsonc` in place of the placeholder, then
apply the schema from `migrations/`:

```
npm run db:remote
```

**3. Publish.** Builds the project and deploys the Worker:

```
npm run deploy
```

An address like `aedexa.<subdomain>.workers.dev` is printed at the end. The site already
works there: placement, topo survey, archive, and export run in the browser and need no server
keys.

**4. Custom domain** — `aedexa.site`, registered with Namecheap.

1. In the Cloudflare dashboard: **Add a site** → `aedexa.site` → Free plan.
2. Cloudflare shows two addresses like `name.ns.cloudflare.com`.
3. In Namecheap: **Domain List → Manage → Nameservers → Custom DNS** — enter
   both in place of `dns1.registrar-servers.com` and `dns2.registrar-servers.com`.
4. Wait until the Cloudflare dashboard shows **Active** (from half an hour to a day).
5. The domain is set in `routes` in `wrangler.jsonc` — put your own and run
   `npm run deploy` again.

Cloudflare creates the DNS record and the certificate itself. Until the domain has moved, a deploy with
`routes` fails with "zone not found": wait for the move to finish.

**5. Model key.** Needed only for 2D → 3D mode. Without a key the mode is hidden
and nothing breaks. The key goes into the Worker secrets, not into `.env`:

```bash
npx wrangler secret put FEATHERLESS_API_KEY
```

After secrets change, the Worker restarts on its own.

## Environment and limitations

- Node.js at least the version stated in `package.json`; dependencies are pinned by the lock file.
- Without AI keys, local CAD, placement, and archive are available; reconstruction through the provider needs the server settings from `.env.example`.
- Keys are entered separately into the secrets of the target environment; client-side `VITE_*` variables are not used for keys.
- The project archive is stored in the user's browser; accounts and projects are stored in D1.
- Model responses are mocked in tests, so check the real Featherless integration and opening exports in CAD programs by hand.
- DXF is read by the placement module; the current WASM parser for reconstruction reads DWG. For 2D → 3D from DXF, export to DWG or an image first. The model does not accept PDF: use PNG or JPEG pages.
- Model analysis of labels and groups in a large topo survey takes minutes: about ten on a drawing with a hundred labels.

`npm run deploy` publishes the site right away.

If Windows blocks package updates (`EBUSY`), stop this project's dev server first. If a corporate root certificate is already installed in Windows, Node can be started with `--use-system-ca`; there is no need to disable TLS verification.
