import { useState } from 'react';
import { signInWithPopup, signOut, type User } from 'firebase/auth';
import { doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { Loader2, LogOut, ShieldCheck, UserCheck, X } from 'lucide-react';
import {
  auth,
  db,
  googleProvider,
  handleFirestoreError,
  OperationType,
  OWNER_EMAIL,
} from '../firebase';
import { WORLD_LANGUAGES } from '../languages';
import type { UserProfile } from '../types';
import { isSafeHttpsUrl } from '../utils/safety';

interface AuthProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  firebaseUser: User | null;
  profile: UserProfile | null;
  isSuperOwner: boolean;
  isAdmin: boolean;
  onProfileSaved: (profile: UserProfile) => void;
}

function sanitizeHandle(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return cleaned.length >= 2 ? cleaned : `uye_${Math.floor(1000 + Math.random() * 9000)}`;
}

export function AuthProfileModal({
  isOpen,
  onClose,
  firebaseUser,
  profile,
  isSuperOwner,
  isAdmin,
  onProfileSaved,
}: AuthProfileModalProps) {
  const [displayName, setDisplayName] = useState(
    profile?.displayName || firebaseUser?.displayName?.slice(0, 50) || ''
  );
  const [handle, setHandle] = useState(
    profile?.handle ||
      sanitizeHandle(firebaseUser?.email?.split('@')[0] || firebaseUser?.displayName || '')
  );
  const [nativeLang, setNativeLang] = useState(profile?.nativeLang || 'tr');
  const [bio, setBio] = useState(profile?.bio || '');
  const [isSaving, setIsSaving] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleGoogleSignIn = async () => {
    setErrorMsg(null);
    setIsSigningIn(true);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const u = result.user;
      if (!profile) {
        setDisplayName((u.displayName || 'Yeni Üye').slice(0, 50));
        setHandle(sanitizeHandle(u.email?.split('@')[0] || u.displayName || 'uye'));
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Hesap ile giriş yapılamadı.');
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser) return;
    setErrorMsg(null);

    const cleanName = displayName.trim().slice(0, 50);
    const cleanHandle = sanitizeHandle(handle.trim());
    const cleanBio = bio.trim().slice(0, 240);

    if (cleanName.length < 2) {
      setErrorMsg('Görünen ad en az 2 karakter olmalıdır.');
      return;
    }

    setIsSaving(true);
    const userPath = `users/${firebaseUser.uid}`;
    const privatePath = `users/${firebaseUser.uid}/private/info`;

    try {
      if (!profile) {
        const safeAvatar = isSafeHttpsUrl(firebaseUser.photoURL)
          ? (firebaseUser.photoURL || '').slice(0, 512)
          : '';
        const newProfile: UserProfile = {
          uid: firebaseUser.uid,
          displayName: cleanName,
          handle: cleanHandle,
          avatarUrl: safeAvatar,
          nativeLang,
          bio: cleanBio,
          status: 'active',
          followersCount: 0,
          followingCount: 0,
        };

        try {
          await setDoc(doc(db, 'users', firebaseUser.uid), {
            ...newProfile,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, userPath);
        }

        try {
          await setDoc(doc(db, 'users', firebaseUser.uid, 'private', 'info'), {
            uid: firebaseUser.uid,
            email: (firebaseUser.email || 'unknown@user.local').slice(0, 160),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, privatePath);
        }

        onProfileSaved(newProfile);
      } else {
        const nextAvatar = isSafeHttpsUrl(firebaseUser.photoURL)
          ? (firebaseUser.photoURL || '').slice(0, 512)
          : isSafeHttpsUrl(profile.avatarUrl)
            ? (profile.avatarUrl || '').slice(0, 512)
            : '';
        try {
          await updateDoc(doc(db, 'users', firebaseUser.uid), {
            displayName: cleanName,
            handle: cleanHandle,
            avatarUrl: nextAvatar,
            nativeLang,
            bio: cleanBio,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, userPath);
        }

        onProfileSaved({
          ...profile,
          displayName: cleanName,
          handle: cleanHandle,
          nativeLang,
          bio: cleanBio,
        });
      }
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Profil kaydedilemedi.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSignOut = async () => {
    await signOut(auth);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900 font-display">
              {firebaseUser
                ? profile
                  ? 'Hesap ve Dil Profili'
                  : 'Kaydını Tamamla'
                : 'OndaTalk Ağına Katıl'}
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              {firebaseUser
                ? 'Görüntülü eşleşme, canlı yayın ve otomatik çeviri için dil tercihlerini belirle.'
                : 'Dünyanın her yerinden insanlarla görüntülü sohbet et, canlı yayın aç ve anlık çeviriyle anlaş.'}
            </p>
          </div>
          {profile && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Kapat"
              className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {!firebaseUser ? (
          <div className="space-y-4">
            <button
              type="button"
              disabled={isSigningIn}
              onClick={() => void handleGoogleSignIn()}
              className="w-full h-11 px-4 bg-teal-600 text-white rounded-lg text-sm font-semibold hover:bg-teal-700 transition-colors inline-flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {isSigningIn ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <UserCheck className="w-4 h-4" />
              )}
              Hesap ile Giriş Yap / Kayıt Ol
            </button>
            <button
              type="button"
              onClick={onClose}
              className="w-full h-9 text-xs font-medium text-slate-500 hover:text-slate-800"
            >
              Şimdilik Misafir Olarak Devam Et
            </button>
          </div>
        ) : (
          <form onSubmit={(e) => void handleSaveProfile(e)} className="space-y-4">
            {(isSuperOwner || isAdmin) && (
              <div className="px-3.5 py-2.5 bg-teal-50 border border-teal-200 rounded-lg text-xs text-teal-900 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-teal-700 shrink-0" />
                <span>
                  {firebaseUser.email === OWNER_EMAIL
                    ? 'Platform Sahibi (Tam Süper Yönetici Yetkisi Aktif)'
                    : 'Yetkili Moderatör Hesabı'}
                </span>
              </div>
            )}

            <div>
              <label htmlFor="prof-name" className="block text-xs font-medium text-slate-600 mb-1">
                Görünen Adın
              </label>
              <input
                id="prof-name"
                type="text"
                required
                minLength={2}
                maxLength={50}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full h-10 px-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-600"
              />
            </div>

            <div>
              <label htmlFor="prof-handle" className="block text-xs font-medium text-slate-600 mb-1">
                Kullanıcı Adı (@handle)
              </label>
              <input
                id="prof-handle"
                type="text"
                required
                minLength={2}
                maxLength={32}
                value={handle}
                onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                className="w-full h-10 px-3 bg-slate-50 border border-slate-200 rounded-lg text-sm font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-600"
              />
            </div>

            <div>
              <label htmlFor="prof-lang" className="block text-xs font-medium text-slate-600 mb-1">
                Ana Konuşma ve Çeviri Dilin
              </label>
              <select
                id="prof-lang"
                value={nativeLang}
                onChange={(e) => setNativeLang(e.target.value)}
                className="w-full h-10 px-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-600"
              >
                {WORLD_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.nameTr} ({l.nativeName})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="prof-bio" className="block text-xs font-medium text-slate-600 mb-1">
                Kısa Biyografi
              </label>
              <textarea
                id="prof-bio"
                rows={2}
                maxLength={240}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Örn: İstanbul'dan merhaba, teknoloji ve kültür sohbetleri..."
                className="w-full p-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-600"
              />
            </div>

            <div className="flex items-center justify-between gap-3 pt-2">
              <button
                type="button"
                onClick={() => void handleSignOut()}
                className="h-10 px-3.5 border border-slate-200 text-slate-600 hover:text-rose-700 hover:border-rose-200 rounded-lg text-xs font-medium inline-flex items-center gap-1.5"
              >
                <LogOut className="w-3.5 h-3.5" />
                Çıkış Yap
              </button>

              <button
                type="submit"
                disabled={isSaving}
                className="h-10 px-5 bg-teal-600 text-white rounded-lg text-sm font-semibold hover:bg-teal-700 inline-flex items-center gap-2 disabled:opacity-50"
              >
                {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                {profile ? 'Profili Güncelle' : 'Ağa Katıl'}
              </button>
            </div>
          </form>
        )}

        {errorMsg && (
          <div className="px-3.5 py-2.5 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800">
            {errorMsg}
          </div>
        )}
      </div>
    </div>
  );
}
