import { useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  auth,
  db,
  handleFirestoreError,
  OperationType,
  OWNER_EMAIL,
} from './firebase';
import { AdMonetizationCenter } from './components/AdMonetizationCenter';
import { AdminPanel } from './components/AdminPanel';
import { AgreementPanel } from './components/AgreementPanel';
import { AuthProfileModal } from './components/AuthProfileModal';
import { GlobalGreetingShowcase } from './components/GlobalGreetingShowcase';
import { GlobalVoiceRoom } from './components/GlobalVoiceRoom';
import { LiveInterpreter } from './components/LiveInterpreter';
import { OmegleVideoMatch } from './components/OmegleVideoMatch';
import {
  GlobalShareButton,
  OfflineIndicator,
  PWAInstallButton,
} from './components/PWAInstallButton';
import { TikTokLiveFeed } from './components/TikTokLiveFeed';
import { VideoFeedAndUpload } from './components/VideoFeedAndUpload';
import { VoiceCommandStudio } from './components/VoiceCommandStudio';
import { ExternalLink, Film, Globe, Languages, Megaphone, Video } from 'lucide-react';
import {
  detectInitialUiLang,
  getUiStrings,
  UI_LANGUAGES,
  type UiLangCode,
} from './i18n';
import { getLanguageByCode } from './languages';
import type {
  AdCampaign,
  AgreementItem,
  AgreementSummary,
  PlatformSettings,
  TranscriptTurn,
  TranslatorSubTab,
  UserProfile,
  WorkspaceTab,
} from './types';
import { playWavBase64 } from './utils/audio';

function getInitialRouteState(): {
  tab: WorkspaceTab;
  subTab: TranslatorSubTab;
  roomCode: string;
} {
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room');
  if (room && room.trim()) {
    return {
      tab: 'translator',
      subTab: 'room',
      roomCode: room.trim().toUpperCase(),
    };
  }
  return { tab: 'omegle', subTab: 'live', roomCode: 'DUNYA-101' };
}

const DEFAULT_SETTINGS: PlatformSettings = {
  announcement: '',
  maintenanceMode: false,
  autoTranslateVoice: true,
  allowRandomMatch: true,
  updatedBy: 'system',
};

export default function App() {
  const initial = getInitialRouteState();

  const [activeTab, setActiveTab] = useState<WorkspaceTab>(initial.tab);
  const [translatorSubTab, setTranslatorSubTab] = useState<TranslatorSubTab>(initial.subTab);
  const [roomCode, setRoomCode] = useState<string>(initial.roomCode);

  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [goLiveRequested, setGoLiveRequested] = useState(false);

  const [platformSettings, setPlatformSettings] = useState<PlatformSettings>(DEFAULT_SETTINGS);
  const [approvedAds, setApprovedAds] = useState<AdCampaign[]>([]);

  const [uiLang, setUiLang] = useState<UiLangCode>(() => detectInitialUiLang());
  const ui = getUiStrings(uiLang);

  const [langA, setLangA] = useState<string>(() => detectInitialUiLang());
  const [langB, setLangB] = useState<string>(() =>
    detectInitialUiLang() === 'en' ? 'tr' : 'en'
  );
  const [voiceName, setVoiceName] = useState<string>('Zephyr');

  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [agreements, setAgreements] = useState<AgreementItem[]>([]);
  const [summary, setSummary] = useState<AgreementSummary | null>(null);
  const [isSummarizing, setIsSummarizing] = useState<boolean>(false);
  const [summarizeError, setSummarizeError] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const tabSwipeStartRef = useRef<{ x: number; y: number } | null>(null);

  const isSuperOwner = Boolean(
    firebaseUser?.emailVerified && firebaseUser?.email === OWNER_EMAIL
  );

  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(null), 2600);
    return () => clearTimeout(t);
  }, [toastMsg]);

  const showToast = (msg: string) => setToastMsg(msg);

  // Firebase Auth listener + profile & admin lookup
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      if (!user) {
        setProfile(null);
        setIsAdmin(false);
        setAuthReady(true);
        return;
      }

      try {
        const userSnap = await getDoc(doc(db, 'users', user.uid));
        if (userSnap.exists()) {
          const loaded = userSnap.data() as UserProfile;
          setProfile(loaded);
          if (loaded.nativeLang) setLangA(loaded.nativeLang);
        } else {
          setProfile(null);
          setAuthModalOpen(true);
        }

        const ownerMatch = Boolean(user.emailVerified && user.email === OWNER_EMAIL);
        if (ownerMatch) {
          setIsAdmin(true);
        } else {
          const adminSnap = await getDoc(doc(db, 'admins', user.uid));
          setIsAdmin(adminSnap.exists());
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, `users/${user.uid}`);
      } finally {
        setAuthReady(true);
      }
    });

    return () => unsub();
  }, []);

  // Listen to global platform settings
  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, 'platformSettings', 'global'),
      (snap) => {
        if (snap.exists()) {
          setPlatformSettings(snap.data() as PlatformSettings);
        }
      },
      () => {
        // Ignore if settings doc not initialized yet by owner
      }
    );
    return () => unsub();
  }, []);

  // Listen to approved ads for banner & feed sponsorship slots
  useEffect(() => {
    const qAds = query(
      collection(db, 'adCampaigns'),
      where('status', '==', 'approved'),
      limit(10)
    );
    const unsub = onSnapshot(
      qAds,
      (snap) => setApprovedAds(snap.docs.map((d) => d.data() as AdCampaign)),
      () => {}
    );
    return () => unsub();
  }, []);

  const handleTrackAdClick = (ad: AdCampaign) => {
    if (!firebaseUser?.emailVerified) return;
    void updateDoc(doc(db, 'adCampaigns', ad.id), {
      clicks: (ad.clicks || 0) + 1,
      updatedAt: serverTimestamp(),
    }).catch(() => {});
  };

  const handleSwapLanguages = () => {
    setLangA(langB);
    setLangB(langA);
  };

  const handleAddTurn = (turn: TranscriptTurn) => {
    setTurns((prev) => [turn, ...prev]);
  };

  const handleAddAgreement = (original: string, translated: string, owner: string) => {
    const newItem: AgreementItem = {
      id: `ag_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      original,
      translated,
      owner,
      confirmed: false,
      timestamp: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
    };
    setAgreements((prev) => [newItem, ...prev]);
    showToast('Karşılıklı anlaşma listesine eklendi.');
  };

  const handleAddManualAgreement = async (text: string) => {
    const tempId = `ag_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const nowTime = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    setAgreements((prev) => [
      {
        id: tempId,
        original: text,
        translated: 'Çevriliyor...',
        owner: 'Manuel Kayıt',
        confirmed: false,
        timestamp: nowTime,
      },
      ...prev,
    ]);

    try {
      const resp = await fetch('/api/translate-and-speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          sourceLang: langA,
          targetLang: langB,
          sourceLangName: getLanguageByCode(langA).nameTr,
          targetLangName: getLanguageByCode(langB).nameTr,
          speak: false,
        }),
      });
      const data = (await resp.json()) as { translatedText?: string };
      setAgreements((prev) =>
        prev.map((item) =>
          item.id === tempId ? { ...item, translated: data.translatedText || text } : item
        )
      );
    } catch {
      setAgreements((prev) =>
        prev.map((item) => (item.id === tempId ? { ...item, translated: text } : item))
      );
    }
  };

  const handleToggleAgreement = (id: string) => {
    setAgreements((prev) =>
      prev.map((item) => (item.id === id ? { ...item, confirmed: !item.confirmed } : item))
    );
  };

  const handleDeleteAgreement = (id: string) => {
    setAgreements((prev) => prev.filter((item) => item.id !== id));
  };

  const handleGenerateSummary = async () => {
    if (turns.length === 0) return;
    setIsSummarizing(true);
    setSummarizeError(null);
    try {
      const ordered = [...turns].reverse();
      const resp = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: ordered.map((t) => ({
            speakerLabel: t.speakerLabel,
            originalText: t.originalText,
            translatedText: t.translatedText,
          })),
          langAName: getLanguageByCode(langA).nameTr,
          langBName: getLanguageByCode(langB).nameTr,
        }),
      });

      const data = (await resp.json()) as AgreementSummary & { error?: string };
      if (!resp.ok) throw new Error(data.error || 'Özet oluşturulamadı.');

      setSummary(data);

      if (data.agreements?.length) {
        const nowTime = new Date().toLocaleTimeString('tr-TR', {
          hour: '2-digit',
          minute: '2-digit',
        });
        setAgreements((prev) => {
          const existingOrig = new Set(prev.map((p) => p.original.toLowerCase()));
          const additions: AgreementItem[] = data.agreements
            .filter((a) => !existingOrig.has(a.original.toLowerCase()))
            .map((a, idx) => ({
              id: `ag_sum_${Date.now()}_${idx}`,
              original: a.original,
              translated: a.translated,
              owner: a.owner || 'Ortak Karar',
              confirmed: false,
              timestamp: nowTime,
            }));
          return [...additions, ...prev];
        });
      }
      showToast('Çift dilli anlaşma özeti hazırlandı.');
    } catch (err) {
      setSummarizeError(err instanceof Error ? err.message : 'Özet çıkarılamadı.');
    } finally {
      setIsSummarizing(false);
    }
  };

  const handleSpeakLastTurn = async () => {
    const latest = turns[0];
    if (!latest) {
      showToast('Seslendirilecek önceki bir cümle yok.');
      return;
    }
    try {
      if (latest.audioBase64) {
        await playWavBase64(latest.audioBase64);
        return;
      }
      const resp = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: latest.translatedText,
          voiceName,
          langName: getLanguageByCode(latest.targetLang).nameTr,
        }),
      });
      const data = (await resp.json()) as { audioBase64?: string };
      if (resp.ok && data.audioBase64) {
        await playWavBase64(data.audioBase64);
      }
    } catch {
      showToast('Son cümle seslendirilemedi.');
    }
  };

  const handleCopyRoomLink = async () => {
    const url = `${window.location.origin}/?room=${encodeURIComponent(roomCode)}`;
    await navigator.clipboard.writeText(url);
    showToast(`Oda davet bağlantısı kopyalandı (${roomCode}).`);
  };

  const isMaintenanceBlocked = platformSettings.maintenanceMode && !isAdmin && !isSuperOwner;
  const availableTabs: WorkspaceTab[] =
    isSuperOwner || isAdmin
      ? ['omegle', 'discover', 'translator', 'monetize', 'admin']
      : ['omegle', 'discover', 'translator', 'monetize'];

  const handleMainTouchStart = (e: React.TouchEvent<HTMLElement>) => {
    if (e.touches.length !== 1) return;
    const target = e.target as HTMLElement | null;
    if (
      target?.closest(
        '[data-no-tab-swipe="true"], input, textarea, select, button, video, a'
      )
    ) {
      return;
    }
    tabSwipeStartRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
    };
  };

  const handleMainTouchEnd = (e: React.TouchEvent<HTMLElement>) => {
    if (!tabSwipeStartRef.current) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - tabSwipeStartRef.current.x;
    const dy = touch.clientY - tabSwipeStartRef.current.y;
    tabSwipeStartRef.current = null;
    if (Math.abs(dx) < 85 || Math.abs(dy) > Math.abs(dx) * 0.55) return;
    const idx = availableTabs.indexOf(activeTab);
    if (idx < 0) return;
    if (dx < 0 && idx < availableTabs.length - 1) {
      setActiveTab(availableTabs[idx + 1]);
    } else if (dx > 0 && idx > 0) {
      setActiveTab(availableTabs[idx - 1]);
    }
  };

  return (
    <div
      dir={uiLang === 'ar' ? 'rtl' : 'ltr'}
      className="min-h-screen bg-slate-50 text-slate-900 flex flex-col"
    >
      {/* 3-Zone Top Bar */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-[1360px] mx-auto px-4 sm:px-6 lg:px-8 h-14 sm:h-16 flex items-center justify-between gap-8">
          <a
            href="/"
            className="text-xl font-extrabold tracking-tight text-slate-900 whitespace-nowrap shrink-0 font-display"
          >
            Onda<span className="text-teal-600">Talk</span>
          </a>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            <button
              type="button"
              onClick={() => setActiveTab('omegle')}
              className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
                activeTab === 'omegle' ? 'text-slate-900 border-b-2 border-teal-600' : ''
              }`}
            >
              {ui.navMatch}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('discover')}
              className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
                activeTab === 'discover' ? 'text-slate-900 border-b-2 border-teal-600' : ''
              }`}
            >
              {ui.navLive}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('translator')}
              className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
                activeTab === 'translator' ? 'text-slate-900 border-b-2 border-teal-600' : ''
              }`}
            >
              {ui.navStudio}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('monetize')}
              className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
                activeTab === 'monetize' ? 'text-slate-900 border-b-2 border-teal-600' : ''
              }`}
            >
              {ui.navAds}
            </button>
            {(isSuperOwner || isAdmin) && (
              <button
                type="button"
                onClick={() => setActiveTab('admin')}
                className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
                  activeTab === 'admin' ? 'text-slate-900 border-b-2 border-teal-600' : ''
                }`}
              >
                {ui.navAdmin}
              </button>
            )}
          </nav>

          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={() => setAuthModalOpen(true)}
              className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              {!authReady
                ? '...'
                : profile
                  ? `@${profile.handle}`
                  : firebaseUser
                    ? ui.completeRegBtn
                    : ui.signInBtn}
            </button>
          </div>
        </div>
      </header>

      {/* Owner Live Global Announcement Banner */}
      {platformSettings.announcement && (
        <div className="bg-teal-700 text-white text-xs font-medium py-2 px-4 text-center">
          {platformSettings.announcement}
        </div>
      )}

      <main
        onTouchStart={handleMainTouchStart}
        onTouchEnd={handleMainTouchEnd}
        className="flex-1 max-w-[1360px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8"
      >
        {isMaintenanceBlocked ? (
          <section className="bg-white border border-slate-200 rounded-xl p-10 text-center max-w-lg mx-auto mt-10 space-y-3">
            <h1 className="text-xl font-bold text-slate-900 font-display">
              Platform Bakım Modunda
            </h1>
            <p className="text-sm text-slate-600">
              Platform yöneticisi kısa süreli bakım başlattı. Lütfen biraz sonra tekrar deneyin.
            </p>
          </section>
        ) : (
          <>
            {/* Intro + Global UI Language Selector + Mode Switcher */}
            <div className="mb-6 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
              <div className="max-w-2xl">
                <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 font-display [text-wrap:balance]">
                  {ui.heroTitle}
                </h1>
                <p className="text-sm text-slate-600 mt-1.5 leading-relaxed">
                  {ui.heroSubtitle}
                </p>
                {!profile && (
                  <p className="text-xs font-medium text-teal-700 mt-1.5">
                    {ui.guestActiveNote}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2.5 self-start lg:self-auto">
                <PWAInstallButton label={ui.installAppBtn} />
                <GlobalShareButton onShared={showToast} />

                <label className="inline-flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-2.5 min-h-[44px] sm:min-h-[36px] text-xs text-slate-700">
                  <Globe className="w-3.5 h-3.5 text-teal-600 shrink-0" />
                  <span className="sr-only">{ui.uiLangLabel}</span>
                  <select
                    aria-label={ui.uiLangLabel}
                    value={uiLang}
                    onChange={(e) => setUiLang(e.target.value as UiLangCode)}
                    className="bg-transparent font-medium text-slate-900 focus:outline-none cursor-pointer"
                  >
                    {UI_LANGUAGES.map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="hidden sm:inline-flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setActiveTab('omegle')}
                    className={`px-3.5 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      activeTab === 'omegle'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {ui.navMatch}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('discover')}
                    className={`px-3.5 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      activeTab === 'discover'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {ui.navLive}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('translator')}
                    className={`px-3.5 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      activeTab === 'translator'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {ui.navStudio}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('monetize')}
                    className={`px-3.5 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      activeTab === 'monetize'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {ui.navAds}
                  </button>
                  {(isSuperOwner || isAdmin) && (
                    <button
                      type="button"
                      onClick={() => setActiveTab('admin')}
                      className={`px-3.5 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        activeTab === 'admin'
                          ? 'bg-slate-900 text-white shadow-xs'
                          : 'text-slate-700 hover:text-slate-900'
                      }`}
                    >
                      {ui.navAdmin}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {toastMsg && (
              <div className="mb-5 px-4 py-2.5 bg-slate-900 text-white text-xs font-medium rounded-lg inline-block">
                {toastMsg}
              </div>
            )}

            {/* Approved Sponsored Banner Ad (when active) */}
            {approvedAds.filter((a) => a.placement === 'banner_top').length > 0 && (
              <div className="mb-5 bg-white border border-amber-200 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-4">
                {(() => {
                  const ad = approvedAds.filter((a) => a.placement === 'banner_top')[0];
                  return (
                    <>
                      <div className="min-w-0">
                        <div className="text-[11px] font-semibold text-amber-800">
                          Sponsorlu Reklam · {ad.brandName}
                        </div>
                        <div className="text-sm font-bold text-slate-900 truncate">{ad.headline}</div>
                        <p className="text-xs text-slate-600 truncate">{ad.description}</p>
                      </div>
                      <a
                        href={ad.targetUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => handleTrackAdClick(ad)}
                        className="min-h-[40px] px-4 bg-slate-900 text-white rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 hover:bg-slate-800 shrink-0"
                      >
                        İncele
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </>
                  );
                })()}
              </div>
            )}

            <div className="mb-6">
              <GlobalGreetingShowcase />
            </div>

            {/* Active Mode Viewport */}
            {activeTab === 'omegle' && (
              <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-6 items-start">
                <OmegleVideoMatch
                  profile={profile}
                  myLang={langA}
                  onChangeMyLang={setLangA}
                  voiceName={voiceName}
                  allowRandomMatch={platformSettings.allowRandomMatch}
                  ui={ui}
                  onRequireAuth={() => setAuthModalOpen(true)}
                  onAddAgreement={handleAddAgreement}
                />
                <AgreementPanel
                  langA={langA}
                  langB={langB}
                  ui={ui}
                  turns={turns}
                  agreements={agreements}
                  summary={summary}
                  isSummarizing={isSummarizing}
                  summarizeError={summarizeError}
                  onAddManualAgreement={(txt) => void handleAddManualAgreement(txt)}
                  onToggleAgreement={handleToggleAgreement}
                  onDeleteAgreement={handleDeleteAgreement}
                  onGenerateSummary={() => void handleGenerateSummary()}
                />
              </div>
            )}

            {activeTab === 'discover' && (
              <div className="space-y-8">
                <VideoFeedAndUpload
                  profile={profile}
                  myLang={langA}
                  voiceName={voiceName}
                  approvedAds={approvedAds}
                  onRequireAuth={() => setAuthModalOpen(true)}
                  onTrackAdClick={handleTrackAdClick}
                />
                <TikTokLiveFeed
                  profile={profile}
                  myLang={langA}
                  voiceName={voiceName}
                  ui={ui}
                  openGoLiveRequested={goLiveRequested}
                  onResetGoLiveRequest={() => setGoLiveRequested(false)}
                  onRequireAuth={() => setAuthModalOpen(true)}
                />
              </div>
            )}

            {activeTab === 'translator' && (
              <div className="space-y-6">
                <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setTranslatorSubTab('live')}
                    className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      translatorSubTab === 'live'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {ui.tabLiveInterp}
                  </button>
                  <button
                    type="button"
                    onClick={() => setTranslatorSubTab('commands')}
                    className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      translatorSubTab === 'commands'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {ui.tabVoiceCmd}
                  </button>
                  <button
                    type="button"
                    onClick={() => setTranslatorSubTab('room')}
                    className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      translatorSubTab === 'room'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {ui.tabGlobalRoom}
                  </button>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6 items-start">
                  <div>
                    {translatorSubTab === 'live' && (
                      <LiveInterpreter
                        langA={langA}
                        langB={langB}
                        voiceName={voiceName}
                        ui={ui}
                        onChangeLangA={setLangA}
                        onChangeLangB={setLangB}
                        onSwapLanguages={handleSwapLanguages}
                        onChangeVoice={setVoiceName}
                        turns={turns}
                        onAddTurn={handleAddTurn}
                        onAddAgreement={handleAddAgreement}
                      />
                    )}
                    {translatorSubTab === 'commands' && (
                      <VoiceCommandStudio
                        langA={langA}
                        langB={langB}
                        voiceName={voiceName}
                        ui={ui}
                        onChangeLangA={setLangA}
                        onChangeLangB={setLangB}
                        onSwapLanguages={handleSwapLanguages}
                        onSpeakLastTurn={() => void handleSpeakLastTurn()}
                        onTriggerSummarize={() => void handleGenerateSummary()}
                        onAddAgreement={handleAddAgreement}
                        onCopyRoomLink={() => void handleCopyRoomLink()}
                      />
                    )}
                    {translatorSubTab === 'room' && (
                      <GlobalVoiceRoom
                        initialRoomCode={roomCode}
                        defaultLang={langA}
                        voiceName={voiceName}
                        ui={ui}
                      />
                    )}
                  </div>

                  <AgreementPanel
                    langA={langA}
                    langB={langB}
                    ui={ui}
                    turns={turns}
                    agreements={agreements}
                    summary={summary}
                    isSummarizing={isSummarizing}
                    summarizeError={summarizeError}
                    onAddManualAgreement={(txt) => void handleAddManualAgreement(txt)}
                    onToggleAgreement={handleToggleAgreement}
                    onDeleteAgreement={handleDeleteAgreement}
                    onGenerateSummary={() => void handleGenerateSummary()}
                  />
                </div>
              </div>
            )}

            {activeTab === 'monetize' && (
              <AdMonetizationCenter
                profile={profile}
                userEmail={firebaseUser?.email}
                onRequireAuth={() => setAuthModalOpen(true)}
              />
            )}

            {activeTab === 'admin' && (isSuperOwner || isAdmin) && firebaseUser && (
              <AdminPanel
                currentUserUid={firebaseUser.uid}
                isSuperOwner={isSuperOwner}
                platformSettings={platformSettings}
              />
            )}
          </>
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white mt-auto pb-20 md:pb-4">
        <div className="max-w-[1360px] mx-auto px-4 sm:px-6 lg:px-8 py-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
          <span className="font-semibold text-slate-700">© 2026 OndaTalk</span>
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={() => setActiveTab('monetize')}
              className="text-teal-700 font-medium hover:underline"
            >
              {ui.navAds}
            </button>
            <span>{ui.footerNotice}</span>
          </div>
        </div>
      </footer>

      {/* Mobile & Tablet Thumb-Zone Fixed Bottom Navigation */}
      <nav
        aria-label="Mobil alt menü"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-slate-200 px-2 pb-[env(safe-area-inset-bottom)]"
      >
        <div className="grid grid-cols-4 items-center h-14">
          <button
            type="button"
            onClick={() => setActiveTab('omegle')}
            className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold ${
              activeTab === 'omegle' ? 'text-teal-700' : 'text-slate-500'
            }`}
          >
            <Video className="w-5 h-5" />
            <span className="truncate max-w-[72px]">{ui.navMatch}</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('discover')}
            className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold ${
              activeTab === 'discover' ? 'text-teal-700' : 'text-slate-500'
            }`}
          >
            <Film className="w-5 h-5" />
            <span className="truncate max-w-[72px]">{ui.navLive}</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('translator')}
            className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold ${
              activeTab === 'translator' ? 'text-teal-700' : 'text-slate-500'
            }`}
          >
            <Languages className="w-5 h-5" />
            <span className="truncate max-w-[72px]">{ui.navStudio}</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('monetize')}
            className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold ${
              activeTab === 'monetize' ? 'text-teal-700' : 'text-slate-500'
            }`}
          >
            <Megaphone className="w-5 h-5" />
            <span className="truncate max-w-[72px]">{ui.navAds}</span>
          </button>
        </div>
      </nav>

      <OfflineIndicator />

      <AuthProfileModal
        isOpen={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        firebaseUser={firebaseUser}
        profile={profile}
        isSuperOwner={isSuperOwner}
        isAdmin={isAdmin}
        onProfileSaved={(saved) => {
          setProfile(saved);
          setLangA(saved.nativeLang);
          showToast('Profilin kaydedildi, hoş geldin!');
        }}
      />
    </div>
  );
}
