# CLAUDE.md

## Branch and PR workflow

Every change reaches `main` through a reviewed pull request — features,
docs, config, and one-line fixes alike. Nothing is committed directly to
`main`.

Steps for any change:

1. Branch off `main`: `git checkout -b <type>/<short-description>`
   (`type` is one of `feature`, `fix`, `docs`, `chore`).
2. Commit the work on that branch.
3. Verify on the branch before opening the PR:
   - `npm run build` — `tsc -b && vite build`
   - `npm run test` — the `tsx` suites in `test/`
4. Push the branch and open a PR against `main`.
5. Merge through the PR once CI is green and the change has been reviewed.

Why: `main` auto-deploys to GitHub Pages (`.github/workflows/deploy.yml`),
so anything committed to `main` ships to production immediately.

Enforcement:

- `.claude/hooks/block-main-writes.sh` (wired in `.claude/settings.json`)
  blocks `git commit` and `git push` while the repo is on `main`. For a
  deliberate exception, run the git command yourself in a terminal.
- `.github/workflows/ci.yml` runs `npm run build` and `npm run test` on
  every PR to `main`.

## Commit messages

Show the drafted commit message and wait for approval before running
`git commit`.

## Orientation

See `README.md` for what the two tools do and the design constraints they
must respect.
