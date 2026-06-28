-- =============================================================================
-- schema.sql — Consolidated single-org schema for a fresh self-hosted deploy.
-- =============================================================================
-- This is the complete, runnable schema for a self-hosted single-org install
-- of myRSI. One deployment = one organization: there is deliberately no
-- organization_id column and no multi-tenant / billing surface (the
-- organizations, diplomacy, Stripe / pricing, and platform control tables are
-- all absent by design). The marketplace IS present, but as a single-org
-- INTERNAL marketplace only — the SaaS's cross-org / platform listing sharing
-- and visibility tiers are gone.
--
-- It creates everything a fresh database needs, in dependency order: enums,
-- tables, the warehouse-quantity + unified position-history views, stored
-- functions / RPCs, indexes, triggers, deny-by-default RLS (plus the realtime-
-- authorization policies in section 6b that gate the private live-update
-- channels), and the global permission seed (section 7). There are NO
-- migrations — this one file is the schema.
--
-- HOW TO APPLY:
--   1. (optional) run reset_db.sql to drop + recreate the public schema.
--   2. run THIS file in the Supabase SQL Editor.
--   3. boot the app — first boot seeds roles / ranks / units / locations /
--      settings and the role->permission grants (lib/db/seeder.ts) and prints
--      the one-time admin setup code. The single-column UNIQUE constraints here
--      back the seeder's upsert(onConflict) calls (service_types.name,
--      ranks.name, roles.name, security_clearances.level, settings.key, ...).
--
--   TIP: apply to a throwaway database first to confirm a clean run for your
--   Postgres / Supabase version before pointing production at it.
--
-- UPDATING AN EXISTING DEPLOYMENT (no migrations folder by design):
--   This file is RE-RUNNABLE. To pick up schema changes from a newer release,
--   pull the code, then RE-RUN THIS FILE in the Supabase SQL Editor — it adds
--   new tables / columns / indexes / functions / policies / permissions WITHOUT
--   touching existing data (every statement is guarded: CREATE ... IF NOT EXISTS,
--   DO-block duplicate guards, CREATE OR REPLACE, ON CONFLICT). Then open
--   Admin → Database Tools → Repair Database to converge role grants + seed data.
--   The applied version is recorded in settings.schema_version (last section).
--
-- ===== AMENDMENT RULES — keep this file re-runnable (read before editing) =====
--   * New table        → CREATE TABLE IF NOT EXISTS.
--   * NEW COLUMN on an existing table → a SEPARATE `ALTER TABLE x ADD COLUMN
--     IF NOT EXISTS col ... ` that is NULLABLE or has a DEFAULT. Editing the
--     CREATE TABLE body alone does NOTHING on an existing DB (the table already
--     exists) — this is the #1 footgun.
--   * New enum TYPE    → wrap in `DO $$ BEGIN CREATE TYPE ...; EXCEPTION WHEN
--     duplicate_object THEN NULL; END $$;`.
--   * New enum VALUE   → a BARE `ALTER TYPE x ADD VALUE IF NOT EXISTS 'v';`
--     (NOT inside a DO/transaction block — Postgres forbids it there).
--   * New FK/constraint → guarded DO-block (EXCEPTION WHEN duplicate_object).
--   * New index        → CREATE INDEX IF NOT EXISTS.
--   * New function/view → CREATE OR REPLACE (a view COLUMN-LIST change needs
--     DROP VIEW ... CASCADE + recreate + re-GRANT; plain CREATE OR REPLACE
--     cannot change a view's columns).
--   * New trigger/policy → DROP ... IF EXISTS first, then CREATE.
--   * New realtime table → add it to the §6a `CREATE PUBLICATION ... FOR TABLE`
--     list (the DROP+CREATE re-establishes current membership on re-run).
--   * New permission   → add to §7 (ON CONFLICT DO NOTHING) AND to
--     GLOBAL_PERMISSIONS (lib/db/system.ts) — tests/permissionSeedParity enforces it.
--   * New seed reference data → add to lib/db/seeder.ts with an upsert so Repair
--     Database converges it on existing installs.
--   * Breaking change (type change / rename / drop / NOT-NULL tighten / new CHECK
--     existing data violates) → a SELF-SKIPPING guarded DO-block that checks
--     information_schema / pg_constraint first (so re-run is a no-op), or a
--     clearly-fenced one-time block called out in that release's notes.
--   * BUMP settings.schema_version (last section) on every schema change, and
--     re-run this whole file TWICE on a data-seeded copy → zero errors, zero loss.
-- =============================================================================



-- =============================================================================
-- SECTION 1 — Extensions + private schema
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;   -- gen_random_uuid()

CREATE SCHEMA IF NOT EXISTS private;


-- =============================================================================
-- SECTION 2 — Enums (alliance_status + alliance_type rebuilt for alliance_peers)
-- =============================================================================

-- Each enum is wrapped in a duplicate-safe DO block so re-running schema.sql on
-- an existing DB is a no-op rather than a "type already exists" abort. To ADD a
-- new VALUE to an existing enum later, use a BARE (not in a DO/txn block)
-- statement: ALTER TYPE public.x ADD VALUE IF NOT EXISTS 'New';  (see §0 rules).
DO $$ BEGIN CREATE TYPE public.announcement_type AS ENUM ('Information', 'Warning', 'Danger'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE public.application_status AS ENUM ('Applied', 'Screening', 'Interviewing', 'On Hold', 'Offered', 'Rejected', 'Accepted', 'Hired', 'Withdrawn'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE public.conduct_record_type AS ENUM ('Commendation', 'Observation', 'Counseling', 'Warning', 'Infraction'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE public.fleet_group_type AS ENUM ('Division', 'Squadron', 'Wing', 'Taskforce', 'Custom'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE public.intel_subject_type AS ENUM ('Person', 'Organization'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Alliance federation (cross-instance diplomacy). See alliance_peers below.
DO $$ BEGIN CREATE TYPE public.alliance_status AS ENUM ('Pending', 'Active', 'Dissolved'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE public.alliance_type AS ENUM ('Alliance', 'Rivalry', 'Neutral'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE public.intel_threat_level AS ENUM ('None', 'Low', 'Medium', 'High', 'Critical'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE public.job_posting_status AS ENUM ('Draft', 'Open', 'Closed', 'Filled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE public.location_type AS ENUM ('System', 'Planet', 'Moon', 'Station', 'Facility'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE public.operation_status AS ENUM ('Planning', 'Scheduled', 'Active', 'Concluded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE public.operation_type AS ENUM ('PvP', 'PvE', 'Non-Combat', 'Training', 'Social', 'Mixed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE public.service_request_status AS ENUM ('Submitted', 'Triaged', 'Accepted', 'In-Progress', 'Success', 'Failed', 'Cancelled', 'Refused', 'Aborted', 'GameError'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE public.ship_status AS ENUM ('Active', 'Stored', 'Damaged', 'Lent', 'Sold'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE public.threat_level AS ENUM ('None', 'Low', 'Medium', 'High', 'Critical', 'PVP'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE public.transfer_request_status AS ENUM ('Pending', 'Approved', 'Denied', 'Cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE public.urgency_level AS ENUM ('Low', 'Medium', 'High', 'Critical'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE public.warrant_action AS ENUM ('Caution', 'High Caution', 'Extreme Caution'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE public.warrant_status AS ENUM ('Active', 'Claimed', 'Cancelled', 'Standing'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- =============================================================================
-- SECTION 3 — Tables
-- Integer/bigint surrogate PKs use IDENTITY (no standalone sequences needed).
-- Tables are ordered so every FK target is created before its referrer.
-- =============================================================================


-- ----- 3.0 Global reference / infra tables (no org, no user dependency) ------

CREATE TABLE IF NOT EXISTS public.cron_locks (
    job_name     text PRIMARY KEY,
    locked_until timestamptz NOT NULL DEFAULT now(),
    locked_at    timestamptz NOT NULL DEFAULT now(),
    worker_id    text NOT NULL DEFAULT '',
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.permissions (
    id          integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name        text NOT NULL UNIQUE,
    description text,
    category    text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.platform_ships (
    id                integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    external_uuid     text UNIQUE,
    name              text NOT NULL,
    manufacturer      text NOT NULL,
    manufacturer_code text,
    role              text,
    career            text,
    size              text,
    crew_min          integer DEFAULT 1,
    crew_max          integer DEFAULT 1,
    cargo_capacity    integer DEFAULT 0,
    length            numeric,
    beam              numeric,
    height            numeric,
    mass              integer,
    scm_speed         integer,
    max_speed         integer,
    health            integer,
    shield_hp         integer,
    image_url         text,
    wiki_url          text,
    pledge_url        text,
    msrp              numeric,
    description       text,
    production_status text,
    updated_at        timestamptz DEFAULT now(),
    created_at        timestamptz DEFAULT now(),
    external_api_id   integer UNIQUE
);

CREATE TABLE IF NOT EXISTS public.platform_locations (
    id                  bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    kind                text NOT NULL CHECK (kind IN (
        'star_system', 'orbit', 'planet', 'moon',
        'space_station', 'city', 'outpost', 'poi'
    )),
    external_id         integer NOT NULL,
    parent_id           bigint REFERENCES public.platform_locations(id) ON DELETE SET NULL,
    star_system_id      bigint REFERENCES public.platform_locations(id) ON DELETE CASCADE,
    name                text NOT NULL,
    nickname            text,
    code                text,
    path                text,
    is_available_live   boolean,
    is_visible          boolean,
    is_landable         boolean,
    is_armistice        boolean,
    is_decommissioned   boolean,
    is_internal         boolean NOT NULL DEFAULT false,
    is_hidden           boolean NOT NULL DEFAULT false,
    pad_types           text,
    amenities           jsonb NOT NULL DEFAULT '{}'::jsonb,
    faction_name        text,
    jurisdiction_name   text,
    wiki_url            text,
    uex_date_added      integer,
    uex_date_modified   integer,
    last_synced_at      timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_platform_locations_kind_external UNIQUE (kind, external_id)
);

CREATE TABLE IF NOT EXISTS public.quartermaster_platform_categories (
    id                bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    uex_category_id   integer NOT NULL UNIQUE,
    uex_category_name text NOT NULL,
    uex_section       text,
    display_name      text NOT NULL,
    sort_order        integer NOT NULL DEFAULT 0,
    is_hidden         boolean NOT NULL DEFAULT false,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.warehouse_platform_categories (
    id           bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    slug         text NOT NULL UNIQUE,
    uex_kind     text NOT NULL,
    display_name text NOT NULL,
    sort_order   integer NOT NULL DEFAULT 0,
    is_hidden    boolean NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.warehouse_platform_commodities (
    id                   bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    external_id          integer NOT NULL UNIQUE,
    external_uuid        text,
    slug                 text NOT NULL UNIQUE,
    name                 text NOT NULL,
    code                 text,
    kind                 text,
    weight_scu           numeric,
    price_buy            numeric,
    price_sell           numeric,
    is_available         boolean,
    is_available_live    boolean,
    is_visible           boolean,
    is_extractable       boolean,
    is_mineral           boolean,
    is_raw               boolean,
    is_pure              boolean,
    is_refined           boolean,
    is_refinable         boolean,
    is_harvestable       boolean,
    is_buyable           boolean,
    is_sellable          boolean,
    is_temporary         boolean,
    is_illegal           boolean,
    is_volatile_qt       boolean,
    is_volatile_time     boolean,
    is_inert             boolean,
    is_explosive         boolean,
    is_buggy             boolean,
    is_fuel              boolean,
    wiki_url             text,
    platform_category_id bigint REFERENCES public.warehouse_platform_categories(id) ON DELETE SET NULL,
    uex_date_added       integer,
    uex_date_modified    integer,
    last_synced_at       timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);


-- ----- 3.1 Org config tables (org column dropped; name/level/key uniques) -----

CREATE TABLE IF NOT EXISTS public.roles (
    id          integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name        text NOT NULL,
    description text,
    is_system   boolean DEFAULT false,
    CONSTRAINT roles_name_key UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS public.role_permissions (
    role_id       integer NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
    permission_id integer NOT NULL REFERENCES public.permissions(id) ON DELETE CASCADE,
    CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS public.ranks (
    id         integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name       varchar NOT NULL,
    icon_url   text,
    sort_order integer DEFAULT 0,
    CONSTRAINT ranks_name_key UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS public.units (
    id              integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name            varchar NOT NULL,
    parent_unit_id  integer REFERENCES public.units(id) ON DELETE SET NULL,
    sort_order      integer DEFAULT 0,
    leader_id       integer,   -- FK to users added after users exists
    logo_url        text,
    banner_url      text,
    motto           text,
    description     text,
    has_radio_channel boolean NOT NULL DEFAULT true,
    linked_channel_id text,
    is_restricted   boolean NOT NULL DEFAULT false,
    CONSTRAINT units_name_key UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS public.security_clearances (
    id          integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    level       integer NOT NULL,
    name        text NOT NULL,
    description text,
    CONSTRAINT security_clearances_level_key UNIQUE (level),
    CONSTRAINT security_clearances_name_key UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS public.security_limiting_markers (
    id              integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name            text NOT NULL,
    code            text NOT NULL,
    description     text,
    sync_restricted boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.personnel_positions (
    id          integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name        text NOT NULL,
    description text,
    icon        text,
    department  text,
    created_at  timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.certifications (
    id          integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name        varchar NOT NULL,
    description text,
    icon        text,
    image_url   text,
    CONSTRAINT certifications_name_key UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS public.commendations (
    id          integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name        varchar NOT NULL,
    description text,
    icon        text,
    image_url   text,
    CONSTRAINT commendations_name_key UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS public.specialization_tags (
    id          integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name        varchar NOT NULL,
    description text,
    icon        text,
    image_url   text,
    CONSTRAINT specialization_tags_name_key UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS public.service_types (
    id                 integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name               varchar NOT NULL,
    icon               text,
    color              text,
    description        text,
    is_active          boolean DEFAULT true,
    created_at         timestamptz DEFAULT now(),
    discord_channel_id text,
    CONSTRAINT service_types_name_key UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS public.locations (
    id        integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name      text NOT NULL,
    type      public.location_type NOT NULL,
    parent_id integer REFERENCES public.locations(id) ON DELETE SET NULL,
    CONSTRAINT locations_name_key UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS public.settings (
    key   varchar NOT NULL,
    value jsonb,
    CONSTRAINT settings_pkey PRIMARY KEY (key)
);

CREATE TABLE IF NOT EXISTS public.radio_channels (
    id         text NOT NULL,
    name       text NOT NULL,
    type       text DEFAULT 'public'::text,
    color      text DEFAULT 'text-slate-400'::text,
    sort_order integer DEFAULT 0,
    CONSTRAINT radio_channels_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.synced_discord_roles (
    id    text NOT NULL,
    name  text NOT NULL,
    color text NOT NULL,
    CONSTRAINT synced_discord_roles_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.rank_mappings (
    discord_role_id text NOT NULL,
    rank_id         integer REFERENCES public.ranks(id) ON DELETE SET NULL,
    role_id         integer REFERENCES public.roles(id) ON DELETE SET NULL,
    CONSTRAINT rank_mappings_pkey PRIMARY KEY (discord_role_id)
);

CREATE TABLE IF NOT EXISTS public.government_branches (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name        text NOT NULL,
    branch_type text NOT NULL DEFAULT 'Custom'::text,
    description text,
    sort_order  integer NOT NULL DEFAULT 0,
    icon        text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT government_branches_name_key UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS public.government_positions (
    id                    bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    branch_id             bigint REFERENCES public.government_branches(id) ON DELETE SET NULL,
    name                  text NOT NULL,
    description           text,
    fill_method           text NOT NULL DEFAULT 'Appointed'::text,
    term_length_days      integer,
    max_holders           integer NOT NULL DEFAULT 1,
    icon                  text,
    sort_order            integer NOT NULL DEFAULT 0,
    permissions_granted   text[] NOT NULL DEFAULT '{}'::text[],
    can_propose_legislation boolean NOT NULL DEFAULT false,
    can_vote_legislation  boolean NOT NULL DEFAULT false,
    can_veto_legislation  boolean NOT NULL DEFAULT false,
    can_call_elections    boolean NOT NULL DEFAULT false,
    created_at            timestamptz NOT NULL DEFAULT now(),
    can_issue_orders      boolean NOT NULL DEFAULT false,
    CONSTRAINT government_positions_name_key UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS public.government_configs (
    id                   uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    government_type      text NOT NULL DEFAULT 'custom'::text,
    name                 text NOT NULL DEFAULT 'Government'::text,
    description          text,
    constitution_content jsonb,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);


-- ----- 3.2 users (org column + org FK dropped) -------------------------------

CREATE TABLE IF NOT EXISTS public.users (
    id                    integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    auth_user_id          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    discord_id            text NOT NULL,
    name                  text NOT NULL,
    avatar_url            text,
    rsi_handle            varchar NOT NULL,
    reputation            integer NOT NULL DEFAULT 50,
    role_id               integer NOT NULL REFERENCES public.roles(id),
    rank_id               integer REFERENCES public.ranks(id) ON DELETE SET NULL,
    unit_id               integer REFERENCES public.units(id) ON DELETE SET NULL,
    clearance_level_id    integer REFERENCES public.security_clearances(id) ON DELETE SET NULL,
    position_id           integer REFERENCES public.personnel_positions(id) ON DELETE SET NULL,
    secondary_position_id integer REFERENCES public.personnel_positions(id) ON DELETE SET NULL,
    job_title             text,
    is_duty               boolean NOT NULL DEFAULT false,
    admin_notes           text,
    personnel_notes       text,
    voice_channel_name    varchar,
    deleted_at            timestamptz,
    rsi_handle_pending    varchar,
    rsi_verification_code varchar,
    -- false ONLY for an admin who used the first-run "verify later (offline)" bypass;
    -- everyone else (verified signup, imported members) defaults to true.
    rsi_verified          boolean NOT NULL DEFAULT true,
    discord_synced_at     timestamptz,
    probation_start       timestamptz,
    probation_end         timestamptz,
    display_name          text,
    timezone              text,
    date_format           text,
    is_affiliate          boolean NOT NULL DEFAULT false,
    is_vip                boolean NOT NULL DEFAULT false,
    tenure_start_date     timestamptz,
    -- Per-user session-revocation watermark. HMAC tokens issued before this are
    -- 401'd (force_logout) by the dispatcher. Set by admin:revoke_user_sessions
    -- or a soft-delete/ban. NULL = no per-user revocation in effect.
    tokens_valid_from     timestamptz
);
-- Idempotent add for existing deployments re-running schema.sql.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tokens_valid_from timestamptz;

-- Backfill the units.leader_id FK now that users exists.
DO $$ BEGIN
    ALTER TABLE public.units
        ADD CONSTRAINT units_leader_id_fkey FOREIGN KEY (leader_id) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One users row per Discord identity, preventing a second row from being bound
-- to a victim's discord_id (account squatting). Partial WHERE deleted_at IS NULL
-- so a soft-deleted account never blocks a legitimate re-registration.
-- Re-deploy on a populated DB: if two live (deleted_at IS NULL) rows already
-- share a discord_id, dedup them first or this index creation fails.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_discord_id_active
    ON public.users (discord_id) WHERE deleted_at IS NULL;

-- One account per VERIFIED RSI identity. Blocks two live accounts from both holding
-- a proven claim to the same handle (the race backstop behind the verifyRsiUpdate /
-- createUser app checks). Case-insensitive to match the app's ILIKE comparisons;
-- partial on rsi_verified so unverified placeholder handles never collide.
-- Re-deploy on a populated DB: if two verified live rows already share a handle
-- (case-insensitive), dedup them first or this index creation fails.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_rsi_handle_verified
    ON public.users (lower(rsi_handle)) WHERE deleted_at IS NULL AND rsi_verified = true;


-- ----- 3.3 Tables referencing users / config (org column dropped) ------------

CREATE TABLE IF NOT EXISTS public.announcements (
    id           uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    publish_date timestamptz NOT NULL DEFAULT now(),
    title        text NOT NULL,
    body         text NOT NULL,
    author       text NOT NULL,
    type         public.announcement_type NOT NULL,
    audience     text[] NOT NULL,
    expiry_date  timestamptz
);

CREATE TABLE IF NOT EXISTS public.api_keys (
    id           uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at   timestamptz NOT NULL DEFAULT now(),
    label        text NOT NULL,
    key_hash     text NOT NULL,
    last_used_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.external_tools (
    id          integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    created_at  timestamptz NOT NULL DEFAULT now(),
    title       text NOT NULL,
    description text NOT NULL,
    url         text NOT NULL,
    icon        text NOT NULL,
    audience    text[] NOT NULL,
    category    text,
    sort_order  integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.dossier_summaries (
    target_id    text NOT NULL,
    summary      text NOT NULL,
    generated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dossier_summaries_pkey PRIMARY KEY (target_id)
);

CREATE TABLE IF NOT EXISTS public.clearance_history (
    id                  integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id             integer REFERENCES public.users(id) ON DELETE SET NULL,
    admin_id            integer REFERENCES public.users(id) ON DELETE SET NULL,
    old_level_id        integer REFERENCES public.security_clearances(id) ON DELETE SET NULL,
    new_level_id        integer REFERENCES public.security_clearances(id) ON DELETE SET NULL,
    changes_description text,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.conduct_records (
    id             integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id        integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    type           public.conduct_record_type NOT NULL,
    reason         text NOT NULL,
    entered_by_id  integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.reputation_history (
    id             integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id        integer REFERENCES public.users(id) ON DELETE SET NULL,
    admin_user_id  integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    change_date    timestamptz NOT NULL DEFAULT now(),
    old_reputation integer NOT NULL,
    new_reputation integer NOT NULL,
    reason         text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.unit_posts (
    id         uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    unit_id    integer NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,
    author_id  integer REFERENCES public.users(id) ON DELETE SET NULL,
    content    text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    pinned     boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.user_certifications (
    user_id          integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    certification_id integer NOT NULL REFERENCES public.certifications(id) ON DELETE CASCADE,
    awarded_at       timestamptz NOT NULL DEFAULT now(),
    awarded_by       integer REFERENCES public.users(id) ON DELETE SET NULL,
    CONSTRAINT user_certifications_pkey PRIMARY KEY (user_id, certification_id)
);

CREATE TABLE IF NOT EXISTS public.user_commendations (
    id             integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id        integer REFERENCES public.users(id) ON DELETE CASCADE,
    commendation_id integer REFERENCES public.commendations(id) ON DELETE CASCADE,
    awarded_at     timestamptz NOT NULL DEFAULT now(),
    awarded_by     integer REFERENCES public.users(id) ON DELETE SET NULL,
    reason         text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.user_specializations (
    user_id          integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    specialization_id integer NOT NULL REFERENCES public.specialization_tags(id) ON DELETE CASCADE,
    CONSTRAINT user_specializations_pkey PRIMARY KEY (user_id, specialization_id)
);

CREATE TABLE IF NOT EXISTS public.user_limiting_markers (
    user_id   integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    marker_id integer NOT NULL REFERENCES public.security_limiting_markers(id) ON DELETE CASCADE,
    CONSTRAINT user_limiting_markers_pkey PRIMARY KEY (user_id, marker_id)
);

CREATE TABLE IF NOT EXISTS public.user_presence (
    user_id             integer NOT NULL PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    last_active_at      timestamptz,
    avatar_refreshed_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.user_hr_position_history (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id     integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    position_id bigint NOT NULL REFERENCES public.personnel_positions(id) ON DELETE CASCADE,
    started_at  timestamptz NOT NULL DEFAULT now(),
    ended_at    timestamptz,
    end_reason  text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
    id           uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id      integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    endpoint     text UNIQUE,
    p256dh       text,
    auth         text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now(),
    subscription jsonb
);

CREATE TABLE IF NOT EXISTS public.user_ships (
    id            integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id       integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    ship_id       integer NOT NULL REFERENCES public.platform_ships(id),
    custom_name   text,
    loadout_notes text,
    status        public.ship_status NOT NULL DEFAULT 'Active'::public.ship_status,
    is_primary    boolean DEFAULT false,
    created_at    timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fleet_groups (
    id           integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name         text NOT NULL,
    type         text NOT NULL DEFAULT 'Custom'::text,
    parent_id    integer REFERENCES public.fleet_groups(id) ON DELETE CASCADE,
    commander_id integer REFERENCES public.users(id) ON DELETE SET NULL,
    description  text,
    icon         text,
    sort_order   integer DEFAULT 0,
    created_at   timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fleet_group_ships (
    id            integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    fleet_group_id integer NOT NULL REFERENCES public.fleet_groups(id) ON DELETE CASCADE,
    user_ship_id  integer NOT NULL REFERENCES public.user_ships(id) ON DELETE CASCADE,
    assigned_at   timestamptz DEFAULT now(),
    sort_order    integer NOT NULL DEFAULT 0
);


-- ----- 3.4 HR ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hr_applications (
    id                   uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    applicant_name       text NOT NULL,
    applicant_discord_id text NOT NULL,
    rsi_handle           text NOT NULL,
    status               public.application_status NOT NULL DEFAULT 'Applied'::public.application_status,
    referral_source      text,
    notes                text,
    assigned_recruiter_id integer REFERENCES public.users(id) ON DELETE SET NULL,
    linked_user_id       integer REFERENCES public.users(id) ON DELETE SET NULL,
    vetting_data         jsonb DEFAULT '{}'::jsonb,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.hr_application_logs (
    id             uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    application_id uuid REFERENCES public.hr_applications(id) ON DELETE CASCADE,
    user_id        integer REFERENCES public.users(id) ON DELETE SET NULL,
    action_type    text NOT NULL,
    message        text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.hr_interview_templates (
    id          integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name        text NOT NULL,
    description text
);

CREATE TABLE IF NOT EXISTS public.hr_interview_questions (
    id            integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    template_id   integer REFERENCES public.hr_interview_templates(id) ON DELETE CASCADE,
    question_text text NOT NULL,
    order_index   integer NOT NULL
);

CREATE TABLE IF NOT EXISTS public.hr_interviews (
    id            uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    application_id uuid REFERENCES public.hr_applications(id) ON DELETE CASCADE,
    template_id   integer REFERENCES public.hr_interview_templates(id) ON DELETE SET NULL,
    interviewer_id integer REFERENCES public.users(id) ON DELETE SET NULL,
    scheduled_at  timestamptz,
    completed_at  timestamptz,
    overall_notes text,
    final_score   integer,
    status        text DEFAULT 'Scheduled'::text,
    is_recommended boolean
);

CREATE TABLE IF NOT EXISTS public.hr_interview_panel (
    id           integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    interview_id uuid NOT NULL REFERENCES public.hr_interviews(id) ON DELETE CASCADE,
    user_id      integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.hr_interview_responses (
    id            integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    interview_id  uuid REFERENCES public.hr_interviews(id) ON DELETE CASCADE,
    question_id   integer REFERENCES public.hr_interview_questions(id) ON DELETE SET NULL,
    response_body text,
    score         integer
);

CREATE TABLE IF NOT EXISTS public.hr_job_postings (
    id            uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    title         text NOT NULL,
    department    text NOT NULL,
    -- DEFAULT '' so an omitted description (optional in the create payload) does not
    -- raise a NOT NULL violation; the column stays non-null for readers.
    description   text NOT NULL DEFAULT '',
    requirements  text[] NOT NULL DEFAULT '{}'::text[],
    status        public.job_posting_status NOT NULL DEFAULT 'Open'::public.job_posting_status,
    created_by_id integer REFERENCES public.users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    position_id   integer REFERENCES public.personnel_positions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public.hr_job_applications (
    id           uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    job_id       uuid REFERENCES public.hr_job_postings(id) ON DELETE CASCADE,
    applicant_id integer REFERENCES public.users(id) ON DELETE SET NULL,
    statement    text,
    status       text DEFAULT 'Pending'::text,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- One application per member per job posting. Backstops the per-user submission
-- throttle so a member can't re-spam the same posting (each apply files an ATS row
-- and pushes every recruiter). Partial on applicant_id so rows orphaned by a member
-- deletion (applicant_id NULL) don't collide. Re-deploy on a populated DB: if a
-- member already has duplicate rows for one job, dedup them first or this fails.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_job_application_per_user
    ON public.hr_job_applications (applicant_id, job_id) WHERE applicant_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.hr_transfer_requests (
    id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id         integer REFERENCES public.users(id) ON DELETE SET NULL,
    current_unit_id integer REFERENCES public.units(id) ON DELETE SET NULL,
    target_unit_id  integer REFERENCES public.units(id) ON DELETE SET NULL,
    reason          text NOT NULL,
    status          public.transfer_request_status NOT NULL DEFAULT 'Pending'::public.transfer_request_status,
    admin_notes     text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz DEFAULT now()
);


-- ----- 3.5 Service requests --------------------------------------------------

CREATE TABLE IF NOT EXISTS public.service_requests (
    id                           varchar NOT NULL PRIMARY KEY,
    created_at                   timestamptz NOT NULL DEFAULT now(),
    updated_at                   timestamptz NOT NULL DEFAULT now(),
    client_id                    integer REFERENCES public.users(id) ON DELETE SET NULL,
    unregistered_client_rsi_handle varchar,
    service_type                 varchar NOT NULL,
    description                  text NOT NULL,
    location                     varchar NOT NULL,
    status                       public.service_request_status NOT NULL,
    urgency                      public.urgency_level NOT NULL,
    threat_level                 public.threat_level NOT NULL DEFAULT 'None'::public.threat_level,
    lead_responder_id            integer REFERENCES public.users(id) ON DELETE SET NULL,
    uec_earned                   integer,
    medigel_consumed             numeric DEFAULT 0.00,
    client_rating                integer,
    rated                        boolean DEFAULT false,
    party_info                   text,
    secondary_client_handles     text[] DEFAULT '{}'::text[],
    client_feedback              text
);

-- A rating is 1..5 (or unrated/null). Backstops the app-side clamp in rateRequest so
-- a bad value can never reach the public rating average. Idempotent for re-deploys.
DO $$ BEGIN
    ALTER TABLE public.service_requests
        ADD CONSTRAINT service_requests_client_rating_range
        CHECK (client_rating IS NULL OR (client_rating BETWEEN 1 AND 5));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One active SELF-SERVICE request per client. Backstops the count-then-insert check
-- in createServiceRequest (a concurrent burst could otherwise open several). Scoped to
-- unregistered_client_rsi_handle IS NULL so staff-logged ad-hoc requests (which set
-- that handle, and may legitimately stack for one client) are not constrained.
-- Re-deploy on a populated DB: if a client already has 2+ active self requests, close
-- the extras first or this index creation fails.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_self_request
    ON public.service_requests (client_id)
    WHERE client_id IS NOT NULL
      AND unregistered_client_rsi_handle IS NULL
      AND status IN ('Submitted', 'Triaged', 'Accepted', 'In-Progress');

CREATE TABLE IF NOT EXISTS public.request_responders (
    request_id varchar NOT NULL REFERENCES public.service_requests(id) ON DELETE CASCADE,
    user_id    integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    CONSTRAINT request_responders_pkey PRIMARY KEY (request_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.status_history (
    id         integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    request_id varchar REFERENCES public.service_requests(id) ON DELETE CASCADE,
    updated_at timestamptz NOT NULL DEFAULT now(),
    status     public.service_request_status NOT NULL,
    updated_by integer REFERENCES public.users(id) ON DELETE SET NULL,
    note       text
);


-- ----- 3.6 Intel + warrants --------------------------------------------------

-- alliance_peers — secure server-to-server federation between independent
-- self-hosted instances. A peer is either a handshake-paired ally OR a
-- manual/legacy one-directional intel-feed subscription (pairing_state).
-- Supersedes the old trusted_intel_feeds table (intel sharing is one channel).
-- Directional keys are derived on BOTH sides from a code-authenticated X25519
-- ECDH handshake and are NEVER transmitted. See migrations/add-alliances.sql.
CREATE TABLE IF NOT EXISTS public.alliance_peers (
    id                        uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),

    label                     text NOT NULL,
    base_url                  text NOT NULL,
    peer_org_name             text,
    peer_org_tag              text,
    peer_icon_url             text,
    peer_blurb                text,
    profile_fetched_at        timestamptz,

    status                    public.alliance_status NOT NULL DEFAULT 'Pending',
    type                      public.alliance_type   NOT NULL DEFAULT 'Alliance',

    inbound_max_clearance     integer NOT NULL DEFAULT 0,
    outbound_max_clearance    integer NOT NULL DEFAULT 0,
    channels                  jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- outbound_key_enc: key WE present to the peer (encrypted at rest).
    -- inbound_key_id: key the PEER presents to US, stored hashed in api_keys.
    outbound_key_enc          text,
    inbound_key_id            uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,

    -- Handshake state machine (see migrations/add-alliances.sql for field docs).
    -- Our own one-time code is the singleton settings key 'allianceLocalPairingCode';
    -- entered_peer_code_enc is the peer's code our admin typed (both needed to derive S).
    pairing_state             text NOT NULL DEFAULT 'idle',
    entered_peer_code_enc     text,
    entered_peer_code_expires timestamptz,
    handshake_nonce           text,
    handshake_expires         timestamptz,
    is_local_initiator        boolean,

    last_contact_at           timestamptz,
    revoked_at                timestamptz,

    -- Live-sync engine state (lib/db/allianceSync.ts). Health is derived from
    -- consecutive outbound failures; while 'down' the scheduler skips the peer
    -- until sync_next_attempt_at (exponential backoff). sync_alert is an
    -- operator-visible anomaly note (peer rollback detected, N items skipped),
    -- cleared on the next clean reconcile or admin force-sync.
    sync_health               text NOT NULL DEFAULT 'unknown',
    sync_failures             integer NOT NULL DEFAULT 0,
    sync_last_ok_at           timestamptz,
    sync_next_attempt_at      timestamptz,
    sync_alert                text,
    -- Dedicated intel-sync cursor in the PEER's clock domain (the peer's
    -- _meta.fetchedAt). Replaces the old conflated use of last_contact_at,
    -- which is also written by handshake/profile refreshes and could silently
    -- skip unsynced intel. NULL on upgraded rows → code falls back to
    -- last_contact_at once, then writes this column forward.
    intel_synced_at           timestamptz,
    -- Local-clock due-time bookkeeping for the ops manifest poll.
    ops_synced_at             timestamptz
);

CREATE INDEX IF NOT EXISTS idx_alliance_peers_status ON public.alliance_peers (status, type);
CREATE UNIQUE INDEX IF NOT EXISTS uq_alliance_peers_base_url ON public.alliance_peers (lower(base_url));

-- Background-refreshed copy of an ally's shared roster/fleet projections.
-- A SEPARATE table because the alliance_peers row is read on every inbound
-- federation request (getAlliancePeerByInboundKey), so the jsonb blobs must not
-- ride that hot path. Inbound-only cache of data the peer chose to share with
-- us — never re-served to other peers. Image URLs inside are sanitized at write
-- time (sanitizeImageUrl). Server-only: deny-by-default RLS, no
-- authenticated_select policy.
CREATE TABLE IF NOT EXISTS public.alliance_peer_directory_cache (
    peer_id    uuid NOT NULL PRIMARY KEY REFERENCES public.alliance_peers(id) ON DELETE CASCADE,
    roster     jsonb,
    fleet      jsonb,
    synced_at  timestamptz
);

CREATE TABLE IF NOT EXISTS public.intel_reports (
    id                  uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at          timestamptz NOT NULL DEFAULT now(),
    target_id           text NOT NULL,
    subject_type        public.intel_subject_type NOT NULL,
    threat_level        public.intel_threat_level NOT NULL,
    tags                text[] DEFAULT '{}'::text[],
    summary             text NOT NULL,
    evidence_urls       text[] DEFAULT '{}'::text[],
    created_by_id       integer REFERENCES public.users(id) ON DELETE SET NULL,
    affiliated_org      text,
    external_author     text,
    source_feed_id      uuid REFERENCES public.alliance_peers(id) ON DELETE SET NULL,
    external_id         text,
    classification_level integer NOT NULL DEFAULT 0
);

-- Keyset-pagination index for the intel feed (created_at DESC, id DESC), folded in
-- from the former pagination migration so fresh installs are not unindexed.
CREATE INDEX IF NOT EXISTS idx_intel_reports_created_id
    ON public.intel_reports (created_at DESC, id DESC);
-- Feed-dedup invariant: at most one report per (source_feed_id, external_id); backs the
-- .eq(external_id).eq(source_feed_id).maybeSingle() ingest guard against duplicate imports.
CREATE UNIQUE INDEX IF NOT EXISTS uq_intel_reports_feed_external
    ON public.intel_reports (source_feed_id, external_id) WHERE source_feed_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.intel_report_limiting_markers (
    report_id uuid NOT NULL REFERENCES public.intel_reports(id) ON DELETE CASCADE,
    marker_id integer NOT NULL REFERENCES public.security_limiting_markers(id) ON DELETE CASCADE,
    CONSTRAINT intel_report_limiting_markers_pkey PRIMARY KEY (report_id, marker_id)
);

CREATE TABLE IF NOT EXISTS public.intel_bulletins (
    id                     uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    title                  text NOT NULL,
    body                   text NOT NULL,
    threat_level           text NOT NULL DEFAULT 'Medium'::text,
    location               text,
    duration_minutes       integer NOT NULL DEFAULT 60,
    expires_at             timestamptz NOT NULL,
    classification_level   integer NOT NULL DEFAULT 0,
    created_by_id          integer REFERENCES public.users(id) ON DELETE SET NULL,
    created_at             timestamptz NOT NULL DEFAULT now(),
    shared_with_allies     boolean DEFAULT false,
    source_bulletin_id     uuid REFERENCES public.intel_bulletins(id) ON DELETE SET NULL,
    source_organization_name text,
    -- Set on bulletins ingested from an allied peer's intel channel; drives the
    -- "ALLY" badge in the UI (alliance federation, Phase 2).
    source_organization_id uuid REFERENCES public.alliance_peers(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public.intel_bulletin_limiting_markers (
    bulletin_id uuid NOT NULL REFERENCES public.intel_bulletins(id) ON DELETE CASCADE,
    marker_id   integer NOT NULL REFERENCES public.security_limiting_markers(id) ON DELETE CASCADE,
    CONSTRAINT intel_bulletin_limiting_markers_pkey PRIMARY KEY (bulletin_id, marker_id)
);

CREATE TABLE IF NOT EXISTS public.warrants (
    id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    target_rsi_handle text NOT NULL,
    reason          text NOT NULL,
    action          public.warrant_action NOT NULL,
    uec_reward      bigint NOT NULL DEFAULT 0,
    status          public.warrant_status NOT NULL DEFAULT 'Active'::public.warrant_status,
    -- Nullable for federated warrants ingested from an allied peer's intel
    -- channel: they carry honest "via <ally>" provenance (source_feed_id) with
    -- NO local issuer instead of fake admin attribution. SET NULL (not CASCADE)
    -- so deleting a user no longer destroys the warrants they issued.
    issued_by       integer REFERENCES public.users(id) ON DELETE SET NULL,
    claimed_by      integer REFERENCES public.users(id) ON DELETE SET NULL,
    claimed_at      timestamptz,
    notes           text,
    source_feed_id  uuid REFERENCES public.alliance_peers(id) ON DELETE SET NULL,
    -- text (not uuid) to match intel_reports.external_id and accept arbitrary
    -- remote-feed ids from non-myRSI peers without a 22P02 cast error.
    external_id     text
);

-- Feed-dedup invariant (parity with uq_intel_reports_feed_external): at most one
-- warrant per (source_feed_id, external_id). The ingest dedups by external_id
-- when the feed supplies one, falling back to content match for legacy feeds
-- without ids (which insert with external_id NULL — excluded from this index).
CREATE UNIQUE INDEX IF NOT EXISTS uq_warrants_feed_external
    ON public.warrants (source_feed_id, external_id)
    WHERE source_feed_id IS NOT NULL AND external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.warrant_notes (
    id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    warrant_id uuid NOT NULL REFERENCES public.warrants(id) ON DELETE CASCADE,
    author_id  integer REFERENCES public.users(id) ON DELETE SET NULL,
    content    text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);


-- ----- 3.7 Operations --------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.operations (
    id                    uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    name                  text NOT NULL,
    type                  public.operation_type NOT NULL,
    description           text,
    status                public.operation_status NOT NULL DEFAULT 'Planning'::public.operation_status,
    active_start_time     timestamptz,
    active_end_time       timestamptz,
    is_special            boolean DEFAULT false,
    join_code             text,
    tracks_uec            boolean DEFAULT false,
    total_uec             bigint DEFAULT 0,
    unit_id               integer REFERENCES public.units(id) ON DELETE SET NULL,
    location_id           integer REFERENCES public.locations(id) ON DELETE SET NULL,
    max_participants      integer,
    clearance_level       integer DEFAULT 0,
    is_training           boolean DEFAULT false,
    owner_id              integer REFERENCES public.users(id) ON DELETE SET NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    scheduled_start       timestamptz,
    scheduled_end         timestamptz,
    is_joint              boolean NOT NULL DEFAULT false,
    roe                   text,
    commander_notes       text,
    comms_plan            jsonb NOT NULL DEFAULT '[]'::jsonb,
    live_status           text,
    aar_summary           text,
    aar_lessons_learned   text,
    aar_submitted_at      timestamptz,
    aar_submitted_by      integer REFERENCES public.users(id) ON DELETE SET NULL,
    aar_ai_generated_at   timestamptz,
    location_text         text,
    additional_location_texts text[] NOT NULL DEFAULT '{}'::text[],
    total_costs           bigint NOT NULL DEFAULT 0,
    payout_mode           text NOT NULL DEFAULT 'equal'::text CHECK (payout_mode IN ('equal', 'weighted', 'custom')),
    discord_announcement_channel_id text,
    discord_announcement_message_id text,
    -- Discord Guild Scheduled Event id (set when an op is created with a Discord event);
    -- read on op delete/update for event cleanup + mirroring. Server-authored, nullable.
    discord_event_id      text,
    -- Template this op was instantiated from. Nullable; FK is wired after
    -- operation_templates is defined (deferred ALTER below that table).
    template_id           bigint,
    -- Monotonic counter bumped on any structure/status change; used to version-gate
    -- joint-operation snapshots pushed/pulled by allied instances (alliance P3).
    joint_version         integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.operation_phases (
    id           bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    operation_id uuid NOT NULL REFERENCES public.operations(id) ON DELETE CASCADE,
    name         text NOT NULL,
    description  text,
    phase_type   text NOT NULL DEFAULT 'sequential'::text,
    sort_order   integer NOT NULL DEFAULT 0,
    status       text NOT NULL DEFAULT 'Pending'::text,
    color        text,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.operation_tasks (
    id               bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    operation_id     uuid NOT NULL REFERENCES public.operations(id) ON DELETE CASCADE,
    title            text NOT NULL,
    description      text,
    task_type        text NOT NULL DEFAULT 'primary'::text,
    assigned_unit_id integer REFERENCES public.units(id) ON DELETE SET NULL,
    assigned_user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
    phase_id         bigint REFERENCES public.operation_phases(id) ON DELETE SET NULL,
    status           text NOT NULL DEFAULT 'Pending'::text,
    priority         text NOT NULL DEFAULT 'Normal'::text,
    sort_order       integer NOT NULL DEFAULT 0,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.operation_participants (
    operation_id      uuid NOT NULL REFERENCES public.operations(id) ON DELETE CASCADE,
    user_id           integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    role_requested    text,
    ship_utilized     text,
    attendance_status text DEFAULT 'Pending'::text,
    is_ready          boolean DEFAULT false,
    joined_at         timestamptz NOT NULL DEFAULT now(),
    -- Departure timestamp: NULL means the participant is still ACTIVE. The
    -- special-op visibility gate (lib/db/ops.ts canUserSeeOpInList and the
    -- rt_recv_op_board realtime RLS policy in §6b) treats time_left IS NULL as
    -- "active participant"; lib/db/ops.ts stamps it on leave / reset-readiness.
    time_left         timestamptz,
    ship_id           integer REFERENCES public.platform_ships(id) ON DELETE SET NULL,
    rsvp_status       text DEFAULT 'Pending'::text,
    rsvp_at           timestamptz,
    user_ship_id      integer REFERENCES public.user_ships(id) ON DELETE SET NULL,
    live_status       text,
    payout_share_percent numeric(6,3),
    payout_paid_at    timestamptz,
    payout_paid_by    integer REFERENCES public.users(id) ON DELETE SET NULL,
    CONSTRAINT operation_participants_pkey PRIMARY KEY (operation_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.operation_aar_entries (
    id           bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    operation_id uuid NOT NULL REFERENCES public.operations(id) ON DELETE CASCADE,
    author_id    integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    category     text NOT NULL DEFAULT 'observation'::text,
    content      text NOT NULL,
    upvotes      integer NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.operation_board_elements (
    id           bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    operation_id uuid NOT NULL REFERENCES public.operations(id) ON DELETE CASCADE,
    element_type text NOT NULL DEFAULT 'unit'::text,
    label        text,
    pos_x        real NOT NULL DEFAULT 0,
    pos_y        real NOT NULL DEFAULT 0,
    width        real,
    height       real,
    rotation     real NOT NULL DEFAULT 0,
    color        text,
    data         jsonb NOT NULL DEFAULT '{}'::jsonb,
    layer        integer NOT NULL DEFAULT 0,
    sort_order   integer NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.operation_command_nodes (
    id               bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    operation_id     uuid NOT NULL REFERENCES public.operations(id) ON DELETE CASCADE,
    parent_id        bigint REFERENCES public.operation_command_nodes(id) ON DELETE CASCADE,
    label            text NOT NULL,
    node_type        text NOT NULL DEFAULT 'position'::text,
    assigned_user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
    assigned_unit_id integer REFERENCES public.units(id) ON DELETE SET NULL,
    pos_x            real NOT NULL DEFAULT 0,
    pos_y            real NOT NULL DEFAULT 0,
    color            text,
    icon             text,
    sort_order       integer NOT NULL DEFAULT 0,
    created_at       timestamptz NOT NULL DEFAULT now(),
    fleet_group_id   integer REFERENCES public.fleet_groups(id) ON DELETE SET NULL,
    live_status      text
);

CREATE TABLE IF NOT EXISTS public.operation_limiting_markers (
    operation_id uuid NOT NULL REFERENCES public.operations(id) ON DELETE CASCADE,
    marker_id    integer NOT NULL REFERENCES public.security_limiting_markers(id) ON DELETE CASCADE,
    CONSTRAINT operation_limiting_markers_pkey PRIMARY KEY (operation_id, marker_id)
);

CREATE TABLE IF NOT EXISTS public.operation_locations (
    operation_id uuid NOT NULL REFERENCES public.operations(id) ON DELETE CASCADE,
    location_id  integer NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    is_primary   boolean NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT operation_locations_pkey PRIMARY KEY (operation_id, location_id)
);

CREATE TABLE IF NOT EXISTS public.operation_log_entries (
    id              integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    operation_id    uuid NOT NULL REFERENCES public.operations(id) ON DELETE CASCADE,
    entry_type      text NOT NULL,
    log_entry       text NOT NULL,
    author_id       integer REFERENCES public.users(id) ON DELETE SET NULL,
    uec_amount      bigint,
    created_at      timestamptz NOT NULL DEFAULT now(),
    cost_category   text,
    cost_description text
);

CREATE TABLE IF NOT EXISTS public.operation_logistics (
    id                 bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    operation_id       uuid NOT NULL REFERENCES public.operations(id) ON DELETE CASCADE,
    item_name          text NOT NULL,
    quantity_needed    integer NOT NULL DEFAULT 1,
    quantity_fulfilled integer NOT NULL DEFAULT 0,
    fulfilled_by_user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
    category           text NOT NULL DEFAULT 'general'::text,
    status             text NOT NULL DEFAULT 'Needed'::text,
    notes              text,
    created_at         timestamptz NOT NULL DEFAULT now()
);

-- ----- Joint-operation federation (alliance P3) ------------------------------
-- Cross-instance joint operations: the HOST instance owns the operation; invited
-- allied instances get a read-only mirror and sync their members' RSVPs back.
-- See lib/db/operations-federation.ts.

-- HOST side: which allied peers are invited to a locally-owned joint op.
CREATE TABLE IF NOT EXISTS public.operation_allied_orgs (
    id           bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    operation_id uuid NOT NULL REFERENCES public.operations(id) ON DELETE CASCADE,
    peer_id      uuid NOT NULL REFERENCES public.alliance_peers(id) ON DELETE CASCADE,
    accepted     boolean NOT NULL DEFAULT false,
    invited_at   timestamptz NOT NULL DEFAULT now(),
    accepted_at  timestamptz,
    CONSTRAINT operation_allied_orgs_unique UNIQUE (operation_id, peer_id)
);
CREATE INDEX IF NOT EXISTS idx_operation_allied_orgs_op ON public.operation_allied_orgs (operation_id);

-- HOST side: allied members participating in a locally-owned joint op. These are
-- members of a PEER instance, so there is deliberately NO users FK — their identity
-- is a snapshot synced from the peer.
CREATE TABLE IF NOT EXISTS public.operation_allied_participants (
    operation_id      uuid NOT NULL REFERENCES public.operations(id) ON DELETE CASCADE,
    peer_id           uuid NOT NULL REFERENCES public.alliance_peers(id) ON DELETE CASCADE,
    remote_user_handle text NOT NULL,
    display_name      text,
    avatar_url        text,
    role              text,
    ship_text         text,
    rsvp_status       text NOT NULL DEFAULT 'Pending',
    is_ready          boolean NOT NULL DEFAULT false,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT operation_allied_participants_pkey PRIMARY KEY (operation_id, peer_id, remote_user_handle)
);

-- GUEST side: a read-only mirror of an operation hosted by an allied peer. The
-- full projected operation is stored as a jsonb snapshot (it deserializes to the
-- same HydratedOperation shape getFullOperationDetails produces).
CREATE TABLE IF NOT EXISTS public.mirrored_operations (
    id                 uuid NOT NULL PRIMARY KEY,            -- the HOST operation_id
    host_peer_id       uuid NOT NULL REFERENCES public.alliance_peers(id) ON DELETE CASCADE,
    snapshot           jsonb,
    version            integer NOT NULL DEFAULT 0,
    snapshot_updated_at timestamptz,
    accepted           boolean NOT NULL DEFAULT false,
    invited_at         timestamptz NOT NULL DEFAULT now(),
    accepted_at        timestamptz,
    last_polled_at     timestamptz,
    revoked_at         timestamptz
);
CREATE INDEX IF NOT EXISTS idx_mirrored_operations_peer ON public.mirrored_operations (host_peer_id);

-- GUEST side: this instance's own members' participation in a mirrored op. These
-- ARE local users, so a normal users FK is correct. Survives snapshot replacement
-- and is overlaid on the read-only host snapshot at render. Pushed back to the host.
CREATE TABLE IF NOT EXISTS public.mirrored_operation_participation (
    mirror_op_id  uuid NOT NULL REFERENCES public.mirrored_operations(id) ON DELETE CASCADE,
    user_id       integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    rsvp_status   text NOT NULL DEFAULT 'Pending',
    ship_text     text,
    is_ready      boolean NOT NULL DEFAULT false,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mirrored_operation_participation_pkey PRIMARY KEY (mirror_op_id, user_id)
);
-- RLS for these (and all public tables) is enabled deny-by-default by the loop in
-- SECTION 6 — Row Level Security. They are server-only (not realtime-subscribed),
-- so they correctly get no authenticated_select policy.

CREATE TABLE IF NOT EXISTS public.operation_reminders (
    id           uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    operation_id uuid NOT NULL REFERENCES public.operations(id) ON DELETE CASCADE,
    remind_at    timestamptz NOT NULL,
    sent         boolean DEFAULT false,
    created_at   timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.operation_schedule_entries (
    id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    operation_id   uuid NOT NULL REFERENCES public.operations(id) ON DELETE CASCADE,
    label          text NOT NULL,
    scheduled_time timestamptz,
    phase_id       bigint REFERENCES public.operation_phases(id) ON DELETE SET NULL,
    notes          text,
    sort_order     integer NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now(),
    status         text
);

CREATE TABLE IF NOT EXISTS public.operation_templates (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name        text NOT NULL UNIQUE,
    description text,
    created_by  integer REFERENCES public.users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    payload     jsonb NOT NULL,
    -- A template extracted from an operation inherits that op's clearance so the
    -- laundered phase/task plan stays as restricted as the source. Snapshot at
    -- create time; the read path filters templates by these like operations.
    classification_level integer NOT NULL DEFAULT 0,
    limiting_marker_ids  bigint[] NOT NULL DEFAULT '{}'
);
-- Re-runnable: add the clearance columns to instances created before they existed.
ALTER TABLE public.operation_templates ADD COLUMN IF NOT EXISTS classification_level integer NOT NULL DEFAULT 0;
ALTER TABLE public.operation_templates ADD COLUMN IF NOT EXISTS limiting_marker_ids bigint[] NOT NULL DEFAULT '{}';

-- operations.template_id -> operation_templates: FK wired here (deferred) because
-- operations is created earlier in the file. ON DELETE SET NULL keeps ops if a
-- template is removed.
DO $$ BEGIN
    ALTER TABLE public.operations
        ADD CONSTRAINT operations_template_id_fkey
        FOREIGN KEY (template_id) REFERENCES public.operation_templates(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- updated_at trigger for operation_templates. search_path is pinned (empty) so the
-- function never resolves unqualified names against a caller-controlled path
-- (Supabase linter: function_search_path_mutable). now() resolves from pg_catalog
-- regardless. (This function/trigger previously lived only in a feature migration;
-- folded into the canonical schema so fresh installs match.)
CREATE OR REPLACE FUNCTION public._operation_templates_set_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_operation_templates_updated_at ON public.operation_templates;
CREATE TRIGGER trg_operation_templates_updated_at
    BEFORE UPDATE ON public.operation_templates
    FOR EACH ROW EXECUTE FUNCTION public._operation_templates_set_updated_at();


-- ----- 3.8 Government (depends on positions/branches/users) ------------------

CREATE TABLE IF NOT EXISTS public.government_elections (
    id                  bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    position_id         bigint NOT NULL REFERENCES public.government_positions(id) ON DELETE CASCADE,
    title               text NOT NULL,
    description         text,
    election_type       text NOT NULL DEFAULT 'SimpleMajority'::text,
    status              text NOT NULL DEFAULT 'Draft'::text,
    candidacy_start     timestamptz,
    candidacy_end       timestamptz,
    voting_start        timestamptz,
    voting_end          timestamptz,
    min_candidates      integer NOT NULL DEFAULT 1,
    max_winners         integer NOT NULL DEFAULT 1,
    min_voter_turnout_pct numeric,
    min_vote_threshold_pct numeric,
    allow_runoff        boolean NOT NULL DEFAULT false,
    runoff_top_n        integer NOT NULL DEFAULT 2,
    parent_election_id  bigint REFERENCES public.government_elections(id) ON DELETE SET NULL,
    is_by_election      boolean NOT NULL DEFAULT false,
    remaining_term_days integer,
    created_by_id       integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    concluded_at        timestamptz,
    conclusion_reason   text,
    certified_by_id     integer REFERENCES public.users(id) ON DELETE SET NULL,
    certified_at        timestamptz,
    eligible_voter_count integer,
    total_votes_cast    integer,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.government_election_candidates (
    id                bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    election_id       bigint NOT NULL REFERENCES public.government_elections(id) ON DELETE CASCADE,
    user_id           integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    platform_statement text,
    declared_at       timestamptz NOT NULL DEFAULT now(),
    withdrawn_at      timestamptz,
    is_winner         boolean NOT NULL DEFAULT false,
    vote_count        integer,
    vote_percentage   numeric
);

-- One active candidacy per (election, user), so a member can't self-declare N
-- times to pad the candidate count. Partial WHERE withdrawn_at IS NULL so a
-- withdrawn run does not block re-declaring.
-- Re-deploy on a populated DB: dedup any existing active duplicate
-- (election_id,user_id) rows first or this index creation will fail.
CREATE UNIQUE INDEX IF NOT EXISTS uq_gov_election_candidacy
    ON public.government_election_candidates (election_id, user_id) WHERE withdrawn_at IS NULL;

CREATE TABLE IF NOT EXISTS public.government_election_voter_registry (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    election_id bigint NOT NULL REFERENCES public.government_elections(id) ON DELETE CASCADE,
    user_id     integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    voted_at    timestamptz NOT NULL DEFAULT now(),
    -- One ballot per (election, user). The app-level count pre-check is racy; this
    -- UNIQUE is the real one-person-one-vote guard the vote code relies on.
    CONSTRAINT government_election_voter_registry_unique UNIQUE (election_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.government_election_votes (
    id           uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    election_id  bigint NOT NULL REFERENCES public.government_elections(id) ON DELETE CASCADE,
    voter_hash   text NOT NULL,
    candidate_id bigint NOT NULL REFERENCES public.government_election_candidates(id) ON DELETE CASCADE,
    rank_order   integer,
    cast_at      timestamptz NOT NULL DEFAULT now()
);

-- One vote per (election, candidate, voter), guarding against ballot-stuffing.
-- The voter key here is voter_hash (this table has no user_id column); the
-- per-ballot guard is government_election_voter_registry_unique above.
-- voter_hash is NOT NULL so no partial clause is needed.
-- Re-deploy on a populated DB: dedup any existing duplicate
-- (election_id,candidate_id,voter_hash) rows first or this index creation fails.
CREATE UNIQUE INDEX IF NOT EXISTS uq_gov_election_vote
    ON public.government_election_votes (election_id, candidate_id, voter_hash);

CREATE TABLE IF NOT EXISTS public.government_position_holders (
    id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    position_id    bigint NOT NULL REFERENCES public.government_positions(id) ON DELETE CASCADE,
    user_id        integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    appointed_by_id integer REFERENCES public.users(id) ON DELETE SET NULL,
    election_id    bigint REFERENCES public.government_elections(id) ON DELETE SET NULL,
    started_at     timestamptz NOT NULL DEFAULT now(),
    ended_at       timestamptz,
    end_reason     text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- At most one ACTIVE holder per (position, user): makes appointPositionHolder's
-- existing-holder pre-check and the .single() active-holder lookup atomic.
CREATE UNIQUE INDEX IF NOT EXISTS uq_gov_active_position_holder
    ON public.government_position_holders (position_id, user_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS public.government_legislation (
    id                     bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    title                  text NOT NULL,
    body                   jsonb NOT NULL DEFAULT '""'::jsonb,
    summary                text,
    status                 text NOT NULL DEFAULT 'Draft'::text,
    author_id              integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    sponsor_position_id    bigint REFERENCES public.government_positions(id) ON DELETE SET NULL,
    parent_legislation_id  bigint REFERENCES public.government_legislation(id) ON DELETE SET NULL,
    is_constitutional_amendment boolean NOT NULL DEFAULT false,
    voting_start           timestamptz,
    voting_end             timestamptz,
    votes_for              integer NOT NULL DEFAULT 0,
    votes_against          integer NOT NULL DEFAULT 0,
    votes_abstain          integer NOT NULL DEFAULT 0,
    passed_at              timestamptz,
    vetoed_at              timestamptz,
    vetoed_by_id           integer REFERENCES public.users(id) ON DELETE SET NULL,
    veto_reason            text,
    repealed_at            timestamptz,
    repealed_by_legislation_id bigint REFERENCES public.government_legislation(id) ON DELETE SET NULL,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.government_legislation_comments (
    id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    legislation_id bigint NOT NULL REFERENCES public.government_legislation(id) ON DELETE CASCADE,
    user_id        integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    content        text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.government_legislation_votes (
    id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    legislation_id bigint NOT NULL REFERENCES public.government_legislation(id) ON DELETE CASCADE,
    user_id        integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    position_id    bigint NOT NULL REFERENCES public.government_positions(id) ON DELETE CASCADE,
    vote           text NOT NULL CHECK (vote IN ('for', 'against', 'abstain')),
    cast_at        timestamptz NOT NULL DEFAULT now()
);
-- One-person-one-vote for legislation (the cast function also pre-checks + treats
-- 23505 as the atomic guard). Re-deploy on a populated DB: dedup duplicate
-- (legislation_id,user_id) rows first or this index creation will fail.
CREATE UNIQUE INDEX IF NOT EXISTS uq_gov_legislation_vote
    ON public.government_legislation_votes (legislation_id, user_id);

CREATE TABLE IF NOT EXISTS public.government_motions (
    id                  bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    title               text NOT NULL,
    description         text,
    status              text NOT NULL DEFAULT 'Open'::text,
    created_by_id       integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    restricted_to_position_ids integer[],
    voting_start        timestamptz,
    voting_end          timestamptz,
    votes_for           integer NOT NULL DEFAULT 0,
    votes_against       integer NOT NULL DEFAULT 0,
    votes_abstain       integer NOT NULL DEFAULT 0,
    is_secret_ballot    boolean NOT NULL DEFAULT false,
    concluded_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.government_motion_votes (
    id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    motion_id  bigint NOT NULL REFERENCES public.government_motions(id) ON DELETE CASCADE,
    user_id    integer REFERENCES public.users(id) ON DELETE SET NULL,
    voter_hash text,
    vote       text NOT NULL CHECK (vote IN ('for', 'against', 'abstain')),
    cast_at    timestamptz NOT NULL DEFAULT now()
);
-- One-person-one-vote for motions: by user (named) or voter_hash (anonymous). The
-- cast function pre-checks + treats 23505 as the atomic guard. Re-deploy on a
-- populated DB: dedup duplicates first or these index creations will fail.
CREATE UNIQUE INDEX IF NOT EXISTS uq_gov_motion_vote_user
    ON public.government_motion_votes (motion_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gov_motion_vote_hash
    ON public.government_motion_votes (motion_id, voter_hash) WHERE voter_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.government_orders (
    id                   uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    issuer_position_id   bigint NOT NULL REFERENCES public.government_positions(id) ON DELETE RESTRICT,
    issuer_user_id       integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    number               text,
    title                text NOT NULL,
    preamble             text,
    body                 text NOT NULL,
    rationale            text,
    status               text NOT NULL DEFAULT 'draft'::text CHECK (status IN ('draft', 'active', 'expired', 'revoked')),
    effective_at         timestamptz,
    expires_at           timestamptz,
    issued_at            timestamptz,
    revoked_at           timestamptz,
    revoked_by_user_id   integer REFERENCES public.users(id) ON DELETE SET NULL,
    revoked_by_position_id bigint REFERENCES public.government_positions(id) ON DELETE SET NULL,
    revoked_reason       text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);


-- ----- 3.9 Wiki --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.wiki_pages (
    id                  uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    parent_page_id      uuid REFERENCES public.wiki_pages(id) ON DELETE SET NULL,
    title               text NOT NULL,
    slug                text NOT NULL,
    content             jsonb DEFAULT '{}'::jsonb,
    classification_level integer DEFAULT 0,
    sort_order          integer DEFAULT 0,
    created_by_id       integer REFERENCES public.users(id) ON DELETE SET NULL,
    updated_by_id       integer REFERENCES public.users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    menu_structure_locked boolean NOT NULL DEFAULT false,
    CONSTRAINT wiki_pages_slug_unique UNIQUE (slug)
);

CREATE TABLE IF NOT EXISTS public.wiki_page_limiting_markers (
    page_id   uuid NOT NULL REFERENCES public.wiki_pages(id) ON DELETE CASCADE,
    marker_id integer NOT NULL REFERENCES public.security_limiting_markers(id) ON DELETE CASCADE,
    CONSTRAINT wiki_page_limiting_markers_pkey PRIMARY KEY (page_id, marker_id)
);


-- ----- 3.10 Finances / Treasury ----------------------------------------------

CREATE TABLE IF NOT EXISTS public.treasury_accounts (
    id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name           text NOT NULL,
    type           text NOT NULL DEFAULT 'general'::text CHECK (type IN ('general', 'reserve', 'project', 'ops')),
    description    text,
    balance_cached bigint NOT NULL DEFAULT 0,
    is_active      boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.treasury_ledger_entries (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id          bigint NOT NULL REFERENCES public.treasury_accounts(id) ON DELETE RESTRICT,
    entry_type          text NOT NULL CHECK (entry_type IN ('deposit', 'withdrawal', 'transfer', 'payout', 'adjustment')),
    amount              bigint NOT NULL,
    status              text NOT NULL DEFAULT 'pending'::text CHECK (status IN ('pending', 'confirmed', 'rejected', 'reversed')),
    memo                text,
    counterparty_user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
    counterparty_text   text,
    operation_id        bigint,
    related_inventory_id bigint,
    related_entry_id    uuid REFERENCES public.treasury_ledger_entries(id) ON DELETE RESTRICT,
    transfer_group_id   uuid,
    created_by_user_id  integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    approved_by_user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
    approved_at         timestamptz,
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT treasury_ledger_amount_nonzero CHECK (amount <> 0),
    CONSTRAINT treasury_ledger_sign_matches_type CHECK (
        (entry_type = 'deposit'    AND amount > 0) OR
        (entry_type = 'withdrawal' AND amount < 0) OR
        (entry_type IN ('transfer', 'payout', 'adjustment'))
    )
);

CREATE INDEX IF NOT EXISTS idx_treasury_accounts_active ON public.treasury_accounts(is_active);
CREATE INDEX IF NOT EXISTS idx_treasury_ledger_account_created
    ON public.treasury_ledger_entries(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_treasury_ledger_status
    ON public.treasury_ledger_entries(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_treasury_ledger_pending
    ON public.treasury_ledger_entries(created_at DESC) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS uq_treasury_ledger_pending_dedup
    ON public.treasury_ledger_entries(account_id, memo, amount)
    WHERE status = 'pending' AND memo IS NOT NULL;


-- ----- 3.11 Quartermaster (inventory) ----------------------------------------
-- catalog: org-only schema drops the platform/custom split. catalog_id is now a
-- plain table (slug UNIQUE) keeping the UEX-sync metadata columns. The original
-- platform/custom CHECK + partial indexes are removed (no organization_id).

CREATE TABLE IF NOT EXISTS public.quartermaster_catalog (
    id              bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    slug            text NOT NULL UNIQUE,
    name            text NOT NULL,
    category        text NOT NULL CHECK (category IN ('weapon', 'armor', 'component', 'consumable', 'misc')),
    subcategory     text,
    attributes      jsonb NOT NULL DEFAULT '{}'::jsonb,
    source          text NOT NULL DEFAULT 'custom'::text CHECK (source IN ('platform', 'custom')),
    thumbnail_url   text,
    wiki_url        text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    external_uuid   text UNIQUE,
    external_id     bigint UNIQUE,
    is_vehicle_item boolean NOT NULL DEFAULT false,
    is_commodity    boolean NOT NULL DEFAULT false,
    is_harvestable  boolean NOT NULL DEFAULT false,
    screenshot_url  text,
    store_url       text,
    company_name    text,
    vehicle_name    text,
    quality         integer,
    size_label      text,
    color           text,
    color2          text,
    game_version    text,
    platform_category_id bigint REFERENCES public.quartermaster_platform_categories(id) ON DELETE SET NULL,
    last_synced_at  timestamptz
);

CREATE TABLE IF NOT EXISTS public.quartermaster_locations (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name        text NOT NULL,
    type        text NOT NULL DEFAULT 'custom'::text CHECK (type IN ('hangar', 'ship', 'station', 'custom')),
    parent_id   bigint REFERENCES public.quartermaster_locations(id) ON DELETE SET NULL,
    description text,
    sort_order  integer NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quartermaster_inventory (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    catalog_id  bigint REFERENCES public.quartermaster_catalog(id) ON DELETE SET NULL,
    custom_name text,
    location_id bigint REFERENCES public.quartermaster_locations(id) ON DELETE SET NULL,
    condition   text NOT NULL DEFAULT 'pristine'::text CHECK (condition IN ('pristine', 'used', 'damaged', 'broken')),
    acquired_at timestamptz NOT NULL DEFAULT now(),
    notes       text,
    is_archived boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT qm_inventory_has_name CHECK (catalog_id IS NOT NULL OR (custom_name IS NOT NULL AND custom_name <> ''))
);

CREATE TABLE IF NOT EXISTS public.quartermaster_issuances (
    id                   bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    inventory_id         bigint NOT NULL REFERENCES public.quartermaster_inventory(id) ON DELETE RESTRICT,
    issued_to_user_id    integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    quantity             integer NOT NULL CHECK (quantity > 0),
    status               text NOT NULL DEFAULT 'active'::text CHECK (status IN ('requested', 'active', 'returned', 'written_off')),
    requested_at         timestamptz,
    issued_at            timestamptz,
    due_back_at          timestamptz,
    returned_at          timestamptz,
    returned_quantity    integer,
    outcome              text CHECK (outcome IN ('returned_on_time', 'returned_late', 'returned_damaged', 'lost', 'destroyed_in_action')),
    requested_by_user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
    issued_by_user_id    integer REFERENCES public.users(id) ON DELETE SET NULL,
    closed_by_user_id    integer REFERENCES public.users(id) ON DELETE SET NULL,
    notes                text,
    operation_id         bigint,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quartermaster_inventory_movements (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    inventory_id        bigint NOT NULL REFERENCES public.quartermaster_inventory(id) ON DELETE RESTRICT,
    delta               integer NOT NULL CHECK (delta <> 0),
    reason              text NOT NULL CHECK (reason IN ('initial', 'issue', 'return', 'adjust', 'loss', 'destruction')),
    actor_user_id       integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    related_issuance_id bigint REFERENCES public.quartermaster_issuances(id) ON DELETE SET NULL,
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qm_inventory_archived ON public.quartermaster_inventory(is_archived);
CREATE INDEX IF NOT EXISTS idx_qm_inventory_catalog ON public.quartermaster_inventory(catalog_id);
CREATE INDEX IF NOT EXISTS idx_qm_inventory_location ON public.quartermaster_inventory(location_id);
CREATE INDEX IF NOT EXISTS idx_qm_movements_inventory ON public.quartermaster_inventory_movements(inventory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qm_issuances_status ON public.quartermaster_issuances(status);
CREATE INDEX IF NOT EXISTS idx_qm_issuances_user ON public.quartermaster_issuances(issued_to_user_id, status);
CREATE INDEX IF NOT EXISTS idx_qm_issuances_due ON public.quartermaster_issuances(due_back_at)
    WHERE status = 'active' AND due_back_at IS NOT NULL;


-- ----- 3.12 Warehouse (bulk commodities) -------------------------------------

CREATE TABLE IF NOT EXISTS public.warehouse_catalog (
    id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name          text NOT NULL,
    category      text NOT NULL CHECK (category IN ('ore', 'refined', 'fuel', 'rmc', 'munition', 'consumable', 'misc')),
    quality_label text,
    unit          text NOT NULL DEFAULT 'units'::text,
    description   text,
    archived_at   timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One catalog row per (name, quality_label); NULL quality treated as '' .
CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouse_catalog_name_quality
    ON public.warehouse_catalog(name, COALESCE(quality_label, ''));

CREATE TABLE IF NOT EXISTS public.warehouse_stock (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    catalog_id  bigint NOT NULL REFERENCES public.warehouse_catalog(id) ON DELETE RESTRICT,
    location_id bigint NOT NULL REFERENCES public.quartermaster_locations(id) ON DELETE RESTRICT,
    notes       text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouse_stock_catalog_location
    ON public.warehouse_stock(catalog_id, location_id);

CREATE TABLE IF NOT EXISTS public.warehouse_requests (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_id             bigint NOT NULL REFERENCES public.warehouse_stock(id) ON DELETE RESTRICT,
    requested_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    requested_quantity   integer NOT NULL CHECK (requested_quantity > 0),
    reason_category      text NOT NULL CHECK (reason_category IN ('sale', 'craft', 'transport', 'other')),
    reason_notes         text,
    status               text NOT NULL DEFAULT 'pending'::text CHECK (status IN ('pending', 'approved', 'denied', 'fulfilled', 'cancelled')),
    approved_by_user_id  integer REFERENCES public.users(id) ON DELETE SET NULL,
    approved_at          timestamptz,
    fulfilled_movement_id uuid,   -- FK added after warehouse_movements exists
    fulfilled_at         timestamptz,
    denial_reason        text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.warehouse_movements (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_id            bigint NOT NULL REFERENCES public.warehouse_stock(id) ON DELETE RESTRICT,
    delta               integer NOT NULL CHECK (delta <> 0),
    reason              text NOT NULL CHECK (reason IN (
                            'initial', 'adjust', 'restock',
                            'withdraw_sale', 'withdraw_craft', 'withdraw_transport', 'withdraw_other',
                            'transfer_in', 'transfer_out', 'loss', 'destruction')),
    actor_user_id       integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    related_request_id  uuid REFERENCES public.warehouse_requests(id) ON DELETE SET NULL,
    related_movement_id uuid REFERENCES public.warehouse_movements(id) ON DELETE SET NULL,
    -- Marketplace sell/buy contract that drove this movement (auto stock decrement
    -- on contract delivery / compensating reversal on cancel). FK wired in the
    -- Marketplace section once marketplace_contracts exists (deferred, like the
    -- requests→movements FK below).
    related_contract_id uuid,
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now()
);

-- Wire the requests→movements FK now that warehouse_movements exists.
DO $$ BEGIN
    ALTER TABLE public.warehouse_requests
        ADD CONSTRAINT warehouse_requests_fulfilled_movement_id_fkey
        FOREIGN KEY (fulfilled_movement_id) REFERENCES public.warehouse_movements(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_warehouse_movements_stock ON public.warehouse_movements(stock_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_warehouse_movements_request ON public.warehouse_movements(related_request_id)
    WHERE related_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_warehouse_requests_status ON public.warehouse_requests(status);
CREATE INDEX IF NOT EXISTS idx_warehouse_stock_catalog ON public.warehouse_stock(catalog_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_stock_location ON public.warehouse_stock(location_id);

-- Convenience view: stock + computed on-hand / reserved quantities.
-- security_invoker=true so the view runs with the QUERYING role's privileges +
-- RLS (not the view owner's) — server reads bypass RLS via service_role; a direct
-- anon/authenticated query is gated by the underlying tables' deny-by-default RLS.
-- (Without this, Supabase flags a SECURITY DEFINER view — lint 0010.)
-- NOTE: this view is RE-CREATED (extended) in the Marketplace section so that
-- quantity_reserved ALSO reserves against accepted/in-progress marketplace sell
-- contracts. The definition here is the warehouse-only base; the marketplace
-- section's CREATE OR REPLACE supersedes it (it needs marketplace_contracts to
-- exist first). Keep the two column lists identical.
-- The on-hand / reserved SUM aggregates are cast to ::bigint (not ::integer) so a
-- pathological pile-up of movements/requests can't overflow a 32-bit accumulator
-- (integer-overflow DoS). NOTE: schema.sql is applied MANUALLY via the Supabase
-- SQL editor — re-run this view definition there for the cast to take effect.
CREATE OR REPLACE VIEW public.v_warehouse_stock_with_qty
WITH (security_invoker = true) AS
SELECT
    s.id,
    s.catalog_id,
    s.location_id,
    s.notes,
    s.created_at,
    s.updated_at,
    COALESCE((
        SELECT SUM(m.delta)::bigint FROM public.warehouse_movements m WHERE m.stock_id = s.id
    ), 0) AS quantity_on_hand,
    COALESCE((
        SELECT SUM(r.requested_quantity)::bigint FROM public.warehouse_requests r
         WHERE r.stock_id = s.id AND r.status IN ('pending', 'approved')
    ), 0) AS quantity_reserved
FROM public.warehouse_stock s;


-- ----- 3.x Marketplace (single-org internal trading) -------------------------
-- An internal, single-org marketplace: members post listings (items + services,
-- four directions sell/buy/offer/request), negotiate contracts through a
-- lifecycle, optionally reserve/move real warehouse stock, and rate each other.
-- DELIBERATELY single-org: NO organization_id, NO visibility tiers, NO *_org_id
-- columns — the cross-org/platform marketplace of the multi-tenant SaaS is gone.
-- Server-only tables (no realtime publication membership; deny-by-default RLS in
-- §6); realtime rides the gated 'marketplace:update' broadcast. Categories are
-- seeded by lib/db/seeder.ts (so a full-reset reseed restores them).

CREATE TABLE IF NOT EXISTS public.marketplace_categories (
    id           bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    slug         text NOT NULL UNIQUE,
    name         text NOT NULL,
    parent_id    bigint REFERENCES public.marketplace_categories(id) ON DELETE CASCADE,
    listing_kind text NOT NULL DEFAULT 'both' CHECK (listing_kind IN ('item', 'service', 'both')),
    icon         text,
    sort_order   integer NOT NULL DEFAULT 0,
    active       boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_categories_parent ON public.marketplace_categories(parent_id);

CREATE TABLE IF NOT EXISTS public.marketplace_listings (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id        integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    kind             text NOT NULL CHECK (kind IN ('item', 'service')),
    listing_type     text NOT NULL CHECK (listing_type IN ('sell', 'buy', 'offer', 'request')),
    category_id      bigint REFERENCES public.marketplace_categories(id) ON DELETE SET NULL,
    title            text NOT NULL,
    description      text,
    quantity         integer,
    quantity_claimed integer NOT NULL DEFAULT 0,
    price_uec        bigint,
    price_type       text NOT NULL DEFAULT 'fixed' CHECK (price_type IN ('fixed', 'negotiable', 'per_unit', 'hourly')),
    location         text,
    tags             text[] NOT NULL DEFAULT '{}'::text[],
    status           text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'paused', 'closed', 'expired')),
    expires_at       timestamptz,
    -- Optional link to a real warehouse stock row (sell ⇒ source, buy ⇒ destination).
    warehouse_stock_id bigint REFERENCES public.warehouse_stock(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    -- Set when a moderator closes the listing via a report takedown. While set,
    -- the seller cannot reopen (set status back to 'active') — undoing moderation.
    moderation_closed_at timestamptz,
    -- Items carry a positive quantity; services never do. Claimed never exceeds it.
    CONSTRAINT marketplace_listings_qty_kind CHECK (
        (kind = 'item' AND quantity IS NOT NULL AND quantity > 0)
        OR (kind = 'service' AND quantity IS NULL)),
    CONSTRAINT marketplace_listings_claimed_bounds CHECK (
        quantity_claimed >= 0 AND (quantity IS NULL OR quantity_claimed <= quantity))
);
-- Idempotent add for existing deployments re-running schema.sql.
ALTER TABLE public.marketplace_listings ADD COLUMN IF NOT EXISTS moderation_closed_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_browse ON public.marketplace_listings(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_seller ON public.marketplace_listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_category ON public.marketplace_listings(category_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_wh_stock ON public.marketplace_listings(warehouse_stock_id)
    WHERE warehouse_stock_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.marketplace_contracts (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- SET NULL (not CASCADE) so a deleted listing leaves the contract history intact.
    listing_id       uuid REFERENCES public.marketplace_listings(id) ON DELETE SET NULL,
    seller_id        integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    buyer_id         integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    kind             text NOT NULL CHECK (kind IN ('item', 'service')),
    title            text NOT NULL,                 -- snapshot of listing.title
    quantity         integer,                       -- snapshot; items only
    agreed_price_uec bigint,
    terms_note       varchar(250),
    status           text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'in_progress', 'delivered', 'completed', 'cancelled')),
    proposed_by_id   integer REFERENCES public.users(id) ON DELETE SET NULL,
    cancel_reason    text,
    -- Snapshot of the listing's warehouse link at accept time, so delivery/reversal
    -- target the right stock even if the listing is later edited/deleted.
    warehouse_stock_id bigint REFERENCES public.warehouse_stock(id) ON DELETE SET NULL,
    proposed_at      timestamptz NOT NULL DEFAULT now(),
    accepted_at      timestamptz,
    delivered_at     timestamptz,
    completed_at     timestamptz,
    cancelled_at     timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_contracts_listing ON public.marketplace_contracts(listing_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_contracts_seller ON public.marketplace_contracts(seller_id, status);
CREATE INDEX IF NOT EXISTS idx_marketplace_contracts_buyer ON public.marketplace_contracts(buyer_id, status);
-- Backs the warehouse reserve subquery (active sell contracts against a stock row).
CREATE INDEX IF NOT EXISTS idx_marketplace_contracts_wh_reserve ON public.marketplace_contracts(warehouse_stock_id, status)
    WHERE warehouse_stock_id IS NOT NULL;
-- One live contract per (listing, proposer) — defense-in-depth for the app-layer
-- dedup in proposeMarketplaceContract (anti contract-spam).
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_contract_live
    ON public.marketplace_contracts(listing_id, proposed_by_id)
    WHERE listing_id IS NOT NULL AND status IN ('proposed', 'accepted', 'delivered');

CREATE TABLE IF NOT EXISTS public.marketplace_contract_milestones (
    id              bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    contract_id     uuid NOT NULL REFERENCES public.marketplace_contracts(id) ON DELETE CASCADE,
    title           text NOT NULL,
    description     text,
    sort_order      integer NOT NULL DEFAULT 0,
    completed_at    timestamptz,
    completed_by_id integer REFERENCES public.users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_milestones_contract ON public.marketplace_contract_milestones(contract_id);

CREATE TABLE IF NOT EXISTS public.marketplace_ratings (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    contract_id uuid NOT NULL REFERENCES public.marketplace_contracts(id) ON DELETE CASCADE,
    rater_id    integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    ratee_id    integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    rater_role  text NOT NULL CHECK (rater_role IN ('buyer', 'seller')),
    stars       smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
    feedback    text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT marketplace_ratings_one_per_party UNIQUE (contract_id, rater_id)
);
CREATE INDEX IF NOT EXISTS idx_marketplace_ratings_ratee ON public.marketplace_ratings(ratee_id);

CREATE TABLE IF NOT EXISTS public.marketplace_reports (
    id              bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    listing_id      uuid REFERENCES public.marketplace_listings(id) ON DELETE CASCADE,
    contract_id     uuid REFERENCES public.marketplace_contracts(id) ON DELETE CASCADE,
    reporter_id     integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    reason_category text NOT NULL,
    details         text,
    status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'actioned', 'dismissed')),
    reviewed_at     timestamptz,
    reviewed_by_id  integer REFERENCES public.users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT marketplace_reports_target CHECK (listing_id IS NOT NULL OR contract_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_marketplace_reports_status ON public.marketplace_reports(status);

-- Wire the deferred warehouse_movements → marketplace_contracts FK now that the
-- table exists (mirrors the requests→movements deferral above). Add the column
-- separately: on an existing DB the CREATE TABLE above is a no-op, so the column
-- must be added here before the FK + index can reference it.
ALTER TABLE public.warehouse_movements ADD COLUMN IF NOT EXISTS related_contract_id uuid;
DO $$ BEGIN
    ALTER TABLE public.warehouse_movements
        ADD CONSTRAINT warehouse_movements_related_contract_id_fkey
        FOREIGN KEY (related_contract_id) REFERENCES public.marketplace_contracts(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_warehouse_movements_contract ON public.warehouse_movements(related_contract_id)
    WHERE related_contract_id IS NOT NULL;

-- Re-create the stock-quantity view to ALSO reserve against accepted/in-progress
-- marketplace SELL contracts (a member selling from real stock holds it until the
-- contract completes/cancels). Column list identical to the warehouse-section base.
-- SUM aggregates are cast to ::bigint to avoid a 32-bit integer-overflow DoS (see
-- the base definition above). NOTE: schema.sql is applied MANUALLY via the Supabase
-- SQL editor — re-run this definition there for the cast to take effect.
CREATE OR REPLACE VIEW public.v_warehouse_stock_with_qty
WITH (security_invoker = true) AS
SELECT
    s.id,
    s.catalog_id,
    s.location_id,
    s.notes,
    s.created_at,
    s.updated_at,
    COALESCE((
        SELECT SUM(m.delta)::bigint FROM public.warehouse_movements m WHERE m.stock_id = s.id
    ), 0) AS quantity_on_hand,
    COALESCE((
        SELECT SUM(r.requested_quantity)::bigint FROM public.warehouse_requests r
         WHERE r.stock_id = s.id AND r.status IN ('pending', 'approved')
    ), 0)
    + COALESCE((
        SELECT SUM(c.quantity)::bigint
          FROM public.marketplace_contracts c
          JOIN public.marketplace_listings l ON l.id = c.listing_id
         WHERE c.warehouse_stock_id = s.id
           AND c.status IN ('accepted', 'in_progress')
           AND l.listing_type = 'sell'
           AND c.quantity IS NOT NULL
    ), 0) AS quantity_reserved
FROM public.warehouse_stock s;


-- Unified position-history view (HR + Government), read by getUserPositionHistory
-- (lib/db/users.ts) via the gated user:get_position_history RPC. security_invoker
-- so it respects the underlying tables' deny-by-default RLS — only the
-- service-role server (which bypasses RLS) returns rows; a direct anon/
-- authenticated SELECT gets nothing. `kind` disambiguates the two sources
-- (the bigint ids may collide across them).
CREATE OR REPLACE VIEW public.user_position_history_unified
    WITH (security_invoker = true) AS
    SELECT 'hr'::text AS kind, h.id, h.user_id, h.position_id,
           p.name AS position_name, p.description AS position_description, p.icon AS position_icon,
           h.started_at, h.ended_at, h.end_reason
      FROM public.user_hr_position_history h
      JOIN public.personnel_positions p ON p.id = h.position_id
    UNION ALL
    SELECT 'government'::text AS kind, gph.id, gph.user_id, gph.position_id,
           gp.name AS position_name, gp.description AS position_description, gp.icon AS position_icon,
           gph.started_at, gph.ended_at, gph.end_reason
      FROM public.government_position_holders gph
      JOIN public.government_positions gp ON gp.id = gph.position_id;


-- =============================================================================
-- SECTION 4 — Functions / RPCs (org params + org predicates removed)
-- =============================================================================

-- ----- 4.1 Cron lock leases (global infra; unchanged) ------------------------

CREATE OR REPLACE FUNCTION public.try_acquire_cron_lock(
    p_job_name text, p_worker_id text, p_hold_seconds integer
) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    INSERT INTO public.cron_locks AS cl (job_name, locked_until, locked_at, worker_id, updated_at)
    VALUES (p_job_name, now() + make_interval(secs => p_hold_seconds), now(), p_worker_id, now())
    ON CONFLICT (job_name) DO UPDATE
        SET locked_until = now() + make_interval(secs => p_hold_seconds),
            locked_at = now(), worker_id = p_worker_id, updated_at = now()
        WHERE cl.locked_until < now()
    RETURNING (cl.worker_id = p_worker_id);
$$;

CREATE OR REPLACE FUNCTION public.release_cron_lock(
    p_job_name text, p_worker_id text
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    UPDATE public.cron_locks
       SET locked_until = now(), updated_at = now()
     WHERE job_name = p_job_name AND worker_id = p_worker_id;
$$;

-- ----- 4.1b Admin "full reset / full wipe" data truncation -------------------
-- DANGER: truncates EVERY org-data table in one pass. Backs the Database Tools
-- "Full reset (keep one admin)" and "Full wipe" actions. The server gates both
-- behind the genuine Admin role + the admin:db:destroy permission + a
-- server-validated typed confirmation phrase; this function is service_role-only
-- (SECTION 5's default REVOKE strips EXECUTE from anon/authenticated, and the
-- only caller is the service-role server). TRUNCATE without RESTART IDENTITY so
-- sequences are preserved — a retained admin keeps its user id, so its session
-- JWT stays valid after a reset.
--
-- PRESERVED, by design:
--   * permissions      — the CODE-OWNED permission catalog (seeded by SECTION 7,
--                        not by the runtime seeder, which only READS it to grant
--                        the Admin role). Truncating it would leave the re-seed
--                        with zero permissions.
--   * cron_locks       — the multi-instance lease table; avoid disrupting a
--                        concurrently-running cron tick.
-- Note: auth.users lives in the `auth` schema, so Discord/Supabase identities
-- are untouched — a retained admin can still sign in.
CREATE OR REPLACE FUNCTION public.admin_truncate_all_data()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE t text;
BEGIN
    FOR t IN
        SELECT tablename FROM pg_tables
         WHERE schemaname = 'public'
           AND tablename NOT IN ('permissions', 'cron_locks')
    LOOP
        EXECUTE format('TRUNCATE TABLE public.%I CASCADE', t);
    END LOOP;
END;
$$;


-- ----- 4.2 Operations UEC / cost accumulators (key off id; unchanged) --------

CREATE OR REPLACE FUNCTION public.add_uec_to_operation(op_id uuid, amount_to_add bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.operations
       SET total_uec = total_uec + amount_to_add, updated_at = now()
     WHERE id = op_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.add_cost_to_operation(op_id uuid, amount_to_add bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.operations
       SET total_costs = COALESCE(total_costs, 0) + amount_to_add
     WHERE id = op_id;
END;
$$;

-- ----- 4.2b op_join_participant: atomic capacity-check + upsert (race-1) -------
-- Serialises concurrent joins on the operation row (FOR UPDATE) so a check-then-
-- insert TOCTOU can't overshoot max_participants. The capacity check skips users
-- who are already participants (a re-join is an update, not new growth). Raises
-- 'operation_full' on capacity, which the caller maps to a friendly message.
CREATE OR REPLACE FUNCTION public.op_join_participant(
    p_operation_id uuid, p_user_id integer, p_role_requested text,
    p_ship_utilized text, p_ship_id integer, p_user_ship_id integer
) RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
    v_max    integer;
    v_count  integer;
    v_exists boolean;
BEGIN
    SELECT max_participants INTO v_max FROM public.operations WHERE id = p_operation_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'operation_not_found'; END IF;

    SELECT EXISTS(SELECT 1 FROM public.operation_participants
                  WHERE operation_id = p_operation_id AND user_id = p_user_id) INTO v_exists;

    IF v_max IS NOT NULL AND NOT v_exists THEN
        SELECT count(*) INTO v_count FROM public.operation_participants WHERE operation_id = p_operation_id;
        IF v_count >= v_max THEN RAISE EXCEPTION 'operation_full'; END IF;
    END IF;

    INSERT INTO public.operation_participants
        (operation_id, user_id, role_requested, ship_utilized, ship_id, user_ship_id, attendance_status, is_ready)
    VALUES (p_operation_id, p_user_id, p_role_requested, p_ship_utilized, p_ship_id, p_user_ship_id, 'Registered', false)
    ON CONFLICT (operation_id, user_id) DO UPDATE SET
        role_requested    = EXCLUDED.role_requested,
        ship_utilized     = EXCLUDED.ship_utilized,
        ship_id           = EXCLUDED.ship_id,
        user_ship_id      = EXCLUDED.user_ship_id,
        attendance_status = 'Registered',
        is_ready          = false;
END;
$$;

-- ----- 4.2c gov_appoint_holder: atomic max_holders check + insert (race-2) -----
-- Serialises concurrent appointments on the position row (FOR UPDATE) so a
-- check-then-insert TOCTOU can't covertly over-seat a uniquely-powered office.
CREATE OR REPLACE FUNCTION public.gov_appoint_holder(
    p_position_id bigint, p_user_id integer, p_appointed_by_id integer, p_election_id bigint
) RETURNS bigint LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
    v_max       integer;
    v_count     integer;
    v_holder_id bigint;
BEGIN
    SELECT max_holders INTO v_max FROM public.government_positions WHERE id = p_position_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'position_not_found'; END IF;

    IF EXISTS(SELECT 1 FROM public.government_position_holders
              WHERE position_id = p_position_id AND user_id = p_user_id AND ended_at IS NULL) THEN
        RAISE EXCEPTION 'already_holds';
    END IF;

    SELECT count(*) INTO v_count FROM public.government_position_holders
        WHERE position_id = p_position_id AND ended_at IS NULL;
    IF v_count >= v_max THEN RAISE EXCEPTION 'position_full'; END IF;

    INSERT INTO public.government_position_holders (position_id, user_id, appointed_by_id, election_id)
    VALUES (p_position_id, p_user_id, p_appointed_by_id, p_election_id)
    RETURNING id INTO v_holder_id;
    RETURN v_holder_id;
END;
$$;


-- ----- 4.3 admin_adjust_reputation (DE-ORG'd: no users.organization_id read,
--           no reputation_history.organization_id write) -----------------------

CREATE OR REPLACE FUNCTION public.admin_adjust_reputation(
    user_id_in integer, new_reputation_in integer, admin_id_in integer, reason_in text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_old_reputation integer;
BEGIN
    SELECT reputation INTO v_old_reputation FROM public.users WHERE id = user_id_in;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User not found';
    END IF;

    UPDATE public.users SET reputation = new_reputation_in WHERE id = user_id_in;

    INSERT INTO public.reputation_history (
        user_id, admin_user_id, old_reputation, new_reputation, reason
    ) VALUES (
        user_id_in, admin_id_in, v_old_reputation, new_reputation_in, reason_in
    );
END;
$$;


-- ----- 4.4 Finance functions (key off entry/account id; unchanged bodies) ----

CREATE OR REPLACE FUNCTION public.finance_approve_entry(p_entry_id uuid, p_approver_id integer)
RETURNS integer LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
    v_account_id bigint;
    v_amount     bigint;
    v_rows       integer;
BEGIN
    SELECT account_id INTO v_account_id FROM public.treasury_ledger_entries WHERE id = p_entry_id;
    IF v_account_id IS NULL THEN RETURN 0; END IF;

    PERFORM 1 FROM public.treasury_accounts WHERE id = v_account_id FOR UPDATE;

    UPDATE public.treasury_ledger_entries
       SET status = 'confirmed', approved_by_user_id = p_approver_id,
           approved_at = now(), updated_at = now()
     WHERE id = p_entry_id AND status = 'pending'
     RETURNING amount INTO v_amount;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN RETURN 0; END IF;

    UPDATE public.treasury_accounts
       SET balance_cached = balance_cached + v_amount, updated_at = now()
     WHERE id = v_account_id;
    RETURN 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.finance_reject_entry(p_entry_id uuid, p_approver_id integer, p_reason text)
RETURNS integer LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
    v_rows integer;
BEGIN
    UPDATE public.treasury_ledger_entries
       SET status = 'rejected', approved_by_user_id = p_approver_id, approved_at = now(),
           notes = COALESCE(notes, '') ||
                   CASE WHEN p_reason IS NOT NULL AND p_reason <> ''
                        THEN E'\n[rejected] ' || p_reason ELSE '' END,
           updated_at = now()
     WHERE id = p_entry_id AND status = 'pending';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows;
END;
$$;

CREATE OR REPLACE FUNCTION public.finance_reverse_entry(p_entry_id uuid, p_actor_id integer, p_reason text)
RETURNS uuid LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
    v_orig   public.treasury_ledger_entries;
    v_new_id uuid;
    v_rows   integer;
BEGIN
    SELECT * INTO v_orig FROM public.treasury_ledger_entries WHERE id = p_entry_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Entry % not found', p_entry_id; END IF;
    IF v_orig.status <> 'confirmed' THEN
        RAISE EXCEPTION 'Only confirmed entries may be reversed (status=%)', v_orig.status;
    END IF;

    PERFORM 1 FROM public.treasury_accounts WHERE id = v_orig.account_id FOR UPDATE;

    UPDATE public.treasury_ledger_entries SET status = 'reversed', updated_at = now()
     WHERE id = p_entry_id AND status = 'confirmed';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN RAISE EXCEPTION 'Entry % was no longer in confirmed state', p_entry_id; END IF;

    INSERT INTO public.treasury_ledger_entries (
        account_id, entry_type, amount, status, memo,
        counterparty_user_id, counterparty_text, operation_id, related_inventory_id,
        related_entry_id, created_by_user_id, approved_by_user_id, approved_at, notes
    ) VALUES (
        v_orig.account_id, 'adjustment', -v_orig.amount, 'confirmed', v_orig.memo,
        v_orig.counterparty_user_id, v_orig.counterparty_text, v_orig.operation_id,
        v_orig.related_inventory_id, p_entry_id, p_actor_id, p_actor_id, now(),
        CASE WHEN p_reason IS NOT NULL AND p_reason <> ''
             THEN '[reversal] ' || p_reason ELSE '[reversal]' END
    ) RETURNING id INTO v_new_id;

    UPDATE public.treasury_accounts
       SET balance_cached = balance_cached - v_orig.amount, updated_at = now()
     WHERE id = v_orig.account_id;
    RETURN v_new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.finance_reconcile_balances()
RETURNS TABLE (account_id bigint, cached bigint, computed bigint, delta bigint)
LANGUAGE sql SET search_path = public, pg_temp
AS $$
    SELECT a.id, a.balance_cached,
           COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'confirmed'), 0),
           a.balance_cached - COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'confirmed'), 0)
    FROM public.treasury_accounts a
    LEFT JOIN public.treasury_ledger_entries e ON e.account_id = a.id
    GROUP BY a.id, a.balance_cached
    HAVING a.balance_cached <> COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'confirmed'), 0);
$$;


-- ----- 4.5 Quartermaster functions (DE-ORG'd: no organization_id reads/writes) -

CREATE OR REPLACE FUNCTION public.qm_fulfil_issuance(p_issuance_id bigint, p_actor_id integer)
RETURNS integer LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
    v_inv_id  bigint;
    v_qty     integer;
    v_rows    integer;
    v_current integer;
BEGIN
    SELECT inventory_id, quantity INTO v_inv_id, v_qty
      FROM public.quartermaster_issuances WHERE id = p_issuance_id;
    IF v_inv_id IS NULL THEN RETURN 0; END IF;

    PERFORM 1 FROM public.quartermaster_inventory WHERE id = v_inv_id FOR UPDATE;

    -- Over-issue backstop: never let the negative 'issue' movement drive computed
    -- on-hand (SUM of movement deltas) below zero. Mirrors warehouse_fulfil_request.
    -- NOTE: schema.sql is applied MANUALLY via the Supabase SQL editor, so this is
    -- the authoritative DB-level guard once applied; lib/db/quartermaster.ts carries
    -- the in-code pre-check (assertSufficientOnHand) that guards the same condition
    -- in the application layer. Checked under the FOR UPDATE row lock so concurrent
    -- fulfils serialize.
    SELECT COALESCE(SUM(delta), 0) INTO v_current
      FROM public.quartermaster_inventory_movements WHERE inventory_id = v_inv_id;
    IF v_current < v_qty THEN
        RAISE EXCEPTION 'QM_INSUFFICIENT_STOCK: have %, need %', v_current, v_qty;
    END IF;

    UPDATE public.quartermaster_issuances
       SET status = 'active', issued_by_user_id = p_actor_id, issued_at = now(), updated_at = now()
     WHERE id = p_issuance_id AND status = 'requested';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN RETURN 0; END IF;

    INSERT INTO public.quartermaster_inventory_movements
        (inventory_id, delta, reason, actor_user_id, related_issuance_id)
    VALUES (v_inv_id, -v_qty, 'issue', p_actor_id, p_issuance_id);
    RETURN 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.qm_issue_direct(
    p_inventory_id bigint, p_issued_to integer, p_quantity integer,
    p_due_back_at timestamptz, p_actor_id integer, p_notes text, p_operation_id bigint
) RETURNS bigint LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
    v_exists      bigint;
    v_issuance_id bigint;
    v_current     integer;
BEGIN
    IF p_quantity IS NULL OR p_quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity must be positive';
    END IF;

    SELECT id INTO v_exists FROM public.quartermaster_inventory WHERE id = p_inventory_id FOR UPDATE;
    IF v_exists IS NULL THEN RAISE EXCEPTION 'Inventory % not found', p_inventory_id; END IF;

    -- Over-issue backstop: never let the negative 'issue' movement drive computed
    -- on-hand (SUM of movement deltas) below zero. Mirrors warehouse_adjust_stock.
    -- NOTE: schema.sql is applied MANUALLY via the Supabase SQL editor, so this is
    -- the authoritative DB-level guard once applied; lib/db/quartermaster.ts carries
    -- the in-code pre-check until then. The row is locked FOR UPDATE above, so the
    -- bulk path's repeated calls for the SAME inventory row serialize and the
    -- already-posted negative movement is visible to the next line's SUM.
    SELECT COALESCE(SUM(delta), 0) INTO v_current
      FROM public.quartermaster_inventory_movements WHERE inventory_id = p_inventory_id;
    IF v_current < p_quantity THEN
        RAISE EXCEPTION 'QM_INSUFFICIENT_STOCK: have %, need %', v_current, p_quantity;
    END IF;

    INSERT INTO public.quartermaster_issuances
        (inventory_id, issued_to_user_id, quantity, status,
         requested_at, issued_at, due_back_at, issued_by_user_id, notes, operation_id)
    VALUES (p_inventory_id, p_issued_to, p_quantity, 'active',
            now(), now(), p_due_back_at, p_actor_id, p_notes, p_operation_id)
    RETURNING id INTO v_issuance_id;

    INSERT INTO public.quartermaster_inventory_movements
        (inventory_id, delta, reason, actor_user_id, related_issuance_id)
    VALUES (p_inventory_id, -p_quantity, 'issue', p_actor_id, v_issuance_id);
    RETURN v_issuance_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.qm_return_issuance(
    p_issuance_id bigint, p_returned_qty integer, p_outcome text, p_actor_id integer, p_notes text
) RETURNS integer LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
    v_inv_id bigint;
    v_qty    integer;
    v_rows   integer;
BEGIN
    IF p_outcome NOT IN ('returned_on_time', 'returned_late', 'returned_damaged') THEN
        RAISE EXCEPTION 'Invalid return outcome: %', p_outcome;
    END IF;

    SELECT inventory_id, quantity INTO v_inv_id, v_qty
      FROM public.quartermaster_issuances WHERE id = p_issuance_id;
    IF v_inv_id IS NULL THEN RETURN 0; END IF;

    IF p_returned_qty IS NULL OR p_returned_qty < 0 OR p_returned_qty > v_qty THEN
        RAISE EXCEPTION 'Returned quantity % is outside issued range [0, %]', p_returned_qty, v_qty;
    END IF;

    PERFORM 1 FROM public.quartermaster_inventory WHERE id = v_inv_id FOR UPDATE;

    UPDATE public.quartermaster_issuances
       SET status = 'returned', returned_at = now(), returned_quantity = p_returned_qty,
           outcome = p_outcome, closed_by_user_id = p_actor_id,
           notes = CASE WHEN p_notes IS NOT NULL AND p_notes <> ''
                        THEN COALESCE(notes, '') ||
                             CASE WHEN notes IS NOT NULL AND notes <> '' THEN E'\n' ELSE '' END ||
                             '[return] ' || p_notes
                        ELSE notes END,
           updated_at = now()
     WHERE id = p_issuance_id AND status = 'active';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN RETURN 0; END IF;

    IF p_returned_qty > 0 THEN
        INSERT INTO public.quartermaster_inventory_movements
            (inventory_id, delta, reason, actor_user_id, related_issuance_id)
        VALUES (v_inv_id, p_returned_qty, 'return', p_actor_id, p_issuance_id);
    END IF;
    RETURN 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.qm_write_off_issuance(
    p_issuance_id bigint, p_outcome text, p_actor_id integer, p_notes text
) RETURNS integer LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
    v_rows integer;
BEGIN
    IF p_outcome NOT IN ('lost', 'destroyed_in_action') THEN
        RAISE EXCEPTION 'Invalid write-off outcome: %', p_outcome;
    END IF;

    UPDATE public.quartermaster_issuances
       SET status = 'written_off', returned_at = now(), returned_quantity = 0,
           outcome = p_outcome, closed_by_user_id = p_actor_id,
           notes = CASE WHEN p_notes IS NOT NULL AND p_notes <> ''
                        THEN COALESCE(notes, '') ||
                             CASE WHEN notes IS NOT NULL AND notes <> '' THEN E'\n' ELSE '' END ||
                             '[write-off] ' || p_notes
                        ELSE notes END,
           updated_at = now()
     WHERE id = p_issuance_id AND status = 'active';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows;
END;
$$;

CREATE OR REPLACE FUNCTION public.qm_adjust_inventory(
    p_inventory_id bigint, p_delta integer, p_reason text, p_actor_id integer, p_notes text
) RETURNS uuid LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
    v_exists bigint;
    v_new_id uuid;
BEGIN
    IF p_delta = 0 THEN RAISE EXCEPTION 'Delta cannot be zero'; END IF;
    IF p_reason NOT IN ('initial', 'adjust', 'loss', 'destruction') THEN
        RAISE EXCEPTION 'Invalid adjustment reason: %', p_reason;
    END IF;

    SELECT id INTO v_exists FROM public.quartermaster_inventory WHERE id = p_inventory_id FOR UPDATE;
    IF v_exists IS NULL THEN RAISE EXCEPTION 'Inventory % not found', p_inventory_id; END IF;

    INSERT INTO public.quartermaster_inventory_movements
        (inventory_id, delta, reason, actor_user_id, notes)
    VALUES (p_inventory_id, p_delta, p_reason, p_actor_id, p_notes)
    RETURNING id INTO v_new_id;
    RETURN v_new_id;
END;
$$;

-- Bulk variants delegate to the single-item functions (no org references).
-- Over-issue safety: each per-line qm_issue_direct call re-checks on-hand WITHIN
-- this transaction (its prior negative movement is already visible under the
-- FOR UPDATE row lock), so cumulative over-issue across lines for the same
-- inventory row raises QM_INSUFFICIENT_STOCK and rolls back the WHOLE batch.
-- schema.sql is applied MANUALLY via the Supabase SQL editor (authoritative
-- backstop once applied); lib/db/quartermaster.ts carries the in-code pre-check.
CREATE OR REPLACE FUNCTION public.qm_issue_bulk(
    p_issued_to integer, p_due_back_at timestamptz, p_actor_id integer,
    p_notes text, p_operation_id bigint, p_lines jsonb
) RETURNS bigint[] LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
    v_line jsonb; v_inventory_id bigint; v_quantity integer;
    v_issuance_id bigint; v_ids bigint[] := ARRAY[]::bigint[];
BEGIN
    IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
        RAISE EXCEPTION 'Lines must be a non-empty JSON array';
    END IF;
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
        v_inventory_id := NULLIF(v_line->>'inventory_id', '')::bigint;
        v_quantity     := NULLIF(v_line->>'quantity', '')::integer;
        IF v_inventory_id IS NULL THEN RAISE EXCEPTION 'Each line needs inventory_id'; END IF;
        IF v_quantity    IS NULL THEN RAISE EXCEPTION 'Each line needs quantity'; END IF;
        v_issuance_id := public.qm_issue_direct(
            v_inventory_id, p_issued_to, v_quantity, p_due_back_at, p_actor_id, p_notes, p_operation_id);
        v_ids := array_append(v_ids, v_issuance_id);
    END LOOP;
    RETURN v_ids;
END;
$$;

CREATE OR REPLACE FUNCTION public.qm_return_bulk(p_actor_id integer, p_notes text, p_lines jsonb)
RETURNS integer LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
    v_line jsonb; v_iss_id bigint; v_qty integer; v_outcome text;
    v_count integer := 0; v_result integer;
BEGIN
    IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
        RAISE EXCEPTION 'Lines must be a non-empty JSON array';
    END IF;
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
        v_iss_id  := NULLIF(v_line->>'issuance_id', '')::bigint;
        v_qty     := NULLIF(v_line->>'returned_quantity', '')::integer;
        v_outcome := v_line->>'outcome';
        IF v_iss_id  IS NULL THEN RAISE EXCEPTION 'Each line needs issuance_id'; END IF;
        IF v_qty     IS NULL THEN RAISE EXCEPTION 'Each line needs returned_quantity'; END IF;
        IF v_outcome IS NULL OR v_outcome = '' THEN RAISE EXCEPTION 'Each line needs outcome'; END IF;
        v_result := public.qm_return_issuance(v_iss_id, v_qty, v_outcome, p_actor_id, p_notes);
        v_count := v_count + v_result;
    END LOOP;
    RETURN v_count;
END;
$$;

-- qm_overview_stats (DE-ORG'd: no p_org_id param, no org predicates).
CREATE OR REPLACE FUNCTION public.qm_overview_stats()
RETURNS TABLE (
    total_items bigint, items_on_issue bigint, distinct_skus bigint,
    pending_requests bigint, overdue_count bigint
) LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
BEGIN
    RETURN QUERY
    SELECT
        COALESCE((
            SELECT SUM(m.delta)::bigint
            FROM public.quartermaster_inventory_movements m
            JOIN public.quartermaster_inventory i ON i.id = m.inventory_id
            WHERE i.is_archived = false
        ), 0) AS total_items,
        COALESCE((
            SELECT SUM(quantity)::bigint FROM public.quartermaster_issuances WHERE status = 'active'
        ), 0) AS items_on_issue,
        (SELECT COUNT(*)::bigint FROM public.quartermaster_inventory WHERE is_archived = false) AS distinct_skus,
        (SELECT COUNT(*)::bigint FROM public.quartermaster_issuances WHERE status = 'requested') AS pending_requests,
        (SELECT COUNT(*)::bigint FROM public.quartermaster_issuances
          WHERE status = 'active' AND due_back_at IS NOT NULL AND due_back_at < now()) AS overdue_count;
END;
$$;


-- ----- 4.6 Warehouse functions (DE-ORG'd: no organization_id reads/writes) ----

CREATE OR REPLACE FUNCTION public.warehouse_adjust_stock(
    p_stock_id bigint, p_delta integer, p_reason text, p_actor_id integer, p_notes text
) RETURNS uuid LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
    v_exists  bigint;
    v_current integer;
    v_new_id  uuid;
BEGIN
    IF p_delta = 0 THEN RAISE EXCEPTION 'Delta cannot be zero'; END IF;
    IF p_reason NOT IN ('initial', 'adjust', 'restock', 'loss', 'destruction') THEN
        RAISE EXCEPTION 'Invalid adjustment reason: %', p_reason;
    END IF;

    SELECT id INTO v_exists FROM public.warehouse_stock WHERE id = p_stock_id FOR UPDATE;
    IF v_exists IS NULL THEN RAISE EXCEPTION 'Warehouse stock % not found', p_stock_id; END IF;

    SELECT COALESCE(SUM(delta), 0) INTO v_current
      FROM public.warehouse_movements WHERE stock_id = p_stock_id;
    IF v_current + p_delta < 0 THEN
        RAISE EXCEPTION 'WAREHOUSE_INSUFFICIENT_STOCK: current %, delta %', v_current, p_delta;
    END IF;

    INSERT INTO public.warehouse_movements (stock_id, delta, reason, actor_user_id, notes)
    VALUES (p_stock_id, p_delta, p_reason, p_actor_id, p_notes)
    RETURNING id INTO v_new_id;

    UPDATE public.warehouse_stock SET updated_at = now() WHERE id = p_stock_id;
    RETURN v_new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.warehouse_fulfil_request(p_request_id uuid, p_actor_id integer)
RETURNS uuid LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
    v_stock_id    bigint;
    v_qty         integer;
    v_category    text;
    v_status      text;
    v_current     integer;
    v_movement_id uuid;
BEGIN
    SELECT stock_id, requested_quantity, reason_category, status
      INTO v_stock_id, v_qty, v_category, v_status
      FROM public.warehouse_requests WHERE id = p_request_id;
    IF v_stock_id IS NULL THEN RAISE EXCEPTION 'Request % not found', p_request_id; END IF;
    IF v_status NOT IN ('pending', 'approved') THEN
        RAISE EXCEPTION 'Request % is not fulfilable (status=%)', p_request_id, v_status;
    END IF;

    PERFORM 1 FROM public.warehouse_stock WHERE id = v_stock_id FOR UPDATE;

    SELECT COALESCE(SUM(delta), 0) INTO v_current
      FROM public.warehouse_movements WHERE stock_id = v_stock_id;
    IF v_current < v_qty THEN
        RAISE EXCEPTION 'WAREHOUSE_INSUFFICIENT_STOCK: have %, need %', v_current, v_qty;
    END IF;

    INSERT INTO public.warehouse_movements
        (stock_id, delta, reason, actor_user_id, related_request_id, notes)
    VALUES (v_stock_id, -v_qty, 'withdraw_' || v_category, p_actor_id, p_request_id,
            'Fulfilled request ' || p_request_id::text)
    RETURNING id INTO v_movement_id;

    UPDATE public.warehouse_requests
       SET status = 'fulfilled', fulfilled_movement_id = v_movement_id, fulfilled_at = now(),
           approved_by_user_id = COALESCE(approved_by_user_id, p_actor_id),
           approved_at = COALESCE(approved_at, now()), updated_at = now()
     WHERE id = p_request_id;

    UPDATE public.warehouse_stock SET updated_at = now() WHERE id = v_stock_id;
    RETURN v_movement_id;
END;
$$;

-- Marketplace fulfilment: post the warehouse movement for a delivered sell/buy
-- contract. Idempotent + row-locked, same pattern as warehouse_fulfil_request:
-- returns the EXISTING movement id on retry so a double-submit/replay can't
-- double-move stock. sell ⇒ withdraw from the seller's stock (delta<0); buy ⇒
-- restock the buyer's stock (delta>0). No-op return for service contracts or
-- contracts with no warehouse link.
CREATE OR REPLACE FUNCTION public.warehouse_marketplace_deliver(p_contract_id uuid, p_actor_id integer)
RETURNS uuid LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
    v_stock_id    bigint;
    v_qty         integer;
    v_listing_type text;
    v_existing    uuid;
    v_current     integer;
    v_movement_id uuid;
BEGIN
    SELECT c.warehouse_stock_id, c.quantity, l.listing_type
      INTO v_stock_id, v_qty, v_listing_type
      FROM public.marketplace_contracts c
      JOIN public.marketplace_listings l ON l.id = c.listing_id
     WHERE c.id = p_contract_id;
    IF v_stock_id IS NULL OR v_qty IS NULL THEN
        RETURN NULL;  -- service contract or no warehouse link — nothing to move
    END IF;

    -- Idempotency: a prior delivery for this contract already posted a movement.
    SELECT id INTO v_existing FROM public.warehouse_movements
     WHERE related_contract_id = p_contract_id
       AND reason IN ('withdraw_sale', 'restock')
       AND related_movement_id IS NULL  -- exclude reversals
     LIMIT 1;
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

    PERFORM 1 FROM public.warehouse_stock WHERE id = v_stock_id FOR UPDATE;

    IF v_listing_type = 'sell' THEN
        SELECT COALESCE(SUM(delta), 0) INTO v_current
          FROM public.warehouse_movements WHERE stock_id = v_stock_id;
        IF v_current < v_qty THEN
            RAISE EXCEPTION 'WAREHOUSE_INSUFFICIENT_STOCK: have %, need %', v_current, v_qty;
        END IF;
        INSERT INTO public.warehouse_movements
            (stock_id, delta, reason, actor_user_id, related_contract_id, notes)
        VALUES (v_stock_id, -v_qty, 'withdraw_sale', p_actor_id, p_contract_id,
                'Marketplace sale ' || p_contract_id::text)
        RETURNING id INTO v_movement_id;
    ELSE
        INSERT INTO public.warehouse_movements
            (stock_id, delta, reason, actor_user_id, related_contract_id, notes)
        VALUES (v_stock_id, v_qty, 'restock', p_actor_id, p_contract_id,
                'Marketplace purchase ' || p_contract_id::text)
        RETURNING id INTO v_movement_id;
    END IF;

    UPDATE public.warehouse_stock SET updated_at = now() WHERE id = v_stock_id;
    RETURN v_movement_id;
END;
$$;

-- Marketplace reversal: compensating movement when a DELIVERED contract is later
-- cancelled. Idempotent (returns existing reversal) + chained via
-- related_movement_id to the original delivery movement.
CREATE OR REPLACE FUNCTION public.warehouse_marketplace_reverse(p_contract_id uuid, p_actor_id integer, p_reason text)
RETURNS uuid LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
    v_orig     uuid;
    v_stock_id bigint;
    v_delta    integer;
    v_existing uuid;
    v_rev_id   uuid;
BEGIN
    -- The original delivery movement for this contract.
    SELECT id, stock_id, delta INTO v_orig, v_stock_id, v_delta
      FROM public.warehouse_movements
     WHERE related_contract_id = p_contract_id
       AND reason IN ('withdraw_sale', 'restock')
       AND related_movement_id IS NULL
     LIMIT 1;
    IF v_orig IS NULL THEN RETURN NULL; END IF;  -- nothing was delivered

    -- Idempotency: reversal already posted.
    SELECT id INTO v_existing FROM public.warehouse_movements
     WHERE related_movement_id = v_orig LIMIT 1;
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

    PERFORM 1 FROM public.warehouse_stock WHERE id = v_stock_id FOR UPDATE;
    INSERT INTO public.warehouse_movements
        (stock_id, delta, reason, actor_user_id, related_contract_id, related_movement_id, notes)
    VALUES (v_stock_id, -v_delta, 'adjust', p_actor_id, p_contract_id, v_orig,
            COALESCE(p_reason, 'Marketplace contract reversal'))
    RETURNING id INTO v_rev_id;

    UPDATE public.warehouse_stock SET updated_at = now() WHERE id = v_stock_id;
    RETURN v_rev_id;
END;
$$;

-- Marketplace accept: the ENTIRE accept transition done atomically in one
-- transaction (PostgREST has none), closing the read-modify-write races a
-- two-statement accept would otherwise hit. Locks the contract FOR UPDATE,
-- re-checks the caller is the non-proposer party AND the contract is still
-- 'proposed' (so a double-accept of the SAME contract finds it already accepted
-- and does NOT reserve twice), snapshots the sell listing's warehouse link,
-- reserves the listing only if it stays within quantity (auto-closing when
-- fully claimed), then flips the contract to accepted. Returns:
--   'ok' | 'forbidden' (not the non-proposer) | 'bad_state' (not proposed) |
--   'full' (would over-claim the listing).
CREATE OR REPLACE FUNCTION public.marketplace_accept_contract(p_contract_id uuid, p_actor_id integer)
RETURNS text LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
    v_status text; v_seller integer; v_buyer integer; v_proposer integer;
    v_kind text; v_qty integer; v_listing uuid; v_ltype text; v_wh bigint;
    v_nonproposer integer; v_reserved boolean;
BEGIN
    SELECT status, seller_id, buyer_id, proposed_by_id, kind, quantity, listing_id
      INTO v_status, v_seller, v_buyer, v_proposer, v_kind, v_qty, v_listing
      FROM public.marketplace_contracts WHERE id = p_contract_id FOR UPDATE;
    IF v_status IS NULL THEN RETURN 'forbidden'; END IF;
    v_nonproposer := CASE WHEN v_proposer = v_seller THEN v_buyer ELSE v_seller END;
    IF p_actor_id <> v_nonproposer THEN RETURN 'forbidden'; END IF;
    IF v_status <> 'proposed' THEN RETURN 'bad_state'; END IF;

    IF v_kind = 'item' AND v_listing IS NOT NULL THEN
        SELECT listing_type, warehouse_stock_id INTO v_ltype, v_wh
          FROM public.marketplace_listings WHERE id = v_listing;
        IF v_ltype IS DISTINCT FROM 'sell' THEN v_wh := NULL; END IF;
        IF v_qty IS NOT NULL THEN
            UPDATE public.marketplace_listings
               SET quantity_claimed = quantity_claimed + v_qty,
                   status = CASE WHEN quantity IS NOT NULL AND quantity_claimed + v_qty >= quantity THEN 'closed' ELSE status END,
                   updated_at = now()
             WHERE id = v_listing AND quantity IS NOT NULL AND quantity_claimed + v_qty <= quantity
            RETURNING true INTO v_reserved;
            IF NOT COALESCE(v_reserved, false) THEN RETURN 'full'; END IF;
        END IF;
    ELSE
        v_wh := NULL;
    END IF;

    UPDATE public.marketplace_contracts
       SET status = 'accepted', accepted_at = now(), warehouse_stock_id = v_wh, updated_at = now()
     WHERE id = p_contract_id AND status = 'proposed';
    RETURN 'ok';
END;
$$;

-- Marketplace release: atomically return p_qty to a listing on contract cancel,
-- re-opening it if it had auto-closed and is not expired. GREATEST(0, …) floors
-- the claim so a double-cancel can't drive it negative.
CREATE OR REPLACE FUNCTION public.marketplace_release_listing(p_listing_id uuid, p_qty integer)
RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.marketplace_listings
       SET quantity_claimed = GREATEST(0, quantity_claimed - p_qty),
           status = CASE
               WHEN status = 'closed'
                    AND (quantity IS NULL OR GREATEST(0, quantity_claimed - p_qty) < quantity)
                    AND (expires_at IS NULL OR expires_at > now())
               THEN 'active' ELSE status END,
           updated_at = now()
     WHERE id = p_listing_id;
END;
$$;

-- DE-ORG'd: cross-org guard removed (single org); still checks same commodity.
CREATE OR REPLACE FUNCTION public.warehouse_transfer_stock(
    p_from_stock_id bigint, p_to_stock_id bigint, p_quantity integer, p_actor_id integer, p_notes text
) RETURNS uuid LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
    v_from_cat bigint;
    v_to_cat   bigint;
    v_current  integer;
    v_out_id   uuid;
    v_in_id    uuid;
BEGIN
    IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'Transfer quantity must be positive'; END IF;
    IF p_from_stock_id = p_to_stock_id THEN RAISE EXCEPTION 'Cannot transfer to the same stock row'; END IF;

    IF p_from_stock_id < p_to_stock_id THEN
        SELECT catalog_id INTO v_from_cat FROM public.warehouse_stock WHERE id = p_from_stock_id FOR UPDATE;
        SELECT catalog_id INTO v_to_cat   FROM public.warehouse_stock WHERE id = p_to_stock_id   FOR UPDATE;
    ELSE
        SELECT catalog_id INTO v_to_cat   FROM public.warehouse_stock WHERE id = p_to_stock_id   FOR UPDATE;
        SELECT catalog_id INTO v_from_cat FROM public.warehouse_stock WHERE id = p_from_stock_id FOR UPDATE;
    END IF;

    IF v_from_cat IS NULL OR v_to_cat IS NULL THEN RAISE EXCEPTION 'One or both stock rows not found'; END IF;
    IF v_from_cat <> v_to_cat THEN
        RAISE EXCEPTION 'Transfer must be between the same commodity (catalog_id)';
    END IF;

    SELECT COALESCE(SUM(delta), 0) INTO v_current
      FROM public.warehouse_movements WHERE stock_id = p_from_stock_id;
    IF v_current < p_quantity THEN
        RAISE EXCEPTION 'WAREHOUSE_INSUFFICIENT_STOCK: have %, need %', v_current, p_quantity;
    END IF;

    INSERT INTO public.warehouse_movements (stock_id, delta, reason, actor_user_id, notes)
    VALUES (p_from_stock_id, -p_quantity, 'transfer_out', p_actor_id, p_notes)
    RETURNING id INTO v_out_id;

    INSERT INTO public.warehouse_movements (stock_id, delta, reason, actor_user_id, related_movement_id, notes)
    VALUES (p_to_stock_id, p_quantity, 'transfer_in', p_actor_id, v_out_id, p_notes)
    RETURNING id INTO v_in_id;

    UPDATE public.warehouse_movements SET related_movement_id = v_in_id WHERE id = v_out_id;
    UPDATE public.warehouse_stock SET updated_at = now() WHERE id IN (p_from_stock_id, p_to_stock_id);
    RETURN v_out_id;
END;
$$;

-- warehouse_overview_stats (DE-ORG'd: no p_org_id param, no org predicates).
CREATE OR REPLACE FUNCTION public.warehouse_overview_stats()
RETURNS TABLE (
    total_stocks bigint, total_on_hand bigint, total_reserved bigint,
    low_stock_count bigint, open_request_count bigint
) LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
BEGIN
    RETURN QUERY
    WITH stock_qty AS (
        SELECT s.id AS stock_id,
            COALESCE((SELECT SUM(m.delta)::bigint FROM public.warehouse_movements m
                      WHERE m.stock_id = s.id), 0) AS qty_on_hand,
            COALESCE((SELECT SUM(r.requested_quantity)::bigint FROM public.warehouse_requests r
                      WHERE r.stock_id = s.id AND r.status IN ('pending', 'approved')), 0) AS qty_reserved
        FROM public.warehouse_stock s
    )
    SELECT
        COUNT(*)::bigint AS total_stocks,
        COALESCE(SUM(qty_on_hand), 0)::bigint AS total_on_hand,
        COALESCE(SUM(qty_reserved), 0)::bigint AS total_reserved,
        COUNT(*) FILTER (WHERE qty_on_hand = 0)::bigint AS low_stock_count,
        (SELECT COUNT(*)::bigint FROM public.warehouse_requests
          WHERE status IN ('pending', 'approved')) AS open_request_count
    FROM stock_qty;
END;
$$;


-- ----- 4.7 public_stats_for_org (DE-ORG'd: no org_id param/predicate) --------
-- NOTE: call site (lib/db/public.ts) passes { org_id: null }; update it to {}.

CREATE OR REPLACE FUNCTION public.public_stats_for_org()
RETURNS TABLE (
    total_completed int, avg_rating_times10 int,
    avg_response_minutes int, last30_completed int
) LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
    SELECT
        COUNT(*) FILTER (WHERE status = 'Success')::int AS total_completed,
        COALESCE(ROUND(AVG(client_rating) FILTER (WHERE client_rating IS NOT NULL AND status = 'Success') * 10), 0)::int AS avg_rating_times10,
        COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60.0)
                 FILTER (WHERE status = 'Success')), 0)::int AS avg_response_minutes,
        COUNT(*) FILTER (
            WHERE status = 'Success' AND updated_at > now() - interval '30 days'
        )::int AS last30_completed
    FROM public.service_requests;
$$;


-- ----- 4.x Org-import helper -------------------------------------------------
-- Resets a table's identity sequence to MAX(id) after the org importer bulk-loads
-- rows with explicit ids (lib/db/importer.ts calls rpc('import_reset_sequence',
-- { p_table })). Previously defined only in a migration and absent from the
-- consolidated schema, so a fresh deploy silently degraded (importer warned and
-- asked the operator to reset sequences by hand). Identifier-injection-safe via
-- quote_ident + %I; service-role-only (granted below, revoked from PUBLIC).
CREATE OR REPLACE FUNCTION public.import_reset_sequence(p_table text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_seq text;
    v_max bigint;
BEGIN
    -- Identity/serial sequence backing <table>.id; NULL for uuid / no-id PKs.
    v_seq := pg_get_serial_sequence('public.' || quote_ident(p_table), 'id');
    IF v_seq IS NULL THEN
        RETURN;
    END IF;
    EXECUTE format('SELECT COALESCE(MAX(id), 0) FROM public.%I', p_table) INTO v_max;
    -- is_called = (v_max > 0): empty table → next nextval() yields 1; else v_max + 1.
    PERFORM setval(v_seq, GREATEST(v_max, 1), v_max > 0);
END;
$$;


-- =============================================================================
-- SECTION 5 — Grants
-- =============================================================================
-- The application server uses the service_role key (bypasses RLS). authenticated
-- (the realtime client) gets SELECT on the realtime-subscribed tables only,
-- via the policies in SECTION 6 — not via blanket table grants.

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- authenticated needs table-level SELECT privilege in addition to a permissive
-- RLS policy. INSERT/UPDATE/DELETE stay with service_role (the app server).
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT ON TABLES TO authenticated;

-- Function execute grants: service_role ONLY. Every supabase.rpc() caller runs
-- server-side under the service-role key (lib/db/**); the client never invokes
-- these via PostgREST (it POSTs to /api/services, gated by fullPermissionMap).
-- These functions are SECURITY DEFINER and trust their caller, so granting
-- `authenticated` would let any logged-in member call finance_*/qm_*/warehouse_*
-- directly via /rest/v1/rpc and bypass the server's permission checks — a latent
-- BOLA surface with no consumer. Keep them service_role-only (deny-by-default).
GRANT EXECUTE ON FUNCTION public.try_acquire_cron_lock(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_cron_lock(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finance_reconcile_balances() TO service_role;
GRANT EXECUTE ON FUNCTION public.add_uec_to_operation(uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.add_cost_to_operation(uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.op_join_participant(uuid, integer, text, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.gov_appoint_holder(bigint, integer, integer, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_adjust_reputation(integer, integer, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.public_stats_for_org() TO service_role;
GRANT EXECUTE ON FUNCTION public.import_reset_sequence(text) TO service_role;

GRANT EXECUTE ON FUNCTION public.finance_approve_entry(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finance_reject_entry(uuid, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finance_reverse_entry(uuid, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.qm_fulfil_issuance(bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.qm_issue_direct(bigint, integer, integer, timestamptz, integer, text, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.qm_return_issuance(bigint, integer, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.qm_write_off_issuance(bigint, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.qm_adjust_inventory(bigint, integer, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.qm_issue_bulk(integer, timestamptz, integer, text, bigint, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.qm_return_bulk(integer, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.qm_overview_stats() TO service_role;
GRANT EXECUTE ON FUNCTION public.warehouse_adjust_stock(bigint, integer, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.warehouse_fulfil_request(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.warehouse_transfer_stock(bigint, bigint, integer, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.warehouse_overview_stats() TO service_role;
GRANT EXECUTE ON FUNCTION public.warehouse_marketplace_deliver(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.warehouse_marketplace_reverse(uuid, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_accept_contract(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_release_listing(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_truncate_all_data() TO service_role;

-- PostgreSQL grants EXECUTE on every function to PUBLIC by default, which via
-- PostgREST (/rest/v1/rpc/<fn>) would let an unauthenticated caller invoke the
-- SECURITY DEFINER functions above and bypass app-level authorization (these
-- functions trust their caller — the server calls them under the service-role
-- key after its own permission checks). Revoke the implicit PUBLIC + anon grant;
-- the explicit service_role grants are the allowlist (no function is granted to
-- `authenticated` — every caller runs server-side under service_role).
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon;
-- On Supabase, its bootstrap runs ALTER DEFAULT PRIVILEGES granting EXECUTE on
-- every new function to anon + authenticated explicitly, so the FROM PUBLIC
-- revoke alone does NOT remove the `authenticated` grant. Revoke from
-- authenticated too; no function is meant to be PostgREST-callable.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
-- And for any function added to the schema later in this apply.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;


-- =============================================================================
-- SECTION 6 — Row Level Security (single-org, deny-by-default)
-- =============================================================================
-- Strategy: enable RLS on every table; service_role bypasses RLS
-- (all app reads/writes go through the server). The ONLY non-service-role direct
-- client is the realtime subscriber (anon/publishable key carrying a logged-in
-- Supabase Auth session = role `authenticated`). It needs SELECT on the tables
-- it subscribes to. Everything else is deny-all by omission (no policy). No anon
-- access anywhere. "Tenant isolation" collapses to "is this a logged-in member".
-- =============================================================================

DO $$
DECLARE t text;
BEGIN
    FOR t IN
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    END LOOP;
END $$;

-- Authenticated-SELECT policies on the realtime-subscribed tables only
-- (source: contexts/DataCoreContext.tsx tableSubsets + the settings handler).
-- All other tables remain deny-all to authenticated/anon (no policy created);
-- service_role bypasses RLS and serves them via the API.
DO $$
DECLARE t text;
BEGIN
    -- Low-sensitivity org-structure/reference tables only. postgres_changes
    -- ships the FULL changed row, so anything with a per-viewer access boundary
    -- on its server read path is DELIBERATELY EXCLUDED (its realtime is
    -- broadcast-driven instead — no liveness lost):
    --   - hr_applications/interviews/job_postings/transfer_requests + settings:
    --     HR PII / settings secrets (incl. the admin setup code) — would bypass
    --     hr:view + the server's secret-stripping.
    --   - external_tools / announcements: rows carry an `audience` field and the
    --     server filters by the viewer's role (getExternalToolsState /
    --     getAnnouncementsState) — a raw row push would defeat that audience
    --     scoping. Both are broadcast-driven (external_tools_update /
    --     announcement_update id-only nudges → refetch through the gated read).
    --   - synced_discord_roles / rank_mappings: admin-console role-sync config;
    --     the aggregated 'discord' subset is gated admin:config:discord, so the
    --     raw rows must not be member-readable via postgres_changes either.
    -- Since clients now authenticate to Realtime as role=authenticated (private
    -- channel JWT), these policies actually deliver — the exclusions above are
    -- load-bearing, not cosmetic.
    FOREACH t IN ARRAY ARRAY[
        'ranks', 'units', 'roles', 'locations', 'radio_channels',
        'personnel_positions',
        'security_clearances', 'security_limiting_markers',
        'specialization_tags', 'certifications', 'commendations',
        'service_types'
    ]
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS authenticated_select ON public.%I;', t);
        -- Require the realtime token's user_id to be a live (non-deleted) member,
        -- like the §6b broadcast policies do, so a banned/removed account loses access
        -- to these tables right away instead of at token expiry — rather than the
        -- looser `auth.uid() IS NOT NULL`, which any token satisfies. The iat vs
        -- tokens_valid_from check also cuts off a revoked-but-not-deleted session
        -- (admin "revoke sessions") before the realtime token's own expiry.
        EXECUTE format(
            'CREATE POLICY authenticated_select ON public.%I FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = NULLIF(auth.jwt()->>''user_id'', '''')::int AND u.deleted_at IS NULL AND (u.tokens_valid_from IS NULL OR to_timestamp(NULLIF(auth.jwt()->>''iat'', '''')::bigint) >= u.tokens_valid_from)));',
            t);
    END LOOP;
END $$;

-- Explicit deny-all for EVERY server-only table (everything NOT in the
-- authenticated_select allowlist above). RLS is already enabled on all tables, so
-- they were deny-by-default by omission; these explicit policies RECORD the intent
-- and clear the Supabase linter's "RLS enabled, no policy" finding (lint 0008). No
-- client reads these tables directly — only the service-role server, which bypasses
-- RLS. The allowlist tables keep their permissive SELECT policy (and have no write
-- policy, so writes stay server-only there too).
DO $$
DECLARE
    t text;
    allowlist text[] := ARRAY[
        'ranks', 'units', 'roles', 'locations', 'radio_channels',
        'personnel_positions',
        'security_clearances', 'security_limiting_markers',
        'specialization_tags', 'certifications', 'commendations',
        'service_types'
    ];
BEGIN
    FOR t IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND NOT (tablename = ANY(allowlist))
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS "Service role only" ON public.%I;', t);
        EXECUTE format('CREATE POLICY "Service role only" ON public.%I FOR ALL TO public USING (false) WITH CHECK (false);', t);
    END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- SECTION 6a — Realtime publication membership (postgres_changes)
-- -----------------------------------------------------------------------------
-- For a postgres_changes event to be delivered, the table must be a member of
-- the supabase_realtime publication. Membership is defined explicitly here (not
-- left to out-of-band dashboard config) so a fresh deploy gets live reference-
-- table updates and the set is reviewable/diffable in source.
--
-- Membership == the authenticated_select allowlist above (the only tables whose
-- raw rows are safe to push to role=authenticated). Sensitive/PII tables
-- (hr_*, settings, external_tools, announcements, synced_discord_roles,
-- rank_mappings, service_requests) are DELIBERATELY excluded — their realtime is broadcast-
-- driven (ids only, fetched back through the permission-gated read paths), so a
-- full-row postgres_changes push would defeat that scoping. RLS is the second
-- guard: a non-allowlisted table has no authenticated SELECT policy and so would
-- deliver nothing even if mistakenly added here.
DROP PUBLICATION IF EXISTS supabase_realtime;
CREATE PUBLICATION supabase_realtime FOR TABLE
    public.ranks, public.units, public.roles, public.locations,
    public.radio_channels, public.personnel_positions,
    public.security_clearances, public.security_limiting_markers,
    public.specialization_tags, public.certifications, public.commendations,
    public.service_types;

-- -----------------------------------------------------------------------------
-- SECTION 6b — Realtime Authorization (private broadcast channels)
-- -----------------------------------------------------------------------------
-- Every app broadcast channel ('db-changes', 'auth-alerts', 'op-board-{uuid}')
-- is created with { config: { private: true } } on BOTH the server
-- (lib/db/common.ts) and every client subscriber. Private channels are
-- authorized by these RLS policies on realtime.messages, evaluated against the
-- JWT the client passed to realtime.setAuth(). The server mints that JWT
-- (lib/auth.ts signRealtimeToken, signed with SUPABASE_JWT_SECRET) with
-- role='authenticated' and a `user_id` integer claim. The public anon key alone
-- can no longer subscribe to any broadcast channel. Clients never SEND
-- broadcasts (no INSERT policy → denied); the service-role server bypasses RLS
-- for sends.

-- Org-wide channels: any authenticated, non-deleted member may receive
-- (payloads are id-only by design; content rides permission-gated fetches).
-- The deleted_at check cuts a removed user off from even id-only pings
-- without waiting for token expiry; the iat vs tokens_valid_from check does
-- the same for a session an admin revoked (revokeUserSessions) without deleting.
-- CONTRACT: this topic list is the canonical set of org-wide broadcast
-- channels (see lib/db/common.ts broadcastToOrg → 'db-changes'; the EAM/
-- op-alert path → 'auth-alerts'). Adding a new org-wide channel in code
-- requires adding it here, or its private subscription is denied.
DROP POLICY IF EXISTS rt_recv_org_channels ON realtime.messages;
CREATE POLICY rt_recv_org_channels ON realtime.messages
    FOR SELECT TO authenticated
    USING (
        realtime.messages.extension = 'broadcast'
        AND realtime.topic() IN ('db-changes', 'auth-alerts')
        AND EXISTS (
            SELECT 1 FROM public.users u
            WHERE u.id = NULLIF(auth.jwt()->>'user_id', '')::int
              AND u.deleted_at IS NULL
              AND (u.tokens_valid_from IS NULL
                   OR to_timestamp(NULLIF(auth.jwt()->>'iat', '')::bigint) >= u.tokens_valid_from)
        )
    );

-- Tactical board channels: deltas carry full element content (broadcastBoardAdd
-- emits the `element` object and broadcastBoardUpdate the `changes` object —
-- lib/db/ops.ts), so receipt is gated on the SAME operation-visibility predicate
-- the app enforces on its read paths (lib/db/ops.ts canUserSeeOpInList /
-- assertOpVisibleToUser):
--   owner, OR operations:manage holder, OR
--   (clearance level met AND every limiting marker held
--    AND — for SPECIAL operations — caller is an ACTIVE participant).
-- Special operations are invite-only: a clearance-0 (or otherwise clearance-met,
-- unmarked) special op must NOT be readable by every member — only the owner,
-- operations:manage holders, and ACTIVE participants (operation_participants rows
-- with time_left IS NULL) may receive its live board. Without this branch a
-- non-participant could subscribe to op-board-<id> directly via supabase-js and
-- read the special op's tactical board content. This mirrors the special-op gate
-- the TS read/list/detail/action paths enforce so the realtime channel cannot
-- drift from them. Topic format: 'op-board-<operation uuid>'; the regex guard
-- rejects malformed topics up front (a non-UUID tail never matches o.id — the
-- EXISTS fails closed — but the guard makes the contract explicit and avoids a
-- needless scan). NULL user clearance is treated as level 0, identical to the
-- app's passesClearance (lib/clearance.ts).
--
-- MANUAL APPLY: schema.sql is applied by hand via the Supabase SQL editor, not via
-- migrations. After editing this policy you MUST re-run this DROP/CREATE POLICY
-- block against the live database for the change to take effect.
DROP POLICY IF EXISTS rt_recv_op_board ON realtime.messages;
CREATE POLICY rt_recv_op_board ON realtime.messages
    FOR SELECT TO authenticated
    USING (
        realtime.messages.extension = 'broadcast'
        AND realtime.topic() ~ '^op-board-[0-9a-fA-F-]{36}$'
        AND EXISTS (
            SELECT 1
            FROM public.operations o
            JOIN public.users u
              ON u.id = NULLIF(auth.jwt()->>'user_id', '')::int
             AND u.deleted_at IS NULL
             AND (u.tokens_valid_from IS NULL
                  OR to_timestamp(NULLIF(auth.jwt()->>'iat', '')::bigint) >= u.tokens_valid_from)
            LEFT JOIN public.security_clearances sc ON sc.id = u.clearance_level_id
            WHERE o.id::text = substring(realtime.topic() FROM 10)
              AND (
                    o.owner_id = u.id
                    OR EXISTS (
                        SELECT 1 FROM public.role_permissions rp
                        JOIN public.permissions p ON p.id = rp.permission_id
                        WHERE rp.role_id = u.role_id AND p.name = 'operations:manage'
                    )
                    OR (
                        -- Special-op participation gate: a special op is visible
                        -- through clearance ONLY to ACTIVE participants (time_left
                        -- IS NULL). Non-special ops keep clearance-only behavior.
                        (
                            NOT COALESCE(o.is_special, false)
                            OR EXISTS (
                                SELECT 1 FROM public.operation_participants opp
                                WHERE opp.operation_id = o.id
                                  AND opp.user_id = u.id
                                  AND opp.time_left IS NULL
                            )
                        )
                        AND COALESCE(o.clearance_level, 0) <= COALESCE(sc.level, 0)
                        AND NOT EXISTS (
                            SELECT 1 FROM public.operation_limiting_markers olm
                            WHERE olm.operation_id = o.id
                              AND NOT EXISTS (
                                  SELECT 1 FROM public.user_limiting_markers ulm
                                  WHERE ulm.user_id = u.id AND ulm.marker_id = olm.marker_id
                              )
                        )
                    )
              )
        )
    );


-- =============================================================================
-- SECTION 7 — Seed: global permissions (union of backup COPY + add-*-perms)
-- =============================================================================
-- Seeded by NAME (ids are not load-bearing — the app resolves permissions by
-- name; the seeder grants Admin every permission and Member/Dispatcher named
-- subsets). role_permissions are seeded by lib/db/seeder.ts, NOT here.
-- CONTRACT: this list is the authoritative deploy seed and MUST contain every
-- permission the app gates on (server fullPermissionMap + SUBSET_REQUIRED_PERMISSION
-- + inline checks) AND must stay in parity with lib/db/system.ts GLOBAL_PERMISSIONS
-- (the admin "repair database" backstop). tests/permissionSeedParity.test.ts
-- enforces both — a gate on an unseeded permission means nobody can ever hold it.

INSERT INTO public.permissions (name, description, category) VALUES
    ('admin:access', 'Access the Admin Dashboard', 'System'),
    ('admin:config:branding', 'Manage Branding & System Config', 'System'),
    ('admin:config:discord', 'Manage Discord Integration', 'System'),
    ('admin:config:metadata', 'Manage SEO & Metadata', 'System'),
    ('admin:config:ai', 'Manage AI Configuration', 'System'),
    ('admin:config:api', 'Manage API Keys', 'System'),
    ('admin:config:tools', 'Manage External Tools', 'System'),
    ('admin:config:catalog', 'Manage Global Catalog (Ships/Items/Commodities/Locations)', 'System'),
    ('admin:db:destroy', 'Destroy all data (full reset / full wipe)', 'System'),
    ('admin:config:notices', 'Manage Announcements', 'System'),
    ('admin:config:roles', 'Manage Roles & Permissions', 'System'),
    ('admin:config:servicetypes', 'Manage Service Types', 'System'),
    ('admin:config:units', 'Manage Units', 'Organization'),
    ('admin:config:ranks', 'Manage Ranks', 'Organization'),
    ('admin:config:locations', 'Manage Locations', 'Organization'),
    ('admin:config:clearance', 'Manage Security Clearances', 'Organization'),
    ('admin:config:specializations', 'Manage Specializations', 'Organization'),
    ('admin:config:certifications', 'Manage Certifications', 'Organization'),
    ('admin:config:commendations', 'Manage Commendations', 'Organization'),
    ('admin:view:roster', 'View Member Roster', 'User Management'),
    ('admin:view:clients', 'View Client Registry', 'User Management'),
    ('admin:user:update', 'Edit User Details', 'User Management'),
    ('admin:user:update_role', 'Promote/Demote Users', 'User Management'),
    ('admin:user:manage_clearance', 'Change User Clearance', 'User Management'),
    ('admin:user:adjust_reputation', 'Adjust User Reputation', 'User Management'),
    ('admin:user:view_history', 'View User History', 'User Management'),
    ('user:manage:conduct_record', 'Add/Remove Conduct Entries', 'User Management'),
    ('user:manage:personnel_notes', 'Add/View Personnel Notes', 'User Management'),
    ('user:toggle_duty', 'Toggle Duty Status', 'User Management'),
    ('admin:award:certification', 'Award Certification', 'User Management'),
    ('admin:revoke:certification', 'Revoke Certification', 'User Management'),
    ('admin:award:commendation', 'Award Commendation', 'User Management'),
    ('admin:revoke:commendation', 'Revoke Commendation', 'User Management'),
    ('user:view:roster', 'View Duty Roster', 'User Management'),
    ('hr:view', 'View HR Dashboard', 'HR'),
    ('hr:recruiter', 'Manage Recruitment Cases', 'HR'),
    ('hr:manager', 'Manage HR Department', 'HR'),
    ('hr:admin', 'Full HR Administration', 'HR'),
    ('hr:manage:positions', 'Manage Job Roles', 'HR'),
    ('admin:manage:documents', 'Manage Documents', 'HR'),
    ('intel:view', 'View Intelligence Hub & Post Bulletins', 'Intelligence'),
    ('intel:view:clearance', 'View Classified Intel Reports', 'Intelligence'),
    ('intel:create', 'Create Formal Intelligence Reports', 'Intelligence'),
    ('intel:manage', 'Manage & Delete Intel Reports/Bulletins', 'Intelligence'),
    ('warrant:view', 'View Warrants', 'Intelligence'),
    ('warrant:create', 'Issue Warrants', 'Intelligence'),
    ('warrant:manage', 'Manage Warrants', 'Intelligence'),
    ('operations:view', 'View Operations Center', 'Operations'),
    ('operations:create', 'Create Operations', 'Operations'),
    ('operations:manage', 'Manage Any Operation', 'Operations'),
    ('request:create', 'Create Service Requests', 'Requests'),
    ('request:create_adhoc', 'Log Ad-Hoc Requests', 'Requests'),
    ('request:triage', 'Triage Incoming Requests', 'Requests'),
    ('request:dispatch', 'Dispatch Units', 'Requests'),
    ('request:accept', 'Accept Requests', 'Requests'),
    ('request:start', 'Start Mission', 'Requests'),
    ('request:complete', 'Complete Mission', 'Requests'),
    ('request:cancel', 'Cancel Own Request', 'Requests'),
    ('request:delete', 'Delete Request', 'Requests'),
    ('request:manage_responders', 'Manage Responders', 'Requests'),
    ('request:set_lead', 'Assign Lead Responder', 'Requests'),
    ('request:update', 'Update Request Status', 'Requests'),
    ('request:rate', 'Rate Completed Service', 'Requests'),
    ('request:view:feedback', 'View Client Feedback', 'Requests'),
    ('radio:manage', 'Manage Radio Frequencies', 'Communications'),
    ('admin:broadcast:eam', 'Broadcast EAM', 'Communications'),
    ('user:manage:self', 'Manage Own Profile', 'User Management'),
    ('unit:manage:own', 'Manage Own Unit', 'Organization'),
    ('units:view_all', 'View All Restricted Units', 'Organization'),
    ('admin:config:settings', 'Manage Client UI Settings', 'System'),
    ('user:receive:eam', 'Receive EAM Alerts', 'Communications'),
    ('fleet:view', 'View Fleet Manager', 'Fleet'),
    ('fleet:manage_own', 'Manage Own Ship Hangar', 'Fleet'),
    ('fleet:manage', 'Manage Fleet Groups & Assignments', 'Fleet'),
    ('alliance:view', 'View Alliance Directory', 'Alliance'),
    ('alliance:manage', 'Manage Alliances & Directory Profile', 'Alliance'),
    ('wiki:view', 'View Org Wiki', 'Wiki'),
    ('wiki:add_page', 'Create Wiki Pages', 'Wiki'),
    ('wiki:edit_page', 'Edit Wiki Pages & Settings', 'Wiki'),
    ('wiki:delete_page', 'Delete Wiki Pages', 'Wiki'),
    ('gov:view', 'View Government', 'Government'),
    ('gov:participate', 'Vote & Run for Office', 'Government'),
    ('gov:elected_official', 'Propose/Vote on Legislation', 'Government'),
    ('gov:electoral_officer', 'Manage Elections', 'Government'),
    ('gov:manage', 'Manage Governance', 'Government'),
    ('gov:admin', 'Configure Government Structure', 'Government'),
    ('gov:issue_orders', 'Issue Executive Orders', 'Government'),
    ('admin:config:features', 'Toggle Optional Features', 'System Config'),
    ('finance:view', 'View Org Finances', 'Finances'),
    ('finance:deposit', 'Submit Deposit Claims', 'Finances'),
    ('finance:withdraw_request', 'Request Withdrawals', 'Finances'),
    ('finance:approve', 'Approve / Reject Pending Entries', 'Finances'),
    ('finance:manage', 'Manage Accounts, Adjustments, Reversals', 'Finances'),
    ('finance:admin', 'Configure Finances Module', 'Finances'),
    ('qm:view', 'View Org Armoury', 'Quartermaster'),
    ('qm:request', 'Request Issuance of Items', 'Quartermaster'),
    ('qm:manage', 'Manage Inventory & Issuances', 'Quartermaster'),
    ('qm:admin', 'Configure Catalog, Locations, Module', 'Quartermaster'),
    ('warehouse:view', 'View Org Warehouse', 'Warehouse'),
    ('warehouse:request', 'Request Withdrawal of Bulk Stock', 'Warehouse'),
    ('warehouse:manage', 'Manage Stock, Transfers & Withdrawals', 'Warehouse'),
    ('warehouse:admin', 'Configure Commodity Catalog', 'Warehouse'),
    ('marketplace:view', 'Browse the Marketplace', 'Marketplace'),
    ('marketplace:list', 'Post & Manage Own Listings', 'Marketplace'),
    ('marketplace:contract', 'Propose & Fulfil Contracts', 'Marketplace'),
    ('marketplace:admin', 'Moderate Marketplace & Reports', 'Marketplace')
ON CONFLICT (name) DO NOTHING;


-- =============================================================================
-- SECTION 8 — Optional platform reference data (COPY) — NOT INCLUDED
-- =============================================================================
-- platform_ships (ship catalog, ~hundreds of rows) is normally populated by the
-- UEX sync cron. To ship the Apr-28 snapshot, append the backup's
-- `COPY public.platform_ships (...) FROM stdin;` block (backup line 17522) here.
-- Omitted to keep this file reviewable; an empty platform_ships is acceptable —
-- the sync job (or a manual UEX import) will populate it on first run.
-- platform_locations / quartermaster_platform_categories /
-- warehouse_platform_* are likewise empty until the UEX sync runs.

-- =============================================================================
-- SECTION 9 — Schema version stamp (KEEP LAST)
-- =============================================================================
-- Records the schema version this run applied. The app reads settings.schema_version
-- to tell whether a deployment's DB is behind the code (a future self-update flow
-- surfaces "re-run schema.sql"). Placed LAST so the stamp only lands if the whole
-- script ran without aborting. settings.value is jsonb → store the version as a
-- JSON string. BUMP this whenever you change the schema (see AMENDMENT RULES at top);
-- keep it aligned with the app version where practical.
INSERT INTO public.settings (key, value)
VALUES ('schema_version', '"15.2.0-open"'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- Refresh PostgREST schema cache.
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- END schema.single-org.sql
-- =============================================================================
