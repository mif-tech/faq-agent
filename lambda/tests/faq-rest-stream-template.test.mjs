/** Public-only REST streaming entrance: default-off resources and unchanged HTTP contracts. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parseDocument } from 'yaml';

const doc = parseDocument(fs.readFileSync(new URL('../template.yaml', import.meta.url), 'utf8'), {
  customTags: [
    ...[['Ref', 'Ref'], ['Sub', 'Fn::Sub'], ['GetAtt', 'Fn::GetAtt']].map(([tag, name]) => ({
      tag: `!${tag}`, resolve: (value) => ({ [name]: tag === 'GetAtt' ? value.split('.') : value }),
    })),
    ...['And', 'Equals', 'If', 'Not', 'Or'].map((tag) => ({
      tag: `!${tag}`, collection: 'seq', resolve: (seq) => ({ [`Fn::${tag}`]: seq.items.map((item) => item.toJSON()) }),
    })),
  ], uniqueKeys: true,
});
const template = doc.toJS({ maxAliasCount: 0 });
const resources = template.Resources;
const api = resources.FaqRestStreamApi;
const stream = resources.FaqChatStreamFunction;
const legacy = resources.FaqChatFunction;
const routePaths = ['/faq-chat', '/agents/{agentId}/faq-chat'];
const permissionNames = ['ChatPost', 'ChatOptions', 'AgentPost', 'AgentOptions']
  .map((name) => `FaqRestStream${name}Permission`);
const streamResources = ['FaqRestStreamApi', 'FaqChatStreamFunction', ...permissionNames];
const allowedTimeoutSeconds = [1, 5, 10, 20, 29, 30, 45, 60, 70, 90, 120, 180, 240, 300, 600, 900];
const timeoutParameter = 'FaqRestStreamIntegrationTimeoutSeconds';

function evaluate(value, parameters, input = template) {
  if (Array.isArray(value)) return value.map((item) => evaluate(item, parameters, input));
  if (value === null || typeof value !== 'object') return value;
  if ('Ref' in value) return parameters[value.Ref];
  if ('Fn::Equals' in value) {
    const [left, right] = evaluate(value['Fn::Equals'], parameters, input);
    // CloudFormation Number parameter Refs can be strings; Equals compares
    // their scalar values rather than JavaScript's number/string types.
    return String(left) === String(right);
  }
  if ('Fn::Not' in value) return !evaluate(value['Fn::Not'][0], parameters, input);
  if ('Fn::And' in value) return evaluate(value['Fn::And'], parameters, input).every(Boolean);
  if ('Fn::Or' in value) return evaluate(value['Fn::Or'], parameters, input).some(Boolean);
  if ('Fn::If' in value) {
    const [condition, whenTrue, whenFalse] = value['Fn::If'];
    assert.ok(Object.hasOwn(input.Conditions, condition), `missing condition: ${condition}`);
    return evaluate(evaluate(input.Conditions[condition], parameters, input) ? whenTrue : whenFalse,
      parameters, input);
  }
  throw new Error(`Unsupported contract expression: ${JSON.stringify(value)}`);
}

function activeEntries(section, enabled = template.Parameters.FaqRestStreamApiEnabled.Default, input = template) {
  const parameters = {
    ...Object.fromEntries(Object.entries(template.Parameters).map(([name, value]) => [name, value.Default])),
    FaqRestStreamApiEnabled: enabled,
  };
  return Object.fromEntries(Object.entries(input[section]).filter(([, item]) =>
    !item.Condition || evaluate(input.Conditions[item.Condition], parameters, input)));
}

function assertIntegerTimeouts(body, input, seconds) {
  // Exercise both the parsed Number default and the string parameter values
  // supplied to CloudFormation. Every OpenAPI operation must receive an integer.
  for (const parameterValue of [seconds, String(seconds)]) {
    for (const path of routePaths) {
      for (const method of ['post', 'options']) {
        const timeout = body.paths[path][method]['x-amazon-apigateway-integration'].timeoutInMillis;
        const milliseconds = evaluate(timeout, { [timeoutParameter]: parameterValue }, input);
        const message = `${path} ${method}, seconds=${parameterValue} (${typeof parameterValue})`;
        assert.ok(Number.isInteger(milliseconds), `OpenAPI timeout must be an integer: ${message}`);
        assert.equal(milliseconds, seconds * 1000, message);
      }
    }
  }
}

test('REST streaming entrance and its outputs are absent by default and present only when enabled', () => {
  assert.deepEqual(doc.errors, []);
  assert.deepEqual(doc.warnings, []);
  assert.equal(template.Parameters.FaqRestStreamApiEnabled.Default, 'false');
  assert.deepEqual(template.Parameters.FaqRestStreamApiEnabled.AllowedValues, ['false', 'true']);
  assert.deepEqual(template.Conditions.HasRestStreamApi, {
    'Fn::Equals': [{ Ref: 'FaqRestStreamApiEnabled' }, 'true'],
  });
  assert.deepEqual(Object.entries(resources)
    .filter(([, resource]) => resource.Condition === 'HasRestStreamApi')
    .map(([name]) => name).sort(), [...streamResources].sort());
  for (const enabled of ['false', 'true']) {
    const deployedResources = activeEntries('Resources', enabled);
    const deployedOutputs = activeEntries('Outputs', enabled);
    for (const name of streamResources) assert.equal(name in deployedResources, enabled === 'true', name);
    for (const name of ['FaqRestStreamApiUrl', 'FaqChatStreamCallerRoleArn']) {
      assert.equal(name in deployedOutputs, enabled === 'true', name);
    }
    assert.ok(deployedResources.FaqHttpApi);
    assert.ok(deployedResources.FaqChatFunction);
    assert.ok(deployedOutputs.FaqApiUrl);
  }
});

test('Regional SAM API publishes all four proxy streaming routes and parameter-only updates', () => {
  assert.equal(api.Type, 'AWS::Serverless::Api');
  assert.equal(api.Properties.EndpointConfiguration, 'REGIONAL');
  assert.deepEqual(api.Properties.StageName, { Ref: 'Environment' });
  assert.equal(api.Properties.OpenApiVersion, '3.0.1', 'avoid SAM implicit extra Stage');
  assert.equal(api.Properties.AlwaysDeploy, true, 'timeout and CORS parameter changes must publish a new snapshot');
  assert.equal(api.Properties.Cors, undefined, 'OPTIONS must use Lambda, not generated MOCK');
  assert.deepEqual(Object.keys(api.Properties.DefinitionBody.paths), routePaths);
  for (const path of routePaths) {
    const operations = api.Properties.DefinitionBody.paths[path];
    assert.deepEqual(Object.keys(operations).filter((key) => key !== 'parameters'), ['post', 'options']);
    for (const method of ['post', 'options']) {
      const integration = operations[method]['x-amazon-apigateway-integration'];
      assert.equal(integration.type, 'aws_proxy');
      assert.equal(integration.httpMethod, 'POST');
      assert.equal(integration.responseTransferMode, 'STREAM');
      assert.deepEqual(integration.uri, {
        'Fn::Sub': 'arn:${AWS::Partition}:apigateway:${AWS::Region}:lambda:path/2021-11-15/functions/${FaqChatStreamFunction.Arn}/response-streaming-invocations',
      });
    }
  }
  assert.deepEqual(api.Properties.DefinitionBody.paths[routePaths[1]].parameters, [
    { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
  ]);
});

test('all allowed second budgets produce integer milliseconds within the 15 minute STREAM maximum', () => {
  const parameter = template.Parameters[timeoutParameter];
  assert.equal(parameter.Type, 'Number');
  assert.equal(parameter.Default, 70);
  assert.equal(parameter.MinValue, 1);
  assert.equal(parameter.MaxValue, 900);
  assert.deepEqual(parameter.AllowedValues, allowedTimeoutSeconds);
  assert.equal(template.Mappings?.FaqRestStreamTimeoutMillis, undefined, 'obsolete timeout mapping must be removed');
  const conditionalSeconds = allowedTimeoutSeconds.slice(0, -1);
  assert.deepEqual(Object.keys(template.Conditions).filter((name) => name.startsWith('RestStreamTimeoutIs')).sort(),
    conditionalSeconds.map((seconds) => `RestStreamTimeoutIs${seconds}`).sort());
  for (const seconds of conditionalSeconds) {
    assert.deepEqual(template.Conditions[`RestStreamTimeoutIs${seconds}`], {
      'Fn::Equals': [{ Ref: timeoutParameter }, seconds],
    });
  }
  // Literal leaves avoid the SAM/CloudFormation FindInMap preprocessing failure
  // and do not depend on Ref or Sub coercing an OpenAPI string into an integer.
  const expectedTimeout = conditionalSeconds.reduceRight((fallback, seconds) => ({
    'Fn::If': [`RestStreamTimeoutIs${seconds}`, seconds * 1000, fallback],
  }), 900000);
  for (const path of routePaths) {
    for (const method of ['post', 'options']) {
      const timeout = api.Properties.DefinitionBody.paths[path][method]['x-amazon-apigateway-integration'].timeoutInMillis;
      assert.deepEqual(timeout, expectedTimeout);
    }
  }
  for (const seconds of allowedTimeoutSeconds) assertIntegerTimeouts(api.Properties.DefinitionBody, template, seconds);
  for (const invalid of [0, 1.5, 70.5, 901]) assert.equal(parameter.AllowedValues.includes(invalid), false);
});

function assertSharedEnvironment(streamEnvironment, httpEnvironment) {
  const shared = structuredClone(httpEnvironment);
  assert.deepEqual(shared.Variables.FAQ_HTTP_API_FAQ_ROUTES_ENABLED, { Ref: 'FaqHttpApiFaqRoutesEnabled' });
  delete shared.Variables.FAQ_HTTP_API_FAQ_ROUTES_ENABLED;
  assert.deepEqual(streamEnvironment, shared, 'only the HTTP entrance disablement flag is entrance-specific');
}

test('dedicated streaming function shares runtime settings and IAM except the HTTP-only disablement flag', () => {
  assert.equal(stream.Type, 'AWS::Serverless::Function');
  assert.equal(stream.Condition, 'HasRestStreamApi');
  assert.equal(stream.Properties.Handler, 'bootstrap.streamHandler');
  assert.equal(stream.Properties.Events, undefined, 'only precise explicit REST permissions may invoke this entrance');
  assert.notDeepEqual(stream.Properties.FunctionName, legacy.Properties.FunctionName);
  for (const field of ['CodeUri', 'Timeout', 'Policies', 'Runtime', 'MemorySize', 'Architectures']) {
    assert.deepEqual(stream.Properties[field], legacy.Properties[field], `${field} must stay in parity`);
  }
  assertSharedEnvironment(stream.Properties.Environment, legacy.Properties.Environment);
  assert.deepEqual(stream.Metadata, legacy.Metadata);
  const variables = stream.Properties.Environment.Variables;
  assert.deepEqual(variables.FAQ_QA_NOTIFY_ASYNC_ENABLED, { Ref: 'FaqQaNotifyAsyncEnabled' });
  assert.deepEqual(variables.FAQ_MAX_INFLIGHT, { Ref: 'FaqMaxInflight' });
  assert.deepEqual(stream.Properties.Timeout, { Ref: 'FaqChatFunctionTimeoutSeconds' });
  assert.equal(template.Parameters.FaqChatFunctionTimeoutSeconds.Default, '28');
  assert.equal(template.Parameters.FaqMaxInflight.Default, 0);
  assert.equal(template.Parameters.FaqQaNotifyAsyncEnabled.Default, 'false');
});

test('Lambda permissions are restricted to this account, API, stage, method and FAQ paths', () => {
  const suffixes = ['POST/faq-chat', 'OPTIONS/faq-chat', 'POST/agents/*/faq-chat', 'OPTIONS/agents/*/faq-chat'];
  for (const [index, name] of permissionNames.entries()) {
    const permission = resources[name];
    assert.equal(permission.Type, 'AWS::Lambda::Permission');
    assert.equal(permission.Condition, 'HasRestStreamApi');
    assert.deepEqual(permission.Properties, {
      Action: 'lambda:InvokeFunction',
      FunctionName: { Ref: 'FaqChatStreamFunction' },
      Principal: 'apigateway.amazonaws.com',
      SourceAccount: { Ref: 'AWS::AccountId' },
      SourceArn: { 'Fn::Sub': 'arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${FaqRestStreamApi}/${Environment}/' + suffixes[index] },
    });
  }
});

test('REST stage retains its throttle independently of HTTP and gateway failures include browser CORS headers', () => {
  assert.deepEqual(api.Properties.MethodSettings, [{
    ResourcePath: '/*', HttpMethod: '*', ThrottlingBurstLimit: 5, ThrottlingRateLimit: 2,
  }]);
  assert.deepEqual(Object.keys(api.Properties.GatewayResponses), ['DEFAULT_4XX', 'DEFAULT_5XX']);
  for (const response of Object.values(api.Properties.GatewayResponses)) {
    assert.deepEqual(response.ResponseParameters.Headers, {
      'Access-Control-Allow-Origin': { 'Fn::Sub': "'${FaqChatCorsOrigin}'" },
      'Access-Control-Allow-Methods': "'POST, OPTIONS'",
      'Access-Control-Allow-Headers': "'Content-Type'",
    });
    assert.equal(response.StatusCode, undefined, 'retain actual 429 and 5xx status codes');
  }
  assert.equal(api.Properties.AccessLogSetting, resources.FaqHttpApi.Properties.AccessLogSettings);
});

test('conditional URL includes a stage without a trailing slash and remote caller ARN is exposed separately', () => {
  assert.deepEqual(template.Outputs.FaqRestStreamApiUrl.Value, {
    'Fn::Sub': 'https://${FaqRestStreamApi}.execute-api.${AWS::Region}.${AWS::URLSuffix}/${Environment}',
  });
  assert.deepEqual(template.Outputs.FaqChatStreamCallerRoleArn.Value, {
    'Fn::GetAtt': ['FaqChatStreamFunctionRole', 'Arn'],
  });
  assert.deepEqual(template.Outputs.FaqChatCallerRoleArn.Value, {
    'Fn::GetAtt': ['FaqChatFunctionRole', 'Arn'],
  });
  assert.deepEqual(template.Outputs.FaqApiUrl.Value, {
    'Fn::Sub': 'https://${FaqHttpApi}.execute-api.${AWS::Region}.${AWS::URLSuffix}/${Environment}',
  });
});

test('local SAM transform preserves STREAM and conditions the generated REST stage, deployment and IAM role', (context) => {
  // npm test also works on Node-only installations. When SAM is installed, exercise
  // its real transform locally; fake S3 references avoid packaging or any AWS calls.
  const script = [
    'import copy, json, sys',
    'try:',
    '    from samtranslator.translator.transform import transform',
    '    from samtranslator.translator.managed_policy_translator import ManagedPolicyLoader',
    'except ImportError:',
    '    sys.exit(42)',
    'source = json.load(sys.stdin)',
    'for resource in source["Resources"].values():',
    '    if resource["Type"] == "AWS::Serverless::Function":',
    '        resource["Properties"]["CodeUri"] = "s3://unit-test/code.zip"',
    'def translated(parameters):',
    '    return transform(copy.deepcopy(source), parameters, ManagedPolicyLoader(None))',
    'result = {"default": translated({})}',
    `override = translated({"FaqRestStreamApiEnabled": "true", "${timeoutParameter}": "900"})`,
    'result["override"] = {"Conditions": override["Conditions"],',
    '    "body": override["Resources"]["FaqRestStreamApi"]["Properties"]["Body"]}',
    'print(json.dumps(result))',
  ].join('\n');
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script], {
    input: JSON.stringify(template), encoding: 'utf8', timeout: 30_000, maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env, AWS_DEFAULT_REGION: 'us-west-2', AWS_EC2_METADATA_DISABLED: 'true' },
  });
  if (result.error?.code === 'ENOENT' || result.status === 42) {
    context.skip('optional SAM translator is not installed; parsed template contracts still run');
    return;
  }
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const { default: transformed, override } = JSON.parse(result.stdout);
  const generated = Object.entries(transformed.Resources)
    .filter(([name]) => /^(?:FaqRestStream|FaqChatStream)/u.test(name));
  assert.equal(generated.length, 9, 'API, stage, deployment, function, role and four permissions');
  for (const [name, resource] of generated) assert.equal(resource.Condition, 'HasRestStreamApi', name);
  for (const enabled of ['false', 'true']) {
    const deployed = activeEntries('Resources', enabled, transformed);
    for (const [name] of generated) assert.equal(name in deployed, enabled === 'true', name);
    const outputs = activeEntries('Outputs', enabled, transformed);
    for (const name of ['FaqRestStreamApiUrl', 'FaqChatStreamCallerRoleArn']) {
      assert.equal(name in outputs, enabled === 'true', name);
    }
  }
  const stage = generated.find(([, resource]) => resource.Type === 'AWS::ApiGateway::Stage')[1];
  assert.deepEqual(stage.Properties.MethodSettings, api.Properties.MethodSettings);
  const body = transformed.Resources.FaqRestStreamApi.Properties.Body;
  // SAM preserves Fn::If instead of resolving parameter values. One comparison
  // fixes that structure; evaluate every allowed value below without re-transforming.
  assert.deepEqual(override, { Conditions: transformed.Conditions, body });
  for (const seconds of allowedTimeoutSeconds) assertIntegerTimeouts(body, transformed, seconds);
  for (const path of routePaths) {
    for (const method of ['post', 'options']) {
      assert.deepEqual(body.paths[path][method]['x-amazon-apigateway-integration'],
        api.Properties.DefinitionBody.paths[path][method]['x-amazon-apigateway-integration']);
    }
  }
  const gatewayResponses = body['x-amazon-apigateway-gateway-responses'];
  assert.deepEqual(Object.keys(gatewayResponses).sort(), ['DEFAULT_4XX', 'DEFAULT_5XX']);
  for (const response of Object.values(gatewayResponses)) {
    assert.deepEqual(response.responseParameters['gatewayresponse.header.Access-Control-Allow-Origin'],
      { 'Fn::Sub': "'${FaqChatCorsOrigin}'" });
  }
  assertSharedEnvironment(transformed.Resources.FaqChatStreamFunction.Properties.Environment,
    transformed.Resources.FaqChatFunction.Properties.Environment);
  const streamRole = transformed.Resources.FaqChatStreamFunctionRole.Properties;
  const httpRole = transformed.Resources.FaqChatFunctionRole.Properties;
  assert.deepEqual(streamRole.Policies.map(({ PolicyDocument }) => PolicyDocument),
    httpRole.Policies.map(({ PolicyDocument }) => PolicyDocument));
  assert.deepEqual(streamRole.ManagedPolicyArns, httpRole.ManagedPolicyArns);
});
