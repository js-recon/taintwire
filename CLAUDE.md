# taintwire

Babel/CS-MAST AST → LadybugDB graph library, published to npm as `@js-recon/taintwire`. Docs site source is in `docs/` (Docusaurus), served at https://taintwire.js-recon.io.

- Build: `npm run build` (tsc → `build/`, the only directory that ships)
- Test: `npm test` (vitest)
- Docs: `cd docs && npx docusaurus build` (fails on broken links)

Branding assets live in `docs/static/img/` (`banner.png`, `logo.png`, `favicon.png`, downscaled from the originals with `sips -Z`). The README pulls the banner from `raw.githubusercontent.com/.../main/...` so it renders on npmjs.com too.

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

2. **Bump the version** in `package.json` and add `## X.Y.Z - YYYY-MM-DD` to the top of `CHANGELOG.md`, with `### Added` / `### Changed` / `### Fixed` (and `### Security` for vulnerability fixes). Cover every `feat`/`fix` from step 1. `version_check` fails the release unless package.json, the first CHANGELOG heading and the release tag all match.

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
