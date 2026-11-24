# Security

## Report a vulnerability

Use **Report a vulnerability** on this repo's Security tab. That opens a private report only the maintainer sees. Do not open a public issue for a security problem.

Include what you did, what happened and which version or commit you ran.

## What the server holds

- **The login.** A Bloom Growth email and password, read from the environment or from the file `BLOOM_GROWTH_LOGIN_FILE` names. The server sends it only to the sign-in endpoint, over https, and never writes it anywhere. It refuses an address that is not https, unless it is on this computer.
- **The token.** Bloom's sign-in token, valid for about 14 days, cached in a file in the user's cache folder. The server sets the file to owner-only each time it reads or writes it (on Windows, the file gets the user profile's permissions). Anyone who can read that file can act as the signed-in user until the token expires.

The server acts as the signed-in user. Bloom Growth has no scopes and no read-only logins, so give the server a user that can reach only what the assistant needs.
