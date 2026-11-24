# Bloom Growth's API descriptions

- `bloom-growth-v1.json`: the v1 API, from `https://dev-api.bloomgrowth.com/swagger/v1/swagger.json`
- `bloom-growth-v2.json`: the v2 score endpoints, from `https://dev-api.bloomgrowth.com/swagger/v2/swagger.json`

Both files are saved byte for byte as Bloom Growth serves them. They belong to Bloom Growth and are not covered by this repo's MIT license. They are here so the server can build its tools without a network call, and so every API change shows up as a reviewable diff.

Never edit them by hand. `npm run sync-api` replaces them with Bloom's current versions.
