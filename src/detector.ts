export const BUILT_IN_PATTERNS = {
  "discord-invite": /(?:discord\.gg|discord(?:app)?\.com\/invite)\//i,
  payment: /\b(?:cash\s*app|venmo|paypal|wire transfer|gift card|payment)\b/i,
  crypto: /\b(?:bitcoin|ethereum|crypto|wallet|seed phrase|usdt|btc|eth)\b/i,
  "private-message": /\b(?:dm me|direct message|message me privately|open a ticket)\b/i,
  giveaway: /\b(?:giveaway|you(?:'ve| have) won|claim (?:your )?(?:prize|reward))\b/i,
} as const;

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<]+|\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z]{2,})(?:\/[^\s<]*)?/gi;

export function findUrls(content: string): string[] {
  return content.match(URL_PATTERN) ?? [];
}

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
}

export function detectReasons(content: string, keywords: string[], domains: string[], patterns: string[]): string[] {
  const lower = content.toLowerCase();
  const urls = findUrls(content);
  const reasons: string[] = [];
  if (urls.length) reasons.push(`link (${urls.length})`);
  for (const keyword of keywords) {
    if (lower.includes(keyword.toLowerCase())) reasons.push(`keyword: ${keyword}`);
  }
  for (const domain of domains) {
    if (urls.some((url) => normalizeDomain(url) === domain || normalizeDomain(url).endsWith(`.${domain}`))) {
      reasons.push(`domain: ${domain}`);
    }
  }
  for (const name of patterns) {
    const pattern = BUILT_IN_PATTERNS[name as keyof typeof BUILT_IN_PATTERNS];
    if (pattern?.test(content)) reasons.push(`pattern: ${name}`);
  }
  return [...new Set(reasons)];
}
