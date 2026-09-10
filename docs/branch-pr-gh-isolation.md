# Branch-per-feature workflow with an isolated `gh` credential

> This is a general runbook, kept in the repository so contributors can read
> the process this project follows. A canonical copy is maintained outside
> the repository for reuse across projects. `camris-tools` is the reference
> implementation: it uses `nixpkgs-24.11-darwin`, a Node toolchain, and the
> `ci.yml` shown in the Templates section.

A reusable setup. It makes a project use feature branches and reviewed pull
requests, and it gives `gh` a GitHub token that works for one repository only.

Written in a Simplified Technical English style: short sentences, active
voice, one instruction per step, one term per concept. The lexical rules of
ASD-STE100 are a direction, not a checked standard, because the official
word list is not reproduced here.

## Purpose

This runbook prepares a project so that:

- Every change reaches the `main` branch through a reviewed pull request.
- The `gh` command uses a GitHub token that is scoped to one repository.
- The token comes from 1Password. No step writes it to disk.
- A token from one project cannot act on another project's repositories.

The `git` remote uses SSH. `git push` and `git pull` do not use the token.
The token is only for `gh` API calls, such as "create pull request".

## Who does each task

| Task | Who |
|---|---|
| Create `flake.nix`, `.envrc`, and `.gitignore` entries | Claude |
| Run `nix flake lock` and commit `flake.lock` | Claude |
| Add the `CLAUDE.md` branch rule | Claude |
| Add the `block-main-writes` hook and register it | Claude |
| Add a CI workflow file | Claude |
| Add a README section | Claude |
| Create branches, commits, and pull requests | Claude |
| Create the GitHub fine-grained token | You |
| Get the token approved in the organization | You, or an organization owner |
| Enable the 1Password CLI integration | You |
| Store the token in a 1Password item | You |
| Run `direnv allow` | You |
| Approve each commit message | You |
| Merge each pull request | You |

Claude cannot do the "You" tasks. They need a GitHub web session, the
1Password app, or your approval on the machine.

## Prerequisites

- macOS or NixOS.
- Nix, with flakes enabled.
- direnv, with the `nix-direnv` library loaded.
- The 1Password desktop app.
- A GitHub account with access to the target repository.
- A `git` remote that uses SSH, not HTTPS.

Substitution points, not covered in full:

- A project without Nix gets `gh` and `1password-cli` from another source,
  such as Homebrew. The `.envrc` token logic does not change.
- A project without 1Password reads the token from the login Keychain
  (macOS `security`) or from `libsecret` (NixOS `secret-tool`). Only the
  one line in `.envrc` that calls `op read` changes.

## Phase 1 — Repository files (Claude)

Claude creates these files on one feature branch and opens a pull request
for them. Claude does not commit them to `main`.

### 1.1 `flake.nix`

Create `flake.nix` with a devShell that contains `gh`, `_1password-cli`,
and the project's own toolchain. Use the template in the Templates section.

Notes:

- `_1password-cli` has an unfree license. The `allowUnfreePredicate` allows
  that one package and no other.
- Choose the `nixpkgs` branch that matches the operating system. Use
  `nixpkgs-24.11-darwin` on macOS. Use `nixos-24.11` on NixOS. A shared
  branch such as `release-24.11` also works.

### 1.2 `.envrc`

Create `.envrc` with the template in the Templates section. It loads the
devShell and reads the token from 1Password.

Notes:

- `op read` writes the token to the `GH_TOKEN` variable in the current
  shell only.
- If `op read` fails, `.envrc` prints the error. It does not hide the
  failure. A hidden failure lets `gh` use an old global token that looks
  valid but lacks the scopes.
- `OP_GH_TOKEN_REF` sets the 1Password location. A git-ignored
  `.envrc.local` can override it.

### 1.3 `.gitignore`

Add these lines:

```
.direnv/
.envrc.local
```

### 1.4 Lock the flake

1. Stage the new files, or mark them with `git add -N`. Nix ignores
   untracked files in a dirty git tree.
2. Run `nix flake lock`.
3. Commit `flake.lock`. It pins the exact tool versions.

### 1.5 `CLAUDE.md` branch rule

Add a section to `CLAUDE.md` that states the rule:

- Every change reaches `main` through a reviewed pull request.
- Branch from `main` with `git checkout -b <type>/<short-name>`.
- The `type` is one of `feature`, `fix`, `docs`, `chore`.
- Run the project's build and tests on the branch before you open the
  pull request.

### 1.6 `block-main-writes` hook

1. Create `.claude/hooks/block-main-writes.sh` from the template.
2. Make it executable.
3. Register it in `.claude/settings.json` from the template.

Notes:

- The hook stops `git commit` and `git push` while the repository is on
  `main`.
- The hook matches the text `git commit` and `git push` anywhere in the
  command. It blocks a command that only names those words, such as an
  `echo` or a `git log --grep`, while you are on `main`.
- To make a deliberate exception, run the `git` command in a terminal.
  The hook does not act on commands that Claude did not start.
- Claude Code may ask you to approve the new hook. Approve it once.

### 1.7 CI workflow

Add a workflow that runs the project's checks on each pull request to
`main`. The checks depend on the project. The Templates section has an
example for a Node project.

Notes:

- A project with a different toolchain uses its own commands.
- A project may add deploy steps or extra gates. This runbook does not
  describe them.
- If `main` deploys automatically, the review gate also stops unfinished
  work from reaching production.

### 1.8 README section

Add a "Contributing" section to the README. State:

- The branch-and-pull-request rule.
- How to enter the devShell: `direnv allow`, or `nix develop`.
- That `gh` uses a repository-scoped token from 1Password.
- The one-time token steps, or a link to this runbook.

## Phase 2 — The GitHub token (You)

### 2.1 Create the token

1. Open GitHub. Go to Settings, then Developer settings, then Personal
   access tokens, then Fine-grained tokens.
2. Select "Generate new token".
3. Set the resource owner to the repository's organization, or to your
   account.
4. Set "Repository access" to "Only select repositories". Select the
   target repository.
5. Set these repository permissions:
   - Pull requests: Read and write
   - Contents: Read-only
   - Metadata: Read-only (GitHub sets this)
   - Actions: Read-only
6. Set an expiration date. Add a calendar reminder for that date.
7. Select "Generate token". Copy the token value.

Notes:

- "Pull requests: Read and write" is enough to create a pull request, to
  merge it, and to delete the branch through `gh`. This is tested.
- Keep "Contents" at Read-only unless a task needs to write files to the
  repository.
- "Actions: Read-only" lets `gh` read CI status.

### 2.2 Get organization approval

If the organization requires approval, an organization owner approves the
token.

- Path: Organization, then Settings, then Personal access tokens, then
  Pending requests.
- The token value exists at once. It returns HTTP 403 until an owner
  approves it.

### 2.3 Enable the 1Password CLI integration

Do this once per machine.

1. Open the 1Password desktop app.
2. Go to Settings, then Developer.
3. Enable "Integrate with 1Password CLI".

### 2.4 Store the token in a 1Password item

Use the app, or the command line.

App:

1. Create a new item. Category: API Credential.
2. Title: `<repo> GitHub PAT`. Example: `camris-tools GitHub PAT`.
3. Put the token in the `credential` field.

Command line, inside the devShell:

1. Run `op vault list`. Note the vault name.
2. Run `read -rs GH_PAT` and press Return. Paste the token. Press Return.
   The input stays hidden.
3. Run:
   ```
   op item create --category "API Credential" \
     --title "<repo> GitHub PAT" \
     --vault "<vault>" \
     "credential=$GH_PAT"
   ```
4. Run `unset GH_PAT`.

Note: for a short time, `op item create` holds the token in its process
arguments. Another process on the machine can read process arguments. The
app method does not have this risk.

### 2.5 Check the reference

Run:

```
op read "op://<vault>/<repo> GitHub PAT/credential"
```

It prints the token value. If it prints an error, the vault name, the
title, or the field name is wrong.

### 2.6 Give Claude the reference

The default reference in `.envrc` is
`op://Private/<repo> GitHub PAT/credential`. If your vault name or title
differs, tell Claude the exact `op://...` reference. Or set
`OP_GH_TOKEN_REF` in `.envrc.local`.

## Phase 3 — Connect the token to the shell (You)

Claude cannot do this phase. You must do it on the machine.

1. Run `direnv allow` in the repository root.
2. The first load asks for Touch ID. Approve it.
3. The first load asks you to approve the `op` binary. Approve it.
4. Run `gh auth status`. Check that the active account shows `GH_TOKEN`
   as the source.
5. If a global keyring token exists, check that it shows
   "Active account: false".

## Phase 4 — Each feature

### Claude

1. Run `git checkout -b <type>/<short-name>`.
2. Make the change.
3. Run the project's build and tests on the branch.
4. Show you the commit message. Wait for your approval.
5. Run `git commit`.
6. Run `git push -u origin <branch>`. This uses SSH, not the token.
7. Run `gh pr create`. This needs the token. 1Password must be unlocked.
8. Report the pull request link and the CI result.

### You

1. Review the pull request.
2. Wait for CI to pass.
3. Merge the pull request. Use "Rebase" or "Squash" to keep `main` linear.
4. Delete the branch.

Claude can also merge with `gh pr merge`, with the same token, if you ask
for that.

### Claude, after the merge

1. Run `git checkout main`.
2. Run `git pull --ff-only`.
3. Delete the local branch.

## Known limits

- **1Password idle timeout.** The 1Password CLI authorization stops after
  a short idle time. `op read` then fails with "authorization timeout".
  To reduce this:
  - Raise the auto-lock time. Path: 1Password Settings, then Security.
  - Or run `eval $(op signin)` at the start of a work session. This gives
    a 30-minute sliding window.
  - A locked 1Password blocks every non-interactive `gh` call.
- **Hook text match.** The `block-main-writes` hook matches the text
  `git commit` and `git push`. It blocks a command that only names those
  words while you are on `main`. Run such a command in a terminal.
- **Token expiry.** The fine-grained token stops working on its
  expiration date. `gh` calls fail on that date. Create a new token.
  Update the 1Password item. The `op://...` reference does not change.
- **Per-project CI.** This runbook fixes the branch-and-pull-request
  process. It does not fix the test suite or the deploy policy. Each
  project defines those.

## One-time checklist for a new project

You:

- [ ] Create the fine-grained token for the repository.
- [ ] Get organization approval, if required.
- [ ] Enable the 1Password CLI integration, once per machine.
- [ ] Store the token in a 1Password item named `<repo> GitHub PAT`.
- [ ] Run `direnv allow`.
- [ ] Check `gh auth status`.

Claude:

- [ ] Add `flake.nix` with `gh`, `_1password-cli`, and the toolchain.
- [ ] Add `.envrc` with the `op read` token logic.
- [ ] Add `.direnv/` and `.envrc.local` to `.gitignore`.
- [ ] Run `nix flake lock`. Commit `flake.lock`.
- [ ] Add the `CLAUDE.md` branch rule.
- [ ] Add the `block-main-writes` hook. Register it.
- [ ] Add a CI workflow for the project's checks.
- [ ] Add the README "Contributing" section.
- [ ] Open the setup as a pull request. Do not commit it to `main`.

## Templates

Replace `<project>`, `<repo>`, `<vault>`, and the toolchain packages.

### `flake.nix`

```nix
{
  description = "<project> dev environment";

  inputs = {
    # Use the branch that matches your OS:
    #   macOS:  github:NixOS/nixpkgs/nixpkgs-24.11-darwin
    #   NixOS:  github:NixOS/nixpkgs/nixos-24.11
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-24.11-darwin";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          # _1password-cli is unfree; allow only that one package.
          config.allowUnfreePredicate = pkg:
            builtins.elem (nixpkgs.lib.getName pkg) [ "1password-cli" ];
        };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.gh
            pkgs._1password-cli
            # Add the project's own toolchain below, for example:
            #   pkgs.nodejs_20
          ];
        };
      });
}
```

### `.envrc`

```bash
use flake
watch_file flake.lock

# A git-ignored .envrc.local can override the token location.
[ -f .envrc.local ] && source_env .envrc.local

# GitHub PAT for `gh`, read from 1Password at shell entry — never written
# to disk or the login keychain. Needs the 1Password desktop CLI
# integration ("Integrate with 1Password CLI" in Settings -> Developer).
: "${OP_GH_TOKEN_REF:=op://Private/<repo> GitHub PAT/credential}"
if has op; then
  if op_out="$(op read --no-newline "$OP_GH_TOKEN_REF" 2>&1)"; then
    export GH_TOKEN="$op_out"
  else
    # Don't fall back silently — a stale global token would look fine but
    # lack this repo's scopes. Surface the real error instead.
    log_error "op read '$OP_GH_TOKEN_REF' failed; gh will use global auth, which"
    log_error "probably lacks this repo's scopes. op said:"
    log_error "  ${op_out}"
  fi
  unset op_out
fi
```

### `.claude/hooks/block-main-writes.sh`

```bash
#!/usr/bin/env bash
# PreToolUse(Bash) hook: refuse `git commit` / `git push` while on `main`.
#
# This project lands every change on `main` through a reviewed PR (see
# CLAUDE.md). The hook is a guard rail, not a lock: to handle a genuine
# exception, run the git command yourself in a terminal.
set -euo pipefail

input="$(cat)"

# Ignore any Bash command that is not a git commit / push.
case "$input" in
  *"git commit"* | *"git push"*) ;;
  *) exit 0 ;;
esac

repo_dir="${CLAUDE_PROJECT_DIR:-$PWD}"
branch="$(git -C "$repo_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"

if [ "$branch" = "main" ]; then
  cat >&2 <<'EOF'
Blocked: this project requires every change to land on `main` via a
reviewed PR, so `git commit` and `git push` are not allowed on `main`.

  git checkout -b <type>/<short-description>   # feature | fix | docs | chore
  # commit on the branch, push, open a PR against main

See CLAUDE.md ("Branch and PR workflow"). For a deliberate exception, run
the git command yourself in a terminal.
EOF
  exit 2
fi

exit 0
```

### `.claude/settings.json`

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR/.claude/hooks/block-main-writes.sh\""
          }
        ]
      }
    ]
  }
}
```

### `.github/workflows/ci.yml` (example — Node project)

```yaml
name: CI

on:
  pull_request:
    branches: [main]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build
      - run: npm run test
```
