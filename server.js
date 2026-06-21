const express = require('express');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const PLACE_ID = process.env.PLACE_ID || 96342491571673;

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 7;
const SCAN_INTERVAL = 5000;
const MAX_PAGES = 3;
const JOBID_LOCK_TTL = 90 * 1000;
const BOT_HISTORY_TTL = 6 * 60 * 60 * 1000;
const FILTERING_ENABLED = true;
const MIN_FPS = 35;
const MAX_PING = 500;
const TOP_DISTRIBUTION_RATIO = 0.7;

// Direct call to Roblox API via Cloudflare
const ROBLOX_API = 'https://dark-math-f490.medinazorita.workers.dev/';

let pool = [];
let poolQualityStats = { avgFps: 0, avgPing: 0, avgScore: 0, filtered: 0, total: 0 };

const jobLocks = new Map();
const botHistory = new Map();

const stats = {
    totalScans: 0,
    jobsServed: 0,
    jobsServedTopScore: 0,
    jobsServedRandom: 0,
    startedAt: Date.now()
};

function calculateServerScore(server) {
    let score = 100;
    if (server.fps !== undefined && server.fps !== null) {
        if (server.fps < 30) score -= 80;
        else if (server.fps < 45) score -= 50;
        else if (server.fps < 55) score -= 20;
        else if (server.fps >= 58) score += 20;
    }
    if (server.ping !== undefined && server.ping !== null) {
        if (server.ping > 500) score -= 50;
        else if (server.ping > 200) score -= 20;
        else if (server.ping < 80) score += 10;
    }
    if (server.players === 7) score += 15;
    else if (server.players === 6) score += 5;
    else if (server.players === 5) score -= 5;
    return score;
}

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of jobLocks.entries()) { 
        if (v.expiresAt < now) jobLocks.delete(k); 
    }
    for (const [k, v] of botHistory.entries()) { 
        if (now - v.lastSeen > BOT_HISTORY_TTL) botHistory.delete(k); 
    }
}, 5000);

// ============================================================
// FETCH — Direct call to Roblox API
// ============================================================

async function fetchServers(cursor) {
    const path = '/v1/games/' + PLACE_ID + '/servers/Public?limit=100&excludeFullGames=true' + (cursor ? '&cursor=' + cursor : '');
    const url = ROBLOX_API + path;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            }
        });
        clearTimeout(timeout);
        if (response.ok) {
            const data = await response.json();
            if (data && data.data) return data;
        }
    } catch (e) {
        console.error('[FETCH] Error:', e.message);
    }

    return null;
}

// ============================================================
// SCAN — Fresh pool each cycle
// ============================================================

async function scanPool() {
    const newPool = [];
    let cursor = '';
    let totalScanned = 0, filteredOut = 0, sumFps = 0, sumPing = 0, sumScore = 0, pagesScanned = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
        const data = await fetchServers(cursor);
        if (!data || !data.data) break;
        pagesScanned++;

        for (const server of data.data) {
            if (server.playing >= MIN_PLAYERS && server.playing <= MAX_PLAYERS) {
                totalScanned++;
                if (FILTERING_ENABLED) {
                    if (server.fps !== undefined && server.fps < MIN_FPS) { filteredOut++; continue; }
                    if (server.ping !== undefined && server.ping > MAX_PING) { filteredOut++; continue; }
                }
                const s = { 
                    jobId: server.id, 
                    players: server.playing, 
                    maxPlayers: server.maxPlayers, 
                    fps: server.fps, 
                    ping: server.ping 
                };
                s.score = calculateServerScore(s);
                newPool.push(s);
                if (server.fps) sumFps += server.fps;
                if (server.ping) sumPing += server.ping;
                sumScore += s.score;
            }
        }
        if (!data.nextPageCursor) break;
        cursor = data.nextPageCursor;
        await new Promise(r => setTimeout(r, 200));
    }

    if (pagesScanned === 0) {
        console.log('[SCAN] API call failed, keeping existing pool (' + pool.length + ' servers)');
        return;
    }

    newPool.sort((a, b) => b.score - a.score);
    pool = newPool;

    if (newPool.length > 0) {
        poolQualityStats = {
            avgFps: Math.round((sumFps / newPool.length) * 10) / 10,
            avgPing: Math.round(sumPing / newPool.length),
            avgScore: Math.round(sumScore / newPool.length),
            filtered: filteredOut, 
            total: totalScanned
        };
    }

    stats.totalScans++;
    console.log('[SCAN] ' + newPool.length + ' servers | Pages: ' + pagesScanned + ' | Filtered: ' + filteredOut + ' | Top score: ' + (newPool[0] ? newPool[0].score : 0));
}

async function scanLoop() {
    while (true) {
        try { 
            await scanPool(); 
        } catch (e) { 
            console.error('[SCAN] Error:', e.message); 
        }
        await new Promise(r => setTimeout(r, SCAN_INTERVAL));
    }
}

// ============================================================
// API ENDPOINTS
// ============================================================

app.get('/', (req, res) => res.json({
    name: 'Server Distribution API',
    version: '8.1',
    pool: pool.length,
    config: { 
        scanInterval: SCAN_INTERVAL + 'ms', 
        maxPages: MAX_PAGES
    }
}));

app.get('/health', (req, res) => res.json({ 
    status: 'ok', 
    uptime: Math.floor((Date.now() - stats.startedAt) / 1000), 
    pool: pool.length 
}));

app.get('/jobs', (req, res) => {
    const username = req.headers.username || 'anonymous';
    if (!pool || pool.length === 0) return res.status(503).json({ error: 'Pool empty' });

    if (!botHistory.has(username)) {
        botHistory.set(username, { 
            firstSeen: Date.now(), 
            lastSeen: Date.now(), 
            jobsReceived: 0, 
            currentJobId: null, 
            visitedJobs: new Set() 
        });
    }
    const botData = botHistory.get(username);
    botData.lastSeen = Date.now();
    botData.jobsReceived++;

    const now = Date.now();
    const candidates = pool.filter(s => {
        const lock = jobLocks.get(s.jobId);
        if (lock && lock.expiresAt > now && lock.botName !== username) return false;
        if (botData.visitedJobs.has(s.jobId)) return false;
        return true;
    });

    if (candidates.length === 0) { 
        botData.visitedJobs = new Set(); 
        return res.status(503).json({ error: 'All servers visited' }); 
    }

    let selected;
    const useTopScore = Math.random() < TOP_DISTRIBUTION_RATIO;
    if (useTopScore) {
        const topSize = Math.max(1, Math.floor(candidates.length * 0.3));
        selected = candidates.slice(0, topSize)[Math.floor(Math.random() * topSize)];
        stats.jobsServedTopScore++;
    } else {
        selected = candidates[Math.floor(Math.random() * candidates.length)];
        stats.jobsServedRandom++;
    }

    const idx = pool.findIndex(s => s.jobId === selected.jobId);
    if (idx !== -1) pool.splice(idx, 1);

    jobLocks.set(selected.jobId, { botName: username, expiresAt: now + JOBID_LOCK_TTL });
    botData.currentJobId = selected.jobId;
    botData.visitedJobs.add(selected.jobId);
    stats.jobsServed++;

    console.log('[JOBS] ' + username + ' -> ' + selected.jobId.substring(0, 12) + '... Score:' + selected.score + ' (' + (useTopScore ? 'TOP' : 'RND') + ') Pool remaining: ' + pool.length);
    
    res.json({
        jobId: selected.jobId,
        players: selected.players,
        maxPlayers: selected.maxPlayers,
        fps: selected.fps,
        ping: selected.ping,
        score: selected.score
    });
});

app.get('/stats', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.startedAt) / 1000);
    const m = uptime / 60;
    res.json({
        uptime,
        pool: pool.length,
        totalScans: stats.totalScans,
        jobsServed: stats.jobsServed,
        jobsServedTopScore: stats.jobsServedTopScore,
        jobsServedRandom: stats.jobsServedRandom,
        jobsPerMinute: m > 0 ? Math.round(stats.jobsServed / m) : 0,
        activeBots: botHistory.size,
        quality: poolQualityStats
    });
});

app.get('/pool', (req, res) => {
    res.json({ 
        count: pool.length, 
        quality: poolQualityStats, 
        servers: pool.slice(0, 100) 
    });
});

app.get('/bots', (req, res) => {
    const now = Date.now();
    const bots = [];
    for (const [name, data] of botHistory.entries()) {
        bots.push({ 
            name, 
            secondsSinceLastSeen: Math.floor((now - data.lastSeen) / 1000), 
            jobsReceived: data.jobsReceived, 
            currentJobId: data.currentJobId 
        });
    }
    res.json(bots.sort((a, b) => a.secondsSinceLastSeen - b.secondsSinceLastSeen));
});

app.listen(PORT, () => {
    console.log('================================================');
    console.log('SERVER DISTRIBUTION API v8.1');
    console.log('PlaceId: ' + PLACE_ID);
    console.log('Roblox API: ' + ROBLOX_API);
    console.log('Scan: every ' + (SCAN_INTERVAL/1000) + 's | Pages: ' + MAX_PAGES);
    console.log('PORT: ' + PORT);
    console.log('================================================');
    console.log('Endpoints:');
    console.log('  GET  /');
    console.log('  GET  /health');
    console.log('  GET  /jobs');
    console.log('  GET  /stats');
    console.log('  GET  /pool');
    console.log('  GET  /bots');
    console.log('================================================');
    scanLoop();
