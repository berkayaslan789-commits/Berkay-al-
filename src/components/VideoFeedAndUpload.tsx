import { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  doc,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  Captions,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Film,
  Heart,
  Languages,
  Loader2,
  Play,
  Plus,
  Upload,
  Volume2,
  X,
} from 'lucide-react';
import { auth, db, handleFirestoreError, OperationType } from '../firebase';
import { getLanguageByCode, WORLD_LANGUAGES } from '../languages';
import type { AdCampaign, SubtitleCue, UserProfile, VideoPost } from '../types';
import { playWavBase64 } from '../utils/audio';
import { isSafeHttpsUrl, sanitizeClientText } from '../utils/safety';

interface VideoFeedAndUploadProps {
  profile: UserProfile | null;
  myLang: string;
  voiceName: string;
  approvedAds: AdCampaign[];
  onRequireAuth: () => void;
  onTrackAdClick: (ad: AdCampaign) => void;
}

export function VideoFeedAndUpload({
  profile,
  myLang,
  voiceName,
  approvedAds,
  onRequireAuth,
  onTrackAdClick,
}: VideoFeedAndUploadProps) {
  const [videos, setVideos] = useState<VideoPost[]>([]);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [viewerLang, setViewerLang] = useState<string>(myLang);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);

  // On-demand translated cues cache per videoId + langCode
  const [cueCache, setCueCache] = useState<
    Record<string, { transcript: string; cues: SubtitleCue[] }>
  >({});
  const [isTranslatingVideo, setIsTranslatingVideo] = useState(false);
  const [isSpeakingSub, setIsSpeakingSub] = useState(false);

  // Upload Modal state
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadMode, setUploadMode] = useState<'file' | 'url'>('file');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [externalVideoUrl, setExternalVideoUrl] = useState('');
  const [videoTitle, setVideoTitle] = useState('');
  const [videoTopic, setVideoTopic] = useState('Günlük Yaşam');
  const [videoSourceLang, setVideoSourceLang] = useState(myLang);
  const [manualNarration, setManualNarration] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStage, setUploadStage] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [noticeMsg, setNoticeMsg] = useState<string | null>(null);

  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    setViewerLang(myLang);
  }, [myLang]);

  useEffect(() => {
    const q = query(
      collection(db, 'videos'),
      where('isPublished', '==', true),
      limit(30)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs
          .map((d) => d.data() as VideoPost)
          .sort((a, b) => {
            const ta = (a.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
            const tb = (b.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
            return tb - ta;
          });
        setVideos(list);
        if (list.length > 0 && !selectedVideoId) {
          setSelectedVideoId(list[0].id);
        }
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'videos')
    );
    return () => unsub();
  }, []);

  const activeVideo = useMemo(
    () => videos.find((v) => v.id === selectedVideoId) || videos[0] || null,
    [videos, selectedVideoId]
  );

  const cacheKey = activeVideo ? `${activeVideo.id}_${viewerLang}` : '';
  const activeTranslatedData = cacheKey ? cueCache[cacheKey] : undefined;

  // Automatically translate cues whenever a viewer picks a video or switches viewer language
  const handleTranslateActiveVideo = async (video: VideoPost, targetCode: string) => {
    const key = `${video.id}_${targetCode}`;
    if (targetCode === video.sourceLang) {
      setCueCache((prev) => ({
        ...prev,
        [key]: { transcript: video.transcriptOriginal, cues: video.cues },
      }));
      return;
    }
    if (cueCache[key]) return;
    if (!video.transcriptOriginal && (!video.cues || video.cues.length === 0)) return;

    setIsTranslatingVideo(true);
    try {
      const langObj = getLanguageByCode(targetCode);
      const resp = await fetch('/api/videos/translate-cues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cues: video.cues,
          transcriptOriginal: video.transcriptOriginal,
          sourceLang: video.sourceLang,
          targetLang: targetCode,
          targetLangName: langObj.nameTr,
        }),
      });
      const data = (await resp.json()) as {
        translatedTranscript?: string;
        translatedCues?: SubtitleCue[];
      };
      if (resp.ok) {
        setCueCache((prev) => ({
          ...prev,
          [key]: {
            transcript: data.translatedTranscript || video.translations?.[targetCode] || video.transcriptOriginal,
            cues: data.translatedCues || video.cues,
          },
        }));
      }
    } catch {
      // fallback silently to stored summary translation if offline
    } finally {
      setIsTranslatingVideo(false);
    }
  };

  useEffect(() => {
    if (activeVideo && viewerLang !== activeVideo.sourceLang) {
      void handleTranslateActiveVideo(activeVideo, viewerLang);
    }
  }, [activeVideo?.id, viewerLang]);

  const activeCues: SubtitleCue[] = useMemo(() => {
    if (!activeVideo) return [];
    if (viewerLang === activeVideo.sourceLang) return activeVideo.cues || [];
    if (activeTranslatedData?.cues?.length) return activeTranslatedData.cues;
    return activeVideo.cues || [];
  }, [activeVideo, viewerLang, activeTranslatedData]);

  const currentSubtitleText = useMemo(() => {
    if (!activeVideo) return '';
    const hit = activeCues.find(
      (c) => currentTime >= c.startSec && currentTime <= (c.endSec || c.startSec + 4)
    );
    if (hit) return hit.text;
    if (viewerLang !== activeVideo.sourceLang) {
      return (
        activeTranslatedData?.transcript ||
        activeVideo.translations?.[viewerLang] ||
        activeVideo.transcriptOriginal
      );
    }
    return activeVideo.transcriptOriginal;
  }, [activeVideo, activeCues, currentTime, viewerLang, activeTranslatedData]);

  const handleOpenUpload = () => {
    if (!profile) {
      onRequireAuth();
      return;
    }
    setErrorMsg(null);
    setShowUploadModal(true);
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) {
      onRequireAuth();
      return;
    }

    const cleanTitle = sanitizeClientText(videoTitle, 120);
    if (!cleanTitle.safe || cleanTitle.text.length < 2) {
      setErrorMsg('Lütfen geçerli ve güvenli bir video başlığı girin.');
      return;
    }

    const cleanNarration = sanitizeClientText(manualNarration, 3000);
    if (!cleanNarration.safe) {
      setErrorMsg('Güvenlik kalkanı: Açıklama metninde izin verilmeyen karakter/kod tespit edildi.');
      return;
    }

    let finalVideoUrl = '';
    let finalMime = 'video/mp4';
    let uploadedVideoId: string | undefined;

    setIsUploading(true);
    setErrorMsg(null);

    try {
      if (uploadMode === 'file') {
        if (!selectedFile) {
          throw new Error('Lütfen cihazınızdan bir MP4, WebM veya MOV video seçin.');
        }
        if (selectedFile.size > 15 * 1024 * 1024) {
          throw new Error('Ücretsiz sunucu uyumluluğu için maksimum dosya boyutu 15 MB olmalıdır.');
        }

        setUploadStage('Video sunucuya güvenli aktarılıyor...');
        const token = await auth.currentUser?.getIdToken();
        if (!token) throw new Error('Oturum doğrulanamadı, lütfen tekrar giriş yapın.');

        const uploadResp = await fetch('/api/videos/upload-binary', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': selectedFile.type || 'video/mp4',
            'x-video-mime': selectedFile.type || 'video/mp4',
          },
          body: selectedFile,
        });
        const uploadData = (await uploadResp.json()) as {
          ok?: boolean;
          videoId?: string;
          videoUrl?: string;
          mimeType?: string;
          error?: string;
        };
        if (!uploadResp.ok || !uploadData.videoUrl) {
          throw new Error(uploadData.error || 'Video yüklenemedi.');
        }
        finalVideoUrl = uploadData.videoUrl;
        finalMime = uploadData.mimeType || 'video/mp4';
        uploadedVideoId = uploadData.videoId;
      } else {
        if (!isSafeHttpsUrl(externalVideoUrl)) {
          throw new Error('Lütfen geçerli bir https:// video bağlantısı girin.');
        }
        if (!cleanNarration.text) {
          throw new Error('Harici video linki için lütfen videodaki konuşma/açıklama metnini yazın.');
        }
        finalVideoUrl = externalVideoUrl.trim().slice(0, 512);
      }

      setUploadStage('Konuşmalar çözülüyor ve çok dilli altyazılar üretiliyor...');
      const langObj = getLanguageByCode(videoSourceLang);
      const subResp = await fetch('/api/videos/analyze-subtitles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId: uploadedVideoId,
          manualTranscript: cleanNarration.text,
          sourceLang: videoSourceLang,
          sourceLangName: langObj.nameTr,
        }),
      });
      const subData = (await subResp.json()) as {
        transcriptOriginal?: string;
        cues?: SubtitleCue[];
        translations?: Record<string, string>;
        error?: string;
      };
      if (!subResp.ok) {
        throw new Error(subData.error || 'Otomatik altyazı üretilemedi.');
      }

      setUploadStage('Video topluluk akışına yayınlanıyor...');
      const docId = uploadedVideoId || `vid_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const payload: VideoPost = {
        id: docId,
        authorUid: profile.uid,
        authorName: profile.displayName,
        authorHandle: profile.handle,
        sourceLang: videoSourceLang,
        title: cleanTitle.text,
        topic: videoTopic.slice(0, 40),
        videoUrl: finalVideoUrl,
        mimeType: finalMime,
        transcriptOriginal: (subData.transcriptOriginal || cleanNarration.text).slice(0, 3000),
        cues: (subData.cues || []).slice(0, 35),
        translations: subData.translations || {},
        likesCount: 0,
        viewsCount: 0,
        isPublished: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      await setDoc(doc(db, 'videos', docId), payload);
      setSelectedVideoId(docId);
      setShowUploadModal(false);
      setSelectedFile(null);
      setExternalVideoUrl('');
      setVideoTitle('');
      setManualNarration('');
      setNoticeMsg('Videonuz çok dilli çeviri altyazılarıyla yayınlandı!');
      setTimeout(() => setNoticeMsg(null), 3200);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Video yükleme sırasında hata oluştu.');
    } finally {
      setIsUploading(false);
      setUploadStage('');
    }
  };

  const handleLikeVideo = async (video: VideoPost) => {
    if (!profile) {
      onRequireAuth();
      return;
    }
    try {
      await updateDoc(doc(db, 'videos', video.id), {
        likesCount: (video.likesCount || 0) + 1,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `videos/${video.id}`);
    }
  };

  const handleSpeakTranslatedSubtitle = async () => {
    if (!currentSubtitleText) return;
    setIsSpeakingSub(true);
    try {
      const resp = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: currentSubtitleText.slice(0, 500),
          voiceName,
          langName: getLanguageByCode(viewerLang).nameTr,
        }),
      });
      const data = (await resp.json()) as { audioBase64?: string };
      if (resp.ok && data.audioBase64) {
        await playWavBase64(data.audioBase64);
      }
    } catch {
      // ignore tts error
    } finally {
      setIsSpeakingSub(false);
    }
  };

  const feedAds = approvedAds.filter(
    (ad) => ad.placement === 'feed_card' || ad.placement === 'video_sponsor'
  );

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-slate-900 font-display">
            Çok Dilli Topluluk Videoları
          </h3>
          <p className="text-xs text-slate-600 mt-0.5">
            Videonuzu yükleyin; dünyadaki herkes kendi dilinde altyazı ve seslendirmeyle izlesin.
          </p>
        </div>

        <button
          type="button"
          onClick={handleOpenUpload}
          className="min-h-[44px] sm:min-h-[38px] px-4 bg-teal-600 text-white rounded-xl text-xs font-semibold hover:bg-teal-700 inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
        >
          <Upload className="w-4 h-4" />
          Video Yükle &amp; Çevir
        </button>
      </div>

      {noticeMsg && (
        <div className="px-4 py-2.5 bg-teal-50 border border-teal-200 rounded-xl text-xs font-medium text-teal-900">
          {noticeMsg}
        </div>
      )}

      {videos.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center space-y-3">
          <Film className="w-8 h-8 text-teal-600 mx-auto" />
          <div className="text-sm font-semibold text-slate-900">
            Henüz yüklenmiş topluluk videosu yok
          </div>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            Telefonunuzdan veya bilgisayarınızdan kısa bir video yükleyin; sistem konuşmaları otomatik çözüp tüm dillere çevirsin.
          </p>
          <button
            type="button"
            onClick={handleOpenUpload}
            className="min-h-[44px] px-5 bg-slate-900 text-white rounded-xl text-xs font-semibold hover:bg-slate-800 inline-flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            İlk Videoyu Yükle
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Horizontal Snap-Scroll Video Carousel (Swipe Left / Right) */}
          {videos.length > 1 && (
            <div
              data-no-tab-swipe="true"
              className="flex items-center gap-2.5 overflow-x-auto snap-x snap-mandatory pb-1"
            >
              {videos.map((v) => {
                const isSelected = activeVideo?.id === v.id;
                return (
                  <button
                    key={`strip_${v.id}`}
                    type="button"
                    onClick={() => {
                      setSelectedVideoId(v.id);
                      setCurrentTime(0);
                    }}
                    className={`snap-start shrink-0 min-h-[44px] px-3.5 py-2 rounded-xl border text-left flex items-center gap-2.5 transition-colors ${
                      isSelected
                        ? 'bg-slate-900 border-slate-900 text-white'
                        : 'bg-white border-slate-200 text-slate-800 hover:bg-slate-50'
                    }`}
                  >
                    <Play
                      className={`w-3.5 h-3.5 shrink-0 ${
                        isSelected ? 'text-teal-400' : 'text-teal-600'
                      }`}
                    />
                    <div className="max-w-[170px] truncate text-xs font-semibold">{v.title}</div>
                  </button>
                );
              })}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-6 items-start">
            {/* Active Video Player + Multi-language Live Subtitles (Swipe Left/Right) */}
            {activeVideo && (
              <div
                data-no-tab-swipe="true"
                className="bg-slate-950 rounded-2xl overflow-hidden border border-slate-800 flex flex-col"
              >
                <div
                  onTouchStart={(e) => {
                    if (e.touches.length !== 1) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    // Leave bottom 54px free for native video scrub bar
                    if (e.touches[0].clientY > rect.bottom - 54) return;
                    swipeStartRef.current = {
                      x: e.touches[0].clientX,
                      y: e.touches[0].clientY,
                    };
                  }}
                  onTouchEnd={(e) => {
                    if (!swipeStartRef.current || videos.length < 2) {
                      swipeStartRef.current = null;
                      return;
                    }
                    const touch = e.changedTouches[0];
                    const dx = touch.clientX - swipeStartRef.current.x;
                    const dy = touch.clientY - swipeStartRef.current.y;
                    swipeStartRef.current = null;
                    if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 1.2) {
                      const idx = videos.findIndex((v) => v.id === activeVideo.id);
                      const nextIdx =
                        dx < 0
                          ? (idx + 1) % videos.length
                          : (idx - 1 + videos.length) % videos.length;
                      setSelectedVideoId(videos[nextIdx].id);
                      setCurrentTime(0);
                    }
                  }}
                  className="relative aspect-video sm:aspect-[16/10] bg-black flex items-center justify-center group"
                >
                  <video
                    ref={videoElRef}
                    key={activeVideo.id}
                    src={activeVideo.videoUrl}
                    controls
                    playsInline
                    onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                    className="w-full h-full object-contain"
                  />

                  {videos.length > 1 && (
                    <>
                      <button
                        type="button"
                        aria-label="Önceki video"
                        onClick={() => {
                          const idx = videos.findIndex((v) => v.id === activeVideo.id);
                          const prevIdx = (idx - 1 + videos.length) % videos.length;
                          setSelectedVideoId(videos[prevIdx].id);
                          setCurrentTime(0);
                        }}
                        className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/55 hover:bg-black/80 text-white flex items-center justify-center z-10"
                      >
                        <ChevronLeft className="w-5 h-5" />
                      </button>
                      <button
                        type="button"
                        aria-label="Sonraki video"
                        onClick={() => {
                          const idx = videos.findIndex((v) => v.id === activeVideo.id);
                          const nextIdx = (idx + 1) % videos.length;
                          setSelectedVideoId(videos[nextIdx].id);
                          setCurrentTime(0);
                        }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/55 hover:bg-black/80 text-white flex items-center justify-center z-10"
                      >
                        <ChevronRight className="w-5 h-5" />
                      </button>
                    </>
                  )}

                  {showSubtitles && currentSubtitleText && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-12 px-4 py-3 bg-gradient-to-t from-black/85 via-black/50 to-transparent text-center">
                      <div className="inline-block max-w-xl px-3 py-1.5 rounded-lg bg-black/75 text-white text-xs sm:text-sm font-medium leading-snug">
                        {currentSubtitleText}
                      </div>
                    </div>
                  )}
                </div>

              {/* Viewer Translation Controls */}
              <div className="p-4 bg-slate-900 text-white space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="text-sm font-bold text-white truncate">{activeVideo.title}</h4>
                    <div className="text-xs text-slate-400 mt-0.5">
                      @{activeVideo.authorHandle} · Kaynak Dil:{' '}
                      {getLanguageByCode(activeVideo.sourceLang).nameTr} · {activeVideo.topic}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleLikeVideo(activeVideo)}
                    className="min-h-[40px] px-3 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 shrink-0"
                  >
                    <Heart className="w-3.5 h-3.5 text-rose-400" />
                    <span className="tabular-nums">{activeVideo.likesCount}</span>
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-800">
                  <label className="inline-flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-2.5 min-h-[40px] text-xs">
                    <Languages className="w-3.5 h-3.5 text-teal-400 shrink-0" />
                    <span className="text-slate-300">İzleme Dili:</span>
                    <select
                      value={viewerLang}
                      onChange={(e) => setViewerLang(e.target.value)}
                      className="bg-transparent text-white font-semibold focus:outline-none cursor-pointer"
                    >
                      {WORLD_LANGUAGES.map((l) => (
                        <option key={l.code} value={l.code} className="text-slate-900">
                          {l.nameTr} ({l.nativeName})
                        </option>
                      ))}
                    </select>
                  </label>

                  <button
                    type="button"
                    onClick={() => setShowSubtitles((s) => !s)}
                    className={`min-h-[40px] px-3 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 border ${
                      showSubtitles
                        ? 'bg-teal-600 border-teal-500 text-white'
                        : 'bg-slate-800 border-slate-700 text-slate-300'
                    }`}
                  >
                    <Captions className="w-3.5 h-3.5" />
                    Altyazı {showSubtitles ? 'Açık' : 'Kapalı'}
                  </button>

                  <button
                    type="button"
                    disabled={isSpeakingSub || !currentSubtitleText}
                    onClick={() => void handleSpeakTranslatedSubtitle()}
                    className="min-h-[40px] px-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {isSpeakingSub ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Volume2 className="w-3.5 h-3.5 text-teal-400" />
                    )}
                    Çeviriyi Sesli Dinle
                  </button>

                  {isTranslatingVideo && (
                    <span className="text-xs text-teal-300 inline-flex items-center gap-1">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Çevriliyor...
                    </span>
                  )}
                </div>

                {(activeTranslatedData?.transcript || activeVideo.transcriptOriginal) && (
                  <div className="p-3 bg-slate-950/70 border border-slate-800 rounded-xl text-xs text-slate-300 leading-relaxed">
                    <span className="font-semibold text-teal-400">
                      Tam Çeviri ({getLanguageByCode(viewerLang).nameTr}):{' '}
                    </span>
                    {viewerLang === activeVideo.sourceLang
                      ? activeVideo.transcriptOriginal
                      : activeTranslatedData?.transcript ||
                        activeVideo.translations?.[viewerLang] ||
                        activeVideo.transcriptOriginal}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Video List + Sponsored Cards */}
          <div className="space-y-3">
            {feedAds.length > 0 && (
              <div className="bg-amber-50/70 border border-amber-200 rounded-2xl p-4 space-y-2">
                <div className="flex items-center justify-between text-[11px] font-semibold text-amber-800">
                  <span>Sponsorlu Reklam · {feedAds[0].brandName}</span>
                  <span>Reklam</span>
                </div>
                <div className="text-sm font-bold text-slate-900">{feedAds[0].headline}</div>
                <p className="text-xs text-slate-600">{feedAds[0].description}</p>
                <a
                  href={feedAds[0].targetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => onTrackAdClick(feedAds[0])}
                  className="min-h-[40px] px-3.5 bg-slate-900 text-white rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 hover:bg-slate-800"
                >
                  Ziyaret Et
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            )}

            <div className="bg-white border border-slate-200 rounded-2xl divide-y divide-slate-200 max-h-[520px] overflow-y-auto">
              {videos.map((v) => {
                const isSelected = activeVideo?.id === v.id;
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => {
                      setSelectedVideoId(v.id);
                      setCurrentTime(0);
                    }}
                    className={`w-full text-left p-4 flex items-center justify-between gap-3 transition-colors min-h-[60px] ${
                      isSelected ? 'bg-teal-50/80' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                          isSelected ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        <Play className="w-4 h-4" />
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs sm:text-sm font-semibold text-slate-900 truncate">
                          {v.title}
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5 truncate">
                          @{v.authorHandle} · {getLanguageByCode(v.sourceLang).nameTr} · {v.topic}
                        </div>
                      </div>
                    </div>
                    <span className="text-xs text-slate-500 tabular-nums shrink-0">
                      {v.likesCount} beğeni
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          </div>
        </div>
      )}

      {/* Upload Video Modal */}
      {showUploadModal && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/60 backdrop-blur-xs p-0 sm:p-4"
        >
          <div className="w-full sm:max-w-lg bg-white border border-slate-200 rounded-t-3xl sm:rounded-2xl p-6 max-h-[90vh] overflow-y-auto space-y-4">
            <div className="w-10 h-1 bg-slate-200 rounded-full mx-auto sm:hidden" />
            <div className="flex items-center justify-between">
              <h4 className="text-base font-bold text-slate-900 font-display">
                Video Yükle &amp; Otomatik Çeviri Ekle
              </h4>
              <button
                type="button"
                onClick={() => setShowUploadModal(false)}
                className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl">
              <button
                type="button"
                onClick={() => setUploadMode('file')}
                className={`flex-1 min-h-[40px] text-xs font-semibold rounded-lg transition-colors ${
                  uploadMode === 'file' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                Cihazdan Dosya (MP4/WebM)
              </button>
              <button
                type="button"
                onClick={() => setUploadMode('url')}
                className={`flex-1 min-h-[40px] text-xs font-semibold rounded-lg transition-colors ${
                  uploadMode === 'url' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                HTTPS Video Bağlantısı
              </button>
            </div>

            <form onSubmit={(e) => void handleUploadSubmit(e)} className="space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Video Başlığı
                </label>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={120}
                  value={videoTitle}
                  onChange={(e) => setVideoTitle(e.target.value)}
                  placeholder="Örn: İstanbul'dan Tokyo'ya Sokak Lezzetleri"
                  className="w-full h-11 px-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Videodaki Konuşma Dili
                  </label>
                  <select
                    value={videoSourceLang}
                    onChange={(e) => setVideoSourceLang(e.target.value)}
                    className="w-full h-11 px-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900"
                  >
                    {WORLD_LANGUAGES.map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.nameTr} ({l.nativeName})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Kategori</label>
                  <select
                    value={videoTopic}
                    onChange={(e) => setVideoTopic(e.target.value)}
                    className="w-full h-11 px-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900"
                  >
                    <option value="Günlük Yaşam">Günlük Yaşam</option>
                    <option value="Seyahat & Kültür">Seyahat &amp; Kültür</option>
                    <option value="Eğitim & Dil">Eğitim &amp; Dil</option>
                    <option value="Müzik & Sanat">Müzik &amp; Sanat</option>
                    <option value="Teknoloji">Teknoloji</option>
                  </select>
                </div>
              </div>

              {uploadMode === 'file' ? (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Video Dosyası Seç (Max 15 MB · MP4, WebM, MOV)
                  </label>
                  <input
                    type="file"
                    accept="video/mp4,video/webm,video/quicktime"
                    onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                    className="w-full text-xs text-slate-700 file:mr-3 file:py-2.5 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-slate-900 file:text-white hover:file:bg-slate-800"
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Doğrudan HTTPS Video Linki (.mp4 / .webm)
                  </label>
                  <input
                    type="url"
                    required
                    value={externalVideoUrl}
                    onChange={(e) => setExternalVideoUrl(e.target.value)}
                    placeholder="https://example.com/video.mp4"
                    className="w-full h-11 px-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Konuşma / Altyazı Metni (Opsiyonel — boş bırakılırsa videodan otomatik çözülür)
                </label>
                <textarea
                  rows={3}
                  maxLength={3000}
                  value={manualNarration}
                  onChange={(e) => setManualNarration(e.target.value)}
                  placeholder="Videoda söylenenleri veya çevrilmesini istediğiniz metni buraya da yazabilirsiniz..."
                  className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900"
                />
              </div>

              {errorMsg && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800">
                  {errorMsg}
                </div>
              )}

              {isUploading && uploadStage && (
                <div className="p-3 bg-teal-50 border border-teal-200 rounded-xl text-xs text-teal-900 flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  <span>{uploadStage}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={isUploading}
                className="w-full min-h-[46px] bg-teal-600 text-white rounded-xl text-xs font-semibold hover:bg-teal-700 disabled:opacity-50 inline-flex items-center justify-center gap-2"
              >
                {isUploading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4" />
                )}
                Yükle &amp; Otomatik Çeviri Oluştur
              </button>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
