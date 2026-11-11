import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const createBasicAuthMiddleware = require('../graph-viewer/basic-auth');

function invoke(middleware, authorization) {
  let nextCalled = false;
  let statusCode;
  const headers = {};
  const response = {
    set(name, value) { headers[name.toLowerCase()] = value; return this; },
    status(code) { statusCode = code; return this; },
    send(body) { this.body = body; return this; }
  };

  middleware({ get: () => authorization }, response, () => { nextCalled = true; });
  return { nextCalled, statusCode, headers, body: response.body };
}

test('Basic Auth is disabled when both credentials are empty', () => {
  const result = invoke(createBasicAuthMiddleware('', ''), undefined);
  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, undefined);
});

test('Basic Auth accepts valid credentials', () => {
  const authorization = 'Basic ' + Buffer.from('viewer:secret').toString('base64');
  const result = invoke(createBasicAuthMiddleware('viewer', 'secret'), authorization);
  assert.equal(result.nextCalled, true);
});

test('Basic Auth rejects invalid credentials with a challenge', () => {
  const authorization = 'Basic ' + Buffer.from('viewer:wrong').toString('base64');
  const result = invoke(createBasicAuthMiddleware('viewer', 'secret'), authorization);
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 401);
  assert.match(result.headers['www-authenticate'], /^Basic realm=/);
});

test('Basic Auth rejects incomplete configuration', () => {
  assert.throws(() => createBasicAuthMiddleware('viewer', ''), /must both be set/);
});
