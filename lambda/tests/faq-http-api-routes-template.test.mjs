/** Legacy HTTP FAQ controls must preserve the default SAM output and Slack. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parseDocument } from 'yaml';

const document = parseDocument(fs.readFileSync(new URL('../template.yaml', import.meta.url), 'utf8'), {
  customTags: [
    ...[['Ref', 'Ref'], ['Sub', 'Fn::Sub'], ['GetAtt', 'Fn::GetAtt']].map(([tag, name]) => ({
      tag: `!${tag}`, resolve: (value) => ({ [name]: tag === 'GetAtt' ? value.split('.') : value }),
    })),
    ...['And', 'Equals', 'If', 'Not', 'Or', 'Sub'].map((tag) => ({
      tag: `!${tag}`, collection: 'seq', resolve: (sequence) => ({
        [`Fn::${tag}`]: sequence.items.map((item) => item.toJSON()),
      }),
    })),
  ], uniqueKeys: true,
});
const template = document.toJS({ maxAliasCount: 0 });
const condition = 'HasFaqHttpApiFaqRoutes';
const enabledParameter = 'FaqHttpApiFaqRoutesEnabled';
const keepRouteRule = 'FaqHttpApiMustKeepARoute';
const rateParameter = 'FaqHttpApiFaqThrottlingRateLimit';
const burstParameter = 'FaqHttpApiFaqThrottlingBurstLimit';
const faqPaths = ['/faq-chat', '/agents/{agentId}/faq-chat'];
const eventContracts = [
  ['FaqChatApi', '/faq-chat', 'POST'],
  ['FaqChatOptions', '/faq-chat', 'OPTIONS'],
  ['FaqAgentChatApi', '/agents/{agentId}/faq-chat', 'POST'],
  ['FaqAgentChatOptions', '/agents/{agentId}/faq-chat', 'OPTIONS'],
];
const permissionNames = eventContracts.map(([name]) => `FaqChatFunction${name}Permission`);
const noValue = Symbol('AWS::NoValue');

function defaults(overrides = {}, input = template) {
  return {
    ...Object.fromEntries(Object.entries(input.Parameters).map(([name, parameter]) => [name, parameter.Default])),
    ...overrides,
  };
}

function resolve(value, parameters, input = template) {
  if (Array.isArray(value)) return value.map((item) => resolve(item, parameters, input))
    .filter((item) => item !== noValue);
  if (value === null || typeof value !== 'object') return value;
  if ('Ref' in value) {
    if (value.Ref === 'AWS::NoValue') return noValue;
    return Object.hasOwn(parameters, value.Ref) ? parameters[value.Ref] : value;
  }
  if ('Fn::Equals' in value) {
    const [left, right] = resolve(value['Fn::Equals'], parameters, input);
    return String(left) === String(right);
  }
  if ('Fn::Not' in value) return !resolve(value['Fn::Not'][0], parameters, input);
  if ('Fn::And' in value) return resolve(value['Fn::And'], parameters, input).every(Boolean);
  if ('Fn::Or' in value) return resolve(value['Fn::Or'], parameters, input).some(Boolean);
  if ('Fn::If' in value) {
    const [name, yes, no] = value['Fn::If'];
    assert.ok(Object.hasOwn(input.Conditions, name), `unknown condition: ${name}`);
    return resolve(resolve(input.Conditions[name], parameters, input) ? yes : no, parameters, input);
  }
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, resolve(item, parameters, input)])
    .filter(([, item]) => item !== noValue));
}

function effectiveSection(input, section, overrides = {}) {
  const parameters = defaults(overrides, input);
  return Object.fromEntries(Object.entries(input[section]).filter(([, resource]) =>
    !resource.Condition || resolve(input.Conditions[resource.Condition], parameters, input))
    .map(([name, resource]) => {
      const resolved = resolve(resource, parameters, input);
      delete resolved.Condition;
      return [name, resolved];
    }));
}

function priorTemplate() {
  // Reconstruct the pre-control template rather than duplicating a transformed fixture.
  // The real SAM transform below detects drift in routes, generated IDs, IAM or CORS.
  const prior = structuredClone(template);
  for (const name of [enabledParameter, rateParameter, burstParameter]) delete prior.Parameters[name];
  delete prior.Rules[keepRouteRule];
  delete prior.Conditions[condition];
  delete prior.Resources.FaqHttpApi.Properties.DefinitionBody;
  for (const path of faqPaths) {
    prior.Resources.FaqHttpApi.Properties.RouteSettings[`POST ${path}`] = {
      ThrottlingBurstLimit: 5, ThrottlingRateLimit: 2,
    };
  }
  prior.Resources.FaqChatFunction.Properties.Events = Object.fromEntries(eventContracts.map(([name, path, method]) => [
    name, { Type: 'HttpApi', Properties: { ApiId: { Ref: 'FaqHttpApi' }, Path: path, Method: method } },
  ]));
  for (const name of permissionNames) delete prior.Resources[name];
  return prior;
}

test('HTTP FAQ controls keep all four buffered routes and the previous limits by default', () => {
  assert.deepEqual(document.errors, []);
  assert.deepEqual(document.warnings, []);
  assert.equal(template.Parameters[enabledParameter].Type, 'String');
  assert.equal(template.Parameters[enabledParameter].Default, 'true');
  assert.deepEqual([...template.Parameters[enabledParameter].AllowedValues].sort(), ['false', 'true']);
  assert.deepEqual(template.Conditions[condition], { 'Fn::Equals': [{ Ref: enabledParameter }, 'true'] });
  const effective = effectiveSection(template, 'Resources');
  const properties = effective.FaqHttpApi.Properties;
  for (const path of faqPaths) {
    assert.deepEqual(properties.RouteSettings[`POST ${path}`], { ThrottlingBurstLimit: 5, ThrottlingRateLimit: 2 });
    assert.deepEqual(Object.keys(properties.DefinitionBody.paths[path]).sort(), ['options', 'post']);
    for (const method of ['post', 'options']) {
      const operation = properties.DefinitionBody.paths[path][method];
      assert.deepEqual(operation.responses, {});
      assert.deepEqual(operation['x-amazon-apigateway-integration'], {
        httpMethod: 'POST', type: 'aws_proxy', payloadFormatVersion: '2.0',
        uri: { 'Fn::Sub': 'arn:${AWS::Partition}:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${FaqChatFunction.Arn}/invocations' },
      });
      assert.deepEqual(operation.parameters, path.includes('{agentId}')
        ? [{ required: true, name: 'agentId', in: 'path' }] : undefined);
    }
  }
  assert.equal(template.Resources.FaqChatFunction.Properties.Events, undefined,
    'unconditional SAM events would recreate disabled routes');
});

test('HTTP FAQ disablement requires a Slack route to keep the HTTP API nonempty', () => {
  const rule = template.Rules[keepRouteRule];
  assert.deepEqual(rule.RuleCondition, { 'Fn::Equals': [{ Ref: enabledParameter }, 'false'] });
  assert.equal(rule.Assertions.length, 1);
  assert.deepEqual(rule.Assertions[0].Assert, {
    'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'SlackSigningSecret' }, ''] }],
  });
  for (const routesEnabled of ['false', 'true']) {
    for (const slackSecret of ['', 'unit-test-slack-secret']) {
      const parameters = defaults({ [enabledParameter]: routesEnabled, SlackSigningSecret: slackSecret });
      const accepted = !resolve(rule.RuleCondition, parameters)
        || rule.Assertions.every((assertion) => resolve(assertion.Assert, parameters));
      assert.equal(accepted, routesEnabled === 'true' || slackSecret !== '',
        `FAQ enabled=${routesEnabled}, Slack enabled=${slackSecret !== ''}`);
    }
  }
});

test('HTTP FAQ disablement removes routes, limits and permissions while preserving Slack and caller identity', () => {
  const overrides = { SlackSigningSecret: 'unit-test-slack-secret' };
  const enabled = effectiveSection(template, 'Resources', overrides);
  const disabled = effectiveSection(template, 'Resources', { ...overrides, [enabledParameter]: 'false' });
  for (const path of faqPaths) {
    assert.equal(path in disabled.FaqHttpApi.Properties.DefinitionBody.paths, false);
    assert.equal(`POST ${path}` in disabled.FaqHttpApi.Properties.RouteSettings, false);
  }
  for (const name of permissionNames) {
    assert.ok(enabled[name], name);
    assert.equal(name in disabled, false, name);
    assert.equal(template.Resources[name].Condition, condition);
  }
  assert.deepEqual(disabled.FaqChatFunction, enabled.FaqChatFunction);
  assert.equal(template.Resources.FaqChatFunction.Condition, undefined,
    'keep the SAM-generated IAM role stable across rollback and external trust policies');
  assert.deepEqual(disabled.FaqHttpApi.Properties.DefinitionBody.paths['/slack/events'],
    enabled.FaqHttpApi.Properties.DefinitionBody.paths['/slack/events']);
  assert.deepEqual(disabled.FaqHttpApi.Properties.RouteSettings['POST /slack/events'],
    { ThrottlingBurstLimit: 5, ThrottlingRateLimit: 2 });
  for (const name of ['SlackIngressFunction', 'SlackWorkerFunction']) {
    assert.deepEqual(disabled[name], enabled[name], name);
  }
  assert.deepEqual(effectiveSection(template, 'Outputs', { ...overrides, [enabledParameter]: 'false' }),
    effectiveSection(template, 'Outputs', overrides));
  assert.deepEqual(template.Outputs.FaqChatCallerRoleArn.Value, { 'Fn::GetAtt': ['FaqChatFunctionRole', 'Arn'] });
  assert.equal(template.Outputs.FaqApiUrl.Condition, undefined);
  assert.equal(template.Outputs.FaqChatCallerRoleArn.Condition, undefined);
});

test('FAQ rate and burst accept only integers 1 through 100 and do not throttle Slack or REST', () => {
  for (const [name, previous] of [[rateParameter, 2], [burstParameter, 5]]) {
    const parameter = template.Parameters[name];
    assert.equal(parameter.Type, 'Number');
    assert.equal(parameter.Default, previous);
    assert.equal(parameter.MinValue, 1);
    assert.equal(parameter.MaxValue, 100);
    assert.equal(parameter.AllowedPattern, undefined, 'CloudFormation Number does not support AllowedPattern');
    assert.deepEqual(parameter.AllowedValues, Array.from({ length: 100 }, (_, index) => index + 1));
    for (const invalid of [-1, 0, 0.5, 1.5, 99.9, 101]) {
      assert.equal(parameter.AllowedValues.includes(invalid), false, `${name}: ${invalid}`);
    }
  }
  for (const path of faqPaths) {
    assert.deepEqual(template.Resources.FaqHttpApi.Properties.RouteSettings[`POST ${path}`], {
      'Fn::If': [condition, {
        ThrottlingBurstLimit: { Ref: burstParameter }, ThrottlingRateLimit: { Ref: rateParameter },
      }, { Ref: 'AWS::NoValue' }],
    });
  }
  for (const [rate, burst] of [[1, 1], [1, 2], [100, 100]]) {
    const effective = effectiveSection(template, 'Resources', {
      [rateParameter]: rate, [burstParameter]: burst, SlackSigningSecret: 'unit-test-slack-secret',
      FaqRestStreamApiEnabled: 'true',
    });
    for (const path of faqPaths) {
      assert.deepEqual(effective.FaqHttpApi.Properties.RouteSettings[`POST ${path}`], {
        ThrottlingBurstLimit: burst, ThrottlingRateLimit: rate,
      });
    }
    assert.deepEqual(effective.FaqHttpApi.Properties.RouteSettings['POST /slack/events'], {
      ThrottlingBurstLimit: 5, ThrottlingRateLimit: 2,
    });
    assert.deepEqual(effective.FaqRestStreamApi.Properties.MethodSettings, [{
      ResourcePath: '/*', HttpMethod: '*', ThrottlingBurstLimit: 5, ThrottlingRateLimit: 2,
    }]);
  }
});

test('local SAM transform preserves all previous default resources and removes only disabled FAQ entry resources', (context) => {
  const script = [
    'import json, sys',
    'try:',
    '    from samtranslator.translator.transform import transform',
    '    from samtranslator.translator.managed_policy_translator import ManagedPolicyLoader',
    'except ImportError:',
    '    sys.exit(42)',
    'sources = json.load(sys.stdin)',
    'result = {}',
    'for name, source in sources.items():',
    '    for resource in source["Resources"].values():',
    '        if resource["Type"] == "AWS::Serverless::Function":',
    '            resource["Properties"]["CodeUri"] = "s3://unit-test/code.zip"',
    '    result[name] = transform(source, {}, ManagedPolicyLoader(None))',
    'print(json.dumps(result))',
  ].join('\n');
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script], {
    input: JSON.stringify({ current: template, prior: priorTemplate() }), encoding: 'utf8',
    timeout: 30_000, maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env, AWS_DEFAULT_REGION: 'us-west-2', AWS_EC2_METADATA_DISABLED: 'true' },
  });
  if (result.error?.code === 'ENOENT' || result.status === 42) {
    context.skip('optional SAM translator is not installed; parsed template contracts still run');
    return;
  }
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const { current, prior } = JSON.parse(result.stdout);
  for (const slackSecret of ['', 'unit-test-slack-secret']) {
    for (const streamEnabled of ['false', 'true']) {
      const overrides = { SlackSigningSecret: slackSecret, FaqRestStreamApiEnabled: streamEnabled };
      const enabled = effectiveSection(current, 'Resources', overrides);
      const previous = effectiveSection(prior, 'Resources', overrides);
      assert.deepEqual(enabled, previous, 'default controls must preserve every transformed resource');
      assert.deepEqual(effectiveSection(current, 'Outputs', overrides),
        effectiveSection(prior, 'Outputs', overrides));
      if (!slackSecret) continue;
      const disabled = effectiveSection(current, 'Resources', { ...overrides, [enabledParameter]: 'false' });
      const expected = structuredClone(enabled);
      for (const name of permissionNames) delete expected[name];
      for (const path of faqPaths) delete expected.FaqHttpApi.Properties.Body.paths[path];
      const stage = Object.values(expected).find((resource) => resource.Type === 'AWS::ApiGatewayV2::Stage');
      assert.ok(stage, 'SAM must generate the HTTP API stage');
      for (const path of faqPaths) delete stage.Properties.RouteSettings[`POST ${path}`];
      assert.deepEqual(disabled, expected,
        'disablement may change only the four FAQ permissions, two paths and two route settings');
      assert.deepEqual(disabled.FaqChatFunctionRole, enabled.FaqChatFunctionRole);
      assert.deepEqual(disabled.FaqChatFunction, enabled.FaqChatFunction);
      assert.deepEqual(effectiveSection(current, 'Outputs', { ...overrides, [enabledParameter]: 'false' }),
        effectiveSection(prior, 'Outputs', overrides));
    }
  }
});
