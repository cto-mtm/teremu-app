# MCP — Teremu inside other AI assistants

Status (2026-10-24): **design, nothing built.** Decisions below were agreed
with the product owner and revised after a code review the same day; items
under *Open questions* are not.

A restaurant connects Teremu to the assistant they already use (Claude,
ChatGPT, Gemini, a Grok-based bot, Cursor…) and asks it about their own
numbers: "which dishes lost margin this month", "what did Makro charge me
for tomatoes", "how much did I spend on vendors in September". Teremu
exposes a **remote MCP server** (Model Context Protocol); the external
assistant runs — and pays for — the model, Teremu answers tool calls.

## Scope

- **Read-only.** Every exposed tool is a `query` or read-only `code` row
  from the in-app assistant (`firebase/functions/src/assistant/tools.ts`).
  No `propose` rows, no writes, no confirm flow.
- **Invoices go through the app.** When the user wants to upload an
  invoice, the assistant gives them a link to `https://app.teremu.com/scan`
  and they use the normal scanner (`ingest()`, scan meter, triage). We do
  **not** accept files over MCP and we do **not** accept invoices the
  external assistant OCR'd itself: triage must have the original, and our
  extraction/dedupe must run on it.
- **Same permissions as the app.** A connection acts as one member of one
  location, with that member's current perms.
- **One location per connection** (known limit). An owner with three
  locations connects three times and no single question spans them. A
  grant could carry several `rid`s later (consent would list them and
  every tool would take a location argument); not in the first release.

Non-goals (for now): writes of any kind, file transfer, chat-bot channels
(WhatsApp/Telegram — those would run our own `llm.ts` assistant, not MCP),
listing in the ChatGPT / Claude connector directories.

## Shape

```
external assistant ──HTTPS (Streamable HTTP, JSON-RPC)──► mcp Cloud Function
                                                            │  bearer = Teremu access token
                                                            ├─ token hash → grant (uid, email, rid)
                                                            ├─ loadMember → permissionList   (tenancy.ts)
                                                            ├─ restaurant doc → plan, currency, name, tz  (one read)
                                                            ├─ reserveDaily(rid, "mcpCalls")   (helpers/dailyCap.ts)
                                                            └─ tools.ts rows → Firestore (tenant-scoped)
```

- A **new `mcp` function**, separate from `api`: different auth (OAuth
  access tokens, not Firebase ID tokens), different CORS (server-to-server,
  no browser origin), and it must serve the OAuth discovery documents.
  Hosting rewrites `/mcp`, `/oauth/**` and `/.well-known/oauth-**` to it so
  the public URL is `https://app.teremu.com/mcp`. **Rewrite order matters:**
  Firebase Hosting takes the first match, and `/oauth/email/callback`
  already goes to `emailOauthCallback` — that line stays above the new
  `/oauth/**` one (`firebase/firebase.json`, checked by
  `scripts/check-ports.mjs`).
- **Stateless** Streamable HTTP: each POST is self-contained, no session
  store, no SSE stream needed for tools-only servers.
- **Tenancy helpers move, they are not re-implemented.** `loadMember` in
  `tenancy.ts` is module-private today and takes `(uid, email, rid)`; it
  gets exported, and the grant stores `email` so a Member can be built
  without a Firebase token. `permissionList()` is a private function in
  `api.ts`; it moves to `tenancy.ts` so `mcp` can import it without the
  router. `resolveMember` is **not** used: it attaches pending invites and
  falls back to the caller's default location on a miss, and an MCP call
  must never fall back — no member at the grant's `rid` is a 401.
- **Per call** that is: one member read, one restaurant read (plan,
  currency, name, timezone — the same read feeds the cap, the envelope and
  the `instructions`), one cap transaction, one log write, then the tool's
  own reads. With 3–10 calls per question this is still cents per month at
  the cap. Do not cache the member or the plan across calls: the
  "perms take effect on the next call" promise below depends on it.

### Where the adapter lives

**Recommended: in `@mtmcya/assistant`** as a new `@mtmcya/assistant/mcp`
entry that takes the same `ToolRow[]` + manifest the chat engine takes and
returns a request handler. The engine already knows how to run a `query`
row (resolve `{tenant}`, `$input.*`, map, validate against `output`) and
how to build an `AssistantContext` for `code` rows; duplicating that in
Teremu would fork the semantics. Dirumed and Pasdiu get MCP for free.

Fallback if the package can't take it soon: a local adapter in
`firebase/functions/src/mcp/` that calls `execute(ctx)` for `code` rows and
re-implements the small `query` runner. The fallback is smaller than it
sounds: every `code` row in `assistant/code/` reaches Firestore through
`tenantRef(ctx)`, which reads only `ctx.tenantId`, so the context to fake
is `{ tenantId, input }`. Throwaway once the package ships it; the package
decision does not block step 1 of the rollout.

## Tools

| Row | Expose | Notes |
|---|---|---|
| `searchIngredients` | yes | |
| `getPriceChanges` | yes | |
| `getDishCosts` | yes | |
| `getRecentInvoices` | yes | approved only, as today |
| `getInvoiceLineItems` | yes | |
| `getVendors` | yes | |
| `getCounts` | yes | |
| `getAppHelp` | yes | static help; answers "how do I upload" too, and its upload entry carries the `/scan` URL so a member without `scan:write` still gets the link |
| `getRevenue`, `getExpenses` | yes | `finance:read` |
| `getRestaurantNotes` | yes | owner-written text |
| `listMenuItems` | yes | |
| `getRestaurantListing` | **no** | live Google Places call with its own paid daily cap (`assistantPlaces`); not reachable from third-party bots |
| `proposeIngredient`, `proposeMenuItem` | **no** | writes |
| `openScanner` | yes, **as a link** | returns `{ url: "https://app.teremu.com/scan" }` + "send the user here to upload"; gated by `scan:write` like today |
| `openTriage`, `openDish`, `openIngredient`, `openVendor` | yes, **as links** | `destinations` from the manifest, prefixed with the web-app origin |
| `search` | yes, **MCP-only** | ChatGPT rejects a connector without `search` + `fetch` outside developer mode, and deep research uses only those two. `search(query)` fans the text over ingredients, dishes, vendors and approved invoices (each via its existing row's query, perms applied per area) and returns `{ id, title, url }` hits with a typed id (`ingredient:<id>`, `dish:<id>`, `vendor:<key>`, `invoice:<id>`) |
| `fetch` | yes, **MCP-only** | `fetch(id)` returns the one record (the same shape its row returns, plus `url`); unknown prefix or wrong tenant → not found |

`search` and `fetch` live in `mcp/tools.ts`, not in the assistant's
`tools.ts`: they are a client convention, not something the in-app
assistant needs, and they compose the existing rows rather than reading
Firestore themselves.

Handoffs become links rather than disappearing: a tool *result* is what
external models reliably act on, so "the user wants to upload an invoice"
→ `openScanner` → a URL the assistant shows is more dependable than
server-level instructions alone.

Mapping a row to an MCP tool:

- `name` / `description` as-is (they're already English, written for a model).
- `inputSchema` / `outputSchema` from the zod schemas (`z.toJSONSchema`,
  zod v4). `card()` metadata (Spanish labels, `hidden`) is ignored — there
  is no card outside the app. Fields marked `hidden` are still returned;
  the output schema stays the allow-list.
- `annotations: { readOnlyHint: true, openWorldHint: false }` on every tool.
- Results as `structuredContent` plus a JSON `text` block for clients that
  don't read structured content yet.

### Context the external model doesn't have

In the app, the manifest's `facts` tell the model the base currency,
restaurant name, timezone and today's date. An MCP client never sees them,
so:

- every tool result is wrapped: `{ currency: "EUR", asOf: "2026-10-24",
  timezone: "Europe/Madrid", rows: [...] }` — money is base currency
  (docs/multi-currency.md), and the model must not guess; `asOf` is
  today's date in the restaurant's timezone, **per call**, because a
  client runs `initialize` once and may keep that session for days, so
  anything date-shaped in the instructions goes stale by the second
  morning;
- the server's `initialize` `instructions` (built per request, the grant is
  known) carry only what does not change: restaurant name, timezone,
  "amounts are in <currency>", and one line: "To add an invoice, call
  `openScanner` (or ask `getAppHelp` for the upload link) and give the
  user the URL; Teremu cannot receive files here."

Both come from the restaurant read the call already makes (above).

## Auth — OAuth 2.1

Claude and ChatGPT connect to remote MCP servers with OAuth 2.1
(authorization code + PKCE) and discover everything from the server.
Firebase Auth is not an OAuth authorization server, so the `mcp` function
is one, backed by Firebase sign-in:

| Endpoint | Does |
|---|---|
| `/.well-known/oauth-protected-resource/mcp` | points the client at the authorization server (RFC 9728; the path is suffixed with the resource path, hence the `oauth-**` rewrite). Also served at the unsuffixed path for older clients |
| `/.well-known/oauth-authorization-server` | metadata (RFC 8414): endpoints, `S256`, scopes, `resource` support |
| `POST /oauth/register` | dynamic client registration (RFC 7591) — required by Claude/ChatGPT; stores `mcpClients/{clientId}` with its redirect URIs |
| `GET /oauth/authorize` | validates client + redirect URI + PKCE challenge + `resource`, stores the request as `mcpAuthRequests/{id}` (client, redirect URI, state, challenge, resource; `purgeAt` TTL 10 min — same shape as `posOauthStates`), redirects to the app page `/connect?req=<id>` |
| app `/connect` (new Vue page) | signed-out → existing login redirect back; then **pick a location** (only those the user is a member of) and a consent screen: which assistant, what it can read, "your data will be sent to <client name>'s AI provider" → posts approval to `api`, which consumes the auth request (read-and-delete, once), mints the code and returns the redirect |
| `POST /oauth/token` | code + verifier → access token (1 h) + refresh token (30 d, rotated on use); refresh grant |
| `POST /oauth/revoke` | RFC 7009 |

Discovery details that are easy to miss and without which the connector
flow never starts:

- A request with no / bad token answers **401 with
  `WWW-Authenticate: Bearer resource_metadata="https://app.teremu.com/.well-known/oauth-protected-resource/mcp"`**.
  That header is how clients find the metadata.
- **Resource indicators (RFC 8707):** clients send
  `resource=https://app.teremu.com/mcp` on authorize and token; tokens are
  bound to that audience and a call presenting a token minted for another
  resource is a 401. Cheap now, awkward to retrofit.

Grants:

- `mcpGrants/{grantId}`: `{ uid, email, rid, clientId, clientName, scope, resource, createdAt, lastUsedAt, revokedAt }`.
  Tokens are opaque random strings; only their SHA-256 is stored
  (`mcpTokens/{hash}` → `grantId`, kind, `expiresAt` as a number for the
  check and **`purgeAt` as a Firestore `Timestamp`** for the TTL policy in
  `firestore.indexes.json` — every TTL field in the repo is a `Timestamp`
  named `purgeAt`; a number is silently ignored by TTL).
- **Refresh token reuse revokes the grant.** Refresh tokens rotate on use;
  presenting an already-rotated one means the token leaked (or the client
  lost state), and the safe answer is to revoke the whole grant and let the
  user reconnect. That also makes theft visible in Settings.
- One scope, `teremu.read`. What a grant may actually read is **not**
  frozen at consent: every call re-loads the member (`loadMember(uid,
  email, rid)`) and derives `permissionList()` fresh, so removing a member
  or lowering their perms takes effect on the next call. No member → 401 →
  the client re-auths and fails at `/connect`.
- The tenant comes **only** from the grant. No `X-Restaurant-Id`, no rid in
  tool input. Switching location = a new connection.

**Settings → Connected assistants** (owner and members, each sees their
own; owners also see everyone's for their location): client name,
location, last used, *Disconnect* (revokes grant + tokens). Strings in
`src/i18n/locales/` per docs/i18n.md.

## Caps

Not the assistant meter. `aiUsage` counts chat **turns**, each of which
costs us an LLM call; an MCP call costs a few Firestore reads, and one
external question often makes 3–10 calls. Sharing the meter would burn
Free's 20 turns in two questions and show "questions used" for questions
asked elsewhere.

- New `PLAN_LIMITS.mcpCallsPerDay` in `plan.ts`: **free 100, pro 2 000,
  max 5 000** (decided; a one-line edit if they turn out wrong).
- Metered with the existing daily counter, not a new field: add
  `"mcpCalls"` to `PlanDailyKind` in `helpers/dailyCap.ts` and call
  `reserveDaily(rid, "mcpCalls", 1, limits.mcpCallsPerDay)` per tool call.
  That gives the UTC-day reset, the transaction and the TTL for free
  (`restaurants/{rid}/dailyUsage/{YYYY-MM-DD}`). Over the cap → a tool
  error whose text says the daily limit was reached and when it resets
  (and, on Free, that Pro raises it).
- Free gets MCP, capped — same stance as POS and email (business-model.md).
- Uploads cost nothing here: they happen in the app and spend `scans` as
  always.

## Security & privacy

- Read-only limits the blast radius of prompt injection: vendor names,
  line descriptions and owner notes are untrusted text that will be shown
  to a third-party model, but nothing it says can change data.
- Output schemas are allow-lists already; nothing outside them leaves.
- `restaurants/{rid}/mcpLog/{id}`: `{ grantId, tool, at, ok, ms }`, no
  inputs or outputs stored, 30-day TTL (`purgeAt` Timestamp) — enough to
  answer "what did ChatGPT read" and to spot abuse.
- Consent copy must say the data goes to the client's AI provider; the
  privacy policy needs the same line before launch.
- Redirect URIs are matched exactly against the registered ones; codes are
  single-use, 60 s, bound to the PKCE challenge, the client and the
  `resource`.
- **Per-IP caps on the unauthenticated endpoints**: `/oauth/register` and
  `/oauth/token` (code guesses, refresh replay) — a small counter doc per
  IP per hour with `purgeAt`, same mechanics as `dailyUsage`. Over the cap
  → 429. Authenticated tool calls are capped per location already.
- `mcpStats/{YYYY-MM}` (one doc a month): `connected`, `disconnected`,
  `calls` incremented on grant create / revoke / tool call, so "how many
  restaurants are connected" is one read for marketing, not a collection
  scan.

## Testing

Per docs/testing.md:

- **Unit:** row → MCP tool mapping (schemas, annotations, excluded rows),
  handoff → URL, the `{ currency, rows }` envelope, token hashing,
  discovery document shapes.
- **Integration** (`firebase/functions/test/`, emulators): full OAuth dance
  (register → authorize → consent → token → refresh → refresh reuse revokes
  → revoke), the 401 `WWW-Authenticate` header, a token for the wrong
  `resource`, a tool call per permission area as a member with and without
  access, perms lowered mid-grant, member removed mid-grant, cap
  exhaustion (the cap is a Firestore transaction, so it lives here, not in
  the unit tier), cross-tenant attempt.
- **Manual:** MCP Inspector against the emulator, then Claude and ChatGPT
  against a preview deploy (never prod without an explicit OK).

## Rollout

1. Export `loadMember`, move `permissionList` to `tenancy.ts`; adapter
   (package or local) + `mcp` function with a dev-only static token; tools
   verified in MCP Inspector.
2. OAuth endpoints, `/connect` page, grants, revocation UI.
3. Caps + log.
4. Try with Claude and ChatGPT on a preview channel; privacy policy update;
   ship.

## Decided after review (2026-10-24)

- **Dynamic client registration only** for the first release. Both target
  clients work with it today; Client ID Metadata Documents can be added
  later without breaking a connection. Claude's connector dialog already
  offers "Use Claude's published identity" (CIMD) next to "Register
  automatically" (DCR), so CIMD is the natural second step.
- **Cap numbers** as listed under Caps.
- **This is a marketing feature first.** The launch message is "ask your
  Claude / ChatGPT / Gemini about your margins", with those products'
  names, not the protocol. **Names in text are the default; logos need
  written approval.** Anthropic's trademark guidelines allow their marks
  only as specifically permitted and in materials approved beforehand;
  OpenAI's allow review, required changes and revocation and forbid their
  marks being more prominent than ours. So the creative ships as "works
  with Claude and ChatGPT" in plain text, never "powered by" or a
  co-branded lockup, and the logos are added per vendor once that vendor
  has approved the actual artwork (phase 5). Retention through being the
  source of truth is the business case; the privacy policy line about
  third-party AI providers is a legal requirement, not a product concern.
- **Sequencing (2026-10-25): US market readiness first, then MCP.** The
  US audit (`docs/us-market-readiness.md`) found product assumptions
  (tax-inclusive prices, no US country pack, Spanish-centric prompts)
  that would make a US launch — the market the MCP campaign leans on
  hardest — misfire. MCP starts once that plan's launch-blocking items
  are done. Ingredient identity and email ingestion are built (email
  waits only on Google's `gmail.readonly` review).

## Client compatibility (checked 2026-10-24)

What each assistant needs from us, and who can connect. Verify each row
again in phase 5 — these products change monthly.

| Client | User-added remote MCP? | Who | Auth they expect | Notes |
|---|---|---|---|---|
| **Claude** (web, desktop, Cowork) | yes, Settings → Connectors → Add custom | Free (1 connector), Pro, Max, Team, Enterprise (admin adds) | OAuth: DCR ("Register automatically") or CIMD ("Claude's published identity"); header tokens as a fallback | In beta. Connects from Anthropic's cloud; public HTTPS only. Easiest target. |
| **ChatGPT** | yes — via `search`/`fetch` as a plain connector, or any tool in **developer mode** | Pro: read-only connectors; Business / Enterprise / Edu: full; Plus: reports conflict — test. **Not in the EEA, Switzerland or the UK for Plus and Pro** (OpenAI's release notes still carry the block; Business / Enterprise workspaces are exempt) | OAuth + PKCE with DCR | Read-only is all we expose, so Pro's restriction costs nothing. **Spain is in the EEA**, so a Spanish owner on an individual plan most likely cannot add Teremu; confirm on OpenAI's live help page from a Spanish account before any Spanish ad names ChatGPT. |
| **Gemini app** | yes, "Connected apps → custom" on gemini.google.com | Personal Google accounts, **US only**, 18+, English, Keep Activity on; no plan requirement listed; not Workspace accounts | DCR expected ("if the server doesn't support DCR, enter credentials") | **Works for US restaurants today**, not for Spain yet. The Gemini logo goes on US ads; keep it off Spanish ads until Google widens the rollout. Gemini Enterprise Business can add servers too but that is not our buyer. |
| **Grok** (grok.com) | yes, grok.com/connectors → New → Custom | Paid tiers per third-party guides; one guide says Free since July 2026 — unverified | A generic "authentication step"; OAuth support unconfirmed, header tokens certain | Standard OAuth is the bet; if it fails, a per-user static token minted in Settings is a cheap fallback (phase 6). |
| **Grok Bot** (xAI + Cursor, always-on agents) | yes, custom MCP servers + a Connector Marketplace (third-party submissions open since 2026-10-15) | Cursor Teams / Enterprise policies apply | Marketplace listing or user-added; forum reports of OAuth trouble with custom servers | Same server, no extra work; a marketplace listing is a form, after the server is stable. |
| **xAI API** (Grok-based bots built by others) | yes, `tools: [{type:"mcp", server_url, authorization}]` | any API customer | Bearer in `authorization`, or extra headers; no OAuth | Needs the static-token path (phase 6). Streamable HTTP and SSE only — we do Streamable HTTP. |
| **Meta Muse** (consumer + Small Business, US/Canada) | **not by URL.** Connectors are a reviewed directory (muse.ai/platform: submit an MCP server or a raw API, "OAuth with PKCE" accepted, review in waves) plus a "custom connector" flow for services with an API that one report says ends up as a generated skill | US and Canada only | OAuth + PKCE or API key, reviewed by Meta | **Reachable for US restaurants, but only through Meta's directory** — not self-serve, so it is a phase 6 submission once the server is stable, using the same OAuth server. Not available in Spain. Separate thing: **WhatsApp Business Tools MCP** (Sept 2026) is Meta exposing *their* server to agents — the reverse direction, irrelevant here. |

Reading of the table for the launch. Teremu targets **Spain and the US**
(2026-10-24); a client that only works in the US is still worth
supporting and advertising there, since Spanish restaurants use the app
itself either way.

- **Claude is the only client confirmed to work in both markets** on
  individual plans. It carries every ad.
- **US ads:** Claude, ChatGPT (Pro developer mode / Business), Gemini
  (self-serve for personal US accounts) and, after the directory review,
  Meta Muse. Grok joins once its OAuth is tried.
- **Spanish ads:** Claude and Grok. ChatGPT only if the EEA block turns
  out not to apply (or for Business workspaces, which is not our buyer);
  Gemini and Muse when Google and Meta open them in Spain. Recheck
  quarterly.

## Execution plan

Each phase ends in a commit that passes the normal gate (`npm run
test:unit`, `npm run test:integration:exec`, e2e where noted) and is
deployable on its own; nothing user-visible appears before phase 4.
Phases 1–3 are server-only and can be deployed dark.

**Effort.** The code is not the long part. Phases 1–3 reuse the assistant
rows, the tenancy helpers, the daily-cap helper and the OAuth-state
pattern already in the repo, so they are a few working sessions, not
weeks (the per-phase day counts below are a conservative human-engineer
pace and double as a review budget). What takes calendar time is outside
the code: a preview deploy and a real connection from each client (each
tends to disagree with the spec somewhere), the privacy-policy line, the
brand-guideline read and the ad assets, and any directory review. Plan
on **days for the server and consent page, then a week or two of
waiting on and testing against the clients.**

### Phase 1 — tools over MCP, dev token only (≈ 4 days)

Goal: every allowed row answers in MCP Inspector against the emulator.

- `tenancy.ts`: export `loadMember`; move `permissionList` here from
  `api.ts` (api keeps importing it). `test/tenancy.test.ts` covers the
  move.
- `firebase/functions/src/mcp/`:
  - `tools.ts`: the allow-list of row names + the row → MCP tool mapping
    (`z.toJSONSchema` in/out, annotations, `{ currency, asOf, timezone,
    rows }` envelope, handoff → `{ url }` with `defaultAppOrigin()` +
    `destinations`), plus the MCP-only `search` and `fetch` composed
    from the rows (typed ids, per-area perms). Pure; unit-tested.
  - `runner.ts`: runs a `query` row (`{tenant}`, `$input.*`, `map`,
    `output.parse`) or a `code` row (`execute({ tenantId, input })`).
    Local adapter first; swapping to `@mtmcya/assistant/mcp` later is
    this file only.
  - `server.ts`: JSON-RPC over Streamable HTTP (stateless): `initialize`
    (with per-grant `instructions`), `tools/list`, `tools/call`, errors.
    Use the official MCP TypeScript SDK's server + stateless transport if
    its footprint is acceptable in the esbuild bundle; otherwise ~200
    lines by hand — decide after measuring `lib/index.js`.
  - `auth.ts`: for this phase only, `MCP_DEV_TOKEN` env (emulator only,
    refused when `FUNCTIONS_EMULATOR !== "true"`) mapped to a seeded
    member.
- `index.ts`: `export const mcp = onRequest({ region: REGION, cors: false }, …)`.
- `firebase.json`: rewrites `/mcp`, `/oauth/**`, `/.well-known/oauth-**`
  → `mcp`, below the existing `/oauth/email/callback` line; run
  `scripts/check-ports.mjs`.
- Tests: unit (mapping, envelope, excluded rows, handoff URLs);
  integration `test/mcp.test.ts` — `tools/list` as owner vs member with
  reduced perms, one `tools/call` per permission area, cross-tenant id in
  input returns nothing, `code` and `query` row each.
- Manual: MCP Inspector → `http://localhost:<hosting port>/mcp`.

### Phase 2 — OAuth 2.1 server (≈ 6 days)

Goal: Claude on a preview channel connects end to end.

- `mcp/oauth.ts`: discovery documents (both protected-resource paths +
  authorization-server metadata), `POST /oauth/register`,
  `GET /oauth/authorize` (validate client, exact redirect URI, `S256`,
  `resource`; write `mcpAuthRequests/{id}` with `purgeAt`; 302 to
  `/connect?req=`), `POST /oauth/token` (code and refresh grants, PKCE
  verify, `resource` check, rotation, reuse → revoke grant),
  `POST /oauth/revoke`. 401s carry `WWW-Authenticate … resource_metadata`.
- `models.ts`: `mcpClientSchema`, `mcpAuthRequestSchema`, `mcpGrantSchema`,
  `mcpTokenSchema`. Tokens: 32 random bytes base64url, stored as SHA-256.
- `api.ts`: `GET /mcp/connect/:req` (client name, redirect host, the
  caller's locations) and `POST /mcp/connect/:req` `{ rid }` → consumes
  the request, creates the grant, mints the code, returns the redirect
  URL. Member of `rid` required.
- `firestore.indexes.json`: TTL `purgeAt` on `mcpAuthRequests`,
  `mcpTokens`, `mcpLog`. `firestore.rules`: the new top-level collections
  are server-only (deny all client access); `test/rules.test.ts`.
- App: `/connect` route + `ConnectPage.vue` (login redirect preserves
  `?req=`; location picker; consent copy naming the client and "sent to
  <client>'s AI provider"; Connect / Cancel). Strings in
  `locales/pages/connect.ts` (es + en).
- Tests: integration — register → authorize → consent → token →
  tools/call → refresh → reuse revokes → revoke → 401; wrong `resource`;
  wrong verifier; expired code; redirect URI mismatch; member removed
  mid-grant; perms lowered mid-grant. e2e — `settings/connect.spec.ts`:
  land on `/connect?req=` signed out, sign in, pick location, consent,
  assert the redirect.
- Deploy to a preview channel; connect from Claude (DCR path). Fix what
  the real client disagrees with before moving on — this is where the
  unknowns are.

### Phase 3 — caps, log, revocation UI (≈ 3 days)

- `plan.ts`: `mcpCallsPerDay` (100 / 2 000 / 5 000); `dailyCap.ts`:
  `"mcpCalls"` in `PlanDailyKind`; `server.ts` calls `reserveDaily` per
  `tools/call` and returns the limit-reached tool error with reset time
  (and the Pro line on Free). `test/paywalls.test.ts` gets the cap case.
- `mcpLog` write per call (`grantId, tool, at, ok, ms`, `purgeAt` 30 d);
  `mcpStats/{YYYY-MM}` counters; per-IP hourly caps on `/oauth/register`
  and `/oauth/token`.
- `api.ts`: `GET /mcp/grants` (own; owners see all for the location),
  `DELETE /mcp/grants/:id`. `lastUsedAt` updated at most once a minute to
  avoid a write per call.
- App: `ConnectedAssistantsCard.vue` in Settings (client, location, last
  used, Disconnect), gated like `EmailCard`; strings in
  `locales/components/connectedAssistants.ts`. Below the list, the
  **setup block**: the server URL with a copy button and three short
  "how to add it in Claude / ChatGPT / Grok" steps with links to each
  vendor's own help page — this is the only place users will discover
  the feature.
- e2e extends `connect.spec.ts`: the card shows the grant, Disconnect
  removes it, a following tool call 401s (checked through the API, not a
  real client).

### Phase 4 — launch readiness (≈ 3 days)

- Privacy policy: add the third-party AI provider line (same place the
  Gmail scopes are described). The same pass adds the **California
  (CCPA) notice** the US market needs — the Gmail and MCP wording is
  GDPR-shaped today.
- `getAppHelp`: an "ask from your own assistant" entry pointing at
  Settings → Connected assistants, plus the `/scan` URL on the upload
  entry.
- In-app assistant: when the turn cap is hit, the upgrade notice gains a
  second line, "or connect your own assistant" → Settings. Strings in
  the existing assistant locale module.
- Demo account: verify every exposed tool returns sensible El Cuadrat
  data (this is the data the ad screenshots will show).
- Deploy (`node scripts/deploy.mjs`); connect Claude and ChatGPT (Pro
  developer mode, then Plus to settle the eligibility question, **from a
  US account and from a Spanish account** to settle the EEA question;
  then as a plain connector without developer mode to prove
  `search`/`fetch`) against prod with the demo account only, explicit
  OK first per `docs/security.md`.

### Phase 5 — marketing assets and the other clients (≈ 1 week, parallel with 4)

- Brand permissions: read the three trademark pages (Anthropic, OpenAI,
  Google), then **request written approval and official assets from
  each** for the actual creative — the ad ships with names in text until
  a vendor's approval arrives, and that vendor's logo is added then.
  Keep each answer (date, contact, what was approved) in
  `docs/marketing/` (new) so the next campaign does not redo it.
- Screenshots: a real question in Claude and in ChatGPT with the El
  Cuadrat answer in euros. Landing section on the marketing site with
  the three setup walkthroughs.
- Try Grok (grok.com custom connector) against prod with the demo
  account. If its OAuth works, it joins the ad; if not, phase 6.
- Test Gemini with a US personal Google account against prod (demo
  account); if it connects, it joins the US creative.
- File the Muse directory submission (muse.ai/platform) for the US
  market once the production URL is stable; recheck both products'
  country lists quarterly for Spain.

### Phase 6 — optional, when needed

- **Static tokens** ("Personal access tokens" in the same Settings card,
  shown once, revocable, same `mcpTokens` table with `kind: "static"`
  and no refresh): unlocks the xAI API, Grok-based bots built by third
  parties, and any client whose OAuth misbehaves. Half a day on top of
  phase 3, but it is a credential users can paste anywhere, so it stays
  off until a real client needs it.
- **CIMD** for Claude's "published identity" path: accept a client_id
  that is an HTTPS URL, fetch and cache its metadata document, skip
  registration. One day.
- **Directory listings**: Claude / ChatGPT / Grok Bot marketplace / Muse
  — forms, not code; each wants a stable production URL, a privacy
  policy link and a support contact.
- `@mtmcya/assistant/mcp`: when the package ships it, replace
  `mcp/runner.ts` and delete the local query runner; Dirumed and Pasdiu
  reuse phases 2–3 wholesale (OAuth server and grants are app-agnostic).

### Risks to watch

- **Client disagreements with the spec** are the schedule risk, not our
  code: the preview-channel test in phase 2 is placed early for that
  reason. Budget a day per client.
- **Bundle size**: the MCP SDK pulls in more than we need; measure before
  adopting it (phase 1).
- **Abuse**: DCR is unauthenticated by design, so `mcpClients` can be
  spammed. Cap registrations per IP per hour and TTL unused clients
  (`purgeAt` 30 d, refreshed on each authorize).
- **Cold starts**: a new function means a new cold path; `minInstances`
  is not worth it until usage shows up, but say so in the function's
  comment.

## Open questions

- Package (`@mtmcya/assistant/mcp`) vs local adapter — depends on the
  package's timeline; step 1 proceeds either way.
- ChatGPT Plus eligibility for read-only custom connectors, and whether
  the EEA / Switzerland / UK block on connectors for individual plans
  still stands (both settled by the phase 4 test from a US and a Spanish
  account).
- Grok's OAuth behaviour with DCR (settled by the phase 5 test).
- **History window.** The app's list endpoints clamp to the plan's
  `historyDays` (Free: 90 days, `api.ts`), but the assistant rows do not,
  so a Free restaurant asking through MCP (or the in-app assistant) can
  read further back than in the app. Either clamp the rows by plan in the
  adapter, or state that the assistant is exempt. Same answer for both
  surfaces.
- Universal / app links so `https://app.teremu.com/scan` opens the native
  app — moot until the native shells exist (docs/mobile-release-plan.md);
  until then it opens the web app, and the login redirect already returns
  to `/scan`.
