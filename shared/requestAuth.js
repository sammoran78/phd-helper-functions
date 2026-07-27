const crypto = require('crypto');

function base64UrlEncode(value) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return buffer
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

function timingSafeEqualText(left, right) {
    const a = Buffer.from((left || '').toString());
    const b = Buffer.from((right || '').toString());
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getBearerToken(request) {
    const header = request.headers.get('authorization') || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1] : null;
}

function verifyDashboardRequest(request) {
    try {
        const token = getBearerToken(request);
        if (!token) return null;

        const parts = token.split('.');
        if (parts.length !== 3) return null;

        const [headerB64, payloadB64, signature] = parts;
        const data = `${headerB64}.${payloadB64}`;
        const secret = process.env.AUTH_JWT_SECRET || 'dev-secret-change-me';
        const expected = base64UrlEncode(
            crypto.createHmac('sha256', secret).update(data).digest()
        );
        if (!timingSafeEqualText(signature, expected)) return null;

        const payloadText = Buffer.from(
            payloadB64.replace(/-/g, '+').replace(/_/g, '/'),
            'base64'
        ).toString('utf8');
        const payload = JSON.parse(payloadText);
        if (payload.exp && Number(payload.exp) <= Math.floor(Date.now() / 1000)) return null;
        return payload;
    } catch {
        return null;
    }
}

function verifyWorkerRequest(request) {
    const configuredToken = process.env.PODCAST_WORKER_TOKEN;
    if (!configuredToken) return false;
    const suppliedToken = request.headers.get('x-podcast-worker-token') || '';
    return timingSafeEqualText(suppliedToken, configuredToken);
}

module.exports = {
    verifyDashboardRequest,
    verifyWorkerRequest
};
