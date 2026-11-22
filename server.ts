import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  GoogleGenAI,
  Modality,
  ThinkingLevel,
  Type,
  type LiveServerMessage,
  type Session,
} from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const SUPER_OWNER_EMAIL = 'berkayaslan789@gmail.com';

let firebaseServerConfig: {
  projectId?: string;
  apiKey?: string;
  firestoreDatabaseId?: string;
} = {};
try {
  const fbPath = path.resolve(__dirname, 'firebase-applet-config.json');
  if (fs.existsSync(fbPath)) {
    firebaseServerConfig = JSON.parse(fs.readFileSync(fbPath, 'utf8'));
  }
} catch {
  // fallback to empty config if unavailable
}

async function verifyFirebaseUserToken(
  idToken: unknown
): Promise<{ uid: string; email?: string } | null> {
  if (typeof idToken !== 'string' || idToken.length < 20 || idToken.length > 8192) {
    return null;
  }
  const apiKey = firebaseServerConfig.apiKey;
  if (!apiKey) return null;
  try {
    const lookupResp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );
    if (!lookupResp.ok) return null;
    const lookupData = (await lookupResp.json()) as {
      users?: { localId?: string; email?: string; emailVerified?: boolean }[];
    };
    const account = lookupData.users?.[0];
    if (!account?.localId || account.emailVerified !== true) return null;
    return { uid: account.localId, email: account.email };
  } catch {
    return null;
  }
}

async function verifyFirebaseAdminToken(idToken: unknown): Promise<boolean> {
  const account = await verifyFirebaseUserToken(idToken);
  if (!account) return false;
  if (account.email === SUPER_OWNER_EMAIL) {
    return true;
  }
  const projectId = firebaseServerConfig.projectId;
  const dbId = firebaseServerConfig.firestoreDatabaseId || '(default)';
  if (!projectId || typeof idToken !== 'string') return false;
  try {
    const adminResp = await fetch(
      `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(dbId)}/documents/admins/${encodeURIComponent(account.uid)}`,
      {
        headers: { Authorization: `Bearer ${idToken}` },
      }
    );
    return adminResp.ok;
  } catch {
    return false;
  }
}

const UPLOAD_DIR = path.resolve(__dirname, 'uploads', 'videos');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function detectVideoExtension(buf: Buffer, declaredMime: string): 'mp4' | 'webm' | 'mov' | null {
  if (buf.length < 12) return null;
  // WebM / Matroska EBML header: 0x1A 0x45 0xDF 0xA3
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return 'webm';
  }
  // ISO Base Media (MP4 / MOV): "ftyp" at offset 4..7
  const boxType = buf.subarray(4, 8).toString('ascii');
  if (boxType === 'ftyp') {
    if (declaredMime === 'video/quicktime') return 'mov';
    return 'mp4';
  }
  return null;
}

// --- Platform Self-Protection & Security Shield ---
const ALLOWED_VOICES = new Set(['Zephyr', 'Kore', 'Puck', 'Charon', 'Fenrir']);
const ALLOWED_AUDIO_MIMES = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/wav',
  'audio/mp4',
  'audio/mpeg',
  'audio/pcm',
]);

const MALICIOUS_PATTERNS: RegExp[] = [
  /<\s*script\b/i,
  /<\s*iframe\b/i,
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /data\s*:\s*text\/html/i,
  /\bon(?:error|load|click|mouseover|focus)\s*=/i,
  /\bpowershell(?:\.exe)?\s+-(?:e|enc|encodedcommand)\b/i,
  /\bcmd(?:\.exe)?\s+\/c\b/i,
  /\b(?:curl|wget)\b[^|\n]*\|\s*(?:ba)?sh\b/i,
  /https?:\/\/[^\s"'<>]+\.(?:exe|bat|scr|vbs|ps1|msi|dll)(?:[?#\s]|$)/i,
];

const defenseStats = {
  startedAt: new Date().toISOString(),
  blockedMaliciousPayloads: 0,
  rateLimitedRequests: 0,
  floodDisconnects: 0,
  sanitizedControlChars: 0,
};

function sanitizeTextGuard(
  raw: unknown,
  maxLen = 2000
): { ok: true; text: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string') return { ok: true, text: '' };
  const stripped = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (stripped.length !== raw.length) {
    defenseStats.sanitizedControlChars += 1;
  }
  const trimmed = stripped.trim().slice(0, maxLen);
  for (const pattern of MALICIOUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      defenseStats.blockedMaliciousPayloads += 1;
      return {
        ok: false,
        reason: 'Güvenlik kalkanı: Kötücül kod veya zararlı bağlantı tespit edildi ve engellendi.',
      };
    }
  }
  return { ok: true, text: trimmed };
}

function safeVoiceName(v: unknown): string {
  return typeof v === 'string' && ALLOWED_VOICES.has(v) ? v : 'Zephyr';
}

function safeAudioMime(m: unknown): string {
  if (typeof m !== 'string') return 'audio/webm';
  const base = m.split(';')[0].trim().toLowerCase();
  return ALLOWED_AUDIO_MIMES.has(base) ? base : 'audio/webm';
}

function isValidSdp(sdp: unknown): boolean {
  if (!sdp || typeof sdp !== 'object') return false;
  const obj = sdp as { type?: unknown; sdp?: unknown };
  return (
    (obj.type === 'offer' || obj.type === 'answer') &&
    typeof obj.sdp === 'string' &&
    obj.sdp.length > 0 &&
    obj.sdp.length <= 65536
  );
}

function isValidIceCandidate(cand: unknown): boolean {
  if (!cand || typeof cand !== 'object') return false;
  const obj = cand as { candidate?: unknown };
  return typeof obj.candidate === 'string' && obj.candidate.length <= 4096;
}

function getClientIp(req: http.IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

const apiRateBuckets = new Map<string, { count: number; resetAt: number }>();
const wsIpConnectionCounts = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of apiRateBuckets.entries()) {
    if (bucket.resetAt <= now) {
      apiRateBuckets.delete(ip);
    }
  }
}, 60_000).unref();

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY yapılandırılmamış. Settings > Secrets panelinden API anahtarınızı kontrol edin.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function formatGeminiError(err: unknown): { status: number; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes('API_KEY_INVALID') || raw.includes('PERMISSION_DENIED') || raw.includes('403')) {
    return {
      status: 403,
      message: 'API anahtarı geçersiz veya eksik. Lütfen Settings > Secrets panelini kontrol edin.',
    };
  }
  if (raw.includes('RESOURCE_EXHAUSTED') || raw.includes('429')) {
    return {
      status: 429,
      message: 'Kota sınırı aşıldı. Lütfen biraz bekleyin veya ücretli API anahtarı seçin.',
    };
  }
  if (raw.includes('GEMINI_API_KEY')) {
    return { status: 500, message: raw };
  }
  return { status: 500, message: raw || 'Beklenmeyen bir sunucu hatası oluştu.' };
}

interface RoomParticipantState {
  id: string;
  name: string;
  langCode: string;
  langName: string;
  isSpeaking: boolean;
  ws: WebSocket;
}

interface RoomMessageState {
  id: string;
  senderId: string;
  senderName: string;
  sourceLang: string;
  originalText: string;
  translations: Record<string, string>;
  timestamp: string;
}

interface RoomAgreementState {
  id: string;
  original: string;
  translated: string;
  owner: string;
  confirmed: boolean;
  timestamp: string;
}

interface RoomState {
  id: string;
  participants: Map<string, RoomParticipantState>;
  messages: RoomMessageState[];
  agreements: RoomAgreementState[];
}

const rooms = new Map<string, RoomState>();

function getOrCreateRoom(roomId: string): RoomState {
  const cleanId = roomId.trim().toUpperCase().slice(0, 24) || 'DUNYA-1';
  let room = rooms.get(cleanId);
  if (!room) {
    room = {
      id: cleanId,
      participants: new Map(),
      messages: [],
      agreements: [],
    };
    rooms.set(cleanId, room);
  }
  return room;
}

function serializeParticipants(room: RoomState) {
  return Array.from(room.participants.values()).map((p) => ({
    id: p.id,
    name: p.name,
    langCode: p.langCode,
    langName: p.langName,
    isSpeaking: p.isSpeaking,
  }));
}

function broadcastToRoom(room: RoomState, payload: unknown) {
  const encoded = JSON.stringify(payload);
  for (const participant of room.participants.values()) {
    if (participant.ws.readyState === WebSocket.OPEN) {
      participant.ws.send(encoded);
    }
  }
}

async function translateToMultipleLanguages(
  text: string,
  sourceLang: string,
  targetLangs: { code: string; name: string }[]
): Promise<Record<string, string>> {
  const result: Record<string, string> = { [sourceLang]: text };
  const needed = targetLangs.filter((t) => t.code !== sourceLang);
  if (needed.length === 0) return result;

  const ai = getAiClient();
  const langList = needed.map((l) => `${l.code} (${l.name})`).join(', ');

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: `Translate the following message naturally and conversationally into these target languages: ${langList}.\n\nSource language: ${sourceLang}\nMessage: "${text}"`,
    config: {
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          translations: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                langCode: { type: Type.STRING },
                text: { type: Type.STRING },
              },
              required: ['langCode', 'text'],
            },
          },
        },
        required: ['translations'],
      },
    },
  });

  const parsed = JSON.parse((response.text ?? '{}').trim()) as {
    translations?: { langCode: string; text: string }[];
  };
  for (const item of parsed.translations ?? []) {
    result[item.langCode] = item.text;
  }
  return result;
}

// --- Video Social: Random Matchmaking + Live Broadcast WebRTC Signaling ---
interface VideoPeer {
  peerId: string;
  uid: string;
  displayName: string;
  handle: string;
  langCode: string;
  langName: string;
  filterLang: string;
  ws: WebSocket;
  partnerPeerId: string | null;
  matchSessionId: string | null;
  streamId: string | null;
  isHost: boolean;
  mediaMode: 'video' | 'text';
}

const videoPeers = new Map<string, VideoPeer>();
const matchQueue: string[] = [];
const streamRooms = new Map<string, Set<string>>();

function sendPeer(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastQueueStats() {
  const waitingCount = matchQueue.length;
  const onlineCount = videoPeers.size;
  for (const peer of videoPeers.values()) {
    sendPeer(peer.ws, {
      type: 'match:queue_status',
      waitingCount,
      onlineCount,
    });
  }
}

function removeFromQueue(peerId: string) {
  const idx = matchQueue.indexOf(peerId);
  if (idx >= 0) {
    matchQueue.splice(idx, 1);
  }
}

function disconnectMatchPair(peer: VideoPeer) {
  if (peer.partnerPeerId) {
    const partner = videoPeers.get(peer.partnerPeerId);
    if (partner) {
      partner.partnerPeerId = null;
      partner.matchSessionId = null;
      sendPeer(partner.ws, { type: 'match:partner_left' });
    }
    peer.partnerPeerId = null;
    peer.matchSessionId = null;
  }
}

function tryPairFromQueue(seekerId: string) {
  const seeker = videoPeers.get(seekerId);
  if (!seeker) return;

  for (let i = 0; i < matchQueue.length; i++) {
    const candidateId = matchQueue[i];
    if (candidateId === seekerId) continue;
    const candidate = videoPeers.get(candidateId);
    if (!candidate) {
      matchQueue.splice(i, 1);
      i--;
      continue;
    }

    const seekerAllows =
      seeker.filterLang === 'all' || seeker.filterLang === candidate.langCode;
    const candidateAllows =
      candidate.filterLang === 'all' || candidate.filterLang === seeker.langCode;

    if (seekerAllows && candidateAllows) {
      removeFromQueue(seekerId);
      removeFromQueue(candidateId);

      const sessionId = `match_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      seeker.partnerPeerId = candidate.peerId;
      seeker.matchSessionId = sessionId;
      candidate.partnerPeerId = seeker.peerId;
      candidate.matchSessionId = sessionId;

      sendPeer(seeker.ws, {
        type: 'match:found',
        sessionId,
        initiator: true,
        partner: {
          peerId: candidate.peerId,
          uid: candidate.uid,
          displayName: candidate.displayName,
          handle: candidate.handle,
          langCode: candidate.langCode,
          langName: candidate.langName,
          mediaMode: candidate.mediaMode,
        },
      });

      sendPeer(candidate.ws, {
        type: 'match:found',
        sessionId,
        initiator: false,
        partner: {
          peerId: seeker.peerId,
          uid: seeker.uid,
          displayName: seeker.displayName,
          handle: seeker.handle,
          langCode: seeker.langCode,
          langName: seeker.langName,
          mediaMode: seeker.mediaMode,
        },
      });

      broadcastQueueStats();
      return;
    }
  }
}

function broadcastStreamPresence(streamId: string) {
  const members = streamRooms.get(streamId);
  if (!members) return;

  const participantList = Array.from(members)
    .map((pid) => videoPeers.get(pid))
    .filter((p): p is VideoPeer => Boolean(p))
    .map((p) => ({
      peerId: p.peerId,
      uid: p.uid,
      displayName: p.displayName,
      handle: p.handle,
      langCode: p.langCode,
      langName: p.langName,
      isHost: p.isHost,
    }));

  for (const pid of members) {
    const peer = videoPeers.get(pid);
    if (peer) {
      sendPeer(peer.ws, {
        type: 'stream:presence',
        streamId,
        viewerCount: participantList.length,
        participants: participantList,
      });
    }
  }
}

function leaveStreamRoom(peer: VideoPeer) {
  if (!peer.streamId) return;
  const sid = peer.streamId;
  const members = streamRooms.get(sid);
  if (members) {
    members.delete(peer.peerId);
    for (const otherPid of members) {
      const other = videoPeers.get(otherPid);
      if (other) {
        sendPeer(other.ws, {
          type: 'stream:peer_left',
          streamId: sid,
          peerId: peer.peerId,
          isHost: peer.isHost,
        });
      }
    }
    if (members.size === 0) {
      streamRooms.delete(sid);
    } else {
      broadcastStreamPresence(sid);
    }
  }
  peer.streamId = null;
  peer.isHost = false;
}

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Strict security headers protecting against MIME sniffing, XSS, and unsafe plugins
  app.use((_req: Request, res: Response, next: NextFunction) => {
    const isProd = process.env.NODE_ENV === 'production';
    const scriptSrc = isProd
      ? "'self' https://apis.google.com https://*.firebaseapp.com"
      : "'self' 'unsafe-inline' 'unsafe-eval' https://apis.google.com https://*.firebaseapp.com";
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader(
      'Permissions-Policy',
      'geolocation=(), payment=(), usb=(), serial=(), hid=(), camera=(self), microphone=(self)'
    );
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        `script-src ${scriptSrc}`,
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: blob: https:",
        "media-src 'self' data: blob: https:",
        "worker-src 'self' blob:",
        "connect-src 'self' ws: wss: https://*.googleapis.com https://*.firebaseio.com https://*.firebaseapp.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com",
        "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; ')
    );
    next();
  });

  // Serve uploaded community videos with HTTP Range support & strict nosniff header
  app.use(
    '/uploads/videos',
    express.static(UPLOAD_DIR, {
      setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'public, max-age=86400');
      },
    })
  );

  // Raw binary video upload endpoint (before express.json)
  app.post(
    '/api/videos/upload-binary',
    express.raw({
      type: ['video/mp4', 'video/webm', 'video/quicktime', 'application/octet-stream'],
      limit: '16mb',
    }),
    async (req, res) => {
      try {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
        const verified = await verifyFirebaseUserToken(token);
        if (!verified) {
          res.status(401).json({ error: 'Video yüklemek için hesabınızla giriş yapmalısınız.' });
          return;
        }

        if (!Buffer.isBuffer(req.body) || req.body.length < 128) {
          res.status(400).json({ error: 'Geçersiz veya boş video dosyası.' });
          return;
        }

        const declaredMime = String(req.headers['x-video-mime'] || req.headers['content-type'] || '')
          .split(';')[0]
          .trim()
          .toLowerCase();
        const ext = detectVideoExtension(req.body, declaredMime);
        if (!ext) {
          defenseStats.blockedMaliciousPayloads += 1;
          res.status(400).json({
            error: 'Güvenlik kalkanı: Yalnızca gerçek MP4, WebM veya MOV video dosyaları kabul edilir.',
          });
          return;
        }

        // Keep disk footprint bounded on free-tier hosting (max 40 local cached files)
        const existingFiles = fs
          .readdirSync(UPLOAD_DIR)
          .map((name) => {
            const full = path.resolve(UPLOAD_DIR, name);
            return { name, full, mtime: fs.statSync(full).mtimeMs };
          })
          .sort((a, b) => a.mtime - b.mtime);
        while (existingFiles.length >= 40) {
          const oldest = existingFiles.shift();
          if (oldest && oldest.full.startsWith(UPLOAD_DIR + path.sep)) {
            fs.unlinkSync(oldest.full);
          }
        }

        const videoId = `vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const fileName = `${videoId}.${ext}`;
        const targetPath = path.resolve(UPLOAD_DIR, fileName);
        if (!targetPath.startsWith(UPLOAD_DIR + path.sep)) {
          res.status(400).json({ error: 'Geçersiz dosya yolu.' });
          return;
        }

        fs.writeFileSync(targetPath, req.body);
        const mimeMap = {
          mp4: 'video/mp4',
          webm: 'video/webm',
          mov: 'video/quicktime',
        };
        res.json({
          ok: true,
          videoId,
          videoUrl: `/uploads/videos/${fileName}`,
          mimeType: mimeMap[ext],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Video yüklenemedi.';
        res.status(500).json({ error: msg });
      }
    }
  );

  app.use(express.json({ limit: '10mb' }));

  // Per-IP sliding-window rate limiter on /api/*
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/health' || req.path === '/security-status') {
      next();
      return;
    }
    const ip = getClientIp(req);
    const now = Date.now();
    let bucket = apiRateBuckets.get(ip);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + 60_000 };
      apiRateBuckets.set(ip, bucket);
    }
    bucket.count += 1;
    if (bucket.count > 45) {
      defenseStats.rateLimitedRequests += 1;
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      res.status(429).json({
        error: 'Güvenlik kalkanı: Çok fazla istek algılandı. Lütfen birkaç saniye bekleyin.',
      });
      return;
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, onlinePeers: videoPeers.size, queueSize: matchQueue.length });
  });

  app.get('/api/security-status', (_req, res) => {
    let activeWsConnections = 0;
    for (const c of wsIpConnectionCounts.values()) activeWsConnections += c;
    res.json({
      protected: true,
      startedAt: defenseStats.startedAt,
      blockedMaliciousPayloads: defenseStats.blockedMaliciousPayloads,
      rateLimitedRequests: defenseStats.rateLimitedRequests,
      floodDisconnects: defenseStats.floodDisconnects,
      sanitizedControlChars: defenseStats.sanitizedControlChars,
      activeWsConnections,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  app.post('/api/translate-and-speak', async (req, res) => {
    try {
      const {
        text,
        audioBase64,
        mimeType,
        sourceLang = 'tr',
        targetLang = 'en',
        sourceLangName = 'Türkçe',
        targetLangName = 'İngilizce',
        voiceName = 'Zephyr',
        speak = true,
      } = req.body as {
        text?: string;
        audioBase64?: string;
        mimeType?: string;
        sourceLang?: string;
        targetLang?: string;
        sourceLangName?: string;
        targetLangName?: string;
        voiceName?: string;
        speak?: boolean;
      };

      const ai = getAiClient();
      const textCheck = sanitizeTextGuard(text, 2000);
      if (!textCheck.ok) {
        res.status(400).json({ error: textCheck.reason });
        return;
      }
      let originalText = textCheck.text;
      const safeVoice = safeVoiceName(voiceName);
      const safeMime = safeAudioMime(mimeType);

      if (!originalText && audioBase64) {
        if (typeof audioBase64 !== 'string' || audioBase64.length > 8_000_000) {
          res.status(400).json({ error: 'Ses verisi boyut sınırını aşıyor.' });
          return;
        }
        const transcribeResp = await ai.models.generateContent({
          model: 'gemini-3.5-transcribe',
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: safeMime,
                  data: audioBase64,
                },
              },
              {
                text:
                  sourceLang === 'auto'
                    ? 'Transcribe the spoken audio accurately in its original language. Return only the spoken transcript.'
                    : `Transcribe this ${sourceLangName} (${sourceLang}) speech accurately. Return only the spoken transcript without commentary.`,
              },
            ],
          },
        });
        originalText = (transcribeResp.text ?? '').trim();
      }

      if (!originalText) {
        res.status(400).json({ error: 'Çevrilecek konuşma veya metin algılanamadı.' });
        return;
      }

      const translationPromptInput = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Utterance: "${originalText}"\nSource: ${sourceLang === 'auto' ? 'Detect automatically' : `${sourceLangName} (${sourceLang})`}\nTarget: ${targetLangName} (${targetLang})`,
        config: {
          systemInstruction:
            'You are a real-time professional voice interpreter. Translate the utterance into the target language naturally. Return JSON only.',
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              detectedLanguage: { type: Type.STRING },
              originalText: { type: Type.STRING },
              translatedText: { type: Type.STRING },
            },
            required: ['detectedLanguage', 'originalText', 'translatedText'],
          },
        },
      });
      const parsed = JSON.parse((translationPromptInput.text ?? '{}').trim()) as {
        detectedLanguage?: string;
        originalText?: string;
        translatedText?: string;
      };

      const finalOriginal = parsed.originalText?.trim() || originalText;
      const finalTranslated = parsed.translatedText?.trim() || originalText;
      let ttsAudioBase64: string | undefined;

      if (speak && finalTranslated) {
        const ttsResp = await ai.models.generateContent({
          model: 'gemini-3.8-flash-lite-tts',
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: finalTranslated,
                  speechMetadata: {
                    style: `Natural, clear native ${targetLangName} speaker`,
                  },
                },
              ],
            },
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: safeVoice },
              },
            },
          },
        });
        ttsAudioBase64 = ttsResp.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      }

      res.json({
        detectedLanguage: parsed.detectedLanguage || sourceLang,
        originalText: finalOriginal,
        translatedText: finalTranslated,
        audioBase64: ttsAudioBase64,
      });
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  app.post('/api/tts', async (req, res) => {
    try {
      const { text, voiceName = 'Zephyr', langName = '' } = req.body as {
        text?: string;
        voiceName?: string;
        langName?: string;
      };
      const ttsCheck = sanitizeTextGuard(text, 2000);
      if (!ttsCheck.ok) {
        res.status(400).json({ error: ttsCheck.reason });
        return;
      }
      if (!ttsCheck.text) {
        res.status(400).json({ error: 'Seslendirilecek metin boş.' });
        return;
      }
      const safeVoice = safeVoiceName(voiceName);
      const ai = getAiClient();
      const ttsResp = await ai.models.generateContent({
        model: 'gemini-3.8-flash-lite-tts',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: ttsCheck.text,
                speechMetadata: {
                  style: langName
                    ? `Natural, expressive native ${langName} speaker`
                    : 'Clear, warm conversational speaker',
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: safeVoice },
            },
          },
        },
      });

      const audioBase64 = ttsResp.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!audioBase64) {
        res.status(502).json({ error: 'Ses çıktısı oluşturulamadı.' });
        return;
      }
      res.json({ audioBase64 });
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  app.post('/api/transcribe-audio', async (req, res) => {
    try {
      const { audioBase64, mimeType = 'audio/webm', langName } = req.body as {
        audioBase64?: string;
        mimeType?: string;
        langName?: string;
      };
      if (
        typeof audioBase64 !== 'string' ||
        audioBase64.length === 0 ||
        audioBase64.length > 8_000_000
      ) {
        res.status(400).json({ error: 'Ses verisi eksik veya izin verilen boyutu aşıyor.' });
        return;
      }
      const cleanLang = sanitizeTextGuard(langName, 40);
      if (!cleanLang.ok) {
        res.status(400).json({ error: cleanLang.reason });
        return;
      }
      const safeMime = safeAudioMime(mimeType);
      const ai = getAiClient();
      const resp = await ai.models.generateContent({
        model: 'gemini-3.5-transcribe',
        contents: {
          parts: [
            { inlineData: { mimeType: safeMime, data: audioBase64 } },
            {
              text: cleanLang.text
                ? `Transcribe this ${cleanLang.text} speech accurately. Return only the transcribed text.`
                : 'Transcribe this speech accurately in its original language. Return only the transcribed text.',
            },
          ],
        },
      });
      res.json({ transcript: (resp.text ?? '').trim() });
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  app.post('/api/command', async (req, res) => {
    try {
      const {
        transcript,
        currentSourceLang = 'tr',
        currentTargetLang = 'en',
        currentTargetLangName = 'İngilizce',
        availableLanguages = [],
      } = req.body as {
        transcript?: string;
        currentSourceLang?: string;
        currentTargetLang?: string;
        currentTargetLangName?: string;
        availableLanguages?: { code: string; nameTr: string; nativeName: string }[];
      };

      const cmdCheck = sanitizeTextGuard(transcript, 1500);
      if (!cmdCheck.ok) {
        res.status(400).json({ error: cmdCheck.reason });
        return;
      }
      if (!cmdCheck.text) {
        res.status(400).json({ error: 'Komut veya metin boş.' });
        return;
      }

      const ai = getAiClient();
      const langSummary = availableLanguages
        .map((l) => `${l.code}:${l.nameTr}/${l.nativeName}`)
        .join(', ');

      const resp = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Analyze this spoken user input: "${cmdCheck.text}"\nCurrent source lang: ${currentSourceLang}\nCurrent target lang: ${currentTargetLang} (${currentTargetLangName})\nAvailable languages: ${langSummary}`,
        config: {
          systemInstruction: `You are a voice command & bilingual dictation router for a Turkish/global voice translator app.
Determine whether the user gave an explicit interface voice command OR normal dictation/conversation text:
- switch_target_lang: e.g. "İspanyolcaya çevir", "dili Japonca yap", "translate to French", "Almanca olsun". Set targetLangCode to the matching ISO code.
- switch_source_lang: e.g. "Benim dilim İngilizce olsun", "my language is German". Set targetLangCode to the matching ISO code.
- swap_languages: e.g. "Dilleri değiştir", "Karşı taraf konuşsun", "swap languages".
- speak_last: e.g. "Son cümleyi tekrar oku", "Tekrar seslendir", "repeat last".
- summarize: e.g. "Konuşmayı özetle", "Anlaşmayı özetle", "Karşılıklı anlaşma çıkar", "summarize".
- clear_notes: e.g. "Notları temizle", "Ekranı temizle", "clear".
- add_agreement: e.g. "Anlaşma maddesi ekle: ...", "Not ekle: ...", "Karara bağla: ...". Extract agreementText and translate it into ${currentTargetLangName}.
- copy_room: e.g. "Oda linkini kopyala", "Bağlantıyı kopyala".
- none: Normal spoken sentence/dictation to be written down and translated into ${currentTargetLangName}.

Always return cleanText (the spoken text with proper punctuation), translatedText (translation into ${currentTargetLangName}), and a concise Turkish feedback message.`,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              action: { type: Type.STRING },
              targetLangCode: { type: Type.STRING },
              cleanText: { type: Type.STRING },
              translatedText: { type: Type.STRING },
              agreementText: { type: Type.STRING },
              feedback: { type: Type.STRING },
            },
            required: ['action', 'cleanText', 'translatedText', 'feedback'],
          },
        },
      });

      const parsed = JSON.parse((resp.text ?? '{}').trim());
      res.json(parsed);
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  app.post('/api/summarize', async (req, res) => {
    try {
      const {
        messages = [],
        langAName = 'Türkçe',
        langBName = 'İngilizce',
      } = req.body as {
        messages?: { speakerLabel: string; originalText: string; translatedText: string }[];
        langAName?: string;
        langBName?: string;
      };

      if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ error: 'Özetlenecek konuşma kaydı henüz yok.' });
        return;
      }

      const safeLines: string[] = [];
      for (const m of messages.slice(0, 80)) {
        const sp = sanitizeTextGuard(m.speakerLabel, 50);
        const orig = sanitizeTextGuard(m.originalText, 1000);
        const tr = sanitizeTextGuard(m.translatedText, 1000);
        if (!sp.ok || !orig.ok || !tr.ok) {
          res.status(400).json({ error: 'Güvenlik kalkanı: Geçersiz içerik engellendi.' });
          return;
        }
        safeLines.push(`${sp.text}: ${orig.text} [${tr.text}]`);
      }

      const transcriptBlock = safeLines.join('\n');

      const ai = getAiClient();
      const resp = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Conversation transcript:\n${transcriptBlock}\n\nLanguage A: ${langAName}\nLanguage B: ${langBName}`,
        config: {
          systemInstruction: `Summarize this bilingual conversation and extract clear mutual agreement items ("Karşılıklı Anlaşma Maddeleri") so both parties have an unambiguous record. Provide summaryA in ${langAName}, summaryB in ${langBName}, and each agreement item in both ${langAName} (original) and ${langBName} (translated).`,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              summaryA: { type: Type.STRING },
              summaryB: { type: Type.STRING },
              agreements: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    original: { type: Type.STRING },
                    translated: { type: Type.STRING },
                    owner: { type: Type.STRING },
                  },
                  required: ['original', 'translated', 'owner'],
                },
              },
            },
            required: ['title', 'summaryA', 'summaryB', 'agreements'],
          },
        },
      });

      const parsed = JSON.parse((resp.text ?? '{}').trim());
      res.json(parsed);
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // --- Uploaded Video Speech Transcription & Multi-Language Subtitle Generation ---
  app.post('/api/videos/analyze-subtitles', async (req, res) => {
    try {
      const {
        videoId,
        manualTranscript = '',
        sourceLang = 'tr',
        sourceLangName = 'Türkçe',
      } = req.body as {
        videoId?: string;
        manualTranscript?: string;
        sourceLang?: string;
        sourceLangName?: string;
      };

      const manualCheck = sanitizeTextGuard(manualTranscript, 3000);
      if (!manualCheck.ok) {
        res.status(400).json({ error: manualCheck.reason });
        return;
      }

      const ai = getAiClient();
      const targetSummaryLangs = ['tr', 'en', 'es', 'de', 'fr', 'ar', 'ja', 'ru'];

      let parts: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }> = [];

      if (videoId && /^[a-zA-Z0-9_\-]+$/.test(videoId)) {
        const matched = (['mp4', 'webm', 'mov'] as const)
          .map((ext) => ({
            ext,
            filePath: path.resolve(UPLOAD_DIR, `${videoId}.${ext}`),
          }))
          .find(
            (candidate) =>
              candidate.filePath.startsWith(UPLOAD_DIR + path.sep) &&
              fs.existsSync(candidate.filePath)
          );

        if (matched) {
          const buf = fs.readFileSync(matched.filePath);
          const mimeMap = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
          if (buf.length <= 15 * 1024 * 1024) {
            parts.push({
              inlineData: {
                mimeType: mimeMap[matched.ext],
                data: buf.toString('base64'),
              },
            });
          }
        }
      }

      if (parts.length === 0 && !manualCheck.text) {
        res.status(400).json({
          error: 'Video dosyası bulunamadı veya ses metni boş. Lütfen konuşma notu ekleyin.',
        });
        return;
      }

      parts.push({
        text: manualCheck.text
          ? `Create clean timed subtitle cues (in seconds) and multi-language translations for this video narration (${sourceLangName}): "${manualCheck.text}". Target translation codes: ${targetSummaryLangs.join(', ')}.`
          : `Listen to the spoken dialogue in this video (primary language: ${sourceLangName} / ${sourceLang}). Transcribe all speech accurately into timed subtitle cues (startSec, endSec, text in original language), combine into transcriptOriginal, and translate the full transcript naturally into each language code: ${targetSummaryLangs.join(', ')}.`,
      });

      const resp = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: { parts },
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              transcriptOriginal: { type: Type.STRING },
              cues: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    startSec: { type: Type.NUMBER },
                    endSec: { type: Type.NUMBER },
                    text: { type: Type.STRING },
                  },
                  required: ['startSec', 'endSec', 'text'],
                },
              },
              translations: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    langCode: { type: Type.STRING },
                    text: { type: Type.STRING },
                  },
                  required: ['langCode', 'text'],
                },
              },
            },
            required: ['transcriptOriginal', 'cues', 'translations'],
          },
        },
      });

      const parsed = JSON.parse((resp.text ?? '{}').trim()) as {
        transcriptOriginal?: string;
        cues?: { startSec: number; endSec: number; text: string }[];
        translations?: { langCode: string; text: string }[];
      };

      const translationsMap: Record<string, string> = {};
      for (const t of parsed.translations ?? []) {
        if (t.langCode && t.text) {
          translationsMap[t.langCode] = t.text.slice(0, 3000);
        }
      }
      if (parsed.transcriptOriginal) {
        translationsMap[sourceLang] = parsed.transcriptOriginal.slice(0, 3000);
      }

      res.json({
        transcriptOriginal: (parsed.transcriptOriginal || manualCheck.text).slice(0, 3000),
        cues: (parsed.cues ?? []).slice(0, 35),
        translations: translationsMap,
      });
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // --- On-Demand Viewer Subtitle Cue Translation (Accessible to All Visitors) ---
  app.post('/api/videos/translate-cues', async (req, res) => {
    try {
      const {
        cues = [],
        transcriptOriginal = '',
        sourceLang = 'tr',
        targetLang = 'en',
        targetLangName = 'İngilizce',
      } = req.body as {
        cues?: { startSec: number; endSec: number; text: string }[];
        transcriptOriginal?: string;
        sourceLang?: string;
        targetLang?: string;
        targetLangName?: string;
      };

      const trCheck = sanitizeTextGuard(transcriptOriginal, 3000);
      if (!trCheck.ok) {
        res.status(400).json({ error: trCheck.reason });
        return;
      }

      const safeCues = (Array.isArray(cues) ? cues : []).slice(0, 35).map((c) => ({
        startSec: Number(c.startSec) || 0,
        endSec: Number(c.endSec) || 0,
        text: typeof c.text === 'string' ? c.text.slice(0, 300) : '',
      }));

      const ai = getAiClient();
      const resp = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Source language: ${sourceLang}\nTarget language: ${targetLangName} (${targetLang})\nFull transcript: "${trCheck.text}"\nCues JSON: ${JSON.stringify(safeCues)}`,
        config: {
          systemInstruction: `Translate the full transcript and every cue's text faithfully into ${targetLangName} (${targetLang}), keeping startSec and endSec identical.`,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              translatedTranscript: { type: Type.STRING },
              translatedCues: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    startSec: { type: Type.NUMBER },
                    endSec: { type: Type.NUMBER },
                    text: { type: Type.STRING },
                  },
                  required: ['startSec', 'endSec', 'text'],
                },
              },
            },
            required: ['translatedTranscript', 'translatedCues'],
          },
        },
      });

      const parsed = JSON.parse((resp.text ?? '{}').trim()) as {
        translatedTranscript?: string;
        translatedCues?: { startSec: number; endSec: number; text: string }[];
      };
      res.json({
        translatedTranscript: parsed.translatedTranscript || trCheck.text,
        translatedCues: parsed.translatedCues ?? safeCues,
      });
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  app.get('/robots.txt', (req, res) => {
    const base = `${req.protocol}://${requestHost(req)}`;
    res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
  });

  app.get('/sitemap.xml', (req, res) => {
    const base = `${req.protocol}://${requestHost(req)}`;
    res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${base}/</loc>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>\n</urlset>\n`
    );
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const httpServer = http.createServer(app);
  const wssLiveTranslate = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  const wssLiveTranscribe = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  const wssRoom = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  const wssVideoSocial = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

  const attachSocketShield = (ws: WebSocket, ip: string): boolean => {
    const currentCount = wsIpConnectionCounts.get(ip) || 0;
    if (currentCount >= 15) {
      defenseStats.floodDisconnects += 1;
      ws.close(1008, 'Too many concurrent connections');
      return false;
    }
    wsIpConnectionCounts.set(ip, currentCount + 1);
    ws.once('close', () => {
      const next = (wsIpConnectionCounts.get(ip) || 1) - 1;
      if (next <= 0) wsIpConnectionCounts.delete(ip);
      else wsIpConnectionCounts.set(ip, next);
    });
    return true;
  };

  httpServer.on('upgrade', (request, socket, head) => {
    const reqUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    const ip = getClientIp(request);
    if (reqUrl.pathname === '/ws/live-translate') {
      wssLiveTranslate.handleUpgrade(request, socket, head, (ws) => {
        if (attachSocketShield(ws, ip)) wssLiveTranslate.emit('connection', ws, request);
      });
    } else if (reqUrl.pathname === '/ws/live-transcribe') {
      wssLiveTranscribe.handleUpgrade(request, socket, head, (ws) => {
        if (attachSocketShield(ws, ip)) wssLiveTranscribe.emit('connection', ws, request);
      });
    } else if (reqUrl.pathname === '/ws/room') {
      wssRoom.handleUpgrade(request, socket, head, (ws) => {
        if (attachSocketShield(ws, ip)) wssRoom.emit('connection', ws, request);
      });
    } else if (reqUrl.pathname === '/ws/video-social') {
      wssVideoSocial.handleUpgrade(request, socket, head, (ws) => {
        if (attachSocketShield(ws, ip)) wssVideoSocial.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // 1. Live Speech-to-Speech Translation WebSocket (gemini-3.5-live-translate-preview)
  wssLiveTranslate.on('connection', async (clientWs, req) => {
    const reqUrl = new URL(req.url || '/', `http://${requestHost(req)}`);
    let currentTargetLang = reqUrl.searchParams.get('targetLang') || 'en';
    let session: Session | null = null;
    let isClosing = false;

    const sendSafe = (payload: unknown) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    const connectLiveSession = async (targetLangCode: string) => {
      try {
        if (session) {
          try {
            session.close();
          } catch {
            // ignore
          }
          session = null;
        }
        const ai = getAiClient();
        const nextSession = await ai.live.connect({
          model: 'gemini-3.5-live-translate-preview',
          config: {
            responseModalities: [Modality.AUDIO],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            translationConfig: {
              targetLanguageCode: targetLangCode,
              echoTargetLanguage: false,
            },
          },
          callbacks: {
            onmessage: (message: LiveServerMessage) => {
              const content = message.serverContent;
              if (content?.inputTranscription?.text) {
                sendSafe({ type: 'inputTranscript', text: content.inputTranscription.text });
              }
              if (content?.outputTranscription?.text) {
                sendSafe({ type: 'outputTranscript', text: content.outputTranscription.text });
              }
              for (const part of content?.modelTurn?.parts ?? []) {
                if (part.inlineData?.data) {
                  sendSafe({ type: 'audio', data: part.inlineData.data });
                }
              }
              if (content?.turnComplete) {
                sendSafe({ type: 'turnComplete' });
              }
              if (content?.interrupted) {
                sendSafe({ type: 'interrupted' });
              }
            },
            onerror: (err: unknown) => {
              const formatted = formatGeminiError(err);
              sendSafe({ type: 'error', message: formatted.message });
            },
            onclose: () => {
              if (!isClosing) {
                sendSafe({ type: 'status', status: 'session_closed' });
              }
            },
          },
        });
        session = nextSession;
        sendSafe({ type: 'ready', targetLang: targetLangCode });
      } catch (err) {
        const formatted = formatGeminiError(err);
        sendSafe({ type: 'error', message: formatted.message });
      }
    };

    await connectLiveSession(currentTargetLang);

    clientWs.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          audio?: string;
          targetLang?: string;
        };
        if (msg.type === 'config' && msg.targetLang && msg.targetLang !== currentTargetLang) {
          currentTargetLang = msg.targetLang;
          await connectLiveSession(currentTargetLang);
          return;
        }
        if (msg.audio && session) {
          session.sendRealtimeInput({
            audio: { data: msg.audio, mimeType: 'audio/pcm;rate=16000' },
          });
        }
      } catch (err) {
        const formatted = formatGeminiError(err);
        sendSafe({ type: 'error', message: formatted.message });
      }
    });

    clientWs.on('close', () => {
      isClosing = true;
      if (session) {
        try {
          session.close();
        } catch {
          // ignore
        }
      }
    });
  });

  // 2. Live Speech-to-Text Transcription WebSocket (gemini-3.5-transcribe-live)
  wssLiveTranscribe.on('connection', async (clientWs, req) => {
    const reqUrl = new URL(req.url || '/', `http://${requestHost(req)}`);
    const langParam = reqUrl.searchParams.get('lang') || '';
    const languageCodes = langParam && langParam !== 'auto' ? [langParam] : [];
    let session: Session | null = null;
    let isClosing = false;

    const sendSafe = (payload: unknown) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    try {
      const ai = getAiClient();
      session = await ai.live.connect({
        model: 'gemini-3.5-transcribe-live',
        config: {
          responseModalities: [Modality.TEXT],
          inputAudioTranscription: {
            languageCodes,
          },
        },
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            const content = message.serverContent;
            if (content?.interimInputTranscription?.text) {
              sendSafe({
                type: 'interimTranscript',
                text: content.interimInputTranscription.text,
              });
            }
            if (content?.inputTranscription?.text) {
              sendSafe({
                type: 'transcript',
                text: content.inputTranscription.text,
              });
            }
            if (content?.turnComplete) {
              sendSafe({ type: 'turnComplete' });
            }
          },
          onerror: (err: unknown) => {
            const formatted = formatGeminiError(err);
            sendSafe({ type: 'error', message: formatted.message });
          },
          onclose: () => {
            if (!isClosing) {
              sendSafe({ type: 'status', status: 'session_closed' });
            }
          },
        },
      });
      sendSafe({ type: 'ready' });
    } catch (err) {
      const formatted = formatGeminiError(err);
      sendSafe({ type: 'error', message: formatted.message });
    }

    clientWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { audio?: string };
        if (msg.audio && session) {
          session.sendRealtimeInput({
            audio: { data: msg.audio, mimeType: 'audio/pcm;rate=16000' },
          });
        }
      } catch (err) {
        const formatted = formatGeminiError(err);
        sendSafe({ type: 'error', message: formatted.message });
      }
    });

    clientWs.on('close', () => {
      isClosing = true;
      if (session) {
        try {
          session.close();
        } catch {
          // ignore
        }
      }
    });
  });

  // 3. Global Multi-User Voice & Translation Room WebSocket
  wssRoom.on('connection', (ws) => {
    let activeRoom: RoomState | null = null;
    let activeParticipantId: string | null = null;

    ws.on('message', async (raw) => {
      try {
        const event = JSON.parse(raw.toString()) as {
          type: string;
          roomId?: string;
          participantId?: string;
          name?: string;
          langCode?: string;
          langName?: string;
          messageId?: string;
          text?: string;
          audioBase64?: string;
          mimeType?: string;
          isSpeaking?: boolean;
          agreement?: RoomAgreementState;
          agreementId?: string;
          confirmed?: boolean;
        };

        if (event.type === 'join' && event.roomId && event.participantId) {
          const room = getOrCreateRoom(event.roomId);
          activeRoom = room;
          activeParticipantId = event.participantId;

          room.participants.set(event.participantId, {
            id: event.participantId,
            name: (event.name || 'Misafir').slice(0, 40),
            langCode: event.langCode || 'tr',
            langName: event.langName || 'Türkçe',
            isSpeaking: false,
            ws,
          });

          ws.send(
            JSON.stringify({
              type: 'room:init',
              roomId: room.id,
              participants: serializeParticipants(room),
              messages: room.messages,
              agreements: room.agreements,
            })
          );

          broadcastToRoom(room, {
            type: 'room:participants',
            participants: serializeParticipants(room),
          });
          return;
        }

        if (!activeRoom || !activeParticipantId) return;
        const sender = activeRoom.participants.get(activeParticipantId);
        if (!sender) return;

        if (event.type === 'update_lang' && event.langCode) {
          sender.langCode = event.langCode;
          sender.langName = event.langName || event.langCode;
          broadcastToRoom(activeRoom, {
            type: 'room:participants',
            participants: serializeParticipants(activeRoom),
          });
          return;
        }

        if (event.type === 'typing') {
          sender.isSpeaking = Boolean(event.isSpeaking);
          broadcastToRoom(activeRoom, {
            type: 'room:participants',
            participants: serializeParticipants(activeRoom),
          });
          return;
        }

        if (event.type === 'agreement:add' && event.agreement) {
          const exists = activeRoom.agreements.some((a) => a.id === event.agreement!.id);
          if (!exists) {
            activeRoom.agreements.push(event.agreement);
            broadcastToRoom(activeRoom, {
              type: 'room:agreements',
              agreements: activeRoom.agreements,
            });
          }
          return;
        }

        if (event.type === 'agreement:toggle' && event.agreementId) {
          activeRoom.agreements = activeRoom.agreements.map((a) =>
            a.id === event.agreementId ? { ...a, confirmed: Boolean(event.confirmed) } : a
          );
          broadcastToRoom(activeRoom, {
            type: 'room:agreements',
            agreements: activeRoom.agreements,
          });
          return;
        }

        if (event.type === 'chat_message') {
          const messageId =
            event.messageId || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          if (activeRoom.messages.some((m) => m.id === messageId)) return;

          const msgGuard = sanitizeTextGuard(event.text, 2000);
          if (!msgGuard.ok) {
            ws.send(JSON.stringify({ type: 'room:error', message: msgGuard.reason }));
            return;
          }
          let originalText = msgGuard.text;

          if (!originalText && event.audioBase64) {
            const ai = getAiClient();
            const transcribeResp = await ai.models.generateContent({
              model: 'gemini-3.5-transcribe',
              contents: {
                parts: [
                  {
                    inlineData: {
                      mimeType: event.mimeType || 'audio/webm',
                      data: event.audioBase64,
                    },
                  },
                  {
                    text: `Transcribe this ${sender.langName} (${sender.langCode}) speech accurately. Return only the spoken words.`,
                  },
                ],
              },
            });
            originalText = (transcribeResp.text ?? '').trim();
          }

          if (!originalText) {
            ws.send(JSON.stringify({ type: 'room:error', message: 'Ses algılanamadı.' }));
            return;
          }

          const uniqueTargetMap = new Map<string, string>();
          for (const p of activeRoom.participants.values()) {
            uniqueTargetMap.set(p.langCode, p.langName);
          }
          uniqueTargetMap.set('en', 'İngilizce');
          uniqueTargetMap.set('tr', 'Türkçe');

          const targetList = Array.from(uniqueTargetMap.entries()).map(([code, name]) => ({
            code,
            name,
          }));

          const translations = await translateToMultipleLanguages(
            originalText,
            sender.langCode,
            targetList
          );

          const roomMsg: RoomMessageState = {
            id: messageId,
            senderId: sender.id,
            senderName: sender.name,
            sourceLang: sender.langCode,
            originalText,
            translations,
            timestamp: new Date().toISOString(),
          };

          activeRoom.messages.push(roomMsg);
          if (activeRoom.messages.length > 100) {
            activeRoom.messages = activeRoom.messages.slice(-100);
          }

          broadcastToRoom(activeRoom, {
            type: 'message:created',
            message: roomMsg,
          });
        }
      } catch (err) {
        const formatted = formatGeminiError(err);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'room:error', message: formatted.message }));
        }
      }
    });

    ws.on('close', () => {
      if (activeRoom && activeParticipantId) {
        activeRoom.participants.delete(activeParticipantId);
        broadcastToRoom(activeRoom, {
          type: 'room:participants',
          participants: serializeParticipants(activeRoom),
        });
      }
    });
  });

  // 4. Video Social Signaling: Random Matchmaking + Live Broadcast WebRTC + Translated Subtitles
  wssVideoSocial.on('connection', (ws) => {
    const peerId = `peer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const peer: VideoPeer = {
      peerId,
      uid: peerId,
      displayName: 'Misafir',
      handle: 'misafir',
      langCode: 'tr',
      langName: 'Türkçe',
      filterLang: 'all',
      ws,
      partnerPeerId: null,
      matchSessionId: null,
      streamId: null,
      isHost: false,
      mediaMode: 'video',
    };
    videoPeers.set(peerId, peer);
    sendPeer(ws, {
      type: 'peer:registered',
      peerId,
      waitingCount: matchQueue.length,
      onlineCount: videoPeers.size,
    });
    broadcastQueueStats();

    let msgWindowCount = 0;
    let msgWindowReset = Date.now() + 10_000;

    ws.on('message', async (raw) => {
      try {
        const now = Date.now();
        if (now > msgWindowReset) {
          msgWindowCount = 0;
          msgWindowReset = now + 10_000;
        }
        msgWindowCount += 1;
        if (msgWindowCount > 40) {
          defenseStats.floodDisconnects += 1;
          sendPeer(ws, {
            type: 'video:error',
            message: 'Güvenlik kalkanı: Çok hızlı mesaj trafiği nedeniyle bağlantı durduruldu.',
          });
          ws.close(1008, 'Rate limit exceeded');
          return;
        }

        const msg = JSON.parse(raw.toString()) as {
          type: string;
          uid?: string;
          displayName?: string;
          handle?: string;
          langCode?: string;
          langName?: string;
          filterLang?: string;
          mediaMode?: 'video' | 'text';
          toPeerId?: string;
          sdp?: unknown;
          candidate?: unknown;
          streamId?: string;
          isHost?: boolean;
          text?: string;
          audioBase64?: string;
          mimeType?: string;
          speak?: boolean;
          voiceName?: string;
          idToken?: string;
        };

        if (msg.type === 'peer:identify') {
          if (msg.uid) peer.uid = msg.uid.slice(0, 64);
          if (msg.displayName) {
            const dn = sanitizeTextGuard(msg.displayName, 50);
            if (dn.ok && dn.text) peer.displayName = dn.text;
          }
          if (msg.handle) peer.handle = msg.handle.replace(/[^a-z0-9_]/gi, '').slice(0, 32) || 'misafir';
          if (msg.langCode) peer.langCode = msg.langCode.slice(0, 12);
          if (msg.langName) peer.langName = msg.langName.slice(0, 40);
          return;
        }

        // --- Random Matchmaking ---
        if (msg.type === 'match:join') {
          disconnectMatchPair(peer);
          leaveStreamRoom(peer);
          if (msg.uid) peer.uid = msg.uid.slice(0, 64);
          if (msg.displayName) {
            const dn = sanitizeTextGuard(msg.displayName, 50);
            if (dn.ok && dn.text) peer.displayName = dn.text;
          }
          if (msg.handle) peer.handle = msg.handle.replace(/[^a-z0-9_]/gi, '').slice(0, 32) || 'misafir';
          if (msg.langCode) peer.langCode = msg.langCode.slice(0, 12);
          if (msg.langName) peer.langName = msg.langName.slice(0, 40);
          peer.filterLang = (msg.filterLang || 'all').slice(0, 12);
          peer.mediaMode = msg.mediaMode === 'text' ? 'text' : 'video';

          removeFromQueue(peerId);
          matchQueue.push(peerId);
          broadcastQueueStats();
          tryPairFromQueue(peerId);
          return;
        }

        if (msg.type === 'match:leave') {
          removeFromQueue(peerId);
          disconnectMatchPair(peer);
          broadcastQueueStats();
          return;
        }

        // --- Live Broadcast Stream Room Join / Leave ---
        if (msg.type === 'stream:join' && msg.streamId) {
          removeFromQueue(peerId);
          disconnectMatchPair(peer);
          leaveStreamRoom(peer);

          const sid = msg.streamId.slice(0, 64);
          peer.streamId = sid;
          peer.isHost = Boolean(msg.isHost);
          if (msg.uid) peer.uid = msg.uid.slice(0, 64);
          if (msg.displayName) {
            const dn = sanitizeTextGuard(msg.displayName, 50);
            if (dn.ok && dn.text) peer.displayName = dn.text;
          }
          if (msg.handle) peer.handle = msg.handle.replace(/[^a-z0-9_]/gi, '').slice(0, 32) || 'misafir';
          if (msg.langCode) peer.langCode = msg.langCode.slice(0, 12);
          if (msg.langName) peer.langName = msg.langName.slice(0, 40);

          let members = streamRooms.get(sid);
          if (!members) {
            members = new Set();
            streamRooms.set(sid, members);
          }
          members.add(peerId);

          // Notify host / existing peers so host can send WebRTC offer to new viewer
          for (const otherPid of members) {
            if (otherPid === peerId) continue;
            const other = videoPeers.get(otherPid);
            if (other) {
              sendPeer(other.ws, {
                type: 'stream:peer_joined',
                streamId: sid,
                peer: {
                  peerId: peer.peerId,
                  uid: peer.uid,
                  displayName: peer.displayName,
                  handle: peer.handle,
                  langCode: peer.langCode,
                  langName: peer.langName,
                  isHost: peer.isHost,
                },
              });
            }
          }
          broadcastStreamPresence(sid);
          return;
        }

        if (msg.type === 'stream:leave') {
          leaveStreamRoom(peer);
          return;
        }

        if (msg.type === 'admin:force_close_stream' && msg.streamId) {
          const isVerifiedAdmin = await verifyFirebaseAdminToken(msg.idToken);
          if (!isVerifiedAdmin) {
            defenseStats.blockedMaliciousPayloads += 1;
            sendPeer(ws, {
              type: 'video:error',
              message: 'Güvenlik kalkanı: Yetkisiz yönetici komutu engellendi.',
            });
            return;
          }
          const members = streamRooms.get(msg.streamId);
          if (members) {
            for (const pid of members) {
              const member = videoPeers.get(pid);
              if (member) {
                sendPeer(member.ws, {
                  type: 'stream:closed_by_admin',
                  streamId: msg.streamId,
                });
                member.streamId = null;
                member.isHost = false;
              }
            }
            streamRooms.delete(msg.streamId);
          }
          return;
        }

        // --- WebRTC Signaling Relay (validated SDP / ICE shapes) ---
        if (
          (msg.type === 'webrtc:offer' ||
            msg.type === 'webrtc:answer' ||
            msg.type === 'webrtc:ice') &&
          msg.toPeerId
        ) {
          if (msg.type === 'webrtc:ice' && !isValidIceCandidate(msg.candidate)) return;
          if ((msg.type === 'webrtc:offer' || msg.type === 'webrtc:answer') && !isValidSdp(msg.sdp)) {
            return;
          }
          const target = videoPeers.get(msg.toPeerId);
          if (target) {
            sendPeer(target.ws, {
              type: msg.type,
              fromPeerId: peerId,
              sdp: msg.sdp,
              candidate: msg.candidate,
              streamId: msg.streamId,
            });
          }
          return;
        }

        // --- Real-Time Auto-Translated Speech / Captions during Video Chat ---
        if (msg.type === 'call:speech_chunk') {
          const textGuard = sanitizeTextGuard(msg.text, 1000);
          if (!textGuard.ok) {
            sendPeer(ws, { type: 'video:error', message: textGuard.reason });
            return;
          }
          const ai = getAiClient();
          let originalText = textGuard.text;

          if (
            !originalText &&
            typeof msg.audioBase64 === 'string' &&
            msg.audioBase64.length > 0 &&
            msg.audioBase64.length <= 4_000_000
          ) {
            const tr = await ai.models.generateContent({
              model: 'gemini-3.5-transcribe',
              contents: {
                parts: [
                  {
                    inlineData: {
                      mimeType: safeAudioMime(msg.mimeType),
                      data: msg.audioBase64,
                    },
                  },
                  {
                    text: `Transcribe this ${peer.langName} (${peer.langCode}) speech accurately. Return only the spoken words without commentary.`,
                  },
                ],
              },
            });
            originalText = (tr.text ?? '').trim();
          }

          if (!originalText) return;

          // Case A: 1-to-1 Random Match Partner
          if (peer.partnerPeerId) {
            const partner = videoPeers.get(peer.partnerPeerId);
            if (!partner) return;

            const translations = await translateToMultipleLanguages(
              originalText,
              peer.langCode,
              [{ code: partner.langCode, name: partner.langName }]
            );
            const partnerText = translations[partner.langCode] || originalText;

            let ttsAudioBase64: string | undefined;
            if (msg.speak !== false && partner.langCode !== peer.langCode) {
              const ttsResp = await ai.models.generateContent({
                model: 'gemini-3.8-flash-lite-tts',
                contents: [
                  {
                    role: 'user',
                    parts: [
                      {
                        text: partnerText,
                        speechMetadata: {
                          style: `Natural conversational native ${partner.langName} speaker`,
                        },
                      },
                    ],
                  },
                ],
                config: {
                  responseModalities: ['AUDIO'],
                  speechConfig: {
                    voiceConfig: {
                      prebuiltVoiceConfig: { voiceName: safeVoiceName(msg.voiceName) },
                    },
                  },
                },
              });
              ttsAudioBase64 = ttsResp.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            }

            const payload = {
              type: 'call:subtitle',
              id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              senderPeerId: peer.peerId,
              senderName: peer.displayName,
              sourceLang: peer.langCode,
              originalText,
              translations,
              timestamp: new Date().toLocaleTimeString('tr-TR', {
                hour: '2-digit',
                minute: '2-digit',
              }),
            };

            sendPeer(peer.ws, payload);
            sendPeer(partner.ws, { ...payload, audioBase64: ttsAudioBase64 });
            return;
          }

          // Case B: Live Broadcast Stream Room (broadcast translated captions to all viewers in their language)
          if (peer.streamId) {
            const members = streamRooms.get(peer.streamId);
            if (!members) return;

            const targetMap = new Map<string, string>();
            for (const pid of members) {
              const member = videoPeers.get(pid);
              if (member) targetMap.set(member.langCode, member.langName);
            }
            const targetList = Array.from(targetMap.entries()).map(([code, name]) => ({
              code,
              name,
            }));

            const translations = await translateToMultipleLanguages(
              originalText,
              peer.langCode,
              targetList
            );

            const payload = {
              type: 'call:subtitle',
              id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              senderPeerId: peer.peerId,
              senderName: peer.displayName,
              sourceLang: peer.langCode,
              originalText,
              translations,
              timestamp: new Date().toLocaleTimeString('tr-TR', {
                hour: '2-digit',
                minute: '2-digit',
              }),
            };

            for (const pid of members) {
              const member = videoPeers.get(pid);
              if (member) sendPeer(member.ws, payload);
            }
          }
          return;
        }

        // --- Live Stream Comment (accessible for guests without DB write) ---
        if (msg.type === 'stream:comment' && peer.streamId && msg.text?.trim()) {
          const members = streamRooms.get(peer.streamId);
          if (!members) return;
          const commentGuard = sanitizeTextGuard(msg.text, 500);
          if (!commentGuard.ok) {
            sendPeer(ws, { type: 'video:error', message: commentGuard.reason });
            return;
          }
          const cleanText = commentGuard.text;
          if (!cleanText) return;
          const targetMap = new Map<string, string>();
          for (const pid of members) {
            const member = videoPeers.get(pid);
            if (member) targetMap.set(member.langCode, member.langName);
          }
          const targetList = Array.from(targetMap.entries()).map(([code, name]) => ({
            code,
            name,
          }));
          const translations = await translateToMultipleLanguages(
            cleanText,
            peer.langCode,
            targetList
          );
          const commentPayload = {
            type: 'stream:guest_comment',
            comment: {
              id: `gcmt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              streamId: peer.streamId,
              authorUid: peer.uid,
              authorName: peer.displayName,
              sourceLang: peer.langCode,
              originalText: cleanText,
              translations,
            },
          };
          for (const pid of members) {
            const member = videoPeers.get(pid);
            if (member) sendPeer(member.ws, commentPayload);
          }
        }
      } catch (err) {
        const formatted = formatGeminiError(err);
        sendPeer(ws, { type: 'video:error', message: formatted.message });
      }
    });

    ws.on('close', () => {
      removeFromQueue(peerId);
      disconnectMatchPair(peer);
      leaveStreamRoom(peer);
      videoPeers.delete(peerId);
      broadcastQueueStats();
    });
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`OndaTalk server running on http://0.0.0.0:${PORT}`);
  });
}

function requestHost(req: http.IncomingMessage): string {
  return req.headers.host || 'localhost';
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
