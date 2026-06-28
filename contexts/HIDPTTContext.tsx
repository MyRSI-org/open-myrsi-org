
import React, { createContext, use, useState, useCallback, useEffect, useRef } from 'react';
import { debugLog } from '../lib/debugLog';

// ── Types ──

interface HIDBinding {
    type: 'hid';
    vendorId: number;
    productId: number;
    deviceName: string;
    reportId: number;
    byteIndex: number;
    bitMask: number;
}

interface GamepadBinding {
    type: 'gamepad';
    gamepadIndex: number;
    buttonIndex: number;
    gamepadId: string;
}

type PTTBinding = HIDBinding | GamepadBinding;

interface DevicePTTContextType {
    isSupported: boolean;
    isPTTActive: boolean;
    pairedDeviceName: string | null;
    boundButtonLabel: string | null;
    isBinding: boolean;
    bindingPrompt: string | null;
    bindingError: string | null;
    bindGamepad: () => void;
    bindHID: () => Promise<void>;
    cancelBinding: () => void;
    unpair: () => void;
    subscribePTT: (cb: (active: boolean) => void) => () => void;
}

const STORAGE_KEY = 'devicePTTBinding';

const HIDPTTContext = createContext<DevicePTTContextType | null>(null);

function loadBinding(): PTTBinding | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function saveBinding(binding: PTTBinding) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(binding));
}

function clearBinding() {
    localStorage.removeItem(STORAGE_KEY);
}

function extractReportData(dataView: DataView): Uint8Array {
    return new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
}

function formatBindingLabel(binding: PTTBinding): string {
    if (binding.type === 'gamepad') {
        return `Button ${binding.buttonIndex}`;
    }
    const bits: number[] = [];
    for (let b = 0; b < 8; b++) {
        if (binding.bitMask & (1 << b)) bits.push(b);
    }
    return `Byte ${binding.byteIndex}, Bit ${bits.join('+')}`;
}

export const HIDPTTProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const hasGamepadAPI = typeof navigator !== 'undefined' && 'getGamepads' in navigator;
    const hasWebHID = typeof navigator !== 'undefined' && 'hid' in navigator;
    const isSupported = hasGamepadAPI || hasWebHID;

    const [isPTTActive, setIsPTTActive] = useState(false);
    // PTT edge pub/sub: consumers register a handler that runs on each press/
    // release EDGE, instead of watching isPTTActive in an effect (which would be
    // a set-state-in-effect). The isPTTActive STATE is retained for render
    // consumers (e.g. RadioWidget ACTIVE/IDLE dot). The edge dedupe here
    // replaces each consumer's former prevHIDPTTRef guard.
    const pttSubscribersRef = useRef(new Set<(active: boolean) => void>());
    const lastPTTRef = useRef(false);
    const setPTT = useCallback((active: boolean) => {
        if (lastPTTRef.current === active) return; // edge dedupe
        lastPTTRef.current = active;
        setIsPTTActive(active);
        pttSubscribersRef.current.forEach(cb => cb(active));
    }, []);
    const subscribePTT = useCallback((cb: (active: boolean) => void) => {
        pttSubscribersRef.current.add(cb);
        return () => { pttSubscribersRef.current.delete(cb); };
    }, []);
    const [pairedDeviceName, setPairedDeviceName] = useState<string | null>(() => {
        const b = loadBinding();
        if (!b) return null;
        return b.type === 'gamepad' ? b.gamepadId : b.type === 'hid' ? (b.deviceName || null) : null;
    });
    const [boundButtonLabel, setBoundButtonLabel] = useState<string | null>(() => {
        const b = loadBinding();
        return b ? formatBindingLabel(b) : null;
    });
    const [isBinding, setIsBinding] = useState(false);
    const [bindingPrompt, setBindingPrompt] = useState<string | null>(null);
    const [bindingError, setBindingError] = useState<string | null>(null);

    const bindingRef = useRef<PTTBinding | null>(null);
    const bindingModeRef = useRef<'gamepad' | 'hid' | false>(false);

    // ── Gamepad API ──
    // Use setInterval instead of requestAnimationFrame so polling continues in background tabs
    const gamepadPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const gamepadBaselineRef = useRef<Map<number, boolean[]> | null>(null);
    const gamepadBindTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const GAMEPAD_POLL_MS = 16; // ~60Hz when tab is focused, browsers throttle to ~1Hz in background

    const stopGamepadPoll = useCallback(() => {
        if (gamepadPollRef.current !== null) {
            clearInterval(gamepadPollRef.current);
            gamepadPollRef.current = null;
        }
    }, []);

    // Start normal-mode gamepad polling
    const startGamepadNormalPoll = useCallback(() => {
        stopGamepadPoll();
        gamepadPollRef.current = setInterval(() => {
            const binding = bindingRef.current;
            if (!binding || binding.type !== 'gamepad') return;

            const gamepads = navigator.getGamepads();
            const gp = gamepads[binding.gamepadIndex];
            if (gp && gp.buttons[binding.buttonIndex]) {
                setPTT(gp.buttons[binding.buttonIndex].pressed);
            }
        }, GAMEPAD_POLL_MS);
    }, [stopGamepadPoll, setPTT]);

    // Start binding-mode gamepad polling: detect which button is pressed
    const startGamepadBindingPoll = useCallback(() => {
        stopGamepadPoll();
        gamepadPollRef.current = setInterval(() => {
            if (bindingModeRef.current !== 'gamepad') return;

            const gamepads = navigator.getGamepads();
            const baselines = gamepadBaselineRef.current;

            for (let gi = 0; gi < gamepads.length; gi++) {
                const gp = gamepads[gi];
                if (!gp) continue;

                const baseline = baselines?.get(gi);
                if (!baseline) {
                    // Capture baseline for this gamepad (current button states)
                    if (!baselines) gamepadBaselineRef.current = new Map();
                    gamepadBaselineRef.current!.set(gi, gp.buttons.map(b => b.pressed));
                    continue;
                }

                // Check each button against baseline
                for (let bi = 0; bi < gp.buttons.length; bi++) {
                    if (bi >= baseline.length) continue;
                    if (gp.buttons[bi].pressed && !baseline[bi]) {
                        const binding: GamepadBinding = {
                            type: 'gamepad',
                            gamepadIndex: gi,
                            buttonIndex: bi,
                            gamepadId: gp.id,
                        };
                        bindingRef.current = binding;
                        saveBinding(binding);

                        const label = formatBindingLabel(binding);
                        bindingModeRef.current = false;
                        gamepadBaselineRef.current = null;
                        if (gamepadBindTimeoutRef.current) {
                            clearTimeout(gamepadBindTimeoutRef.current);
                            gamepadBindTimeoutRef.current = null;
                        }
                        setIsBinding(false);
                        setBindingPrompt(null);
                        setBindingError(null);
                        setBoundButtonLabel(label);
                        setPairedDeviceName(gp.id);
                        debugLog(`[Device PTT] Gamepad bound: ${gp.id}, button ${bi}`);

                        // Switch to normal-mode polling
                        startGamepadNormalPoll();
                        return;
                    }
                }
            }
        }, GAMEPAD_POLL_MS);
    }, [stopGamepadPoll, startGamepadNormalPoll]);

    // ── WebHID ──
    const hidDeviceRef = useRef<HIDDevice | null>(null);
    const hidSnapshotRef = useRef<{ data: Uint8Array; reportId: number } | null>(null);
    const hidBindResolveRef = useRef<(() => void) | null>(null);

    const handleHIDReport = useCallback((e: HIDInputReportEvent) => {
        const data = extractReportData(e.data);

        if (bindingModeRef.current === 'hid') {
            const snap = hidSnapshotRef.current;
            if (!snap) {
                hidSnapshotRef.current = { data: new Uint8Array(data), reportId: e.reportId };
                debugLog(`[Device PTT] HID Snapshot A: reportId=${e.reportId}, bytes=[${Array.from(data).map(b => '0x' + b.toString(16).padStart(2, '0')).join(',')}]`);
                return;
            }

            if (e.reportId !== snap.reportId) return;

            const isIdentical = data.length === snap.data.length &&
                data.every((byte, i) => byte === snap.data[i]);

            if (isIdentical) {
                // Polling device — keep updating snapshot
                hidSnapshotRef.current = { data: new Uint8Array(data), reportId: e.reportId };
                return;
            }

            debugLog(`[Device PTT] HID Snapshot B: reportId=${e.reportId}, bytes=[${Array.from(data).map(b => '0x' + b.toString(16).padStart(2, '0')).join(',')}]`);

            const minLen = Math.min(data.length, snap.data.length);
            for (let i = 0; i < minLen; i++) {
                const diff = data[i] ^ snap.data[i];
                if (diff !== 0) {
                    const device = hidDeviceRef.current!;
                    const binding: HIDBinding = {
                        type: 'hid',
                        vendorId: device.vendorId,
                        productId: device.productId,
                        deviceName: device.productName,
                        reportId: e.reportId,
                        byteIndex: i,
                        bitMask: diff,
                    };
                    bindingRef.current = binding;
                    saveBinding(binding);

                    const label = formatBindingLabel(binding);
                    bindingModeRef.current = false;
                    hidSnapshotRef.current = null;
                    setIsBinding(false);
                    setBindingPrompt(null);
                    setBindingError(null);
                    setBoundButtonLabel(label);
                    setPairedDeviceName(device.productName || `Device ${device.vendorId}:${device.productId}`);
                    debugLog(`[Device PTT] HID bound: ${label}, mask=0x${diff.toString(16)}`);
                    hidBindResolveRef.current?.();
                    hidBindResolveRef.current = null;
                    return;
                }
            }
            return;
        }

        // Normal mode
        const binding = bindingRef.current;
        if (!binding || binding.type !== 'hid') return;
        if (e.reportId !== binding.reportId) return;

        if (data.length > binding.byteIndex) {
            const pressed = (data[binding.byteIndex] & binding.bitMask) !== 0;
            setPTT(pressed);
        }
    }, [setPTT]);

    const cleanupHIDDevice = useCallback(() => {
        if (hidDeviceRef.current) {
            hidDeviceRef.current.removeEventListener('inputreport', handleHIDReport);
            hidDeviceRef.current.close().catch(() => {});
            hidDeviceRef.current = null;
        }
    }, [handleHIDReport]);

    const bindGamepad = useCallback(() => {
        if (!hasGamepadAPI) return;

        stopGamepadPoll();
        cleanupHIDDevice();

        bindingModeRef.current = 'gamepad';
        gamepadBaselineRef.current = null;
        setIsBinding(true);
        setBindingError(null);
        setBoundButtonLabel(null);
        setBindingPrompt('Press any button on your controller...');

        // Check if any gamepads are connected
        const gamepads = navigator.getGamepads();
        const hasConnected = Array.from(gamepads).some(g => g !== null);
        if (!hasConnected) {
            setBindingError('No controller detected. Press a button on your controller to wake it up, then try again.');
        }

        // Start binding poll
        startGamepadBindingPoll();

        // Timeout after 20 seconds
        if (gamepadBindTimeoutRef.current) clearTimeout(gamepadBindTimeoutRef.current);
        gamepadBindTimeoutRef.current = setTimeout(() => {
            if (bindingModeRef.current === 'gamepad') {
                bindingModeRef.current = false;
                stopGamepadPoll();
                gamepadBaselineRef.current = null;
                setIsBinding(false);
                setBindingPrompt(null);
                setBindingError('Binding timed out. Make sure your controller is connected and try again.');
            }
            gamepadBindTimeoutRef.current = null;
        }, 20000);
    }, [hasGamepadAPI, stopGamepadPoll, startGamepadBindingPoll, cleanupHIDDevice]);

    const openHIDDevice = useCallback(async (device: HIDDevice, binding: HIDBinding | null) => {
        if (!device.opened) {
            await device.open();
        }
        device.addEventListener('inputreport', handleHIDReport);
        hidDeviceRef.current = device;
        if (binding) bindingRef.current = binding;
        const name = device.productName || `Device ${device.vendorId}:${device.productId}`;
        setPairedDeviceName(name);
        if (binding) setBoundButtonLabel(formatBindingLabel(binding));
        debugLog(`[Device PTT] HID opened: ${name}`);
        debugLog(`[Device PTT] Collections:`, device.collections?.map(c =>
            `usagePage=0x${c.usagePage.toString(16)}, usage=0x${c.usage.toString(16)}`
        ));
    }, [handleHIDReport]);

    const bindHID = useCallback(async () => {
        if (!hasWebHID) return;

        stopGamepadPoll();
        cleanupHIDDevice();

        setBindingError(null);

        try {
            const devices: HIDDevice[] = await navigator.hid.requestDevice({ filters: [] });
            if (!devices.length) return;

            const device = devices[0];
            await openHIDDevice(device, null);

            bindingModeRef.current = 'hid';
            hidSnapshotRef.current = null;
            setIsBinding(true);
            setBoundButtonLabel(null);
            setBindingPrompt('Press the button you want to use for PTT...');

            await new Promise<void>((resolve) => {
                hidBindResolveRef.current = resolve;

                const warningTimer = setTimeout(() => {
                    if (bindingModeRef.current === 'hid') {
                        setBindingError('No input received. Chrome blocks keyboards, mice, and game controllers from WebHID. For controllers, use "Bind Controller" instead.');
                    }
                }, 5000);

                const timeoutTimer = setTimeout(() => {
                    if (bindingModeRef.current === 'hid') {
                        bindingModeRef.current = false;
                        hidSnapshotRef.current = null;
                        setIsBinding(false);
                        setBindingPrompt(null);
                        setBindingError('Binding timed out. This device may be blocked by Chrome. For game controllers, use "Bind Controller" instead.');
                        resolve();
                    }
                }, 20000);

                const origResolve = hidBindResolveRef.current;
                hidBindResolveRef.current = () => {
                    clearTimeout(warningTimer);
                    clearTimeout(timeoutTimer);
                    origResolve?.();
                };
            });
        } catch (e: any) {
            if (e.name !== 'NotAllowedError') {
                console.error('[Device PTT] HID pairing failed:', e);
                setBindingError(`Pairing failed: ${e.message}`);
            }
            setIsBinding(false);
            setBindingPrompt(null);
        }
    }, [hasWebHID, stopGamepadPoll, cleanupHIDDevice, openHIDDevice]);

    // ── Restore saved binding on mount ──
    useEffect(() => {
        const binding = loadBinding();
        if (!binding) return;

        bindingRef.current = binding;

        if (binding.type === 'gamepad' && hasGamepadAPI) {
            startGamepadNormalPoll();
        }

        if (binding.type === 'hid' && hasWebHID) {
            (async () => {
                try {
                    const devices = await navigator.hid.getDevices();
                    const match = devices.find((d: HIDDevice) =>
                        d.vendorId === binding.vendorId && d.productId === binding.productId
                    );
                    if (match) {
                        await openHIDDevice(match, binding);
                        debugLog('[Device PTT] HID auto-reconnected');
                    }
                } catch (e) {
                    console.warn('[Device PTT] HID auto-reconnect failed:', e);
                }
            })();
        }

        return () => {
            if (gamepadPollRef.current !== null) {
                clearInterval(gamepadPollRef.current);
                gamepadPollRef.current = null;
            }
            cleanupHIDDevice();
        };
    }, [hasGamepadAPI, hasWebHID, startGamepadNormalPoll, openHIDDevice, cleanupHIDDevice]);

    // ── Gamepad connect/disconnect events ──
    useEffect(() => {
        if (!hasGamepadAPI) return;

        const onConnected = (e: GamepadEvent) => {
            debugLog(`[Device PTT] Gamepad connected: ${e.gamepad.id} (index ${e.gamepad.index})`);
            // If we're in binding mode and had "no controller" error, clear it
            if (bindingModeRef.current === 'gamepad') {
                setBindingError(null);
            }
        };

        window.addEventListener('gamepadconnected', onConnected);
        return () => window.removeEventListener('gamepadconnected', onConnected);
    }, [hasGamepadAPI]);

    // ── HID disconnect/reconnect events ──
    useEffect(() => {
        if (!hasWebHID) return;

        const onDisconnect = (e: Event) => {
            const event = e as HIDConnectionEvent;
            if (hidDeviceRef.current && event.device === hidDeviceRef.current) {
                hidDeviceRef.current = null;
                setPairedDeviceName(prev => prev ? `${prev} (disconnected)` : null);
                setPTT(false);
            }
        };

        const onConnect = (e: Event) => {
            const event = e as HIDConnectionEvent;
            const binding = bindingRef.current;
            if (binding && binding.type === 'hid' && !hidDeviceRef.current &&
                event.device.vendorId === binding.vendorId &&
                event.device.productId === binding.productId) {
                openHIDDevice(event.device, binding).catch(() => {});
            }
        };

        navigator.hid.addEventListener('connect', onConnect);
        navigator.hid.addEventListener('disconnect', onDisconnect);
        return () => {
            navigator.hid.removeEventListener('connect', onConnect);
            navigator.hid.removeEventListener('disconnect', onDisconnect);
        };
    }, [hasWebHID, openHIDDevice, setPTT]);

    // ── Shared actions ──
    const cancelBinding = useCallback(() => {
        bindingModeRef.current = false;
        stopGamepadPoll();
        if (gamepadBindTimeoutRef.current) {
            clearTimeout(gamepadBindTimeoutRef.current);
            gamepadBindTimeoutRef.current = null;
        }
        gamepadBaselineRef.current = null;
        hidSnapshotRef.current = null;
        setIsBinding(false);
        setBindingPrompt(null);
        setBindingError(null);

        // Restart normal polling if we have a gamepad binding
        const binding = bindingRef.current;
        if (binding?.type === 'gamepad') {
            startGamepadNormalPoll();
        }
    }, [stopGamepadPoll, startGamepadNormalPoll]);

    const unpair = useCallback(() => {
        stopGamepadPoll();
        cleanupHIDDevice();
        bindingRef.current = null;
        clearBinding();
        setPairedDeviceName(null);
        setBoundButtonLabel(null);
        setPTT(false);
        setIsBinding(false);
        setBindingPrompt(null);
        setBindingError(null);
    }, [stopGamepadPoll, cleanupHIDDevice, setPTT]);

    const value: DevicePTTContextType = {
        isSupported,
        isPTTActive,
        pairedDeviceName,
        boundButtonLabel,
        isBinding,
        bindingPrompt,
        bindingError,
        bindGamepad,
        bindHID,
        cancelBinding,
        unpair,
        subscribePTT,
    };

    return <HIDPTTContext value={value}>{children}</HIDPTTContext>;
};

export const useHIDPTT = () => {
    const context = use(HIDPTTContext);
    if (!context) throw new Error('useHIDPTT must be used within HIDPTTProvider');
    return context;
};
