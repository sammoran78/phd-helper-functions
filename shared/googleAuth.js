/**
 * Google Authentication Utility
 * Supports both OAuth tokens and Service Account authentication
 */

const { google } = require('googleapis');

let cachedOAuthTokens = null;
let oauthTokenExpiry = null;
let cachedServiceAuth = null;

const SCOPES = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/documents'
];

/**
 * Get Service Account auth client
 * Reads from GOOGLE_SERVICE_ACCOUNT_JSON env var (JSON string)
 */
function getServiceAccountAuth() {
    if (cachedServiceAuth) return cachedServiceAuth;
    
    const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountJson) {
        return null;
    }
    
    try {
        const credentials = JSON.parse(serviceAccountJson);
        cachedServiceAuth = new google.auth.GoogleAuth({
            credentials,
            scopes: SCOPES
        });
        return cachedServiceAuth;
    } catch (error) {
        console.error('Failed to parse service account JSON:', error.message);
        return null;
    }
}

/**
 * Get OAuth2 client with credentials from environment variables
 */
function getOAuth2Client() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    
    if (!clientId || !clientSecret) {
        return null;
    }
    
    return new google.auth.OAuth2(clientId, clientSecret);
}

/**
 * Get authenticated OAuth2 client with valid access token
 * Automatically refreshes token if expired
 */
async function getOAuthClient() {
    const oauth2Client = getOAuth2Client();
    if (!oauth2Client) return null;
    
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
    if (!refreshToken) return null;
    
    // Check if we have a cached valid token
    if (cachedOAuthTokens && oauthTokenExpiry && Date.now() < oauthTokenExpiry - 60000) {
        oauth2Client.setCredentials(cachedOAuthTokens);
        return oauth2Client;
    }
    
    // Set refresh token and get new access token
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    
    try {
        const { credentials } = await oauth2Client.refreshAccessToken();
        cachedOAuthTokens = credentials;
        oauthTokenExpiry = credentials.expiry_date || (Date.now() + 3600000);
        oauth2Client.setCredentials(credentials);
        return oauth2Client;
    } catch (error) {
        console.error('Failed to refresh Google OAuth token:', error.message);
        return null;
    }
}

/**
 * Get authenticated client - prefers Service Account, falls back to OAuth
 */
async function getAuthenticatedClient() {
    // Try service account first (better for server-side)
    const serviceAuth = getServiceAccountAuth();
    if (serviceAuth) {
        return serviceAuth;
    }
    
    // Fall back to OAuth
    const oauthClient = await getOAuthClient();
    if (oauthClient) {
        return oauthClient;
    }
    
    throw new Error('No Google authentication configured. Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN');
}

/**
 * Get authenticated Google Calendar client
 */
async function getCalendarClient() {
    const auth = await getAuthenticatedClient();
    return google.calendar({ version: 'v3', auth });
}

/**
 * Get authenticated Google Drive client
 */
async function getDriveClient() {
    const auth = await getAuthenticatedClient();
    return google.drive({ version: 'v3', auth });
}

/**
 * Get authenticated Google Docs client
 */
async function getDocsClient() {
    const auth = await getAuthenticatedClient();
    return google.docs({ version: 'v1', auth });
}

module.exports = {
    getOAuth2Client,
    getAuthenticatedClient,
    getCalendarClient,
    getDriveClient,
    getDocsClient,
    getServiceAccountAuth,
    getOAuthClient
};
