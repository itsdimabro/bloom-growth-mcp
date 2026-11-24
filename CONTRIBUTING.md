# Contributing

Bug reports and pull requests are welcome.

## Set up

```bash
git clone https://github.com/itsdimabro/bloom-growth-mcp.git
cd bloom-growth-mcp
npm install
npm test
```

You need Node.js 22 or newer. The tests use a local stand-in for Bloom's API, so you need no Bloom Growth account to run them.

## Before you open a pull request

- `npm test` passes.
- A fix comes with a test that fails without it.
- A new setting is read in `src/config.js` and listed in the README's Settings table.
- No tool is added or edited by hand. Tools come from the files in `api/`, and those change only through `npm run sync-api`.

[AGENTS.md](AGENTS.md) has the module map and the rest of the rules. They apply to people and to coding agents.

## Reporting a bug

Open an issue with the tool name, the input you sent and the answer you got. Remove names, emails and other real data first, and never paste a password or a token.

A security problem goes through [SECURITY.md](SECURITY.md), not a public issue.
