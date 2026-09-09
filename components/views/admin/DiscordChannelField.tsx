import React, { useMemo } from 'react';

// A channel id field with a picker, and a manual escape hatch that is never taken
// away from the operator.
//
// It drops to a raw text input whenever the directory could not be fetched, is still
// loading, or does not contain the currently-stored id — the last case matters most:
// a channel the bot cannot see is exactly when an admin needs to be able to type the
// id, and a picker that silently blanks their configured value would be worse than
// the plain input this replaces.
//
// Declares its own option shape rather than importing one from lib/: the ESLint
// boundary forbids client code from reaching into server modules, and this component
// only ever renders what the action handed it.

export interface GuildChannelOption {
    id: string;
    name: string;
    /** 0=text, 2=voice, 5=announcement, 13=stage. */
    type: number;
}

interface Props {
    id: string;
    label: React.ReactNode;
    value: string;
    onChange: (next: string) => void;
    hint?: React.ReactNode;
    channels: GuildChannelOption[];
    /** True while the directory request is in flight. */
    loading?: boolean;
    /** Set when the directory could not be fetched — the field stays manual. */
    error?: string | null;
    disabled?: boolean;
}

const TYPE_PREFIX: Record<number, string> = { 0: '#', 2: '🔊', 5: '📢', 13: '🎙' };

const DiscordChannelField: React.FC<Props> = ({
    id, label, value, onChange, hint, channels, loading, error, disabled,
}) => {
    const trimmed = (value || '').trim();
    const known = useMemo(() => channels.some((c) => c.id === trimmed), [channels, trimmed]);

    // Manual whenever a picker could not represent the truth.
    const manual = !!error || loading || channels.length === 0 || (!!trimmed && !known);

    const manualReason = error
        ? 'Channel list unavailable — enter the ID manually.'
        : loading
            ? 'Loading channels…'
            : channels.length === 0
                ? 'No channels visible to the bot — enter the ID manually.'
                : 'This channel is not visible to the bot. Leaving the ID as typed.';

    return (
        <div>
            <label htmlFor={id} className="block text-sm font-medium text-slate-300 mb-2">{label}</label>
            {manual ? (
                <>
                    <input
                        type="text"
                        id={id}
                        name={id}
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                        placeholder="e.g., 123456789012345678"
                        disabled={disabled}
                        className="w-full bg-slate-700/50 border border-slate-600 rounded-md p-2.5 text-white font-mono disabled:opacity-50"
                    />
                    <p className="text-[11px] text-amber-400/80 mt-1">{manualReason}</p>
                </>
            ) : (
                <select
                    id={id}
                    name={id}
                    value={trimmed}
                    onChange={(e) => onChange(e.target.value)}
                    disabled={disabled}
                    className="w-full bg-slate-700/50 border border-slate-600 rounded-md p-2.5 text-white disabled:opacity-50"
                >
                    <option value="">— None —</option>
                    {channels.map((c) => (
                        <option key={c.id} value={c.id}>{(TYPE_PREFIX[c.type] || '#')} {c.name}</option>
                    ))}
                </select>
            )}
            {hint && <p className="text-xs text-slate-500 mt-1">{hint}</p>}
        </div>
    );
};

export default DiscordChannelField;
