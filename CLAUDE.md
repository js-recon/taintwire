# taintwire

Babel/CS-MAST AST → LadybugDB graph library, published to npm as `@js-recon/taintwire`. Docs site source (Docusaurus) is in the separate repo [js-recon/taintwire-docs](https://github.com/js-recon/taintwire-docs) (`../taintwire-docs` in the workspace), served at https://taintwire.js-recon.io.

- Build: `npm run build` (tsc → `build/`, the only directory that ships)
- Test: `npm test` (vitest)
- Docs: `cd ../taintwire-docs && npx docusaurus build` (fails on broken links; that repo's CI runs it)

## Docs versions

In taintwire-docs, `docs/` is **Next** (served at `/next`): what's on its `dev`, shipped in alpha/beta releases. `/` serves the latest stable release from `versioned_docs/` (`lastVersion` in `docusaurus.config.ts`, listed in `versions.json`). Alpha and beta releases don't snapshot. For a stable release, run `npx docusaurus docs:version X.Y.Z` in taintwire-docs and set `lastVersion: "X.Y.Z"` before tagging. Fix old versions in `versioned_docs/version-X.Y.Z/`, not in `docs/`.

Branding assets live in taintwire-docs `static/img/` (`banner.png`, `logo.png`, `favicon.ico`; PNGs downscaled from the originals with `sips -Z`, favicon converted with `ffmpeg`). The README pulls the banner from `raw.githubusercontent.com/js-recon/taintwire-docs/main/...` so it renders on npmjs.com too.

## Docs hosting (Cloudflare Pages)

The `Cloudflare Pages: taintwire` / `taintwire-dev` checks on taintwire-docs come from two Pages projects with git integration on `js-recon/taintwire-docs`: `taintwire` (production branch `main`, taintwire.js-recon.io) and `taintwire-dev` (production branch `dev`, taintwire.stage.js-recon.io). Each also builds previews of every other branch. Build config: `npm run build`, output `build`, root dir `""` (the repo root; it was `docs` from when the site lived in the taintwire repo, which failed every deploy with `Output directory "docs/build" not found`).

Wrangler (`npx wrangler`, logged in with OAuth, `npx wrangler whoami`) lists projects (`npx wrangler pages project list`) but can't read or change the git build config, read build logs, or retry git deploys. For those, call the API with wrangler's token:

```bash
T=$(grep -E '^oauth_token' ~/.config/.wrangler/config/default.toml | cut -d'"' -f2)
B="https://api.cloudflare.com/client/v4/accounts/<account id from whoami>/pages/projects"
curl -s -H "Authorization: Bearer $T" "$B/taintwire" | jq '.result.build_config'                       # config
curl -s -H "Authorization: Bearer $T" "$B/taintwire/deployments/<id>/history/logs" | jq -r '.result.data[].line'  # build log
curl -s -X PATCH -H "Authorization: Bearer $T" -H "Content-Type: application/json" "$B/taintwire" -d '{"build_config":{...}}'
curl -s -X POST -H "Authorization: Bearer $T" "$B/taintwire/deployments/<id>/retry"                   # re-run; updates the GitHub check
```

## Branches

`main` is release-only and only takes `dev` through a PR. Do day-to-day work on `dev` or on feature branches off `dev`.

## Release process

Releases go out through npm **OIDC trusted publishing** from `.github/workflows/publish.yaml`, in the `publish` GitHub environment. No npm token exists anywhere. The trusted publisher is scoped to staged publishes (`npm stage publish`), the same as js-recon, so every release ends with a human 2FA approval.

Bump the version or edit CHANGELOG only when the user asks for a release.

1. **Gather state** (on `dev`):

    ```bash
    git checkout dev && git pull origin dev
    git describe --tags --abbrev=0          # previous release
    git log <prev-tag>..HEAD --oneline | grep -E "^[a-f0-9]+ (feat|fix)"
    ```

2. **Bump the version** in `package.json` (alpha/beta: `X.Y.Z-alpha.N`; stable: also snapshot the docs, see [Docs versions](#docs-versions)) and add `## X.Y.Z - YYYY-MM-DD` to the top of `CHANGELOG.md`, with `### Added` / `### Changed` / `### Fixed` (and `### Security` for vulnerability fixes). Cover every `feat`/`fix` from step 1. `version_check` fails the release unless package.json, the first CHANGELOG heading and the release tag all match.

3. **Verify locally:** `npm ci && npm run build && npm test`. Also run `npm pack --dry-run` and check that only `build/`, `package.json`, `README.md` and `LICENSE` ship.

4. **Push `dev` and open the PR:**

    ```bash
    git push origin dev
    gh pr create --repo js-recon/taintwire --base main --head dev --title vX.Y.Z --body "<CHANGELOG section>"
    ```

    Wait for the `Test` workflow to pass, and merge only with the user's approval.

5. **Create the GitHub release** from `main`:

    ```bash
    gh release create vX.Y.Z --repo js-recon/taintwire --target main --title vX.Y.Z --notes "<CHANGELOG section>"
    ```

    Add `--prerelease` for alpha/beta versions. The npm dist-tag is chosen from the tag name: `alpha`, `beta`, otherwise `latest`.

6. **Watch `publish.yaml`:** `gh run list --repo js-recon/taintwire --workflow "Publish taintwire"`. It runs `version_check` → `build` (npm ci, audit, build, test) → `publish-npm` (stages via OIDC) → `sync_dev` (fast-forwards `dev` to `main`; if `dev` moved after the merge, this job fails, so sync by hand).

7. **Human-only:** a staged package is not live. Report the stage id (`npm stage list @js-recon/taintwire`, or the "Staged Packages" tab on npmjs.com) and wait. The user runs `npm stage approve <stage-id>` (2FA) or clicks Approve on npmjs.com. Claude cannot do this step.

8. **Confirm:** `npm view @js-recon/taintwire@X.Y.Z version`.

## One-time setup (done once, kept for reference)

npm only lets you configure a trusted publisher on a package that already exists, so the package was bootstrapped by hand:

1. Created `dev` from `main`.
2. The user ran `npm publish --access public` locally for a placeholder `0.0.1` (2FA).
3. On npmjs.com → `@js-recon/taintwire` → Settings → Trusted publisher → GitHub Actions: org `js-recon`, repo `taintwire`, workflow `publish.yaml`, environment `publish`. The GitHub environment was created with `gh api -X PUT repos/js-recon/taintwire/environments/publish`. npm can't edit these fields afterwards; to change them, delete the connection and create it again. Publishing access: require 2FA and disallow tokens.
4. `npm deprecate @js-recon/taintwire@0.0.1 "placeholder, use >=0.1.0"`.
5. `0.1.0` was the first release through the workflow above.

If `publish.yaml` is renamed or the job's `environment:` changes, update the trusted publisher on npmjs.com in the same change, otherwise OIDC auth fails.
