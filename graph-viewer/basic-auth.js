const crypto = require('node:crypto');

function matches(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

module.exports = function createBasicAuthMiddleware(username, password) {
  const hasUsername = Boolean(username);
  const hasPassword = Boolean(password);

  if (!hasUsername && !hasPassword) {
    return function(_req, _res, next) { next(); };
  }
  if (!hasUsername || !hasPassword) {
    throw new Error('GRAPH_VIEWER_USER and GRAPH_VIEWER_PASSWORD must both be set');
  }

  return function(req, res, next) {
    const match = /^Basic\s+(\S+)$/i.exec(req.get('authorization') || '');
    let authorized = false;

    if (match) {
      const credentials = Buffer.from(match[1], 'base64').toString('utf8');
      const separator = credentials.indexOf(':');
      if (separator >= 0) {
        authorized = matches(credentials.slice(0, separator), username) &&
          matches(credentials.slice(separator + 1), password);
      }
    }

    if (authorized) return next();
    res.set('WWW-Authenticate', 'Basic realm="Graph Viewer", charset="UTF-8"');
    return res.status(401).send('Authentication required');
  };
};
