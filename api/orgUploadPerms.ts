// Permission map for native image uploads.
//
// Each upload feature is gated by the SAME permission that gates that feature's write
// action in api/services.ts `fullPermissionMap`. A member who can't create or edit a
// resource has no reason to upload media for it, and letting them would be an unmetered
// storage-abuse vector. tests/orgUploadPermParity.test.ts locks each value to
// `fullPermissionMap[<the write action>]`, so changing a feature's write permission fails
// the test until this map is updated to match.

import type { OrgMediaFeature } from '../lib/storage.js';

// A feature maps to one permission, or (any-of) an array — the uploader needs at least
// one. `wiki` is any-of because creating a page (wiki:add_page) and editing one
// (wiki:edit_page) are different permissions, and the upload happens on file-pick before
// the server can tell which; a contributor with only add_page must still be able to upload.
//
// `quartermaster` and `catalog` look redundant and are not. They write the SAME table by
// two different actions, on two disjoint row sets, under two different permissions, in two
// different namespaces:
//   * quartermaster -> qm:update_catalog_item / qm:admin -> quartermaster_catalog WHERE
//     source='custom'  (the org's OWN rows, inside the Quartermaster module -> GATED qm:)
//   * catalog       -> catalog:update_item / admin:config:catalog -> quartermaster_catalog
//     WHERE source='platform' (the global platform catalog, edited from the admin console
//     with no module condition -> UNGATED catalog:)
// Collapsing them would either break the platform catalog on every Quartermaster-off org
// or hand qm:admin the global platform catalog. Keep them apart.
export const FEATURE_UPLOAD_PERMS: Record<OrgMediaFeature, string | string[]> = {
    branding: 'admin:config:branding',
    'site-metadata': 'admin:config:metadata',
    'public-page': 'admin:config:branding',
    'hero-card': 'admin:config:branding',
    rank: 'admin:config:ranks',
    unit: 'admin:config:units',
    specialization: 'admin:config:specializations',
    certification: 'admin:config:certifications',
    commendation: 'admin:config:commendations',
    alliance: 'alliance:manage',
    quartermaster: 'qm:admin',
    catalog: 'admin:config:catalog',
    wiki: ['wiki:edit_page', 'wiki:add_page'],
    government: 'gov:admin',
    legislation: 'gov:elected_official',
    academy: 'academy:instruct',
};

// The representative write action whose permission each feature must match.
//
// TWO consumers, not one:
//   1. tests/orgUploadPermParity.test.ts pins each value against fullPermissionMap, so a
//      change to a write permission fails the build until FEATURE_UPLOAD_PERMS matches.
//   2. RUNTIME — api/orgUpload.ts DERIVES the optional-module namespace of each upload
//      target from the first-colon prefix of these actions (`academy:update_course` →
//      `academy:`) and looks that prefix up in OPTIONAL_FEATURE_NAMESPACES. That is
//      deliberately a derivation and not a fourth hand-written map: a hand-typed prefix
//      that drops its trailing colon ('qm' vs 'qm:') misses the registry key, leaves the
//      gate undefined and silently un-gates the target — a fail-OPEN typo no
//      `startsWith` parity assertion can catch.
// So this map is NOT test-only scaffolding. Reshaping it (changing a namespace, or
// making an entry an empty/colon-less string) changes which uploads a disabled module
// blocks. Both invariants are pinned in tests/orgUploadPermParity.test.ts.
export const FEATURE_WRITE_ACTION: Record<OrgMediaFeature, string | string[]> = {
    branding: 'admin:update_branding_config',
    'site-metadata': 'admin:update_opengraph_config',
    'public-page': 'admin:update_public_page_config',
    'hero-card': 'admin:update_hero_config',
    rank: 'admin:update_rank',
    unit: 'admin:update_unit',
    specialization: 'admin:update_specialization',
    certification: 'admin:update_certification',
    commendation: 'admin:update_commendation',
    alliance: 'alliance:save_self_profile',
    quartermaster: 'qm:update_catalog_item',
    catalog: 'catalog:update_item',
    wiki: ['wiki:update_page', 'wiki:create_page'],
    government: 'gov:update_constitution',
    legislation: 'gov:update_legislation',
    academy: 'academy:update_course',
};
