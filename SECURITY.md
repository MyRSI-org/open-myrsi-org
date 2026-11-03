# Security Policy

Thanks for helping keep **My RSI Org** and the orgs that self-host it safe. This app handles real org data — rosters, intel, comms, and cross-org alliance keys — so we take security seriously and genuinely appreciate responsible reports.

## Reporting a vulnerability

**Please report security issues privately — do not open a public GitHub issue, PR, or Discussion**, as that discloses the problem to attackers before it can be fixed.

Instead, email **hello@myrsi.org** with:

- A clear description of the issue and its impact.
- Steps to reproduce (proof-of-concept, requests, or screenshots help a lot).
- The affected area (file path, endpoint, or feature) if you know it.
- Any suggested fix or mitigation — optional, but welcome.

If you'd rather use GitHub, you can also open a private report via **Security → Report a vulnerability** (GitHub private vulnerability reporting), if it's enabled on the repository.

### What to expect

This is a noncommercial, self-hosted project maintained on a best-effort basis — there is **no bug bounty**, but real reports get real attention:

- We aim to acknowledge a report within **5 days**.
- We'll keep you updated on triage and remediation.
- With your consent, we're happy to credit you once a fix ships.

Please give us a reasonable window to fix and release before any public disclosure. We're a small project and will work with you in good faith.

## Safe harbor

We want good-faith security research to feel safe. If you make a genuine effort to follow this policy, we will treat your research as **authorised**, we will **not** pursue or support legal action against you for it, and we'll work with you to understand and resolve the issue.

To stay within that safe harbor, please:

- Report privately via the channel above, and give us reasonable time to fix and release before any public disclosure.
- Only test against **your own** installation or the source in this repository — see the boundary below.
- Use the **minimum** access needed to demonstrate a flaw. Don't access, modify, exfiltrate, or destroy data that isn't yours, and don't degrade service for others (no DoS, no spam, no automated scanning that disrupts a live org).
- Stop and tell us if you encounter anyone's personal data.

### Where the safe harbor ends

This authorisation covers **only** testing the code here and a deployment **you control**. It does **not** authorise you to attack, access, or test any other org's live self-hosted instance — those belong to third parties who haven't given you permission, and the maintainers cannot grant it on their behalf.

Activity beyond good-faith research — unauthorised access to a deployment you don't own, stealing or exposing other people's data, exploiting a flaw for gain, extortion, or disclosure timed to harm users rather than help them — is **not authorised**, is not protected here, and may be unlawful under applicable computer-misuse and data-protection laws. (This isn't legal advice — if in doubt, check the law in your jurisdiction.)

## Scope

**In scope** — the application code in this repository, including:

- Authentication & session handling (Discord OAuth, token signing/verification).
- The RPC dispatcher and per-resource authorization (`api/services.ts`), the read-path subset gates and secret-stripping (`api/query.ts`).
- API keys, and the alliance federation handshake / key handling (`lib/db/alliances.ts`, `/api/alliance/*`).
- Any path that could leak data across the server's security boundary, escalate privileges, or bypass permission checks.

**Out of scope** — issues that aren't a flaw in this codebase, e.g.:

- Vulnerabilities in **your own** deployment config: a leaked Supabase service-role key, missing TLS, an unset `JWT_SECRET` / `SECRETS_ENCRYPTION_KEY`, an exposed admin setup code, or a misconfigured reverse proxy.
- Third-party services (Supabase, Discord, LiveKit, Gemini, UEX) themselves — report those to the respective vendor.
- Denial-of-service via traffic volume, social engineering, and findings that require a compromised admin account or physical/host access.

### Documented design exception: tactical-board realtime deltas

Live updates ride private Supabase Realtime channels and, by design, carry **ids only** — the browser then fetches content through the server's permission-gated read paths. There is **one deliberate exception**: the per-operation tactical-board channel `op-board-<operation id>` carries board element **content** (`broadcastBoardAdd` / `broadcastBoardUpdate` in `lib/db/ops.ts`), so live board edits don't need a full refetch. Receipt on that channel is authorized per operation by the realtime RLS policy `rt_recv_op_board` → `private.rt_can_read_op_board()` (`schema.sql` §4.9 / §6b), which applies the same gate as opening the operation in the app — owner, `operations:manage`, or `operations:view` plus clearance level, every limiting marker and (for Special Operations) participation — and drops deleted, revoked and banned accounts. Board content is never sent on any org-wide channel, and every other broadcast stays id-only (pinned by `tests/opBoardDeltaException.test.ts` and `tests/sec-schema-rls.test.ts`). A way to receive board content for an operation you can't open in the app is in scope and we'd like to hear about it.

## Self-hosting hardening

Because **the server is the security boundary** (it runs under the Supabase service-role key, bypassing RLS), a secure deployment depends on you:

- Keep the **service-role key** server-side only — never ship it to the browser.
- Set strong, unique `JWT_SECRET` and `SECRETS_ENCRYPTION_KEY` values.
- Always serve over **HTTPS** (the alliance federation handshake assumes TLS).
- Rotate the one-time **admin setup code** usage on first boot, and review permissions/roles after seeding.

See [`DEPLOYMENT_GUIDE.md`](./DEPLOYMENT_GUIDE.md) for full setup guidance.

## Supported versions

This is a rolling, self-hosted project: security fixes land on the latest `main` (and the latest tagged release, if any). If you're running an older checkout, **update to the latest before reporting** — the issue may already be fixed. Older deployments are not separately patched.

---

Thanks for looking out for the org. o7
