# OndaTalk — Küresel Gerçek Zamanlı Sesli, Yazılı ve Görüntülü Çeviri Sosyal Platformu

OndaTalk; dünyanın her yerinden kullanıcıların **telefon, tablet ve masaüstü** tarayıcılardan (ayrıca PWA olarak ana ekrana kurularak) görüntülü eşleşme, sesli çeviri, mikrofonsuz yazılı çeviri ve çok dilli canlı yayın/video paylaşımı yapabilmesi için tasarlanmış çok dilli iletişim platformudur.

---

## Temel Özellikler

- **Mobil & Tablet Öncelikli Tam Ekran Görüntülü Eşleşme:** Konuşma başladığında otomatik tam ekran, alta sabitlenmiş kontrol çubuğu, sürüklenebilir PiP öz-kamera ve sola/sağa kaydırma (swipe) hareketleriyle hızlı geçiş ve sohbet çekmecesi.
- **Mikrofonsuz ve Kayıtsız Kullanım:** Mikrofonu olmayan veya hesap açmak istemeyen kullanıcılar doğrudan yazılı çeviri ve misafir sohbetiyle platformu kullanabilir.
- **Çok Dilli Video Akışı ve Canlı Yayınlar:** Yüklenen videolarda ve canlı yayınlarda farklı dillerde otomatik altyazı/çeviri desteği, sağa/sola kaydırılabilir dikey/yatay mobil akış.
- **Reklam & Gelir Modeli + Yönetim Paneli:** İlan koşulları, reklam verme formu ve yetkili yönetici/sahip denetimi.
- **Güvenlik Kalkanı:** Sunucu taraflı API anahtarı izolasyonu (`GEMINI_API_KEY` istemci paketine gömülmez), XSS/zararlı yük engelleme, IP tabanlı hız sınırlaması (`rate limit`), WebSocket flood koruması ve Firestore güvenlik kuralları (`firestore.rules`).

---

## Gereksinimler

- **Node.js `>= 22.0.0`** (`node server.ts` doğrudan TypeScript giriş noktasını çalıştırır)
- **Gemini API Anahtarı** (`GEMINI_API_KEY`)
- **Firebase Projesi** (`firebase-applet-config.json` ile yapılandırılmış Firestore & Authentication)

---

## 1. Yerelde Çalıştırma

```bash
npm install
cp .env.example .env
```

`.env` dosyasının içine kendi API anahtarınızı ekleyin (bu dosyayı **asla** kod deposuna göndermeyin; `.gitignore` otomatik olarak hariç tutar):

```env
GEMINI_API_KEY="BURAYA_API_ANAHTARINIZI_YAZIN"
NODE_ENV=development
PORT=3000
```

Geliştirme sunucusunu başlatmak için:

```bash
npm run dev
```

Üretim (production) derlemesi ve testi için:

```bash
npm run build
NODE_ENV=production node server.ts
```

---

## 2. Kod Deposuna (GitHub) Taşıma

> **Güvenlik Notu:** `.gitignore` dosyası `node_modules/`, `dist/`, `uploads/` ve `.env*` dosyalarını depo dışında tutar. Gerçek `GEMINI_API_KEY` anahtarınızı **kesinlikle** koda veya repoya eklemeyin; yalnızca sunucu panelindeki Environment Variables bölümüne girin.

```bash
git init
git branch -M main
git add .
git commit -m "OndaTalk ilk surum"
git remote add origin https://github.com/KULLANICI_ADINIZ/ondatalk.git
git push -u origin main
```

---

## 3. Ücretsiz Sunucuya Yayınlama

Projede hazır yapılandırma dosyaları bulunmaktadır:

- `render.yaml` (Render Blueprint için)
- `Dockerfile` (Koyeb, Fly.io, Railway veya Docker destekli herhangi bir ücretsiz bulut sunucusu için)
- `Procfile` (`web: NODE_ENV=production node server.ts`)

### Ortam Değişkenleri (Sunucu Panelinde Tanımlanacak)

- `NODE_ENV` = `production`
- `GEMINI_API_KEY` = `...` (Gizli / Secret olarak ekleyin)
- `PORT` = `3000` (veya sunucunun otomatik atadığı port)
- Sağlık kontrolü yolu (Health Check): `/api/health`

### Yayın Sonrası Zorunlu Firebase Ayarı

Yeni sunucu alan adınız (`https://ondatalk.onrender.com` veya `https://....koyeb.app`) açıldıktan sonra kullanıcı girişlerinin hata vermemesi için:

1. Firebase Console -> **iconic-venture-hv0ns** projesini açın.
2. **Authentication -> Settings -> Authorized domains** bölümüne girin.
3. Yeni canlı alan adınızı (**Add domain**) ekleyin.

### Ücretsiz Sunucu Dosya Depolama Notu

Ücretsiz (free-tier) sunucularda konteyner uyku moduna geçip yeniden başladığında yerel `/uploads/videos` klasörü sıfırlanabilir. Kalıcı videolar için video eklerken doğrudan harici `https://` video bağlantısı kullanılması önerilir.
