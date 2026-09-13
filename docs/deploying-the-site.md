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

That publishes to `magpie-site.<your-subdomain>.workers.dev`. Good for a look,
wrong as a home — see the next section.

> [!IMPORTANT]
> The Anona Cloudflare account is **Anoop's**, not the account a fresh
> `wrangler login` is likely to land in. Check which one you are in before
> deploying, or you will publish a second copy of the site under your own
> account and wonder why the DNS record does nothing:
>
> ```bash
> npx wrangler whoami
> ```
>
> To target it explicitly, set `CLOUDFLARE_ACCOUNT_ID`, or add `account_id` to
> `wrangler.jsonc`.

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
