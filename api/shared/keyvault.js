/**
 * SI Shop — Shared Key Vault Helper
 * Centralised secret retrieval via Azure Managed Identity.
 * All Azure Functions import from this module.
 */

const { DefaultAzureCredential } = require("@azure/identity");
const { SecretClient }           = require("@azure/keyvault-secrets");

const KV_URL = process.env.KEY_VAULT_URL;
const _cache = {};

let _client = null;
function getClient() {
  if (!_client) {
    const cred = new DefaultAzureCredential();
    _client = new SecretClient(KV_URL, cred);
  }
  return _client;
}

/**
 * Get a secret from Key Vault with in-memory caching.
 * Cache expires after 30 minutes.
 */
async function getSecret(name) {
  const now = Date.now();
  if (_cache[name] && now < _cache[name].exp) {
    return _cache[name].value;
  }
  const client = getClient();
  const secret = await client.getSecret(name);
  _cache[name] = { value: secret.value, exp: now + 30 * 60 * 1000 };
  return secret.value;
}

/**
 * Get multiple secrets in parallel.
 */
async function getSecrets(...names) {
  return Promise.all(names.map(n => getSecret(n)));
}

module.exports = { getSecret, getSecrets };
