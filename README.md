# nodedrift-ci

Fail CI when your Node.js version claims disagree with each other.

A project can declare its target Node version in four different places — `.nvmrc`,
`package.json`'s `engines.node`, a `Dockerfile`'s `FROM node:X`, and a GitHub Actions
workflow's `node-version:` — each edited by a different person at a different time. They
drift silently, and the bug that surfaces is "works in CI, breaks in the Docker image" (or
the reverse), discovered in production, not in review.

```
$ npx github:growaleaf/nodedrift-ci check
nodedrift-ci — mode: free (nvmrc + engines only)
  no drift found.
  (free mode checked .nvmrc + package.json only — Pro also checks every Dockerfile and
  GitHub Actions workflow: https://nodedrift-ci.madeforthisday.com)

$ NODEDRIFT_KEY=... npx github:growaleaf/nodedrift-ci check
nodedrift-ci — mode: Pro (nvmrc + engines + Dockerfile + CI workflows)
  DRIFT  [pinMismatch]  Pinned Node versions disagree: .nvmrc=20, Dockerfile:1=18, .github/workflows/ci.yml:10=20
  DRIFT  [enginesMismatch]  .nvmrc pins Node 20, which does not satisfy package.json engines.node ">=18.0.0 <19.0.0"
```

A deliberate CI version matrix (`node-version: [16, 18, 20]`, used to test multiple Node
versions on purpose) is detected and reported as skipped — it is never treated as drift.

## Install

No npm account needed — install straight from the GitHub repo:

```
npm install github:growaleaf/nodedrift-ci
```

Or run it without installing:

```
npx github:growaleaf/nodedrift-ci check
```

## Usage

```
node cli.js check [--dir <path>] [--json]
```

| Exit code | Meaning |
|---|---|
| 0 | no drift found |
| 1 | a drift finding exists — fail the build on this |
| 2 | configuration error — `--dir` does not exist |

`--json` writes the full report (every source checked, every finding, the skipped-matrix
list) to stdout, suited to a PR-comment bot or a lint-results artifact.

## Free vs. Pro

**Free, no key needed:** compares `.nvmrc` against `package.json`'s `engines.node`. Useful on
its own for a project with no Docker image and no CI-declared Node version.

**Pro ($9, one time):** also scans every `Dockerfile` (any file matching `Dockerfile*`,
anywhere in the repo) and every `.github/workflows/*.yml` for a `node-version:` declaration,
and cross-checks every source against every other source — this is where the real bugs are,
since the Dockerfile and the CI workflow are usually the two files furthest from active
editing.

The license key is checked **offline** — an ECDSA-signed token verified locally; the CLI
makes no network call to check it, ever, and reads neither your source files nor your
repository name over the network at any point.

```
export NODEDRIFT_KEY=<your key>       # CI secret
# or, on your own machine:
mkdir -p ~/.nodedrift && echo "<your key>" > ~/.nodedrift/license
```

Buy a key: https://nodedrift-ci.madeforthisday.com (one-time purchase, no subscription).

## How this differs from an existing tool you may already know

[`check-node-version`](https://www.npmjs.com/package/check-node-version) and
[`expected-node-version`](https://www.npmjs.com/package/expected-node-version) check the
**running** `node` binary against `package.json`/`.nvmrc` — they tell you if your current
shell is on the wrong version, not whether your Dockerfile and your CI workflow silently
disagree with each other. A search of the npm registry and GitHub for a tool that
cross-checks `.nvmrc` + `engines.node` + `Dockerfile` + CI workflow declarations together
turned up nothing with that exact scope as of 2026-10-20 — this is a narrow, specific gap,
not a crowded one.

## Source

Source is readable here before you buy. The free tier works as shipped; the Pro tier needs
a key (see `LICENSE`).
