#!/usr/bin/env node
/** Parsed CloudFormation contract tests for the public lite remote profile. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, '..', 'template.yaml');
const templateSource = fs.readFileSync(TEMPLATE, 'utf8');

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

function parameterAllows(parameter, value) {
  if (parameter.MinLength !== undefined && value.length < parameter.MinLength) return false;
  if (parameter.MaxLength !== undefined && value.length > parameter.MaxLength) return false;
  return parameter.AllowedPattern === undefined || new RegExp(parameter.AllowedPattern, 'u').test(value);
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

function actions(statement) {
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

function resources(statement) {
  return Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
}

function renderParameterSub(expression, parameters) {
  assert.equal(
    typeof expression?.['Fn::Sub'],
    'string',
    `expected scalar Fn::Sub, got ${JSON.stringify(expression)}`
  );
  const rendered = expression['Fn::Sub'].replace(
    /\$\{([A-Za-z][A-Za-z0-9]*)\}/gu,
    (match, name) => {
      assert.equal(
        Object.hasOwn(parameters, name),
        true,
        `Fn::Sub parameter ${name} must be provided`
      );
      return String(parameters[name]);
    }
  );
  assert.doesNotMatch(rendered, /\$\{/u, 'all parameter references must be resolved');
  return rendered;
}

const TABLE_CONTRACTS = [
  {
    logicalId: 'SettingsTable',
    suffix: 'Settings',
    environmentName: 'FAQ_SETTINGS_TABLE_NAME',
    action: 'dynamodb:GetItem',
    outputName: 'FaqSettingsTableName',
  },
  {
    logicalId: 'AgentConfigTable',
    suffix: 'AgentConfig',
    environmentName: 'FAQ_AGENT_CONFIG_TABLE_NAME',
    action: 'dynamodb:GetItem',
    outputName: 'FaqAgentConfigTableName',
  },
  {
    logicalId: 'KnowledgeEntriesTable',
    suffix: 'KnowledgeEntries',
    environmentName: 'FAQ_KNOWLEDGE_ENTRIES_TABLE_NAME',
    action: 'dynamodb:Scan',
    outputName: 'FaqKnowledgeEntriesTableName',
  },
  {
    logicalId: 'FaqQaLogsTable',
    suffix: 'FaqQaLogs',
    environmentName: 'FAQ_QA_LOGS_TABLE_NAME',
    action: 'dynamodb:PutItem',
    outputName: 'FaqQaLogsTableName',
  },
];

test('lite template parses with CloudFormation short tags preserved', () => {
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

test('FAQ table namespace accepts only bounded lowercase alphanumeric and hyphen values', () => {
  const namespace = template.Parameters.FaqTableNamespace;
  assert.equal(namespace.Type, 'String');
  assert.equal(namespace.Default, 'lite');
  assert.equal(namespace.MinLength, 1);
  assert.equal(namespace.MaxLength, 32);

  for (const value of ['a', 'candidate', 'candidate-2', 'a--b', 'a'.repeat(32)]) {
    assert.equal(parameterAllows(namespace, value), true, `${value} must be accepted`);
  }
  for (const value of [
    '',
    '-candidate',
    'candidate-',
    'Candidate',
    'candidate_2',
    'candidate 2',
    'a'.repeat(33),
  ]) {
    assert.equal(parameterAllows(namespace, value), false, `${value} must be rejected`);
  }
});

test('prod candidate creates four unconditional retained tables with isolated physical names', () => {
  const parameters = withParameterDefaults({
    Environment: 'prod',
    FaqTableNamespace: 'candidate',
  });
  const tableLogicalIds = Object.entries(template.Resources)
    .filter(
      ([logicalId, resource]) =>
        resource.Type === 'AWS::DynamoDB::Table' &&
        !Object.hasOwn(resource, 'Condition') &&
        // SlackQaLogsTableはFAQ契約外の常設データ表（再有効化CREATE衝突の回避で無条件化。
        // 検証は slack-lite-template.test.mjs 側）。
        logicalId !== 'SlackQaLogsTable'
    )
    .map(([logicalId]) => logicalId)
    .sort();
  assert.deepEqual(
    tableLogicalIds,
    TABLE_CONTRACTS.map(({ logicalId }) => logicalId).sort()
  );

  for (const contract of TABLE_CONTRACTS) {
    const resource = template.Resources[contract.logicalId];
    assert.equal(resource.Type, 'AWS::DynamoDB::Table');
    assert.equal(
      renderParameterSub(resource.Properties.TableName, parameters),
      `prod-candidate-${contract.suffix}`
    );
    assert.equal(Object.hasOwn(resource, 'Condition'), false);
    assert.equal(resource.DeletionPolicy, 'RetainExceptOnCreate');
    assert.equal(resource.UpdateReplacePolicy, 'Retain');
    assert.equal(resource.Properties.BillingMode, 'PAY_PER_REQUEST');
  }

  const agentConfig = template.Resources.AgentConfigTable.Properties;
  assert.deepEqual(agentConfig.AttributeDefinitions, [
    { AttributeName: 'agentId', AttributeType: 'S' },
  ]);
  assert.deepEqual(agentConfig.KeySchema, [
    { AttributeName: 'agentId', KeyType: 'HASH' },
  ]);

  const qaLogs = template.Resources.FaqQaLogsTable.Properties;
  assert.deepEqual(qaLogs.TimeToLiveSpecification, {
    AttributeName: 'ttl',
    Enabled: true,
  });
  assert.equal(Object.hasOwn(qaLogs, 'StreamSpecification'), false);
});

test('FaqChatFunction receives the exact candidate table names without the legacy global prefix', () => {
  const globalVariables = template.Globals.Function.Environment.Variables;
  assert.equal(Object.hasOwn(globalVariables, 'DYNAMODB_TABLE_PREFIX'), false);

  const variables = template.Resources.FaqChatFunction.Properties.Environment.Variables;
  assert.equal(Object.hasOwn(variables, 'DYNAMODB_TABLE_PREFIX'), false);
  assert.deepEqual(variables.FAQ_TABLE_NAME_PREFIX, {
    'Fn::Sub': '${Environment}-${FaqTableNamespace}',
  });
  assert.equal(
    renderParameterSub(
      variables.FAQ_TABLE_NAME_PREFIX,
      withParameterDefaults({ Environment: 'prod', FaqTableNamespace: 'candidate' })
    ),
    'prod-candidate'
  );
  for (const contract of TABLE_CONTRACTS) {
    assert.deepEqual(variables[contract.environmentName], { Ref: contract.logicalId });
  }
});

test('FAQ DynamoDB IAM maps each allowed action to exactly the required table ARNs', () => {
  const policies = template.Resources.FaqChatFunction.Properties.Policies;
  const statements = collectStatements(policies);
  const dynamodbStatements = statements.filter((statement) =>
    actions(statement).some((action) => action.startsWith('dynamodb:'))
  );
  const expectedActions = [...new Set(TABLE_CONTRACTS.map(({ action }) => action))];
  assert.equal(dynamodbStatements.length, expectedActions.length);

  for (const action of expectedActions) {
    const matchingStatements = dynamodbStatements.filter((statement) =>
      actions(statement).includes(action)
    );
    assert.equal(matchingStatements.length, 1, `${action} must have one statement`);
    const [statement] = matchingStatements;
    assert.equal(statement.Effect, 'Allow');
    assert.deepEqual(actions(statement), [action]);
    assert.deepEqual(
      resources(statement),
      TABLE_CONTRACTS.filter((contract) => contract.action === action).map(
        ({ logicalId }) => ({ 'Fn::GetAtt': [logicalId, 'Arn'] })
      )
    );
  }

  const allActions = statements.flatMap(actions).sort();
  assert.deepEqual(allActions, [
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:Scan',
    'sts:AssumeRole',
  ]);
  for (const forbiddenAction of [
    'dynamodb:DeleteItem',
    'dynamodb:UpdateItem',
    'dynamodb:BatchWriteItem',
  ]) {
    assert.equal(allActions.includes(forbiddenAction), false);
  }
  assert.equal(allActions.some((action) => action.includes('*')), false);
  assert.doesNotMatch(JSON.stringify(policies), /\*/u);
});

test('candidate table, environment, and IAM contracts contain no canonical prod table names', () => {
  const variables = template.Resources.FaqChatFunction.Properties.Environment.Variables;
  const dynamodbStatements = collectStatements(
    template.Resources.FaqChatFunction.Properties.Policies
  ).filter((statement) => actions(statement).some((action) => action.startsWith('dynamodb:')));
  const dataPlaneContract = JSON.stringify({
    tableNames: TABLE_CONTRACTS.map(
      ({ logicalId }) => template.Resources[logicalId].Properties.TableName
    ),
    variables,
    dynamodbStatements,
  });

  for (const { suffix } of TABLE_CONTRACTS) {
    assert.equal(dataPlaneContract.includes(`prod-${suffix}`), false);
    assert.equal(dataPlaneContract.includes('${Environment}-' + suffix), false);
  }
});

test('four table-name outputs expose the created candidate table resources', () => {
  const tableOutputNames = Object.keys(template.Outputs)
    .filter((name) => name.startsWith('Faq') && name.endsWith('TableName'))
    .sort();
  assert.deepEqual(
    tableOutputNames,
    TABLE_CONTRACTS.map(({ outputName }) => outputName).sort()
  );
  for (const contract of TABLE_CONTRACTS) {
    assert.deepEqual(template.Outputs[contract.outputName].Value, {
      Ref: contract.logicalId,
    });
  }
});

test('named FAQ route uses the same throttle limits and Lambda as the default route', () => {
  const routeSettings = template.Resources.FaqHttpApi.Properties.RouteSettings;
  assert.deepEqual(
    routeSettings['POST /agents/{agentId}/faq-chat'],
    routeSettings['POST /faq-chat']
  );

  const events = template.Resources.FaqChatFunction.Properties.Events;
  assert.deepEqual(events.FaqAgentChatApi.Properties, {
    ApiId: { Ref: 'FaqHttpApi' },
    Path: '/agents/{agentId}/faq-chat',
    Method: 'POST',
  });
  assert.deepEqual(events.FaqAgentChatOptions.Properties, {
    ApiId: { Ref: 'FaqHttpApi' },
    Path: '/agents/{agentId}/faq-chat',
    Method: 'OPTIONS',
  });
});

test('remote profile parameters retain exact choices and deployment-safe constraints', () => {
  const profile = template.Parameters.FaqPortsProfile;
  assert.equal(profile.Default, 'free');
  assert.deepEqual(profile.AllowedValues, ['free', 'remote']);

  const baseUrl = template.Parameters.FaqRemoteRagBaseUrl;
  const roleArn = template.Parameters.FaqRemoteRagRoleArn;
  const externalId = template.Parameters.FaqRemoteRagExternalId;
  for (const parameter of [baseUrl, roleArn, externalId]) {
    assert.equal(parameter.Type, 'String');
    assert.equal(parameter.Default, '');
    assert.equal(parameterAllows(parameter, ''), true);
  }
  assert.equal(externalId.NoEcho, true);

  assert.equal(parameterAllows(baseUrl, 'https://rag.example.test/prod'), true);
  assert.equal(parameterAllows(baseUrl, 'http://rag.example.test/prod'), false);
  assert.equal(parameterAllows(baseUrl, 'https://rag.example.test/has space'), false);

  assert.equal(
    parameterAllows(roleArn, 'arn:aws:iam::123456789012:role/mif/remote-rag-invoker'),
    true
  );
  assert.equal(parameterAllows(roleArn, 'arn:aws:iam::123456789012:role/*'), false);
  assert.equal(parameterAllows(roleArn, 'arn:aws:iam::123456789012:user/remote-rag'), false);

  assert.equal(parameterAllows(externalId, 'tenant-01:/remote'), true);
  assert.equal(parameterAllows(externalId, 'x'), false);
  assert.equal(parameterAllows(externalId, 'tenant id'), false);
  assert.equal(parameterAllows(externalId, 'x'.repeat(1225)), false);
});

test('CloudFormation Rules require all remote values and reject half-paired credentials', () => {
  const completeRemote = {
    FaqPortsProfile: 'remote',
    FaqRemoteRagBaseUrl: 'https://rag.example.test/prod',
    FaqRemoteRagRoleArn: 'arn:aws:iam::123456789012:role/mif-remote-rag-invoker',
    FaqRemoteRagExternalId: 'tenant-01',
  };

  assert.deepEqual(ruleFailures({ FaqPortsProfile: 'free' }), []);
  assert.deepEqual(ruleFailures(completeRemote), []);
  for (const parameterName of [
    'FaqRemoteRagBaseUrl',
    'FaqRemoteRagRoleArn',
    'FaqRemoteRagExternalId',
  ]) {
    assert.notDeepEqual(
      ruleFailures({ ...completeRemote, [parameterName]: '' }),
      [],
      `remote must reject an empty ${parameterName}`
    );
  }
  assert.notDeepEqual(
    ruleFailures({
      FaqPortsProfile: 'free',
      FaqRemoteRagRoleArn: completeRemote.FaqRemoteRagRoleArn,
    }),
    [],
    'RoleArn without ExternalId must be rejected'
  );
  assert.notDeepEqual(
    ruleFailures({
      FaqPortsProfile: 'free',
      FaqRemoteRagExternalId: completeRemote.FaqRemoteRagExternalId,
    }),
    [],
    'ExternalId without RoleArn must be rejected'
  );
  // remote 3値が揃っていても profile=free なら拒否する（free の字句検索で静かに動く事故を防ぐ）。
  assert.notDeepEqual(
    ruleFailures({
      FaqPortsProfile: 'free',
      FaqRemoteRagBaseUrl: completeRemote.FaqRemoteRagBaseUrl,
      FaqRemoteRagRoleArn: completeRemote.FaqRemoteRagRoleArn,
      FaqRemoteRagExternalId: completeRemote.FaqRemoteRagExternalId,
    }),
    [],
    'remote values with FaqPortsProfile=free must be rejected (no silent free fallback)'
  );
});

test('FaqChatFunction wires exact remote env names and only conditional exact-role AssumeRole', () => {
  const faqFunction = template.Resources.FaqChatFunction;
  const variables = faqFunction.Properties.Environment.Variables;
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(variables).filter(([name]) => name.startsWith('FAQ_REMOTE_RAG_'))
    ),
    {
      FAQ_REMOTE_RAG_BASE_URL: { Ref: 'FaqRemoteRagBaseUrl' },
      FAQ_REMOTE_RAG_ROLE_ARN: { Ref: 'FaqRemoteRagRoleArn' },
      FAQ_REMOTE_RAG_EXTERNAL_ID: { Ref: 'FaqRemoteRagExternalId' },
    }
  );
  assert.deepEqual(variables.FAQ_PORTS_PROFILE, { Ref: 'FaqPortsProfile' });

  const statements = collectStatements(faqFunction.Properties.Policies);
  const assumeRoleStatements = statements.filter((statement) =>
    actions(statement).includes('sts:AssumeRole')
  );
  assert.equal(assumeRoleStatements.length, 1);
  assert.equal(assumeRoleStatements[0].Effect, 'Allow');
  assert.deepEqual(actions(assumeRoleStatements[0]), ['sts:AssumeRole']);
  assert.deepEqual(assumeRoleStatements[0].Resource, { Ref: 'FaqRemoteRagRoleArn' });
  assert.doesNotMatch(JSON.stringify(assumeRoleStatements[0].Resource), /\*/u);
  const allActions = statements.flatMap(actions);
  assert.equal(allActions.some((action) => action.includes('*')), false);
  assert.equal(
    allActions.some((action) => action.startsWith('execute-api:')),
    false
  );
  assert.equal(Object.hasOwn(template.Parameters, 'FaqRemoteRagApiId'), false);

  const assumeRolePolicy = faqFunction.Properties.Policies.find((policy) => {
    const conditional = policy?.['Fn::If'];
    return (
      conditional !== undefined &&
      collectStatements(conditional[1]).some((statement) =>
        actions(statement).includes('sts:AssumeRole')
      )
    );
  });
  assert.ok(assumeRolePolicy, 'AssumeRole policy must be guarded by Fn::If');
  const conditionName = assumeRolePolicy['Fn::If'][0];
  const condition = template.Conditions[conditionName];
  assert.ok(condition, `${conditionName} must be a declared condition`);
  assert.equal(
    evaluate(
      condition,
      withParameterDefaults({
        FaqPortsProfile: 'remote',
        FaqRemoteRagRoleArn: 'arn:aws:iam::123456789012:role/mif-remote-rag-invoker',
      })
    ),
    true
  );
  assert.equal(
    evaluate(
      condition,
      withParameterDefaults({
        FaqPortsProfile: 'free',
        FaqRemoteRagRoleArn: 'arn:aws:iam::123456789012:role/mif-remote-rag-invoker',
      })
    ),
    false
  );
  assert.equal(
    evaluate(
      condition,
      withParameterDefaults({ FaqPortsProfile: 'remote', FaqRemoteRagRoleArn: '' })
    ),
    false
  );
});

test('caller role output exposes the SAM-generated FaqChatFunction role ARN', () => {
  assert.deepEqual(template.Outputs.FaqChatCallerRoleArn.Value, {
    'Fn::GetAtt': ['FaqChatFunctionRole', 'Arn'],
  });
});
