# Publishing to npm (maintainers)

Two packages go to npm under the `@reconsumet` scope: **`@reconsumet/core`** (the library + `reconsumet` CLI) and
**`@reconsumet/client`** (the typed API client). The servers (`api`, `relay`) and `db` are `"private": true` and ship
as Docker images instead.

The very first release is published by hand, because npm needs your login for that. Every release after it is
published by GitHub Actions when you push a `vX.Y.Z` tag, using npm **trusted publishing**: GitHub proves to npm
which repo and workflow is publishing, so there is no npm token stored anywhere. npm also attaches a provenance
statement (which commit built the package) automatically.

Everything goes through one script, `node scripts/publish-npm.mjs`. It refuses to run on a dirty working tree or when
the package versions don't match the root `package.json`, builds, packs each package with `pnpm pack` (which turns
`workspace:*` into real versions), and publishes the tarball. **Versions that are already on npm are skipped**, so
running it twice is harmless. `--dry-run` shows what would be published; `--tag next` publishes under another
dist-tag.

## One-time setup and the first publish

1. On npmjs.com, signed in: **Add organization** → name `reconsumet` → the free plan (public packages only).
2. On your PC:

   ```sh
   cd RECONSUMET.TS
   git status                          # must be clean, on the release commit
   npm login                           # opens the browser; sign in with your passkey
   npm whoami
   pnpm install --frozen-lockfile
   node scripts/publish-npm.mjs --dry-run
   node scripts/publish-npm.mjs        # npm may ask for a 2FA confirmation in the browser
   ```

3. For **each** package (`@reconsumet/core`, `@reconsumet/client`): npmjs.com → the package → **Settings** →
   **Trusted Publisher** → **GitHub Actions**:
   - Organization or user: `thesupersupersigma`
   - Repository: `RECONSUMET.TS` (exact casing)
   - Workflow filename: `release.yml`
   - Environment: leave empty
   - Tick **allow `npm publish`**. (Without it, configs created after 2026-09-03 only allow *staged* publishes, which
     then wait for a manual 2FA approval on npmjs.com.)
4. Recommended: package **Settings** → **Publishing access** → "Require two-factor authentication and disallow
   tokens". Trusted publishing keeps working; leaked tokens can't publish.

## Later releases

```sh
# bump "version" in package.json and every packages/*/package.json (and VERSION in packages/api/src/app.ts)
git commit -am "chore(release): X.Y.Z"
git tag vX.Y.Z
git push && git push origin vX.Y.Z
```

The tag runs `.github/workflows/release.yml`: job `npm` installs, builds, tests and runs `publish-npm.mjs` with OIDC
(`id-token: write`), and job `images` pushes the Docker images to GHCR. If the npm job fails halfway, fix the cause
and re-run the job: what's already published is skipped.

## A bad publish

- **Deprecate, don't delete:** `npm deprecate @reconsumet/client@X.Y.Z "broken, use X.Y.Z+1"`, then release a fixed
  version. Deprecation shows a warning on install and can be undone (`npm deprecate … ""`).
- **Unpublish** (`npm unpublish @reconsumet/client@X.Y.Z`) only works within 72 hours of publishing if nothing on
  npm depends on it; after that only if the package has no dependents, under 300 downloads in the last week and a
  single owner. A version number can **never** be reused once published, even after unpublishing.
- A wrong dist-tag: `npm dist-tag add @reconsumet/core@X.Y.Z latest`.
