import {
  SlackAgentDisabledError,
  type SlackAgentPolicyPort,
  type SlackAgentResolvedConfig,
  type SlackAgentRuntimeBoundary,
} from '../shared/public/slack-agent-ports.js';

export type LiteSlackAgentTrustClass = 'slack';

export function isLiteSlackAgentTrustClass(
  value: string
): value is LiteSlackAgentTrustClass {
  return value === 'slack';
}

const policy: SlackAgentPolicyPort<LiteSlackAgentTrustClass> = {
  isTrustClass: isLiteSlackAgentTrustClass,

  // liteはserver-side強制なし（設定値をそのまま使う）。強制する場合はここへ追加する。
  qaLogPolicyOverrides: Object.freeze({}),

  inspectJob() {
    return 'process';
  },

  assertAgentConfigBoundary(
    config: SlackAgentResolvedConfig | null,
    runtime: SlackAgentRuntimeBoundary<LiteSlackAgentTrustClass>
  ): asserts config is SlackAgentResolvedConfig<LiteSlackAgentTrustClass> {
    if (!config) throw new Error('AgentConfig is missing or invalid');
    if (config.agentId !== runtime.agentId) {
      throw new Error('AgentConfig agentId mismatch');
    }
    // disabledはオペレーターの正常操作。retry/DLQ/エラー投稿にせず、workerが警告付きACKする。
    if (config.enabled !== true) throw new SlackAgentDisabledError(config.agentId);
    if (config.trustClass !== 'slack' || config.trustClass !== runtime.trustClass) {
      throw new Error('AgentConfig trust class mismatch');
    }
    if (config.access !== 'internal') {
      throw new Error('AgentConfig access mismatch');
    }
    if (config.kbTable !== runtime.kbTableName) {
      throw new Error('AgentConfig KB table mismatch');
    }
    if (config.qaLogTable !== runtime.qaLogTableName) {
      throw new Error('AgentConfig Q&A log table mismatch');
    }
    if (config.embeddingPolicy !== 'disabled') {
      throw new Error('Lite Slack agent embeddingPolicy must be disabled');
    }
    if (config.qaLogNotification?.enabled === true) {
      throw new Error('Lite Slack agent qaLogNotification must not be enabled');
    }
  },

  selectKbInjectionStrategy() {
    return 'query';
  },

  canSendQaLogNotification() {
    return false;
  },

  async sendQaLogNotification() {
    return false;
  },
};

export const liteSlackAgentPolicy: Readonly<
  SlackAgentPolicyPort<LiteSlackAgentTrustClass>
> = Object.freeze(policy);
