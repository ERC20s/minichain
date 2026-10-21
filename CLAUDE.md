# minichain

A blockchain built from scratch in TypeScript: blocks, ed25519 signatures, Merkle
roots, proof of stake, WebSocket gossip and a JSON-RPC API.

## Commands

    npm ci          # install (package-lock.json is committed)
    npm run dev     # run one node: gossip on PORT (9300), JSON-RPC on RPC_PORT (9310)
    npm test        # the project's check: jest over test/**/*.test.ts

These match the `run:` block at the end of `.d8a` and the README. CI
(`.github/workflows/ci.yml`) runs `npm ci` and `npm test` on every push and pull
request. Settings are environment variables; see `.env.example` and the README.

Tests that open gossip sockets use fixed ports and jest runs files in parallel:
give each new test file its own ports (grep `test/` before picking).

## Ground rules

- Work on a new branch from `main`; one pull request per task, whose description
  lists the commands run and their results before and after.
- Never modify `.d8a` or `.d8a-governance`. Never modify the group-store widget
  markup/script copied from the `payments:` block of `.d8a` (`id="group-store"`,
  `groupStoreVerify`).
- Ignore open pull requests by `d8a[bot]`: do not merge, close, rebase,
  cherry-pick from or comment on them.
- Do not add a LICENSE file or any licence text.
- Install dependencies and run the project's checks before and after a change.
  Never report a result you did not get by running the command.
- Every new test must be able to fail: no `require(x >= 0)` on unsigned values,
  no bare `vm.expectRevert()`, no `try/catch` that accepts any error, no
  asserting a value equals itself. Import every symbol you use. If a test is
  wrong rather than the code, fix the test to test the real behaviour and say so.
- Fix root causes; never delete or weaken a test to get green.
- Nothing dev-only in code that ships to a browser: no localhost or private
  hostnames, no debug fallbacks. No secrets, tokens or keys in the repo.
- CI runs exactly the declared checks and fails when one fails: no
  `continue-on-error`, no `|| true`, no skipped jobs counted as passing. Pin
  GitHub Actions to their current major versions.
- Keep changes focused: no reformatting untouched files, no unneeded dependency
  upgrades, no renaming public files or URLs, no rewriting git history.
