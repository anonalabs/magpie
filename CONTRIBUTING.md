# Contributing

Thanks for looking. Issues and pull requests are both welcome.

## Getting set up

```bash
npm install
npm run vendor:wasm   # model libraries into src/vendor, once
npm run build
npm run verify        # build, remote-code gate, unit tests, end-to-end tests
```

`npm run verify` is what CI would run and what a pull request needs to pass. It
drives a real Chrome, so it needs one installed at `/usr/bin/google-chrome`.

## What a change needs

**A test that would have failed before it.** Most of this codebase exists behind
WebGPU, a service worker, or a browser API, so "I ran it and it worked" does not
survive a refactor. If the thing you are fixing cannot be tested where it lives,
that is usually a sign it wants extracting. `src/lib/engine-pool.js` exists
because the same bug recurred three times in code that could not be reached from
a test.

**Honest failure.** An error must say what went wrong and what to do about it. An
error that says "something went wrong" ends the conversation, and we have been
there.

**A reason in the comment, not a description of the code.** Comments here explain
why a thing is the way it is: which failure it prevents, which assumption it
protects. The code already says what it does.

## Running a subset

```bash
npm test                      # unit only, fast
npx vitest run test/queue.test.js
npm run test:e2e              # the full browser suite
npm run shot out.png popup.html dark 420   # look at a page of the built extension
```

## Things that will surprise you

- **Chrome caches an unpacked extension's manifest until you reload it**, while
  re-reading its files on every load. A rebuild can run new code against an old
  manifest, and the symptoms look nothing like the cause.
- **Remote code is a hard line.** `npm run check:remote` fails the build on any
  CDN-hosted `.wasm` or `.js` in `dist/`, because Chrome treats one as
  remotely-hosted code and the Web Store rejects it outright.
- **The service worker is disposable.** Anything that must outlive it belongs in
  the offscreen document or in `chrome.storage`.
- **The popup is a viewer.** Nothing may depend on it being open.

## Adding a memory layer

One file in `src/lib/providers/`, then register it in `registry.js`. The
manifest's host permissions are generated from `PROVIDER_ORIGINS` there, so a new
provider cannot ship with an unreachable host. Add tests that pin the exact
request shape. At least one provider rejects unknown fields outright.

## Commit messages

Say what changed and why it was wrong before. A reader six months from now is the
audience.

## Code of conduct

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Releasing

Two things ship from this repository and they have separate tags, so releasing
one never releases the other by accident.

| | Tag | What happens |
|---|---|---|
| the daemon | `local-v0.1.0` | tests, then `npm publish --provenance` of `local/` as `@anona-labs/magpie-local` |
| the extension | `v0.1.0` | tests, then the Web Store zip is built and attached to the release |

```bash
# the daemon
npm version --prefix local 0.1.1 --no-git-tag-version
git commit -am "release: magpie-local 0.1.1" && git tag local-v0.1.1 && git push --follow-tags

# the extension
git tag v0.1.1 && git push --follow-tags
```

Both workflows refuse if the tag and the version in the file disagree, because
a tag that says one thing and a package that says another is a release nobody
can reason about afterwards. The publish also re-runs `sync-lib.mjs` and fails
on a diff: the daemon carries a copy of the extension's chunker, and a stale
copy would mean the published package behaves differently from the repository
it names.

### Getting npm to accept the publish

Two paths, in the order the workflow tries them, and the same two the SDK's
`publish-npm.yml` uses:

1. **Trusted Publishing (OIDC).** Nothing is stored anywhere: npm verifies the
   workflow itself. This is what a second repository should use rather than
   being handed a copy of the SDK's token. It can only be configured on a
   package that already exists, so it cannot do the first publish.
2. **An `NPM_TOKEN` repository secret**, a granular token scoped to
   `@anona-labs` with "bypass 2FA". Needed for the first version, and
   deletable once (1) is set up.

The SDK's token cannot be shared: a GitHub secret is write-only, so no
workflow in another repository can read it. It is a repository secret on
`anonalabs/Anona-Memory-SDK`, not an organisation one. To use one token for
both, promote it to the org and grant it to both repositories:

```bash
gh secret set NPM_TOKEN --org anonalabs --visibility selected \
  --repos "Anona-Memory-SDK,magpie"
```

Better for this package: mint a granular token that can publish
`@anona-labs/magpie-local` and nothing else, so a compromised workflow here
cannot publish the SDK. Then, after the first release, configure a trusted
publisher on npm pointing at `publish-local.yml` and delete the token.

The workflow also uses the `npm` environment, so whatever protection rules the
org puts on releases apply here too.

`workflow_dispatch` on the publish workflow defaults to a dry run, so the
packing and the checks can be exercised without shipping anything.
