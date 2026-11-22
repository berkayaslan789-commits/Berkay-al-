const DANGEROUS_PATTERNS = [
  /<\s*script\b/i,
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /data\s*:\s*text\/html/i,
  /\bon(?:error|load|click|mouseover)\s*=/i,
];

export function isSafeHttpsUrl(rawUrl: string | undefined | null): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl.trim());
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function sanitizeClientText(raw: string, maxLen = 1000): {
  safe: boolean;
  text: string;
} {
  const cleaned = raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLen);

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(cleaned)) {
      return { safe: false, text: '' };
    }
  }
  return { safe: true, text: cleaned };
}
