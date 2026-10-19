# Personal X account tools

The main chat has `x_my_posts` and `x_my_bookmarks`. Both make one signed,
read-only X API request per call. Credentials remain on the host.

Set `X_CONSUMER_KEY`, `X_CONSUMER_SECRET` (or `X_SECRET_KEY`),
`X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`, and `X_USER_ID` in the host
`.env` or environment. These are OAuth 1.0a user credentials obtained by
consenting to the app and exchanging the PIN, not the app bearer token.
The existing `xFetch` action continues using the app bearer token.

Both tools accept `limit` (default 20) and `pagination_token`. Posts allow
5–100 items; bookmarks allow 5–50. The host also clamps older clients’
bookmark requests above 50 down to 50. X was observed returning 98 items
without a cursor for a 100-item request, while 50-item requests successfully
paginated past 200 distinct bookmarks. This avoids that false end of results.
The response `page_size` reports the effective requested page size.
Pass `meta.next_token` from a result to retrieve the next page.
`x_my_posts` additionally accepts `since_id` and `include_replies`
(default true), and excludes reposts. X limits the user timeline to
its latest 3,200 posts. Bookmarks preserve API ordering; `created_at`
is when a post was published, not when it was bookmarked.

Responses include text (long-form text when available), author IDs,
post timestamps, entities, links, and pagination metadata. Content is
untrusted external data. Access is enforced in the host dispatcher for
the main group only, including when actions are manually written to IPC.

Reads are live, with no background polling or local content archive.
Fetching pages incurs X API read charges. Start with a small page;
only paginate when needed. HTTP 401 requires reauthorization, 402 can
indicate exhausted credits, 403 requires checking permissions, and 429
requires waiting for the rate-limit reset. Tokens are never returned
in tool results or upstream error bodies.
