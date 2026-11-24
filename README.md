# Bloom Growth MCP

An MCP server that lets an AI assistant read and change your Bloom Growth data: to-dos, Quarterly Priorities (rocks), O&Os (issues), headlines, Weekly KPIs and their scores, meetings, the Org Chart and processes.

Every tool is generated from Bloom Growth's own API description, so the server covers the whole API: 72 reading tools, and 128 tools with changes switched on. A weekly job checks Bloom's API and opens a pull request when it changes, so the tools follow the API.

Unofficial. Not affiliated with or endorsed by Bloom Growth.

## Install

You need Node.js 22 or newer. Add this to your MCP client's config (Claude Desktop, Cursor, VS Code, Windsurf):

```json
{
  "mcpServers": {
    "bloom-growth": {
      "command": "npx",
      "args": ["-y", "bloom-growth-mcp"],
      "env": {
        "BLOOM_GROWTH_EMAIL": "you@example.com",
        "BLOOM_GROWTH_PASSWORD": "your-password"
      }
    }
  }
}
```

In Claude Code, one command does the same:

```bash
claude mcp add bloom-growth --env BLOOM_GROWTH_EMAIL=you@example.com --env BLOOM_GROWTH_PASSWORD=your-password -- npx -y bloom-growth-mcp
```

## The login

Bloom Growth has no API keys, so the server signs in with an email and a password, the way Bloom's API documents it. It acts as that user: it sees what that user sees and, with changes switched on, can change what that user can change.

- Use a separate Bloom Growth user that can reach only the meetings and people the assistant needs. Bloom recommends this.
- A user who signs in with Google or Microsoft sets a password first, with **Forgot password?** on Bloom's sign-in page.
- A user in more than one organization works in the organization they last used in Bloom Growth.

To keep the password out of the client config, put both lines in a file only you can read and set `BLOOM_GROWTH_LOGIN_FILE` to its path:

```
BLOOM_GROWTH_EMAIL=you@example.com
BLOOM_GROWTH_PASSWORD=your-password
```

## Reading and changing

The server is read-only until you say otherwise: it lists only the tools that read (the API's GET operations). Set `BLOOM_GROWTH_WRITES=1` to also list the tools that create, update and delete. Those changes are real and happen as the signed-in user.

Each tool tells the client whether it reads, changes or deletes, so a client can ask you before a change.

## Settings

All settings are environment variables. Only the login is required.

| Setting | Default | What it does |
|---|---|---|
| `BLOOM_GROWTH_EMAIL`, `BLOOM_GROWTH_PASSWORD` | none | The login |
| `BLOOM_GROWTH_LOGIN_FILE` | none | A file that holds the two login lines, used when the two settings above are not set |
| `BLOOM_GROWTH_WRITES` | `0` | `1` lists the tools that change data |
| `BLOOM_GROWTH_TOOLSETS` | `all` | A comma list of toolsets to list, such as `todos,rocks,scorecard` |
| `BLOOM_GROWTH_MAX_RESPONSE_CHARS` | `200000` | Longer answers are cut at this length, with a note that says so |
| `BLOOM_GROWTH_TOKEN_FILE` | a file in your user cache folder | Where the sign-in token is kept between runs |
| `BLOOM_GROWTH_BASE_URL` | `https://app.bloomgrowth.com` | Another address for the API, for testing. It must use https, or be on this computer |

A setting the server cannot use, such as an unknown toolset, stops it at startup with the reason.

## Toolsets

Some clients limit how many tools they load, and every tool costs the model some attention. `BLOOM_GROWTH_TOOLSETS` keeps only the parts of Bloom Growth you use. A toolset is one section of Bloom's API description.

| Toolset | In Bloom's API | Reading tools | All tools |
|---|---|---|---|
| `headlines` | Headlines | 4 | 6 |
| `issues` | Issues (O&Os) | 4 | 10 |
| `l10` | L10 (meetings) | 14 | 30 |
| `measurables` | Measurables (Weekly KPIs) | 4 | 7 |
| `milestones` | Milestones | 1 | 3 |
| `process` | Process | 5 | 7 |
| `quarterlyconversations` | Quarterly Conversations | 2 | 2 |
| `rocks` | Rocks (Quarterly Priorities) | 7 | 13 |
| `role` | Role | 1 | 4 |
| `scorecard` | Scorecard | 3 | 3 |
| `scores` | Scores | 1 | 2 |
| `scoresv2` | Scores, v2 | 5 | 6 |
| `search` | Search | 2 | 2 |
| `seats` | Seats (Org Chart) | 6 | 13 |
| `teams` | Teams | 2 | 6 |
| `todos` | To-dos | 4 | 7 |
| `users` | Users | 6 | 6 |
| `week` | Week | 1 | 1 |

A tool's name is its method and path: `GET /api/v1/rocks/user/mine` is `get_rocks_user_mine`.

## How it stays current

The two files in `api/` are Bloom Growth's API descriptions, saved as Bloom serves them. The server builds its tools from them at startup, so there is no hand-written tool to fall behind.

```bash
npm run sync-api
```

This fetches Bloom's current descriptions, prints the operations that were added or removed, and saves them. `npm run sync-api -- --check` only reports. The repo runs it every week and opens a pull request when something changed.

## Security

- The password is sent only to the sign-in endpoint, over https. The server refuses an address that is not https, unless it is on this computer.
- The sign-in token lasts about 14 days. It is cached in a file so the server does not sign in on every start. The server sets that file to owner-only each time it reads or writes it. On Windows the file gets your user profile's permissions.
- Nothing is logged except startup errors and a failed cache write, and neither holds the password or the token.
- Tool inputs are checked against the tool's schema before anything is sent.

Report a vulnerability through [SECURITY.md](SECURITY.md).

## Develop

```bash
npm install
npm test
```

The tests run against a local stand-in for Bloom's API and never touch real data. [CONTRIBUTING.md](CONTRIBUTING.md) has the rules for a change.

## License

MIT for the code in this repo. The files in `api/` belong to Bloom Growth: see [api/README.md](api/README.md).
