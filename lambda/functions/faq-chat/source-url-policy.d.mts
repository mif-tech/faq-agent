export const FAQ_SOURCE_LIMITS: Readonly<{
  sourceTopicCodePoints: 512;
  sourceUrlCodePoints: 2048;
}>;

export function isPublishableSourceUrl(url: unknown): url is string;
