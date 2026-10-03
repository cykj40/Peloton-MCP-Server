import nock from 'nock';

// Fail unmatched requests rather than ever falling through to the live Peloton API.
nock.disableNetConnect();
for (const key of ['PELOTON_BEARER_TOKEN', 'PELOTON_SESSION_COOKIE', 'PELOTON_USERNAME', 'PELOTON_PASSWORD', 'TURSO_AUTH_TOKEN']) {
  delete process.env[key];
}
