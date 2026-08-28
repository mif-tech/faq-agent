import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createAnthropicGenerationPort } from '../functions/faq-chat/adapters/free/anthropic-generation.js';
import type { FaqGenerationRequest } from '../functions/faq-chat/ports/generation.js';
import type {
  SlackAgentPorts,
  SlackAgentRuntimeBoundary,
  SlackGenerationPort,
} from '../shared/public/slack-agent-ports.js';
import { createLiteSlackAgentConfigPort } from './slack-agent-config.js';
import { liteSlackKbPort } from './slack-kb.js';
import { liteSlackAgentPolicy } from './slack-agent-policy.js';
import { LiteDynamoSlackAgentQaLogWriter } from './slack-agent-qa-log-dynamo.js';
import { createSlackAgentComposition } from '../shared/public/slack-agent-composition.js';

// port検査はエディション共通の公開実装を使う（正本との二重定義を避ける / レビュー指摘）。
export { createSlackAgentComposition };


export type LiteSlackTrustClass = 'slack';

export interface LiteSlackCompositionOptions {
  anthropicApiKey?: string;
  documentClient?: DynamoDBDocumentClient;
  /** Test seam. Production handlers bind the public Anthropic adapter. */
  generation?: SlackGenerationPort;
}

function createLiteGenerationPort(apiKey: string): SlackGenerationPort {
  const trimmedApiKey = apiKey.trim();
  if (!trimmedApiKey) throw new Error('Lite Slack agent Anthropic API key is required');
  const faqGeneration = createAnthropicGenerationPort({ apiKey: trimmedApiKey });

  return {
    async generate(request) {
      const model = request.model?.trim();
      if (!model) throw new Error('Lite Slack agent generation model is required');
      if (!Number.isSafeInteger(request.maxTokens) || (request.maxTokens ?? 0) <= 0) {
        throw new Error('Lite Slack agent max tokens must be a positive integer');
      }
      const faqRequest: FaqGenerationRequest = {
        ...request,
        model,
        maxTokens: request.maxTokens as number,
      };
      return faqGeneration.generate(faqRequest);
    },
  };
}

export function createLiteSlackAgentComposition(
  boundary: SlackAgentRuntimeBoundary<LiteSlackTrustClass>,
  options: LiteSlackCompositionOptions = {}
): SlackAgentPorts<LiteSlackTrustClass> {
  if (boundary.trustClass !== 'slack') {
    throw new Error('Lite Slack agent composition trust class must be slack');
  }
  for (const [name, value] of [
    ['agentId', boundary.agentId],
    ['kbTableName', boundary.kbTableName],
    ['qaLogTableName', boundary.qaLogTableName],
  ] as const) {
    if (!value.trim()) {
      throw new Error(`Lite Slack agent composition ${name} is required`);
    }
  }

  const generation =
    options.generation ?? createLiteGenerationPort(options.anthropicApiKey ?? '');
  return createSlackAgentComposition<LiteSlackTrustClass>({
    config: createLiteSlackAgentConfigPort(boundary),
    kb: liteSlackKbPort,
    generation,
    qaLog: new LiteDynamoSlackAgentQaLogWriter(
      boundary.qaLogTableName,
      boundary.agentId,
      options.documentClient
    ),
    policy: liteSlackAgentPolicy,
  });
}
