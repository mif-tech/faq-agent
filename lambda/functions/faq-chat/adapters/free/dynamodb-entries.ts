import type { FaqKbEntry, FaqKbSourcePort } from '../../ports/storage.js';
import { LiteTableNames, scanAll } from '../../infra/lite-dynamodb.js';

interface LiteKnowledgeEntry {
  entryId?: unknown;
  topic?: unknown;
  answer?: unknown;
  canonicalUrl?: unknown;
  status?: unknown;
  visibility?: unknown;
  agentId?: unknown;
}

/**
 * Load only active, explicitly public records for the default public agent.
 * The JavaScript filter intentionally repeats the DynamoDB filter as a fail-closed boundary.
 */
export async function loadPublicKnowledgeEntries(): Promise<FaqKbEntry[]> {
  const rows = await scanAll<LiteKnowledgeEntry>(LiteTableNames.KnowledgeEntries, {
    filterExpression:
      '#status = :active AND #visibility = :public AND ' +
      '(attribute_not_exists(#agentId) OR #agentId = :defaultAgentId)',
    expressionAttributeNames: {
      '#status': 'status',
      '#visibility': 'visibility',
      '#agentId': 'agentId',
    },
    expressionAttributeValues: {
      ':active': 'active',
      ':public': 'public',
      ':defaultAgentId': 'default',
    },
  });

  return rows
    .filter(
      (row) =>
        row.status === 'active' &&
        row.visibility === 'public' &&
        (row.agentId === undefined || row.agentId === 'default') &&
        typeof row.entryId === 'string' &&
        typeof row.topic === 'string' &&
        typeof row.answer === 'string' &&
        (row.canonicalUrl === undefined || typeof row.canonicalUrl === 'string')
    )
    .map((row) => ({
      id: row.entryId as string,
      topic: row.topic as string,
      content: row.answer as string,
      ...(row.canonicalUrl === undefined
        ? {}
        : { canonicalUrl: row.canonicalUrl as string }),
    }));
}

export const dynamoDbFaqKbSource: FaqKbSourcePort = {
  loadPublicEntries: loadPublicKnowledgeEntries,
};
