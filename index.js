const express = require('express');
const axios = require('axios');
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs').promises;
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const session = require('express-session');

const app = express();

// Middleware
app.use(express.json());
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration
app.use(session({
    secret: 'shareboost-super-secret-key-change-this',
    resave: false,
    saveUninitialized: true,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000
    }
}));

// Data structures
const total = new Map();
const activeTimers = new Map();
const sessionLogs = new Map();

// Configuration
const CONFIG = {
    MAX_CONCURRENT_SESSIONS: 5,
    REQUEST_TIMEOUT: 30000,
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY: 2000,
    DEFAULT_INTERVAL: 2
};

// Logger
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

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'portal.html'));
});

app.get('/dashboard', (req, res) => {
    if (!req.session.agreedToPrivacy) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/agree-privacy', (req, res) => {
    req.session.agreedToPrivacy = true;
    req.session.agreedAt = new Date().toISOString();
    res.json({ success: true });
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
        error: session.error || null
    }));
    
    res.json({
        success: true,
        activeSessions: total.size,
        sessions: data,
        timestamp: new Date().toISOString()
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
        interval = CONFIG.DEFAULT_INTERVAL
    } = req.body;
    
    if (!req.session.agreedToPrivacy) {
        return res.status(403).json({
            success: false,
            error: 'Please agree to the privacy policy first'
        });
    }
    
    if (!cookie || !url || !amount) {
        return res.status(400).json({
            success: false,
            error: 'Missing required fields'
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
            error: `Maximum ${CONFIG.MAX_CONCURRENT_SESSIONS} concurrent sessions reached`
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
        
        const sessionId = crypto.randomBytes(16).toString('hex');
        const result = await share(cookies, url, parseInt(amount), parseInt(interval), sessionId);
        
        res.json({
            success: true,
            sessionId: result.sessionId,
            message: 'Sharing started successfully',
            estimatedCompletion: result.estimatedCompletion
        });
    } catch (err) {
        console.error('Error:', err);
        return res.status(500).json({
            success: false,
            error: err.message || 'Internal server error'
        });
    }
});

async function share(cookies, url, amount, interval, sessionId) {
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
        interval
    };
    
    total.set(sessionId, sessionData);
    await Logger.log(sessionId, 'session_started', { url, amount, interval });
    
    let sharedCount = 0;
    let consecutiveErrors = 0;
    
    async function sharePost() {
        if (!total.has(sessionId)) return;
        
        try {
            const response = await axios.post(
                `https://graph.facebook.com/me/feed?link=https://m.facebook.com/${id}&published=0&access_token=${accessToken}`,
                {},
                {
                    headers: {
                        'accept': '*/*',
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
                    total: amount
                });
                
                if (sharedCount >= amount) {
                    await stopSharing(sessionId);
                }
            }
        } catch (error) {
            consecutiveErrors++;
            await Logger.log(sessionId, 'share_error', {
                error: error.message,
                consecutiveErrors
            });
            
            if (consecutiveErrors >= 5) {
                await stopSharing(sessionId);
                const session = total.get(sessionId);
                if (session) {
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
    }, amount * interval * 1000 + 60000);
    
    activeTimers.set(`${sessionId}_timeout`, timeoutId);
    
    return { sessionId, estimatedCompletion: estimatedCompletion.toISOString() };
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
}

async function getPostID(url, retryCount = 0) {
    try {
        const response = await axios.post('https://id.traodoisub.com/api.php', 
            `link=${encodeURIComponent(url)}`,
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: CONFIG.REQUEST_TIMEOUT
            }
        );
        return response.data.id;
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
        const response = await axios.get('https://business.facebook.com/content_management', {
            headers: {
                'cookie': cookie,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: CONFIG.REQUEST_TIMEOUT
        });
        
        const tokenMatch = response.data.match(/"accessToken":"([^"]+)"/);
        return tokenMatch ? tokenMatch[1] : null;
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
                if (cookie.includes('=')) return cookie;
                throw new Error('Invalid cookie format');
            }
        } else if (Array.isArray(cookie)) {
            cookies = cookie;
        } else {
            throw new Error('Cookie must be array or JSON string');
        }
        
        const sbCookie = cookies.find(c => c.key === "sb");
        if (!sbCookie) throw new Error("Missing 'sb' field");
        
        return `sb=${sbCookie.value}; ${cookies.filter(c => c.key !== "sb").map(c => `${c.key}=${c.value}`).join('; ')}`;
    } catch (error) {
        throw new Error("Error processing cookie");
    }
}

// Error pages
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).sendFile(path.join(__dirname, 'public', '500.html'));
});

// Cleanup
setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of total.entries()) {
        const sessionTime = new Date(session.startTime).getTime();
        if (session.status === 'completed' && (now - sessionTime) > 86400000) {
            total.delete(sessionId);
            sessionLogs.delete(sessionId);
        }
    }
}, 3600000);

// Create directories
(async () => {
    await fs.mkdir('logs', { recursive: true });
    console.log('Logs directory ready');
})();

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Portal: http://localhost:${PORT}/`);
    console.log(`Dashboard: http://localhost:${PORT}/dashboard`);
});

module.exports = app;