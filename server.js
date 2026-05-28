const express = require('express');
const axios = require('axios');
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs').promises;
const crypto = require('crypto');
const HttpsProxyAgent = require('https-proxy-agent');
const HttpProxyAgent = require('http-proxy-agent');

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
const proxyStats = new Map(); // Track proxy performance

// Configuration with anti-detection enhancements
const CONFIG = {
    MAX_CONCURRENT_SESSIONS: 3,
    RATE_LIMIT_WINDOW: 120000,
    MAX_REQUESTS_PER_WINDOW: 15,
    REQUEST_TIMEOUT: 45000,
    RETRY_ATTEMPTS: 2,
    RETRY_DELAY: 5000,
    LOG_RETENTION_DAYS: 7,
    // Anti-detection settings
    MIN_DELAY_VARIATION: 2000,
    MAX_DELAY_VARIATION: 8000,
    USER_AGENT_ROTATION: true,
    PROXY_ROTATION: true,
    USE_DELAY_BETWEEN_REQUESTS: true,
    RANDOM_START_OFFSET: true,
    // Proxy settings
    PROXY_FAILURE_THRESHOLD: 3,
    PROXY_BAN_TIME: 300000, // 5 minutes ban for failing proxies
    PROXY_ROTATION_INTERVAL: 60000, // Rotate proxy every minute
    PROXY_HEALTH_CHECK_INTERVAL: 300000 // Check proxy health every 5 minutes
};

// User agent rotation pool
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'
];

// Proxy pool configuration
class ProxyManager {
    constructor() {
        this.proxies = [];
        this.proxyStatus = new Map();
        this.currentProxyIndex = 0;
        this.loadProxiesFromFile();
    }

    async loadProxiesFromFile() {
        try {
            // Try to load proxies from file
            const proxyFile = await fs.readFile('proxies.json', 'utf8').catch(() => '[]');
            const proxyList = JSON.parse(proxyFile);
            
            if (proxyList.length > 0) {
                this.proxies = proxyList;
                console.log(`✅ Loaded ${this.proxies.length} proxies from proxies.json`);
            } else {
                // Default proxy list (add your own proxies here)
                this.proxies = [
                    // 'http://username:password@host:port',
                    // 'socks5://username:password@host:port',
                    // 'http://host:port',
                ];
                console.log('⚠️ No proxies configured. Running without proxy.');
            }

            // Initialize proxy status
            this.proxies.forEach(proxy => {
                this.proxyStatus.set(proxy, {
                    failures: 0,
                    lastUsed: 0,
                    isBanned: false,
                    banUntil: 0,
                    successCount: 0,
                    responseTime: []
                });
            });
        } catch (error) {
            console.error('Error loading proxies:', error);
        }
    }

    async saveProxiesToFile() {
        try {
            await fs.writeFile('proxies.json', JSON.stringify(this.proxies, null, 2));
            console.log('✅ Proxies saved to proxies.json');
        } catch (error) {
            console.error('Error saving proxies:', error);
        }
    }

    addProxy(proxyUrl) {
        if (!this.proxies.includes(proxyUrl)) {
            this.proxies.push(proxyUrl);
            this.proxyStatus.set(proxyUrl, {
                failures: 0,
                lastUsed: 0,
                isBanned: false,
                banUntil: 0,
                successCount: 0,
                responseTime: []
            });
            this.saveProxiesToFile();
            console.log(`➕ Added proxy: ${proxyUrl}`);
            return true;
        }
        return false;
    }

    removeProxy(proxyUrl) {
        const index = this.proxies.indexOf(proxyUrl);
        if (index > -1) {
            this.proxies.splice(index, 1);
            this.proxyStatus.delete(proxyUrl);
            this.saveProxiesToFile();
            console.log(`❌ Removed proxy: ${proxyUrl}`);
            return true;
        }
        return false;
    }

    getRandomProxy() {
        if (!CONFIG.PROXY_ROTATION || this.proxies.length === 0) {
            return null;
        }

        // Get available proxies (not banned)
        const availableProxies = this.proxies.filter(proxy => {
            const status = this.proxyStatus.get(proxy);
            if (!status) return true;
            if (status.isBanned && Date.now() < status.banUntil) return false;
            if (status.isBanned && Date.now() >= status.banUntil) {
                status.isBanned = false;
                status.failures = 0;
                return true;
            }
            return true;
        });

        if (availableProxies.length === 0) {
            console.warn('⚠️ No available proxies, resetting all bans');
            this.resetAllBans();
            return this.proxies[0] || null;
        }

        // Rotate through available proxies with weighted selection (prefer successful ones)
        const weightedProxies = [];
        availableProxies.forEach(proxy => {
            const status = this.proxyStatus.get(proxy);
            const weight = Math.max(1, 10 - (status?.failures || 0));
            for (let i = 0; i < weight; i++) {
                weightedProxies.push(proxy);
            }
        });

        const selectedProxy = weightedProxies[Math.floor(Math.random() * weightedProxies.length)];
        const status = this.proxyStatus.get(selectedProxy);
        if (status) {
            status.lastUsed = Date.now();
        }

        return selectedProxy;
    }

    getNextProxy() {
        if (this.proxies.length === 0) return null;
        
        // Try to get next non-banned proxy
        for (let i = 0; i < this.proxies.length; i++) {
            this.currentProxyIndex = (this.currentProxyIndex + 1) % this.proxies.length;
            const proxy = this.proxies[this.currentProxyIndex];
            const status = this.proxyStatus.get(proxy);
            
            if (!status?.isBanned || (status.isBanned && Date.now() >= status.banUntil)) {
                if (status?.isBanned && Date.now() >= status.banUntil) {
                    status.isBanned = false;
                    status.failures = 0;
                }
                return proxy;
            }
        }
        
        // If all proxies are banned, reset all bans
        this.resetAllBans();
        return this.proxies[0];
    }

    reportSuccess(proxyUrl, responseTime) {
        const status = this.proxyStatus.get(proxyUrl);
        if (status) {
            status.failures = 0;
            status.successCount++;
            status.responseTime.push(responseTime);
            // Keep only last 10 response times
            if (status.responseTime.length > 10) {
                status.responseTime.shift();
            }
        }
    }

    reportFailure(proxyUrl, error) {
        const status = this.proxyStatus.get(proxyUrl);
        if (status) {
            status.failures++;
            
            // Check if proxy should be banned
            if (status.failures >= CONFIG.PROXY_FAILURE_THRESHOLD) {
                status.isBanned = true;
                status.banUntil = Date.now() + CONFIG.PROXY_BAN_TIME;
                console.warn(`🚫 Proxy banned: ${proxyUrl} for ${CONFIG.PROXY_BAN_TIME / 1000}s (${status.failures} failures)`);
            }
            
            console.error(`❌ Proxy error (${status.failures}/${CONFIG.PROXY_FAILURE_THRESHOLD}): ${proxyUrl} - ${error.message}`);
        }
    }

    resetAllBans() {
        this.proxyStatus.forEach((status, proxy) => {
            status.isBanned = false;
            status.failures = 0;
            status.banUntil = 0;
        });
        console.log('🔄 Reset all proxy bans');
    }

    getProxyAgent(proxyUrl) {
        if (!proxyUrl) return null;
        
        try {
            const url = new URL(proxyUrl);
            const isHttps = url.protocol === 'https:';
            
            if (url.protocol === 'socks5:' || url.protocol === 'socks5h:') {
                // For SOCKS5 proxies, you'd need socks-proxy-agent package
                console.warn('SOCKS5 proxy support requires "socks-proxy-agent" package');
                return null;
            }
            
            const agent = isHttps 
                ? new HttpsProxyAgent(proxyUrl)
                : new HttpProxyAgent(proxyUrl);
            
            return agent;
        } catch (error) {
            console.error('Error creating proxy agent:', error);
            return null;
        }
    }

    getProxyStats() {
        const stats = {};
        this.proxies.forEach(proxy => {
            const status = this.proxyStatus.get(proxy);
            if (status) {
                const avgResponseTime = status.responseTime.length > 0
                    ? status.responseTime.reduce((a, b) => a + b, 0) / status.responseTime.length
                    : 0;
                
                stats[proxy] = {
                    failures: status.failures,
                    isBanned: status.isBanned,
                    successCount: status.successCount,
                    avgResponseTime: Math.round(avgResponseTime),
                    lastUsed: status.lastUsed ? new Date(status.lastUsed).toISOString() : 'never'
                };
            }
        });
        return stats;
    }
}

// Initialize proxy manager
const proxyManager = new ProxyManager();

// Enhanced logging with security focus
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

        if (sessionLogs.get(sessionId).length > 100) {
            sessionLogs.get(sessionId).shift();
        }

        if (sessionLogs.get(sessionId).length % 20 === 0) {
            await this.saveToFile(sessionId);
        }
    }

    static async saveToFile(sessionId) {
        const logs = sessionLogs.get(sessionId);
        if (!logs || logs.length === 0) return;

        const filename = `logs/session_${sessionId}_${Date.now()}.json`;
        try {
            await fs.mkdir('logs', { recursive: true });
            const logsToSave = logs.slice(-50);
            await fs.writeFile(filename, JSON.stringify(logsToSave, null, 2));
        } catch (error) {
            console.error('Failed to save logs:', error);
        }
    }

    static getLogs(sessionId) {
        return sessionLogs.get(sessionId) || [];
    }
}

// Enhanced rate limiter with jitter
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
    
    static async waitForRateLimit(sessionId, errorCount) {
        const backoffTime = Math.min(30000, Math.pow(2, errorCount) * 1000);
        await new Promise(resolve => setTimeout(resolve, backoffTime + (Math.random() * 5000)));
    }
}

// Utility functions for anti-detection
function getRandomUserAgent() {
    if (!CONFIG.USER_AGENT_ROTATION) return USER_AGENTS[0];
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getRandomDelay() {
    if (!CONFIG.USE_DELAY_BETWEEN_REQUESTS) return 0;
    return CONFIG.MIN_DELAY_VARIATION + Math.random() * (CONFIG.MAX_DELAY_VARIATION - CONFIG.MIN_DELAY_VARIATION);
}

function getRandomProxy() {
    return proxyManager.getRandomProxy();
}

// Generate random browser fingerprint headers
function getBrowserHeaders(cookie, additionalHeaders = {}) {
    const userAgent = getRandomUserAgent();
    
    return {
        'authority': 'graph.facebook.com',
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        'content-type': 'application/x-www-form-urlencoded',
        'cookie': cookie,
        'origin': 'https://www.facebook.com',
        'referer': 'https://www.facebook.com/',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
        'user-agent': userAgent,
        'pragma': 'no-cache',
        ...additionalHeaders
    };
}

// Enhanced endpoints with security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// Proxy management endpoints
app.get('/api/proxies', (req, res) => {
    const stats = proxyManager.getProxyStats();
    res.json({
        success: true,
        totalProxies: proxyManager.proxies.length,
        activeProxies: Object.values(stats).filter(s => !s.isBanned).length,
        proxies: stats,
        rotationEnabled: CONFIG.PROXY_ROTATION
    });
});

app.post('/api/proxies/add', async (req, res) => {
    const { proxyUrl } = req.body;
    
    if (!proxyUrl) {
        return res.status(400).json({ success: false, error: 'Proxy URL required' });
    }
    
    const added = proxyManager.addProxy(proxyUrl);
    res.json({
        success: added,
        message: added ? 'Proxy added successfully' : 'Proxy already exists'
    });
});

app.delete('/api/proxies/remove', async (req, res) => {
    const { proxyUrl } = req.body;
    
    if (!proxyUrl) {
        return res.status(400).json({ success: false, error: 'Proxy URL required' });
    }
    
    const removed = proxyManager.removeProxy(proxyUrl);
    res.json({
        success: removed,
        message: removed ? 'Proxy removed successfully' : 'Proxy not found'
    });
});

app.post('/api/proxies/reset-bans', (req, res) => {
    proxyManager.resetAllBans();
    res.json({ success: true, message: 'All proxy bans reset' });
});

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
        error: session.error || null,
        lastRequestTime: session.lastRequestTime,
        proxyUsed: session.lastProxyUsed || null
    }));

    res.json({
        success: true,
        activeSessions: total.size,
        sessions: data,
        timestamp: new Date().toISOString()
    });
});

app.post('/api/submit', async (req, res) => {
    const {
        cookie,
        url,
        amount,
        interval,
        sessionId: providedSessionId,
        useProxy = true
    } = req.body;

    if (!cookie || !url || !amount || !interval) {
        return res.status(400).json({
            success: false,
            error: 'Missing required fields'
        });
    }

    if (amount < 1 || amount > 500) {
        return res.status(400).json({
            success: false,
            error: 'Amount must be between 1 and 500'
        });
    }

    if (interval < 30 || interval > 300) {
        return res.status(400).json({
            success: false,
            error: 'Interval must be between 30 and 300 seconds'
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
        
        if (CONFIG.RANDOM_START_OFFSET) {
            const startDelay = Math.random() * 5000;
            await new Promise(resolve => setTimeout(resolve, startDelay));
        }

        const result = await share(cookies, url, amount, interval, sessionId, useProxy);

        res.json({
            success: true,
            sessionId: result.sessionId,
            message: 'Sharing started successfully',
            estimatedCompletion: result.estimatedCompletion,
            proxyEnabled: useProxy && CONFIG.PROXY_ROTATION && proxyManager.proxies.length > 0
        });
    } catch (err) {
        console.error('Error in /api/submit:', err);
        return res.status(500).json({
            success: false,
            error: err.message || 'Internal server error'
        });
    }
});

// Enhanced share function with proxy support
async function share(cookies, url, amount, interval, sessionId, useProxy = true) {
    const id = await getPostID(url);
    if (!id) {
        throw new Error("Unable to get post ID");
    }

    const accessToken = await getAccessToken(cookies);
    if (!accessToken) {
        throw new Error("Unable to get access token");
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
        sharedCount: 0,
        lastRequestTime: null,
        consecutiveErrors: 0,
        dailyRequestCount: 0,
        lastDailyReset: Date.now(),
        useProxy: useProxy && CONFIG.PROXY_ROTATION && proxyManager.proxies.length > 0,
        lastProxyUsed: null
    };

    total.set(sessionId, sessionData);
    await Logger.log(sessionId, 'session_started', { url, amount, interval, useProxy: sessionData.useProxy });

    let sharedCount = 0;
    let consecutiveErrors = 0;
    let requestCountToday = 0;
    let lastRequestDate = new Date().toDateString();

    async function sharePost() {
        if (!total.has(sessionId)) return;

        const today = new Date().toDateString();
        if (today !== lastRequestDate) {
            requestCountToday = 0;
            lastRequestDate = today;
        }

        if (requestCountToday >= 100) {
            await Logger.log(sessionId, 'daily_limit_reached', { 
                message: 'Daily share limit reached (100 shares per day)'
            });
            await stopSharing(sessionId);
            return;
        }

        if (!RateLimiter.checkLimit(sessionId)) {
            await Logger.log(sessionId, 'rate_limited', { timestamp: new Date().toISOString() });
            return;
        }

        const delay = getRandomDelay();
        await new Promise(resolve => setTimeout(resolve, delay));

        let proxyUsed = null;
        let proxyAgent = null;
        
        // Get proxy if enabled
        if (sessionData.useProxy) {
            proxyUsed = getRandomProxy();
            if (proxyUsed) {
                proxyAgent = proxyManager.getProxyAgent(proxyUsed);
                await Logger.log(sessionId, 'proxy_selected', { proxy: proxyUsed });
            }
        }

        const startRequestTime = Date.now();

        try {
            const headers = getBrowserHeaders(cookies);
            
            const requestConfig = {
                headers,
                timeout: CONFIG.REQUEST_TIMEOUT
            };
            
            if (proxyAgent) {
                requestConfig.httpsAgent = proxyAgent;
                requestConfig.httpAgent = proxyAgent;
            }

            const endpoints = [
                `https://graph.facebook.com/me/feed`,
                `https://graph.facebook.com/v18.0/me/feed`,
                `https://graph.facebook.com/v17.0/me/feed`
            ];
            const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];
            
            const response = await axios.post(
                `${endpoint}?link=https://m.facebook.com/${id}&published=0&access_token=${accessToken}&no_redirect=true`,
                {},
                requestConfig
            );

            const responseTime = Date.now() - startRequestTime;
            
            if (proxyUsed) {
                proxyManager.reportSuccess(proxyUsed, responseTime);
            }

            if (response.status === 200) {
                sharedCount++;
                requestCountToday++;
                consecutiveErrors = 0;
                
                const session = total.get(sessionId);
                if (session) {
                    session.count = sharedCount;
                    session.status = sharedCount >= amount ? 'completed' : 'running';
                    session.lastRequestTime = new Date().toISOString();
                    session.lastProxyUsed = proxyUsed;
                    total.set(sessionId, session);
                }

                await Logger.log(sessionId, 'share_success', {
                    count: sharedCount,
                    total: amount,
                    dailyCount: requestCountToday,
                    proxyUsed: proxyUsed,
                    responseTime: responseTime
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
            
            if (proxyUsed) {
                proxyManager.reportFailure(proxyUsed, error);
            }
            
            await Logger.log(sessionId, 'share_error', {
                error: error.message,
                consecutiveErrors,
                status: error.response?.status,
                proxyUsed: proxyUsed
            });

            if (error.response?.status === 429) {
                await RateLimiter.waitForRateLimit(sessionId, consecutiveErrors);
            }

            if (consecutiveErrors >= 3) {
                await Logger.log(sessionId, 'session_stopped_due_to_errors', {
                    reason: 'Too many consecutive errors',
                    errorCount: consecutiveErrors
                });
                await stopSharing(sessionId);
                if (total.has(sessionId)) {
                    const session = total.get(sessionId);
                    session.status = 'failed';
                    session.error = `Stopped after ${consecutiveErrors} errors`;
                    total.set(sessionId, session);
                }
            }
        }
    }

    const timer = setInterval(sharePost, interval * 1000);
    activeTimers.set(sessionId, timer);

    const timeoutId = setTimeout(() => {
        if (total.has(sessionId) && total.get(sessionId).count < amount) {
            stopSharing(sessionId);
            const session = total.get(sessionId);
            if (session) {
                session.status = 'timeout';
                session.error = 'Session timed out';
                total.set(sessionId, session);
            }
        }
    }, amount * interval * 1000 + 120000);

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

async function getPostID(url, retryCount = 0) {
    try {
        await new Promise(resolve => setTimeout(resolve, Math.random() * 2000));
        
        const response = await axios.post('https://id.traodoisub.com/api.php', 
            `link=${encodeURIComponent(url)}`,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': getRandomUserAgent()
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
        const userAgent = getRandomUserAgent();
        const headers = {
            'authority': 'business.facebook.com',
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
            'cache-control': 'max-age=0',
            'cookie': cookie,
            'referer': 'https://www.facebook.com/',
            'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-site': 'same-origin',
            'upgrade-insecure-requests': '1',
            'User-Agent': userAgent
        };

        await new Promise(resolve => setTimeout(resolve, Math.random() * 3000));

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
        let cookies;
        if (typeof cookie === 'string') {
            try {
                cookies = JSON.parse(cookie);
            } catch {
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
            throw new Error("Cookie missing 'sb' field");
        }

        const cookieString = `sb=${sbCookie.value}; ${cookies
            .filter(c => c.key !== "sb")
            .map(c => `${c.key}=${c.value}`)
            .join('; ')}`;

        return cookieString;
    } catch (error) {
        console.error('Cookie conversion error:', error);
        throw new Error(error.message || "Error processing cookie");
    }
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        activeSessions: total.size,
        maxConcurrent: CONFIG.MAX_CONCURRENT_SESSIONS,
        uptime: process.uptime(),
        proxyEnabled: CONFIG.PROXY_ROTATION,
        activeProxies: proxyManager.proxies.filter(p => {
            const status = proxyManager.proxyStatus.get(p);
            return !status?.isBanned;
        }).length,
        totalProxies: proxyManager.proxies.length,
        timestamp: new Date().toISOString()
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// Create logs directory and load proxies
(async () => {
    try {
        await fs.mkdir('logs', { recursive: true });
        console.log('📁 Logs directory created');
        await proxyManager.loadProxiesFromFile();
    } catch (error) {
        console.error('Failed to create logs directory:', error);
    }
})();

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`\n🚀 FB Share Engine running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
    console.log(`📈 Total endpoint: http://localhost:${PORT}/api/total`);
    console.log(`🔌 Proxy endpoints:`);
    console.log(`   GET  /api/proxies - List all proxies`);
    console.log(`   POST /api/proxies/add - Add proxy`);
    console.log(`   DELETE /api/proxies/remove - Remove proxy`);
    console.log(`   POST /api/proxies/reset-bans - Reset all proxy bans`);
    console.log(`\n⚠️  IMPORTANT SAFETY NOTICE:`);
    console.log(`1. Keep intervals above 30 seconds`);
    console.log(`2. Maximum 100 shares per day per account`);
    console.log(`3. Don't run more than 3 concurrent sessions`);
    console.log(`4. Use fresh cookies from legitimate accounts`);
    console.log(`5. Monitor logs for any suspicious activity`);
    if (proxyManager.proxies.length === 0) {
        console.log(`\n⚠️  No proxies configured. Add proxies using the API or create proxies.json`);
        console.log(`   Example: {"proxyUrl": "http://user:pass@host:port"}`);
    } else {
        console.log(`\n✅ ${proxyManager.proxies.length} proxies loaded and ready`);
    }
    console.log('');
});

module.exports = app;