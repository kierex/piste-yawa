

const express = require('express');
const axios = require('axios');
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs').promises;
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Enhanced data structures
const total = new Map();
const activeTimers = new Map();
const requestQueue = new Map();
const rateLimiter = new Map();
const sessionLogs = new Map();

// Configuration
const CONFIG = {
    MAX_CONCURRENT_SESSIONS: 5,
    RATE_LIMIT_WINDOW: 60000, // 1 minute
    MAX_REQUESTS_PER_WINDOW: 30,
    REQUEST_TIMEOUT: 30000,
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY: 2000,
    LOG_RETENTION_DAYS: 7
};

// Enhanced logging
class Logger {
    static async log(sessionId, action, data) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            sessionId,
            action,
            data
        };

        if (!sessionLogs.has(sessionId)) {
            sessionLogs.set(sessionId, []);
        }
        sessionLogs.get(sessionId).push(logEntry);

        // Save to file periodically
        if (sessionLogs.get(sessionId).length % 10 === 0) {
            await this.saveToFile(sessionId);
        }
    }

    static async saveToFile(sessionId) {
        const logs = sessionLogs.get(sessionId);
        if (!logs) return;

        const filename = `logs/session_${sessionId}_${Date.now()}.json`;
        try {
            await fs.mkdir('logs', { recursive: true });
            await fs.writeFile(filename, JSON.stringify(logs, null, 2));
        } catch (error) {
            console.error('Failed to save logs:', error);
        }
    }

    static getLogs(sessionId) {
        return sessionLogs.get(sessionId) || [];
    }
}

// Rate limiter
class RateLimiter {
    static checkLimit(sessionId) {
        const now = Date.now();
        const sessionLimit = rateLimiter.get(sessionId);

        if (!sessionLimit) {
            rateLimiter.set(sessionId, {
                count: 1,
                resetTime: now + CONFIG.RATE_LIMIT_WINDOW
            });
            return true;
        }

        if (now > sessionLimit.resetTime) {
            rateLimiter.set(sessionId, {
                count: 1,
                resetTime: now + CONFIG.RATE_LIMIT_WINDOW
            });
            return true;
        }

        if (sessionLimit.count >= CONFIG.MAX_REQUESTS_PER_WINDOW) {
            return false;
        }

        sessionLimit.count++;
        return true;
    }
}

// Enhanced endpoints
app.get('/api/total', (req, res) => {
    const data = Array.from(total.values()).map((session, index) => ({
        sessionId: session.sessionId,
        sessionNumber: index + 1,
        url: session.url,
        sharedCount: session.count,
        targetAmount: session.target,
        postId: session.postId,
        status: session.status,
        progress: ((session.count / session.target) * 100).toFixed(2),
        startTime: session.startTime,
        estimatedCompletion: session.estimatedCompletion,
        error: session.error || null
    }));

    res.json({
        success: true,
        activeSessions: total.size,
        sessions: data,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/session/:sessionId/logs', (req, res) => {
    const { sessionId } = req.params;
    const logs = Logger.getLogs(sessionId);
    res.json({
        success: true,
        sessionId,
        logs
    });
});

app.delete('/api/session/:sessionId', async (req, res) => {
    const { sessionId } = req.params;

    if (!total.has(sessionId)) {
        return res.status(404).json({
            success: false,
            error: 'Session not found'
        });
    }

    await stopSharing(sessionId);
    total.delete(sessionId);

    res.json({
        success: true,
        message: 'Session stopped successfully'
    });
});

app.post('/api/submit', async (req, res) => {
    const {
        cookie,
        url,
        amount,
        interval,
        sessionId: providedSessionId
    } = req.body;

    // Validation
    if (!cookie || !url || !amount || !interval) {
        return res.status(400).json({
            success: false,
            error: 'Missing required fields: cookie, url, amount, or interval'
        });
    }

    if (amount < 1 || amount > 10000) {
        return res.status(400).json({
            success: false,
            error: 'Amount must be between 1 and 10000'
        });
    }

    if (interval < 1 || interval > 60) {
        return res.status(400).json({
            success: false,
            error: 'Interval must be between 1 and 60 seconds'
        });
    }

    if (total.size >= CONFIG.MAX_CONCURRENT_SESSIONS) {
        return res.status(429).json({
            success: false,
            error: `Maximum concurrent sessions (${CONFIG.MAX_CONCURRENT_SESSIONS}) reached`
        });
    }

    try {
        const cookies = await convertCookie(cookie);
        if (!cookies) {
            return res.status(400).json({
                success: false,
                error: 'Invalid cookies format'
            });
        }

        const sessionId = providedSessionId || crypto.randomBytes(16).toString('hex');

        const result = await share(cookies, url, amount, interval, sessionId);

        res.json({
            success: true,
            sessionId: result.sessionId,
            message: 'Sharing started successfully',
            estimatedCompletion: result.estimatedCompletion
        });
    } catch (err) {
        console.error('Error in /api/submit:', err);
        return res.status(500).json({
            success: false,
            error: err.message || 'Internal server error'
        });
    }
});

// Enhanced share function with better error handling
async function share(cookies, url, amount, interval, sessionId) {
    const id = await getPostID(url);
    if (!id) {
        throw new Error("Unable to get post ID: Invalid URL, private post, or friends-only visibility");
    }

    const accessToken = await getAccessToken(cookies);
    if (!accessToken) {
        throw new Error("Unable to get access token: Invalid cookies or session expired");
    }

    const startTime = Date.now();
    const estimatedCompletion = new Date(startTime + (amount * interval * 1000));

    const sessionData = {
        sessionId,
        url,
        postId: id,
        count: 0,
        target: amount,
        status: 'running',
        startTime: new Date().toISOString(),
        estimatedCompletion: estimatedCompletion.toISOString(),
        error: null,
        cookies,
        accessToken,
        interval,
        sharedCount: 0
    };

    total.set(sessionId, sessionData);
    await Logger.log(sessionId, 'session_started', { url, amount, interval });

    let sharedCount = 0;
    let consecutiveErrors = 0;

    async function sharePost() {
        // Check if session still exists
        if (!total.has(sessionId)) {
            return;
        }

        // Rate limiting check
        if (!RateLimiter.checkLimit(sessionId)) {
            await Logger.log(sessionId, 'rate_limited', { timestamp: new Date().toISOString() });
            return;
        }

        try {
            const response = await axios.post(
                `https://graph.facebook.com/me/feed?link=https://m.facebook.com/${id}&published=0&access_token=${accessToken}`,
                {},
                {
                    headers: {
                        'accept': '*/*',
                        'accept-encoding': 'gzip, deflate',
                        'connection': 'keep-alive',
                        'content-length': '0',
                        'cookie': cookies,
                        'host': 'graph.facebook.com'
                    },
                    timeout: CONFIG.REQUEST_TIMEOUT
                }
            );

            if (response.status === 200) {
                sharedCount++;
                consecutiveErrors = 0;

                const session = total.get(sessionId);
                if (session) {
                    session.count = sharedCount;
                    session.status = sharedCount >= amount ? 'completed' : 'running';
                    total.set(sessionId, session);
                }

                await Logger.log(sessionId, 'share_success', {
                    count: sharedCount,
                    total: amount,
                    timestamp: new Date().toISOString()
                });

                if (sharedCount >= amount) {
                    await stopSharing(sessionId);
                    await Logger.log(sessionId, 'session_completed', {
                        totalShared: sharedCount,
                        completedAt: new Date().toISOString()
                    });
                }
            }
        } catch (error) {
            consecutiveErrors++;
            await Logger.log(sessionId, 'share_error', {
                error: error.message,
                consecutiveErrors,
                timestamp: new Date().toISOString()
            });

            if (consecutiveErrors >= 5) {
                await Logger.log(sessionId, 'session_stopped_due_to_errors', {
                    reason: 'Too many consecutive errors',
                    errorCount: consecutiveErrors
                });
                await stopSharing(sessionId);
                if (total.has(sessionId)) {
                    const session = total.get(sessionId);
                    session.status = 'failed';
                    session.error = `Stopped after ${consecutiveErrors} consecutive errors`;
                    total.set(sessionId, session);
                }
            }
        }
    }

    // Start sharing with interval
    const timer = setInterval(sharePost, interval * 1000);
    activeTimers.set(sessionId, timer);

    // Set timeout to stop after completion
    const timeoutId = setTimeout(() => {
        if (total.has(sessionId) && total.get(sessionId).count < amount) {
            stopSharing(sessionId);
            const session = total.get(sessionId);
            if (session) {
                session.status = 'timeout';
                session.error = 'Session timed out before completion';
                total.set(sessionId, session);
            }
        }
    }, amount * interval * 1000 + 60000); // Add 1 minute grace period

    activeTimers.set(`${sessionId}_timeout`, timeoutId);

    return {
        sessionId,
        estimatedCompletion: estimatedCompletion.toISOString()
    };
}

async function stopSharing(sessionId) {
    const timer = activeTimers.get(sessionId);
    if (timer) {
        clearInterval(timer);
        activeTimers.delete(sessionId);
    }

    const timeoutId = activeTimers.get(`${sessionId}_timeout`);
    if (timeoutId) {
        clearTimeout(timeoutId);
        activeTimers.delete(`${sessionId}_timeout`);
    }

    await Logger.log(sessionId, 'session_stopped', {
        timestamp: new Date().toISOString()
    });
}

// Enhanced helper functions with retry logic
async function getPostID(url, retryCount = 0) {
    try {
        const response = await axios.post('https://id.traodoisub.com/api.php', 
            `link=${encodeURIComponent(url)}`,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                timeout: CONFIG.REQUEST_TIMEOUT
            }
        );

        if (response.data && response.data.id) {
            return response.data.id;
        }
        throw new Error('No ID returned from API');
    } catch (error) {
        if (retryCount < CONFIG.RETRY_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
            return getPostID(url, retryCount + 1);
        }
        return null;
    }
}

async function getAccessToken(cookie, retryCount = 0) {
    try {
        const headers = {
            'authority': 'business.facebook.com',
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
            'cache-control': 'max-age=0',
            'cookie': cookie,
            'referer': 'https://www.facebook.com/',
            'sec-ch-ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-site': 'same-origin',
            'upgrade-insecure-requests': '1',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        };

        const response = await axios.get('https://business.facebook.com/content_management', {
            headers,
            timeout: CONFIG.REQUEST_TIMEOUT
        });

        const tokenMatch = response.data.match(/"accessToken":"([^"]+)"/);
        if (tokenMatch && tokenMatch[1]) {
            return tokenMatch[1];
        }

        throw new Error('Access token not found in response');
    } catch (error) {
        if (retryCount < CONFIG.RETRY_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
            return getAccessToken(cookie, retryCount + 1);
        }
        return null;
    }
}

async function convertCookie(cookie) {
    try {
        // Handle both string and object input
        let cookies;
        if (typeof cookie === 'string') {
            try {
                cookies = JSON.parse(cookie);
            } catch {
                // If it's already a cookie string, return as is
                if (cookie.includes('=')) {
                    return cookie;
                }
                throw new Error('Invalid cookie format');
            }
        } else if (Array.isArray(cookie)) {
            cookies = cookie;
        } else {
            throw new Error('Cookie must be an array or JSON string');
        }

        const sbCookie = cookies.find(c => c.key === "sb");
        if (!sbCookie) {
            throw new Error("Cookie missing 'sb' field - invalid appstate");
        }

        const sbValue = sbCookie.value;
        const cookieString = `sb=${sbValue}; ${cookies
            .filter(c => c.key !== "sb")
            .map(c => `${c.key}=${c.value}`)
            .join('; ')}`;

        return cookieString;
    } catch (error) {
        console.error('Cookie conversion error:', error);
        throw new Error(error.message || "Error processing cookie");
    }
}

// Cleanup old sessions periodically
setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of total.entries()) {
        const sessionTime = new Date(session.startTime).getTime();
        if (session.status === 'completed' && (now - sessionTime) > 86400000) { // 24 hours
            total.delete(sessionId);
            sessionLogs.delete(sessionId);
        }
    }
}, 3600000); // Run every hour

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        activeSessions: total.size,
        maxConcurrent: CONFIG.MAX_CONCURRENT_SESSIONS,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: err.message
    });
});

// Create logs directory if it doesn't exist
(async () => {
    try {
        await fs.mkdir('logs', { recursive: true });
        console.log('Logs directory created');
    } catch (error) {
        console.error('Failed to create logs directory:', error);
    }
})();

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/api/health`);
    console.log(`Total endpoint: http://localhost:${PORT}/api/total`);
});

module.exports = app;const express = require('express');
const axios = require('axios');
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs').promises;
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Enhanced data structures
const total = new Map();
const activeTimers = new Map();
const requestQueue = new Map();
const rateLimiter = new Map();
const sessionLogs = new Map();

// Configuration
const CONFIG = {
    MAX_CONCURRENT_SESSIONS: 5,
    RATE_LIMIT_WINDOW: 60000, // 1 minute
    MAX_REQUESTS_PER_WINDOW: 30,
    REQUEST_TIMEOUT: 30000,
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY: 2000,
    LOG_RETENTION_DAYS: 7
};

// Enhanced logging
class Logger {
    static async log(sessionId, action, data) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            sessionId,
            action,
            data
        };

        if (!sessionLogs.has(sessionId)) {
            sessionLogs.set(sessionId, []);
        }
        sessionLogs.get(sessionId).push(logEntry);

        // Save to file periodically
        if (sessionLogs.get(sessionId).length % 10 === 0) {
            await this.saveToFile(sessionId);
        }
    }

    static async saveToFile(sessionId) {
        const logs = sessionLogs.get(sessionId);
        if (!logs) return;

        const filename = `logs/session_${sessionId}_${Date.now()}.json`;
        try {
            await fs.mkdir('logs', { recursive: true });
            await fs.writeFile(filename, JSON.stringify(logs, null, 2));
        } catch (error) {
            console.error('Failed to save logs:', error);
        }
    }

    static getLogs(sessionId) {
        return sessionLogs.get(sessionId) || [];
    }
}

// Rate limiter
class RateLimiter {
    static checkLimit(sessionId) {
        const now = Date.now();
        const sessionLimit = rateLimiter.get(sessionId);

        if (!sessionLimit) {
            rateLimiter.set(sessionId, {
                count: 1,
                resetTime: now + CONFIG.RATE_LIMIT_WINDOW
            });
            return true;
        }

        if (now > sessionLimit.resetTime) {
            rateLimiter.set(sessionId, {
                count: 1,
                resetTime: now + CONFIG.RATE_LIMIT_WINDOW
            });
            return true;
        }

        if (sessionLimit.count >= CONFIG.MAX_REQUESTS_PER_WINDOW) {
            return false;
        }

        sessionLimit.count++;
        return true;
    }
}

// Enhanced endpoints
app.get('/api/total', (req, res) => {
    const data = Array.from(total.values()).map((session, index) => ({
        sessionId: session.sessionId,
        sessionNumber: index + 1,
        url: session.url,
        sharedCount: session.count,
        targetAmount: session.target,
        postId: session.postId,
        status: session.status,
        progress: ((session.count / session.target) * 100).toFixed(2),
        startTime: session.startTime,
        estimatedCompletion: session.estimatedCompletion,
        error: session.error || null
    }));

    res.json({
        success: true,
        activeSessions: total.size,
        sessions: data,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/session/:sessionId/logs', (req, res) => {
    const { sessionId } = req.params;
    const logs = Logger.getLogs(sessionId);
    res.json({
        success: true,
        sessionId,
        logs
    });
});

app.delete('/api/session/:sessionId', async (req, res) => {
    const { sessionId } = req.params;

    if (!total.has(sessionId)) {
        return res.status(404).json({
            success: false,
            error: 'Session not found'
        });
    }

    await stopSharing(sessionId);
    total.delete(sessionId);

    res.json({
        success: true,
        message: 'Session stopped successfully'
    });
});

app.post('/api/submit', async (req, res) => {
    const {
        cookie,
        url,
        amount,
        interval,
        sessionId: providedSessionId
    } = req.body;

    // Validation
    if (!cookie || !url || !amount || !interval) {
        return res.status(400).json({
            success: false,
            error: 'Missing required fields: cookie, url, amount, or interval'
        });
    }

    if (amount < 1 || amount > 10000) {
        return res.status(400).json({
            success: false,
            error: 'Amount must be between 1 and 10000'
        });
    }

    if (interval < 1 || interval > 60) {
        return res.status(400).json({
            success: false,
            error: 'Interval must be between 1 and 60 seconds'
        });
    }

    if (total.size >= CONFIG.MAX_CONCURRENT_SESSIONS) {
        return res.status(429).json({
            success: false,
            error: `Maximum concurrent sessions (${CONFIG.MAX_CONCURRENT_SESSIONS}) reached`
        });
    }

    try {
        const cookies = await convertCookie(cookie);
        if (!cookies) {
            return res.status(400).json({
                success: false,
                error: 'Invalid cookies format'
            });
        }

        const sessionId = providedSessionId || crypto.randomBytes(16).toString('hex');

        const result = await share(cookies, url, amount, interval, sessionId);

        res.json({
            success: true,
            sessionId: result.sessionId,
            message: 'Sharing started successfully',
            estimatedCompletion: result.estimatedCompletion
        });
    } catch (err) {
        console.error('Error in /api/submit:', err);
        return res.status(500).json({
            success: false,
            error: err.message || 'Internal server error'
        });
    }
});

// Enhanced share function with better error handling
async function share(cookies, url, amount, interval, sessionId) {
    const id = await getPostID(url);
    if (!id) {
        throw new Error("Unable to get post ID: Invalid URL, private post, or friends-only visibility");
    }

    const accessToken = await getAccessToken(cookies);
    if (!accessToken) {
        throw new Error("Unable to get access token: Invalid cookies or session expired");
    }

    const startTime = Date.now();
    const estimatedCompletion = new Date(startTime + (amount * interval * 1000));

    const sessionData = {
        sessionId,
        url,
        postId: id,
        count: 0,
        target: amount,
        status: 'running',
        startTime: new Date().toISOString(),
        estimatedCompletion: estimatedCompletion.toISOString(),
        error: null,
        cookies,
        accessToken,
        interval,
        sharedCount: 0
    };

    total.set(sessionId, sessionData);
    await Logger.log(sessionId, 'session_started', { url, amount, interval });

    let sharedCount = 0;
    let consecutiveErrors = 0;

    async function sharePost() {
        // Check if session still exists
        if (!total.has(sessionId)) {
            return;
        }

        // Rate limiting check
        if (!RateLimiter.checkLimit(sessionId)) {
            await Logger.log(sessionId, 'rate_limited', { timestamp: new Date().toISOString() });
            return;
        }

        try {
            const response = await axios.post(
                `https://graph.facebook.com/me/feed?link=https://m.facebook.com/${id}&published=0&access_token=${accessToken}`,
                {},
                {
                    headers: {
                        'accept': '*/*',
                        'accept-encoding': 'gzip, deflate',
                        'connection': 'keep-alive',
                        'content-length': '0',
                        'cookie': cookies,
                        'host': 'graph.facebook.com'
                    },
                    timeout: CONFIG.REQUEST_TIMEOUT
                }
            );

            if (response.status === 200) {
                sharedCount++;
                consecutiveErrors = 0;

                const session = total.get(sessionId);
                if (session) {
                    session.count = sharedCount;
                    session.status = sharedCount >= amount ? 'completed' : 'running';
                    total.set(sessionId, session);
                }

                await Logger.log(sessionId, 'share_success', {
                    count: sharedCount,
                    total: amount,
                    timestamp: new Date().toISOString()
                });

                if (sharedCount >= amount) {
                    await stopSharing(sessionId);
                    await Logger.log(sessionId, 'session_completed', {
                        totalShared: sharedCount,
                        completedAt: new Date().toISOString()
                    });
                }
            }
        } catch (error) {
            consecutiveErrors++;
            await Logger.log(sessionId, 'share_error', {
                error: error.message,
                consecutiveErrors,
                timestamp: new Date().toISOString()
            });

            if (consecutiveErrors >= 5) {
                await Logger.log(sessionId, 'session_stopped_due_to_errors', {
                    reason: 'Too many consecutive errors',
                    errorCount: consecutiveErrors
                });
                await stopSharing(sessionId);
                if (total.has(sessionId)) {
                    const session = total.get(sessionId);
                    session.status = 'failed';
                    session.error = `Stopped after ${consecutiveErrors} consecutive errors`;
                    total.set(sessionId, session);
                }
            }
        }
    }

    // Start sharing with interval
    const timer = setInterval(sharePost, interval * 1000);
    activeTimers.set(sessionId, timer);

    // Set timeout to stop after completion
    const timeoutId = setTimeout(() => {
        if (total.has(sessionId) && total.get(sessionId).count < amount) {
            stopSharing(sessionId);
            const session = total.get(sessionId);
            if (session) {
                session.status = 'timeout';
                session.error = 'Session timed out before completion';
                total.set(sessionId, session);
            }
        }
    }, amount * interval * 1000 + 60000); // Add 1 minute grace period

    activeTimers.set(`${sessionId}_timeout`, timeoutId);

    return {
        sessionId,
        estimatedCompletion: estimatedCompletion.toISOString()
    };
}

async function stopSharing(sessionId) {
    const timer = activeTimers.get(sessionId);
    if (timer) {
        clearInterval(timer);
        activeTimers.delete(sessionId);
    }

    const timeoutId = activeTimers.get(`${sessionId}_timeout`);
    if (timeoutId) {
        clearTimeout(timeoutId);
        activeTimers.delete(`${sessionId}_timeout`);
    }

    await Logger.log(sessionId, 'session_stopped', {
        timestamp: new Date().toISOString()
    });
}

// Enhanced helper functions with retry logic
async function getPostID(url, retryCount = 0) {
    try {
        const response = await axios.post('https://id.traodoisub.com/api.php', 
            `link=${encodeURIComponent(url)}`,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                timeout: CONFIG.REQUEST_TIMEOUT
            }
        );

        if (response.data && response.data.id) {
            return response.data.id;
        }
        throw new Error('No ID returned from API');
    } catch (error) {
        if (retryCount < CONFIG.RETRY_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
            return getPostID(url, retryCount + 1);
        }
        return null;
    }
}

async function getAccessToken(cookie, retryCount = 0) {
    try {
        const headers = {
            'authority': 'business.facebook.com',
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
            'cache-control': 'max-age=0',
            'cookie': cookie,
            'referer': 'https://www.facebook.com/',
            'sec-ch-ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-site': 'same-origin',
            'upgrade-insecure-requests': '1',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        };

        const response = await axios.get('https://business.facebook.com/content_management', {
            headers,
            timeout: CONFIG.REQUEST_TIMEOUT
        });

        const tokenMatch = response.data.match(/"accessToken":"([^"]+)"/);
        if (tokenMatch && tokenMatch[1]) {
            return tokenMatch[1];
        }

        throw new Error('Access token not found in response');
    } catch (error) {
        if (retryCount < CONFIG.RETRY_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
            return getAccessToken(cookie, retryCount + 1);
        }
        return null;
    }
}

async function convertCookie(cookie) {
    try {
        // Handle both string and object input
        let cookies;
        if (typeof cookie === 'string') {
            try {
                cookies = JSON.parse(cookie);
            } catch {
                // If it's already a cookie string, return as is
                if (cookie.includes('=')) {
                    return cookie;
                }
                throw new Error('Invalid cookie format');
            }
        } else if (Array.isArray(cookie)) {
            cookies = cookie;
        } else {
            throw new Error('Cookie must be an array or JSON string');
        }

        const sbCookie = cookies.find(c => c.key === "sb");
        if (!sbCookie) {
            throw new Error("Cookie missing 'sb' field - invalid appstate");
        }

        const sbValue = sbCookie.value;
        const cookieString = `sb=${sbValue}; ${cookies
            .filter(c => c.key !== "sb")
            .map(c => `${c.key}=${c.value}`)
            .join('; ')}`;

        return cookieString;
    } catch (error) {
        console.error('Cookie conversion error:', error);
        throw new Error(error.message || "Error processing cookie");
    }
}

// Cleanup old sessions periodically
setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of total.entries()) {
        const sessionTime = new Date(session.startTime).getTime();
        if (session.status === 'completed' && (now - sessionTime) > 86400000) { // 24 hours
            total.delete(sessionId);
            sessionLogs.delete(sessionId);
        }
    }
}, 3600000); // Run every hour

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        activeSessions: total.size,
        maxConcurrent: CONFIG.MAX_CONCURRENT_SESSIONS,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: err.message
    });
});

// Create logs directory if it doesn't exist
(async () => {
    try {
        await fs.mkdir('logs', { recursive: true });
        console.log('Logs directory created');
    } catch (error) {
        console.error('Failed to create logs directory:', error);
    }
})();

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/api/health`);
    console.log(`Total endpoint: http://localhost:${PORT}/api/total`);
});

module.exports = app;