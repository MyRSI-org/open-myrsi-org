
import { useEffect, useState, useCallback, useRef } from 'react';
import { Room, RoomEvent, Participant, Track, RemoteTrack, RemoteParticipant, LocalAudioTrack } from 'livekit-client';
import { useAuth } from '../contexts/AuthContext';
import { useData } from '../contexts/DataContext';
import { useConfig } from '../contexts/ConfigContext';
import { useHIDPTT } from '../contexts/HIDPTTContext';
import { playCachedSound } from '../lib/audioCache';
import { attachMicLevelMeter, MicLevelMeter } from '../lib/audio/micLevel';

interface UseOpRadioReturn {
    isConnected: boolean;
    isConnecting: boolean;
    isTransmitting: boolean;
    activeSpeakers: string[];
    participants: string[];
    error: string | null;
    volume: number;
    setVolume: (vol: number) => void;
    isMuted: boolean;
    toggleMute: () => void;
    handlePTT: (active: boolean) => void;
    connect: () => void;
    disconnect: () => void;
    /** RMS level (0–1) of the local mic while transmitting. 0 when idle. */
    localAudioLevel: number;
}

export function useOpRadio(operationId: string): UseOpRadioReturn {
    const { currentUser } = useAuth();
    const { rpcAction } = useData();
    const { brandingConfig } = useConfig();
    const { subscribePTT } = useHIDPTT();

    const [isConnected, setIsConnected] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const [isTransmitting, setIsTransmitting] = useState(false);
    const [activeSpeakers, setActiveSpeakers] = useState<string[]>([]);
    const [participants, setParticipants] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [volume, setVolume] = useState(50);
    const [isMuted, setIsMuted] = useState(false);
    const [localAudioLevel, setLocalAudioLevel] = useState(0);

    const roomRef = useRef<Room | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const gainNodesRef = useRef<Map<string, GainNode>>(new Map());
    const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
    const volumeRef = useRef(volume);
    // Keep the ref in sync with volume so async LiveKit event handlers (e.g.
    // TrackSubscribed) read the latest value without re-subscribing. Synced in
    // an effect rather than during render so we don't write a ref while rendering.
    useEffect(() => {
        volumeRef.current = volume;
    }, [volume]);
    const squelchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const prevSpeakerCount = useRef(0);

    // Local mic level analyser — runs only while transmitting (~30Hz).
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
        if (audioContextRef.current?.state === 'suspended') {
            audioContextRef.current.resume().catch(() => {});
        }
        // Cache-warmed playback — see lib/audioCache for rationale.
        playCachedSound(url, volume);
    }, [volume]);

    // Squelch debounce
    useEffect(() => {
        const incomingCount = activeSpeakers.length;
        if (prevSpeakerCount.current > 0 && incomingCount === 0) {
            if (squelchDebounceRef.current) clearTimeout(squelchDebounceRef.current);
            squelchDebounceRef.current = setTimeout(() => {
                if (activeSpeakers.length === 0) {
                    playSound(brandingConfig.radioSquelchUrl);
                }
            }, 1000);
        } else if (incomingCount > 0) {
            if (squelchDebounceRef.current) clearTimeout(squelchDebounceRef.current);
        }
        prevSpeakerCount.current = incomingCount;
    }, [activeSpeakers, brandingConfig.radioSquelchUrl, playSound]);

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
        setParticipants([local, ...remotes].filter(Boolean).sort() as string[]);
    }, []);

    const disconnect = useCallback(() => {
        const room = roomRef.current;
        if (room) {
            try { room.disconnect(); } catch (e) { console.warn('Op radio disconnect error:', e); }
            roomRef.current = null;
            setIsConnected(false);
            setIsTransmitting(false);
            setActiveSpeakers([]);
            setParticipants([]);
            stopMicMeter();

            gainNodesRef.current.forEach(node => node.disconnect());
            gainNodesRef.current.clear();
            audioElementsRef.current.forEach(el => { el.pause(); el.remove(); });
            audioElementsRef.current.clear();
        }
    }, [stopMicMeter]);

    const connect = useCallback(async () => {
        if (!currentUser || isConnecting) return;

        disconnect();
        setIsConnecting(true);
        setError(null);

        if (audioContextRef.current?.state === 'suspended') {
            audioContextRef.current.resume();
        }

        try {
            const { token, url, roomName } = await rpcAction('radio:op_auth', {
                participantName: currentUser.name,
                operationId,
            });

            const newRoom = new Room({ adaptiveStream: true, dynacast: true });

            newRoom.on(RoomEvent.Connected, () => {
                setIsConnected(true);
                setIsConnecting(false);
                updateParticipantList(newRoom);
            });

            newRoom.on(RoomEvent.Disconnected, () => {
                if (roomRef.current === newRoom) {
                    setIsConnected(false);
                    setIsTransmitting(false);
                    setActiveSpeakers([]);
                    setParticipants([]);
                    stopMicMeter();
                    roomRef.current = null;
                }
            });

            newRoom.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
                setActiveSpeakers(speakers.filter(p => !p.isLocal).map(p => p.name || p.identity));
            });

            newRoom.on(RoomEvent.ParticipantConnected, () => updateParticipantList(newRoom));
            newRoom.on(RoomEvent.ParticipantDisconnected, () => updateParticipantList(newRoom));

            newRoom.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
                if (!track.sid) return;
                if (track.kind === Track.Kind.Audio && audioContextRef.current) {
                    const element = track.attach();
                    element.volume = 1.0;
                    document.body.appendChild(element);
                    audioElementsRef.current.set(track.sid, element);

                    try {
                        const source = audioContextRef.current.createMediaElementSource(element);
                        const gainNode = audioContextRef.current.createGain();
                        gainNode.gain.value = (volumeRef.current / 100) * 3;
                        source.connect(gainNode);
                        gainNode.connect(audioContextRef.current.destination);
                        gainNodesRef.current.set(track.sid, gainNode);
                    } catch (e) {
                        console.error('Failed to setup op radio audio gain chain', e);
                    }
                }
            });

            newRoom.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
                if (!track.sid) return;
                const gainNode = gainNodesRef.current.get(track.sid);
                if (gainNode) { gainNode.disconnect(); gainNodesRef.current.delete(track.sid); }
                const element = audioElementsRef.current.get(track.sid);
                if (element) { element.remove(); audioElementsRef.current.delete(track.sid); }
                track.detach().forEach(el => el.remove());
            });

            await newRoom.connect(url, token);
            await newRoom.localParticipant.setMicrophoneEnabled(false);
            roomRef.current = newRoom;
        } catch (err: any) {
            console.error('Op Radio Error:', err);
            setError(err.message || 'Connection failed');
            setIsConnecting(false);
        }
    }, [currentUser, isConnecting, operationId, disconnect, rpcAction, updateParticipantList, stopMicMeter]);

    const handlePTT = useCallback(async (active: boolean) => {
        const room = roomRef.current;
        if (!room || !isConnected) return;

        try {
            if (active) {
                if (isMuted) return;
                if (!isTransmitting) {
                    setIsTransmitting(true);
                    await room.localParticipant.setMicrophoneEnabled(true);
                    if (audioContextRef.current?.state === 'suspended') audioContextRef.current.resume();
                    playSound(brandingConfig.radioMicCueUrl);

                    const micTrack = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
                    if (micTrack) startMicMeter(micTrack as LocalAudioTrack);
                }
            } else {
                if (isTransmitting || room.localParticipant.isMicrophoneEnabled) {
                    setIsTransmitting(false);
                    await room.localParticipant.setMicrophoneEnabled(false);
                    stopMicMeter();
                    playSound(brandingConfig.radioSquelchUrl);
                }
            }
        } catch (e) {
            console.error('Op Radio PTT Failed:', e);
            setIsTransmitting(false);
            stopMicMeter();
        }
    }, [isConnected, isMuted, isTransmitting, brandingConfig.radioMicCueUrl, brandingConfig.radioSquelchUrl, playSound, startMicMeter, stopMicMeter]);

    // WebHID/gamepad PTT — register a handler on each external PTT edge; setState
    // lives in the subscription callback (like the keyboard path), not an effect.
    const handlePTTRef = useRef(handlePTT);
    useEffect(() => {
        handlePTTRef.current = handlePTT;
    });
    useEffect(() => {
        return subscribePTT((active) => {
            if (isConnected) {
                handlePTTRef.current(active);
            }
        });
    }, [subscribePTT, isConnected]);

    // Volume updates for gain nodes
    useEffect(() => {
        gainNodesRef.current.forEach(gainNode => {
            gainNode.gain.value = (volume / 100) * 3;
        });
    }, [volume]);

    // Auto-disconnect on unmount
    useEffect(() => {
        const gainNodes = gainNodesRef.current;
        const audioElements = audioElementsRef.current;
        return () => {
            const room = roomRef.current;
            if (room) {
                try { room.disconnect(); } catch { /* ignore */ }
                roomRef.current = null;
            }
            if (micMeterRafRef.current !== null) {
                cancelAnimationFrame(micMeterRafRef.current);
                micMeterRafRef.current = null;
            }
            if (micMeterRef.current) {
                micMeterRef.current.dispose();
                micMeterRef.current = null;
            }
            gainNodes.forEach(node => node.disconnect());
            gainNodes.clear();
            audioElements.forEach(el => { el.pause(); el.remove(); });
            audioElements.clear();
        };
    }, []);

    const toggleMute = useCallback(() => setIsMuted(prev => !prev), []);

    return {
        isConnected, isConnecting, isTransmitting,
        activeSpeakers, participants, error,
        volume, setVolume, isMuted, toggleMute,
        handlePTT, connect, disconnect,
        localAudioLevel,
    };
}
