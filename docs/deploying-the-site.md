# Deploying the install page

`site/` is a single static page with no build step and no server code. It
deploys to **Cloudflare Workers static assets**, the same way `anonalabs.com`
does — Cloudflare's own Pages documentation now says *"Workers supports most
Pages use cases and offers a broader feature set… Start new projects with
Workers"*, and nothing here needs Pages.

`wrangler.jsonc` at the repo root is the whole configuration.

## Deploy

```bash
npx wrangler login       # once, per machine
npm run deploy:site      # npx wrangler deploy
```

Live at **https://magpie-site.anoop-eaf.workers.dev** — good for a look, wrong as
a home. See [Putting it on a real hostname](#putting-it-on-a-real-hostname).

`workers_dev` is set to `true` explicitly rather than left out. It defaults to
true when absent, which is how an app once ended up served from a public
workers.dev URL nobody had chosen to publish; here it is wanted, so it is stated.

A deploy takes a few seconds to reach every edge. A 404 on the root immediately
after uploading is propagation, not a broken deploy — check again before
debugging it.

The account is **pinned in `wrangler.jsonc`** and needs no thought:

```jsonc
"account_id": "eafb46d20d6f14e15325f10d3e372efa"   // Anoop@anonalabs.com's Account
```

It has to be. The token that deploys this can see two accounts — Anoop's and
Srujan's — and wrangler cannot choose between them: interactively it asks, and in
CI it fails outright. Anoop's is the one the rest of Anona is in; `anona-dashboard`
is deployed there, and so is the `anonalabs.com` zone. Unpinned, a deploy lands
wherever the prompt happened to point, and the symptom is a DNS record that
appears to do nothing.

`npx wrangler whoami` lists both if you need to confirm.

## Putting it on a real hostname

1. In the Cloudflare dashboard, on the `anonalabs.com` zone, add a DNS record
   for `magpie` — any placeholder target will do, because a Workers custom
   domain replaces it.
2. Uncomment the `routes` block in `wrangler.jsonc`:

   ```jsonc
   "routes": [
     { "pattern": "magpie.anonalabs.com", "custom_domain": true }
   ],
   ```

3. `npm run deploy:site` again. Wrangler creates the custom domain and the
   certificate.

`custom_domain: true` is deliberate rather than a plain route pattern: it makes
Cloudflare own the DNS record and the certificate for that hostname, so there is
no second place holding a stale target.

## What is served

- `site/index.html` — the page.
- `site/404.html` — a real 404, because `not_found_handling` is `404-page`. A
  miss is a genuine miss; `single-page-application` would return the front door
  with a 200 for every wrong URL.
- `site/_headers` — security headers. They apply because there is no Worker
  script; `_headers` governs static assets, never bytes a Worker generated.

The Content-Security-Policy there is narrow and names `'unsafe-inline'` for
styles and scripts rather than working around it. The page has one inline style
block and one inline script, and the alternative is a nonce, which needs a
Worker to mint — adding a Worker to avoid one keyword is the worse trade.

## Turning on Add to Chrome

When the Web Store listing exists, set `STORE_URL` at the foot of
`site/index.html` and redeploy. The primary button becomes a real **Add to
Chrome** and the note beneath it changes. Nothing else needs touching.

## Checking a deploy

```bash
curl -sI https://magpie.anonalabs.com | head -20
```

Look for `content-security-policy`, and `cf-cache-status: HIT` on a second
request. A 404 should return a real `404`, not a `200`.
