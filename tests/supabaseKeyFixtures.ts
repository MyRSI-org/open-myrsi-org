// Realistic fake Supabase keys for the anon-key guard tests (tests/supabaseKeyGuard.test.ts,
// tests/queryAnonKeyEgress.test.ts). The exact header and claim shapes Supabase issues, with a
// made-up project ref and signature: a guard tested only against strings like 'test-anon-key'
// proves nothing about the keys operators actually paste. None of these is a working credential.

export const b64url = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

export const fakeJwt = (claims: Record<string, unknown>): string =>
    `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.${Buffer.from('not-a-real-signature-0123456789ab').toString('base64url')}`;

export const LEGACY_CLAIMS = { iss: 'supabase', ref: 'abcdefghijklmnopqrst', iat: 1700000000, exp: 2015576000 };

export const FAKE_ANON_JWT = fakeJwt({ ...LEGACY_CLAIMS, role: 'anon' });
export const FAKE_SERVICE_ROLE_JWT = fakeJwt({ ...LEGACY_CLAIMS, role: 'service_role' });
export const FAKE_PUBLISHABLE = 'sb_publishable_Xq7PzR2mN8vK4tL1cW9bYdA_3fH6jGs';
export const FAKE_SECRET = 'sb_secret_Jk2LmN4pQr6StU8vWx0YzA_1bCd3EfGh';
