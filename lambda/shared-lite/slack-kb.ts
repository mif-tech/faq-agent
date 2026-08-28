import type {
  SlackKbInjection,
  SlackKbPort,
} from '../shared/public/slack-agent-ports.js';
import { resolveAgentProfile } from '../functions/faq-chat/adapters/free/agent-config.js';
import { loadPublicKnowledgeEntries } from '../functions/faq-chat/adapters/free/dynamodb-entries.js';
import { createSimpleRetrievalPort } from '../functions/faq-chat/adapters/free/simple-retrieval.js';
import type { LiteSlackAgentTrustClass } from './slack-agent-policy.js';

const retrieval = createSimpleRetrievalPort({
  loadEntries: loadPublicKnowledgeEntries,
});

const kbPort: SlackKbPort<LiteSlackAgentTrustClass> = {
  async load(input): Promise<SlackKbInjection> {
    if (input.strategy !== 'query') {
      throw new Error('Lite Slack KB supports only the query injection strategy');
    }
    if (input.trustClass !== 'slack') {
      throw new Error('Lite Slack KB trust class mismatch');
    }
    if (input.embeddingPolicy !== 'disabled') {
      throw new Error('Lite Slack KB embeddingPolicy must be disabled');
    }

    // SlackKbLoadInput intentionally carries no client-selectable KB scope. Resolve the
    // server-owned AgentConfig row and share the exact HTTP named-route scope instead.
    const profile = await resolveAgentProfile(input.agentId);
    if (!profile || profile.enabled !== true) {
      throw new Error('Lite Slack KB AgentConfig is missing, disabled, or invalid');
    }
    const kbAgentId = profile.kbAgentId ?? profile.agentId;
    const result = await retrieval.retrieve({
      question: input.question,
      kbAgentId,
    });

    return {
      // simple-retrieval already returns the complete tag pair; the worker must not wrap it.
      block: result.block,
      sourceIds: [...result.entryIdByRef.values()],
    };
  },
};

export const liteSlackKbPort: Readonly<SlackKbPort<LiteSlackAgentTrustClass>> =
  Object.freeze(kbPort);
