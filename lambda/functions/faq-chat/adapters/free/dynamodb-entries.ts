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
 * Load only active, explicitly public records for the requested public agent.
 * Omitting kbAgentId preserves the legacy default scope (missing agentId or "default").
 * A named scope is exact-match only and never mixes legacy rows without agentId.
 * The JavaScript filter intentionally repeats the DynamoDB filter as a fail-closed boundary.
 *
 * コスト特性: FilterExpressionは応答行を絞るだけで、Scanの読み取り容量は毎回テーブル全件分
 * 消費する。コーパスキャッシュ（agent別・TTL 60秒・LRU上限）があるため、Nエージェント運用時は
 * 最悪「毎分N回のフルScan」になる。フリー版の想定KB規模（数百行）では許容範囲だが、KBや
 * エージェント数が増えて問題になったら (a) agentIdのGSIを張ってQueryへ移行するか、
 * (b) 1回のScan結果をメモリ上でagent別に分割してキャッシュを共有する方式へ切り替えること。
 */
export async function loadPublicKnowledgeEntries(
  kbAgentId?: string
): Promise<FaqKbEntry[]> {
  const namedScope = kbAgentId !== undefined;
  const agentFilter = namedScope
    ? '#agentId = :kbAgentId'
    : '(attribute_not_exists(#agentId) OR #agentId = :defaultAgentId)';
  const agentExpressionValue = namedScope
    ? { ':kbAgentId': kbAgentId }
    : { ':defaultAgentId': 'default' };

  const rows = await scanAll<LiteKnowledgeEntry>(LiteTableNames.KnowledgeEntries, {
    filterExpression:
      '#status = :active AND #visibility = :public AND ' +
      agentFilter,
    expressionAttributeNames: {
      '#status': 'status',
      '#visibility': 'visibility',
      '#agentId': 'agentId',
    },
    expressionAttributeValues: {
      ':active': 'active',
      ':public': 'public',
      ...agentExpressionValue,
    },
  });

  return rows
    .filter(
      (row) =>
        row.status === 'active' &&
        row.visibility === 'public' &&
        (namedScope
          ? row.agentId === kbAgentId
          : row.agentId === undefined || row.agentId === 'default') &&
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
