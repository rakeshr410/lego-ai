#!/usr/bin/env node
// A stand-in for the Anthropic Messages API for e2e runs, so no test ever calls (or pays for)
// the real API. Point the web server at it with ANTHROPIC_BASE_URL=http://127.0.0.1:4410.
//
//   POST /v1/messages     canned answer, as JSON or (stream: true) as server-sent events; a
//                         question containing "[slow]" streams a long answer, a word every 150 ms;
//                         a request for structured output (output_config.format, the mock
//                         interview's feedback) gets JSON that fits its schema
//   GET  /health          200
//   GET  /__requests      the request bodies received so far (for assertions)
//   GET  /__aborted       how many streams the client closed before they finished
//   POST /__reset         forget both
import { createServer } from 'node:http';

const port = Number(process.env.MOCK_ANTHROPIC_PORT ?? 4410);
const requests = [];
let aborted = 0;

const ANSWER = 'Mock tutor answer: the passage explains how the login form validates input before it calls the API.';

/** JSON for the interview feedback schema (web/src/lib/server/interview/prompt.ts feedbackSchema). */
function structured(schema) {
  const keys = (name) => schema?.properties?.[name]?.items?.properties?.key?.enum ?? [];
  return JSON.stringify({
    summary: 'Mock feedback: you asked about users and devices before designing.',
    stages: keys('stages').map((key, i) => ({
      key,
      rating: i === 0 ? 3 : 0,
      strengths: i === 0 ? ['Asked who the users are first.'] : [],
      improvements: i === 0 ? ['Name a load-time target.'] : [],
    })),
    dimensions: keys('dimensions').map((key, i) => ({ key, rating: i === 0 ? 3 : 0, note: i === 0 ? 'Scoped the problem.' : '' })),
    nextSteps: ['Practise cursor pagination.'],
  });
}

function message(model, format) {
  return {
    id: `msg_mock_${requests.length}`,
    type: 'message',
    role: 'assistant',
    model: model ?? 'claude-mock',
    content: [{ type: 'text', text: format?.type === 'json_schema' ? structured(format.schema) : ANSWER }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 24, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 },
  };
}

const SLOW_ANSWER = Array.from({ length: 200 }, (_, i) => `slow${i} `).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The text of the last user turn (a string or text blocks). */
function lastQuestion(body) {
  const turn = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
  const c = turn?.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text ?? '').join('') : '';
}

async function stream(res, model, slow) {
  const m = message(model);
  let finished = false;
  res.on('close', () => {
    if (!finished) aborted++;
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': m.id });
  send('message_start', { message: { ...m, content: [], stop_reason: null, usage: { ...m.usage, output_tokens: 1 } } });
  send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  for (const word of (slow ? SLOW_ANSWER : ANSWER).split(/(?<= )/)) {
    if (res.destroyed) return;
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: word } });
    if (slow) await sleep(150);
  }
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: m.usage.output_tokens } });
  send('message_stop', {});
  finished = true;
  res.end();
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://mock');
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/__requests') return json(res, 200, requests);
  if (req.method === 'GET' && url.pathname === '/__aborted') return json(res, 200, { aborted });
  if (req.method === 'POST' && url.pathname === '/__reset') {
    requests.length = 0;
    aborted = 0;
    return json(res, 200, { ok: true });
  }
  if (req.method !== 'POST' || url.pathname !== '/v1/messages') {
    return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: `mock: ${req.method} ${url.pathname}` } });
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'mock: invalid JSON' } });
    }
    if (!req.headers['x-api-key'] && !req.headers.authorization) {
      return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'mock: missing API key' } });
    }
    requests.push(body);
    if (body.stream) return void stream(res, body.model, lastQuestion(body).includes('[slow]'));
    json(res, 200, message(body.model, body.output_config?.format));
  });
}).listen(port, '127.0.0.1', () => console.log(`mock Anthropic API on http://127.0.0.1:${port}`));
