# myRSI Deployment Guide (Single-Org, Self-Hosted)

This guide covers deploying the **single-org self-hosted** build of myRSI to any Node host, backed by **Supabase**.

This build serves the org dashboard from a single domain. There is **no** billing, customer portal, landing page, or tenant subdomains.

## Prerequisites

1. **Supabase project** — for the database + realtime.
2. **A host** — any Node 22.12+ runtime (a VPS, a container, or a PaaS — your choice).
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

> Structural defaults (roles, ranks, units, permissions, locations, settings) are seeded automatically on first boot — see the first-boot section below.

---

## 2. Environment Variables

Copy `.env.example` to `.env` and fill it in (or set them in your host's environment-variable UI). Minimum required:

| Variable | Notes |
| :--- | :--- |
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `APP_URL` | `https://yourdomain.com` (no trailing slash) |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | Public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | **Required.** Server-only; bypasses RLS |
| `SUPABASE_JWT_SECRET` | **Required for live updates.** Project JWT secret (Dashboard → Settings → API → JWT Secret). The server mints short-lived per-user tokens with it to authorize the private realtime channels; unset = realtime disabled (fail-closed), and the app still works via manual refresh |
| `JWT_SECRET` | Recommended. Session-token signing secret; falls back to the service-role key |
| `SECRETS_ENCRYPTION_KEY` | Recommended. Encrypts at-rest secrets. Do not change once set |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | Required for Discord login |
| `DISCORD_BOT_TOKEN` / `DISCORD_GUILD_ID` | Optional — bot features |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web push |
| `GEMINI_API_KEY`, `LIVEKIT_*`, `UEX_API_KEY` | Optional |

The server fails fast on boot if `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` is missing in production.

---

## 3. Build & Run

The app is a standard Node service — it builds to static frontend assets plus a server that serves both the frontend and the API from a single port.

```bash
npm install
npm run build     # type-checks, builds the client to dist/, compiles the server to dist-server/
npm start         # node dist-server/server.js — serves the frontend + API on $PORT (default 3000)
```

Set the environment variables from step 2, then run the app under a process manager (systemd, pm2, Docker, or your platform's runner) so it restarts on crash/reboot. Node ≥ 22.12 is required (`engines` in `package.json`).

> **Using Coolify (or another Nixpacks/PaaS host)?** New Resource → Public/Private Repository → this repo, branch `main`. Build Pack: Nixpacks, with Install `npm install`, Build `npm run build`, Start `npm start`. Add the env vars from step 2 and set a single application domain. Most container/PaaS hosts work the same way.

---

## 4. Domain & TLS

1. Point an **A record** for `yourdomain.com` at your host's IP. No wildcard record or cert is needed — this is a single hostname.
2. Terminate **HTTPS** in front of the app. The server itself speaks plain HTTP on `$PORT`; put a TLS-terminating reverse proxy (Caddy, nginx, Traefik) or your platform's built-in certificates in front of it. Make sure the proxy forwards the original `Host` and `X-Forwarded-Proto` headers — the server uses them to build OAuth redirect URLs and Open Graph meta. HTTPS is also assumed by the alliance federation handshake.
3. **Client-IP trust** (rate limiting + abuse blocking key on the client IP, so the server must know which proxy headers to believe):
   - `TRUST_PROXY_HOPS` — how many reverse proxies sit in front of the app. **Defaults to `0` (secure): with no proxy the server uses the real TCP connection IP, which clients cannot spoof — safe out of the box.** If you run the single TLS-terminating proxy above, set `1`; for deeper chains (CDN → LB → app) set `2+`. Leaving it at `0` behind a proxy is safe but coarse (all clients share the proxy's IP for limits); setting it higher than your real proxy count lets a client spoof a forwarded hop, so match it to your topology.
   - `TRUST_CF_PROXY=1` — set **only** if the origin is reachable exclusively through Cloudflare (Cloudflare Tunnel or an origin firewall allow-listing Cloudflare's IP ranges). The server then trusts `CF-Connecting-IP` for the real client address. If the origin is reachable directly, leave it unset — otherwise a direct caller can spoof the header to evade rate limits or frame another IP into the abuse blocker.
4. **Set your public domain in the static SEO files.** `public/sitemap.xml`, `public/robots.txt`, and the `og:url` meta in `index.html` ship with a `https://yourdomain.com` placeholder — replace it with your actual domain so crawlers and social-share cards point at your instance. Everything else is runtime-driven: page title, description, and OG image come from **Admin → Branding** (the server rewrites the meta tags per request from your config and the `X-Forwarded-Host` header), and `og:image` falls back to the bundled `/media/opengraph.jpg`. Only those three static files need a manual edit.

> **Using Coolify?** It issues a Let's Encrypt certificate for the single hostname automatically (HTTP-01 challenge) and forwards the proxy headers for you — no manual reverse-proxy config needed.

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

---

## 7. Updating an Existing Deployment

There is **no migrations folder** — `schema.sql` is the single, **re-runnable** source of truth. To take a newer release's schema changes (new tables, columns, RPCs, policies, permissions) onto a database that already has data:

1. **Update the code** — `git pull` and rebuild/redeploy the app as usual (Coolify redeploy, or `npm ci && npm run build` then restart). This alone updates the app but **not** the database.
2. **Re-run `schema.sql`** — open **Supabase → SQL Editor**, paste the new `schema.sql`, and run it. It is fully idempotent: every statement is guarded (`CREATE … IF NOT EXISTS`, duplicate-safe `DO` blocks, `CREATE OR REPLACE`, `ON CONFLICT`), so it **adds what's new and leaves your existing data untouched**. Do **not** run `reset_db.sql` (that wipes everything).
3. **Repair Database** — open **Admin → Database Tools → Repair Database**. This converges the things a schema re-run can't: it re-grants the Admin role every permission, tops up role grants, and refreshes seeded reference data. (This is also the fix if Catalogs or a new feature show "access denied" after an update.)

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
