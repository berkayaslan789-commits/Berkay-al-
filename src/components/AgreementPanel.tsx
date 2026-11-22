import { useState } from 'react';
import {
  Check,
  Copy,
  Download,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { UiStrings } from '../i18n';
import { getLanguageByCode } from '../languages';
import type { AgreementItem, AgreementSummary, TranscriptTurn } from '../types';

interface AgreementPanelProps {
  langA: string;
  langB: string;
  ui: UiStrings;
  turns: TranscriptTurn[];
  agreements: AgreementItem[];
  summary: AgreementSummary | null;
  isSummarizing: boolean;
  summarizeError: string | null;
  onAddManualAgreement: (text: string) => void;
  onToggleAgreement: (id: string) => void;
  onDeleteAgreement: (id: string) => void;
  onGenerateSummary: () => void;
}

export function AgreementPanel({
  langA,
  langB,
  ui,
  turns,
  agreements,
  summary,
  isSummarizing,
  summarizeError,
  onAddManualAgreement,
  onToggleAgreement,
  onDeleteAgreement,
  onGenerateSummary,
}: AgreementPanelProps) {
  const [manualText, setManualText] = useState('');
  const [copiedAll, setCopiedAll] = useState(false);

  const langAInfo = getLanguageByCode(langA);
  const langBInfo = getLanguageByCode(langB);

  const handleSubmitManual = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualText.trim()) return;
    onAddManualAgreement(manualText.trim());
    setManualText('');
  };

  const buildExportMarkdown = () => {
    const lines: string[] = [
      `# OndaTalk — ${ui.agreementTitle}`,
      `${new Date().toLocaleString()}`,
      `${langAInfo.nameTr} (${langAInfo.nativeName}) ⇄ ${langBInfo.nameTr} (${langBInfo.nativeName})`,
      '',
    ];

    if (summary) {
      lines.push(`## ${summary.title}`);
      lines.push(`### ${langAInfo.nameTr}`);
      lines.push(summary.summaryA);
      lines.push('');
      lines.push(`### ${langBInfo.nameTr}`);
      lines.push(summary.summaryB);
      lines.push('');
    }

    lines.push(`## Items (${agreements.length})`);
    for (const item of agreements) {
      lines.push(
        `- [${item.confirmed ? 'x' : ' '}] ${item.original} / ${item.translated} (${item.owner})`
      );
    }

    lines.push('');
    lines.push(`## Transcript (${turns.length})`);
    for (const t of turns) {
      lines.push(`[${t.timestamp}] ${t.speakerLabel}: ${t.originalText} -> ${t.translatedText}`);
    }
    return lines.join('\n');
  };

  const handleCopyExport = async () => {
    await navigator.clipboard.writeText(buildExportMarkdown());
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1600);
  };

  const handleDownloadExport = () => {
    const blob = new Blob([buildExportMarkdown()], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ondatalk-agreement-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <aside className="bg-white border border-slate-200 rounded-xl flex flex-col">
      <div className="p-5 border-b border-slate-200">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-900">{ui.agreementTitle}</h2>
          <span className="text-xs font-mono tabular-nums text-slate-500">
            {agreements.filter((a) => a.confirmed).length}/{agreements.length}
          </span>
        </div>
        <p className="text-xs text-slate-500 mt-1">{ui.agreementDesc}</p>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={turns.length === 0 || isSummarizing}
            onClick={onGenerateSummary}
            className="flex-1 h-9 px-3 bg-teal-600 text-white hover:bg-teal-700 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
          >
            {isSummarizing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
            {ui.summarizeBtn}
          </button>

          <button
            type="button"
            onClick={() => void handleCopyExport()}
            aria-label="Copy"
            className="h-9 px-3 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            {copiedAll ? (
              <Check className="w-3.5 h-3.5 text-teal-600" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>

          <button
            type="button"
            onClick={handleDownloadExport}
            aria-label="Download"
            className="h-9 px-3 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
        </div>

        {summarizeError && (
          <div className="mt-3 px-3 py-2 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800">
            {summarizeError}
          </div>
        )}
      </div>

      {summary && (
        <div className="p-5 border-b border-slate-200 bg-slate-50/70 space-y-3">
          <div className="text-xs font-semibold text-teal-800">{summary.title}</div>
          <div>
            <div className="text-xs font-medium text-slate-500 mb-0.5">{langAInfo.nameTr}</div>
            <p className="text-xs text-slate-800 leading-relaxed">{summary.summaryA}</p>
          </div>
          <div>
            <div className="text-xs font-medium text-slate-500 mb-0.5">{langBInfo.nameTr}</div>
            <p className="text-xs text-slate-800 leading-relaxed">{summary.summaryB}</p>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmitManual} className="p-4 border-b border-slate-200 flex gap-2">
        <input
          type="text"
          value={manualText}
          onChange={(e) => setManualText(e.target.value)}
          placeholder={ui.addManualPlaceholder}
          className="flex-1 h-9 px-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-600"
        />
        <button
          type="submit"
          disabled={!manualText.trim()}
          className="h-9 px-3 bg-slate-900 text-white rounded-lg text-xs font-medium inline-flex items-center gap-1 hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          {ui.addBtn}
        </button>
      </form>

      <div className="divide-y divide-slate-200 flex-1 overflow-y-auto max-h-[520px]">
        {agreements.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500 leading-relaxed">
            {ui.agreementDesc}
          </div>
        ) : (
          agreements.map((item) => (
            <div key={item.id} className="p-4 flex items-start gap-3 hover:bg-slate-50/70">
              <input
                type="checkbox"
                checked={item.confirmed}
                onChange={() => onToggleAgreement(item.id)}
                className="mt-0.5 w-4 h-4 accent-teal-600 rounded cursor-pointer"
              />
              <div className="flex-1 min-w-0">
                <p
                  className={`text-xs font-medium leading-relaxed ${
                    item.confirmed ? 'line-through text-slate-400' : 'text-slate-900'
                  }`}
                >
                  {item.original}
                </p>
                {item.translated && item.translated !== item.original && (
                  <p className="text-xs text-slate-500 mt-1 leading-relaxed">{item.translated}</p>
                )}
                <div className="text-[11px] text-slate-400 mt-1.5 font-mono tabular-nums">
                  {item.owner} · {item.timestamp}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onDeleteAgreement(item.id)}
                aria-label="Delete"
                className="p-1 text-slate-400 hover:text-rose-600 transition-colors shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
