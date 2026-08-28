/**
 * エディション共通の Slack agent port 検査。
 *
 * 正本（internal composition）と lite（overlay composition）の両方がこの検査を通す。
 * 片方だけ検査項目が更新される drift を防ぐため、port/メソッドの一覧はここが単一の正
 * （レビュー指摘）。
 */

import type { SlackAgentPorts } from './slack-agent-ports.js';

function assertPortMethod(
  port: unknown,
  portName: string,
  methodNames: readonly string[]
): void {
  if (typeof port !== 'object' || port === null) {
    throw new Error(`Slack agent composition ${portName} port is required`);
  }
  for (const methodName of methodNames) {
    if (typeof (port as Record<string, unknown>)[methodName] !== 'function') {
      throw new Error(
        `Slack agent composition ${portName}.${methodName} must be a function`
      );
    }
  }
}

/** 5 portすべてを同期検査し、policy未注入・メソッド欠落を起動時に失敗させる。 */
export function createSlackAgentComposition<TTrustClass extends string>(
  ports: SlackAgentPorts<TTrustClass>
): SlackAgentPorts<TTrustClass> {
  const candidate = ports as Partial<SlackAgentPorts<TTrustClass>> | null | undefined;
  assertPortMethod(candidate?.config, 'config', ['resolve']);
  assertPortMethod(candidate?.kb, 'kb', ['load']);
  assertPortMethod(candidate?.generation, 'generation', ['generate']);
  assertPortMethod(candidate?.qaLog, 'qaLog', ['saveGenerated', 'markPosted']);
  assertPortMethod(candidate?.policy, 'policy', [
    'isTrustClass',
    'inspectJob',
    'assertAgentConfigBoundary',
    'selectKbInjectionStrategy',
    'canSendQaLogNotification',
    'sendQaLogNotification',
  ]);
  const overrides = candidate?.policy?.qaLogPolicyOverrides;
  if (typeof overrides !== 'object' || overrides === null) {
    throw new Error(
      'Slack agent composition policy.qaLogPolicyOverrides must be an object'
    );
  }
  return ports;
}
