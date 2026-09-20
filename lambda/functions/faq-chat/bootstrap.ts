/** Canonical Lambda composition root. Keep private adapter wiring out of handler.ts. */
import type { APIGatewayProxyResultV2, StreamifyHandler } from 'aws-lambda';
import { createFaqComposition } from './composition.js';
import { createFaqHandler, jsonResponse, TECHNICAL_FALLBACK_ENVELOPE } from './handler.js';
import { toFaqHttpApiEvent } from './rest-event.js';
import { runFaqEntrypoint } from './shell-timing.js';

const composition = createFaqComposition();

export const handler = createFaqHandler(composition.ports, composition.remoteRag);

function streamError(statusCode: 400 | 500): APIGatewayProxyResultV2 {
  return jsonResponse(statusCode, statusCode === 400 ? { error: 'Invalid request' } : TECHNICAL_FALLBACK_ENVELOPE);
}

function streamResponse(result: APIGatewayProxyResultV2) {
  if (typeof result !== 'object' || result === null || result.isBase64Encoded === true ||
    (result.body !== undefined && typeof result.body !== 'string')) {
    // The FAQ shell only returns text JSON. Binary responses need a separate contract.
    throw new Error('Unsupported FAQ stream response');
  }
  const statusCode = result.statusCode ?? 200;
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    throw new Error('Invalid FAQ stream status');
  }
  return {
    statusCode,
    headers: Object.fromEntries(Object.entries(result.headers ?? {}).map(([key, value]) => [key, String(value)])),
    body: result.body ?? '',
  };
}

const handleStream: StreamifyHandler<unknown> = async (event, responseStream, context) => {
  let output = responseStream;
  try {
    let converted;
    try {
      converted = toFaqHttpApiEvent(event);
      // handler.ts parses text JSON and deliberately has no binary-body decoder.
      if (converted.isBase64Encoded) throw new Error('Unsupported base64 FAQ request');
    } catch {
      const response = streamResponse(streamError(400));
      output = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: response.statusCode, headers: response.headers,
      });
      output.write(response.body);
      return;
    }
    let response;
    try {
      response = streamResponse(await runFaqEntrypoint('rest-stream', () => handler(converted, context)));
    } catch {
      response = streamResponse(streamError(500));
    }
    // from() emits the API Gateway metadata prelude and eight-NUL delimiter.
    // Keep the completed JSON as one write; token-by-token display is a later phase.
    output = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: response.statusCode, headers: response.headers,
    });
    output.write(response.body);
  } finally {
    // Also close on conversion, handler, prelude or write failure. Never write a second prelude.
    // prelude 取得に失敗した場合は素のストリームに何も書かず終える。
    // API GW 側は 200・ヘッダ無しの空応答になる（実質発生しない経路）。
    output.end();
  }
};

// Local buffered consumers need no Lambda runtime global. In Lambda this export is
// always decorated; the HTTP API export above retains its buffered calling convention.
export const streamHandler = typeof awslambda === 'undefined'
  ? handleStream
  : awslambda.streamifyResponse(handleStream);
