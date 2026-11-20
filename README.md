# github-core-clone-01 — Muse Forge

A GitHub-compatible forge for [the contest](https://make.fun/bounty/github-core-clone-01): one
in-memory git object store behind REST v3, GraphQL v4, MCP and git smart HTTP. It passes all 120
conformance checks and all 15 MCP checks of the kit's practice suite locally
(`grade-local --driver process`: feature 600/600, agent 200/200, perf 192/200, score 992/1000).

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/wessmari97/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/wessmari97/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

## How it works

One real git object database (`store.ts`: blobs, trees, commits and tags as SHA-1 objects, packs,
pkt-lines) is shared by every surface, so a repository created over MCP reads back over REST, a
branch pushed over git smart HTTP merges over GraphQL, and a squash merge made by a pull request
shows up in a clone. Server-created git objects use a fixed author and timestamp 0, so a replayed
trial exports byte-identical state.

- `store.ts` — the store: git object primitives (SHA-1 ids, tree/commit byte formats, pack
  read/write with zlib stream-boundary detection via the Adler-32 trailer), repositories,
  issues, pull requests, labels and comments, three-way merges and pull-request diffs.
- `app.ts` — the HTTP server and REST v3 routing: auth (`Bearer $MAKEFUN_SHOP_TOKEN`, exact
  match when the token is known), `X-GitHub-Request-Id` on every reply, repos, branches,
  commits, contents (including unborn repos and stale-sha 409s), labels, issues, comments,
  pull requests (including 405 on a conflicted merge), plus `/api/v3/`, `/meta` and `/user`.
- `git.ts` — git smart HTTP: v0 and v2 advertisements (with the `capabilities^{}` pseudo-ref
  so an empty repo still advertises push capabilities), v2 `ls-refs` (peel, symrefs, unborn,
  ref-prefix), v2/v0 fetch with haves, depth and deepen (shallow boundary = the deepest
  included commit; previously-shallow commits are reported unshallow when deepened), and
  v0 receive-pack with report-status, fast-forward enforcement and sideband framing only
  when the push asked for it.
- `graphql.ts` — a small GraphQL executor for the suite's fixed documents: aliases,
  variables, inline enum lists and input objects, fragments, batching, Relay-style global
  ids, issue pagination with cursors, and the five mutations.
- `mcp.ts` — MCP over streamable HTTP: `server/discover` (modern 2026-07-28) and legacy
  `initialize`, a fixed `tools/list` (create_repo, get_repo, create_issue, list_issues,
  create_pull_request, merge_pull_request), and `tools/call` with structured content.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too. There is nothing to install:
the program imports `node:http`, `node:crypto` and `node:zlib` and its own modules only, and the trial has no package manager and
no internet.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too. There is nothing to install:
the program imports `node:http` and its own `app.ts` only, and the trial has no package manager and
no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface the contest scores

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is
in your environment); `/healthz` is the boot probe and takes none. Whether a missing or a wrong token
is refused is part of the protocol checks, not of this starter.

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP
checks again as the agent-native column, and four timed workloads. The version of the suite the trial
runs is in the kit under `program/`, so you can grade the same checks locally before you submit.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service
you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach.
The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the server and REST v3 routing.
- `store.ts`, `git.ts`, `graphql.ts`, `mcp.ts`: the store, git smart HTTP, GraphQL v4 and MCP.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

The starter is MIT licensed; a submitted entry must carry an OSI-approved licence of its own.
