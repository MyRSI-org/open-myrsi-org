// Decides whether a 404 should count toward the per-IP abuse block.
//
// Don't count ordinary browser/asset 404s: browsers request favicon / apple-touch /
// robots on every visit, and hashed /assets/* chunk URLs 404 during a deploy. If
// those counted, a whole office behind one IP could trip the block and lock all its
// members out. Anything else — non-GET/HEAD, or an unknown path — still counts, so
// scanners are still caught.
export const BENIGN_404_RE = /^\/(?:favicon\.ico|apple-touch-icon[\w.-]*\.png|robots\.txt|sitemap\.xml|manifest\.webmanifest|sw\.js|assets\/|\.well-known\/)/i;

export function counts404TowardAbuse(method: string, pathName: string): boolean {
    if (method !== 'GET' && method !== 'HEAD') return true;
    return !BENIGN_404_RE.test(pathName);
}

// True for the host's own loopback address. With the secure default (trust proxy 0),
// a reverse proxy running on the SAME host makes every forwarded request look like it
// came from loopback. Never blackhole that — it would 404 the whole site — and a real
// attacker can't originate from loopback without already being on the server.
export function isLoopbackIp(ip: string): boolean {
    return ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('127.');
}
