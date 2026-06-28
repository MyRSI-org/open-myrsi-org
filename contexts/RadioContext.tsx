
import React, { createContext, use, useEffect, useState, useCallback, useRef } from 'react';
import { Room, RoomEvent, Participant, Track, RemoteParticipant, RemoteTrack, LocalAudioTrack } from 'livekit-client';
import { useAuth } from './AuthContext';
import { useData } from './DataContext';
import { useHIDPTT } from './HIDPTTContext';
import { RadioChannel } from '../types';
import { playCachedSound } from '../lib/audioCache';
import { attachMicLevelMeter, MicLevelMeter } from '../lib/audio/micLevel';
import { debugLog } from '../lib/debugLog';

interface RadioContextType {
    isConnected: boolean;
    isConnecting: boolean;
    isTransmitting: boolean;
    isEnabled: boolean;
    setIsEnabled: (enabled: boolean) => void;
    currentChannel: RadioChannel | null;
    setChannel: (channel: RadioChannel) => Promise<void>;
    disconnect: () => void;
    activeSpeakers: string[];
    participants: string[];
    error: string | null;
    volume: number;
    setVolume: (vol: number) => void;
    isMuted: boolean;
    toggleMute: () => void;
    handlePTT: (active: boolean) => void;
    /** RMS level (0–1) of the local mic while transmitting. 0 when idle. */
    localAudioLevel: number;
}

const RadioContext = createContext<RadioContextType | null>(null);

export const RadioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { currentUser } = useAuth();
    const { brandingConfig, radioChannels, rpcAction } = useData();
    const { subscribePTT } = useHIDPTT();

    const [isEnabled, setIsEnabled] = useState(false);
    const [isConnected, setIsConnected] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const [isTransmitting, setIsTransmitting] = useState(false);
    const [activeSpeakers, setActiveSpeakers] = useState<string[]>([]);
    const [participants, setParticipants] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [room, setRoom] = useState<Room | null>(null);
    const [volume, setVolume] = useState(50);
    const [isMuted, setIsMuted] = useState(false);
    const [currentChannel, setCurrentChannel] = useState<RadioChannel | null>(null);
    const [localAudioLevel, setLocalAudioLevel] = useState(0);

    // Audio Context for Volume Boosting
    const audioContextRef = useRef<AudioContext | null>(null);
    const gainNodesRef = useRef<Map<string, GainNode>>(new Map());
    const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
    const volumeRef = useRef(volume); // Stable ref for use in connectToChannel without causing reconnects
    // volumeRef is kept in sync with `volume` inside the volume effect below
    // (refs must not be written during render).

    // Local mic level analyser — attached on PTT down, disposed on PTT up.
    // Polled via rAF (~30Hz) while transmitting so the TX meter reflects
    // outgoing voice energy.
    const micMeterRef = useRef<MicLevelMeter | null>(null);
    const micMeterRafRef = useRef<number | null>(null);

    const stopMicMeter = useCallback(() => {
        if (micMeterRafRef.current !== null) {
            cancelAnimationFrame(micMeterRafRef.current);
            micMeterRafRef.current = null;
        }
        if (micMeterRef.current) {
            micMeterRef.current.dispose();
            micMeterRef.current = null;
        }
        setLocalAudioLevel(0);
    }, []);

    const startMicMeter = useCallback((track: LocalAudioTrack) => {
        stopMicMeter();
        const meter = attachMicLevelMeter(track);
        if (!meter) return;
        micMeterRef.current = meter;
        // Throttle: read on every other frame (~30Hz) — smooth enough for
        // perception, half the React re-renders.
        let frameToggle = false;
        const tick = () => {
            if (!micMeterRef.current) return;
            frameToggle = !frameToggle;
            if (frameToggle) {
                setLocalAudioLevel(micMeterRef.current.getLevel());
            }
            micMeterRafRef.current = requestAnimationFrame(tick);
        };
        micMeterRafRef.current = requestAnimationFrame(tick);
    }, [stopMicMeter]);

    // Debounce for squelch to prevent triggering on micro-pauses in speech (VAD gaps)
    const squelchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const prevSpeakerCountRef = useRef(0);

    // Initialize AudioContext
    useEffect(() => {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) {
            audioContextRef.current = new AudioCtx();
        }
        return () => {
            audioContextRef.current?.close().catch(() => {});
        };
    }, []);

    const playSound = useCallback((url: string | undefined) => {
        if (!url) return;
        // Resume AudioContext if suspended (browser auto-play policy)
        if (audioContextRef.current?.state === 'suspended') {
            audioContextRef.current.resume().catch(() => {});
        }
        // Routed through audio cache: squelch/mic-cue clips are warmed at
        // brandingConfig load so the first transmission isn't delayed.
        playCachedSound(url, volume);
    }, [volume]);

    useEffect(() => {
        const incomingCount = activeSpeakers.length;

        // Transition from Speaking -> Silence
        if (prevSpeakerCountRef.current > 0 && incomingCount === 0) {
            if (squelchDebounceRef.current) clearTimeout(squelchDebounceRef.current);

            // Increased to 1000ms to prevent squelch spam during breath pauses
            squelchDebounceRef.current = setTimeout(() => {
                // Double check we are still silent
                if (activeSpeakers.length === 0) {
                    playSound(brandingConfig.radioSquelchUrl);
                }
            }, 1000);
        } else if (incomingCount > 0) {
            // If speech detected, clear any pending squelch immediately
            if (squelchDebounceRef.current) clearTimeout(squelchDebounceRef.current);
        }

        prevSpeakerCountRef.current = incomingCount;
    }, [activeSpeakers, brandingConfig.radioSquelchUrl, playSound]);

    const disconnect = useCallback(() => {
        if (room) {
            try {
                room.disconnect();
            } catch (e) {
                console.warn("Error disconnecting room:", e);
            }
            setRoom(null);
            setIsConnected(false);
            setIsTransmitting(false);
            setActiveSpeakers([]);
            setParticipants([]);
            stopMicMeter();

            // Cleanup Audio Nodes
            gainNodesRef.current.forEach(node => node.disconnect());
            gainNodesRef.current.clear();
            audioElementsRef.current.forEach(el => {
                el.pause();
                el.remove();
            });
            audioElementsRef.current.clear();

            // Clear voice channel in DB so comms matrix is accurate
            if (currentUser) {
                rpcAction('user:set_radio_channel', { userId: currentUser.id, channelName: null })
                    .catch(e => console.warn("Failed to clear radio channel in DB:", e));
            }
        }
    }, [room, currentUser, rpcAction, stopMicMeter]);

    // Handle tab close/refresh cleanup
    useEffect(() => {
        const cleanup = () => {
            if (room) {
                room.disconnect();
            }
            // Best-effort clear voice channel in DB on tab close via sendBeacon
            if (currentUser && isConnected) {
                try {
                    const payload = JSON.stringify({ action: 'user:set_radio_channel', payload: { userId: currentUser.id, channelName: null } });
                    navigator.sendBeacon('/api/services', new Blob([payload], { type: 'application/json' }));
                } catch { /* ignore beacon errors */ }
            }
        };
        window.addEventListener('beforeunload', cleanup);
        return () => window.removeEventListener('beforeunload', cleanup);
    }, [room, currentUser, isConnected]);

    const updateParticipantList = useCallback((r: Room) => {
        if (!r) return;

        const remotesMap = r.remoteParticipants;
        if (!remotesMap) {
            const local = r.localParticipant?.name || r.localParticipant?.identity;
            setParticipants(local ? [local] : []);
            return;
        }

        const remotes = Array.from(remotesMap.values()).map((p: RemoteParticipant) => p.name || p.identity);
        const local = r.localParticipant?.name || r.localParticipant?.identity;

        const list = [local, ...remotes].filter(Boolean).sort();
        setParticipants(list);
    }, []);

    const connectToChannel = useCallback(async (channel: RadioChannel) => {
        if (!currentUser) return;

        const roomName = `radio-${channel.id}`;

        if (!isEnabled) {
            setIsEnabled(true);
        }

        if ((isConnected || isConnecting) && room?.name === roomName) {
            if (currentChannel?.id !== channel.id) setCurrentChannel(channel);
            return;
        }

        disconnect();
        setIsConnecting(true);
        setError(null);
        setCurrentChannel(channel);

        // Resume AudioContext context on user interaction (channel switch)
        if (audioContextRef.current?.state === 'suspended') {
            audioContextRef.current.resume();
        }

        try {
            const { token, url } = await rpcAction('radio:auth', {
                roomName,
                participantName: currentUser.name
            });

            const newRoom = new Room({
                adaptiveStream: true,
                dynacast: true,
            });

            newRoom.on(RoomEvent.Connected, () => {
                setIsConnected(true);
                setIsConnecting(false);
                updateParticipantList(newRoom);
            });

            newRoom.on(RoomEvent.Disconnected, () => {
                setRoom(prev => {
                    if (prev === newRoom) {
                        setIsConnected(false);
                        setIsTransmitting(false);
                        setActiveSpeakers([]);
                        setParticipants([]);
                        stopMicMeter();
                        return null;
                    }
                    return prev;
                });
            });

            newRoom.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
                setActiveSpeakers(speakers.filter(p => !p.isLocal).map(p => p.name || p.identity));
            });

            newRoom.on(RoomEvent.ParticipantConnected, () => updateParticipantList(newRoom));
            newRoom.on(RoomEvent.ParticipantDisconnected, () => updateParticipantList(newRoom));

            newRoom.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication, participant) => {
                if (!track.sid) return;
                if (track.kind === Track.Kind.Audio && audioContextRef.current) {
                    // 1. Create HTML Audio Element (standard attachment)
                    const element = track.attach();
                    element.volume = 1.0; // Set base element volume to max, we control gain later
                    document.body.appendChild(element);
                    audioElementsRef.current.set(track.sid, element);

                    // 2. Create Web Audio API Chain for Amplification
                    try {
                        const source = audioContextRef.current.createMediaElementSource(element);
                        const gainNode = audioContextRef.current.createGain();

                        // Map 0-100 volume to 0.0 - 3.0 Gain (300% boost max)
                        gainNode.gain.value = (volumeRef.current / 100) * 3;

                        source.connect(gainNode);
                        gainNode.connect(audioContextRef.current.destination);

                        gainNodesRef.current.set(track.sid, gainNode);
                    } catch (e) {
                        console.error("Failed to setup audio gain chain", e);
                    }
                }
            });

            newRoom.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
                if (!track.sid) return;
                // Cleanup audio chain
                const gainNode = gainNodesRef.current.get(track.sid);
                if (gainNode) {
                    gainNode.disconnect();
                    gainNodesRef.current.delete(track.sid);
                }

                const element = audioElementsRef.current.get(track.sid);
                if (element) {
                    element.remove();
                    audioElementsRef.current.delete(track.sid);
                }

                track.detach().forEach(el => el.remove());
            });

            await newRoom.connect(url, token);
            await newRoom.localParticipant.setMicrophoneEnabled(false);
            setRoom(newRoom);
        } catch (err: any) {
            console.error("Radio Error:", err);
            setError(err.message || 'Link error');
            setIsConnecting(false);
        }
    }, [currentUser, isEnabled, isConnected, isConnecting, room, disconnect, rpcAction, updateParticipantList, currentChannel, stopMicMeter]);

    const setChannel = useCallback(async (channel: RadioChannel) => {
        try {
            if (currentUser) {
                const roomName = `radio-${channel.id}`;
                if (currentUser.voiceChannelName !== roomName) {
                    rpcAction('user:set_radio_channel', { userId: currentUser.id, channelName: roomName })
                        .catch(e => console.warn("Failed to sync radio channel to DB:", e));
                }
            }
        } catch (e) {
            console.warn("Failed to initiate DB sync:", e);
        }
        await connectToChannel(channel);
    }, [currentUser, rpcAction, connectToChannel]);

    // Sync with DB state (Remote Control)
    useEffect(() => {
        if (currentUser?.voiceChannelName && isEnabled) {
            const targetRoom = currentUser.voiceChannelName;
            if (room?.name !== targetRoom) {
                const channelId = targetRoom.replace('radio-', '');
                if (!channelId) return;

                // Prevent infinite retry loop and fighting between local optimistic update and stale DB state
                if (isConnecting) return;
                if (currentChannel?.id === channelId && error) return;

                const channel = radioChannels.find(c => c.id === channelId) || { id: channelId, name: channelId, color: '#38bdf8' };
                if (channel) {
                    debugLog(`[Radio] Syncing to remote channel: ${channel.name}`);
                    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronizes the LiveKit connection to remote DB-driven channel state; not derived render state, and the surrounding guards (room?.name check, isConnecting/error gates) prevent a reconnect loop.
                    connectToChannel(channel as RadioChannel);
                }
            }
        }
    }, [currentUser?.voiceChannelName, isEnabled, room?.name, radioChannels, connectToChannel, isConnecting, currentChannel, error]);

    const handlePTT = useCallback(async (active: boolean) => {
        if (!room || !isConnected) return;

        try {
            if (active) {
                if (isMuted) return;

                if (!isTransmitting) {
                    setIsTransmitting(true);
                    await room.localParticipant.setMicrophoneEnabled(true);
                    // Resume audio context if needed
                    if (audioContextRef.current?.state === 'suspended') audioContextRef.current.resume();
                    playSound(brandingConfig.radioMicCueUrl);

                    // Pull the live mic track and wire the level analyser.
                    const micTrack = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
                    if (micTrack) startMicMeter(micTrack as LocalAudioTrack);
                }
            } else {
                if (isTransmitting || room.localParticipant.isMicrophoneEnabled) {
                    setIsTransmitting(false);
                    await room.localParticipant.setMicrophoneEnabled(false);
                    stopMicMeter();
                    // Local squelch cue on own PTT release.
                    playSound(brandingConfig.radioSquelchUrl);
                }
            }
        } catch (e) {
            console.error("PTT Action Failed:", e);
            // Reset transmitting state on failure (e.g. connection lost).
            setIsTransmitting(false);
            stopMicMeter();
        }
    }, [room, isConnected, isMuted, isTransmitting, brandingConfig.radioMicCueUrl, brandingConfig.radioSquelchUrl, playSound, startMicMeter, stopMicMeter]);

    useEffect(() => {
        const onDown = (e: KeyboardEvent) => {
            if (e.code === 'ControlRight' && !e.repeat && isEnabled) {
                e.preventDefault();
                handlePTT(true);
            }
        };
        const onUp = (e: KeyboardEvent) => {
            if (e.code === 'ControlRight') {
                handlePTT(false);
            }
        };
        window.addEventListener('keydown', onDown);
        window.addEventListener('keyup', onUp);
        return () => {
            window.removeEventListener('keydown', onDown);
            window.removeEventListener('keyup', onUp);
        };
    }, [isEnabled, handlePTT]);

    // WebHID/gamepad PTT — register a handler that runs on each external PTT
    // button edge, mirroring the keyboard-PTT path above (setState lives in the
    // subscription callback, not an effect body). Edge dedupe is in HIDPTTContext's
    // setPTT; the isEnabled/isConnected gate matches the prior effect's inner gate.
    const handlePTTRef = useRef(handlePTT);
    useEffect(() => {
        handlePTTRef.current = handlePTT;
    });
    useEffect(() => {
        return subscribePTT((active) => {
            if (isEnabled && isConnected) {
                handlePTTRef.current(active);
            }
        });
    }, [subscribePTT, isEnabled, isConnected]);

    useEffect(() => {
        if (!isEnabled) {
            // Tears down the LiveKit connection (external system) and clears the
            // selected channel when the radio feature is switched off. Kept as an
            // effect (not a setter wrapper) because its `disconnect` dependency is
            // re-created whenever `room` changes, so the effect re-runs and also
            // tears down a room that arrives from an in-flight connectToChannel
            // AFTER the radio was disabled — self-healing a connect/disable race
            // that a one-shot setter wrapper cannot. Runs only on the isEnabled
            // false-edge (or a late room), so no render loop.
            // eslint-disable-next-line react-hooks/set-state-in-effect -- teardown of external LiveKit connection on feature-disable, not derived render state
            disconnect();
            setCurrentChannel(null);
        }
    }, [isEnabled, disconnect]);

    // Volume updates for Gain Nodes
    useEffect(() => {
        // Keep the stable ref in sync so newly-subscribed tracks pick up the
        // current volume without re-creating connectToChannel.
        volumeRef.current = volume;
        gainNodesRef.current.forEach(gainNode => {
            gainNode.gain.value = (volume / 100) * 3;
        });
    }, [volume]);

    const toggleMute = () => setIsMuted(prev => !prev);

    const value = {
        isConnected, isConnecting, isTransmitting, isEnabled, setIsEnabled,
        currentChannel, setChannel, disconnect, activeSpeakers, participants, error,
        volume, setVolume, isMuted, toggleMute, handlePTT, localAudioLevel
    };

    return <RadioContext value={value}>{children}</RadioContext>;
};

export const useRadio = () => {
    const context = use(RadioContext);
    if (!context) throw new Error('useRadio must be used within RadioProvider');
    return context;
};
