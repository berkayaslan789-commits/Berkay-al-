export type WorkspaceTab = 'discover' | 'omegle' | 'translator' | 'monetize' | 'admin';
export type TranslatorSubTab = 'live' | 'commands' | 'room';

export interface TranscriptTurn {
  id: string;
  speaker: 'self' | 'partner';
  speakerLabel: string;
  sourceLang: string;
  targetLang: string;
  originalText: string;
  translatedText: string;
  timestamp: string;
  audioBase64?: string;
}

export interface AgreementItem {
  id: string;
  original: string;
  translated: string;
  owner: string;
  confirmed: boolean;
  timestamp: string;
}

export interface AgreementSummary {
  title: string;
  summaryA: string;
  summaryB: string;
  agreements: {
    original: string;
    translated: string;
    owner: string;
  }[];
}

export interface RoomParticipant {
  id: string;
  name: string;
  langCode: string;
  langName: string;
  isSpeaking?: boolean;
}

export interface RoomMessage {
  id: string;
  senderId: string;
  senderName: string;
  sourceLang: string;
  originalText: string;
  translations: Record<string, string>;
  timestamp: string;
}

export interface VoiceCommandResult {
  action:
    | 'switch_target_lang'
    | 'switch_source_lang'
    | 'swap_languages'
    | 'speak_last'
    | 'summarize'
    | 'clear_notes'
    | 'add_agreement'
    | 'copy_room'
    | 'none';
  targetLangCode?: string;
  cleanText: string;
  translatedText: string;
  agreementText?: string;
  feedback: string;
}

export interface UserProfile {
  uid: string;
  displayName: string;
  handle: string;
  avatarUrl?: string;
  nativeLang: string;
  bio?: string;
  status: 'active' | 'muted' | 'banned';
  followersCount: number;
  followingCount: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface AdminRecord {
  uid: string;
  email: string;
  role: 'super_admin' | 'moderator';
  grantedBy: string;
  createdAt?: unknown;
}

export interface PlatformSettings {
  announcement: string;
  maintenanceMode: boolean;
  autoTranslateVoice: boolean;
  allowRandomMatch: boolean;
  updatedBy: string;
  updatedAt?: unknown;
}

export interface LiveStream {
  id: string;
  hostUid: string;
  hostName: string;
  hostHandle: string;
  hostLang: string;
  title: string;
  topic: string;
  roomCode: string;
  isLive: boolean;
  featured: boolean;
  likesCount: number;
  viewerCount: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface StreamComment {
  id: string;
  streamId: string;
  authorUid: string;
  authorName: string;
  sourceLang: string;
  originalText: string;
  translatedText: string;
  targetLang: string;
  createdAt?: unknown;
}

export interface ModerationReport {
  id: string;
  reporterUid: string;
  targetUid: string;
  targetName: string;
  reason: string;
  status: 'open' | 'resolved' | 'dismissed';
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface SubtitleCue {
  startSec: number;
  endSec: number;
  text: string;
  translations?: Record<string, string>;
}

export interface VideoPost {
  id: string;
  authorUid: string;
  authorName: string;
  authorHandle: string;
  sourceLang: string;
  title: string;
  topic: string;
  videoUrl: string;
  mimeType: string;
  transcriptOriginal: string;
  cues: SubtitleCue[];
  translations: Record<string, string>;
  likesCount: number;
  viewsCount: number;
  isPublished: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface AdPolicy {
  isAcceptingAds: boolean;
  currency: 'TRY' | 'USD' | 'EUR';
  dailyRateBanner: number;
  dailyRateVideoCard: number;
  minDurationDays: number;
  prohibitedContent: string;
  termsText: string;
  paymentInstructions: string;
  updatedBy: string;
  updatedAt?: unknown;
}

export type AdPlacement = 'banner_top' | 'feed_card' | 'video_sponsor';

export interface AdCampaign {
  id: string;
  advertiserUid: string;
  brandName: string;
  headline: string;
  description: string;
  targetUrl: string;
  imageUrl?: string;
  placement: AdPlacement;
  durationDays: number;
  totalPrice: number;
  currency: 'TRY' | 'USD' | 'EUR';
  termsAccepted: boolean;
  status: 'pending' | 'approved' | 'paused' | 'rejected';
  impressions: number;
  clicks: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface AdCampaignBilling {
  adId: string;
  advertiserUid: string;
  contactEmail: string;
  paymentNote?: string;
  createdAt?: unknown;
}
