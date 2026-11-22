import { useEffect, useRef, useState } from 'react';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import {
  Camera,
  CameraOff,
  ChevronLeft,
  ChevronRight,
  FilePlus2,
  Flag,
  Keyboard,
  Loader2,
  Maximize2,
  MessageSquare,
  Mic,
  MicOff,
  Minimize2,
  PhoneOff,
  RefreshCw,
  Send,
  ShieldAlert,
  Users,
  Video,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type { UiStrings } from '../i18n';
import { getLanguageByCode, WORLD_LANGUAGES } from '../languages';
import type { UserProfile } from '../types';
import { blobToBase64, playWavBase64 } from '../utils/audio';
import { sanitizeClientText } from '../utils/safety';

interface OmegleVideoMatchProps {
  profile: UserProfile | null;
  myLang: string;
  onChangeMyLang: (code: string) => void;
  voiceName: string;
  allowRandomMatch: boolean;
  ui: UiStrings;
  onRequireAuth: () => void;
  onAddAgreement: (original: string, translated: string, owner: string) => void;
}

interface PartnerInfo {
  peerId: string;
  uid: string;
  displayName: string;
  handle: string;
  langCode: string;
  langName: string;
  mediaMode?: 'video' | 'text';
}

interface SubtitleMessage {
  id: string;
  senderPeerId: string;
  senderName: string;
  sourceLang: string;
  originalText: string;
  translatedText: string;
  timestamp: string;
}

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export function OmegleVideoMatch({
  profile,
  myLang,
  onChangeMyLang,
  voiceName,
  allowRandomMatch,
  ui,
  onRequireAuth,
  onAddAgreement,
}: OmegleVideoMatchProps) {
  const [guestName, setGuestName] = useState(
    () => `Misafir-${Math.floor(100 + Math.random() * 900)}`
  );
  const [filterLang, setFilterLang] = useState('all');
  const [matchState, setMatchState] = useState<'idle' | 'searching' | 'connected'>('idle');
  const [activeMediaMode, setActiveMediaMode] = useState<'video' | 'text'>('video');
  const [queueStats, setQueueStats] = useState({ waitingCount: 0, onlineCount: 0 });
  const [partner, setPartner] = useState<PartnerInfo | null>(null);

  const [isFullscreenCall, setIsFullscreenCall] = useState(false);
  const [showMobileChatDrawer, setShowMobileChatDrawer] = useState(false);
  const [pipCorner, setPipCorner] = useState<
    'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'
  >('top-right');
  const [pipDragOffset, setPipDragOffset] = useState<{ x: number; y: number } | null>(null);
  const [stageSwipeDx, setStageSwipeDx] = useState(0);

  const pipDragStartRef = useRef<{ x: number; y: number } | null>(null);
  const stageSwipeStartRef = useRef<{ x: number; y: number } | null>(null);

  const [camEnabled, setCamEnabled] = useState(true);
  const [micEnabled, setMicEnabled] = useState(true);
  const [mutePartnerRawAudio, setMutePartnerRawAudio] = useState(false);
  const [autoTranslateSpeech, setAutoTranslateSpeech] = useState(true);
  const [autoSpeakTranslation, setAutoSpeakTranslation] = useState(true);

  const [isRecordingPush, setIsRecordingPush] = useState(false);
  const [isTranslatingChunk, setIsTranslatingChunk] = useState(false);
  const [activeSubtitle, setActiveSubtitle] = useState<{
    speaker: string;
    original: string;
    translated: string;
  } | null>(null);
  const [chatFeed, setChatFeed] = useState<SubtitleMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [reportNotice, setReportNotice] = useState<string | null>(null);
  const [infoNotice, setInfoNotice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const shouldReduceMotion = useReducedMotion();

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingJoinRef = useRef<Record<string, unknown> | null>(null);
  const selfPeerIdRef = useRef<string | null>(null);
  const guestUidRef = useRef<string>(`guest_${Math.random().toString(36).slice(2, 9)}`);

  const pushRecorderRef = useRef<MediaRecorder | null>(null);
  const pushChunksRef = useRef<Blob[]>([]);

  const vadCtxRef = useRef<AudioContext | null>(null);
  const vadTimerRef = useRef<number | null>(null);
  const vadRecorderRef = useRef<MediaRecorder | null>(null);
  const vadChunksRef = useRef<Blob[]>([]);
  const isSpeakingVadRef = useRef(false);
  const silenceStartRef = useRef<number>(0);

  const myLangRef = useRef(myLang);
  const autoSpeakRef = useRef(autoSpeakTranslation);
  const voiceRef = useRef(voiceName);
  const mediaModeRef = useRef(activeMediaMode);
  myLangRef.current = myLang;
  autoSpeakRef.current = autoSpeakTranslation;
  voiceRef.current = voiceName;
  mediaModeRef.current = activeMediaMode;

  const effectiveDisplayName = profile?.displayName || guestName.trim() || 'Misafir';
  const effectiveUid = profile?.uid || guestUidRef.current;
  const effectiveHandle = profile?.handle || 'misafir';

  const cleanupPeerConnection = () => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  };

  const stopVadLoop = () => {
    if (vadTimerRef.current) {
      window.clearInterval(vadTimerRef.current);
      vadTimerRef.current = null;
    }
    if (vadRecorderRef.current && vadRecorderRef.current.state !== 'inactive') {
      vadRecorderRef.current.stop();
    }
    vadRecorderRef.current = null;
    if (vadCtxRef.current && vadCtxRef.current.state !== 'closed') {
      void vadCtxRef.current.close();
    }
    vadCtxRef.current = null;
    isSpeakingVadRef.current = false;
  };

  const stopLocalMedia = () => {
    stopVadLoop();
    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) {
        track.stop();
      }
      localStreamRef.current = null;
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
  };

  const sendSpeechBlobToPartner = async (blob: Blob, mimeType: string) => {
    if (blob.size < 600 || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setIsTranslatingChunk(true);
    try {
      const audioBase64 = await blobToBase64(blob);
      wsRef.current.send(
        JSON.stringify({
          type: 'call:speech_chunk',
          audioBase64,
          mimeType,
          speak: true,
          voiceName: voiceRef.current,
        })
      );
    } catch {
      // ignore transient error
    } finally {
      setIsTranslatingChunk(false);
    }
  };

  const startVadLoop = (stream: MediaStream) => {
    stopVadLoop();
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;

    const audioOnlyStream = new MediaStream(audioTracks);
    const ctx = new AudioContext();
    vadCtxRef.current = ctx;
    const src = ctx.createMediaStreamSource(audioOnlyStream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);

    vadTimerRef.current = window.setInterval(() => {
      if (
        !autoTranslateSpeech ||
        matchState !== 'connected' ||
        !micEnabled ||
        isRecordingPush
      ) {
        return;
      }

      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length;

      const now = Date.now();
      if (avg > 18) {
        silenceStartRef.current = 0;
        if (!isSpeakingVadRef.current) {
          isSpeakingVadRef.current = true;
          try {
            const rec = new MediaRecorder(audioOnlyStream);
            vadRecorderRef.current = rec;
            vadChunksRef.current = [];
            rec.ondataavailable = (ev) => {
              if (ev.data.size > 0) vadChunksRef.current.push(ev.data);
            };
            rec.onstop = () => {
              const mimeType = rec.mimeType || 'audio/webm';
              const blob = new Blob(vadChunksRef.current, { type: mimeType });
              if (blob.size > 1400) {
                void sendSpeechBlobToPartner(blob, mimeType);
              }
            };
            rec.start();
          } catch {
            isSpeakingVadRef.current = false;
          }
        }
      } else if (isSpeakingVadRef.current) {
        if (silenceStartRef.current === 0) {
          silenceStartRef.current = now;
        } else if (now - silenceStartRef.current > 950) {
          isSpeakingVadRef.current = false;
          silenceStartRef.current = 0;
          if (vadRecorderRef.current && vadRecorderRef.current.state !== 'inactive') {
            vadRecorderRef.current.stop();
          }
        }
      }
    }, 120);
  };

  useEffect(() => {
    if (matchState === 'connected' && autoTranslateSpeech && localStreamRef.current) {
      startVadLoop(localStreamRef.current);
    } else {
      stopVadLoop();
    }
  }, [matchState, autoTranslateSpeech, micEnabled]);

  useEffect(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const langInfo = getLanguageByCode(myLang);
      wsRef.current.send(
        JSON.stringify({
          type: 'peer:identify',
          uid: effectiveUid,
          displayName: effectiveDisplayName,
          handle: effectiveHandle,
          langCode: myLang,
          langName: langInfo.nameTr,
        })
      );
    }
  }, [myLang, effectiveUid, effectiveDisplayName, effectiveHandle]);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/video-social`);
    wsRef.current = ws;

    ws.onopen = () => {
      const langInfo = getLanguageByCode(myLangRef.current);
      ws.send(
        JSON.stringify({
          type: 'peer:identify',
          uid: effectiveUid,
          displayName: effectiveDisplayName,
          handle: effectiveHandle,
          langCode: myLangRef.current,
          langName: langInfo.nameTr,
        })
      );
      if (pendingJoinRef.current) {
        ws.send(JSON.stringify(pendingJoinRef.current));
        pendingJoinRef.current = null;
      }
    };

    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data as string) as {
        type: string;
        peerId?: string;
        waitingCount?: number;
        onlineCount?: number;
        initiator?: boolean;
        partner?: PartnerInfo;
        fromPeerId?: string;
        sdp?: RTCSessionDescriptionInit;
        candidate?: RTCIceCandidateInit;
        id?: string;
        senderPeerId?: string;
        senderName?: string;
        sourceLang?: string;
        originalText?: string;
        translations?: Record<string, string>;
        timestamp?: string;
        audioBase64?: string;
        message?: string;
      };

      if (msg.type === 'peer:registered' && msg.peerId) {
        selfPeerIdRef.current = msg.peerId;
        setQueueStats({
          waitingCount: msg.waitingCount || 0,
          onlineCount: msg.onlineCount || 0,
        });
      } else if (msg.type === 'match:queue_status') {
        setQueueStats({
          waitingCount: msg.waitingCount || 0,
          onlineCount: msg.onlineCount || 0,
        });
      } else if (msg.type === 'match:found' && msg.partner) {
        setPartner(msg.partner);
        setMatchState('connected');
        setChatFeed([]);
        setActiveSubtitle(null);
        await setupWebRtcPeer(msg.partner.peerId, Boolean(msg.initiator));
      } else if (msg.type === 'match:partner_left') {
        cleanupPeerConnection();
        setPartner(null);
        setMatchState('idle');
        setActiveSubtitle({
          speaker: 'OndaTalk',
          original: 'Karşı taraf görüşmeden ayrıldı.',
          translated: ui.idleDesc,
        });
      } else if (msg.type === 'webrtc:offer' && msg.fromPeerId && msg.sdp) {
        if (!pcRef.current) {
          await setupWebRtcPeer(msg.fromPeerId, false);
        }
        const pc = pcRef.current;
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          ws.send(
            JSON.stringify({
              type: 'webrtc:answer',
              toPeerId: msg.fromPeerId,
              sdp: pc.localDescription,
            })
          );
        }
      } else if (msg.type === 'webrtc:answer' && msg.sdp && pcRef.current) {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      } else if (msg.type === 'webrtc:ice' && msg.candidate && pcRef.current) {
        try {
          await pcRef.current.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } catch {
          // ignore
        }
      } else if (msg.type === 'call:subtitle' && msg.originalText && msg.translations) {
        const localized = msg.translations[myLangRef.current] || msg.originalText;
        const item: SubtitleMessage = {
          id: msg.id || `sub_${Date.now()}`,
          senderPeerId: msg.senderPeerId || '',
          senderName: msg.senderName || 'Konuşmacı',
          sourceLang: msg.sourceLang || 'tr',
          originalText: msg.originalText,
          translatedText: localized,
          timestamp: msg.timestamp || '',
        };
        setChatFeed((prev) => [...prev, item]);
        setActiveSubtitle({
          speaker: item.senderName,
          original: item.originalText,
          translated: item.translatedText,
        });

        if (
          autoSpeakRef.current &&
          msg.audioBase64 &&
          msg.senderPeerId !== selfPeerIdRef.current
        ) {
          try {
            await playWavBase64(msg.audioBase64);
          } catch {
            // ignore autoplay block
          }
        }
      } else if (msg.type === 'video:error' && msg.message) {
        setErrorMsg(msg.message);
      }
    };

    return () => {
      cleanupPeerConnection();
      stopLocalMedia();
      ws.close();
    };
  }, []);

  const tryAcquireMediaOrFallback = async (
    requestedMode: 'video' | 'text'
  ): Promise<'video' | 'text'> => {
    if (requestedMode === 'text') {
      stopLocalMedia();
      setActiveMediaMode('text');
      return 'text';
    }
    if (localStreamRef.current) {
      setActiveMediaMode('video');
      return 'video';
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      setCamEnabled(true);
      setMicEnabled(true);
      setActiveMediaMode('video');
      return 'video';
    } catch {
      try {
        const videoOnly = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        });
        localStreamRef.current = videoOnly;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = videoOnly;
        }
        setCamEnabled(true);
        setMicEnabled(false);
        setActiveMediaMode('video');
        setInfoNotice('Mikrofon bulunamadı; kamera + yazılı anlık çeviri ile eşleşmeye bağlanıldı.');
        return 'video';
      } catch {
        try {
          const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true });
          localStreamRef.current = audioOnly;
          setCamEnabled(false);
          setMicEnabled(true);
          setActiveMediaMode('video');
          setInfoNotice('Kamera bulunamadı; yalnızca sesli + yazılı çeviri ile bağlanıldı.');
          return 'video';
        } catch {
          stopLocalMedia();
          setCamEnabled(false);
          setMicEnabled(false);
          setActiveMediaMode('text');
          setInfoNotice(
            'Mikrofon veya kamera algılanmadı — otomatik olarak Yazılı & Dinleme Modu açıldı.'
          );
          return 'text';
        }
      }
    }
  };

  const setupWebRtcPeer = async (targetPeerId: string, isInitiator: boolean) => {
    cleanupPeerConnection();
    const pc = new RTCPeerConnection(ICE_SERVERS);
    pcRef.current = pc;

    if (localStreamRef.current && mediaModeRef.current === 'video') {
      for (const track of localStreamRef.current.getTracks()) {
        pc.addTrack(track, localStreamRef.current);
      }
    } else {
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }

    pc.ontrack = (event) => {
      if (remoteVideoRef.current && event.streams[0]) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'webrtc:ice',
            toPeerId: targetPeerId,
            candidate: event.candidate,
          })
        );
      }
    };

    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsRef.current?.send(
        JSON.stringify({
          type: 'webrtc:offer',
          toPeerId: targetPeerId,
          sdp: pc.localDescription,
        })
      );
    }
  };

  const startMatching = async (requestedMode: 'video' | 'text' = 'video') => {
    if (!allowRandomMatch) {
      setErrorMsg('Rastgele eşleşme şu anda yönetici tarafından duraklatılmıştır.');
      return;
    }
    if (profile?.status === 'banned') {
      setErrorMsg('Hesabınız yönetici tarafından kısıtlanmıştır.');
      return;
    }

    setErrorMsg(null);
    setInfoNotice(null);

    const resolvedMode = await tryAcquireMediaOrFallback(requestedMode);
    setMatchState('searching');
    setPartner(null);
    cleanupPeerConnection();

    // Automatically enter fullscreen call mode on mobile and tablet viewports (< 1024px)
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      setIsFullscreenCall(true);
    }

    const langInfo = getLanguageByCode(myLang);
    const joinPayload = {
      type: 'match:join',
      uid: effectiveUid,
      displayName: effectiveDisplayName,
      handle: effectiveHandle,
      langCode: myLang,
      langName: langInfo.nameTr,
      filterLang,
      mediaMode: resolvedMode,
    };

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(joinPayload));
    } else {
      pendingJoinRef.current = joinPayload;
    }
  };

  const stopMatching = () => {
    wsRef.current?.send(JSON.stringify({ type: 'match:leave' }));
    cleanupPeerConnection();
    stopLocalMedia();
    setPartner(null);
    setMatchState('idle');
    setInfoNotice(null);
    setIsFullscreenCall(false);
    setShowMobileChatDrawer(false);
  };

  const toggleCamera = () => {
    if (!localStreamRef.current) return;
    const next = !camEnabled;
    for (const track of localStreamRef.current.getVideoTracks()) {
      track.enabled = next;
    }
    setCamEnabled(next);
  };

  const toggleMic = () => {
    if (!localStreamRef.current) return;
    const next = !micEnabled;
    for (const track of localStreamRef.current.getAudioTracks()) {
      track.enabled = next;
    }
    setMicEnabled(next);
  };

  const startPushTranslate = () => {
    if (!localStreamRef.current || matchState !== 'connected') return;
    const audioTracks = localStreamRef.current.getAudioTracks();
    if (audioTracks.length === 0) return;

    const recorder = new MediaRecorder(new MediaStream(audioTracks));
    pushRecorderRef.current = recorder;
    pushChunksRef.current = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) pushChunksRef.current.push(ev.data);
    };
    recorder.onstop = () => {
      const mimeType = recorder.mimeType || 'audio/webm';
      const blob = new Blob(pushChunksRef.current, { type: mimeType });
      void sendSpeechBlobToPartner(blob, mimeType);
    };
    recorder.start();
    setIsRecordingPush(true);
  };

  const stopPushTranslate = () => {
    if (pushRecorderRef.current && pushRecorderRef.current.state !== 'inactive') {
      pushRecorderRef.current.stop();
    }
    setIsRecordingPush(false);
  };

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || matchState !== 'connected' || !wsRef.current) return;
    const { safe, text } = sanitizeClientText(chatInput, 1000);
    if (!safe || !text) {
      setErrorMsg('Güvenlik kalkanı: Geçersiz veya zararlı karakter içeren mesaj engellendi.');
      return;
    }
    wsRef.current.send(
      JSON.stringify({
        type: 'call:speech_chunk',
        text,
        speak: autoSpeakTranslation,
        voiceName,
      })
    );
    setChatInput('');
  };

  const handleReportPartner = async () => {
    if (!partner) return;
    if (!profile) {
      onRequireAuth();
      return;
    }
    const reportId = `rep_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    try {
      await setDoc(doc(db, 'reports', reportId), {
        id: reportId,
        reporterUid: profile.uid,
        targetUid: partner.uid,
        targetName: partner.displayName.slice(0, 50),
        reason: 'Rastgele görüşme sırasında bildirim',
        status: 'open',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setReportNotice('Bildiriminiz yöneticiye iletildi.');
      setTimeout(() => setReportNotice(null), 2500);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `reports/${reportId}`);
    }
  };

  const hasAudioTrack = Boolean(localStreamRef.current?.getAudioTracks().length);

  const handleStageTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, input, select, textarea, [data-pip-box]')) return;
    if (e.touches.length !== 1) return;
    stageSwipeStartRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
    };
    setStageSwipeDx(0);
  };

  const handleStageTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!stageSwipeStartRef.current || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - stageSwipeStartRef.current.x;
    const dy = e.touches[0].clientY - stageSwipeStartRef.current.y;
    if (Math.abs(dx) > Math.abs(dy) * 1.2 && Math.abs(dx) > 12) {
      setStageSwipeDx(Math.max(-140, Math.min(140, dx)));
    }
  };

  const handleStageTouchEnd = () => {
    if (!stageSwipeStartRef.current) return;
    const dx = stageSwipeDx;
    stageSwipeStartRef.current = null;
    setStageSwipeDx(0);
    if (dx <= -75 && matchState !== 'idle') {
      void startMatching(activeMediaMode);
    } else if (dx >= 75 && isFullscreenCall) {
      setShowMobileChatDrawer((prev) => !prev);
    }
  };

  const handlePipPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isFullscreenCall) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    pipDragStartRef.current = { x: e.clientX, y: e.clientY };
    setPipDragOffset({ x: 0, y: 0 });
  };

  const handlePipPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pipDragStartRef.current) return;
    setPipDragOffset({
      x: e.clientX - pipDragStartRef.current.x,
      y: e.clientY - pipDragStartRef.current.y,
    });
  };

  const handlePipPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pipDragStartRef.current) return;
    pipDragStartRef.current = null;
    setPipDragOffset(null);
    const isLeft = e.clientX < window.innerWidth / 2;
    const isBottom = e.clientY > window.innerHeight * 0.52;
    if (isLeft && isBottom) setPipCorner('bottom-left');
    else if (!isLeft && isBottom) setPipCorner('bottom-right');
    else if (isLeft) setPipCorner('top-left');
    else setPipCorner('top-right');
  };

  const pipPositionClass =
    pipCorner === 'top-left'
      ? 'top-[max(60px,calc(env(safe-area-inset-top)+52px))] left-3 sm:left-5'
      : pipCorner === 'bottom-left'
        ? 'bottom-4 left-3 sm:left-5'
        : pipCorner === 'bottom-right'
          ? 'bottom-4 right-3 sm:right-5'
          : 'top-[max(60px,calc(env(safe-area-inset-top)+52px))] right-3 sm:right-5';

  return (
    <div className="space-y-5">
      {/* Simple Matchmaking & Language Lobby Card */}
      <section className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-900 font-display">{ui.omegleTitle}</h2>
            <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1">
                <Users className="w-3.5 h-3.5 text-teal-600" />
                <span className="font-mono tabular-nums">{queueStats.onlineCount}</span>{' '}
                {ui.onlineLabel}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                <span className="font-mono tabular-nums">{queueStats.waitingCount}</span>{' '}
                {ui.waitingLabel}
              </span>
              {!profile && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-teal-700 font-medium">{ui.guestActiveNote}</span>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
            {matchState === 'idle' ? (
              <>
                <button
                  type="button"
                  onClick={() => void startMatching('video')}
                  className="flex-1 sm:flex-initial min-h-[44px] px-4 bg-teal-600 text-white rounded-xl text-xs sm:text-sm font-semibold hover:bg-teal-700 inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0"
                >
                  <Video className="w-4 h-4" />
                  {ui.startMatch}
                </button>
                <button
                  type="button"
                  onClick={() => void startMatching('text')}
                  className="flex-1 sm:flex-initial min-h-[44px] px-4 bg-slate-900 text-white rounded-xl text-xs font-semibold hover:bg-slate-800 inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0"
                >
                  <Keyboard className="w-4 h-4" />
                  {ui.startTextOnlyMatch}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void startMatching(activeMediaMode)}
                  className="flex-1 sm:flex-initial min-h-[44px] px-4 bg-slate-900 text-white rounded-xl text-xs font-semibold hover:bg-slate-800 inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  {ui.nextPerson}
                </button>
                <button
                  type="button"
                  onClick={stopMatching}
                  className="flex-1 sm:flex-initial min-h-[44px] px-4 bg-rose-600 text-white rounded-xl text-xs font-semibold hover:bg-rose-700 inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <PhoneOff className="w-3.5 h-3.5" />
                  {ui.endCall}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Clean Language & Guest Name Row */}
        <div className="pt-3 border-t border-slate-200 grid grid-cols-2 sm:grid-cols-3 gap-3">
          {!profile && (
            <div className="col-span-2 sm:col-span-1">
              <label htmlFor="guest-nick" className="block text-xs font-medium text-slate-500 mb-1">
                Takma Ad (Kayıtsız)
              </label>
              <input
                id="guest-nick"
                type="text"
                maxLength={30}
                disabled={matchState !== 'idle'}
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                className="w-full h-11 sm:h-10 px-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 disabled:opacity-60"
              />
            </div>
          )}

          <div>
            <label htmlFor="omegle-mylang" className="block text-xs font-medium text-slate-500 mb-1">
              {ui.yourLang}
            </label>
            <select
              id="omegle-mylang"
              value={myLang}
              onChange={(e) => onChangeMyLang(e.target.value)}
              className="w-full h-11 sm:h-10 px-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium text-slate-900"
            >
              {WORLD_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.nameTr} ({l.nativeName})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="omegle-filter" className="block text-xs font-medium text-slate-500 mb-1">
              {ui.partnerLang}
            </label>
            <select
              id="omegle-filter"
              value={filterLang}
              disabled={matchState !== 'idle'}
              onChange={(e) => setFilterLang(e.target.value)}
              className="w-full h-11 sm:h-10 px-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium text-slate-800 disabled:opacity-60"
            >
              <option value="all">{ui.allWorld}</option>
              {WORLD_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.nameTr} ({l.nativeName})
                </option>
              ))}
            </select>
          </div>
        </div>

        {infoNotice && (
          <div className="px-3.5 py-2.5 bg-teal-50 border border-teal-200 rounded-xl text-xs text-teal-900">
            {infoNotice}
          </div>
        )}
        {errorMsg && (
          <div className="px-3.5 py-2.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800">
            {errorMsg}
          </div>
        )}
        {reportNotice && (
          <div className="px-3.5 py-2.5 bg-teal-50 border border-teal-200 rounded-xl text-xs text-teal-900">
            {reportNotice}
          </div>
        )}
      </section>

      {/* Video Stage + Desktop Side Chat */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-6 items-stretch">
        {/* Video Call Theater (Switches seamlessly to Mobile & Tablet Fullscreen Mode with Bottom Controls) */}
        <section
          aria-label="Görüntülü Görüşme Ekranı"
          data-no-tab-swipe="true"
          className={
            isFullscreenCall
              ? 'fixed inset-0 z-50 h-[100dvh] w-full bg-slate-950 flex flex-col justify-between overflow-hidden'
              : 'bg-slate-950 border border-slate-800 rounded-2xl overflow-hidden flex flex-col justify-between min-h-[460px] lg:min-h-[540px] relative'
          }
        >
          {/* Video Canvas with Horizontal Swipe Left/Right */}
          <div
            onTouchStart={handleStageTouchStart}
            onTouchMove={handleStageTouchMove}
            onTouchEnd={handleStageTouchEnd}
            onTouchCancel={handleStageTouchEnd}
            className={
              isFullscreenCall
                ? 'relative flex-1 bg-slate-950 overflow-hidden touch-pan-y'
                : 'relative flex-1 grid grid-cols-1 sm:grid-cols-2 gap-1 bg-slate-900 touch-pan-y'
            }
          >
            {/* Swipe Gesture Feedback Banner */}
            {Math.abs(stageSwipeDx) > 28 && (
              <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 z-30 flex justify-center px-4">
                <div className="px-4 py-2 rounded-2xl bg-black/80 backdrop-blur-md border border-white/15 text-xs font-semibold text-white inline-flex items-center gap-2">
                  {stageSwipeDx < 0 ? (
                    <>
                      <ChevronLeft className="w-4 h-4 text-teal-400" />
                      <span>Sonraki Kişiye Geç</span>
                    </>
                  ) : (
                    <>
                      <span>Sohbet &amp; Çeviri</span>
                      <ChevronRight className="w-4 h-4 text-teal-400" />
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Remote Partner Camera */}
            <div
              style={
                !shouldReduceMotion && stageSwipeDx !== 0
                  ? { transform: `translate3d(${stageSwipeDx * 0.25}px, 0, 0)` }
                  : undefined
              }
              className={
                isFullscreenCall
                  ? 'absolute inset-0 bg-slate-950 flex items-center justify-center overflow-hidden transition-transform duration-150'
                  : 'relative bg-slate-950 min-h-[240px] flex items-center justify-center overflow-hidden'
              }
            >
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                muted={mutePartnerRawAudio}
                className="w-full h-full object-cover"
              />

              {matchState !== 'connected' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-slate-950/88 z-10">
                  {matchState === 'searching' ? (
                    <div className="flex flex-col items-center">
                      <div className="relative w-16 h-16 flex items-center justify-center mb-3">
                        {!shouldReduceMotion && (
                          <motion.span
                            className="absolute inset-0 rounded-full border-2 border-teal-400/50"
                            animate={{ scale: [0.85, 1.45], opacity: [0.85, 0] }}
                            transition={{ duration: 1.4, repeat: Infinity, ease: 'easeOut' }}
                          />
                        )}
                        <Loader2 className="w-8 h-8 text-teal-400 animate-spin relative z-10" />
                      </div>
                      <p className="text-sm sm:text-base font-semibold text-white">
                        {ui.searchingTitle}
                      </p>
                      <p className="text-xs text-slate-300 mt-1 max-w-xs">{ui.searchingDesc}</p>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center space-y-3 max-w-xs">
                      <Video className="w-9 h-9 text-teal-400" />
                      <p className="text-sm sm:text-base font-semibold text-white">{ui.idleTitle}</p>
                      <p className="text-xs text-slate-300">{ui.idleDesc}</p>
                      {isFullscreenCall && (
                        <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                          <button
                            type="button"
                            onClick={() => void startMatching('video')}
                            className="min-h-[44px] px-4 bg-teal-600 text-white rounded-xl text-xs font-semibold hover:bg-teal-700 inline-flex items-center gap-2"
                          >
                            <Video className="w-4 h-4" />
                            {ui.startMatch}
                          </button>
                          <button
                            type="button"
                            onClick={() => void startMatching('text')}
                            className="min-h-[44px] px-4 bg-slate-800 text-white rounded-xl text-xs font-semibold hover:bg-slate-700 inline-flex items-center gap-2"
                          >
                            <Keyboard className="w-4 h-4" />
                            {ui.startTextOnlyMatch}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Top Overlay Bar inside Video Frame (Partner Status + Fullscreen Toggle) */}
              <div
                className={`absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-2 px-3 sm:px-4 pb-6 bg-gradient-to-b from-black/80 via-black/35 to-transparent ${
                  isFullscreenCall ? 'pt-[max(12px,env(safe-area-inset-top))]' : 'pt-3'
                }`}
              >
                <div className="min-w-0 flex items-center gap-2 text-xs text-white">
                  {partner ? (
                    <div className="px-2.5 py-1 bg-black/55 backdrop-blur-xs rounded-lg flex items-center gap-2 truncate">
                      <span className="font-semibold truncate">{partner.displayName}</span>
                      <span className="text-slate-300">·</span>
                      <span className="text-teal-300 shrink-0">{partner.langName}</span>
                    </div>
                  ) : (
                    <div className="px-2.5 py-1 bg-black/55 backdrop-blur-xs rounded-lg flex items-center gap-2">
                      <span className="font-semibold">OndaTalk</span>
                      <span className="text-slate-300">·</span>
                      <span className="text-teal-300 tabular-nums">
                        {queueStats.onlineCount} {ui.onlineLabel}
                      </span>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {partner && (
                    <button
                      type="button"
                      onClick={() => void handleReportPartner()}
                      aria-label={ui.reportBtn}
                      title={ui.reportBtn}
                      className="min-h-[40px] min-w-[40px] px-2.5 bg-black/55 hover:bg-black/75 text-slate-200 hover:text-rose-300 rounded-xl text-xs font-medium inline-flex items-center justify-center gap-1.5 backdrop-blur-xs"
                    >
                      <Flag className="w-4 h-4" />
                      <span className="hidden sm:inline">{ui.reportBtn}</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      setIsFullscreenCall((f) => !f);
                      setShowMobileChatDrawer(false);
                    }}
                    aria-label={isFullscreenCall ? 'Tam ekrandan çık' : 'Tam ekran yap'}
                    title={isFullscreenCall ? 'Küçült' : 'Tam Ekran'}
                    className="min-h-[40px] min-w-[40px] px-2.5 bg-black/55 hover:bg-black/75 text-white rounded-xl text-xs font-medium inline-flex items-center justify-center gap-1.5 backdrop-blur-xs"
                  >
                    {isFullscreenCall ? (
                      <>
                        <Minimize2 className="w-4 h-4" />
                        <span className="hidden sm:inline">Küçült</span>
                      </>
                    ) : (
                      <>
                        <Maximize2 className="w-4 h-4" />
                        <span className="sm:inline">Tam Ekran</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Local Self Camera (Draggable Left/Right PiP in Fullscreen, Split Grid in Windowed) */}
            <div
              data-pip-box="true"
              onPointerDown={handlePipPointerDown}
              onPointerMove={handlePipPointerMove}
              onPointerUp={handlePipPointerUp}
              onPointerCancel={handlePipPointerUp}
              style={
                pipDragOffset
                  ? {
                      transform: `translate3d(${pipDragOffset.x}px, ${pipDragOffset.y}px, 0)`,
                    }
                  : undefined
              }
              className={
                isFullscreenCall
                  ? `absolute ${pipPositionClass} w-24 h-32 sm:w-32 sm:h-44 rounded-2xl overflow-hidden border-2 border-white/25 shadow-2xl bg-slate-900 z-20 cursor-grab active:cursor-grabbing touch-none`
                  : 'relative bg-slate-900 min-h-[200px] sm:min-h-[240px] flex items-center justify-center overflow-hidden'
              }
            >
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                className="w-full h-full object-cover scale-x-[-1]"
              />
              {!isFullscreenCall && (
                <div className="absolute top-3 left-3 px-2.5 py-1 bg-black/65 rounded-lg text-xs text-white flex items-center gap-2 z-10">
                  <span className="font-semibold">{effectiveDisplayName}</span>
                  <span className="text-slate-300">·</span>
                  <span className="text-teal-300">{getLanguageByCode(myLang).nameTr}</span>
                </div>
              )}
              {activeMediaMode === 'text' ? (
                <div className="absolute inset-0 bg-slate-900/95 flex flex-col items-center justify-center p-2 text-center">
                  <Keyboard className="w-6 h-6 text-teal-400 mb-1" />
                  <p className="text-[11px] font-semibold text-white">{ui.textModeBadge}</p>
                </div>
              ) : (
                !camEnabled && (
                  <div className="absolute inset-0 bg-slate-900/92 flex flex-col items-center justify-center text-xs text-slate-300 p-2 text-center">
                    <CameraOff className="w-5 h-5 text-slate-400 mb-1" />
                    <span className="text-[11px]">{ui.camBtn} Kapalı</span>
                  </div>
                )
              )}
            </div>

            {/* Live Translated Subtitle Scrim (Always unobstructed above bottom controls) */}
            <AnimatePresence>
              {activeSubtitle && (
                <motion.div
                  key={`${activeSubtitle.speaker}-${activeSubtitle.translated}`}
                  initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                  className="absolute inset-x-0 bottom-0 p-3 sm:p-4 bg-gradient-to-t from-black/90 via-black/65 to-transparent pointer-events-none z-20"
                >
                  <div className="max-w-2xl mx-auto text-center space-y-0.5">
                    <div className="text-[11px] text-teal-300 font-semibold">
                      {activeSubtitle.speaker}
                    </div>
                    <p className="text-sm sm:text-base font-semibold text-white leading-snug">
                      {activeSubtitle.translated}
                    </p>
                    {activeSubtitle.original !== activeSubtitle.translated && (
                      <p className="text-xs text-slate-300">{activeSubtitle.original}</p>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Slide-Up Chat & Subtitle Settings Sheet inside Fullscreen Mode */}
          {isFullscreenCall && showMobileChatDrawer && (
            <div className="bg-slate-900/95 backdrop-blur-md border-t border-white/10 flex flex-col max-h-[42dvh] z-30">
              <div className="px-4 py-2.5 border-b border-white/10 flex items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-3 text-xs text-slate-200">
                  {activeMediaMode === 'video' && (
                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoTranslateSpeech}
                        onChange={(e) => setAutoTranslateSpeech(e.target.checked)}
                        className="accent-teal-500 w-4 h-4 rounded"
                      />
                      <span>Otomatik altyazı</span>
                    </label>
                  )}
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoSpeakTranslation}
                      onChange={(e) => setAutoSpeakTranslation(e.target.checked)}
                      className="accent-teal-500 w-4 h-4 rounded"
                    />
                    <span>Sesli dublaj</span>
                  </label>
                </div>
                <button
                  type="button"
                  onClick={() => setShowMobileChatDrawer(false)}
                  aria-label="Sohbeti kapat"
                  className="min-h-[36px] min-w-[36px] inline-flex items-center justify-center rounded-lg text-slate-300 hover:bg-white/10"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2">
                {chatFeed.length === 0 ? (
                  <p className="text-xs text-slate-400 text-center py-4">{ui.idleDesc}</p>
                ) : (
                  chatFeed.map((item) => (
                    <div key={item.id} className="p-2.5 rounded-xl bg-white/5 border border-white/10">
                      <div className="flex items-center justify-between text-[11px] text-slate-400">
                        <span className="font-semibold text-teal-300">{item.senderName}</span>
                        <span className="font-mono tabular-nums">{item.timestamp}</span>
                      </div>
                      <p className="text-xs font-medium text-white mt-0.5">{item.translatedText}</p>
                      {item.originalText !== item.translatedText && (
                        <p className="text-[11px] text-slate-400">{item.originalText}</p>
                      )}
                    </div>
                  ))
                )}
              </div>

              <form onSubmit={handleSendChat} className="p-3 border-t border-white/10 flex gap-2">
                <input
                  type="text"
                  disabled={matchState !== 'connected'}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder={ui.chatPlaceholder}
                  className="flex-1 min-h-[44px] px-3 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder:text-slate-400 disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={matchState !== 'connected' || !chatInput.trim()}
                  className="min-h-[44px] px-4 bg-teal-600 text-white rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 hover:bg-teal-700 disabled:opacity-40 shrink-0"
                >
                  <Send className="w-4 h-4" />
                  <span className="hidden sm:inline">{ui.sendBtn}</span>
                </button>
              </form>
            </div>
          )}

          {/* Ergonomic Bottom-Anchored Call Control Dock */}
          <div
            className={`z-30 bg-slate-900/95 backdrop-blur-md border-t border-slate-800 px-3 sm:px-5 pt-3 ${
              isFullscreenCall
                ? 'pb-[max(14px,env(safe-area-inset-bottom))]'
                : 'pb-3.5'
            }`}
          >
            {/* Quick Inline Text Bar when in Text-Only Fullscreen Mode */}
            {isFullscreenCall &&
              activeMediaMode === 'text' &&
              !showMobileChatDrawer &&
              matchState === 'connected' && (
                <form onSubmit={handleSendChat} className="mb-3 flex gap-2 max-w-xl mx-auto">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder={ui.chatPlaceholder}
                    className="flex-1 min-h-[44px] px-3 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder:text-slate-400"
                  />
                  <button
                    type="submit"
                    disabled={!chatInput.trim()}
                    className="min-h-[44px] px-4 bg-teal-600 text-white rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-40 shrink-0"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </form>
              )}

            {/* Quick Voice Push-to-Translate & Raw Audio Strip */}
            <div className="flex flex-wrap items-center justify-center gap-2 mb-2.5">
              {activeMediaMode === 'video' && hasAudioTrack && (
                <button
                  type="button"
                  disabled={matchState !== 'connected'}
                  onClick={() =>
                    isRecordingPush ? stopPushTranslate() : startPushTranslate()
                  }
                  className={`min-h-[38px] px-3.5 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-40 transition-colors ${
                    isRecordingPush
                      ? 'bg-rose-600 text-white'
                      : 'bg-teal-600 text-white hover:bg-teal-700'
                  }`}
                >
                  {isTranslatingChunk ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Mic className="w-3.5 h-3.5" />
                  )}
                  {isRecordingPush ? ui.sendTranslate : ui.pushTranslate}
                </button>
              )}

              <button
                type="button"
                onClick={() => setMutePartnerRawAudio((p) => !p)}
                className={`min-h-[38px] px-3 rounded-xl text-xs font-medium inline-flex items-center gap-1.5 transition-colors ${
                  mutePartnerRawAudio
                    ? 'bg-amber-600 text-white'
                    : 'bg-slate-800 text-slate-200 hover:bg-slate-700'
                }`}
              >
                {mutePartnerRawAudio ? (
                  <VolumeX className="w-3.5 h-3.5" />
                ) : (
                  <Volume2 className="w-3.5 h-3.5" />
                )}
                {mutePartnerRawAudio ? ui.rawAudioOff : ui.rawAudioOn}
              </button>
            </div>

            {/* Primary Bottom Thumb-Zone Control Bar */}
            <div className="flex items-center justify-around sm:justify-center gap-2 sm:gap-4 max-w-lg mx-auto">
              {activeMediaMode === 'video' && (
                <>
                  <button
                    type="button"
                    onClick={toggleMic}
                    aria-label={ui.micBtn}
                    className={`min-h-[48px] min-w-[54px] px-3 py-1.5 rounded-2xl flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 text-[11px] sm:text-xs font-semibold transition-colors ${
                      micEnabled
                        ? 'bg-slate-800 text-white hover:bg-slate-700'
                        : 'bg-rose-600 text-white'
                    }`}
                  >
                    {micEnabled ? (
                      <Mic className="w-4 h-4 shrink-0" />
                    ) : (
                      <MicOff className="w-4 h-4 shrink-0" />
                    )}
                    <span>{ui.micBtn}</span>
                  </button>

                  <button
                    type="button"
                    onClick={toggleCamera}
                    aria-label={ui.camBtn}
                    className={`min-h-[48px] min-w-[54px] px-3 py-1.5 rounded-2xl flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 text-[11px] sm:text-xs font-semibold transition-colors ${
                      camEnabled
                        ? 'bg-slate-800 text-white hover:bg-slate-700'
                        : 'bg-rose-600 text-white'
                    }`}
                  >
                    {camEnabled ? (
                      <Camera className="w-4 h-4 shrink-0" />
                    ) : (
                      <CameraOff className="w-4 h-4 shrink-0" />
                    )}
                    <span>{ui.camBtn}</span>
                  </button>
                </>
              )}

              {isFullscreenCall && (
                <button
                  type="button"
                  onClick={() => setShowMobileChatDrawer((s) => !s)}
                  className={`min-h-[48px] min-w-[54px] px-3 py-1.5 rounded-2xl flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 text-[11px] sm:text-xs font-semibold transition-colors ${
                    showMobileChatDrawer
                      ? 'bg-teal-600 text-white'
                      : 'bg-slate-800 text-white hover:bg-slate-700'
                  }`}
                >
                  <MessageSquare className="w-4 h-4 shrink-0" />
                  <span>
                    Sohbet{chatFeed.length > 0 ? ` (${chatFeed.length})` : ''}
                  </span>
                </button>
              )}

              {matchState !== 'idle' && (
                <>
                  <button
                    type="button"
                    onClick={() => void startMatching(activeMediaMode)}
                    className="min-h-[48px] min-w-[54px] px-3.5 py-1.5 rounded-2xl bg-slate-800 text-white hover:bg-slate-700 flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 text-[11px] sm:text-xs font-semibold transition-colors"
                  >
                    <RefreshCw className="w-4 h-4 shrink-0" />
                    <span>Sonraki</span>
                  </button>

                  <button
                    type="button"
                    onClick={stopMatching}
                    className="min-h-[48px] min-w-[56px] px-4 py-1.5 rounded-2xl bg-rose-600 text-white hover:bg-rose-700 flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 text-[11px] sm:text-xs font-semibold transition-colors"
                  >
                    <PhoneOff className="w-4 h-4 shrink-0" />
                    <span>{ui.endCall}</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </section>

        {/* Bilingual Auto-Translated Text Chat Panel (Desktop & Windowed View) */}
        <section className="bg-white border border-slate-200 rounded-2xl flex flex-col min-h-[420px]">
          <div className="p-4 border-b border-slate-200 space-y-2.5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">{ui.liveSubChatTitle}</h3>
              <span className="text-xs text-slate-500">
                {partner ? `${partner.displayName} (${partner.langName})` : '—'}
              </span>
            </div>

            <div className="flex flex-wrap gap-4 text-xs text-slate-700">
              {activeMediaMode === 'video' && (
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoTranslateSpeech}
                    onChange={(e) => setAutoTranslateSpeech(e.target.checked)}
                    className="accent-teal-600 rounded"
                  />
                  {ui.autoSubtitleCheck}
                </label>
              )}
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoSpeakTranslation}
                  onChange={(e) => setAutoSpeakTranslation(e.target.checked)}
                  className="accent-teal-600 rounded"
                />
                {ui.autoDubCheck}
              </label>
            </div>
          </div>

          <div className="flex-1 divide-y divide-slate-200 overflow-y-auto max-h-[320px]">
            {chatFeed.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500 space-y-2">
                <ShieldAlert className="w-6 h-6 text-slate-300 mx-auto" />
                <p>{ui.idleDesc}</p>
              </div>
            ) : (
              chatFeed.map((item) => (
                <div key={item.id} className="p-3.5 space-y-1">
                  <div className="flex items-center justify-between text-[11px] text-slate-500">
                    <span className="font-semibold text-slate-800">{item.senderName}</span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono tabular-nums">{item.timestamp}</span>
                      <button
                        type="button"
                        onClick={() =>
                          onAddAgreement(item.originalText, item.translatedText, item.senderName)
                        }
                        className="text-teal-700 hover:underline inline-flex items-center gap-0.5"
                      >
                        <FilePlus2 className="w-3 h-3" />+
                      </button>
                    </div>
                  </div>
                  <p className="text-xs font-medium text-slate-900">{item.translatedText}</p>
                  {item.originalText !== item.translatedText && (
                    <p className="text-[11px] text-slate-500">{item.originalText}</p>
                  )}
                </div>
              ))
            )}
          </div>

          <form onSubmit={handleSendChat} className="p-3.5 border-t border-slate-200 flex gap-2">
            <input
              type="text"
              disabled={matchState !== 'connected'}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder={ui.chatPlaceholder}
              className="flex-1 min-h-[42px] px-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={matchState !== 'connected' || !chatInput.trim()}
              className="min-h-[42px] px-3.5 bg-slate-900 text-white rounded-xl text-xs font-medium inline-flex items-center gap-1.5 hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <Send className="w-3.5 h-3.5" />
              {ui.sendBtn}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
