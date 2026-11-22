import { useEffect, useState } from 'react';
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
} from 'firebase/firestore';
import {
  Ban,
  CheckCircle2,
  Cloud,
  Crown,
  Film,
  Loader2,
  Megaphone,
  PauseCircle,
  Radio,
  RefreshCw,
  Save,
  Shield,
  ShieldCheck,
  Star,
  Trash2,
  UserCheck,
  VolumeX,
  XCircle,
} from 'lucide-react';
import { auth, db, handleFirestoreError, OperationType } from '../firebase';
import { getLanguageByCode } from '../languages';
import type {
  AdCampaign,
  AdCampaignBilling,
  AdPolicy,
  AdminRecord,
  LiveStream,
  ModerationReport,
  PlatformSettings,
  UserProfile,
  VideoPost,
} from '../types';
import { DEFAULT_AD_POLICY } from './AdMonetizationCenter';

interface AdminPanelProps {
  currentUserUid: string;
  isSuperOwner: boolean;
  platformSettings: PlatformSettings;
}

export function AdminPanel({
  currentUserUid,
  isSuperOwner,
  platformSettings,
}: AdminPanelProps) {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [admins, setAdmins] = useState<AdminRecord[]>([]);
  const [streams, setStreams] = useState<LiveStream[]>([]);
  const [reports, setReports] = useState<ModerationReport[]>([]);
  const [videos, setVideos] = useState<VideoPost[]>([]);
  const [adCampaigns, setAdCampaigns] = useState<AdCampaign[]>([]);
  const [adBillingMap, setAdBillingMap] = useState<Record<string, AdCampaignBilling>>({});
  const [adPolicy, setAdPolicy] = useState<AdPolicy>(DEFAULT_AD_POLICY);
  const [isSavingPolicy, setIsSavingPolicy] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const [announcement, setAnnouncement] = useState(platformSettings.announcement);
  const [maintenanceMode, setMaintenanceMode] = useState(platformSettings.maintenanceMode);
  const [autoTranslateVoice, setAutoTranslateVoice] = useState(
    platformSettings.autoTranslateVoice
  );
  const [allowRandomMatch, setAllowRandomMatch] = useState(platformSettings.allowRandomMatch);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [securityStatus, setSecurityStatus] = useState<{
    protected: boolean;
    blockedMaliciousPayloads: number;
    rateLimitedRequests: number;
    floodDisconnects: number;
    sanitizedControlChars: number;
    activeWsConnections: number;
    uptimeSeconds: number;
  } | null>(null);

  const loadSecurityStatus = async () => {
    try {
      const resp = await fetch('/api/security-status');
      if (resp.ok) {
        const data = (await resp.json()) as {
          protected: boolean;
          blockedMaliciousPayloads: number;
          rateLimitedRequests: number;
          floodDisconnects: number;
          sanitizedControlChars: number;
          activeWsConnections: number;
          uptimeSeconds: number;
        };
        setSecurityStatus(data);
      }
    } catch {
      // ignore transient network check
    }
  };

  useEffect(() => {
    void loadSecurityStatus();
  }, []);

  useEffect(() => {
    setAnnouncement(platformSettings.announcement);
    setMaintenanceMode(platformSettings.maintenanceMode);
    setAutoTranslateVoice(platformSettings.autoTranslateVoice);
    setAllowRandomMatch(platformSettings.allowRandomMatch);
  }, [platformSettings]);

  useEffect(() => {
    const qUsers = query(collection(db, 'users'), orderBy('createdAt', 'desc'), limit(100));
    const unsubUsers = onSnapshot(
      qUsers,
      (snap) => setUsers(snap.docs.map((d) => d.data() as UserProfile)),
      (err) => handleFirestoreError(err, OperationType.LIST, 'users')
    );

    const qStreams = query(collection(db, 'streams'), orderBy('createdAt', 'desc'), limit(60));
    const unsubStreams = onSnapshot(
      qStreams,
      (snap) => setStreams(snap.docs.map((d) => d.data() as LiveStream)),
      (err) => handleFirestoreError(err, OperationType.LIST, 'streams')
    );

    const qVideos = query(collection(db, 'videos'), orderBy('createdAt', 'desc'), limit(40));
    const unsubVideos = onSnapshot(
      qVideos,
      (snap) => setVideos(snap.docs.map((d) => d.data() as VideoPost)),
      (err) => handleFirestoreError(err, OperationType.LIST, 'videos')
    );

    const unsubPolicy = onSnapshot(
      doc(db, 'adPolicies', 'default'),
      (snap) => {
        if (snap.exists()) setAdPolicy(snap.data() as AdPolicy);
      },
      () => {}
    );

    let unsubAdmins = () => {};
    let unsubReports = () => {};
    let unsubAds = () => {};

    if (isSuperOwner) {
      unsubAdmins = onSnapshot(
        collection(db, 'admins'),
        (snap) => setAdmins(snap.docs.map((d) => d.data() as AdminRecord)),
        (err) => handleFirestoreError(err, OperationType.LIST, 'admins')
      );

      const qReports = query(collection(db, 'reports'), orderBy('createdAt', 'desc'), limit(80));
      unsubReports = onSnapshot(
        qReports,
        (snap) => setReports(snap.docs.map((d) => d.data() as ModerationReport)),
        (err) => handleFirestoreError(err, OperationType.LIST, 'reports')
      );

      const qAds = query(collection(db, 'adCampaigns'), orderBy('createdAt', 'desc'), limit(50));
      unsubAds = onSnapshot(
        qAds,
        (snap) => setAdCampaigns(snap.docs.map((d) => d.data() as AdCampaign)),
        (err) => handleFirestoreError(err, OperationType.LIST, 'adCampaigns')
      );
    }

    return () => {
      unsubUsers();
      unsubStreams();
      unsubVideos();
      unsubPolicy();
      unsubAdmins();
      unsubReports();
      unsubAds();
    };
  }, [isSuperOwner]);

  const notify = (msg: string) => {
    setStatusNotice(msg);
    setTimeout(() => setStatusNotice(null), 2600);
  };

  const handleSavePlatformSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingSettings(true);
    try {
      await setDoc(doc(db, 'platformSettings', 'global'), {
        announcement: announcement.trim().slice(0, 240),
        maintenanceMode,
        autoTranslateVoice,
        allowRandomMatch,
        updatedBy: currentUserUid,
        updatedAt: serverTimestamp(),
      });
      notify('Platform ayarları güncellendi ve tüm kullanıcılara uygulandı.');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'platformSettings/global');
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleChangeUserStatus = async (
    targetUid: string,
    status: 'active' | 'muted' | 'banned'
  ) => {
    try {
      await updateDoc(doc(db, 'users', targetUid), {
        status,
        updatedAt: serverTimestamp(),
      });
      notify(`Kullanıcı durumu "${status}" olarak güncellendi.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${targetUid}`);
    }
  };

  const handleToggleModerator = async (user: UserProfile) => {
    if (!isSuperOwner) return;
    const existingAdmin = admins.find((a) => a.uid === user.uid);
    try {
      if (existingAdmin) {
        await deleteDoc(doc(db, 'admins', user.uid));
        notify(`${user.displayName} yönetici yetkisi kaldırıldı.`);
      } else {
        await setDoc(doc(db, 'admins', user.uid), {
          uid: user.uid,
          email: `${user.handle}@ondatalk.local`,
          role: 'moderator',
          grantedBy: currentUserUid,
          createdAt: serverTimestamp(),
        });
        notify(`${user.displayName} moderatör olarak atandı.`);
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `admins/${user.uid}`);
    }
  };

  const handleToggleFeaturedStream = async (stream: LiveStream) => {
    try {
      await updateDoc(doc(db, 'streams', stream.id), {
        featured: !stream.featured,
        updatedAt: serverTimestamp(),
      });
      notify(stream.featured ? 'Öne çıkarma kaldırıldı.' : 'Yayın öne çıkarıldı.');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `streams/${stream.id}`);
    }
  };

  const handleForceCloseStream = async (streamId: string) => {
    try {
      await updateDoc(doc(db, 'streams', streamId), {
        isLive: false,
        updatedAt: serverTimestamp(),
      });
      const idToken = await auth.currentUser?.getIdToken();
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/video-social`);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'admin:force_close_stream', streamId, idToken }));
        setTimeout(() => ws.close(), 300);
      };
      notify('Canlı yayın yönetici yetkisiyle kapatıldı.');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `streams/${streamId}`);
    }
  };

  const handleResolveReport = async (
    reportId: string,
    status: 'resolved' | 'dismissed'
  ) => {
    try {
      await updateDoc(doc(db, 'reports', reportId), {
        status,
        updatedAt: serverTimestamp(),
      });
      notify('Şikayet kaydı güncellendi.');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `reports/${reportId}`);
    }
  };

  const handleSaveAdPolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingPolicy(true);
    try {
      await setDoc(doc(db, 'adPolicies', 'default'), {
        isAcceptingAds: adPolicy.isAcceptingAds,
        currency: adPolicy.currency,
        dailyRateBanner: Number(adPolicy.dailyRateBanner) || 0,
        dailyRateVideoCard: Number(adPolicy.dailyRateVideoCard) || 0,
        minDurationDays: Math.max(1, Number(adPolicy.minDurationDays) || 1),
        prohibitedContent: adPolicy.prohibitedContent.trim().slice(0, 800),
        termsText: adPolicy.termsText.trim().slice(0, 2500),
        paymentInstructions: adPolicy.paymentInstructions.trim().slice(0, 500),
        updatedBy: currentUserUid,
        updatedAt: serverTimestamp(),
      });
      notify('Reklam şartları ve ücret tarifesi kaydedildi.');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'adPolicies/default');
    } finally {
      setIsSavingPolicy(false);
    }
  };

  const handleChangeAdStatus = async (
    adId: string,
    status: 'approved' | 'paused' | 'rejected'
  ) => {
    try {
      await updateDoc(doc(db, 'adCampaigns', adId), {
        status,
        updatedAt: serverTimestamp(),
      });
      notify(`Reklam kampanyası durumu "${status}" olarak güncellendi.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `adCampaigns/${adId}`);
    }
  };

  const handleDeleteAd = async (adId: string) => {
    try {
      await deleteDoc(doc(db, 'adCampaigns', adId));
      notify('Reklam kaydı silindi.');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `adCampaigns/${adId}`);
    }
  };

  const handleLoadAdBilling = async (adId: string) => {
    try {
      const snap = await getDoc(doc(db, 'adCampaigns', adId, 'private', 'billing'));
      if (snap.exists()) {
        setAdBillingMap((prev) => ({
          ...prev,
          [adId]: snap.data() as AdCampaignBilling,
        }));
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, `adCampaigns/${adId}/private/billing`);
    }
  };

  const handleToggleVideoPublish = async (video: VideoPost) => {
    try {
      await updateDoc(doc(db, 'videos', video.id), {
        isPublished: !video.isPublished,
        updatedAt: serverTimestamp(),
      });
      notify(video.isPublished ? 'Video yayından kaldırıldı.' : 'Video yeniden yayınlandı.');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `videos/${video.id}`);
    }
  };

  const handleDeleteVideo = async (videoId: string) => {
    try {
      await deleteDoc(doc(db, 'videos', videoId));
      notify('Video kaydı silindi.');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `videos/${videoId}`);
    }
  };

  const approvedRevenue = adCampaigns
    .filter((c) => c.status === 'approved')
    .reduce((sum, c) => sum + (c.totalPrice || 0), 0);

  const filteredUsers = users.filter(
    (u) =>
      u.displayName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      u.handle.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-6">
      {/* Owner Authority Header */}
      <section className="bg-slate-900 text-white border border-slate-800 rounded-xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Crown className="w-6 h-6 text-amber-400 shrink-0" />
            <div>
              <h2 className="text-lg font-bold font-display">
                Platform Yönetim ve Yetki Merkezi
              </h2>
              <p className="text-xs text-slate-300 mt-0.5">
                {isSuperOwner
                  ? 'Tam Süper Yönetici Yetkisi (Platform Sahibi: berkayaslan789@gmail.com)'
                  : 'Yetkili Moderatör Paneli'}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-6 text-right">
            <div>
              <div className="text-lg font-bold font-mono tabular-nums">{users.length}</div>
              <div className="text-[11px] text-slate-400">Kayıtlı Üye</div>
            </div>
            <div>
              <div className="text-lg font-bold font-mono tabular-nums">
                {streams.filter((s) => s.isLive).length}
              </div>
              <div className="text-[11px] text-slate-400">Canlı Yayın</div>
            </div>
            <div>
              <div className="text-lg font-bold font-mono tabular-nums">
                {reports.filter((r) => r.status === 'open').length}
              </div>
              <div className="text-[11px] text-slate-400">Açık Şikayet</div>
            </div>
          </div>
        </div>
      </section>

      {statusNotice && (
        <div className="px-4 py-2.5 bg-teal-50 border border-teal-200 rounded-lg text-xs font-medium text-teal-900">
          {statusNotice}
        </div>
      )}

      {/* Global Platform Settings */}
      <section className="bg-white border border-slate-200 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-slate-900 mb-4">
          Genel Platform Kontrolleri
        </h3>
        <form onSubmit={(e) => void handleSavePlatformSettings(e)} className="space-y-4">
          <div>
            <label htmlFor="adm-ann" className="block text-xs font-medium text-slate-600 mb-1">
              Küresel Duyuru Bandı (Tüm kullanıcılara görünür)
            </label>
            <input
              id="adm-ann"
              type="text"
              maxLength={240}
              value={announcement}
              onChange={(e) => setAnnouncement(e.target.value)}
              placeholder="Örn: Hoş geldiniz! Canlı görüntülü çeviri odaları aktif."
              className="w-full h-10 px-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900"
            />
          </div>

          <div className="flex flex-wrap gap-6 text-xs text-slate-700">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allowRandomMatch}
                onChange={(e) => setAllowRandomMatch(e.target.checked)}
                className="accent-teal-600 rounded w-4 h-4"
              />
              Küresel Rastgele Eşleşmeyi Aç
            </label>

            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoTranslateVoice}
                onChange={(e) => setAutoTranslateVoice(e.target.checked)}
                className="accent-teal-600 rounded w-4 h-4"
              />
              Otomatik Sesli Çeviri Varsayılan Açık
            </label>

            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={maintenanceMode}
                onChange={(e) => setMaintenanceMode(e.target.checked)}
                className="accent-rose-600 rounded w-4 h-4"
              />
              Bakım Modu (Sadece yöneticiler işlem yapar)
            </label>
          </div>

          <button
            type="submit"
            disabled={isSavingSettings}
            className="h-9 px-4 bg-teal-600 text-white rounded-lg text-xs font-semibold hover:bg-teal-700 inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            {isSavingSettings ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
            Ayarları Kaydet ve Yayınla
          </button>
        </form>
      </section>

      {/* Registered Users & Role Assignment */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Kayıtlı Kullanıcılar ve Yetki Yönetimi
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Üyeleri susturabilir, yasaklayabilir veya moderatör yetkisi verebilirsiniz.
            </p>
          </div>
          <input
            type="search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="İsim veya @kullanıcı ara..."
            className="h-9 px-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-900 w-60"
          />
        </div>

        <div className="divide-y divide-slate-200 max-h-[380px] overflow-y-auto">
          {filteredUsers.map((u) => {
            const isMod = admins.some((a) => a.uid === u.uid);
            return (
              <div
                key={u.uid}
                className="p-4 flex flex-wrap items-center justify-between gap-3 hover:bg-slate-50/70"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <span>{u.displayName}</span>
                    <span className="text-xs font-mono font-normal text-slate-500">
                      @{u.handle}
                    </span>
                    {isMod && (
                      <span className="text-xs font-medium text-teal-700">· Moderatör</span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Dil: {getLanguageByCode(u.nativeLang).nameTr} · Durum:{' '}
                    <span
                      className={
                        u.status === 'banned'
                          ? 'text-rose-700 font-semibold'
                          : u.status === 'muted'
                            ? 'text-amber-700 font-semibold'
                            : 'text-emerald-700 font-medium'
                      }
                    >
                      {u.status}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleChangeUserStatus(u.uid, 'active')}
                    className="h-8 px-2.5 border border-slate-200 rounded-md text-xs text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
                  >
                    <UserCheck className="w-3.5 h-3.5 text-emerald-600" />
                    Aktif
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleChangeUserStatus(u.uid, 'muted')}
                    className="h-8 px-2.5 border border-slate-200 rounded-md text-xs text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
                  >
                    <VolumeX className="w-3.5 h-3.5 text-amber-600" />
                    Sustur
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleChangeUserStatus(u.uid, 'banned')}
                    className="h-8 px-2.5 border border-slate-200 rounded-md text-xs text-rose-700 hover:bg-rose-50 inline-flex items-center gap-1"
                  >
                    <Ban className="w-3.5 h-3.5" />
                    Yasakla
                  </button>
                  {isSuperOwner && u.uid !== currentUserUid && (
                    <button
                      type="button"
                      onClick={() => void handleToggleModerator(u)}
                      className={`h-8 px-2.5 border rounded-md text-xs font-medium inline-flex items-center gap-1 ${
                        isMod
                          ? 'bg-teal-50 border-teal-200 text-teal-800'
                          : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <Shield className="w-3.5 h-3.5" />
                      {isMod ? 'Yetkiyi Al' : 'Moderatör Yap'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Live Streams Moderation & Reports */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-200">
            <h3 className="text-sm font-semibold text-slate-900">Canlı Yayın Denetimi</h3>
          </div>
          <div className="divide-y divide-slate-200 max-h-[340px] overflow-y-auto">
            {streams.length === 0 ? (
              <div className="p-6 text-xs text-slate-500 text-center">Yayın kaydı yok.</div>
            ) : (
              streams.map((st) => (
                <div key={st.id} className="p-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-900 truncate">
                      {st.title}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {st.hostName} (@{st.hostHandle}) · {st.isLive ? 'Canlı' : 'Sonlandı'}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => void handleToggleFeaturedStream(st)}
                      className={`h-8 px-2.5 border rounded-md text-xs inline-flex items-center gap-1 ${
                        st.featured
                          ? 'bg-amber-50 border-amber-200 text-amber-800'
                          : 'border-slate-200 text-slate-700'
                      }`}
                    >
                      <Star className="w-3.5 h-3.5" />
                      Öne Çıkar
                    </button>
                    {st.isLive && (
                      <button
                        type="button"
                        onClick={() => void handleForceCloseStream(st.id)}
                        className="h-8 px-2.5 bg-rose-600 text-white rounded-md text-xs font-medium inline-flex items-center gap-1 hover:bg-rose-700"
                      >
                        <Radio className="w-3.5 h-3.5" />
                        Kapat
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-200">
            <h3 className="text-sm font-semibold text-slate-900">Şikayet ve İhlal Bildirimleri</h3>
          </div>
          <div className="divide-y divide-slate-200 max-h-[340px] overflow-y-auto">
            {reports.length === 0 ? (
              <div className="p-6 text-xs text-slate-500 text-center">
                Henüz şikayet bildirimi yok.
              </div>
            ) : (
              reports.map((rep) => (
                <div key={rep.id} className="p-4 space-y-2">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-slate-900">
                      Hedef: {rep.targetName}
                    </span>
                    <span className="font-mono text-[11px] text-slate-500">{rep.status}</span>
                  </div>
                  <p className="text-xs text-slate-600">{rep.reason}</p>
                  {rep.status === 'open' && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      <button
                        type="button"
                        onClick={() => void handleResolveReport(rep.id, 'resolved')}
                        className="h-7 px-2.5 bg-emerald-600 text-white rounded text-[11px] font-medium inline-flex items-center gap-1"
                      >
                        <CheckCircle2 className="w-3 h-3" />
                        Çözüldü
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleResolveReport(rep.id, 'dismissed')}
                        className="h-7 px-2.5 border border-slate-200 text-slate-700 rounded text-[11px] inline-flex items-center gap-1"
                      >
                        <XCircle className="w-3 h-3" />
                        Reddet
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await handleChangeUserStatus(rep.targetUid, 'banned');
                          await handleResolveReport(rep.id, 'resolved');
                        }}
                        className="h-7 px-2.5 bg-rose-600 text-white rounded text-[11px] font-medium inline-flex items-center gap-1"
                      >
                        <Ban className="w-3 h-3" />
                        Kullanıcıyı Yasakla
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </section>
      </div>
      {/* Live Security Shield & Free Cloud Hosting Deployment Guide */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-teal-600" />
              <h3 className="text-sm font-semibold text-slate-900">
                Platform Kendini Koruma Kalkanı
              </h3>
            </div>
            <button
              type="button"
              onClick={() => void loadSecurityStatus()}
              className="h-8 px-2.5 border border-slate-200 rounded-md text-xs text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Yenile
            </button>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            Sunucu; kötücül betik/komut enjeksiyonu taraması, IP başına hız sınırlama, WebSocket taşkın koruması ve katı güvenlik başlıklarıyla kendini otomatik korur.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
              <div className="text-base font-bold font-mono tabular-nums text-slate-900">
                {securityStatus?.blockedMaliciousPayloads ?? 0}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">Engellenen Zararlı İstek</div>
            </div>
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
              <div className="text-base font-bold font-mono tabular-nums text-slate-900">
                {securityStatus?.rateLimitedRequests ?? 0}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">Hız Sınırı Engeli</div>
            </div>
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
              <div className="text-base font-bold font-mono tabular-nums text-slate-900">
                {securityStatus?.floodDisconnects ?? 0}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">Taşkın Kesintisi</div>
            </div>
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
              <div className="text-base font-bold font-mono tabular-nums text-teal-700">
                {securityStatus?.activeWsConnections ?? 0}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">Aktif Soket</div>
            </div>
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Cloud className="w-5 h-5 text-teal-600" />
            <h3 className="text-sm font-semibold text-slate-900">
              Ücretsiz Ağlarda Yayınlama Hazırlığı
            </h3>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            Uygulama Node 22 + Express + WebSocket destekli ücretsiz bulut sunuculara doğrudan yüklenecek şekilde yapılandırılmıştır (<code className="font-mono text-slate-800">render.yaml</code>, <code className="font-mono text-slate-800">Dockerfile</code>, <code className="font-mono text-slate-800">Procfile</code> hazır).
          </p>
          <ol className="text-xs text-slate-700 space-y-1.5 list-decimal list-inside">
            <li>Projeyi kod deponuza aktarın ve ücretsiz Node.js Web Servisi desteği sunan bir sunucuda dağıtım başlatın.</li>
            <li>Ortam değişkenlerine <code className="font-mono text-slate-900">GEMINI_API_KEY</code> ve <code className="font-mono text-slate-900">NODE_ENV=production</code> ekleyin.</li>
            <li>Yeni alan adınızı kimlik doğrulama yetkili alan adları (Authorized Domains) listesine ekleyin.</li>
          </ol>
        </section>
      </div>

      {/* Monetization: Ad Policy & Campaign Approvals */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Megaphone className="w-5 h-5 text-teal-600" />
              <h3 className="text-sm font-semibold text-slate-900">
                Reklam Şartları &amp; Fiyat Tarifesi (Gelir Ayarları)
              </h3>
            </div>
            <span className="text-xs font-mono font-bold text-emerald-700 tabular-nums">
              Onaylı Gelir: {approvedRevenue} {adPolicy.currency}
            </span>
          </div>

          <form onSubmit={(e) => void handleSaveAdPolicy(e)} className="space-y-3">
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={adPolicy.isAcceptingAds}
                  onChange={(e) =>
                    setAdPolicy((prev) => ({ ...prev, isAcceptingAds: e.target.checked }))
                  }
                  className="accent-teal-600 w-4 h-4 rounded"
                />
                Yeni Reklam Başvurusu Kabul Et
              </label>
              <select
                value={adPolicy.currency}
                onChange={(e) =>
                  setAdPolicy((prev) => ({
                    ...prev,
                    currency: e.target.value as 'TRY' | 'USD' | 'EUR',
                  }))
                }
                className="h-8 px-2.5 bg-slate-50 border border-slate-200 rounded-md text-xs font-semibold"
              >
                <option value="TRY">TRY (₺)</option>
                <option value="USD">USD ($)</option>
                <option value="EUR">EUR (€)</option>
              </select>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Banner Günlük
                </label>
                <input
                  type="number"
                  min={0}
                  value={adPolicy.dailyRateBanner}
                  onChange={(e) =>
                    setAdPolicy((prev) => ({
                      ...prev,
                      dailyRateBanner: Number(e.target.value) || 0,
                    }))
                  }
                  className="w-full h-9 px-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Video Kart Günlük
                </label>
                <input
                  type="number"
                  min={0}
                  value={adPolicy.dailyRateVideoCard}
                  onChange={(e) =>
                    setAdPolicy((prev) => ({
                      ...prev,
                      dailyRateVideoCard: Number(e.target.value) || 0,
                    }))
                  }
                  className="w-full h-9 px-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Min Gün
                </label>
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={adPolicy.minDurationDays}
                  onChange={(e) =>
                    setAdPolicy((prev) => ({
                      ...prev,
                      minDurationDays: Math.max(1, Number(e.target.value) || 1),
                    }))
                  }
                  className="w-full h-9 px-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Reklam Şartları Metni
              </label>
              <textarea
                rows={4}
                maxLength={2500}
                value={adPolicy.termsText}
                onChange={(e) =>
                  setAdPolicy((prev) => ({ ...prev, termsText: e.target.value }))
                }
                className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-900"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Yasaklı Reklam İçerikleri
              </label>
              <textarea
                rows={2}
                maxLength={800}
                value={adPolicy.prohibitedContent}
                onChange={(e) =>
                  setAdPolicy((prev) => ({ ...prev, prohibitedContent: e.target.value }))
                }
                className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-900"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Ödeme / IBAN / Fatura Talimatı
              </label>
              <textarea
                rows={2}
                maxLength={500}
                value={adPolicy.paymentInstructions}
                onChange={(e) =>
                  setAdPolicy((prev) => ({ ...prev, paymentInstructions: e.target.value }))
                }
                className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-900"
              />
            </div>

            <button
              type="submit"
              disabled={isSavingPolicy}
              className="h-9 px-4 bg-teal-600 text-white rounded-lg text-xs font-semibold hover:bg-teal-700 inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              {isSavingPolicy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              Reklam Şartlarını Yayınla
            </button>
          </form>
        </section>

        <div className="space-y-6">
          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">
                Reklam Başvuruları ({adCampaigns.length})
              </h3>
            </div>
            <div className="divide-y divide-slate-200 max-h-[300px] overflow-y-auto">
              {adCampaigns.length === 0 ? (
                <div className="p-6 text-xs text-slate-500 text-center">
                  Henüz reklam başvurusu yok.
                </div>
              ) : (
                adCampaigns.map((ad) => {
                  const billing = adBillingMap[ad.id];
                  return (
                    <div key={ad.id} className="p-4 space-y-2">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-semibold text-slate-900">
                          {ad.brandName} · {ad.headline}
                        </span>
                        <span className="font-mono font-bold text-teal-700 tabular-nums shrink-0">
                          {ad.totalPrice} {ad.currency}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {ad.placement} · {ad.durationDays} gün · Durum: <strong>{ad.status}</strong> ·{' '}
                        <a
                          href={ad.targetUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-teal-700 underline"
                        >
                          {ad.targetUrl}
                        </a>
                      </div>
                      {billing ? (
                        <div className="text-[11px] bg-slate-50 border border-slate-200 rounded p-2 text-slate-700">
                          E-posta: {billing.contactEmail}
                          {billing.paymentNote ? ` · Not: ${billing.paymentNote}` : ''}
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void handleLoadAdBilling(ad.id)}
                          className="text-[11px] text-teal-700 underline"
                        >
                          İletişim ve Ödeme Notunu Gör
                        </button>
                      )}
                      <div className="flex flex-wrap items-center gap-1.5 pt-1">
                        <button
                          type="button"
                          onClick={() => void handleChangeAdStatus(ad.id, 'approved')}
                          className="h-7 px-2.5 bg-emerald-600 text-white rounded text-[11px] font-medium inline-flex items-center gap-1"
                        >
                          <CheckCircle2 className="w-3 h-3" />
                          Onayla
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleChangeAdStatus(ad.id, 'paused')}
                          className="h-7 px-2.5 border border-slate-200 text-slate-700 rounded text-[11px] inline-flex items-center gap-1"
                        >
                          <PauseCircle className="w-3 h-3" />
                          Duraklat
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleChangeAdStatus(ad.id, 'rejected')}
                          className="h-7 px-2.5 bg-rose-600 text-white rounded text-[11px] font-medium inline-flex items-center gap-1"
                        >
                          <XCircle className="w-3 h-3" />
                          Reddet
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteAd(ad.id)}
                          className="h-7 px-2 border border-slate-200 text-rose-700 rounded text-[11px] inline-flex items-center"
                          title="Sil"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex items-center gap-2">
              <Film className="w-4 h-4 text-teal-600" />
              <h3 className="text-sm font-semibold text-slate-900">
                Yüklenen Topluluk Videoları ({videos.length})
              </h3>
            </div>
            <div className="divide-y divide-slate-200 max-h-[240px] overflow-y-auto">
              {videos.length === 0 ? (
                <div className="p-6 text-xs text-slate-500 text-center">Video kaydı yok.</div>
              ) : (
                videos.map((v) => (
                  <div key={v.id} className="p-3.5 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-900 truncate">{v.title}</div>
                      <div className="text-[11px] text-slate-500">
                        @{v.authorHandle} · {v.isPublished ? 'Yayında' : 'Gizli'}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => void handleToggleVideoPublish(v)}
                        className="h-7 px-2.5 border border-slate-200 rounded text-[11px] text-slate-700"
                      >
                        {v.isPublished ? 'Gizle' : 'Yayınla'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteVideo(v.id)}
                        className="h-7 px-2 bg-rose-600 text-white rounded text-[11px]"
                      >
                        Sil
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
