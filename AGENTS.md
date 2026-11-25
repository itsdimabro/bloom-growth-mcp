# Bloom Growth MCP - rules for agents

A local MCP server (Node, ESM, stdio) that turns Bloom Growth's REST API description into tools. Read this before you change the repo.

## Module map

| Path | Job |
|---|---|
| `api/` | Bloom's own API descriptions, saved byte for byte. Change them only with `npm run sync-api` |
| `src/server.js` | entry: reads the settings, lists the tools, checks each call's input, answers it |
| `src/config.js` | every setting, read from the environment and checked |
| `src/api-specs.js` | the list of saved API descriptions and how to load them |
| `src/tools.js` | API description to MCP tools: names, input schemas, toolsets, read-only filter, server instructions |
| `src/bloom-client.js` | sign-in, token cache, one HTTP request per tool call |
| `scripts/sync-api.mjs` | fetches Bloom's current API descriptions and reports what changed |
| `test/fake-bloom.mjs` | local stand-in for Bloom's API, used by the tests |
| `test/*.test.mjs` | one file per module, plus `server-stdio` (a real MCP client against the server) |
| `.github/workflows/` | `test` runs the tests on every change; `api-watch` runs `sync-api` weekly and opens a pull request; `release` publishes to npm and to the official MCP registry when a GitHub release is published |
| `server.json` | the server's entry in the official MCP registry: its name, version and settings |

## Rules

- Tools come only from the saved API descriptions. Never add or edit a tool by hand: a wrong or missing tool is fixed in `src/tools.js` or by `npm run sync-api`.
- A tool's name is its method and path (`GET /api/v1/rocks/user/mine` is `get_rocks_user_mine`). Keep the scheme, because a renamed tool breaks every prompt that uses it.
- The server lists only GET operations unless `BLOOM_GROWTH_WRITES=1`. Keep read-only as the default.
- Never print, log or commit a password or a token, and never put one in an error message.
- The tests never call Bloom's real API. A check against the real API uses reading tools only.
- Every setting is read in `src/config.js` and listed in the README's Settings table. Add both in the same change.
- The README's tool counts and toolset table are checked by `test/readme.test.mjs`. When `npm run sync-api` changes the counts, update the README in the same change.
- A release sets the same version in `package.json` and `server.json` (`test/registry.test.mjs` checks it), then publishes a GitHub release tagged `v<version>`. The `release` workflow sends it to npm, then to the official MCP registry.
- Run `npm test` before every commit.
- No build step, no TypeScript, no new dependency without a reason the pull request states.
