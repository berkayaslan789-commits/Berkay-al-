import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  FilePlus2,
  Globe,
  Link2,
  Loader2,
  LogOut,
  Mic,
  Send,
  Square,
  Users,
  Volume2,
} from 'lucide-react';
import type { UiStrings } from '../i18n';
import { getLanguageByCode, WORLD_LANGUAGES } from '../languages';
import type { AgreementItem, RoomMessage, RoomParticipant } from '../types';
import { blobToBase64, playWavBase64 } from '../utils/audio';

interface GlobalVoiceRoomProps {
  initialRoomCode: string;
  defaultLang: string;
  voiceName: string;
  ui: UiStrings;
  onSyncRoomAgreements?: (items: AgreementItem[]) => void;
}

export function GlobalVoiceRoom({
  initialRoomCode,
  defaultLang,
  voiceName,
  ui,
}: GlobalVoiceRoomProps) {
  const [roomCode, setRoomCode] = useState(initialRoomCode || 'DUNYA-101');
  const [displayName, setDisplayName] = useState(
    () => `Guest-${Math.floor(100 + Math.random() * 900)}`
  );
  const [myLang, setMyLang] = useState(defaultLang);
  const [joined, setJoined] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(true);

  const [participants, setParticipants] = useState<RoomParticipant[]>([]);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [roomAgreements, setRoomAgreements] = useState<AgreementItem[]>([]);
  const [textInput, setTextInput] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isSendingVoice, setIsSendingVoice] = useState(false);
  const [playingMsgId, setPlayingMsgId] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const participantIdRef = useRef<string>(
    `user_${Math.random().toString(36).slice(2, 9)}`
  );
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const autoSpeakRef = useRef(autoSpeak);
  const myLangRef = useRef(myLang);
  const voiceNameRef = useRef(voiceName);

  autoSpeakRef.current = autoSpeak;
  myLangRef.current = myLang;
  voiceNameRef.current = voiceName;

  const leaveRoom = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setJoined(false);
    setParticipants([]);
  };

  useEffect(() => {
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  useEffect(() => {
    if (joined && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const langInfo = getLanguageByCode(myLang);
      wsRef.current.send(
        JSON.stringify({
          type: 'update_lang',
          langCode: myLang,
          langName: langInfo.nameTr,
        })
      );
    }
  }, [myLang, joined]);

  const speakText = async (text: string, langCode: string, msgId: string) => {
    try {
      setPlayingMsgId(msgId);
      const resp = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voiceName: voiceNameRef.current,
          langName: getLanguageByCode(langCode).nameTr,
        }),
      });
      const data = (await resp.json()) as { audioBase64?: string };
      if (resp.ok && data.audioBase64) {
        await playWavBase64(data.audioBase64);
      }
    } catch {
      // ignore playback error on background auto-speak
    } finally {
      setPlayingMsgId((prev) => (prev === msgId ? null : prev));
    }
  };

  const joinRoom = () => {
    setErrorMsg(null);
    if (!roomCode.trim() || !displayName.trim()) {
      setErrorMsg('Lütfen oda kodu ve görünen adınızı girin.');
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/room`);
    wsRef.current = ws;

    ws.onopen = () => {
      const langInfo = getLanguageByCode(myLang);
      ws.send(
        JSON.stringify({
          type: 'join',
          roomId: roomCode.trim().toUpperCase(),
          participantId: participantIdRef.current,
          name: displayName.trim(),
          langCode: myLang,
          langName: langInfo.nameTr,
        })
      );
      setJoined(true);
    };

    ws.onmessage = (ev) => {
      const payload = JSON.parse(ev.data as string) as {
        type: string;
        roomId?: string;
        participants?: RoomParticipant[];
        messages?: RoomMessage[];
        message?: RoomMessage;
        agreements?: AgreementItem[];
        messageText?: string;
      };

      if (payload.type === 'room:init') {
        setParticipants(payload.participants || []);
        setMessages(payload.messages || []);
        setRoomAgreements(payload.agreements || []);
      } else if (payload.type === 'room:participants') {
        setParticipants(payload.participants || []);
      } else if (payload.type === 'room:agreements') {
        setRoomAgreements(payload.agreements || []);
      } else if (payload.type === 'message:created' && payload.message) {
        const incoming = payload.message;
        setMessages((prev) =>
          prev.some((m) => m.id === incoming.id) ? prev : [...prev, incoming]
        );
        setIsSendingVoice(false);

        if (
          autoSpeakRef.current &&
          incoming.senderId !== participantIdRef.current
        ) {
          const localized =
            incoming.translations[myLangRef.current] || incoming.originalText;
          void speakText(localized, myLangRef.current, incoming.id);
        }
      } else if (payload.type === 'room:error') {
        setIsSendingVoice(false);
        setErrorMsg((payload as { message?: string }).message || 'Oda hatası.');
      }
    };

    ws.onerror = () => {
      setErrorMsg('Oda bağlantısı kurulamadı.');
      setJoined(false);
    };

    ws.onclose = () => {
      setJoined(false);
    };
  };

  const handleSendText = (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim() || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }
    wsRef.current.send(
      JSON.stringify({
        type: 'chat_message',
        messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        text: textInput.trim(),
      })
    );
    setTextInput('');
  };

  const startVoiceRecord = async () => {
    setErrorMsg(null);
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      wsRef.current.send(JSON.stringify({ type: 'typing', isSpeaking: true }));

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };

      recorder.onstop = async () => {
        for (const t of stream.getTracks()) t.stop();
        wsRef.current?.send(JSON.stringify({ type: 'typing', isSpeaking: false }));

        const mimeType = recorder.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: mimeType });
        if (blob.size < 400) return;

        setIsSendingVoice(true);
        try {
          const audioBase64 = await blobToBase64(blob);
          wsRef.current?.send(
            JSON.stringify({
              type: 'chat_message',
              messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              audioBase64,
              mimeType,
            })
          );
        } catch (err) {
          setIsSendingVoice(false);
          setErrorMsg(err instanceof Error ? err.message : 'Ses gönderilemedi.');
        }
      };

      recorder.start();
      setIsRecording(true);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? `Mikrofon açılamadı: ${err.message}` : 'Mikrofon hatası.'
      );
    }
  };

  const stopVoiceRecord = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  };

  const handleCopyInvite = async () => {
    const cleanCode = roomCode.trim().toUpperCase() || 'DUNYA-101';
    const url = `${window.location.origin}/?room=${encodeURIComponent(cleanCode)}`;
    await navigator.clipboard.writeText(url);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 1800);
  };

  const handleAddRoomAgreement = (msg: RoomMessage) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const translated = msg.translations[myLang] || msg.originalText;
    wsRef.current.send(
      JSON.stringify({
        type: 'agreement:add',
        agreement: {
          id: `agree_${msg.id}`,
          original: msg.originalText,
          translated,
          owner: msg.senderName,
          confirmed: false,
          timestamp: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
        },
      })
    );
  };

  const handleToggleAgreement = (id: string, confirmed: boolean) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(
      JSON.stringify({
        type: 'agreement:toggle',
        agreementId: id,
        confirmed,
      })
    );
  };

  return (
    <div className="space-y-6">
      {/* Room Connection Bar */}
      <section className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Küresel Çok Dilli Sesli Sohbet Odası
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Oda bağlantısını dünyanın herhangi bir yerindeki biriyle paylaşın; herkes kendi dilinde konuşur ve dinler.
            </p>
          </div>

          <button
            type="button"
            onClick={() => void handleCopyInvite()}
            className="h-9 px-3.5 bg-white border border-slate-200 rounded-lg text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
          >
            {copiedLink ? (
              <Check className="w-3.5 h-3.5 text-teal-600" />
            ) : (
              <Link2 className="w-3.5 h-3.5" />
            )}
            {copiedLink ? 'Davet Linki Kopyalandı' : 'Davet Linkini Kopyala'}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_auto] gap-3 items-end">
          <div>
            <label htmlFor="room-code" className="block text-xs font-medium text-slate-500 mb-1.5">
              Oda Kodu
            </label>
            <input
              id="room-code"
              type="text"
              disabled={joined}
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
              className="w-full h-10 px-3 bg-slate-50 border border-slate-200 rounded-lg text-sm font-mono font-medium text-slate-900 disabled:opacity-60"
            />
          </div>

          <div>
            <label htmlFor="room-name" className="block text-xs font-medium text-slate-500 mb-1.5">
              Görünen Adın
            </label>
            <input
              id="room-name"
              type="text"
              disabled={joined}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full h-10 px-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 disabled:opacity-60"
            />
          </div>

          <div>
            <label htmlFor="room-lang" className="block text-xs font-medium text-slate-500 mb-1.5">
              {ui.yourLang}
            </label>
            <select
              id="room-lang"
              value={myLang}
              onChange={(e) => setMyLang(e.target.value)}
              className="w-full h-10 px-3 bg-slate-50 border border-slate-200 rounded-lg text-sm font-medium text-slate-900"
            >
              {WORLD_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.nativeName} ({l.nameTr})
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={() => (joined ? leaveRoom() : joinRoom())}
            className={`h-10 px-5 rounded-lg text-sm font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 ${
              joined
                ? 'bg-slate-900 text-white hover:bg-slate-800'
                : 'bg-teal-600 text-white hover:bg-teal-700'
            }`}
          >
            {joined ? (
              <>
                <LogOut className="w-4 h-4" />
                Odadan Ayrıl
              </>
            ) : (
              <>
                <Globe className="w-4 h-4" />
                Odaya Katıl
              </>
            )}
          </button>
        </div>

        {joined && (
          <div className="mt-4 pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600">
              <span className="inline-flex items-center gap-1.5 font-medium text-slate-900">
                <Users className="w-3.5 h-3.5 text-teal-600" />
                Katılımcılar ({participants.length}):
              </span>
              {participants.map((p) => (
                <span key={p.id} className="inline-flex items-center gap-1.5">
                  <span className="font-medium text-slate-800">{p.name}</span>
                  <span className="text-slate-400">·</span>
                  <span>{p.langName}</span>
                  {p.isSpeaking && (
                    <span className="text-teal-700 font-medium">(Konuşuyor...)</span>
                  )}
                </span>
              ))}
            </div>

            <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoSpeak}
                onChange={(e) => setAutoSpeak(e.target.checked)}
                className="w-4 h-4 accent-teal-600 rounded"
              />
              Gelen mesajları otomatik seslendir
            </label>
          </div>
        )}

        {errorMsg && (
          <div className="mt-3 px-3.5 py-2.5 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800">
            {errorMsg}
          </div>
        )}
      </section>

      {/* Live Room Chat + Shared Room Agreements */}
      {joined ? (
        <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-6">
          <section className="bg-white border border-slate-200 rounded-xl flex flex-col min-h-[460px]">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-900">
                Oda Mesajları · <span className="font-mono">{roomCode}</span>
              </div>
              <div className="text-xs text-slate-500">
                Tüm mesajlar otomatik olarak {getLanguageByCode(myLang).nameTr} diline çevrilir
              </div>
            </div>

            <div className="flex-1 divide-y divide-slate-200 overflow-y-auto max-h-[420px]">
              {messages.length === 0 ? (
                <div className="p-10 text-center text-xs text-slate-500">
                  Oda aktif. Sesli konuşmaya başlayın veya ilk mesajı yazın.
                </div>
              ) : (
                messages.map((msg) => {
                  const isMine = msg.senderId === participantIdRef.current;
                  const localized = msg.translations[myLang] || msg.originalText;
                  const timeStr = new Date(msg.timestamp).toLocaleTimeString('tr-TR', {
                    hour: '2-digit',
                    minute: '2-digit',
                  });

                  return (
                    <div key={msg.id} className="p-4">
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <div className="text-xs text-slate-500 flex items-center gap-2">
                          <span className="font-semibold text-slate-900">
                            {msg.senderName} {isMine ? '(Sen)' : ''}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{getLanguageByCode(msg.sourceLang).nameTr}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">{timeStr}</span>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => void speakText(localized, myLang, msg.id)}
                            className="h-7 px-2 border border-slate-200 rounded text-xs text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
                          >
                            <Volume2 className="w-3 h-3" />
                            {playingMsgId === msg.id ? 'Okunuyor' : 'Dinle'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleAddRoomAgreement(msg)}
                            className="h-7 px-2 border border-slate-200 rounded text-xs text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
                          >
                            <FilePlus2 className="w-3 h-3" />
                            Karara Ekle
                          </button>
                        </div>
                      </div>

                      <p className="text-sm font-medium text-slate-900">{localized}</p>
                      {msg.sourceLang !== myLang && (
                        <p className="text-xs text-slate-500 mt-1">
                          Orijinal: {msg.originalText}
                        </p>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            <div className="p-4 border-t border-slate-200 bg-slate-50/70 rounded-b-xl">
              <form onSubmit={handleSendText} className="flex flex-wrap sm:flex-nowrap gap-2">
                <button
                  type="button"
                  disabled={isSendingVoice}
                  onClick={() => (isRecording ? stopVoiceRecord() : void startVoiceRecord())}
                  className={`h-10 px-4 rounded-lg text-xs font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 ${
                    isRecording
                      ? 'bg-rose-600 text-white hover:bg-rose-700'
                      : 'bg-teal-600 text-white hover:bg-teal-700'
                  }`}
                >
                  {isSendingVoice ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : isRecording ? (
                    <Square className="w-3.5 h-3.5 fill-current" />
                  ) : (
                    <Mic className="w-4 h-4" />
                  )}
                  {isSendingVoice
                    ? 'Çevriliyor...'
                    : isRecording
                      ? 'Bitir ve Gönder'
                      : 'Sesli Konuş'}
                </button>

                <input
                  type="text"
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder={ui.chatPlaceholder}
                  className="flex-1 min-w-[180px] h-10 px-3.5 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-600"
                />

                <button
                  type="submit"
                  disabled={!textInput.trim()}
                  className="h-10 px-4 bg-slate-900 text-white rounded-lg text-xs font-medium inline-flex items-center gap-1.5 hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0"
                >
                  <Send className="w-3.5 h-3.5" />
                  {ui.sendBtn}
                </button>
              </form>
            </div>
          </section>

          {/* Shared Room Agreement Sync */}
          <section className="bg-white border border-slate-200 rounded-xl flex flex-col">
            <div className="px-5 py-3.5 border-b border-slate-200">
              <h3 className="text-sm font-semibold text-slate-900">
                Ortak Oda Anlaşmaları
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Odadaki herkesin onaylayabileceği ortak kararlar
              </p>
            </div>
            <div className="divide-y divide-slate-200 flex-1">
              {roomAgreements.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500">
                  Bir mesajda “Karara Ekle” düğmesine tıklayarak ortak anlaşma maddesi oluşturabilirsiniz.
                </div>
              ) : (
                roomAgreements.map((item) => (
                  <label
                    key={item.id}
                    className="p-4 flex items-start gap-3 cursor-pointer hover:bg-slate-50 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={item.confirmed}
                      onChange={(e) => handleToggleAgreement(item.id, e.target.checked)}
                      className="mt-1 w-4 h-4 accent-teal-600 rounded"
                    />
                    <div className="text-xs space-y-1">
                      <p className="font-medium text-slate-900">{item.translated}</p>
                      {item.original !== item.translated && (
                        <p className="text-slate-500">{item.original}</p>
                      )}
                      <div className="text-slate-400">
                        {item.owner} · {item.timestamp}
                      </div>
                    </div>
                  </label>
                ))
              )}
            </div>
          </section>
        </div>
      ) : (
        <section className="bg-white border border-slate-200 rounded-xl p-10 text-center">
          <Globe className="w-9 h-9 text-teal-600 mx-auto mb-3" />
          <h3 className="text-base font-semibold text-slate-900">
            Farklı Dillerdeki İnsanlarla Aynı Odada Buluşun
          </h3>
          <p className="text-xs text-slate-500 mt-1.5 max-w-lg mx-auto leading-relaxed">
            Odaya katıldığınızda seçtiğiniz oda kodunu veya davet bağlantısını karşı tarafa gönderin. Siz Türkçe konuşurken, Tokyo’daki veya Madrid’deki kişi sizi kendi dilinde yazılı ve sesli olarak anında duyar.
          </p>
        </section>
      )}
    </div>
  );
}
