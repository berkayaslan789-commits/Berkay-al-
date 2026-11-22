# Security Summary

OndaTalk implements multi-layer application and network-edge defenses designed for public deployment across free Node.js hosting environments:

- **Server-Side API Key Isolation**: The `GEMINI_API_KEY` secret is read strictly inside `server.ts` (`process.env.GEMINI_API_KEY`) and never bundled into the React frontend (`dist/`). All speech, translation, transcription, and command requests route through server-side `/api/*` or WebSocket endpoints.
- **Malicious Payload & Script Defense**: Both client (`src/utils/safety.ts`) and server (`sanitizeTextGuard` in `server.ts`) strip ASCII control characters, reject `<script>`, `<iframe>`, `javascript:`, `vbscript:`, inline event handlers (`onerror=`, `onload=`), encoded shell payloads (`powershell -e`, `cmd.exe /c`, `curl | bash`), and suspicious binary download URLs (`.exe`, `.bat`, `.ps1`, `.vbs`, `.msi`, `.dll`).
- **Authenticated Admin WebSocket Control**: Administrative `admin:force_close_stream` WebSocket commands verify a Firebase ID token against Firebase Identity Toolkit and confirm either verified super-owner identity or an active `admins/{uid}` record before closing any live room.
- **HTTP Security Headers & Content Security Policy**: Express disables `x-powered-by`, honors reverse proxies (`trust proxy`), and sets `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Cross-Origin-Opener-Policy: same-origin-allow-popups`, and `Permissions-Policy`.
- **Rate Limiting & WebSocket Flood Shield**: `/api/*` endpoints enforce a per-IP sliding window limit (`45 requests / 60s`), while WebSocket endpoints enforce per-IP connection caps (`15` concurrent sockets), bounded `maxPayload` limits (`512 KB` – `2 MB`), and message flood disconnects (`>40 messages / 10s`).
- **Input & Signaling Bounds**: WebRTC SDP offers/answers, ICE candidates, audio MIME types, voice presets, base64 audio payload lengths (`<= 8 MB` HTTP / `<= 4 MB` WS), and profile avatar URLs (`https://` only) are validated before processing.
- **Database Access Rules**: `firestore.rules` restricts profile mutations to the authenticated owner (while locking `status` changes to verified admins), reserves `admins` and `platformSettings` management to the platform owner and authorized moderators, and allows safe public/guest reads where appropriate.
- **Dependency Hygiene**: `bun audit` showed zero direct production vulnerabilities; the only transitive notice (`@grpc/grpc-js@1.9.16` under `firebase > @firebase/firestore`) is a Node-only gRPC transport that is not used by OndaTalk's browser WebChannel Firestore SDK.

---

## PoC Verification

### 1. Unauthenticated Admin Stream Termination Blocked
- **Scenario**: An unauthenticated or regular client sends `{ "type": "admin:force_close_stream", "streamId": "test-stream" }` to `wss://<host>/ws/video-social` without a valid verified admin `idToken`.
- **Expected & Implemented Behavior**: `verifyFirebaseAdminToken` rejects the missing/unverified token, increments `defenseStats.blockedMaliciousPayloads`, returns `{ "type": "video:error", "message": "Güvenlik kalkanı: Yetkisiz yönetici komutu engellendi." }`, and preserves the live room.
- **Authorized Path**: When the verified owner or moderator triggers close from `AdminPanel.tsx`, `auth.currentUser?.getIdToken()` is attached and verified on the server before closing the stream room.

### 2. Script / Executable Injection Rejected on Text & Chat Routes
- **Scenario**: A user submits `<script>alert(1)</script>` or `powershell -enc AAA` in `/api/translate`, `/api/command`, `/api/summarize`, random match chat, or live stream comments.
- **Expected & Implemented Behavior**: `sanitizeTextGuard` detects the pattern, increments `defenseStats.blockedMaliciousPayloads`, and returns HTTP `400` (or WebSocket `video:error`) without storing, translating, or broadcasting the payload.

### 3. Flood & API Abuse Throttling
- **Scenario**: More than 45 `/api/*` requests within 60 seconds from one IP, or more than 40 WebSocket messages within 10 seconds on `/ws/video-social` or `/ws/room`.
- **Expected & Implemented Behavior**: Excess HTTP requests receive HTTP `429` (`rateLimitedRequests` incremented); excess WebSocket bursts trigger `floodDisconnects` increment and socket closure with code `1008`.

### 4. Security Headers & Health Endpoint Verification
- **Check Command**:
  1. `GET /api/health` -> returns `{ "ok": true, "hasKey": ... }`.
  2. `GET /api/security-status` -> returns live `defenseStats` shield telemetry (`protected: true`, blocked counters, active WebSocket connections).
  3. `HEAD /` -> confirms active `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy` headers while omitting `X-Powered-By`.
