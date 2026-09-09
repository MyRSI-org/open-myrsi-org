# myRSI Deployment Guide (Single-Org, Self-Hosted)

This guide covers deploying the **single-org self-hosted** build of myRSI to any Node host, backed by **Supabase**.

This build serves the org dashboard from a single domain. There is **no** billing, customer portal, landing page, or tenant subdomains.

## Prerequisites

1. **Supabase project** — for the database + realtime.
2. **A host** — any Node 24+ runtime (a VPS, a container, or a PaaS — your choice).
3. **A domain** — e.g. `yourdomain.com`, pointed at the host. A single record.
4. **A Discord application** — for login (and optionally a bot for role sync / event posting).
5. *(Optional)* Google Gemini key, LiveKit credentials, UEX API key.

---

## 1. Database Setup (Supabase)

1. Open **Supabase Dashboard → SQL Editor**.
2. *(Optional)* run `reset_db.sql` to drop and recreate the `public` schema, then run `schema.sql` to create all tables, enable RLS, and install policies (including the realtime-authorization policies that gate the private live-update channels). `schema.sql` is the complete, consolidated single-org schema — it is all a fresh self-hosted install needs.
3. **Regenerate the DB types for your project** (one-time, optional but recommended). The committed `lib/database.types.ts` is a generated snapshot — regenerate it against your own project so the types match exactly:
   ```bash
   supabase link --project-ref <your-project-ref>   # once
   npm run gen:types
   ```
   The app builds and runs without this (queries use explicit column lists), but regenerating keeps the type layer honest.

Running `schema.sql` also sets up the two Supabase **Storage buckets** used for uploaded images — your org logo and icons, and any pictures placed inside wiki or government documents. They're locked down so only the server can write to them (and the private one can't be read without a temporary signed link), so there's nothing to create by hand in Supabase's Storage tab.

> Structural defaults (roles, ranks, units, permissions, locations, settings) are seeded automatically on first boot — see the first-boot section below.

---

## 2. Environment Variables

Copy `.env.example` to `.env` and fill it in (or set them in your host's environment-variable UI). Minimum required:

| Variable | Notes |
| :--- | :--- |
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `APP_URL` | `https://yourdomain.com` (no trailing slash). **Set this.** It overrides the `appUrl` stored in the database and is what Discord deep links and alliance pairing use — see [Moving to a new domain](#moving-to-a-new-domain) |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | Public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | **Required.** Server-only; bypasses RLS |
| `SUPABASE_JWT_SECRET` | **Required for live updates.** Project JWT secret (Dashboard → Settings → API → JWT Secret). The server mints short-lived per-user tokens with it to authorize the private realtime channels; unset = realtime disabled (fail-closed), and the app still works via manual refresh |
| `JWT_SECRET` | Recommended. Session-token signing secret; falls back to the service-role key |
| `SECRETS_ENCRYPTION_KEY` | **Required in production** (the server refuses to start without it, and rejects anything under 32 characters). Encrypts at-rest secrets. Changeable — see [Rotating the encryption key](#rotating-the-encryption-key) |
| `SECRETS_ENCRYPTION_KEY_PREVIOUS` | Only while rotating. The *old* key, kept readable so existing secrets still decrypt. Remove it once the rotation is finished |
| `BALLOT_PEPPER` | Optional. Pins the value used to de-duplicate secret-ballot votes so a key rotation cannot re-open a vote in progress — see the rotation section |
| `SESSION_COOKIE_SECURE` | Optional. Leave blank to derive it from `APP_URL`. Set to `1` if TLS terminates upstream and the app only sees plain HTTP; set to `0` only for a deliberate plain-HTTP LAN deployment. Getting it wrong in the strict direction means the browser silently discards the login cookie and **nobody can sign in**, so the server warns at boot rather than guessing strictly |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | Required for Discord login |
| `DISCORD_BOT_TOKEN` / `DISCORD_GUILD_ID` | Optional — bot features |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web push |
| `GEMINI_API_KEY`, `LIVEKIT_*`, `UEX_API_KEY` | Optional |

The server fails fast on boot if `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` or `SECRETS_ENCRYPTION_KEY` is missing in production — and also if `SECRETS_ENCRYPTION_KEY` is shorter than 32 characters.

Image uploads work out of the box. If you want to change the defaults, five optional variables let you: `MEDIA_MAX_UPLOAD_BYTES` (largest single image, default 5 MB), `MEDIA_MAX_STORAGE_BYTES` (total space uploads may use, default 250 MB), `MEDIA_GC_DRY_RUN=true` (makes the nightly cleanup only *report* unused images instead of deleting them — handy while you build confidence), and two that control how long a link to a private image stays valid: `MEDIA_SIGN_TTL_SECONDS` (default 900, i.e. 15 minutes — used when a page is shown to a reader) and `MEDIA_SIGN_TTL_EDITOR_SECONDS` (default 3600, i.e. an hour — used for the preview of an image you have just uploaded but not yet saved, so a long editing session doesn't lose it). Both are clamped to between 1 minute and 24 hours. Lowering the first is safe; images simply get re-fetched more often.

---

## 3. Build & Run

The app is a standard Node service — it builds to static frontend assets plus a server that serves both the frontend and the API from a single port.

```bash
npm install
npm run build     # type-checks, builds the client to dist/, compiles the server to dist-server/
npm start         # node dist-server/server.js — serves the frontend + API on $PORT (default 3000)
```

Set the environment variables from step 2, then run the app under a process manager (systemd, pm2, Docker, or your platform's runner) so it restarts on crash/reboot. Node ≥ 24 is required (`engines` in `package.json`).

> **Using Coolify (or another Nixpacks/PaaS host)?** New Resource → Public/Private Repository → this repo, branch `main`. Build Pack: Nixpacks, with Install `npm install`, Build `npm run build`, Start `npm start`. Add the env vars from step 2 and set a single application domain. Most container/PaaS hosts work the same way.

---

## 4. Domain & TLS

1. Point an **A record** for `yourdomain.com` at your host's IP. No wildcard record or cert is needed — this is a single hostname.
2. Terminate **HTTPS** in front of the app. The server itself speaks plain HTTP on `$PORT`; put a TLS-terminating reverse proxy (Caddy, nginx, Traefik) or your platform's built-in certificates in front of it. Make sure the proxy forwards the original `Host` and `X-Forwarded-Proto` headers — the server uses them to build OAuth redirect URLs and Open Graph meta. HTTPS is also assumed by the alliance federation handshake.
3. **Client-IP trust** (rate limiting + abuse blocking key on the client IP, so the server must know which proxy headers to believe):
   - `TRUST_PROXY_HOPS` — **most setups want `1`** (one reverse proxy or a PaaS like Coolify in front of the app). Leave it at the default `0` only if nothing sits in front and visitors reach the app directly. That's the whole decision for typical installs; the rest is detail. It's the count of reverse proxies in front of the app: with no proxy the default `0` is safe because the server uses the real connection IP, which clients cannot spoof; for deeper chains (CDN → load balancer → app) set `2+`. Leaving it at `0` behind a proxy still works but is coarse (everyone shares the proxy's IP for rate limits), while setting it higher than your real proxy count lets a client fake a forwarded hop — so match it to your actual setup.
   - `TRUST_CF_PROXY=1` — set **only** if the origin is reachable exclusively through Cloudflare (Cloudflare Tunnel or an origin firewall allow-listing Cloudflare's IP ranges). The server then trusts `CF-Connecting-IP` for the real client address. If the origin is reachable directly, leave it unset — otherwise a direct caller can spoof the header to evade rate limits or frame another IP into the abuse blocker.
4. **Set your public domain in the static SEO files.** `public/sitemap.xml`, `public/robots.txt`, and the `og:url` meta in `index.html` ship with a `https://yourdomain.com` placeholder — replace it with your actual domain so crawlers and social-share cards point at your instance. Everything else is runtime-driven: page title, description, and OG image come from **Admin → Branding** (the server rewrites the meta tags per request from your config and the `X-Forwarded-Host` header), and `og:image` falls back to the bundled `/media/opengraph.jpg`. Only those three static files need a manual edit.

> **Using Coolify?** It issues a Let's Encrypt certificate for the single hostname automatically (HTTP-01 challenge) and forwards the proxy headers for you — no manual reverse-proxy config needed.

### Health check

`GET /healthz` returns `200 {"status":"ok"}` as soon as the app is accepting requests. It is a **liveness** check: it deliberately does not touch the database, so a brief Supabase hiccup does not take every instance out of rotation and turn a degraded read path into a total outage. It is uncached and never counts toward the abuse blocker, so you can poll it as often as you like.

- **Coolify** — set *Health Check Path* to `/healthz`.
- **Docker** — `HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3000/healthz || exit 1`

Before this existed, a probe pointed at `/` would answer `200` even while the database was unreachable, because the page still renders with default branding — so it reported healthy during an outage. If you have a probe on `/`, move it.

---

## 5. First-Boot Admin Setup

On first start with an empty database, the server seeds the structural defaults (roles, ranks, units, permissions, locations, settings), detects that **no Admin user exists**, and prints a **one-time setup code** to the server console/logs inside an `OPEN MYRSI.ORG` banner.

To claim the Admin seat, open `https://yourdomain.com` — the first-run setup wizard walks you through it: a preflight check, sign in with Discord, paste the `SETUP-XXXX` code, verify (or skip) your RSI handle, optionally import existing data, and you're in as Admin. The code is single-use and consumed on success.

Notes:
- The code is rate-limited (10 failed attempts → revoked).
- Lost the code? **Restart the server** to regenerate one (only happens while no Admin exists).
- After this, manage everything in-app under **Admin** — including Discord bot token/guild, AI key, and other secrets (stored encrypted at rest when `SECRETS_ENCRYPTION_KEY` is set).

---

## 6. Importer / Re-host Note

If you seed/import a `users` row by `discord_id` (e.g. migrating from another deployment), that user's `auth_user_id` is bound automatically on their first successful Discord login, keeping their original `user.id` and all historical records (requests, intel, ops) intact. You can import a full org export during first-run setup, or any time from **Admin → Import**.

### Moving to a new domain

Set `APP_URL` on the new host and restart. That is the whole procedure — `APP_URL` **wins** over the `appUrl` value stored in the database's `settings.systemConfig` row, so a migrated database carrying the old origin no longer overrides it.

This matters because that stored row is org data: it comes across in a `pg_dump`/restore or a Supabase project move, and it is what Discord announcement deep links, Discord scheduled-event locations, and the origin advertised to alliance federation peers are built from. Before `APP_URL` took precedence, a correct `.env` on the new host was silently ignored and announcements kept linking to the old deployment.

On every boot the server logs which source it used, so you can confirm it from the deploy log:

```text
app origin resolved   {"effective":"https://newdomain.com","source":"env"}
```

If the old value is still in the database you'll also get, harmlessly:

```text
APP_URL and the stored systemConfig.appUrl disagree — APP_URL wins  {"env":"https://newdomain.com","stored":"https://olddomain.com"}
```

`APP_URL` wins, so this needs no action. To silence it, clear the stale key in the **Supabase SQL Editor**:

```sql
UPDATE settings
SET value = value - 'appUrl'
WHERE key = 'systemConfig';
```

A `source` of `stored` means `APP_URL` was blank or rejected (unparseable, not `http(s)`, or left as the `yourdomain.com` placeholder — placeholders are ignored on purpose so a half-edited `.env` can't publish links to a domain you don't own). A `source` of `fallback` in production means neither was usable and links will point at `localhost`; that one is logged as an error.

The importer already strips `systemConfig.appUrl` from an **Admin → Import** org export, so a normal import never carries another deployment's origin in. A raw database restore bypasses that, which is why `APP_URL` is the reliable control.

Two related things do **not** need changing when you move: Discord OAuth uses the browser's own origin (register the new redirect URL in the Discord Developer Portal), and web-push deep links are origin-relative.

### Rotating the encryption key

`SECRETS_ENCRYPTION_KEY` encrypts your stored credentials — the Discord client secret and bot token, the LiveKit key and secret, the Gemini key, and alliance pairing material. If it is ever exposed, you can change it without downtime and without re-entering anything:

1. **Keep the old key.** Set `SECRETS_ENCRYPTION_KEY_PREVIOUS` to your *current* value, and set `SECRETS_ENCRYPTION_KEY` to the new one. Generate a new key with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. **Restart.** Everything keeps working immediately: new secrets are written under the new key, and existing ones are still read using the old one.
3. **Re-encrypt.** Open **Admin → Database Tools** and click **Rotate Encryption Key**. This rewrites every stored secret under the new key. It is safe to run more than once, and anything it cannot read is reported and left untouched rather than overwritten.
4. **Check.** Click **Run Diagnostics**. The *Secret Encryption* row should read `OK` and tell you the previous key is no longer needed.
5. **Remove `SECRETS_ENCRYPTION_KEY_PREVIOUS`** and restart once more. The old key is now out of your environment.

**If you have already changed the key and things are failing**, this is also the recovery path: put the old value into `SECRETS_ENCRYPTION_KEY_PREVIOUS`, restart, and follow from step 3. The server still starts in this state, so nothing is lost as long as you still have the old key. If you *don't* have it, the affected credentials cannot be recovered and must be re-entered in the admin console — Diagnostics will tell you how many are affected.

**One caveat, only if you use secret ballots.** Votes on a secret-ballot motion are de-duplicated using a value derived from the encryption key, so changing the key would let anyone who had already voted on a motion *currently in voting* cast a second vote. Two ways to avoid it: conclude any in-progress secret ballot before you rotate, or set `BALLOT_PEPPER` to your **old** `SECRETS_ENCRYPTION_KEY` value before starting and leave it in place permanently. Diagnostics warns you if a secret ballot is mid-vote while a rotation is in flight. Elections are unaffected — they have their own separate one-vote guard.

---

## 7. Updating an Existing Deployment

There is **no migrations folder** — `schema.sql` is the single, **re-runnable** source of truth. To take a newer release's schema changes (new tables, columns, RPCs, policies, permissions) onto a database that already has data:

1. **Update the code** — `git pull` and rebuild/redeploy the app as usual (Coolify redeploy, or `npm ci && npm run build` then restart). This alone updates the app but **not** the database.
2. **Re-run `schema.sql`** — open **Supabase → SQL Editor**, paste the new `schema.sql`, and run it. It is fully idempotent: every statement is guarded (`CREATE … IF NOT EXISTS`, duplicate-safe `DO` blocks, `CREATE OR REPLACE`, `ON CONFLICT`), so it **adds what's new and leaves your existing data untouched**. Do **not** run `reset_db.sql` (that wipes everything).
3. **Repair Database** — open **Admin → Database Tools → Repair Database**. This converges the things a schema re-run can't: it re-grants the Admin role every permission, tops up role grants, and refreshes seeded reference data. (This is also the fix if Catalogs or a new feature show "access denied" after an update.)

> **This release narrows database privileges — re-running `schema.sql` is required, not optional.**
> The schema used to grant `authenticated` (the role the browser holds for live
> updates) SELECT on *every* table. It now revokes that and re-grants only the
> twelve reference tables the live-update channels actually read. Deleting a
> `GRANT` from a re-runnable script revokes nothing by itself, so the revoke only
> takes effect once you run the new file against your database. Run it in the
> **Supabase SQL Editor** — which runs as `postgres`, the role that created your
> tables — and not through a pooler or a different database user: `ALTER DEFAULT
> PRIVILEGES` only affects defaults recorded for the role that runs it. If live
> updates stop arriving afterwards, the run did not complete; re-run it.

> **This release also closes reference-table live updates to the org's external
> customers — so run Repair Database as well, not just when something looks wrong.**
> The realtime `authenticated_select` policy now requires the caller to be org
> PERSONNEL as well as a live member, so a Client account no longer reads the role
> table, the unit tree or the classification taxonomy — including the marker flag
> that records which compartments must never leave the org — straight out of
> PostgREST. Staff are recognised either by holding any permission beyond the six an
> org may grant a customer, or by sitting on the seeded Admin role; that second arm
> reads the role's `is_system` stamp, and a database whose roles arrived through an
> org import can carry roles without it. **Run Repair Database (step 3) after
> re-running `schema.sql`** — an Admin whose permission rows were pruned AND whose
> role is unstamped would otherwise lose live reference-table updates until you do.
> Customers lose nothing they can see except live refreshes of their own service
> picker while a tab is open; the picker's data still arrives normally.

> **15.7.0-open adds the Blueprint Manager, which is OFF by default.** Enable it in
> **Admin → Optional Features**. On an EXISTING install the Member and Dispatcher
> roles do not receive its five permissions until you **run Repair Database once**
> — a one-shot backfill grants them, and it will not re-grant anything you have
> deliberately revoked, now or later. Fresh installs are seeded with them already.
> Blueprints and crafting requests are NOT carried by an org import; the on/off
> toggle is.

The applied schema version is recorded in `settings.schema_version`. A release that changes the schema will say so in its notes — when in doubt after pulling new code, re-running `schema.sql` + Repair Database is always safe.

> **Tip:** apply a new release's `schema.sql` to a throwaway copy of your database first to confirm a clean run for your Postgres/Supabase version.

---

## 8. Troubleshooting

- **500s on boot:** missing env vars are the #1 cause — check `SUPABASE_*`.
- **Discord login bounces:** verify the redirect URL is registered exactly (`https://yourdomain.com/**`), and that `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` match.
- **`DISCORD_OAUTH_INVALID_CLIENT`:** the Client Secret is wrong/rotated — reset it in the Discord Developer Portal and update `.env` (or Admin → Discord settings).
- **Live updates not working:** set `SUPABASE_JWT_SECRET` (Dashboard → Settings → API → JWT Secret); without it realtime is disabled (the app still works, refreshing manually).
- **DB/RLS errors:** confirm `schema.sql` ran and the service-role key is set.
- **Setup code not appearing:** it only prints when **no Admin exists**. If you already have an Admin, that's expected. Check logs for `admin setup code generated (first boot)`.
- **Discord announcements link to your old domain:** set `APP_URL` on the new host and restart — see [Moving to a new domain](#moving-to-a-new-domain). The boot log line `app origin resolved` tells you which value is actually in use.
- **Alliance pairing fails with `no_pending_pairing`:** the origin you advertise must byte-match what the peer's admin typed into **Add Peer** (exact match — scheme, `www.`, and port all count). Check `app origin resolved` in your boot log against their peer entry. Pairing needs a public **https** origin, so it will refuse to run on the `localhost` fallback.
- **UEX catalog sync returns 403 / a Cloudflare "Just a moment..." page:** the UEX CDN is challenging your server's IP — a `curl` with the same token from the same box can still succeed. Set `UEX_API_BASE=https://api.uexcorp.uk/2.0` (the same API on a different zone) or point it at your own outbound proxy, then restart and retry **Sync from UEX**. No source edit or rebuild needed.
- **UEX sync returns 429:** raise `UEX_REQUEST_DELAY_MS` (default `600`).
- **Uploaded images fail or don't appear:** make sure `schema.sql` has been run — it creates the image storage buckets. If an upload says you don't have permission, run **Admin → Database Tools → Repair Database** so your Admin role picks up the newer permissions.
