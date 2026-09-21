#!/usr/bin/env node
/** Parsed CloudFormation contract tests for the public lite Slack stack. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAMBDA_ROOT = path.join(HERE, '..');
const TEMPLATE = path.join(LAMBDA_ROOT, 'template.yaml');
const INGRESS_SOURCE = path.join(
  LAMBDA_ROOT,
  'functions',
  'slack-ingress',
  'handler.ts'
);
const WORKER_SOURCE = path.join(
  LAMBDA_ROOT,
  'functions',
  'slack-agent-worker',
  'handler.ts'
);
const LITE_DYNAMODB_SOURCE = path.join(
  LAMBDA_ROOT,
  'functions',
  'faq-chat',
  'infra',
  'lite-dynamodb.ts'
);

const templateSource = fs.readFileSync(TEMPLATE, 'utf8');
const ingressSource = fs.readFileSync(INGRESS_SOURCE, 'utf8');
const workerSource = fs.readFileSync(WORKER_SOURCE, 'utf8');
const liteDynamoDbSource = fs.readFileSync(LITE_DYNAMODB_SOURCE, 'utf8');

function scalarIntrinsic(tag, key, transform = (value) => value) {
  return {
    tag,
    resolve(value) {
      return { [key]: transform(value) };
    },
  };
}

function sequenceIntrinsic(name) {
  return {
    tag: `!${name}`,
    collection: 'seq',
    resolve(sequence) {
      return {
        [`Fn::${name}`]: sequence.items.map((item) => item.toJSON()),
      };
    },
  };
}

const templateDocument = parseDocument(templateSource, {
  customTags: [
    scalarIntrinsic('!Ref', 'Ref'),
    scalarIntrinsic('!Sub', 'Fn::Sub'),
    scalarIntrinsic('!GetAtt', 'Fn::GetAtt', (value) => value.split('.')),
    ...['And', 'Equals', 'If', 'Not', 'Or'].map(sequenceIntrinsic),
  ],
  uniqueKeys: true,
});
const template = templateDocument.toJS({ maxAliasCount: 0 });

const SLACK_PARAMETERS = [
  'SlackSigningSecret',
  'SlackBotToken',
  'SlackApiAppId',
  'SlackTeamId',
  'SlackBotUserId',
  'SlackAgentId',
  'SlackAllowedChannelIds',
];

const SLACK_RESOURCES = [
  'SlackEventDLQ',
  'SlackEventQueue',
  'SlackEventIdempotencyTable',
  'SlackIngressRole',
  'SlackWorkerRole',
  'SlackIngressFunction',
  'SlackWorkerFunction',
  'SlackEventDLQAlarm',
];

// データ表は意図的に常設（条件付き+Retainだと無効化で残った物理表が再有効化のCREATEと
// 衝突し、停止→再開が片道になるため）。残留物なしテストの明示的な例外。
const UNCONDITIONAL_SLACK_DATA_RESOURCES = ['SlackQaLogsTable'];
const UNCONDITIONAL_SLACK_OUTPUTS = ['SlackQaLogsTableName'];

const SLACK_OUTPUTS = [
  'SlackEventQueueUrl',
  'SlackEventIdempotencyTableName',
  'SlackIngressEndpointPath',
];

const COMPLETE_SLACK_CONFIGURATION = {
  SlackSigningSecret: 'signing-secret-for-test',
  SlackBotToken: 'bot-token-for-test',
  SlackApiAppId: 'A0123456789',
  SlackTeamId: 'T0123456789',
  SlackBotUserId: 'U0123456789',
  SlackAgentId: 'support',
  SlackAllowedChannelIds: 'C0123456789',
  AnthropicApiKey: 'anthropic-key-for-test',
};

function withParameterDefaults(overrides = {}) {
  return {
    ...Object.fromEntries(
      Object.entries(template.Parameters).map(([name, parameter]) => [
        name,
        parameter.Default,
      ])
    ),
    ...overrides,
  };
}

function evaluate(expression, parameters) {
  if (Array.isArray(expression)) {
    return expression.map((item) => evaluate(item, parameters));
  }
  if (expression === null || typeof expression !== 'object') return expression;
  if (Object.hasOwn(expression, 'Ref')) return parameters[expression.Ref];
  if (Object.hasOwn(expression, 'Fn::Equals')) {
    const [left, right] = evaluate(expression['Fn::Equals'], parameters);
    return left === right;
  }
  if (Object.hasOwn(expression, 'Fn::Not')) {
    const values = evaluate(expression['Fn::Not'], parameters);
    assert.equal(values.length, 1, 'Fn::Not must have exactly one operand');
    return !values[0];
  }
  if (Object.hasOwn(expression, 'Fn::And')) {
    return evaluate(expression['Fn::And'], parameters).every(Boolean);
  }
  if (Object.hasOwn(expression, 'Fn::Or')) {
    return evaluate(expression['Fn::Or'], parameters).some(Boolean);
  }
  throw new Error(`Unsupported rule intrinsic: ${JSON.stringify(expression)}`);
}

function ruleFailures(overrides) {
  const parameters = withParameterDefaults(overrides);
  const failures = [];
  for (const [ruleName, rule] of Object.entries(template.Rules)) {
    if (rule.RuleCondition !== undefined && !evaluate(rule.RuleCondition, parameters)) {
      continue;
    }
    for (const assertion of rule.Assertions) {
      if (!evaluate(assertion.Assert, parameters)) {
        failures.push(`${ruleName}: ${assertion.AssertDescription}`);
      }
    }
  }
  return failures;
}

function collectRefs(value, collected = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, collected);
    return collected;
  }
  if (value === null || typeof value !== 'object') return collected;
  if (typeof value.Ref === 'string') collected.add(value.Ref);
  for (const child of Object.values(value)) collectRefs(child, collected);
  return collected;
}

function collectStatements(value, collected = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectStatements(item, collected);
    return collected;
  }
  if (value === null || typeof value !== 'object') return collected;
  if (Object.hasOwn(value, 'Action')) collected.push(value);
  for (const child of Object.values(value)) collectStatements(child, collected);
  return collected;
}

function asArray(value) {
  return Array.isArray(value) ? value : [value];
}

function actions(statement) {
  return asArray(statement.Action);
}

function resources(statement) {
  return asArray(statement.Resource);
}

function requiredEnvNames(source) {
  return [
    ...new Set(
      [...source.matchAll(/\brequiredEnv\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/gu)].map(
        (match) => match[1]
      )
    ),
  ].sort();
}

function directProcessEnvNames(source) {
  return [
    ...new Set(
      [...source.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/gu)].map(
        (match) => match[1]
      )
    ),
  ].sort();
}

function liteDynamoRequiredEnvNames(source) {
  const tableNameBlock = source.match(
    /const TABLE_NAME_ENV\s*=\s*\{(?<body>[\s\S]*?)\}\s*as const/du
  );
  assert.ok(tableNameBlock?.groups?.body, 'TABLE_NAME_ENV contract must remain readable');
  const tableNames = [
    ...tableNameBlock.groups.body.matchAll(/:\s*['"]([A-Z][A-Z0-9_]*)['"]/gu),
  ].map((match) => match[1]);
  const directNames = [
    ...source.matchAll(
      /requiredEnvironmentValue\(\s*environment\s*,\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/gu
    ),
  ].map((match) => match[1]);
  return [...new Set([...tableNames, ...directNames])].sort();
}

function getResource(logicalId) {
  const resource = template.Resources[logicalId];
  assert.ok(resource, `${logicalId} must be declared`);
  return resource;
}

function permissionStatements(role) {
  return collectStatements(role.Properties.Policies ?? []);
}

function permissionPairs(statements) {
  const pairs = [];
  for (const statement of statements) {
    for (const action of actions(statement)) {
      for (const resource of resources(statement)) {
        pairs.push(`${action}|${JSON.stringify(resource)}`);
      }
    }
  }
  return pairs.sort();
}

function expectedPermissionPairs(entries) {
  return entries
    .map(
      ([action, logicalId]) =>
        `${action}|${JSON.stringify({ 'Fn::GetAtt': [logicalId, 'Arn'] })}`
    )
    .sort();
}

function assertNoWildcards(statements, roleName) {
  for (const statement of statements) {
    assert.equal(statement.Effect, 'Allow', `${roleName} statements must allow explicitly`);
    for (const action of actions(statement)) {
      assert.equal(typeof action, 'string');
      assert.doesNotMatch(action, /\*/u, `${roleName} action must not contain a wildcard`);
    }
    for (const resource of resources(statement)) {
      assert.doesNotMatch(
        JSON.stringify(resource),
        /\*/u,
        `${roleName} resource must not contain a wildcard`
      );
    }
  }
}

function assertLambdaTrustPolicy(role, roleName) {
  const statements = collectStatements(role.Properties.AssumeRolePolicyDocument);
  assert.equal(statements.length, 1, `${roleName} must have one trust statement`);
  const [statement] = statements;
  assert.equal(statement.Effect, 'Allow');
  assert.deepEqual(actions(statement), ['sts:AssumeRole']);
  assert.deepEqual(asArray(statement.Principal?.Service), ['lambda.amazonaws.com']);
  assert.equal(Object.hasOwn(statement, 'Resource'), false);
}

test('lite Slack template parses with CloudFormation short tags preserved', () => {
  assert.deepEqual(
    templateDocument.errors.map((error) => error.message),
    []
  );
  assert.deepEqual(
    templateDocument.warnings.map((warning) => warning.message),
    []
  );
  assert.equal(template.Transform, 'AWS::Serverless-2016-10-31');
});

test('Slack parameters are empty by default and credentials are not echoed', () => {
  for (const parameterName of SLACK_PARAMETERS) {
    const parameter = template.Parameters[parameterName];
    assert.ok(parameter, `${parameterName} must be declared`);
    assert.equal(parameter.Type, 'String');
    assert.equal(parameter.Default, '');
  }
  assert.equal(template.Parameters.SlackSigningSecret.NoEcho, true);
  assert.equal(template.Parameters.SlackBotToken.NoEcho, true);
});

test('Slack CloudFormation Rules enforce complete all-or-none configuration', () => {
  assert.deepEqual(ruleFailures({}), []);
  assert.deepEqual(ruleFailures(COMPLETE_SLACK_CONFIGURATION), []);
  assert.notDeepEqual(
    ruleFailures({ SlackSigningSecret: COMPLETE_SLACK_CONFIGURATION.SlackSigningSecret }),
    [],
    'a signing secret alone must fail deployment validation'
  );

  for (const parameterName of SLACK_PARAMETERS.filter(
    (name) => name !== 'SlackSigningSecret'
  )) {
    assert.notDeepEqual(
      ruleFailures({ ...COMPLETE_SLACK_CONFIGURATION, [parameterName]: '' }),
      [],
      `Slack must reject an empty ${parameterName}`
    );
    assert.notDeepEqual(
      ruleFailures({ [parameterName]: COMPLETE_SLACK_CONFIGURATION[parameterName] }),
      [],
      `${parameterName} without SlackSigningSecret must be rejected`
    );
  }

  assert.notDeepEqual(
    ruleFailures({ ...COMPLETE_SLACK_CONFIGURATION, AnthropicApiKey: '' }),
    [],
    'Slack worker requires the shared AnthropicApiKey when Slack is enabled'
  );

  const slackRules = Object.values(template.Rules).filter((rule) =>
    collectRefs(rule).has('SlackSigningSecret')
  );
  assert.notEqual(slackRules.length, 0, 'at least one Rule must govern SlackSigningSecret');
  const governedParameters = collectRefs(slackRules);
  for (const parameterName of [...SLACK_PARAMETERS, 'AnthropicApiKey']) {
    assert.equal(
      governedParameters.has(parameterName),
      true,
      `${parameterName} must be covered by Slack Rules`
    );
  }
});

test('HasSlackAgent is driven only by a non-empty signing secret', () => {
  assert.deepEqual(template.Conditions.HasSlackAgent, {
    'Fn::Not': [
      {
        'Fn::Equals': [{ Ref: 'SlackSigningSecret' }, ''],
      },
    ],
  });
  assert.equal(evaluate(template.Conditions.HasSlackAgent, withParameterDefaults()), false);
  assert.equal(
    evaluate(
      template.Conditions.HasSlackAgent,
      withParameterDefaults(COMPLETE_SLACK_CONFIGURATION)
    ),
    true
  );
});

test('every and only declared Slack resource is conditional', () => {
  const declaredSlackResources = Object.keys(template.Resources)
    .filter((logicalId) => logicalId.startsWith('Slack'))
    .sort();
  assert.deepEqual(
    declaredSlackResources,
    [...SLACK_RESOURCES, ...UNCONDITIONAL_SLACK_DATA_RESOURCES].sort()
  );
  for (const logicalId of SLACK_RESOURCES) {
    assert.equal(getResource(logicalId).Condition, 'HasSlackAgent');
  }
});

test('ingress and worker env exactly cover their entrypoint and lite Dynamo contracts', () => {
  const expectedIngressRequired = [
    'AGENT_ID',
    'ALLOWED_CHANNEL_IDS',
    'AWS_REGION',
    'EXPECTED_API_APP_ID',
    'EXPECTED_BOT_USER_ID',
    'EXPECTED_TEAM_ID',
    'SLACK_EVENT_QUEUE_URL',
    'SLACK_SIGNING_SECRET',
    'TRUST_CLASS',
  ].sort();
  const expectedWorkerRequired = [
    'AGENT_ID',
    'ANTHROPIC_API_KEY',
    'EXPECTED_BOT_USER_ID',
    'IDEMPOTENCY_TABLE_NAME',
    'KB_TABLE_NAME',
    'QUEUE_MAX_RECEIVE_COUNT',
    'SLACK_BOT_TOKEN',
    'SLACK_QA_LOG_TABLE_NAME',
    'TRUST_CLASS',
  ].sort();
  const expectedTransitiveDynamoRequired = [
    'FAQ_AGENT_CONFIG_TABLE_NAME',
    'FAQ_KNOWLEDGE_ENTRIES_TABLE_NAME',
    'FAQ_QA_LOGS_TABLE_NAME',
    'FAQ_SETTINGS_TABLE_NAME',
    'FAQ_TABLE_NAME_PREFIX',
  ].sort();

  assert.deepEqual(requiredEnvNames(ingressSource), expectedIngressRequired);
  assert.deepEqual(requiredEnvNames(workerSource), expectedWorkerRequired);
  // QUEUE_MAX_RECEIVE_COUNTはrequiredEnv化した（fail closed）ため、直接のprocess.env読みは残らない。
  assert.deepEqual(directProcessEnvNames(workerSource), []);
  assert.deepEqual(
    liteDynamoRequiredEnvNames(liteDynamoDbSource),
    expectedTransitiveDynamoRequired
  );

  const ingress = getResource('SlackIngressFunction');
  const ingressVariables = ingress.Properties.Environment.Variables;
  const ingressTemplateRequired = expectedIngressRequired.filter(
    (name) => name !== 'AWS_REGION'
  );
  assert.deepEqual(Object.keys(ingressVariables).sort(), ingressTemplateRequired.sort());
  assert.deepEqual(ingressVariables, {
    AGENT_ID: { Ref: 'SlackAgentId' },
    TRUST_CLASS: 'slack',
    SLACK_SIGNING_SECRET: { Ref: 'SlackSigningSecret' },
    EXPECTED_API_APP_ID: { Ref: 'SlackApiAppId' },
    EXPECTED_TEAM_ID: { Ref: 'SlackTeamId' },
    EXPECTED_BOT_USER_ID: { Ref: 'SlackBotUserId' },
    ALLOWED_CHANNEL_IDS: { Ref: 'SlackAllowedChannelIds' },
    SLACK_EVENT_QUEUE_URL: { Ref: 'SlackEventQueue' },
  });
  assert.equal(Object.hasOwn(ingressVariables, 'AWS_REGION'), false);

  const worker = getResource('SlackWorkerFunction');
  const workerVariables = worker.Properties.Environment.Variables;
  const expectedWorkerTemplateNames = [
    ...expectedWorkerRequired,
    ...expectedTransitiveDynamoRequired,
  ].sort();
  assert.deepEqual(Object.keys(workerVariables).sort(), expectedWorkerTemplateNames);
  assert.deepEqual(workerVariables, {
    AGENT_ID: { Ref: 'SlackAgentId' },
    TRUST_CLASS: 'slack',
    KB_TABLE_NAME: { Ref: 'KnowledgeEntriesTable' },
    SLACK_QA_LOG_TABLE_NAME: { Ref: 'SlackQaLogsTable' },
    SLACK_BOT_TOKEN: { Ref: 'SlackBotToken' },
    EXPECTED_BOT_USER_ID: { Ref: 'SlackBotUserId' },
    IDEMPOTENCY_TABLE_NAME: { Ref: 'SlackEventIdempotencyTable' },
    QUEUE_MAX_RECEIVE_COUNT: '5',
    ANTHROPIC_API_KEY: { Ref: 'AnthropicApiKey' },
    FAQ_TABLE_NAME_PREFIX: {
      'Fn::Sub': '${Environment}-${FaqTableNamespace}',
    },
    FAQ_SETTINGS_TABLE_NAME: { Ref: 'SettingsTable' },
    FAQ_AGENT_CONFIG_TABLE_NAME: { Ref: 'AgentConfigTable' },
    FAQ_KNOWLEDGE_ENTRIES_TABLE_NAME: { Ref: 'KnowledgeEntriesTable' },
    FAQ_QA_LOGS_TABLE_NAME: { Ref: 'FaqQaLogsTable' },
  });
  assert.equal(Object.hasOwn(workerVariables, 'QA_LOG_TABLE_NAME'), false);
  assert.deepEqual(workerVariables.KB_TABLE_NAME, workerVariables.FAQ_KNOWLEDGE_ENTRIES_TABLE_NAME);
});

test('Slack FIFO queues use encrypted bounded retry delivery', () => {
  const dlq = getResource('SlackEventDLQ');
  const queue = getResource('SlackEventQueue');
  const worker = getResource('SlackWorkerFunction');

  assert.equal(dlq.Type, 'AWS::SQS::Queue');
  assert.deepEqual(dlq.Properties.QueueName, {
    'Fn::Sub': '${Environment}-${FaqTableNamespace}-slack-events-dlq.fifo',
  });
  assert.equal(dlq.Properties.FifoQueue, true);
  assert.equal(dlq.Properties.SqsManagedSseEnabled, true);
  assert.equal(dlq.Properties.MessageRetentionPeriod, 1_209_600);

  assert.equal(queue.Type, 'AWS::SQS::Queue');
  assert.deepEqual(queue.Properties.QueueName, {
    'Fn::Sub': '${Environment}-${FaqTableNamespace}-slack-events.fifo',
  });
  assert.equal(queue.Properties.FifoQueue, true);
  assert.equal(queue.Properties.SqsManagedSseEnabled, true);
  assert.equal(queue.Properties.MessageRetentionPeriod, 345_600);
  assert.equal(
    queue.Properties.VisibilityTimeout >= worker.Properties.Timeout * 6,
    true,
    'queue visibility must be at least six times worker timeout'
  );
  assert.deepEqual(queue.Properties.RedrivePolicy, {
    deadLetterTargetArn: { 'Fn::GetAtt': ['SlackEventDLQ', 'Arn'] },
    maxReceiveCount: 5,
  });

  const sqsEvents = Object.values(worker.Properties.Events).filter(
    (event) => event.Type === 'SQS'
  );
  assert.equal(sqsEvents.length, 1);
  assert.deepEqual(sqsEvents[0].Properties, {
    Queue: { 'Fn::GetAtt': ['SlackEventQueue', 'Arn'] },
    BatchSize: 1,
  });
  assert.equal(Number(worker.Properties.Environment.Variables.QUEUE_MAX_RECEIVE_COUNT), 5);
  assert.equal(
    Number(worker.Properties.Environment.Variables.QUEUE_MAX_RECEIVE_COUNT),
    queue.Properties.RedrivePolicy.maxReceiveCount
  );
});

test('Slack idempotency and QA tables match the entrypoint writers and enable TTL', () => {
  const contracts = [
    {
      logicalId: 'SlackEventIdempotencyTable',
      suffix: 'SlackEventIdempotency',
      key: 'idempotencyKey',
    },
    {
      logicalId: 'SlackQaLogsTable',
      suffix: 'SlackQaLogs',
      key: 'sourceEventId',
    },
  ];

  for (const contract of contracts) {
    const table = getResource(contract.logicalId);
    assert.equal(table.Type, 'AWS::DynamoDB::Table');
    assert.deepEqual(table.Properties.TableName, {
      'Fn::Sub': `\${Environment}-\${FaqTableNamespace}-${contract.suffix}`,
    });
    assert.equal(table.Properties.BillingMode, 'PAY_PER_REQUEST');
    assert.deepEqual(table.Properties.AttributeDefinitions, [
      { AttributeName: contract.key, AttributeType: 'S' },
    ]);
    assert.deepEqual(table.Properties.KeySchema, [
      { AttributeName: contract.key, KeyType: 'HASH' },
    ]);
    assert.deepEqual(table.Properties.TimeToLiveSpecification, {
      AttributeName: 'ttl',
      Enabled: true,
    });
  }
});

test('dedicated Slack roles contain only exact inline least-privilege permissions', () => {
  const ingressRole = getResource('SlackIngressRole');
  const workerRole = getResource('SlackWorkerRole');
  for (const [logicalId, role] of [
    ['SlackIngressRole', ingressRole],
    ['SlackWorkerRole', workerRole],
  ]) {
    assert.equal(role.Type, 'AWS::IAM::Role');
    assertLambdaTrustPolicy(role, logicalId);
    const managedPolicies = role.Properties.ManagedPolicyArns ?? [];
    assert.equal(managedPolicies.length, 1);
    assert.match(JSON.stringify(managedPolicies[0]), /AWSLambdaBasicExecutionRole/u);
    assert.doesNotMatch(JSON.stringify(managedPolicies), /AWSLambdaSQSQueueExecutionRole/u);
    assertNoWildcards(permissionStatements(role), logicalId);
  }

  const ingressStatements = permissionStatements(ingressRole);
  assert.deepEqual(
    permissionPairs(ingressStatements),
    expectedPermissionPairs([['sqs:SendMessage', 'SlackEventQueue']])
  );

  const workerStatements = permissionStatements(workerRole);
  assert.deepEqual(
    permissionPairs(workerStatements),
    expectedPermissionPairs([
      ['dynamodb:GetItem', 'AgentConfigTable'],
      ['dynamodb:Scan', 'KnowledgeEntriesTable'],
      ['dynamodb:GetItem', 'SlackEventIdempotencyTable'],
      ['dynamodb:PutItem', 'SlackEventIdempotencyTable'],
      ['dynamodb:UpdateItem', 'SlackEventIdempotencyTable'],
      ['dynamodb:PutItem', 'SlackQaLogsTable'],
      ['dynamodb:UpdateItem', 'SlackQaLogsTable'],
      ['sqs:ReceiveMessage', 'SlackEventQueue'],
      ['sqs:DeleteMessage', 'SlackEventQueue'],
      ['sqs:GetQueueAttributes', 'SlackEventQueue'],
    ])
  );

  const ingress = getResource('SlackIngressFunction');
  const worker = getResource('SlackWorkerFunction');
  assert.deepEqual(ingress.Properties.Role, {
    'Fn::GetAtt': ['SlackIngressRole', 'Arn'],
  });
  assert.deepEqual(worker.Properties.Role, {
    'Fn::GetAtt': ['SlackWorkerRole', 'Arn'],
  });
  assert.equal(Object.hasOwn(ingress.Properties, 'Policies'), false);
  assert.equal(Object.hasOwn(worker.Properties, 'Policies'), false);
});

test('Slack ingress retains its throttle independently of FAQ and its exact public entrypoint', () => {
  const routeSettings = template.Resources.FaqHttpApi.Properties.RouteSettings;
  // Slack無効時はrouteが生成されないため、stage設定もFn::IfでAWS::NoValueへ落とす
  // （存在しないrouteへのRouteSettings残留を防ぐ / レビュー指摘）。
  const slackRouteSetting = routeSettings['POST /slack/events'];
  assert.deepEqual(Object.keys(slackRouteSetting), ['Fn::If']);
  const [conditionName, enabledBranch, disabledBranch] = slackRouteSetting['Fn::If'];
  assert.equal(conditionName, 'HasSlackAgent');
  assert.deepEqual(enabledBranch, { ThrottlingBurstLimit: 5, ThrottlingRateLimit: 2 });
  assert.deepEqual(disabledBranch, { Ref: 'AWS::NoValue' });

  const ingress = getResource('SlackIngressFunction');
  assert.equal(ingress.Type, 'AWS::Serverless::Function');
  assert.equal(ingress.Properties.CodeUri, 'functions/slack-ingress/');
  assert.equal(ingress.Properties.Handler, 'handler.handler');
  const httpEvents = Object.values(ingress.Properties.Events).filter(
    (event) => event.Type === 'HttpApi'
  );
  assert.equal(httpEvents.length, 1);
  assert.deepEqual(httpEvents[0].Properties, {
    ApiId: { Ref: 'FaqHttpApi' },
    Path: '/slack/events',
    Method: 'POST',
  });

  const worker = getResource('SlackWorkerFunction');
  assert.equal(worker.Type, 'AWS::Serverless::Function');
  assert.equal(worker.Properties.CodeUri, 'functions/slack-agent-worker/');
  assert.equal(worker.Properties.Handler, 'handler.handler');
});

test('Slack DLQ alarm reports one visible failed event', () => {
  const alarm = getResource('SlackEventDLQAlarm');
  assert.equal(alarm.Type, 'AWS::CloudWatch::Alarm');
  assert.deepEqual(alarm.Properties.AlarmName, {
    'Fn::Sub': '${Environment}-${FaqTableNamespace}-slack-events-dlq-not-empty',
  });
  assert.equal(alarm.Properties.Namespace, 'AWS/SQS');
  assert.equal(alarm.Properties.MetricName, 'ApproximateNumberOfMessagesVisible');
  assert.deepEqual(alarm.Properties.Dimensions, [
    {
      Name: 'QueueName',
      Value: { 'Fn::GetAtt': ['SlackEventDLQ', 'QueueName'] },
    },
  ]);
  assert.equal(alarm.Properties.Statistic, 'Maximum');
  assert.equal(alarm.Properties.Period, 300);
  assert.equal(alarm.Properties.EvaluationPeriods, 1);
  assert.equal(alarm.Properties.DatapointsToAlarm, 1);
  assert.equal(alarm.Properties.Threshold, 1);
  assert.equal(alarm.Properties.ComparisonOperator, 'GreaterThanOrEqualToThreshold');
  assert.equal(alarm.Properties.TreatMissingData, 'notBreaching');
});

test('conditional Slack outputs expose exact queue, tables, and ingress path', () => {
  const declaredSlackOutputs = Object.keys(template.Outputs)
    .filter((logicalId) => logicalId.startsWith('Slack'))
    .sort();
  assert.deepEqual(
    declaredSlackOutputs,
    [...SLACK_OUTPUTS, ...UNCONDITIONAL_SLACK_OUTPUTS].sort()
  );
  for (const logicalId of SLACK_OUTPUTS) {
    assert.equal(template.Outputs[logicalId].Condition, 'HasSlackAgent');
  }
  assert.deepEqual(template.Outputs.SlackEventQueueUrl.Value, {
    Ref: 'SlackEventQueue',
  });
  assert.deepEqual(template.Outputs.SlackEventIdempotencyTableName.Value, {
    Ref: 'SlackEventIdempotencyTable',
  });
  assert.deepEqual(template.Outputs.SlackQaLogsTableName.Value, {
    Ref: 'SlackQaLogsTable',
  });
  assert.equal(template.Outputs.SlackIngressEndpointPath.Value, '/slack/events');
});


test('SlackQaLogsTable keeps the FAQ retention policy; idempotency stays disposable', () => {
  // Slackを一時停止（パラメータを空に）した瞬間にQAログ表ごと削除されないよう、
  // FAQ 4表と同じ保持ポリシーを持つ（レビュー指摘）。
  const qaLogs = getResource('SlackQaLogsTable');
  assert.equal(qaLogs.DeletionPolicy, 'RetainExceptOnCreate');
  assert.equal(qaLogs.UpdateReplacePolicy, 'Retain');
  // 常設（条件なし）: 条件付き+Retainの再有効化CREATE衝突を構造的に避ける。
  assert.equal(Object.hasOwn(qaLogs, 'Condition'), false);
  // 冪等性レコードは再作成可能な一時データなので、意図的に保持ポリシーを付けない。
  const idempotency = getResource('SlackEventIdempotencyTable');
  assert.equal(Object.hasOwn(idempotency, 'DeletionPolicy'), false);
  assert.equal(Object.hasOwn(idempotency, 'UpdateReplacePolicy'), false);
});

test('Slack disabled leaves no unconditional Slack remnants in the stack surface', () => {
  // Resources/Outputsは全てHasSlackAgent条件付き（既存テスト）に加えて、
  // RouteSettings以外のstage面にもSlack残留物が無いことを固定する。
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (!logicalId.startsWith('Slack')) continue;
    if (UNCONDITIONAL_SLACK_DATA_RESOURCES.includes(logicalId)) {
      assert.equal(Object.hasOwn(resource, 'Condition'), false, logicalId);
      continue;
    }
    assert.equal(resource.Condition, 'HasSlackAgent', logicalId);
  }
  for (const [outputId, output] of Object.entries(template.Outputs)) {
    if (!outputId.startsWith('Slack')) continue;
    if (UNCONDITIONAL_SLACK_OUTPUTS.includes(outputId)) {
      assert.equal(Object.hasOwn(output, 'Condition'), false, outputId);
      continue;
    }
    assert.equal(output.Condition, 'HasSlackAgent', outputId);
  }
  const routeSettings = template.Resources.FaqHttpApi.Properties.RouteSettings;
  for (const [routeKey, setting] of Object.entries(routeSettings)) {
    if (!routeKey.includes('slack')) continue;
    assert.deepEqual(Object.keys(setting), ['Fn::If'], routeKey);
    assert.equal(setting['Fn::If'][0], 'HasSlackAgent', routeKey);
  }
});
