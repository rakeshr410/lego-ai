import { describe, expect, it } from 'vitest';
import { pageCsp, roomCsp, securityHeaders } from './security-headers';

describe('the interview room’s policy', () => {
  it('is the site’s policy plus a worker from a blob URL and media from blobs, nothing from another origin', () => {
    const page = pageCsp({ scriptHashes: ['sha256-abc'] });
    const room = roomCsp({ scriptHashes: ['sha256-abc'] });
    expect(room).toContain("worker-src 'self' blob:");
    expect(room).toContain("media-src 'self' blob:");
    expect(room.replace("; worker-src 'self' blob:; media-src 'self' blob:", '')).toBe(page);
    expect(page).not.toContain('worker-src');
    expect(room).not.toMatch(/https?:\/\/(?!challenges\.cloudflare\.com|fonts\.)/);
  });

  it('in a voice build adds Daily’s hosts to scripts and connections, and only there', () => {
    const room = roomCsp({ scriptHashes: ['sha256-abc'], voice: true });
    const directives = Object.fromEntries(room.split('; ').map((d) => [d.split(' ')[0], d]));
    expect(directives['script-src']).toContain('https://*.daily.co https://*.dailywebrtc.com https://*.dailywebrtc.net');
    expect(directives['connect-src']).toContain('wss://*.daily.co wss://*.dailywebrtc.com wss://*.dailywebrtc.net');
    expect(directives['connect-src']).toContain('https://*.daily.co');
    expect(room).not.toContain('unsafe-eval');
    for (const d of ['img-src', 'font-src', 'style-src', 'frame-src', 'media-src', 'worker-src']) expect(directives[d]).not.toContain('daily');
  });
});

describe('the Permissions-Policy', () => {
  it('denies the microphone everywhere except where the voice room asks for it', () => {
    expect(securityHeaders(null)['Permissions-Policy']).toBe('camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    expect(securityHeaders(null, { microphone: true })['Permissions-Policy']).toBe('camera=(), microphone=(self), geolocation=(), payment=(), usb=()');
  });
});
