# Getting the "Add to Chrome" button

That button exists only for a listing on the Chrome Web Store. Until then the
only install is Load unpacked, which is fine for you and useless for anyone else.

```bash
npm run verify     # do not skip: a rejection costs days, a test costs seconds
npm run package    # -> magpie-<version>.zip
```

Upload at <https://chrome.google.com/webstore/devconsole>.

## What it costs

A **one-time $5 developer registration fee**, per Google account. Nothing after
that. Use an account the team will still control in two years: a listing cannot
be moved between accounts, only transferred with support's help.

## What the listing needs that the code does not have

The zip is ready. These are not, and every one of them blocks submission:

- **A privacy policy at a public URL.** Mandatory, because magpie handles user
  data (an API key, and page content). It has to say what is collected, what is
  done with it, and that it is not sold. The README's "What actually leaves your
  computer" section is the honest draft of it; it needs a real page, e.g.
  `anonalabs.com/magpie/privacy`.
- **At least one screenshot**, 1280×800 or 640×400. The popup is 360px wide, so
  screenshot it over a real article rather than alone on a blank page.
- **A 440×280 promo tile** if you want to be featured. Optional.
- **A category** (Productivity) and a short description under 132 characters.

## Permission justifications

The console asks for one per permission, in prose, and reviewers read them.
These are accurate for this codebase:

| Permission | Justification |
|---|---|
| `activeTab` | Reads the article text of the page the user explicitly asks to remember, by clicking the toolbar button or pressing the shortcut. No access to any other tab. |
| `scripting` | Injects the article extractor into that one tab on demand, and registers the optional in-page button. |
| `storage` | Stores the user's own settings and their memory-provider API key locally. Nothing is synced. |
| `offscreen` | Hosts the local language model. WebGPU is unavailable in a service worker, so the model cannot run anywhere else. |
| `unlimitedStorage` | The local model's weights are roughly 1.1 GB and are cached by the browser. |
| Host access to `api.anonalabs.com`, `api.mem0.ai`, `api.supermemory.ai` | Sends the memory to the provider the user configured. One of the three, chosen by them. |
| Host access to `huggingface.co` | Downloads the local model's weights, once. |
| Optional `http://*/*`, `https://*/*` | Only for the optional floating button on pages. Requested at the moment the user switches it on, never at install. |

## The data-usage disclosure

You will be asked to tick what the extension collects. The honest answers:

- **Website content: yes.** In distill mode a locally written summary of the page;
  in raw mode the article text. Sent only to the provider the user configured.
- **Personally identifiable information, health, financial, location,
  authentication, personal communications, user activity: no.**
- You must certify the data is not sold, not used for anything unrelated to the
  single purpose, and not used for creditworthiness. All three are true here.

## What will slow the review down

- **The optional all-sites permission.** Anything that can run on every page gets
  a closer look. It being *optional* and requested in-context is the strongest
  thing in magpie's favour; do not move it into `host_permissions` for
  convenience.
- **Remotely-hosted code.** There is none, and `npm run check:remote` keeps it
  that way. If it ever creeps back, the rejection is automatic and the appeal is
  slow.
- **A single purpose.** The store requires one. magpie's is: *save a summary of
  the page you are reading to your memory service.* Adding a second unrelated
  feature to the same listing is a rejection.

Expect days, and longer on a first submission.
