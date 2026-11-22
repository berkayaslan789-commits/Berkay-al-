import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Command,
  Copy,
  Download,
  Loader2,
  Mic,
  MicOff,
  Send,
  Sparkles,
  Trash2,
  Volume2,
} from 'lucide-react';
import type { UiStrings } from '../i18n';
import { getLanguageByCode, WORLD_LANGUAGES } from '../languages';
import type { VoiceCommandResult } from '../types';
import { pcmFloat32ToBase64, playWavBase64 } from '../utils/audio';
import { AudioWaveform } from './AudioWaveform';

interface VoiceCommandStudioProps {
  langA: string;
  langB: string;
  voiceName: string;
  ui: UiStrings;
  onChangeLangA: (code: string) => void;
  onChangeLangB: (code: string) => void;
  onSwapLanguages: () => void;
  onSpeakLastTurn: () => void;
  onTriggerSummarize: () => void;
  onAddAgreement: (original: string, translated: string, owner: string) => void;
  onCopyRoomLink: () => void;
}

const EXAMPLE_COMMANDS = [
  'Dili İspanyolcaya çevir',
  'Dilleri değiştir',
  'Anlaşma maddesi ekle: Teslimat gelecek Pazartesi saat 10:00’da yapılacak',
  'Son cümleyi tekrar oku',
  'Konuşmayı özetle ve anlaşma çıkar',
];

export function VoiceCommandStudio({
  langA,
  langB,
  voiceName,
  ui,
  onChangeLangA,
  onChangeLangB,
  onSwapLanguages,
  onSpeakLastTurn,
  onTriggerSummarize,
  onAddAgreement,
  onCopyRoomLink,
}: VoiceCommandStudioProps) {
  const [isListening, setIsListening] = useState(false);
  const [statusText, setStatusText] = useState('Hazır');
  const [interimText, setInterimText] = useState('');
  const [typedInput, setTypedInput] = useState('');
  const [originalDoc, setOriginalDoc] = useState('');
  const [translatedDoc, setTranslatedDoc] = useState('');
  const [lastFeedback, setLastFeedback] = useState<string | null>(null);
  const [isProcessingCmd, setIsProcessingCmd] = useState(false);
  const [isSpeakingDoc, setIsSpeakingDoc] = useState(false);
  const [copiedDoc, setCopiedDoc] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const inputCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const pendingChunkRef = useRef('');

  const langARef = useRef(langA);
  const langBRef = useRef(langB);
  langARef.current = langA;
  langBRef.current = langB;

  const stopListening = () => {
    setIsListening(false);
    setStatusText('Hazır');

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (inputCtxRef.current && inputCtxRef.current.state !== 'closed') {
      void inputCtxRef.current.close();
      inputCtxRef.current = null;
    }
    if (micStreamRef.current) {
      for (const t of micStreamRef.current.getTracks()) t.stop();
      micStreamRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setAnalyser(null);
  };

  useEffect(() => {
    return () => stopListening();
  }, []);

  const executeVoiceInput = async (transcript: string) => {
    const clean = transcript.trim();
    if (!clean) return;
    setIsProcessingCmd(true);
    setErrorMsg(null);

    const sourceInfo = getLanguageByCode(langARef.current);
    const targetInfo = getLanguageByCode(langBRef.current);

    try {
      const resp = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: clean,
          currentSourceLang: langARef.current,
          currentTargetLang: langBRef.current,
          currentTargetLangName: targetInfo.nameTr,
          availableLanguages: WORLD_LANGUAGES.map((l) => ({
            code: l.code,
            nameTr: l.nameTr,
            nativeName: l.nativeName,
          })),
        }),
      });
      const data = (await resp.json()) as VoiceCommandResult & { error?: string };
      if (!resp.ok) throw new Error(data.error || 'Komut işlenemedi.');

      setLastFeedback(data.feedback);

      switch (data.action) {
        case 'switch_target_lang':
          if (data.targetLangCode) onChangeLangB(data.targetLangCode);
          break;
        case 'switch_source_lang':
          if (data.targetLangCode) onChangeLangA(data.targetLangCode);
          break;
        case 'swap_languages':
          onSwapLanguages();
          break;
        case 'speak_last':
          onSpeakLastTurn();
          break;
        case 'summarize':
          onTriggerSummarize();
          break;
        case 'clear_notes':
          setOriginalDoc('');
          setTranslatedDoc('');
          break;
        case 'copy_room':
          onCopyRoomLink();
          break;
        case 'add_agreement': {
          const itemOrig = data.agreementText || data.cleanText;
          onAddAgreement(itemOrig, data.translatedText || itemOrig, sourceInfo.nameTr);
          setOriginalDoc((prev) => (prev ? `${prev}\n• ${itemOrig}` : `• ${itemOrig}`));
          setTranslatedDoc((prev) =>
            prev ? `${prev}\n• ${data.translatedText}` : `• ${data.translatedText}`
          );
          break;
        }
        default: {
          setOriginalDoc((prev) => (prev ? `${prev}\n${data.cleanText}` : data.cleanText));
          setTranslatedDoc((prev) =>
            prev ? `${prev}\n${data.translatedText}` : data.translatedText
          );
          break;
        }
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Komut işlenemedi.');
    } finally {
      setIsProcessingCmd(false);
    }
  };

  const handleTypedSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!typedInput.trim() || isProcessingCmd) return;
    const text = typedInput.trim();
    setTypedInput('');
    await executeVoiceInput(text);
  };

  const startListening = async () => {
    setErrorMsg(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      micStreamRef.current = stream;

      const inputCtx = new AudioContext({ sampleRate: 16000 });
      inputCtxRef.current = inputCtx;
      const src = inputCtx.createMediaStreamSource(stream);
      const analyserNode = inputCtx.createAnalyser();
      analyserNode.fftSize = 128;
      src.connect(analyserNode);
      setAnalyser(analyserNode);

      const processor = inputCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      src.connect(processor);
      processor.connect(inputCtx.destination);

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(
        `${protocol}//${window.location.host}/ws/live-transcribe?lang=auto`
      );
      wsRef.current = ws;
      setIsListening(true);
      setStatusText('Bağlanıyor...');

      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as {
          type: string;
          text?: string;
          message?: string;
        };
        if (msg.type === 'ready') {
          setStatusText('Dinleniyor...');
        } else if (msg.type === 'interimTranscript' && msg.text) {
          setInterimText(msg.text);
        } else if (msg.type === 'transcript' && msg.text) {
          pendingChunkRef.current = `${pendingChunkRef.current} ${msg.text}`.trim();
          setInterimText(pendingChunkRef.current);
        } else if (msg.type === 'turnComplete') {
          const finalized = pendingChunkRef.current.trim();
          pendingChunkRef.current = '';
          setInterimText('');
          if (finalized) {
            void executeVoiceInput(finalized);
          }
        } else if (msg.type === 'error') {
          setErrorMsg(msg.message || 'Canlı yazıya dökme hatası.');
          stopListening();
        }
      };

      ws.onerror = () => {
        setErrorMsg('Canlı dikte bağlantısı kurulamadı.');
        stopListening();
      };

      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const base64 = pcmFloat32ToBase64(e.inputBuffer.getChannelData(0));
        ws.send(JSON.stringify({ audio: base64 }));
      };
    } catch {
      setErrorMsg(
        'Mikrofon algılanamadı — aşağıdaki yazılı komut/çeviri kutusundan devam edebilirsiniz.'
      );
      stopListening();
    }
  };

  const handleSpeakTranslatedDoc = async () => {
    if (!translatedDoc.trim()) return;
    setIsSpeakingDoc(true);
    setErrorMsg(null);
    try {
      const resp = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: translatedDoc.trim(),
          voiceName,
          langName: getLanguageByCode(langB).nameTr,
        }),
      });
      const data = (await resp.json()) as { audioBase64?: string; error?: string };
      if (!resp.ok || !data.audioBase64) throw new Error(data.error || 'Ses oluşturulamadı.');
      await playWavBase64(data.audioBase64);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Seslendirilemedi.');
    } finally {
      setIsSpeakingDoc(false);
    }
  };

  const handleDownloadTxt = () => {
    const content = [
      `OndaTalk — ${getLanguageByCode(langA).nameTr} → ${getLanguageByCode(langB).nameTr}`,
      ``,
      originalDoc || '',
      ``,
      `---`,
      ``,
      translatedDoc || '',
    ].join('\n');

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ondatalk-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyDoc = async () => {
    const combined = `${originalDoc}\n\n---\n\n${translatedDoc}`.trim();
    if (!combined) return;
    await navigator.clipboard.writeText(combined);
    setCopiedDoc(true);
    setTimeout(() => setCopiedDoc(false), 1500);
  };

  return (
    <div className="space-y-6">
      <section className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">{ui.cmdTitle}</h2>
            <p className="text-xs text-slate-500 mt-0.5">{statusText}</p>
          </div>

          <button
            type="button"
            onClick={() => (isListening ? stopListening() : void startListening())}
            className={`h-11 px-5 rounded-lg text-sm font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 ${
              isListening
                ? 'bg-rose-600 text-white hover:bg-rose-700'
                : 'bg-teal-600 text-white hover:bg-teal-700'
            }`}
          >
            {isListening ? (
              <>
                <MicOff className="w-4 h-4" />
                {ui.cmdStopBtn}
              </>
            ) : (
              <>
                <Mic className="w-4 h-4" />
                {ui.cmdStartBtn}
              </>
            )}
          </button>
        </div>

        <div className="mt-4 bg-slate-50 border border-slate-200 rounded-lg p-4">
          <AudioWaveform analyser={analyser} active={isListening} />
          {(interimText || isProcessingCmd) && (
            <div className="mt-3 pt-3 border-t border-slate-200 flex items-center justify-between gap-3">
              <p className="text-sm text-slate-800 italic">
                {interimText || '...'}
              </p>
              {isProcessingCmd && <Loader2 className="w-4 h-4 text-teal-600 animate-spin shrink-0" />}
            </div>
          )}
        </div>

        {/* Typed Fallback for Users Without a Microphone */}
        <form onSubmit={(e) => void handleTypedSubmit(e)} className="mt-4 flex flex-wrap sm:flex-nowrap gap-2">
          <input
            type="text"
            value={typedInput}
            onChange={(e) => setTypedInput(e.target.value)}
            placeholder={ui.cmdTextPlaceholder}
            className="flex-1 min-w-[200px] h-10 px-3.5 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-600"
          />
          <button
            type="submit"
            disabled={!typedInput.trim() || isProcessingCmd}
            className="h-10 px-4 bg-slate-900 text-white rounded-lg text-xs font-semibold hover:bg-slate-800 disabled:opacity-40 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            {isProcessingCmd ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Send className="w-3.5 h-3.5" />
            )}
            {ui.cmdTextBtn}
          </button>
        </form>

        {lastFeedback && (
          <div className="mt-4 px-3.5 py-2.5 bg-teal-50 border border-teal-200 rounded-lg text-xs text-teal-900 flex items-center gap-2">
            <Command className="w-3.5 h-3.5 text-teal-700 shrink-0" />
            <span>{lastFeedback}</span>
          </div>
        )}

        {errorMsg && (
          <div className="mt-3 px-3.5 py-2.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900">
            {errorMsg}
          </div>
        )}

        <div className="mt-5 pt-4 border-t border-slate-200">
          <div className="flex flex-wrap gap-2">
            {EXAMPLE_COMMANDS.map((cmd) => (
              <button
                key={cmd}
                type="button"
                disabled={isProcessingCmd}
                onClick={() => void executeVoiceInput(cmd)}
                className="px-3 py-1.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg text-xs text-slate-700 transition-colors text-left"
              >
                “{cmd}”
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h3 className="text-sm font-semibold text-slate-900">
            {getLanguageByCode(langA).nameTr} → {getLanguageByCode(langB).nameTr}
          </h3>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!translatedDoc.trim() || isSpeakingDoc}
              onClick={() => void handleSpeakTranslatedDoc()}
              className="h-9 px-3 bg-teal-600 text-white hover:bg-teal-700 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              {isSpeakingDoc ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Volume2 className="w-3.5 h-3.5" />
              )}
            </button>

            <button
              type="button"
              disabled={!originalDoc.trim() && !translatedDoc.trim()}
              onClick={() => void handleCopyDoc()}
              className="h-9 px-3 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              {copiedDoc ? (
                <Check className="w-3.5 h-3.5 text-teal-600" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </button>

            <button
              type="button"
              disabled={!originalDoc.trim() && !translatedDoc.trim()}
              onClick={handleDownloadTxt}
              className="h-9 px-3 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              disabled={!originalDoc && !translatedDoc}
              onClick={() => {
                setOriginalDoc('');
                setTranslatedDoc('');
              }}
              className="h-9 px-3 bg-white border border-slate-200 text-slate-600 hover:text-rose-700 hover:border-rose-200 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="doc-orig" className="block text-xs font-medium text-slate-500 mb-1.5">
              {getLanguageByCode(langA).nameTr}
            </label>
            <textarea
              id="doc-orig"
              rows={8}
              value={originalDoc}
              onChange={(e) => setOriginalDoc(e.target.value)}
              className="w-full p-3.5 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 leading-relaxed"
            />
          </div>

          <div>
            <label htmlFor="doc-trans" className="block text-xs font-medium text-slate-500 mb-1.5">
              {getLanguageByCode(langB).nameTr}
            </label>
            <textarea
              id="doc-trans"
              rows={8}
              value={translatedDoc}
              onChange={(e) => setTranslatedDoc(e.target.value)}
              className="w-full p-3.5 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 leading-relaxed"
            />
          </div>
        </div>

        {originalDoc.trim() && (
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              disabled={isProcessingCmd}
              onClick={() => void executeVoiceInput(originalDoc.split('\n').pop() || originalDoc)}
              className="h-9 px-3.5 bg-slate-900 text-white hover:bg-slate-800 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-40"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {ui.cmdTextBtn}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
