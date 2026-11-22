import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  Check,
  Copy,
  FilePlus2,
  Loader2,
  Mic,
  MicOff,
  Send,
  Square,
  Volume2,
  Waves,
} from 'lucide-react';
import type { UiStrings } from '../i18n';
import { getLanguageByCode, VOICE_PERSONAS, WORLD_LANGUAGES } from '../languages';
import type { TranscriptTurn } from '../types';
import {
  blobToBase64,
  GaplessPcmPlayer,
  pcmFloat32ToBase64,
  playWavBase64,
  stopWavPlayback,
} from '../utils/audio';
import { AudioWaveform } from './AudioWaveform';

interface LiveInterpreterProps {
  langA: string;
  langB: string;
  voiceName: string;
  ui: UiStrings;
  onChangeLangA: (code: string) => void;
  onChangeLangB: (code: string) => void;
  onSwapLanguages: () => void;
  onChangeVoice: (voice: string) => void;
  turns: TranscriptTurn[];
  onAddTurn: (turn: TranscriptTurn) => void;
  onAddAgreement: (original: string, translated: string, owner: string) => void;
}

export function LiveInterpreter({
  langA,
  langB,
  voiceName,
  ui,
  onChangeLangA,
  onChangeLangB,
  onSwapLanguages,
  onChangeVoice,
  turns,
  onAddTurn,
  onAddAgreement,
}: LiveInterpreterProps) {
  const [streamMode, setStreamMode] = useState<'live' | 'turn'>('live');
  const [liveDirection, setLiveDirection] = useState<'A_TO_B' | 'B_TO_A'>('A_TO_B');
  const [isLiveActive, setIsLiveActive] = useState(false);
  const [liveStatus, setLiveStatus] = useState<string>('Hazır');
  const [isOutputPlaying, setIsOutputPlaying] = useState(false);
  const [draftInput, setDraftInput] = useState('');
  const [draftOutput, setDraftOutput] = useState('');

  const [recordingSpeaker, setRecordingSpeaker] = useState<'self' | 'partner' | null>(null);
  const [isProcessingTurn, setIsProcessingTurn] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [textSpeaker, setTextSpeaker] = useState<'self' | 'partner'>('self');
  const [playingTurnId, setPlayingTurnId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const inputCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const pcmPlayerRef = useRef<GaplessPcmPlayer | null>(null);

  const draftInRef = useRef('');
  const draftOutRef = useRef('');
  const liveDirectionRef = useRef(liveDirection);
  const langARef = useRef(langA);
  const langBRef = useRef(langB);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  liveDirectionRef.current = liveDirection;
  langARef.current = langA;
  langBRef.current = langB;

  const activeSourceCode = liveDirection === 'A_TO_B' ? langA : langB;
  const activeTargetCode = liveDirection === 'A_TO_B' ? langB : langA;
  const langAInfo = getLanguageByCode(langA);
  const langBInfo = getLanguageByCode(langB);

  const commitLiveDraft = () => {
    const orig = draftInRef.current.trim();
    const trans = draftOutRef.current.trim();
    if (!orig && !trans) return;

    const dir = liveDirectionRef.current;
    const sLang = dir === 'A_TO_B' ? langARef.current : langBRef.current;
    const tLang = dir === 'A_TO_B' ? langBRef.current : langARef.current;

    onAddTurn({
      id: `turn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      speaker: dir === 'A_TO_B' ? 'self' : 'partner',
      speakerLabel: dir === 'A_TO_B' ? 'Sen' : 'Karşı Taraf',
      sourceLang: sLang,
      targetLang: tLang,
      originalText: orig || '...',
      translatedText: trans || '...',
      timestamp: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
    });

    draftInRef.current = '';
    draftOutRef.current = '';
    setDraftInput('');
    setDraftOutput('');
  };

  const stopLiveSession = () => {
    commitLiveDraft();
    setIsLiveActive(false);
    setLiveStatus('Hazır');

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (inputCtxRef.current && inputCtxRef.current.state !== 'closed') {
      void inputCtxRef.current.close();
      inputCtxRef.current = null;
    }
    if (micStreamRef.current) {
      for (const track of micStreamRef.current.getTracks()) {
        track.stop();
      }
      micStreamRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (pcmPlayerRef.current) {
      pcmPlayerRef.current.dispose();
      pcmPlayerRef.current = null;
    }
    setAnalyser(null);
    setIsOutputPlaying(false);
  };

  useEffect(() => {
    return () => {
      stopLiveSession();
      stopWavPlayback();
    };
  }, []);

  // Reconfigure target language when user swaps direction or language while live
  useEffect(() => {
    if (isLiveActive && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      commitLiveDraft();
      wsRef.current.send(
        JSON.stringify({
          type: 'config',
          targetLang: activeTargetCode,
        })
      );
      setLiveStatus(`Hedef dil güncelleniyor (${getLanguageByCode(activeTargetCode).nameTr})...`);
    }
  }, [activeTargetCode, isLiveActive]);

  const startLiveSession = async () => {
    setErrorMsg(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micStreamRef.current = stream;

      const inputCtx = new AudioContext({ sampleRate: 16000 });
      inputCtxRef.current = inputCtx;
      const source = inputCtx.createMediaStreamSource(stream);
      const analyserNode = inputCtx.createAnalyser();
      analyserNode.fftSize = 128;
      source.connect(analyserNode);
      setAnalyser(analyserNode);

      const processor = inputCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      source.connect(processor);
      processor.connect(inputCtx.destination);

      const player = new GaplessPcmPlayer();
      player.onPlaybackStateChange = (playing) => setIsOutputPlaying(playing);
      pcmPlayerRef.current = player;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(
        `${protocol}//${window.location.host}/ws/live-translate?targetLang=${encodeURIComponent(
          activeTargetCode
        )}`
      );
      wsRef.current = ws;

      setLiveStatus('Canlı ses motoru bağlanıyor...');
      setIsLiveActive(true);

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as {
          type: string;
          text?: string;
          data?: string;
          message?: string;
          targetLang?: string;
        };

        if (msg.type === 'ready') {
          const targetInfo = getLanguageByCode(msg.targetLang || activeTargetCode);
          setLiveStatus(`Canlı çeviri aktif · Hedef: ${targetInfo.nameTr}`);
        } else if (msg.type === 'inputTranscript' && msg.text) {
          draftInRef.current += msg.text;
          setDraftInput(draftInRef.current);
        } else if (msg.type === 'outputTranscript' && msg.text) {
          draftOutRef.current += msg.text;
          setDraftOutput(draftOutRef.current);
        } else if (msg.type === 'audio' && msg.data) {
          pcmPlayerRef.current?.enqueuePcm24Base64(msg.data);
        } else if (msg.type === 'interrupted') {
          pcmPlayerRef.current?.interrupt();
        } else if (msg.type === 'turnComplete') {
          commitLiveDraft();
        } else if (msg.type === 'error') {
          setErrorMsg(msg.message || 'Canlı çeviri bağlantısında hata oluştu.');
          stopLiveSession();
        }
      };

      ws.onerror = () => {
        setErrorMsg('WebSocket bağlantısı kurulamadı. Lütfen tekrar deneyin.');
        stopLiveSession();
      };

      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const channel = e.inputBuffer.getChannelData(0);
        const base64 = pcmFloat32ToBase64(channel);
        ws.send(JSON.stringify({ audio: base64 }));
      };
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? `Mikrofon erişimi sağlanamadı: ${err.message}`
          : 'Mikrofon erişimi reddedildi.'
      );
      stopLiveSession();
    }
  };

  const startTurnRecording = async (speaker: 'self' | 'partner') => {
    setErrorMsg(null);
    if (isLiveActive) stopLiveSession();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const audioCtx = new AudioContext();
      inputCtxRef.current = audioCtx;
      const src = audioCtx.createMediaStreamSource(stream);
      const analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 128;
      src.connect(analyserNode);
      setAnalyser(analyserNode);

      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recordedChunksRef.current = [];

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) recordedChunksRef.current.push(ev.data);
      };

      recorder.onstop = async () => {
        for (const track of stream.getTracks()) track.stop();
        if (inputCtxRef.current && inputCtxRef.current.state !== 'closed') {
          void inputCtxRef.current.close();
        }
        setAnalyser(null);

        const mimeType = recorder.mimeType || 'audio/webm';
        const blob = new Blob(recordedChunksRef.current, { type: mimeType });
        if (blob.size < 400) return;

        await processTurnPayload({ audioBlob: blob, mimeType, speaker });
      };

      recorder.start();
      setRecordingSpeaker(speaker);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? `Mikrofon başlatılamadı: ${err.message}` : 'Mikrofon hatası.'
      );
    }
  };

  const stopTurnRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setRecordingSpeaker(null);
  };

  const processTurnPayload = async (opts: {
    text?: string;
    audioBlob?: Blob;
    mimeType?: string;
    speaker: 'self' | 'partner';
  }) => {
    setIsProcessingTurn(true);
    setErrorMsg(null);

    const sLang = opts.speaker === 'self' ? langA : langB;
    const tLang = opts.speaker === 'self' ? langB : langA;
    const sInfo = getLanguageByCode(sLang);
    const tInfo = getLanguageByCode(tLang);

    try {
      const audioBase64 = opts.audioBlob ? await blobToBase64(opts.audioBlob) : undefined;
      const resp = await fetch('/api/translate-and-speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: opts.text,
          audioBase64,
          mimeType: opts.mimeType,
          sourceLang: sLang,
          targetLang: tLang,
          sourceLangName: sInfo.nameTr,
          targetLangName: tInfo.nameTr,
          voiceName,
          speak: true,
        }),
      });

      const data = (await resp.json()) as {
        originalText?: string;
        translatedText?: string;
        audioBase64?: string;
        error?: string;
      };

      if (!resp.ok) {
        throw new Error(data.error || 'Çeviri sırasında hata oluştu.');
      }

      const newTurn: TranscriptTurn = {
        id: `turn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        speaker: opts.speaker,
        speakerLabel: opts.speaker === 'self' ? 'Sen' : 'Karşı Taraf',
        sourceLang: sLang,
        targetLang: tLang,
        originalText: data.originalText || opts.text || '',
        translatedText: data.translatedText || '',
        timestamp: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
        audioBase64: data.audioBase64,
      };
      onAddTurn(newTurn);

      if (data.audioBase64) {
        setPlayingTurnId(newTurn.id);
        setIsOutputPlaying(true);
        try {
          await playWavBase64(data.audioBase64);
        } finally {
          setPlayingTurnId(null);
          setIsOutputPlaying(false);
        }
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Çeviri tamamlanamadı.');
    } finally {
      setIsProcessingTurn(false);
    }
  };

  const handleTextSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim() || isProcessingTurn) return;
    const text = textInput.trim();
    setTextInput('');
    await processTurnPayload({ text, speaker: textSpeaker });
  };

  const handlePlayTurnAudio = async (turn: TranscriptTurn) => {
    setErrorMsg(null);
    if (playingTurnId === turn.id) {
      stopWavPlayback();
      setPlayingTurnId(null);
      setIsOutputPlaying(false);
      return;
    }

    try {
      setPlayingTurnId(turn.id);
      setIsOutputPlaying(true);
      let audioData = turn.audioBase64;
      if (!audioData) {
        const resp = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: turn.translatedText,
            voiceName,
            langName: getLanguageByCode(turn.targetLang).nameTr,
          }),
        });
        const data = (await resp.json()) as { audioBase64?: string; error?: string };
        if (!resp.ok || !data.audioBase64) {
          throw new Error(data.error || 'Ses oluşturulamadı.');
        }
        audioData = data.audioBase64;
      }
      await playWavBase64(audioData);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Ses oynatılamadı.');
    } finally {
      setPlayingTurnId(null);
      setIsOutputPlaying(false);
    }
  };

  const handleCopy = async (id: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  return (
    <div className="space-y-6">
      {/* Language & Voice Configuration Bar */}
      <section className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto] gap-4 items-end">
          <div>
            <label htmlFor="lang-a" className="block text-xs font-medium text-slate-500 mb-1.5">
              {ui.yourLang}
            </label>
            <select
              id="lang-a"
              value={langA}
              onChange={(e) => onChangeLangA(e.target.value)}
              className="w-full h-10 px-3 bg-slate-50 border border-slate-200 rounded-lg text-sm font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-600"
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
            onClick={onSwapLanguages}
            title="Swap Languages"
            className="h-10 px-3 inline-flex items-center justify-center border border-slate-200 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition-colors shrink-0"
          >
            <ArrowLeftRight className="w-4 h-4" />
          </button>

          <div>
            <label htmlFor="lang-b" className="block text-xs font-medium text-slate-500 mb-1.5">
              {ui.partnerLang}
            </label>
            <select
              id="lang-b"
              value={langB}
              onChange={(e) => onChangeLangB(e.target.value)}
              className="w-full h-10 px-3 bg-slate-50 border border-slate-200 rounded-lg text-sm font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-600"
            >
              {WORLD_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.nativeName} ({l.nameTr})
                </option>
              ))}
            </select>
          </div>

          <div className="min-w-[190px]">
            <label htmlFor="voice-persona" className="block text-xs font-medium text-slate-500 mb-1.5">
              Çevirmen Sesi
            </label>
            <select
              id="voice-persona"
              value={voiceName}
              onChange={(e) => onChangeVoice(e.target.value)}
              className="w-full h-10 px-3 bg-slate-50 border border-slate-200 rounded-lg text-sm font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-600"
            >
              {VOICE_PERSONAS.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-5 pt-5 border-t border-slate-200 flex flex-wrap items-center justify-between gap-4">
          <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => {
                if (recordingSpeaker) stopTurnRecording();
                setStreamMode('live');
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                streamMode === 'live'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Kesintisiz Canlı Akış
            </button>
            <button
              type="button"
              onClick={() => {
                if (isLiveActive) stopLiveSession();
                setStreamMode('turn');
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                streamMode === 'turn'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Yüz Yüze Çift Mikrofon
            </button>
          </div>

          <div className="text-xs text-slate-500 flex items-center gap-2">
            {isLiveActive && (
              <span className="inline-block w-2 h-2 rounded-full bg-teal-600" aria-hidden="true" />
            )}
            <span>
              {isLiveActive
                ? liveStatus
                : recordingSpeaker
                  ? 'Ses kaydediliyor — bitirmek için durdurun'
                  : isProcessingTurn
                    ? 'Ses çözülüyor ve çevriliyor...'
                    : `${langAInfo.nameTr} ⇄ ${langBInfo.nameTr} çeviriye hazır`}
            </span>
          </div>
        </div>

        {/* Active Acoustic Console */}
        <div className="mt-5">
          {streamMode === 'live' ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setLiveDirection('A_TO_B')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      liveDirection === 'A_TO_B'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Ben Konuşuyorum ({langAInfo.code.toUpperCase()} → {langBInfo.code.toUpperCase()})
                  </button>
                  <button
                    type="button"
                    onClick={() => setLiveDirection('B_TO_A')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      liveDirection === 'B_TO_A'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Karşı Taraf ({langBInfo.code.toUpperCase()} → {langAInfo.code.toUpperCase()})
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => (isLiveActive ? stopLiveSession() : void startLiveSession())}
                  className={`h-11 px-5 rounded-lg text-sm font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 ${
                    isLiveActive
                      ? 'bg-rose-600 text-white hover:bg-rose-700'
                      : 'bg-teal-600 text-white hover:bg-teal-700'
                  }`}
                >
                  {isLiveActive ? (
                    <>
                      <MicOff className="w-4 h-4" />
                      Canlı Çeviriyi Durdur
                    </>
                  ) : (
                    <>
                      <Mic className="w-4 h-4" />
                      Canlı Sesli Çeviriyi Başlat
                    </>
                  )}
                </button>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
                <AudioWaveform
                  analyser={analyser}
                  active={isLiveActive}
                  isOutputPlaying={isOutputPlaying}
                />
                {(draftInput || draftOutput) && (
                  <div className="mt-4 pt-3 border-t border-slate-200 grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <div className="text-xs font-medium text-slate-500 mb-1">
                        Algılanan ({getLanguageByCode(activeSourceCode).nameTr})
                      </div>
                      <p className="text-sm text-slate-800">{draftInput || '...'}</p>
                    </div>
                    <div>
                      <div className="text-xs font-medium text-teal-700 mb-1">
                        Canlı Çeviri ({getLanguageByCode(activeTargetCode).nameTr})
                      </div>
                      <p className="text-sm font-medium text-slate-900">{draftOutput || '...'}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <button
                  type="button"
                  disabled={isProcessingTurn || recordingSpeaker === 'partner'}
                  onClick={() =>
                    recordingSpeaker === 'self'
                      ? stopTurnRecording()
                      : void startTurnRecording('self')
                  }
                  className={`h-14 px-5 rounded-xl font-semibold text-sm inline-flex items-center justify-between transition-colors disabled:opacity-50 ${
                    recordingSpeaker === 'self'
                      ? 'bg-rose-600 text-white hover:bg-rose-700'
                      : 'bg-teal-600 text-white hover:bg-teal-700'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    {recordingSpeaker === 'self' ? (
                      <Square className="w-4 h-4 fill-current" />
                    ) : (
                      <Mic className="w-4 h-4" />
                    )}
                    <span>
                      {recordingSpeaker === 'self'
                        ? 'Kaydı Bitir ve Çevir'
                        : `Sen Konuş (${langAInfo.nameTr})`}
                    </span>
                  </span>
                  <span className="text-xs font-mono opacity-85">
                    {langAInfo.code.toUpperCase()} → {langBInfo.code.toUpperCase()}
                  </span>
                </button>

                <button
                  type="button"
                  disabled={isProcessingTurn || recordingSpeaker === 'self'}
                  onClick={() =>
                    recordingSpeaker === 'partner'
                      ? stopTurnRecording()
                      : void startTurnRecording('partner')
                  }
                  className={`h-14 px-5 rounded-xl font-semibold text-sm inline-flex items-center justify-between transition-colors disabled:opacity-50 ${
                    recordingSpeaker === 'partner'
                      ? 'bg-rose-600 text-white hover:bg-rose-700'
                      : 'bg-slate-900 text-white hover:bg-slate-800'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    {recordingSpeaker === 'partner' ? (
                      <Square className="w-4 h-4 fill-current" />
                    ) : (
                      <Mic className="w-4 h-4" />
                    )}
                    <span>
                      {recordingSpeaker === 'partner'
                        ? 'Kaydı Bitir ve Çevir'
                        : `Karşı Taraf Konuşsun (${langBInfo.nameTr})`}
                    </span>
                  </span>
                  <span className="text-xs font-mono opacity-85">
                    {langBInfo.code.toUpperCase()} → {langAInfo.code.toUpperCase()}
                  </span>
                </button>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                <AudioWaveform
                  analyser={analyser}
                  active={recordingSpeaker !== null}
                  isOutputPlaying={isOutputPlaying}
                />
              </div>
            </div>
          )}

          {/* Written Quick Input */}
          <form onSubmit={handleTextSubmit} className="mt-4 flex flex-wrap sm:flex-nowrap gap-2">
            <select
              aria-label="Yazan kişi"
              value={textSpeaker}
              onChange={(e) => setTextSpeaker(e.target.value as 'self' | 'partner')}
              className="h-10 px-3 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium text-slate-700 shrink-0"
            >
              <option value="self">Sen ({langAInfo.code.toUpperCase()})</option>
              <option value="partner">Karşı Taraf ({langBInfo.code.toUpperCase()})</option>
            </select>
            <input
              type="text"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder={ui.chatPlaceholder}
              className="flex-1 min-w-[200px] h-10 px-3.5 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-600"
            />
            <button
              type="submit"
              disabled={!textInput.trim() || isProcessingTurn}
              className="h-10 px-4 bg-slate-900 text-white rounded-lg text-sm font-medium inline-flex items-center gap-2 hover:bg-slate-800 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
            >
              {isProcessingTurn ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
              {ui.sendBtn}
            </button>
          </form>

          {errorMsg && (
            <div className="mt-3 px-3.5 py-2.5 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800">
              {errorMsg}
            </div>
          )}
        </div>
      </section>

      {/* Bilingual Conversation Feed */}
      <section className="bg-white border border-slate-200 rounded-xl">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Çeviri ve Konuşma Akışı</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Konuşulan tüm cümleler iki dilde kaydedilir; anlaşma maddesi olarak işaretleyebilirsiniz.
            </p>
          </div>
          <span className="text-xs font-mono tabular-nums text-slate-500">
            {turns.length} kayıt
          </span>
        </div>

        {turns.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <Waves className="w-8 h-8 text-slate-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-slate-700">Henüz konuşma kaydı yok</p>
            <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
              Yukarıdan canlı sesli çeviriyi başlatın ya da yazılı mesaj gönderin. Tüm çeviriler burada anlık olarak listelenir.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {turns.map((turn) => {
              const sLang = getLanguageByCode(turn.sourceLang);
              const tLang = getLanguageByCode(turn.targetLang);
              const isPlaying = playingTurnId === turn.id;
              return (
                <div key={turn.id} className="p-5 hover:bg-slate-50/70 transition-colors">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span className="font-semibold text-slate-900">{turn.speakerLabel}</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {sLang.nameTr} → {tLang.nameTr}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">{turn.timestamp}</span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void handlePlayTurnAudio(turn)}
                        className={`h-8 px-2.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 border transition-colors whitespace-nowrap shrink-0 ${
                          isPlaying
                            ? 'bg-teal-50 border-teal-200 text-teal-800'
                            : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        <Volume2 className="w-3.5 h-3.5" />
                        {isPlaying ? 'Durdur' : 'Dinle'}
                      </button>

                      <button
                        type="button"
                        onClick={() => void handleCopy(turn.id, `${turn.originalText}\n${turn.translatedText}`)}
                        className="h-8 px-2.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                      >
                        {copiedId === turn.id ? (
                          <Check className="w-3.5 h-3.5 text-teal-600" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        {copiedId === turn.id ? 'Kopyalandı' : 'Kopyala'}
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          onAddAgreement(turn.originalText, turn.translatedText, turn.speakerLabel)
                        }
                        className="h-8 px-2.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                      >
                        <FilePlus2 className="w-3.5 h-3.5" />
                        Anlaşmaya Ekle
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-slate-600 leading-relaxed">{turn.originalText}</p>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-900 leading-relaxed">
                        {turn.translatedText}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
