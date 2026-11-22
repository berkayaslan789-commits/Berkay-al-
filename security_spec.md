# Security Specification — OndaTalk Social & Video Platform

## 1. Data Invariants
1. **Identity Integrity**: Every user-owned document (`users/{userId}`, `users/{userId}/private/info`, `streams/{streamId}`, `comments/{commentId}`, `follows/{followId}`, `reports/{reportId}`) must bind its owner/author UID field to `request.auth.uid`.
2. **PII Isolation**: Public `users/{userId}` profiles must never contain email addresses or private identifiers; email is strictly isolated under `users/{userId}/private/info`, readable only by the document owner or verified platform admins.
3. **RBAC Enforcement & Anti-Escalation**:
   - Platform Owner (`berkayaslan789@gmail.com` with `email_verified == true`) holds full super-admin authority.
   - Regular users cannot create/modify `/admins/{adminUid}`, cannot set `status` to anything other than `'active'` on registration, and cannot change their own `status` (`banned`/`muted`) or `featured` flags on streams.
4. **Master Gate & Referential Integrity**: Stream comments under `/streams/{streamId}/comments/{commentId}` require the parent `/streams/{streamId}` document to exist (`exists(...)`), and `comment.streamId == streamId`.
5. **Temporal Integrity**: `createdAt` and `updatedAt` timestamps must equal `request.time`; `createdAt` is immutable on update.
6. **Zero-Trust List Queries**: `allow list` rules explicitly evaluate `resource.data` without `get()` or `exists()` lookups.

## 2. The "Dirty Dozen" Adversarial Payloads (Must Return PERMISSION_DENIED)
1. **Self-Role Escalation on Registration**: Creating `/users/u1` with an extra shadow field `isAdmin: true` or `role: "super_admin"`.
2. **Banned Status Bypass**: Creating `/users/u1` with `status: "banned"` or updating own profile `status` from `"banned"` back to `"active"`.
3. **Admin Collection Poisoning**: Non-owner authenticated user attempting `setDoc(/admins/u1, { role: "super_admin" })`.
4. **Spoofed Unverified Owner Email**: Auth token with `email: "berkayaslan789@gmail.com"` and `email_verified: false` attempting admin write.
5. **PII Scraping**: Signed-in user `u2` attempting `getDoc(/users/u1/private/info)`.
6. **Shadow Field Injection on Stream**: Creating `/streams/s1` with `featured: true` as a regular user or adding an unlisted field `verifiedBadge: true`.
7. **Stream Host Spoofing**: User `u2` creating `/streams/s1` with `hostUid: "u1"`.
8. **Orphaned Comment**: Creating `/streams/nonexistent/comments/c1` where parent stream document does not exist.
9. **Client-Forged Timestamp**: Creating a stream or comment with `createdAt: Timestamp(1999-01-01)` instead of `serverTimestamp()`.
10. **ID Poisoning**: Creating `/streams/<2000-char-invalid-id>` failing `isValidId()`.
11. **Report Tampering**: Regular reporter updating `/reports/r1` `status` from `'open'` to `'resolved'`.
12. **Follow Spoofing**: User `u2` creating `/follows/u1_u3` with `followerUid: "u1"`.
