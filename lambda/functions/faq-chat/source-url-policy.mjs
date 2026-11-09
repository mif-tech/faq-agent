/** Shared public-source bounds and URL policy for TypeScript code and Node CLIs. */
export const FAQ_SOURCE_LIMITS = Object.freeze({
  sourceTopicCodePoints: 512,
  sourceUrlCodePoints: 2_048,
});

export function isPublishableSourceUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'notion.so' || host === 'www.notion.so') return false;
    return true;
  } catch {
    return false;
  }
}
