'use strict';

const crypto = require('node:crypto');
const { net } = require('electron');

/**
 * Anonymous, opt-out global minutes counter.
 *
 * Identity is a locally-generated Ed25519 keypair, never a machine id and
 * never anything the user typed: only the SHA-256 hash of its public key
 * ever leaves the device, as `anon_id`. The private key lives only in
 * `secret`, the same encrypted-at-rest store (see secret-file.js) the study
 * room's own identity uses.
 *
 * The endpoint and its API key come from the environment
 * (FLOWCUS_STATS_ENDPOINT / FLOWCUS_STATS_API_KEY) rather than being
 * hardcoded, so a build with neither set simply never talks to the network:
 * reporting and fetching both silently no-op.
 */
function createGlobalStats({
  secret,
  endpoint = process.env.FLOWCUS_STATS_ENDPOINT,
  apiKey = process.env.FLOWCUS_STATS_API_KEY,
}) {
  let anonId = null;

  function getAnonId() {
    if (anonId) return anonId;

    const stored = secret.read();
    let privateKey;
    if (stored) {
      privateKey = crypto.createPrivateKey({ key: stored, format: 'der', type: 'pkcs8' });
    } else {
      ({ privateKey } = crypto.generateKeyPairSync('ed25519'));
      secret.write(privateKey.export({ format: 'der', type: 'pkcs8' }));
    }

    const rawPublicKey = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    anonId = crypto.createHash('sha256').update(rawPublicKey).digest('hex');
    return anonId;
  }

  function request(method, path, body) {
    return new Promise((resolve) => {
      if (!endpoint || !apiKey) {
        resolve(null);
        return;
      }
      const req = net.request({ method, url: `${endpoint}${path}` });
      req.setHeader('X-Stats-Key', apiKey);
      if (body) req.setHeader('Content-Type', 'application/json');

      let responseBody = '';
      req.on('response', (response) => {
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode, body: responseBody }));
      });
      req.on('error', () => resolve(null));

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  /**
   * Fires once a solo focus block ends. Best-effort: nothing awaits this, and
   * any network or server failure is dropped silently rather than surfaced.
   */
  function reportMinutes(minutesSpent) {
    if (!Number.isFinite(minutesSpent) || minutesSpent <= 0) return;
    request('POST', '/minutes', {
      anon_id: getAnonId(),
      minutes_spent: Math.round(minutesSpent),
    });
  }

  /** Reads the whitelisted global aggregate. Resolves null on any failure or when unconfigured. */
  async function fetchGlobalMinutes() {
    const result = await request('GET', '/minutes/total');
    if (!result) return null;
    try {
      const parsed = JSON.parse(result.body);
      return Number.isFinite(parsed.total_minutes) ? parsed.total_minutes : null;
    } catch {
      return null;
    }
  }

  return { reportMinutes, fetchGlobalMinutes };
}

module.exports = { createGlobalStats };
