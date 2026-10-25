import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { getClientIp } from './clientIp.js';
import { log as baseLog } from './log.js';

// Same module tag it logged under while it lived in server.ts.
const log = baseLog.child({ module: 'server' });

/**
 * Terminal error handler. There was none, so a body-parser fault escaped to Express's
 * finalhandler and answered a JSON API with an HTML error page — including, outside production,
 * a stack trace and absolute filesystem paths. Splitting the body cap makes 413 a routine
 * outcome rather than a curiosity, so the shape of that response now matters.
 *
 * Its own module so the runtime tests mount THIS handler rather than a copy of it.
 *
 * Four arguments, and `_next` must stay: Express identifies an error handler by ARITY, so
 * dropping the unused parameter silently turns this back into ordinary middleware that never
 * runs. Registered last, after every route. Never call `_next(err)`: that hands the error to
 * finalhandler, which console.errors the whole error object.
 */
export function terminalErrorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
    const type = (err as { type?: string } | null)?.type;
    const status = (err as { status?: number; statusCode?: number } | null)?.status
        ?? (err as { statusCode?: number } | null)?.statusCode
        ?? 500;

    // A handler failed mid-response: the status line and headers are already out, so no error
    // reply can follow, and setHeader would THROW here, handing the error to finalhandler anyway.
    // Destroy the socket rather than res.end(): a clean end would make the truncated body look
    // complete to the client.
    if (res.headersSent) {
        log.error('request error after headers were sent', { path: req.originalUrl, method: req.method, err });
        res.destroy();
        return;
    }

    if (type === 'entity.too.large') {
        log.warn('request body over cap', { path: req.originalUrl, method: req.method, ip: getClientIp(req) });
        res.setHeader('Cache-Control', 'no-store');
        res.status(413).json({ message: 'That upload is too large.' });
        return;
    }
    if (type === 'entity.parse.failed') {
        res.setHeader('Cache-Control', 'no-store');
        res.status(400).json({ message: 'Malformed request body.' });
        return;
    }
    // The parsers run with inflate:false, so a compressed body lands here, as do an unknown
    // encoding and a non-UTF JSON charset. A client mistake, not a server fault: answer 415
    // instead of logging it at error level as an 'internal server error'.
    if (type === 'encoding.unsupported' || type === 'charset.unsupported') {
        log.warn('request body encoding refused', { path: req.originalUrl, method: req.method, ip: getClientIp(req), type });
        res.setHeader('Cache-Control', 'no-store');
        res.status(415).json({ message: 'Unsupported request body encoding.' });
        return;
    }

    // Anything else: log it server-side with an id, return an opaque message. The raw error
    // text never crosses the wire — it can carry file paths and query fragments.
    const requestId = randomUUID();
    log.error('unhandled request error', { requestId, path: req.originalUrl, method: req.method, err });
    res.setHeader('Cache-Control', 'no-store');
    res.status(status >= 400 && status < 600 ? status : 500).json({ message: 'An internal server error occurred.', requestId });
}
