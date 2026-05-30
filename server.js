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

// Configuration - REMOVED MAX_CONCURRENT_SESSIONS limit
const CONFIG = {
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
    try {
        const data = Array.from(total.values()).map((session, index) =>