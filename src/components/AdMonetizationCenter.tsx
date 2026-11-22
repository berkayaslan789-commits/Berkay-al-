import { useEffect, useState } from 'react';
import {
  collection,
  doc,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import {
  BadgeCheck,
  CheckCircle2,
  ExternalLink,
  FileText,
  Loader2,
  Megaphone,
  ShieldAlert,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type { AdCampaign, AdPlacement, AdPolicy, UserProfile } from '../types';
import { isSafeHttpsUrl, sanitizeClientText } from '../utils/safety';

export const DEFAULT_AD_POLICY: AdPolicy = {
  isAcceptingAds: true,
  currency: 'TRY',
  dailyRateBanner: 250,
  dailyRateVideoCard: 450,
  minDurationDays: 3,
  prohibitedContent:
    'Yasa dışı bahis, zararlı yazılım, kimlik avı bağlantıları, telif hakkı ihlali içeren materyaller, nefret söylemi ve yanıltıcı sağlık/finans vaatleri içeren reklamlar kesinlikle yasaktır.',
  termsText:
    '1. Tüm reklam başvuruları yayınlanmadan önce OndaTalk platform sahibi tarafından incelenir ve onaylanır.\n2. Reklamveren, yönlendirdiği https:// adresinin ve görsel/metin içeriklerinin telif haklarına sahip olduğunu kabul eder.\n3. Kurallara aykırı olduğu sonradan tespit edilen reklamlar iade yapılmaksızın durdurulabilir.\n4. Onay sonrası reklam bedeli belirtilen ödeme talimatı üzerinden doğrulandıktan sonra kampanya yayına alınır.',
  paymentInstructions:
    'Başvuru sonrasında yönetici onay e-postası ile iletilen IBAN / ödeme kanalına kampanya kodunu yazarak ödemeyi tamamlayabilirsiniz.',
  updatedBy: 'system',
};

interface AdMonetizationCenterProps {
  profile: UserProfile | null;
  userEmail?: string | null;
  onRequireAuth: () => void;
}

export function AdMonetizationCenter({
  profile,
  userEmail,
  onRequireAuth,
}: AdMonetizationCenterProps) {
  const [policy, setPolicy] = useState<AdPolicy>(DEFAULT_AD_POLICY);
  const [myCampaigns, setMyCampaigns] = useState<AdCampaign[]>([]);

  const [brandName, setBrandName] = useState('');
  const [contactEmail, setContactEmail] = useState(userEmail || '');
  const [headline, setHeadline] = useState('');
  const [description, setDescription] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [placement, setPlacement] = useState<AdPlacement>('feed_card');
  const [durationDays, setDurationDays] = useState<number>(7);
  const [paymentNote, setPaymentNote] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    if (userEmail && !contactEmail) setContactEmail(userEmail);
  }, [userEmail]);

  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, 'adPolicies', 'default'),
      (snap) => {
        if (snap.exists()) {
          setPolicy(snap.data() as AdPolicy);
        }
      },
      () => {
        // use fallback policy when uninitialized
      }
    );
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!profile) {
      setMyCampaigns([]);
      return;
    }
    const q = query(
      collection(db, 'adCampaigns'),
      where('advertiserUid', '==', profile.uid),
      limit(30)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const items = snap.docs
          .map((d) => d.data() as AdCampaign)
          .sort((a, b) => {
            const ta = (a.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
            const tb = (b.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
            return tb - ta;
          });
        setMyCampaigns(items);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'adCampaigns')
    );
    return () => unsub();
  }, [profile?.uid]);

  const dailyRate =
    placement === 'banner_top' ? policy.dailyRateBanner : policy.dailyRateVideoCard;
  const totalPrice = Math.max(1, durationDays) * dailyRate;

  const handleSubmitAd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) {
      onRequireAuth();
      return;
    }
    if (!policy.isAcceptingAds) {
      setErrorMsg('Platform şu anda yeni reklam başvurularını geçici olarak durdurmuştur.');
      return;
    }
    if (!termsAccepted) {
      setErrorMsg('Devam etmek için reklam şartlarını okuyup onaylamanız gerekir.');
      return;
    }

    const cleanBrand = sanitizeClientText(brandName, 60);
    const cleanHeadline = sanitizeClientText(headline, 100);
    const cleanDesc = sanitizeClientText(description, 240);
    const cleanNote = sanitizeClientText(paymentNote, 240);

    if (!cleanBrand.safe || !cleanHeadline.safe || !cleanDesc.safe || !cleanNote.safe) {
      setErrorMsg('Güvenlik kalkanı: Girilen alanlarda izin verilmeyen içerik tespit edildi.');
      return;
    }
    if (!isSafeHttpsUrl(targetUrl)) {
      setErrorMsg('Hedef bağlantı mutlaka https:// ile başlayan güvenli bir adres olmalıdır.');
      return;
    }
    if (imageUrl.trim() && !isSafeHttpsUrl(imageUrl)) {
      setErrorMsg('Görsel bağlantısı yalnızca https:// adresi olabilir.');
      return;
    }
    if (durationDays < policy.minDurationDays) {
      setErrorMsg(`Minimum reklam süresi ${policy.minDurationDays} gündür.`);
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const adId = `ad_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const campaignPayload: AdCampaign = {
        id: adId,
        advertiserUid: profile.uid,
        brandName: cleanBrand.text,
        headline: cleanHeadline.text,
        description: cleanDesc.text,
        targetUrl: targetUrl.trim().slice(0, 512),
        ...(imageUrl.trim() ? { imageUrl: imageUrl.trim().slice(0, 512) } : {}),
        placement,
        durationDays,
        totalPrice,
        currency: policy.currency,
        termsAccepted: true,
        status: 'pending',
        impressions: 0,
        clicks: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      await setDoc(doc(db, 'adCampaigns', adId), campaignPayload);
      await setDoc(doc(db, 'adCampaigns', adId, 'private', 'billing'), {
        adId,
        advertiserUid: profile.uid,
        contactEmail: contactEmail.trim().slice(0, 120),
        paymentNote: cleanNote.text,
        createdAt: serverTimestamp(),
      });

      setBrandName('');
      setHeadline('');
      setDescription('');
      setTargetUrl('');
      setImageUrl('');
      setPaymentNote('');
      setTermsAccepted(false);
      setSuccessMsg(
        `Reklam başvurunuz (${adId}) alındı! Platform yöneticisi onayladıktan sonra yayına alınacaktır.`
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'adCampaigns');
      setErrorMsg('Başvuru kaydedilemedi. Lütfen alanları kontrol edip tekrar deneyin.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1.05fr_1fr] gap-6 items-start">
      {/* Left: Ad Terms, Pricing & Prohibited Policy */}
      <div className="space-y-6">
        <section className="bg-white border border-slate-200 rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2.5">
            <FileText className="w-5 h-5 text-teal-600 shrink-0" />
            <div>
              <h2 className="text-base font-bold text-slate-900 font-display">
                OndaTalk Reklam Şartları &amp; Yayın Politikası
              </h2>
              <p className="text-xs text-slate-500">
                Küresel çok dilli kitleye marka tanıtımı ve sponsorluk kuralları
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
              <div className="text-base font-bold font-mono tabular-nums text-slate-900">
                {policy.dailyRateBanner} {policy.currency}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">Üst Banner / Gün</div>
            </div>
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
              <div className="text-base font-bold font-mono tabular-nums text-slate-900">
                {policy.dailyRateVideoCard} {policy.currency}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">Video &amp; Akış / Gün</div>
            </div>
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl col-span-2 sm:col-span-1">
              <div className="text-base font-bold font-mono tabular-nums text-teal-700">
                {policy.minDurationDays} Gün
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">Minimum Süre</div>
            </div>
          </div>

          <div className="space-y-2 text-xs text-slate-700 leading-relaxed whitespace-pre-line bg-slate-50 border border-slate-200 rounded-xl p-4">
            {policy.termsText}
          </div>

          <div className="p-4 bg-rose-50/70 border border-rose-200 rounded-xl space-y-1">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-900">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              Yasaklı İçerik ve Güvenlik Kuralları
            </div>
            <p className="text-xs text-rose-800 leading-relaxed">{policy.prohibitedContent}</p>
          </div>

          <div className="p-4 bg-teal-50/70 border border-teal-200 rounded-xl space-y-1">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-teal-900">
              <BadgeCheck className="w-4 h-4 shrink-0" />
              Ödeme ve Aktivasyon Talimatı
            </div>
            <p className="text-xs text-teal-800 leading-relaxed">{policy.paymentInstructions}</p>
          </div>
        </section>

        {myCampaigns.length > 0 && (
          <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
            <h3 className="text-sm font-bold text-slate-900">Başvurularım</h3>
            <div className="divide-y divide-slate-200">
              {myCampaigns.map((c) => (
                <div key={c.id} className="py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-900 truncate">
                      {c.brandName} — {c.headline}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {c.durationDays} gün · {c.totalPrice} {c.currency} · {c.clicks} tıklama
                    </div>
                  </div>
                  <span
                    className={`text-xs font-semibold shrink-0 ${
                      c.status === 'approved'
                        ? 'text-emerald-700'
                        : c.status === 'rejected'
                          ? 'text-rose-700'
                          : 'text-amber-700'
                    }`}
                  >
                    {c.status === 'approved'
                      ? 'Yayında'
                      : c.status === 'rejected'
                        ? 'Reddedildi'
                        : c.status === 'paused'
                          ? 'Duraklatıldı'
                          : 'Onay Bekliyor'}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* Right: Advertiser Application Form */}
      <section className="bg-white border border-slate-200 rounded-2xl p-6 space-y-4">
        <div className="flex items-center gap-2.5">
          <Megaphone className="w-5 h-5 text-teal-600 shrink-0" />
          <div>
            <h3 className="text-base font-bold text-slate-900 font-display">
              Sponsorlu Reklam Başvurusu
            </h3>
            <p className="text-xs text-slate-500">
              Onaylanan reklamlar telefon, tablet ve masaüstü kullanıcılarına gösterilir.
            </p>
          </div>
        </div>

        {!policy.isAcceptingAds ? (
          <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900">
            Reklam alımı şu anda yönetici tarafından geçici olarak kapatılmıştır.
          </div>
        ) : (
          <form onSubmit={(e) => void handleSubmitAd(e)} className="space-y-3.5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Marka / İşletme Adı
                </label>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={60}
                  value={brandName}
                  onChange={(e) => setBrandName(e.target.value)}
                  placeholder="Örn: İşletme veya Proje Adı"
                  className="w-full h-11 px-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  İletişim E-posta (Gizli)
                </label>
                <input
                  type="email"
                  required
                  maxLength={120}
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  placeholder="reklam@marka.com"
                  className="w-full h-11 px-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Reklam Başlığı
              </label>
              <input
                type="text"
                required
                minLength={3}
                maxLength={100}
                value={headline}
                onChange={(e) => setHeadline(e.target.value)}
                placeholder="Örn: Online Dil Koçluğu ile 30 Günde Akıcı Konuşun"
                className="w-full h-11 px-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Kısa Açıklama
              </label>
              <textarea
                required
                rows={2}
                minLength={5}
                maxLength={240}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Kullanıcıların göreceği 1-2 cümlelik tanıtım metni..."
                className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Hedef Web Sitesi (https://)
                </label>
                <input
                  type="url"
                  required
                  value={targetUrl}
                  onChange={(e) => setTargetUrl(e.target.value)}
                  placeholder="https://example.com"
                  className="w-full h-11 px-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Görsel Bağlantısı (Opsiyonel https://)
                </label>
                <input
                  type="url"
                  value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)}
                  placeholder="https://example.com/banner.jpg"
                  className="w-full h-11 px-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Yayın Alanı
                </label>
                <select
                  value={placement}
                  onChange={(e) => setPlacement(e.target.value as AdPlacement)}
                  className="w-full h-11 px-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900"
                >
                  <option value="feed_card">Video &amp; Akış Kartı ({policy.dailyRateVideoCard} {policy.currency}/gün)</option>
                  <option value="banner_top">Üst Banner Alanı ({policy.dailyRateBanner} {policy.currency}/gün)</option>
                  <option value="video_sponsor">Video Sponsor Kartı ({policy.dailyRateVideoCard} {policy.currency}/gün)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Yayın Süresi (Gün · Min {policy.minDurationDays})
                </label>
                <input
                  type="number"
                  min={policy.minDurationDays}
                  max={365}
                  value={durationDays}
                  onChange={(e) => setDurationDays(Number(e.target.value) || policy.minDurationDays)}
                  className="w-full h-11 px-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono text-slate-900"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Ödeme Referans / Dekont Notu (Opsiyonel)
              </label>
              <input
                type="text"
                maxLength={240}
                value={paymentNote}
                onChange={(e) => setPaymentNote(e.target.value)}
                placeholder="Havale / fatura bilginizi veya tercih ettiğiniz ödeme yöntemini yazın"
                className="w-full h-11 px-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900"
              />
            </div>

            <div className="p-3.5 bg-slate-900 text-white rounded-xl flex items-center justify-between">
              <span className="text-xs text-slate-300">Hesaplanan Toplam Kampanya Bedeli</span>
              <span className="text-base font-bold font-mono tabular-nums text-teal-400">
                {totalPrice} {policy.currency}
              </span>
            </div>

            <label className="flex items-start gap-2.5 text-xs text-slate-700 cursor-pointer min-h-[44px] py-1">
              <input
                type="checkbox"
                checked={termsAccepted}
                onChange={(e) => setTermsAccepted(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-teal-600 rounded shrink-0"
              />
              <span>
                Sol bölümdeki <strong>OndaTalk Reklam Şartları ve Yasaklı İçerik Kurallarını</strong> okudum ve kabul ediyorum.
              </span>
            </label>

            {errorMsg && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800">
                {errorMsg}
              </div>
            )}

            {successMsg && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-900 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{successMsg}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full min-h-[46px] bg-teal-600 text-white rounded-xl text-xs font-semibold hover:bg-teal-700 disabled:opacity-50 inline-flex items-center justify-center gap-2"
            >
              {isSubmitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <ExternalLink className="w-4 h-4" />
              )}
              {profile ? 'Reklam Başvurusu Gönder' : 'Başvurmak İçin Giriş Yap'}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
