const { app } = require('@azure/functions');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USERS_PATH = path.join(__dirname, '../data/users.json');

function base64UrlEncode(value) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return buf
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

function signToken(payload) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const secret = process.env.AUTH_JWT_SECRET || 'dev-secret-change-me';

    const headerB64 = base64UrlEncode(JSON.stringify(header));
    const payloadB64 = base64UrlEncode(JSON.stringify(payload));
    const data = `${headerB64}.${payloadB64}`;

    const signature = crypto
        .createHmac('sha256', secret)
        .update(data)
        .digest();

    const sigB64 = base64UrlEncode(signature);
    return `${data}.${sigB64}`;
}

function loadUsers() {
    if (!fs.existsSync(USERS_PATH)) return [];
    const raw = fs.readFileSync(USERS_PATH, 'utf8');
    const users = JSON.parse(raw);
    return Array.isArray(users) ? users : [];
}

// POST /api/auth/login - validate credentials against backend users.json
app.http('AuthLogin', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'auth/login',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const email = (body?.email || '').toString().trim();
            const password = (body?.password || '').toString();

            if (!email || !password) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'email and password are required' })
                };
            }

            const users = loadUsers();
            const user = users.find(u => u?.email === email && u?.password === password);

            if (!user) {
                return {
                    status: 401,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Invalid email or password' })
                };
            }

            const safeUser = {
                email: user.email,
                name: user.name,
                role: user.role
            };

            const payload = {
                ...safeUser,
                exp: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60)
            };

            const token = signToken(payload);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, user: safeUser })
            };
        } catch (error) {
            context.error('AuthLogin Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Login failed', details: error.message })
            };
        }
    }
});
