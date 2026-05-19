// server.js - Main server file
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: 'your-secret-key-change-this',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 3600000 }
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
});
app.use('/api/', limiter);

// Data storage
const accountsDir = path.join(__dirname, 'accounts');
if (!fs.existsSync(accountsDir)) fs.mkdirSync(accountsDir);

// User agents array (simplified from Python version)
const userAgents = [];

// Generate user agents dynamically
function generateUserAgents() {
    const oppoModels = ["CPH2461", "CPH2451", "PCGM00", "PBBM00", "PFZM10"];
    const redmiModels = ["2211133G", "M2004J19C", "22041219I", "22101316UG"];
    const infinixModels = ["Infinix X669C", "Infinix X6823", "Infinix X676C"];
    const samsungModels = ["SM-G996B", "SM-A826S", "SM-E135F", "SM-G781B"];
    
    for (let i = 0; i < 100; i++) {
        const androidVer = Math.floor(Math.random() * 6) + 6;
        const chromeVer = Math.floor(Math.random() * 34) + 80;
        const buildVer = Math.floor(Math.random() * 100000) + 120000;
        
        const models = [...oppoModels, ...redmiModels, ...infinixModels, ...samsungModels];
        const model = models[Math.floor(Math.random() * models.length)];
        
        const ua = `Mozilla/5.0 (Linux; Android ${androidVer}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer}.0.${buildVer}.${Math.floor(Math.random() * 80) + 70} Mobile Safari/537.36`;
        userAgents.push(ua);
    }
}
generateUserAgents();

function getRandomUserAgent() {
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// Name databases
const firstNames = [
    "Maria", "Ana", "Joy", "Grace", "Angel", "Angela", "Christine", "Kristine",
    "Michelle", "Shiela", "Sheila", "Maricel", "Marites", "Maribel", "Marjorie",
    "Jennifer", "Jenny", "Jessa", "Jessica", "Janine", "Katherine", "Catherine",
    "Kathleen", "Karen", "Karla", "Camille", "Bianca", "Patricia", "Patty", "Tricia",
    "Juan", "Jose", "Pedro", "Paolo", "Paul", "Mark", "John", "Johnny", "Jonathan"
];

const surnames = [
    "Santos", "Reyes", "Cruz", "Bautista", "Garcia", "Mendoza", "Flores",
    "Gonzales", "Ramos", "Aquino", "DelaCruz", "DelosSantos", "Villanueva",
    "Fernandez", "Castillo", "Torres", "Dominguez", "Navarro", "Salazar"
];

function getRandomName() {
    return {
        first: firstNames[Math.floor(Math.random() * firstNames.length)],
        last: surnames[Math.floor(Math.random() * surnames.length)]
    };
}

function generatePassword() {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const symbols = '!@#$%^&*()_+';
    const digits = '0123456789';
    
    let password = '';
    for (let i = 0; i < 6; i++) password += chars[Math.floor(Math.random() * chars.length)];
    password += symbols[Math.floor(Math.random() * symbols.length)];
    password += symbols[Math.floor(Math.random() * symbols.length)];
    for (let i = 0; i < 3; i++) password += digits[Math.floor(Math.random() * digits.length)];
    for (let i = 0; i < 3; i++) password += chars[Math.floor(Math.random() * chars.length)];
    
    return password;
}

function generatePhoneNumber() {
    const prefixes = ['017', '019', '018', '016', '015', '013', '014'];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    let number = '';
    for (let i = 0; i < 8; i++) number += Math.floor(Math.random() * 10);
    return `+88${prefix}${number}`;
}

function generateTempEmail() {
    const chars = 'abcdefghijklmnopqrstuvwxyz';
    let name = '';
    for (let i = 0; i < 8; i++) name += chars[Math.floor(Math.random() * chars.length)];
    const num = Math.floor(Math.random() * 9000) + 1000;
    return `${name}${num}@tempmail.com`;
}

function extractFormData(html) {
    const $ = cheerio.load(html);
    const formData = {};
    
    $('input').each((i, el) => {
        const name = $(el).attr('name');
        const value = $(el).attr('value') || '';
        if (name) formData[name] = value;
    });
    
    return formData;
}

// API Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/create-account', async (req, res) => {
    const { method = 1, emailType = 'phone', passwordType = 'auto', customPassword, numAccounts = 1 } = req.body;
    
    const results = {
        success: [],
        failed: [],
        total: numAccounts
    };
    
    const password = passwordType === 'auto' ? generatePassword() : customPassword;
    
    for (let i = 0; i < numAccounts; i++) {
        try {
            const session = axios.create({
                headers: {
                    'User-Agent': getRandomUserAgent(),
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Connection': 'keep-alive'
                },
                timeout: 30000
            });
            
            // Get registration page
            const regResponse = await session.get('https://x.facebook.com/reg');
            const formData = extractFormData(regResponse.data);
            
            const { first, last } = getRandomName();
            
            let contact;
            if (emailType === 'phone') contact = generatePhoneNumber();
            else if (emailType === 'mix') contact = generatePhoneNumber();
            else contact = generateTempEmail();
            
            const birthdayDay = Math.floor(Math.random() * 28) + 1;
            const birthdayMonth = Math.floor(Math.random() * 12) + 1;
            const birthdayYear = Math.floor(Math.random() * 11) + 1990;
            
            const payload = {
                ccp: "2",
                reg_instance: formData.reg_instance || "",
                submission_request: "true",
                reg_impression_id: formData.reg_impression_id || "",
                ns: "1",
                logger_id: formData.logger_id || "",
                firstname: first,
                lastname: last,
                birthday_day: birthdayDay.toString(),
                birthday_month: birthdayMonth.toString(),
                birthday_year: birthdayYear.toString(),
                reg_email__: contact,
                sex: "1",
                encpass: `#PWD_BROWSER:0:${Math.floor(Date.now() / 1000)}:${password}`,
                submit: "Sign Up",
                fb_dtsg: formData.fb_dtsg || "",
                jazoest: formData.jazoest || "",
                lsd: formData.lsd || ""
            };
            
            const submitResponse = await session.post('https://www.facebook.com/reg/submit/', 
                new URLSearchParams(payload).toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Referer': 'https://mbasic.facebook.com/reg/'
                    }
                }
            );
            
            const cookies = session.defaults.headers.Cookie || '';
            const c_user = extractCookieValue(cookies, 'c_user');
            
            if (c_user) {
                const accountInfo = {
                    uid: c_user,
                    password: password,
                    email: contact,
                    name: `${first} ${last}`,
                    dob: `${birthdayDay}/${birthdayMonth}/${birthdayYear}`,
                    cookies: cookies,
                    timestamp: new Date().toISOString()
                };
                
                // Save to file
                const logFile = path.join(accountsDir, `accounts_${new Date().toISOString().split('T')[0]}.txt`);
                fs.appendFileSync(logFile, `${c_user}|${password}|${contact}|${cookies}\n`);
                
                results.success.push(accountInfo);
            } else {
                results.failed.push({ reason: 'No c_user cookie received', contact });
            }
            
            await new Promise(resolve => setTimeout(resolve, 2000));
            
        } catch (error) {
            console.error(`Account creation failed:`, error.message);
            results.failed.push({ reason: error.message, index: i });
        }
    }
    
    res.json(results);
});

function extractCookieValue(cookieString, name) {
    const match = cookieString.match(new RegExp(`${name}=([^;]+)`));
    return match ? match[1] : null;
}

app.post('/api/extract-cookies', async (req, res) => {
    const { accounts } = req.body;
    const results = [];
    
    for (const account of accounts) {
        try {
            const [uid, password] = account.split('|');
            
            const response = await axios.get(
                `https://b-api.facebook.com/method/auth.login?access_token=237759909591655%257C0f140aabedfb65ac27a739ed1a2263b1&format=json&sdk_version=1&email=${encodeURIComponent(uid)}&locale=en_US&password=${encodeURIComponent(password)}&sdk=ios&generate_session_cookies=1`,
                { timeout: 15000 }
            );
            
            if (response.data && response.data.session_cookies) {
                const cookies = response.data.session_cookies.map(c => `${c.name}=${c.value}`).join(';');
                results.push({
                    uid: uid,
                    password: password,
                    cookies: cookies,
                    status: 'success'
                });
            } else {
                results.push({
                    uid: uid,
                    status: 'failed',
                    error: response.data.error_msg || 'Unknown error'
                });
            }
        } catch (error) {
            results.push({
                uid: account.split('|')[0],
                status: 'failed',
                error: error.message
            });
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Save extracted cookies
    const cookieFile = path.join(accountsDir, `cookies_${new Date().toISOString().split('T')[0]}.txt`);
    results.filter(r => r.status === 'success').forEach(r => {
        fs.appendFileSync(cookieFile, `${r.uid}|${r.password}|${r.cookies}\n`);
    });
    
    res.json(results);
});

app.post('/api/temp-mail', async (req, res) => {
    try {
        // Generate a temporary email
        const email = generateTempEmail();
        const messages = [];
        
        res.json({
            email: email,
            messages: messages,
            status: 'ready'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/check-uid/:uid', async (req, res) => {
    const { uid } = req.params;
    
    try {
        const picUrl = `https://graph.facebook.com/${uid}/picture?type=normal`;
        const response = await axios.get(picUrl, {
            maxRedirects: 0,
            validateStatus: status => status === 302,
            timeout: 10000
        });
        
        if (response.status === 302) {
            const location = response.headers.location || '';
            if (location.includes('scontent')) {
                res.json({ uid, status: 'live', hasPicture: true });
            } else {
                res.json({ uid, status: 'active', hasPicture: false });
            }
        } else {
            res.json({ uid, status: 'unknown', hasPicture: false });
        }
    } catch (error) {
        res.json({ uid, status: 'error', hasPicture: false, error: error.message });
    }
});

app.get('/api/accounts', (req, res) => {
    try {
        const files = fs.readdirSync(accountsDir);
        const accountFiles = files.filter(f => f.startsWith('accounts_'));
        const accounts = [];
        
        accountFiles.forEach(file => {
            const content = fs.readFileSync(path.join(accountsDir, file), 'utf8');
            const lines = content.split('\n').filter(l => l.trim());
            lines.forEach(line => {
                const [uid, password, email, cookies] = line.split('|');
                if (uid) accounts.push({ uid, password, email, cookies: cookies || '', file });
            });
        });
        
        res.json(accounts);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
