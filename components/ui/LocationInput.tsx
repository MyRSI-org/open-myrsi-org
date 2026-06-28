import React, { useState, useEffect, useRef } from 'react';
import apiService from '../../services/apiService';
import type { PlatformLocation } from '../../types';

interface LocationInputProps {
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
}

const MIN_QUERY_LEN = 2;
const MAX_SUGGESTIONS = 10;
const DEBOUNCE_MS = 250;

const LocationInput: React.FC<LocationInputProps> = ({ value, onChange, disabled }) => {
    const [inputValue, setInputValue] = useState(value);
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [loading, setLoading] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const requestSeqRef = useRef(0);
    // Skip the next debounced search after the user clicks a suggestion —
    // setting inputValue programmatically would otherwise re-fire the search
    // and reopen the dropdown.
    const skipNextSearchRef = useRef(false);

    // Sync the local typeahead buffer when the controlled `value` prop changes
    // externally (e.g. parent resets the form). `inputValue` diverges from
    // `value` while the user types, so it cannot be derived during render; this
    // is the React "adjust state during render" pattern (prev-value tracker),
    // behaviour-equivalent to a prop->state sync effect but without the extra
    // commit-and-effect round-trip.
    const [prevValue, setPrevValue] = useState(value);
    if (value !== prevValue) {
        setPrevValue(value);
        setInputValue(value);
    }

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setShowSuggestions(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Debounced location search. The debounce timer lives inside the effect so
    // the fetch-start loading signal and the result/clear setState calls all run
    // in the setTimeout callback (an async boundary) rather than synchronously in
    // the effect body. skipNextSearchRef is read inside the timer (not during
    // render), so a programmatic setInputValue from a suggestion click neither
    // fires a search nor raises a spinner.
    useEffect(() => {
        const q = inputValue.trim();
        const tooShort = q.length < MIN_QUERY_LEN;
        const timer = setTimeout(() => {
            if (tooShort) {
                // Below the minimum length — clear any prior results + spinner.
                setSuggestions([]);
                setLoading(false);
            }
            if (skipNextSearchRef.current) {
                skipNextSearchRef.current = false;
                return;
            }
            if (tooShort) return;
            const seq = ++requestSeqRef.current;
            setLoading(true);
            // Search via the standard authenticated RPC endpoint
            // (apiService.rpc -> /api/services).
            apiService.rpc('system:search_locations', { query: q, limit: MAX_SUGGESTIONS })
                .then((res: { data?: PlatformLocation[] } | PlatformLocation[] | undefined) => {
                    // /api/services wraps the handler return as { success, data: ... }.
                    const rows = Array.isArray(res) ? res : (res?.data ?? []);
                    if (seq !== requestSeqRef.current) return;
                    const labels = (rows || [])
                        .map((r) => (r.path && r.path.length > 0 ? r.path : r.name))
                        .filter((s): s is string => !!s);
                    // Dedupe — different rows can share a path string in edge cases.
                    setSuggestions(Array.from(new Set(labels)).slice(0, MAX_SUGGESTIONS));
                })
                .catch((err) => {
                    if (seq !== requestSeqRef.current) return;
                    console.warn('[LocationInput] search failed:', err?.message);
                    setSuggestions([]);
                })
                .finally(() => {
                    if (seq === requestSeqRef.current) setLoading(false);
                });
        }, DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [inputValue]);

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const text = e.target.value;
        setInputValue(text);
        onChange(text);
        setShowSuggestions(text.trim().length >= MIN_QUERY_LEN);
    };

    const handleSuggestionClick = (suggestion: string) => {
        skipNextSearchRef.current = true;
        setInputValue(suggestion);
        onChange(suggestion);
        setSuggestions([]);
        setShowSuggestions(false);
    };

    const showDropdown = showSuggestions && (loading || suggestions.length > 0);

    return (
        <div className="relative w-full" ref={containerRef}>
            <input
                type="text"
                value={inputValue}
                onChange={handleInputChange}
                onFocus={() => setShowSuggestions(inputValue.trim().length >= MIN_QUERY_LEN)}
                placeholder="e.g., Stanton > Crusader > Yela > Grim HEX"
                className="w-full bg-slate-700/50 border border-slate-600 rounded-md p-2.5 text-white focus:ring-2 focus:ring-sky-500 focus:border-sky-500 outline-hidden"
                required
                disabled={disabled}
                autoComplete="off"
            />
            {showDropdown && (
                <ul className="absolute z-10 w-full mt-1 bg-slate-800 border border-slate-600 rounded-md shadow-lg max-h-60 overflow-y-auto">
                    {loading && suggestions.length === 0 && (
                        <li className="px-4 py-2 text-sm text-slate-500 italic">
                            <i className="fa-solid fa-spinner fa-spin mr-2" /> Searching…
                        </li>
                    )}
                    {suggestions.map((suggestion) => (
                        <li
                            key={suggestion}
                            onClick={() => handleSuggestionClick(suggestion)}
                            className="px-4 py-2 text-sm text-slate-300 hover:bg-sky-500/10 hover:text-white cursor-pointer"
                        >
                            {suggestion}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

export default LocationInput;
