/** Legacy HTTP FAQ controls must preserve local route discovery, default SAM output and Slack. */
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
const enabledParameter = 'FaqHttpApiFaqRoutesEnabled';
const enabledEnvironment = 'FAQ_HTTP_API_FAQ_ROUTES_ENABLED';
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
  delete prior.Resources.FaqChatFunction.Properties.Environment.Variables[enabledEnvironment];
  for (const path of faqPaths) {
    prior.Resources.FaqHttpApi.Properties.RouteSettings[`POST ${path}`] = {
      ThrottlingBurstLimit: 5, ThrottlingRateLimit: 2,
    };
  }
  return prior;
}

test('HTTP FAQ controls keep all four buffered routes and the previous limits by default', () => {
  assert.deepEqual(document.errors, []);
  assert.deepEqual(document.warnings, []);
  assert.equal(template.Parameters[enabledParameter].Type, 'String');
  assert.equal(template.Parameters[enabledParameter].Default, 'true');
  assert.deepEqual([...template.Parameters[enabledParameter].AllowedValues].sort(), ['false', 'true']);
  assert.equal(template.Conditions.HasFaqHttpApiFaqRoutes, undefined);
  assert.equal(template.Rules.FaqHttpApiMustKeepARoute, undefined,
    'shell disablement must also work without Slack');
  assert.deepEqual(template.Resources.FaqChatFunction.Properties.Environment.Variables[enabledEnvironment],
    { Ref: enabledParameter });
  assert.equal(template.Resources.FaqChatStreamFunction.Properties.Environment.Variables[enabledEnvironment], undefined);
  const effective = effectiveSection(template, 'Resources');
  const properties = effective.FaqHttpApi.Properties;
  for (const path of faqPaths) {
    assert.deepEqual(properties.RouteSettings[`POST ${path}`], { ThrottlingBurstLimit: 5, ThrottlingRateLimit: 2 });
  }
  assert.equal(effective.FaqChatFunction.Properties.Environment.Variables[enabledEnvironment], 'true');
  for (const name of permissionNames) assert.equal(template.Resources[name], undefined,
    'HttpApi Events must let SAM generate the invocation permissions');
});

test('sam local can discover four unconditional FAQ HttpApi events and the conditional Slack event statically', () => {
  // Do not resolve Fn::If here: sam local cannot discover FAQ routes hidden inside
  // conditional DefinitionBody paths. All routes must be literal function Events.
  assert.equal(template.Resources.FaqHttpApi.Condition, undefined);
  assert.equal(template.Resources.FaqHttpApi.Properties.DefinitionBody, undefined);
  assert.equal(template.Resources.FaqChatFunction.Condition, undefined);
  assert.deepEqual(template.Resources.FaqChatFunction.Properties.Events,
    Object.fromEntries(eventContracts.map(([name, path, method]) => [
      name, { Type: 'HttpApi', Properties: { ApiId: { Ref: 'FaqHttpApi' }, Path: path, Method: method } },
    ])));
  const discovered = [];
  for (const [functionName, resource] of Object.entries(template.Resources)) {
    if (resource.Type !== 'AWS::Serverless::Function') continue;
    for (const [eventName, event] of Object.entries(resource.Properties.Events ?? {})) {
      if (event.Type !== 'HttpApi' || event.Properties.ApiId?.Ref !== 'FaqHttpApi') continue;
      assert.equal(event.Condition, undefined);
      discovered.push([functionName, eventName, event.Properties.Path, event.Properties.Method, resource.Condition]);
    }
  }
  assert.deepEqual(discovered, [
    ...eventContracts.map(([name, path, method]) => ['FaqChatFunction', name, path, method, undefined]),
    ['SlackIngressFunction', 'SlackEventsApi', '/slack/events', 'POST', 'HasSlackAgent'],
  ]);
  assert.deepEqual(template.Conditions.HasSlackAgent, {
    'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'SlackSigningSecret' }, ''] }],
  });
});

test('HTTP FAQ disablement changes only the shell flag, independently of Slack and REST streaming', () => {
  for (const slackSecret of ['', 'unit-test-slack-secret']) {
    for (const streamEnabled of ['false', 'true']) {
      const overrides = { SlackSigningSecret: slackSecret, FaqRestStreamApiEnabled: streamEnabled };
      const enabled = effectiveSection(template, 'Resources', overrides);
      const disabled = effectiveSection(template, 'Resources', { ...overrides, [enabledParameter]: 'false' });
      const expected = structuredClone(enabled);
      expected.FaqChatFunction.Properties.Environment.Variables[enabledEnvironment] = 'false';
      assert.deepEqual(disabled, expected,
        'routes, limits, IAM, Slack and REST resources must survive shell disablement');
      assert.deepEqual(effectiveSection(template, 'Outputs', { ...overrides, [enabledParameter]: 'false' }),
        effectiveSection(template, 'Outputs', overrides));
    }
  }
  assert.equal(template.Resources.FaqChatFunction.Condition, undefined,
    'keep the SAM-generated IAM role stable across rollback and external trust policies');
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
      ThrottlingBurstLimit: { Ref: burstParameter }, ThrottlingRateLimit: { Ref: rateParameter },
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

test('local SAM transform preserves previous default resources and toggles only the shell environment', (context) => {
  const script = [
    'import json, sys',
    'from unittest.mock import patch',
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
    // AlwaysDeploy hashes the current second; freeze it for both transforms so
    // deployment IDs/references can still be compared without dropping fields.
    '    with patch("samtranslator.model.apigateway.time.time", return_value=1_700_000_000):',
    '        result[name] = transform(source, {}, ManagedPolicyLoader(None))',
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
      previous.FaqChatFunction.Properties.Environment.Variables[enabledEnvironment] = 'true';
      assert.deepEqual(enabled, previous,
        'default controls must preserve every transformed resource except the new default-true flag');
      assert.deepEqual(effectiveSection(current, 'Outputs', overrides),
        effectiveSection(prior, 'Outputs', overrides));
      const disabled = effectiveSection(current, 'Resources', { ...overrides, [enabledParameter]: 'false' });
      const expected = structuredClone(enabled);
      expected.FaqChatFunction.Properties.Environment.Variables[enabledEnvironment] = 'false';
      assert.deepEqual(disabled, expected,
        'disablement may change only the FAQ shell environment flag');
      assert.deepEqual(disabled.FaqChatFunctionRole, enabled.FaqChatFunctionRole);
      for (const name of permissionNames) {
        assert.ok(disabled[name], `SAM must generate ${name}`);
        assert.deepEqual(disabled[name], enabled[name]);
      }
      assert.deepEqual(effectiveSection(current, 'Outputs', { ...overrides, [enabledParameter]: 'false' }),
        effectiveSection(prior, 'Outputs', overrides));
    }
  }
});
