import { request } from './httpClient';

describe('request', () => {
  it('stops waiting when the TCP handshake never finishes', async () => {
    const started = Date.now();
    await expect(request({
      url: 'https://192.0.2.1/',
      method: 'GET',
      timeout: 400,
    })).rejects.toThrow(/timed out|failed/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
