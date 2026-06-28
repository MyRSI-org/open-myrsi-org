
import { createClient } from '@supabase/supabase-js';
import { Agent } from 'undici';
import { log as baseLog } from './log.js';

const log = baseLog.child({ module: 'lib.supabaseServer' });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    throw new Error("Supabase environment variables SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set.");
}

// Custom HTTP agent with connection pooling to prevent connection exhaustion
// under concurrent Supabase queries (default undici limits are too low).
const fetchAgent = new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
    connections: 50,
    pipelining: 1,
    // undici 8 defaults allowH2 to true; pin this pool to HTTP/1.1 so the tuned
    // keep-alive / connection-pool behavior stays identical to the undici 7 setup.
    allowH2: false,
});

const customFetch: typeof globalThis.fetch = (input, init) =>
    fetch(input, { ...init, dispatcher: fetchAgent } as any);

export const supabase = createClient(supabaseUrl, supabaseKey, {
    global: { fetch: customFetch },
});

export const handleSupabaseError = ({ error, message }: { error: any, message: string }) => {
    if (error) {
        // Detail (PGRST codes, column names, constraint names) goes to logs
        // only — the rethrown Error carries just the high-level caller-provided
        // message so the dispatcher's 500 handler doesn't surface schema info
        // to clients. See lib/errors.ts / api/services.ts for the full path.
        log.error(message, { err: error });
        throw new Error(message);
    }
}
