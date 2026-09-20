import type { APIGatewayProxyEventV2 } from 'aws-lambda';

const INVALID_EVENT = 'Invalid REST API event';

function invalidEvent(): never {
  // Never include request metadata or the body in errors written by the entrypoint.
  throw new Error(INVALID_EVENT);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidEvent();
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) invalidEvent();
  return value;
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stageFreePath(value: string, stage: string): string {
  const prefix = `/${stage}`;
  if (value === prefix) return '/';
  return value.startsWith(`${prefix}/`) ? value.slice(prefix.length) : value;
}

function normalizeHeaders(single: unknown, multiple: unknown): Record<string, string> {
  const headers = new Map<string, string[]>();
  if (single != null) {
    for (const [name, value] of Object.entries(object(single))) {
      if (name.length === 0 || typeof value !== 'string') invalidEvent();
      const key = name.toLowerCase();
      headers.set(key, [...(headers.get(key) ?? []), value]);
    }
  }
  // REST duplicates are represented by multiValueHeaders. They supersede the
  // single-value entry, then use HTTP API v2's comma-joined representation.
  const multiHeaders = new Map<string, string[]>();
  if (multiple != null) {
    for (const [name, values] of Object.entries(object(multiple))) {
      if (name.length === 0 || !Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
        invalidEvent();
      }
      const key = name.toLowerCase();
      multiHeaders.set(key, [...(multiHeaders.get(key) ?? []), ...values]);
    }
  }
  for (const [name, values] of multiHeaders) headers.set(name, values);
  return Object.fromEntries([...headers].map(([name, values]) => [name, values.join(',')]));
}

/**
 * Adapt the REST proxy request to the existing FAQ shell's HTTP API v2 contract.
 * Routing/identity metadata is validated before touching the body. Binary bodies
 * remain encoded here; the streaming entrypoint rejects them explicitly because
 * the existing shell parses body directly as JSON.
 */
export function toFaqHttpApiEvent(input: unknown): APIGatewayProxyEventV2 {
  const event = object(input);
  const method = requiredString(event.httpMethod);
  const path = requiredString(event.path);
  const resource = requiredString(event.resource);
  if (!/^[A-Z]+$/.test(method) || !path.startsWith('/') || !resource.startsWith('/')) invalidEvent();
  const context = object(event.requestContext);
  const identity = object(context.identity);
  const sourceIp = requiredString(identity.sourceIp);
  const requestId = requiredString(context.requestId);
  const stage = requiredString(context.stage);
  if (typeof event.isBase64Encoded !== 'boolean') invalidEvent();

  const headers = normalizeHeaders(event.headers, event.multiValueHeaders);
  let pathParameters: Record<string, string> | undefined;
  if (event.pathParameters != null) {
    pathParameters = Object.fromEntries(Object.entries(object(event.pathParameters)).map(([name, value]) => {
      if (typeof value !== 'string') invalidEvent();
      return [name, value];
    }));
  }
  // Losing agentId must not silently route a named-agent request to the default.
  if (resource.includes('{agentId}') && pathParameters?.agentId === undefined) invalidEvent();

  const rawPath = stageFreePath(path, stage);
  const routeKey = `${method} ${stageFreePath(resource, stage)}`;
  const body = event.body;
  if (body != null && typeof body !== 'string') invalidEvent();
  return {
    version: '2.0',
    routeKey,
    rawPath,
    // FAQ has no query-string inputs. The REST payload cannot preserve the raw
    // query encoding, so do not manufacture a raw query string from decoded data.
    rawQueryString: '',
    headers,
    requestContext: {
      accountId: optionalString(context.accountId),
      apiId: optionalString(context.apiId),
      domainName: optionalString(context.domainName),
      domainPrefix: optionalString(context.domainPrefix),
      http: {
        method,
        path: rawPath,
        protocol: optionalString(context.protocol) || 'HTTP/1.1',
        sourceIp,
        userAgent: optionalString(identity.userAgent) || headers['user-agent'] || '',
      },
      requestId,
      routeKey,
      stage,
      time: optionalString(context.requestTime),
      timeEpoch: typeof context.requestTimeEpoch === 'number' && Number.isFinite(context.requestTimeEpoch)
        ? context.requestTimeEpoch : 0,
    },
    ...(pathParameters === undefined ? {} : { pathParameters }),
    ...(typeof body === 'string' ? { body } : {}),
    isBase64Encoded: event.isBase64Encoded,
  };
}
