import { useEffect, useRef, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  Camera,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Flag,
  Heart,
  Loader2,
  Mic,
  Radio,
  Send,
  Square,
  UserCheck,
  UserPlus,
  Users,
  Video,
  Volume2,
  X,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type { UiStrings } from '../i18n';
import { getLanguageByCode } from '../languages';
import type { LiveStream, StreamComment, UserProfile } from '../types';
import { blobToBase64, playWavBase64 } from '../utils/audio';
import { sanitizeClientText } from '../utils/safety';

interface TikTokLiveFeedProps {
  profile: UserProfile | null;
  myLang: string;
  voiceName: string;
  ui: UiStrings;
  openGoLiveRequested: boolean;
  onResetGoLiveRequest: () => void;
  onRequireAuth: () => void;
}

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export function TikTokLiveFeed({
  profile,
  myLang,
  voiceName,
  ui,
  openGoLiveRequested,
  onResetGoLiveRequest,
  onRequireAuth,
}: TikTokLiveFeedProps) {
  const [streams, setStreams] = useState<LiveStream[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dbComments, setDbComments] = useState<StreamComment[]>([]);
  const [liveGuestComments, setLiveGuestComments] = useState<StreamComment[]>([]);
  const [commentInput, setCommentInput] = useState('');
  const [isSendingComment, setIsSendingComment] = useState(false);

  const [showGoLiveModal, setShowGoLiveModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newTopic, setNewTopic] = useState('Sohbet & Kültür');
  const [isStartingStream, setIsStartingStream] = useState(false);

  const [activeHostStream, setActiveHostStream] = useState<LiveStream | null>(null);
  const [liveViewerCount, setLiveViewerCount] = useState<number>(1);
  const [liveSubtitle, setLiveSubtitle] = useState<{
    speaker: string;
    original: string;
    translated: string;
  } | null>(null);
  const [autoSpeakHostSubtitles, setAutoSpeakHostSubtitles] = useState(false);
  const [floatingHearts, setFloatingHearts] = useState<{ id: number; xOffset: number }[]>([]);
  const [stageImgFailed, setStageImgFailed] = useState(false);
  const shouldReduceMotion = useReducedMotion();
  const [isRecordingHostSpeech, setIsRecordingHostSpeech] = useState(false);
  const [isFollowingHost, setIsFollowingHost] = useState(false);
  const [noticeMsg, setNoticeMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const viewerPcRef = useRef<RTCPeerConnection | null>(null);
  const stageSwipeStartRef = useRef<{ x: number; y: number } | null>(null);

  const hostRecRef = useRef<MediaRecorder | null>(null);
  const hostChunksRef = useRef<Blob[]>([]);

  const myLangRef = useRef(myLang);
  const autoSpeakRef = useRef(autoSpeakHostSubtitles);
  const voiceRef = useRef(voiceName);
  myLangRef.current = myLang;
  autoSpeakRef.current = autoSpeakHostSubtitles;
  voiceRef.current = voiceName;

  useEffect(() => {
    if (openGoLiveRequested) {
      if (!profile) {
        onRequireAuth();
      } else {
        setShowGoLiveModal(true);
      }
      onResetGoLiveRequest();
    }
  }, [openGoLiveRequested, profile, onRequireAuth, onResetGoLiveRequest]);

  // Real-time live streams list from Firestore (public read allowed!)
  useEffect(() => {
    const q = query(
      collection(db, 'streams'),
      where('isLive', '==', true),
      orderBy('createdAt', 'desc'),
      limit(30)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map((d) => d.data() as LiveStream);
        setStreams(list);
        setSelectedIndex((prev) => (prev >= list.length ? 0 : prev));
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, 'streams');
      }
    );
    return () => unsub();
  }, []);

  const currentStream: LiveStream | null = activeHostStream || streams[selectedIndex] || null;

  useEffect(() => {
    setLiveGuestComments([]);
    if (!currentStream) {
      setDbComments([]);
      return;
    }
    const q = query(
      collection(db, 'streams', currentStream.id, 'comments'),
      orderBy('createdAt', 'asc'),
      limit(60)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setDbComments(snap.docs.map((d) => d.data() as StreamComment));
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, `streams/${currentStream.id}/comments`);
      }
    );
    return () => unsub();
  }, [currentStream?.id]);

  useEffect(() => {
    if (!profile || !currentStream || profile.uid === currentStream.hostUid) {
      setIsFollowingHost(false);
      return;
    }
    const followId = `${profile.uid}_${currentStream.hostUid}`;
    void getDoc(doc(db, 'follows', followId))
      .then((snap) => setIsFollowingHost(snap.exists()))
      .catch(() => setIsFollowingHost(false));
  }, [profile?.uid, currentStream?.hostUid]);

  const cleanupAllRtc = () => {
    for (const pc of peerConnectionsRef.current.values()) {
      pc.close();
    }
    peerConnectionsRef.current.clear();
    if (viewerPcRef.current) {
      viewerPcRef.current.close();
      viewerPcRef.current = null;
    }
  };

  const stopHostMedia = () => {
    if (localStreamRef.current) {
      for (const t of localStreamRef.current.getTracks()) t.stop();
      localStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  useEffect(() => {
    const streamTarget = currentStream;
    if (!streamTarget) {
      cleanupAllRtc();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      return;
    }

    const isHost = Boolean(activeHostStream && activeHostStream.id === streamTarget.id);
    setLiveSubtitle(null);
    setLiveViewerCount(streamTarget.viewerCount || 1);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/video-social`);
    wsRef.current = ws;

    ws.onopen = () => {
      const langInfo = getLanguageByCode(myLangRef.current);
      ws.send(
        JSON.stringify({
          type: 'stream:join',
          streamId: streamTarget.id,
          isHost,
          uid: profile?.uid || `guest_${Math.random().toString(36).slice(2, 7)}`,
          displayName: profile?.displayName || 'Misafir',
          handle: profile?.handle || 'misafir',
          langCode: myLangRef.current,
          langName: langInfo.nameTr,
        })
      );
    };

    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data as string) as {
        type: string;
        viewerCount?: number;
        peer?: { peerId: string; isHost: boolean };
        fromPeerId?: string;
        sdp?: RTCSessionDescriptionInit;
        candidate?: RTCIceCandidateInit;
        senderName?: string;
        originalText?: string;
        translations?: Record<string, string>;
        comment?: {
          id: string;
          streamId: string;
          authorUid: string;
          authorName: string;
          sourceLang: string;
          originalText: string;
          translations: Record<string, string>;
        };
      };

      if (msg.type === 'stream:presence' && typeof msg.viewerCount === 'number') {
        setLiveViewerCount(msg.viewerCount);
      } else if (msg.type === 'stream:peer_joined' && isHost && msg.peer && localStreamRef.current) {
        const viewerPeerId = msg.peer.peerId;
        const pc = new RTCPeerConnection(ICE_SERVERS);
        peerConnectionsRef.current.set(viewerPeerId, pc);
        for (const track of localStreamRef.current.getTracks()) {
          pc.addTrack(track, localStreamRef.current);
        }
        pc.onicecandidate = (e) => {
          if (e.candidate && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'webrtc:ice',
                toPeerId: viewerPeerId,
                candidate: e.candidate,
                streamId: streamTarget.id,
              })
            );
          }
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(
          JSON.stringify({
            type: 'webrtc:offer',
            toPeerId: viewerPeerId,
            sdp: pc.localDescription,
            streamId: streamTarget.id,
          })
        );
      } else if (msg.type === 'webrtc:answer' && isHost && msg.fromPeerId && msg.sdp) {
        const pc = peerConnectionsRef.current.get(msg.fromPeerId);
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        }
      } else if (msg.type === 'webrtc:offer' && !isHost && msg.fromPeerId && msg.sdp) {
        if (viewerPcRef.current) viewerPcRef.current.close();
        const pc = new RTCPeerConnection(ICE_SERVERS);
        viewerPcRef.current = pc;

        pc.ontrack = (e) => {
          if (videoRef.current && e.streams[0]) {
            videoRef.current.srcObject = e.streams[0];
          }
        };
        pc.onicecandidate = (e) => {
          if (e.candidate && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'webrtc:ice',
                toPeerId: msg.fromPeerId,
                candidate: e.candidate,
                streamId: streamTarget.id,
              })
            );
          }
        };
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(
          JSON.stringify({
            type: 'webrtc:answer',
            toPeerId: msg.fromPeerId,
            sdp: pc.localDescription,
            streamId: streamTarget.id,
          })
        );
      } else if (msg.type === 'webrtc:ice' && msg.candidate) {
        const targetPc = isHost
          ? msg.fromPeerId
            ? peerConnectionsRef.current.get(msg.fromPeerId)
            : undefined
          : viewerPcRef.current;
        if (targetPc) {
          try {
            await targetPc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } catch {
            // ignore
          }
        }
      } else if (msg.type === 'call:subtitle' && msg.originalText && msg.translations) {
        const translated = msg.translations[myLangRef.current] || msg.originalText;
        setLiveSubtitle({
          speaker: msg.senderName || streamTarget.hostName,
          original: msg.originalText,
          translated,
        });

        if (!isHost && autoSpeakRef.current) {
          try {
            const resp = await fetch('/api/tts', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                text: translated,
                voiceName: voiceRef.current,
                langName: getLanguageByCode(myLangRef.current).nameTr,
              }),
            });
            const data = (await resp.json()) as { audioBase64?: string };
            if (resp.ok && data.audioBase64) {
              await playWavBase64(data.audioBase64);
            }
          } catch {
            // ignore
          }
        }
      } else if (msg.type === 'stream:guest_comment' && msg.comment) {
        const gc = msg.comment;
        const localized = gc.translations[myLangRef.current] || gc.originalText;
        setLiveGuestComments((prev) => [
          ...prev,
          {
            id: gc.id,
            streamId: gc.streamId,
            authorUid: gc.authorUid,
            authorName: gc.authorName,
            sourceLang: gc.sourceLang,
            originalText: gc.originalText,
            translatedText: localized,
            targetLang: myLangRef.current,
          },
        ]);
      } else if (msg.type === 'stream:closed_by_admin') {
        setErrorMsg('Bu canlı yayın yönetici tarafından sonlandırıldı.');
        cleanupAllRtc();
        if (isHost) {
          stopHostMedia();
          setActiveHostStream(null);
        }
      }
    };

    return () => {
      cleanupAllRtc();
      ws.close();
    };
  }, [currentStream?.id, activeHostStream?.id]);

  const handleStartLiveStream = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) {
      onRequireAuth();
      return;
    }
    if (profile.status === 'banned') {
      setErrorMsg('Hesabınız kısıtlı olduğu için yayın açamazsınız.');
      return;
    }
    const cleanTitle = newTitle.trim().slice(0, 120);
    if (cleanTitle.length < 2) return;

    setIsStartingStream(true);
    setErrorMsg(null);
    const streamId = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    try {
      const media = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 720 }, height: { ideal: 1280 }, facingMode: 'user' },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      localStreamRef.current = media;

      const streamObj: LiveStream = {
        id: streamId,
        hostUid: profile.uid,
        hostName: profile.displayName.slice(0, 50),
        hostHandle: profile.handle.slice(0, 32),
        hostLang: myLang,
        title: cleanTitle,
        topic: newTopic.slice(0, 40),
        roomCode: `LIVE-${Math.floor(100 + Math.random() * 900)}`,
        isLive: true,
        featured: false,
        likesCount: 0,
        viewerCount: 1,
      };

      try {
        await setDoc(doc(db, 'streams', streamId), {
          ...streamObj,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `streams/${streamId}`);
      }

      setActiveHostStream(streamObj);
      setShowGoLiveModal(false);
      setNewTitle('');
      setTimeout(() => {
        if (videoRef.current) videoRef.current.srcObject = media;
      }, 50);
    } catch (err) {
      stopHostMedia();
      setErrorMsg(
        err instanceof Error
          ? `Canlı yayın başlatılamadı: ${err.message}`
          : 'Kamera/mikrofon izni verilmedi.'
      );
    } finally {
      setIsStartingStream(false);
    }
  };

  const handleEndHostStream = async () => {
    if (!activeHostStream) return;
    const sid = activeHostStream.id;
    stopHostMedia();
    cleanupAllRtc();
    setActiveHostStream(null);
    try {
      await updateDoc(doc(db, 'streams', sid), {
        isLive: false,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `streams/${sid}`);
    }
  };

  const startHostSpeechBroadcast = () => {
    if (!localStreamRef.current || !wsRef.current) return;
    const audioTracks = localStreamRef.current.getAudioTracks();
    if (audioTracks.length === 0) return;

    const recorder = new MediaRecorder(new MediaStream(audioTracks));
    hostRecRef.current = recorder;
    hostChunksRef.current = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) hostChunksRef.current.push(ev.data);
    };
    recorder.onstop = async () => {
      const mimeType = recorder.mimeType || 'audio/webm';
      const blob = new Blob(hostChunksRef.current, { type: mimeType });
      if (blob.size < 500) return;
      const audioBase64 = await blobToBase64(blob);
      wsRef.current?.send(
        JSON.stringify({
          type: 'call:speech_chunk',
          audioBase64,
          mimeType,
          speak: false,
        })
      );
    };
    recorder.start();
    setIsRecordingHostSpeech(true);
  };

  const stopHostSpeechBroadcast = () => {
    if (hostRecRef.current && hostRecRef.current.state !== 'inactive') {
      hostRecRef.current.stop();
    }
    setIsRecordingHostSpeech(false);
  };

  const handleLikeStream = async () => {
    if (!currentStream) return;
    const burstId = Date.now() + Math.random();
    const xOffset = Math.round((Math.random() - 0.5) * 28);
    setFloatingHearts((prev) => [...prev.slice(-6), { id: burstId, xOffset }]);
    window.setTimeout(() => {
      setFloatingHearts((prev) => prev.filter((h) => h.id !== burstId));
    }, 950);

    if (!profile) {
      onRequireAuth();
      return;
    }
    try {
      await updateDoc(doc(db, 'streams', currentStream.id), {
        likesCount: (currentStream.likesCount || 0) + 1,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `streams/${currentStream.id}`);
    }
  };

  const handleToggleFollow = async () => {
    if (!currentStream) return;
    if (!profile) {
      onRequireAuth();
      return;
    }
    if (profile.uid === currentStream.hostUid) return;

    const followId = `${profile.uid}_${currentStream.hostUid}`;
    const hostRef = doc(db, 'users', currentStream.hostUid);
    const selfRef = doc(db, 'users', profile.uid);

    try {
      if (isFollowingHost) {
        await deleteDoc(doc(db, 'follows', followId));
        setIsFollowingHost(false);
        const hostSnap = await getDoc(hostRef);
        const curFollowers = (hostSnap.data()?.followersCount as number) || 0;
        if (curFollowers > 0) {
          await updateDoc(hostRef, {
            followersCount: curFollowers - 1,
            updatedAt: serverTimestamp(),
          });
        }
        if (profile.followingCount > 0) {
          await updateDoc(selfRef, {
            followingCount: profile.followingCount - 1,
            updatedAt: serverTimestamp(),
          });
        }
      } else {
        await setDoc(doc(db, 'follows', followId), {
          id: followId,
          followerUid: profile.uid,
          targetUid: currentStream.hostUid,
          createdAt: serverTimestamp(),
        });
        setIsFollowingHost(true);
        const hostSnap = await getDoc(hostRef);
        const curFollowers = (hostSnap.data()?.followersCount as number) || 0;
        await updateDoc(hostRef, {
          followersCount: curFollowers + 1,
          updatedAt: serverTimestamp(),
        });
        await updateDoc(selfRef, {
          followingCount: (profile.followingCount || 0) + 1,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `follows/${followId}`);
    }
  };

  const handleSendComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentStream || !commentInput.trim()) return;

    const { safe, text: rawText } = sanitizeClientText(commentInput, 500);
    if (!safe || !rawText) {
      setErrorMsg('Güvenlik kalkanı: Geçersiz veya zararlı karakter içeren yorum engellendi.');
      return;
    }
    setCommentInput('');

    // Guest viewers can chat live over WebSocket without signing in!
    if (!profile) {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'stream:comment',
            text: rawText,
          })
        );
      }
      return;
    }

    if (profile.status === 'muted' || profile.status === 'banned') {
      setErrorMsg('Hesabınız yorum gönderme konusunda kısıtlanmıştır.');
      return;
    }

    setIsSendingComment(true);
    const commentId = `cmt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    try {
      let translatedText = rawText;
      if (myLang !== currentStream.hostLang) {
        const resp = await fetch('/api/translate-and-speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: rawText,
            sourceLang: myLang,
            targetLang: currentStream.hostLang,
            sourceLangName: getLanguageByCode(myLang).nameTr,
            targetLangName: getLanguageByCode(currentStream.hostLang).nameTr,
            speak: false,
          }),
        });
        const data = (await resp.json()) as { translatedText?: string };
        if (resp.ok && data.translatedText) {
          translatedText = data.translatedText.slice(0, 500);
        }
      }

      await setDoc(doc(db, 'streams', currentStream.id, 'comments', commentId), {
        id: commentId,
        streamId: currentStream.id,
        authorUid: profile.uid,
        authorName: profile.displayName.slice(0, 50),
        sourceLang: myLang,
        originalText: rawText,
        translatedText,
        targetLang: currentStream.hostLang,
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(
        err,
        OperationType.CREATE,
        `streams/${currentStream.id}/comments/${commentId}`
      );
    } finally {
      setIsSendingComment(false);
    }
  };

  const handleReportStream = async () => {
    if (!profile || !currentStream) {
      onRequireAuth();
      return;
    }
    const reportId = `rep_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    try {
      await setDoc(doc(db, 'reports', reportId), {
        id: reportId,
        reporterUid: profile.uid,
        targetUid: currentStream.hostUid,
        targetName: currentStream.hostName.slice(0, 50),
        reason: `Canlı yayın bildirimi (${currentStream.title.slice(0, 60)})`,
        status: 'open',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setNoticeMsg('Bildiriminiz yöneticiye iletildi.');
      setTimeout(() => setNoticeMsg(null), 2400);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `reports/${reportId}`);
    }
  };

  const combinedComments = [...dbComments, ...liveGuestComments];

  return (
    <div className="space-y-6">
      <section className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">{ui.liveFeedTitle}</h2>
          <p className="text-xs text-slate-500 mt-0.5">{ui.liveFeedDesc}</p>
        </div>

        <div className="flex items-center gap-3">
          {activeHostStream ? (
            <button
              type="button"
              onClick={() => void handleEndHostStream()}
              className="h-10 px-4 bg-rose-600 text-white rounded-lg text-xs font-semibold hover:bg-rose-700 inline-flex items-center gap-2 whitespace-nowrap shrink-0"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
              {ui.endMyStreamBtn}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => (profile ? setShowGoLiveModal(true) : onRequireAuth())}
              className="h-10 px-5 bg-rose-600 text-white rounded-lg text-sm font-semibold hover:bg-rose-700 inline-flex items-center gap-2 whitespace-nowrap shrink-0"
            >
              <Radio className="w-4 h-4" />
              {ui.goLiveBtn}
            </button>
          )}
        </div>
      </section>

      {errorMsg && (
        <div className="px-4 py-2.5 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800">
          {errorMsg}
        </div>
      )}
      {noticeMsg && (
        <div className="px-4 py-2.5 bg-teal-50 border border-teal-200 rounded-lg text-xs text-teal-900">
          {noticeMsg}
        </div>
      )}

      {streams.length > 1 && !activeHostStream && (
        <div
          data-no-tab-swipe="true"
          className="flex items-center gap-2.5 overflow-x-auto snap-x snap-mandatory pb-1"
        >
          {streams.map((s, idx) => (
            <button
              key={`live_strip_${s.id}`}
              type="button"
              onClick={() => setSelectedIndex(idx)}
              className={`snap-start shrink-0 min-h-[44px] px-3.5 py-2 rounded-xl border text-xs font-semibold inline-flex items-center gap-2 transition-colors ${
                idx === selectedIndex
                  ? 'bg-slate-900 border-slate-900 text-white'
                  : 'bg-white border-slate-200 text-slate-800 hover:bg-slate-50'
              }`}
            >
              <Radio className={`w-3.5 h-3.5 ${idx === selectedIndex ? 'text-rose-400' : 'text-rose-600'}`} />
              <span className="max-w-[140px] truncate">{s.hostName}</span>
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr_280px] gap-6 items-start">
        <section
          data-no-tab-swipe="true"
          onTouchStart={(e) => {
            if (e.touches.length !== 1) return;
            const target = e.target as HTMLElement | null;
            if (target?.closest('button, input, textarea, select')) return;
            stageSwipeStartRef.current = {
              x: e.touches[0].clientX,
              y: e.touches[0].clientY,
            };
          }}
          onTouchEnd={(e) => {
            if (!stageSwipeStartRef.current || streams.length < 2 || activeHostStream) {
              stageSwipeStartRef.current = null;
              return;
            }
            const t = e.changedTouches[0];
            const dx = t.clientX - stageSwipeStartRef.current.x;
            const dy = t.clientY - stageSwipeStartRef.current.y;
            stageSwipeStartRef.current = null;
            if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy)) {
              setSelectedIndex((prev) =>
                dx < 0 ? (prev + 1) % streams.length : (prev - 1 + streams.length) % streams.length
              );
            } else if (Math.abs(dy) > 55 && Math.abs(dy) > Math.abs(dx)) {
              setSelectedIndex((prev) =>
                dy < 0 ? (prev + 1) % streams.length : (prev - 1 + streams.length) % streams.length
              );
            }
          }}
          className="bg-slate-950 border border-slate-800 rounded-2xl overflow-hidden relative aspect-[9/16] max-h-[640px] w-full mx-auto flex flex-col justify-between"
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={Boolean(activeHostStream)}
            className={`absolute inset-0 w-full h-full object-cover ${
              activeHostStream ? 'scale-x-[-1]' : ''
            }`}
          />

          {!currentStream && (
            <div className="absolute inset-0 flex flex-col items-center justify-end p-6 text-center bg-slate-950 overflow-hidden">
              {!stageImgFailed ? (
                <img
                  src="/src/assets/images/live_community_stage_1795268562730.jpg"
                  alt="Live multilingual broadcast studio"
                  referrerPolicy="no-referrer"
                  onError={() => setStageImgFailed(true)}
                  className="absolute inset-0 w-full h-full object-cover opacity-65"
                />
              ) : (
                <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-teal-950 to-slate-950 flex items-center justify-center">
                  <Video className="w-10 h-10 text-slate-600" />
                </div>
              )}
              <div className="relative z-10 w-full p-4 rounded-xl bg-gradient-to-t from-black/90 via-black/75 to-black/45">
                <p className="text-sm font-semibold text-white">{ui.noStreamsTitle}</p>
                <p className="text-xs text-slate-200 mt-1.5 leading-relaxed">{ui.noStreamsDesc}</p>
                <button
                  type="button"
                  onClick={() => (profile ? setShowGoLiveModal(true) : onRequireAuth())}
                  className="mt-4 h-10 px-4 bg-rose-600 text-white rounded-lg text-xs font-semibold hover:bg-rose-700 inline-flex items-center gap-2"
                >
                  <Camera className="w-4 h-4" />
                  {ui.startFirstStream}
                </button>
              </div>
            </div>
          )}

          {currentStream && (
            <>
              <div className="relative z-10 p-4 bg-gradient-to-b from-black/75 to-transparent flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-xs text-white font-semibold">
                    <span className="px-1.5 py-0.5 bg-rose-600 rounded text-[10px] font-bold tracking-wide">
                      LIVE
                    </span>
                    <span className="truncate">{currentStream.hostName}</span>
                  </div>
                  <div className="text-[11px] text-slate-200 mt-0.5">
                    @{currentStream.hostHandle} · {getLanguageByCode(currentStream.hostLang).nameTr}
                  </div>
                </div>

                <div className="px-2.5 py-1 bg-black/55 rounded-md text-xs text-white font-mono tabular-nums inline-flex items-center gap-1.5 shrink-0">
                  <Users className="w-3.5 h-3.5 text-teal-400" />
                  {liveViewerCount}
                </div>
              </div>

              <div className="relative z-10 flex-1 flex items-center justify-end px-3">
                <div className="flex flex-col items-center gap-3">
                  {streams.length > 1 && !activeHostStream && (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedIndex((prev) => (prev - 1 + streams.length) % streams.length)
                        }
                        aria-label="Önceki Yayın"
                        className="w-10 h-10 rounded-full bg-black/55 text-white hover:bg-black/75 flex items-center justify-center"
                      >
                        <ChevronLeft className="w-5 h-5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedIndex((prev) => (prev + 1) % streams.length)}
                        aria-label="Sonraki Yayın"
                        className="w-10 h-10 rounded-full bg-black/55 text-white hover:bg-black/75 flex items-center justify-center"
                      >
                        <ChevronRight className="w-5 h-5" />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedIndex((prev) => (prev - 1 + streams.length) % streams.length)
                        }
                        aria-label="Yukarı"
                        className="hidden sm:flex w-10 h-10 rounded-full bg-black/55 text-white hover:bg-black/75 items-center justify-center"
                      >
                        <ChevronUp className="w-5 h-5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedIndex((prev) => (prev + 1) % streams.length)}
                        aria-label="Aşağı"
                        className="hidden sm:flex w-10 h-10 rounded-full bg-black/55 text-white hover:bg-black/75 items-center justify-center"
                      >
                        <ChevronDown className="w-5 h-5" />
                      </button>
                    </>
                  )}

                  <div className="relative">
                    <AnimatePresence>
                      {!shouldReduceMotion &&
                        floatingHearts.map((heart) => (
                          <motion.span
                            key={heart.id}
                            initial={{ opacity: 0.95, y: 0, x: heart.xOffset, scale: 0.7 }}
                            animate={{ opacity: 0, y: -64, scale: 1.25 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.85, ease: 'easeOut' }}
                            className="pointer-events-none absolute -top-2 left-1/2 -translate-x-1/2 text-rose-500"
                          >
                            <Heart className="w-5 h-5 fill-current" />
                          </motion.span>
                        ))}
                    </AnimatePresence>
                    <button
                      type="button"
                      onClick={() => void handleLikeStream()}
                      className="flex flex-col items-center gap-1 text-white"
                    >
                      <span className="w-10 h-10 rounded-full bg-black/55 hover:bg-rose-600/80 flex items-center justify-center transition-colors">
                        <Heart className="w-5 h-5" />
                      </span>
                      <span className="text-[11px] font-mono tabular-nums">
                        {currentStream.likesCount}
                      </span>
                    </button>
                  </div>

                  {profile?.uid !== currentStream.hostUid && (
                    <button
                      type="button"
                      onClick={() => void handleToggleFollow()}
                      className="flex flex-col items-center gap-1 text-white"
                    >
                      <span
                        className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
                          isFollowingHost ? 'bg-teal-600' : 'bg-black/55 hover:bg-teal-600/80'
                        }`}
                      >
                        {isFollowingHost ? (
                          <UserCheck className="w-4 h-4" />
                        ) : (
                          <UserPlus className="w-4 h-4" />
                        )}
                      </span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => void handleReportStream()}
                    aria-label={ui.reportBtn}
                    className="w-10 h-10 rounded-full bg-black/55 text-slate-200 hover:text-rose-300 flex items-center justify-center"
                  >
                    <Flag className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="relative z-10 p-4 bg-gradient-to-t from-black/90 via-black/60 to-transparent space-y-2.5">
                {liveSubtitle && (
                  <div className="p-2.5 bg-black/60 rounded-lg border border-white/10 space-y-0.5">
                    <div className="text-[11px] font-medium text-teal-300">
                      {getLanguageByCode(myLang).nameTr}
                    </div>
                    <p className="text-xs font-semibold text-white">{liveSubtitle.translated}</p>
                    {liveSubtitle.original !== liveSubtitle.translated && (
                      <p className="text-[11px] text-slate-300">{liveSubtitle.original}</p>
                    )}
                  </div>
                )}

                <div>
                  <p className="text-sm font-semibold text-white leading-snug">
                    {currentStream.title}
                  </p>
                  <p className="text-xs text-slate-300 mt-0.5">{currentStream.topic}</p>
                </div>

                {activeHostStream ? (
                  <button
                    type="button"
                    onClick={() =>
                      isRecordingHostSpeech
                        ? stopHostSpeechBroadcast()
                        : startHostSpeechBroadcast()
                    }
                    className={`w-full h-9 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-2 ${
                      isRecordingHostSpeech
                        ? 'bg-rose-600 text-white'
                        : 'bg-teal-600 text-white hover:bg-teal-700'
                    }`}
                  >
                    <Mic className="w-3.5 h-3.5" />
                    {isRecordingHostSpeech ? ui.sendTranslate : ui.pushTranslate}
                  </button>
                ) : (
                  <label className="inline-flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoSpeakHostSubtitles}
                      onChange={(e) => setAutoSpeakHostSubtitles(e.target.checked)}
                      className="accent-teal-500 rounded"
                    />
                    <Volume2 className="w-3.5 h-3.5 text-teal-400" />
                    {ui.autoDubCheck}
                  </label>
                )}
              </div>
            </>
          )}
        </section>

        {/* Comments (works for Guests via WebSocket + Registered users via Firestore!) */}
        <section className="bg-white border border-slate-200 rounded-xl flex flex-col min-h-[540px]">
          <div className="p-4 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">{ui.streamChatTitle}</h3>
              <p className="text-xs text-slate-500 mt-0.5">{ui.streamChatDesc}</p>
            </div>
            <span className="text-xs font-mono tabular-nums text-slate-500">
              {combinedComments.length}
            </span>
          </div>

          <div className="flex-1 divide-y divide-slate-200 overflow-y-auto max-h-[420px]">
            {combinedComments.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                {ui.streamChatPlaceholder}
              </div>
            ) : (
              combinedComments.map((c) => (
                <div key={c.id} className="p-3.5 space-y-1">
                  <div className="flex items-center gap-2 text-[11px] text-slate-500">
                    <span className="font-semibold text-slate-900">{c.authorName}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {getLanguageByCode(c.sourceLang).code.toUpperCase()} →{' '}
                      {getLanguageByCode(c.targetLang).code.toUpperCase()}
                    </span>
                  </div>
                  <p className="text-xs font-medium text-slate-900">{c.translatedText}</p>
                  {c.originalText !== c.translatedText && (
                    <p className="text-[11px] text-slate-500">{c.originalText}</p>
                  )}
                </div>
              ))
            )}
          </div>

          <form onSubmit={(e) => void handleSendComment(e)} className="p-3.5 border-t border-slate-200 flex gap-2">
            <input
              type="text"
              disabled={!currentStream || isSendingComment}
              value={commentInput}
              onChange={(e) => setCommentInput(e.target.value)}
              placeholder={ui.streamChatPlaceholder}
              className="flex-1 h-9 px-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-900 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!currentStream || !commentInput.trim() || isSendingComment}
              className="h-9 px-3.5 bg-teal-600 text-white rounded-lg text-xs font-semibold hover:bg-teal-700 disabled:opacity-40 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              {isSendingComment ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
              {ui.sendBtn}
            </button>
          </form>
        </section>

        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-200">
            <h3 className="text-sm font-semibold text-slate-900">{ui.activeStreamsTitle}</h3>
          </div>
          <div className="divide-y divide-slate-200 max-h-[520px] overflow-y-auto">
            {streams.length === 0 ? (
              <div className="p-6 text-xs text-slate-500 text-center">{ui.noStreamsTitle}</div>
            ) : (
              streams.map((st, idx) => {
                const isSelected = currentStream?.id === st.id;
                return (
                  <button
                    key={st.id}
                    type="button"
                    onClick={() => setSelectedIndex(idx)}
                    className={`w-full p-3.5 text-left transition-colors ${
                      isSelected ? 'bg-teal-50/70' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-semibold text-slate-900 truncate">{st.hostName}</span>
                      <span className="font-mono text-[11px] text-rose-600 shrink-0">LIVE</span>
                    </div>
                    <p className="text-xs text-slate-700 mt-1 line-clamp-2">{st.title}</p>
                    <div className="text-[11px] text-slate-500 mt-1.5 flex items-center gap-1.5">
                      <span>{getLanguageByCode(st.hostLang).nameTr}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">{st.likesCount}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>
      </div>

      {showGoLiveModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900 font-display">{ui.goLiveBtn}</h3>
              <button
                type="button"
                onClick={() => setShowGoLiveModal(false)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleStartLiveStream(e)} className="space-y-4">
              <div>
                <label htmlFor="stream-title" className="block text-xs font-medium text-slate-600 mb-1">
                  Title
                </label>
                <input
                  id="stream-title"
                  type="text"
                  required
                  minLength={2}
                  maxLength={120}
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="w-full h-10 px-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900"
                />
              </div>

              <div>
                <label htmlFor="stream-topic" className="block text-xs font-medium text-slate-600 mb-1">
                  Topic
                </label>
                <select
                  id="stream-topic"
                  value={newTopic}
                  onChange={(e) => setNewTopic(e.target.value)}
                  className="w-full h-10 px-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900"
                >
                  <option value="Sohbet & Kültür">Sohbet &amp; Kültür</option>
                  <option value="Dil Pratiği">Dil Pratiği</option>
                  <option value="İş & Anlaşma">İş &amp; Anlaşma</option>
                  <option value="Müzik & Sanat">Müzik &amp; Sanat</option>
                  <option value="Teknoloji">Teknoloji</option>
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowGoLiveModal(false)}
                  className="h-10 px-4 border border-slate-200 rounded-lg text-xs font-medium text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isStartingStream}
                  className="h-10 px-5 bg-rose-600 text-white rounded-lg text-sm font-semibold hover:bg-rose-700 inline-flex items-center gap-2 disabled:opacity-50"
                >
                  {isStartingStream && <Loader2 className="w-4 h-4 animate-spin" />}
                  {ui.goLiveBtn}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
