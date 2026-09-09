// Length-preserving comment blanking, shared by every source-scanning ratchet.
//
// WHY THIS IS A MODULE AND NOT A LOCAL HELPER. Four ratchets need it, and three of
// them had independently grown the same broken two-regex version: a non-greedy
// block-comment replace running BEFORE the line-comment replace. Because it runs
// first, a block-comment OPENER appearing inside a line comment opens a block that
// closes at the next block-comment CLOSER anywhere later in the file, deleting
// everything between. In lib/db/system.ts that swallowed 820 lines.
//
// The wildcard-select ratchet is Rule 1's only enforcement, so its green result over
// those 820 lines was not evidence of anything. A scanner that silently stops
// scanning is worse than no scanner, because it reports success.
//
// This walks the source once with a mode flag instead, tracking line comments, block
// comments and all three string quotings, so a comment opener inside a comment or a
// string is just text. Escapes are honoured inside strings so a trailing backslash
// cannot swallow the closing quote.
//
// Comments are blanked to SPACES rather than removed, and newlines are preserved, so
// byte offsets and line numbers survive: a caller can report `line` from the blanked
// text and have it match the real file.
//
// Deliberately written with line comments, not a doc block. The prose above has to
// name the very sequences it is about, and a doc block describing comment syntax is
// one keystroke from closing itself early: the same self-reference that produced the
// bug in the first place.
export function stripComments(s: string): string {
    let out = '', i = 0, mode: string | null = null;
    const BACKSLASH = String.fromCharCode(92);
    while (i < s.length) {
        const c = s[i], n = s[i + 1];
        if (mode === null) {
            if (c === '/' && n === '/') { mode = 'line'; out += '  '; i += 2; continue; }
            if (c === '/' && n === '*') { mode = 'block'; out += '  '; i += 2; continue; }
            if (c === '`' || c === "'" || c === '"') { mode = c; out += c; i++; continue; }
            out += c; i++; continue;
        }
        if (mode === 'line') { if (c === '\n') { mode = null; out += c; } else out += ' '; i++; continue; }
        if (mode === 'block') { if (c === '*' && n === '/') { mode = null; out += '  '; i += 2; continue; } out += (c === '\n' ? c : ' '); i++; continue; }
        if (c === BACKSLASH) { out += c + (s[i + 1] || ''); i += 2; continue; }
        if (c === mode) { mode = null; out += c; i++; continue; }
        out += c; i++;
    }
    return out;
}

// The SQL twin, for scanning schema.sql. Blanks `--` line comments length-preservingly
// for the same reason: a pin that can be satisfied by the prose explaining it is not a
// pin. Quote-aware, so a `--` inside a string literal (or inside a dollar-quoted
// function body) is left alone.
export function stripSqlComments(s: string): string {
    let out = '', i = 0, inLine = false, quote: string | null = null;
    while (i < s.length) {
        const c = s[i], n = s[i + 1];
        if (inLine) { if (c === '\n') { inLine = false; out += c; } else out += ' '; i++; continue; }
        if (quote) { out += c; if (c === quote) quote = null; i++; continue; }
        if (c === "'" || c === '"') { quote = c; out += c; i++; continue; }
        if (c === '-' && n === '-') { inLine = true; out += '  '; i += 2; continue; }
        out += c; i++;
    }
    return out;
}
