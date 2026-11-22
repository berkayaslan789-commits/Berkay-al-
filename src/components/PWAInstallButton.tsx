import { useState } from 'react';
import { Download, Share2, Smartphone, WifiOff, X } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  label?: string;
}

export function PWAInstallButton({ label = 'Uygulamayı İndir' }: PWAInstallButtonProps) {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuideModal, setShowGuideModal] = useState(false);

  if (isInstalled) {
    return null;
  }

  const handleClick = async () => {
    if (isInstallable) {
      await install();
    } else {
      setShowGuideModal(true);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void handleClick()}
        className="min-h-[44px] sm:min-h-[36px] px-3.5 py-2 bg-slate-900 text-white rounded-lg text-xs font-semibold hover:bg-slate-800 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0"
      >
        <Download className="w-3.5 h-3.5 text-teal-400 shrink-0" />
        <span>{label}</span>
      </button>

      {showGuideModal && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/60 backdrop-blur-xs p-0 sm:p-4"
        >
          <div className="w-full sm:max-w-md bg-white border border-slate-200 rounded-t-3xl sm:rounded-2xl p-6 space-y-4">
            <div className="w-10 h-1 bg-slate-200 rounded-full mx-auto sm:hidden" />
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Smartphone className="w-5 h-5 text-teal-600 shrink-0" />
                <h3 className="text-base font-bold text-slate-900 font-display">
                  OndaTalk&apos;ı Cihazına Kur
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowGuideModal(false)}
                aria-label="Kapat"
                className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {isIOS ? (
              <ol className="text-xs text-slate-600 space-y-2 list-decimal list-inside leading-relaxed">
                <li>
                  Mobil tarayıcı alt araç çubuğundaki <strong>Paylaş</strong> simgesine dokunun.
                </li>
                <li>
                  Aşağı kaydırıp <strong>Ana Ekrana Ekle</strong> seçeneğine basın.
                </li>
                <li>
                  Sağ üstten <strong>Ekle</strong> diyerek telefon veya tablet ana ekranınızdan tam ekran uygulama gibi açın.
                </li>
              </ol>
            ) : (
              <ol className="text-xs text-slate-600 space-y-2 list-decimal list-inside leading-relaxed">
                <li>
                  Mobil veya masaüstü tarayıcı menüsünü (<strong>⋮</strong>) açın.
                </li>
                <li>
                  <strong>Uygulamayı Yükle</strong> veya <strong>Ana Ekrana Ekle</strong> seçeneğine dokunun.
                </li>
                <li>
                  OndaTalk telefon, tablet ve bilgisayarınıza uygulama simgesiyle kurulacaktır.
                </li>
              </ol>
            )}

            <button
              type="button"
              onClick={() => setShowGuideModal(false)}
              className="w-full min-h-[44px] bg-teal-600 text-white rounded-xl text-xs font-semibold hover:bg-teal-700 transition-colors"
            >
              Anladım
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function OfflineIndicator() {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div className="fixed bottom-20 md:bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg bg-amber-600 px-3.5 py-2 text-xs font-medium text-white shadow-lg">
      <WifiOff className="w-3.5 h-3.5 shrink-0" />
      <span>Çevrimdışı Mod — Önbellekteki içerikler gösteriliyor.</span>
    </div>
  );
}

interface GlobalShareButtonProps {
  onShared?: (message: string) => void;
}

export function GlobalShareButton({ onShared }: GlobalShareButtonProps) {
  const handleShare = async () => {
    const shareUrl = window.location.origin;
    const shareData = {
      title: 'OndaTalk — Küresel Çok Dilli Sohbet',
      text: 'Kendi dilinde dünyadaki herkesle anında görüntülü, sesli veya yazılı konuş!',
      url: shareUrl,
    };

    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share(shareData);
        onShared?.('OndaTalk davet bağlantısı paylaşıldı.');
        return;
      }
    } catch {
      // User dismissed native share sheet or unsupported; fall back to clipboard
    }

    try {
      await navigator.clipboard.writeText(`${shareData.text} ${shareUrl}`);
      onShared?.('Davet bağlantısı kopyalandı — tüm platformlarda paylaşabilirsiniz!');
    } catch {
      onShared?.('Paylaşım bağlantısı: ' + shareUrl);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleShare()}
      className="min-h-[44px] sm:min-h-[36px] px-3.5 py-2 bg-teal-600 text-white rounded-lg text-xs font-semibold hover:bg-teal-700 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0"
    >
      <Share2 className="w-3.5 h-3.5 shrink-0" />
      <span>Paylaş</span>
    </button>
  );
}
