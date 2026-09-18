import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = parseDocument(fs.readFileSync(path.join(root, 'template.yaml'), 'utf8'), {
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
const worker = resources.FaqQaNotifyFunction;
const event = worker.Properties.Events.QaInsert.Properties;

test('template parses and defaults to synchronous notification without deleting drain infrastructure', () => {
  assert.deepEqual(doc.errors, []);
  assert.deepEqual(doc.warnings, []);
  assert.equal(template.Parameters.FaqQaNotifyAsyncEnabled.Default, 'false');
  assert.deepEqual(template.Parameters.FaqQaNotifyAsyncEnabled.AllowedValues, ['false', 'true']);
  assert.deepEqual(resources.FaqChatFunction.Properties.Environment.Variables.FAQ_QA_NOTIFY_ASYNC_ENABLED,
    { Ref: 'FaqQaNotifyAsyncEnabled' });
  for (const name of ['FaqQaLogsTable', 'FaqQaNotifyFunction', 'FaqQaNotifyRole', 'FaqQaNotifyDLQ', 'FaqQaNotifyDLQAlarm']) {
    assert.equal(resources[name].Condition, undefined, `${name} must remain installed while pending rows drain`);
  }
  assert.deepEqual(resources.FaqQaLogsTable.Properties.StreamSpecification, { StreamViewType: 'NEW_IMAGE' });
  assert.equal(worker.Properties.Environment.Variables.FAQ_QA_NOTIFY_ASYNC_ENABLED, undefined);
  assert.deepEqual(worker.Properties.Environment.Variables, {
    FAQ_TABLE_NAME_PREFIX: { 'Fn::Sub': '${Environment}-${FaqTableNamespace}' },
    FAQ_QA_LOGS_TABLE_NAME: { Ref: 'FaqQaLogsTable' },
    FAQ_QA_NOTIFY_WEBHOOK_URL: { Ref: 'FaqQaNotifyWebhookUrl' },
  });
  assert.equal(worker.Properties.CodeUri, 'functions/faq-qa-notify-worker/');
  assert.equal(worker.Properties.Timeout, 15);
});

test('stream filter assigns only newly committed async INSERTs and catches activation races', () => {
  assert.equal(worker.Properties.Events.QaInsert.Type, 'DynamoDB');
  assert.deepEqual(event.Stream, { 'Fn::GetAtt': ['FaqQaLogsTable', 'StreamArn'] });
  assert.equal(event.StartingPosition, 'TRIM_HORIZON');
  assert.equal(event.BatchSize, 1);
  assert.deepEqual(JSON.parse(event.FilterCriteria.Filters[0].Pattern), {
    eventName: ['INSERT'], dynamodb: { NewImage: { qaNotifyDelivery: { S: ['async-v1'] } } },
  });
});

test('maximum stream send and completion reserve fit inside the worker Lambda timeout', () => {
  function exportedMilliseconds(relativePath, name) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    const declaration = source.match(new RegExp(`export const ${name} = ([\\d_]+);`, 'u'));
    assert.ok(declaration, `${name} must remain an explicit millisecond budget`);
    return Number(declaration[1].replaceAll('_', ''));
  }
  const sendMs = exportedMilliseconds('functions/faq-chat/adapters/faq-qa-slack-notify.ts', 'STREAM_NOTIFY_TIMEOUT_MS');
  const completeMs = exportedMilliseconds('functions/faq-qa-notify-worker/handler.ts', 'COMPLETE_RESERVE_MS');
  assert.ok(completeMs > 0, 'completion must retain a positive write budget');
  assert.ok(sendMs + completeMs <= worker.Properties.Timeout * 1000,
    'Slack timeout plus completion reserve must fit within the Lambda timeout');
});

test('partial record failures have bounded retry and a durable encrypted SQS failure destination', () => {
  assert.deepEqual(event.FunctionResponseTypes, ['ReportBatchItemFailures']);
  assert.equal(event.MaximumRetryAttempts, 10);
  assert.equal(event.MaximumRecordAgeInSeconds, 3600);
  assert.equal(event.BisectBatchOnFunctionError, undefined, 'BatchSize 1 has nothing to bisect');
  assert.deepEqual(event.DestinationConfig.OnFailure, {
    Type: 'SQS', Destination: { 'Fn::GetAtt': ['FaqQaNotifyDLQ', 'Arn'] },
  });
  const dlq = resources.FaqQaNotifyDLQ;
  assert.equal(dlq.Type, 'AWS::SQS::Queue');
  assert.equal(dlq.Properties.SqsManagedSseEnabled, true);
  assert.equal(dlq.Properties.MessageRetentionPeriod, 1209600);
  assert.equal(dlq.Properties.FifoQueue, undefined);
  assert.equal(dlq.DeletionPolicy, 'RetainExceptOnCreate');
  assert.equal(dlq.UpdateReplacePolicy, 'Retain');
  const alarm = resources.FaqQaNotifyDLQAlarm.Properties;
  assert.equal(alarm.Namespace, 'AWS/SQS');
  assert.equal(alarm.MetricName, 'ApproximateNumberOfMessagesVisible');
  assert.equal(alarm.Threshold, 1);
  assert.deepEqual(alarm.Dimensions, [{ Name: 'QueueName', Value: { 'Fn::GetAtt': ['FaqQaNotifyDLQ', 'QueueName'] } }]);
});

test('worker has exact data permissions and only the unavoidable region-bound ListStreams wildcard', () => {
  const role = resources.FaqQaNotifyRole.Properties;
  assert.deepEqual(worker.Properties.Role, { 'Fn::GetAtt': ['FaqQaNotifyRole', 'Arn'] });
  assert.equal(worker.Properties.Policies, undefined);
  assert.equal(role.ManagedPolicyArns.length, 1);
  assert.match(JSON.stringify(role.ManagedPolicyArns), /AWSLambdaBasicExecutionRole/u);
  const statements = role.Policies.flatMap((policy) => policy.PolicyDocument.Statement);
  assert.equal(statements.length, 4);
  const pairs = statements.flatMap((statement) => [statement.Action].flat().map((action) => ({ action, resource: statement.Resource })));
  assert.deepEqual(pairs, [
    ...['dynamodb:DescribeStream', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator'].map((action) => ({ action, resource: { 'Fn::GetAtt': ['FaqQaLogsTable', 'StreamArn'] } })),
    { action: 'dynamodb:ListStreams', resource: '*' },
    ...['dynamodb:GetItem', 'dynamodb:UpdateItem'].map((action) => ({ action, resource: { 'Fn::GetAtt': ['FaqQaLogsTable', 'Arn'] } })),
    { action: 'sqs:SendMessage', resource: { 'Fn::GetAtt': ['FaqQaNotifyDLQ', 'Arn'] } },
  ]);
  assert.deepEqual(statements[1].Condition, { StringEquals: { 'aws:RequestedRegion': { Ref: 'AWS::Region' } } });
  assert.deepEqual(template.Outputs.FaqQaNotifyDLQUrl.Value, { Ref: 'FaqQaNotifyDLQ' });
  assert.deepEqual(template.Outputs.FaqQaNotifyFunctionName.Value, { Ref: 'FaqQaNotifyFunction' });
});
