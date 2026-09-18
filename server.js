process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const express = require("express");
const axios = require("axios");
// Load bundled whatsapp-web.js from ./lib if available (contains all WhatsApp Web memoize & media fixes)
let wwebjsModule;
try {
    wwebjsModule = require("./lib/whatsapp-web.js");
} catch (e) {
    wwebjsModule = require("whatsapp-web.js");
}
const { Client, LocalAuth, MessageMedia } = wwebjsModule;
const qrcode = require("qrcode");
const fs = require("fs");
const path = require("path");
const Busboy = require("busboy");
const XLSX = require("xlsx");
const crypto = require("crypto");
const https = require("https");
const BusyService = require("./busy_service");
const cron = require('node-cron');
const dns = require('dns');
const { machineIdSync } = require('node-machine-id');
const AppUpdater = require('./updater');

const app = express();
const port = 5000;
const appDir = process.pkg ? path.dirname(process.execPath) : __dirname;
const MACHINE_ID = machineIdSync();
console.log(`💻 Machine ID: ${MACHINE_ID}`);
const queueFile = path.join(appDir, "queue.json");
const logsFile = path.join(appDir, "logs.json");
const licenseFile = path.join(appDir, "license.key");

// Secret salt for license key validation (should be kept secret)
const LICENSE_SECRET_SALT = "whatsapp-client-license-salt-2024";

// ======================
// Process Error Handling
// ======================
process.on('uncaughtException', (err) => {
    console.error('CRITICIAL ERROR (Uncaught Exception):', err);
    // Attempt to log to file
    try {
        const timestamp = new Date().toISOString();
        const msg = `[${timestamp}] [ERROR] CRITICIAL ERROR (Uncaught Exception): ${err.message}\n${err.stack}\n`;
        fs.appendFileSync(path.join(appDir, "server_error.log"), msg);

        // Also try adding to application logs if possible
        if (typeof addLog === 'function') {
            addLog('error', 'CRITICAL SERVER ERROR', { error: err.message, stack: err.stack });
        }
    } catch (e) {
        console.error("Failed to log critical error:", e);
    }
    // Prevent exit if possible, but server might be unstable
});

process.on('unhandledRejection', (reason, promise) => {
    const reasonStr = reason ? (reason.message || String(reason)) : '';
    // Ignore normal Puppeteer teardown artifacts during disconnect or reconnect
    if (reasonStr.includes('detached Frame') || reasonStr.includes('Target closed') || reasonStr.includes('Session closed')) {
        return;
    }

    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    try {
        const timestamp = new Date().toISOString();
        const msg = `[${timestamp}] [ERROR] Unhandled Rejection: ${reason}\n`;
        fs.appendFileSync(path.join(appDir, "server_error.log"), msg);

        if (typeof addLog === 'function') {
            addLog('error', 'Unhandled Rejection', { reason: reason ? reason.message || reason : 'Unknown' });
        }
    } catch (e) {
        console.error("Failed to log unhandled rejection:", e);
    }
});

// ======================
// Logs History Management
// ======================
let logsHistory = [];
const MAX_LOGS = 1000; // Keep last 1000 logs

function addLog(type, message, data = null) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        type: type, // 'info', 'success', 'error', 'warning', 'send', 'queue'
        message: message,
        data: data
    };

    logsHistory.push(logEntry);

    // Mirror to console for easier debugging via user photos
    const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : type === 'warning' ? '⚠️' : type === 'queue' ? '📤' : 'ℹ️';
    console.log(`${icon} [${new Date().toLocaleTimeString()}] ${message}`, data ? JSON.stringify(data) : '');

    // Keep only last MAX_LOGS entries
    if (logsHistory.length > MAX_LOGS) {
        logsHistory.shift();
    }

    // Save to file
    saveLogs();

    return logEntry;
}

function loadLogs() {
    if (!fs.existsSync(logsFile)) return [];
    try {
        const data = fs.readFileSync(logsFile, "utf8");
        const parsed = JSON.parse(data);
        // Keep only last MAX_LOGS
        return parsed.slice(-MAX_LOGS);
    } catch {
        return [];
    }
}

function saveLogs() {
    try {
        fs.writeFileSync(logsFile, JSON.stringify(logsHistory, null, 2));
    } catch (err) {
        console.error("Error saving logs:", err.message);
    }
}

// Load existing logs on startup
logsHistory = loadLogs();

// ======================
// State Management
// ======================
let connectionStatus = "disconnected"; // "disconnected", "authenticating", "ready"
let qrCodeBase64 = null;
let qrCodeData = null;

// Load Configuration
let config = {};
const configFile = path.join(appDir, "config.json");
try {
    if (fs.existsSync(configFile)) {
        config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    }
} catch (err) {
    console.error("Error loading config.json:", err.message);
}

// Auto-Updater Instance
const updater = new AppUpdater(appDir, config);

// Hardcoded License Server URL (Hidden from user)
const LICENSE_SERVER_URL = "https://script.google.com/macros/s/AKfycbwCoPgJzFJILkmtNevfIH-_oEDm4BvkBnnqG3IFKRyT83_5a6XEMi9q6kOOXOelDwfjfQ/exec";

// ======================
// API Helpers & Cache
// ======================

// Helper function to format and validate mobile number
const formatMobileNumber = (mobile) => {
    if (!mobile) return null;
    const cleaned = String(mobile).replace(/\D/g, '');
    if (cleaned.length < 10) return null;
    if (cleaned.startsWith('91')) return cleaned;
    return '91' + cleaned;
};

// Cache to prevent duplicate messages (Deduplication)
const RECENT_REQUEST_WINDOW = 10000; // 10 seconds
const recentRequests = new Map();

/**
 * Validate Remote License (Google Sheet)
 */
async function validateRemoteLicense() {
    // Check if email is configured
    if (!config.license_email) {
        return {
            valid: false,
            error: "License email not configured. Please configure Email in Settings."
        };
    }

    try {
        console.log(`🌍 verifying license for ${config.license_email} via backup server...`);
        const response = await axios.get(LICENSE_SERVER_URL, {
            params: {
                email: config.license_email,
                machineId: MACHINE_ID
            },
            timeout: 10000, // 10s timeout
            httpsAgent: new https.Agent({
                rejectUnauthorized: false // ALLOW SELF-SIGNED CERTS / HTTP DEBUGGERS
            })
        });

        const data = response.data;

        if (data.valid) {
            return {
                valid: true,
                expirationDate: data.expirationDate,
                daysRemaining: data.daysRemaining,
                email: config.license_email,
                tier: data.tier || 'basic',
                type: 'remote'
            };
        } else {
            return {
                valid: false,
                error: data.error || "Remote validation failed",
                type: 'remote'
            };
        }
    } catch (err) {
        console.error("❌ Remote license check failed:", err.message);
        return {
            valid: false,
            error: "Connection to license server failed: " + err.message,
            networkError: true,
            type: 'remote'
        };
    }
}

// Cache for license check to prevent flooding logs
let cachedLicenseResult = null;
let lastLicenseCheckTime = 0;
const LICENSE_CACHE_DURATION = 1000 * 60 * 60; // 1 Hour

/**
 * Check license validity (Remote Only)
 */
async function checkLicense(force = false) {
    const now = Date.now();

    // Return cached result if valid and not expired (unless forced)
    if (!force && cachedLicenseResult && (now - lastLicenseCheckTime < LICENSE_CACHE_DURATION)) {
        return cachedLicenseResult;
    }

    // ONLY Remote Check
    const remoteValidation = await validateRemoteLicense();

    if (remoteValidation.valid) {
        console.log(`✅ Remote License Active for ${remoteValidation.email}. Days remaining: ${remoteValidation.daysRemaining}`);
        cachedLicenseResult = remoteValidation;
        lastLicenseCheckTime = now;
        return remoteValidation;
    } else {
        // NETWORK FAILURE GRACE PERIOD
        // If it's a network error (like ENOTFOUND or timeout), allow temporary access
        // so the user can still use the app if their internet is spotty
        if (remoteValidation.networkError) {
            console.log(`⚠️ Network error checking license. Allowing temporary grace access.`);
            return {
                valid: true, // Allow access
                expirationDate: "Unknown (Offline Mode)",
                daysRemaining: 1, // Show 1 day remaining
                email: config.license_email,
                warning: "Offline Mode (License Check Failed)",
                tier: 'basic',
                type: 'grace'
            };
        }

        console.log(`❌ Remote License Valid failed: ${remoteValidation.error}`);
        cachedLicenseResult = remoteValidation;
        lastLicenseCheckTime = now;
        return remoteValidation;
    }
}

// ======================
// WhatsApp Client Setup
// ======================
// Helper to find Chrome/Edge
function getChromeExecutablePath() {
    const possiblePaths = [
        path.join(appDir, 'chrome-win', 'chrome.exe'),
        path.join(appDir, '..', 'chrome-win', 'chrome.exe'),
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
    ];

    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            console.log(`✅ Found browser at: ${p}`);
            return p;
        }
    }
    console.log("⚠️ Could not find a local browser (Chrome/Edge). Puppeteer might fail if not bundled.");
    return null;
}

const clients = new Map(); // clientId -> { client, status, qrCodeBase64, qrCodeData, number, name, isReady }
const clientsClearingSession = new Set(); // Set of clientIds currently clearing session

// ======================
// Per-Account Port Registry
// ======================
const BASE_PORT = 5000; // Default account always on 5000
const clientPorts = new Map();    // clientId -> port number
const clientNames = new Map();    // clientId -> connection name
const clientServers = new Map();  // clientId -> http.Server instance
const CLIENT_PORTS_FILE = path.join(appDir, 'client_ports.json');
const CLIENT_NAMES_FILE = path.join(appDir, 'client_names.json');

// Default account is always on the base port
clientPorts.set('default', BASE_PORT);

function loadClientPorts() {
    try {
        if (fs.existsSync(CLIENT_PORTS_FILE)) {
            const data = JSON.parse(fs.readFileSync(CLIENT_PORTS_FILE, 'utf8'));
            for (const [id, port] of Object.entries(data)) {
                clientPorts.set(id, port);
            }
            console.log('📋 Restored client port assignments:', Object.fromEntries(clientPorts));
        }
    } catch (err) {
        console.error('Error loading client ports:', err.message);
    }
}

function saveClientPorts() {
    try {
        const data = {};
        for (const [id, port] of clientPorts.entries()) {
            data[id] = port;
        }
        fs.writeFileSync(CLIENT_PORTS_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('Error saving client ports:', err.message);
    }
}

function loadClientNames() {
    try {
        if (fs.existsSync(CLIENT_NAMES_FILE)) {
            const data = JSON.parse(fs.readFileSync(CLIENT_NAMES_FILE, 'utf8'));
            for (const [id, name] of Object.entries(data)) {
                clientNames.set(id, name);
            }
            console.log('📋 Restored client name assignments:', Object.fromEntries(clientNames));
        }
    } catch (err) {
        console.error('Error loading client names:', err.message);
    }
}

function saveClientNames() {
    try {
        const data = {};
        for (const [id, name] of clientNames.entries()) {
            data[id] = name;
        }
        fs.writeFileSync(CLIENT_NAMES_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('Error saving client names:', err.message);
    }
}

function getNextAvailablePort() {
    const usedPorts = new Set(clientPorts.values());
    let candidate = BASE_PORT + 1;
    while (usedPorts.has(candidate)) {
        candidate++;
    }
    return candidate;
}

// Load saved port assignments at startup
loadClientPorts();
loadClientNames();


function getOrCreateClient(clientId, name = null) {
    if (clients.has(clientId)) {
        return clients.get(clientId);
    }

    // Determine the client name
    let clientName = name;
    if (!clientName) {
        clientName = clientNames.get(clientId);
    }
    if (!clientName) {
        if (clientId === "default") {
            clientName = "Default Account";
        } else if (clientId === "client-one") {
            clientName = "Primary Account";
        } else {
            const cleanId = clientId.replace("client_", "");
            clientName = `Account ${cleanId.substring(cleanId.length - 6)}`;
        }
    }

    // Persist connection name
    if (clientName && clientNames.get(clientId) !== clientName) {
        clientNames.set(clientId, clientName);
        saveClientNames();
    }

    console.log(`🤖 Initializing WhatsApp client: ${clientId} (${clientName})`);

    const clientAuthPath = path.join(appDir, ".wwebjs_auth");

    const clientInstance = new Client({
        authStrategy: new LocalAuth({
            clientId: clientId,
            dataPath: clientAuthPath
        }),
        webVersionCache: {
            type: 'local'
        },
        puppeteer: {
            executablePath: getChromeExecutablePath(),
            headless: true,
            dumpio: false,
            pipe: true,
            args: [
                '--no-proxy-server',
                '--proxy-server=direct://',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-software-rasterizer',
                '--ignore-certificate-errors',
                '--ignore-certificate-errors-spki-list',
                '--disable-features=IsolateOrigins,site-per-process',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding'
            ]
        }
    });

    const clientInfo = {
        client: clientInstance,
        status: "disconnected",
        qrCodeBase64: null,
        qrCodeData: null,
        pairingCode: null,
        number: null,
        name: clientName,
        isReady: false
    };

    clients.set(clientId, clientInfo);

    clientInstance.on("code", (code) => {
        clientInfo.status = "authenticating";
        clientInfo.pairingCode = code;
        clientInfo.qrCodeBase64 = null; // Clear QR when pairing code is used
        clientInfo.qrCodeData = null;
        console.log(`🔑 Pairing Code received for [${clientInfo.name}]: ${code}`);
        addLog("info", `Pairing code received for client ${clientInfo.name}: ${code}`);
    });

    clientInstance.on("qr", async (qr) => {
        clientInfo.status = "authenticating";
        clientInfo.qrCodeData = qr;
        clientInfo.pairingCode = null; // Clear pairing code when QR is active
        try {
            clientInfo.qrCodeBase64 = await qrcode.toDataURL(qr);
            addLog("info", `QR Code received for client ${clientInfo.name}`);
        } catch (err) {
            console.error(`Error generating QR code for ${clientId}:`, err.message);
        }
    });

    clientInstance.on("loading_screen", (percent, message) => {
        clientInfo.status = "authenticating";
        console.log(`⏳ [${clientInfo.name}] Loading: ${percent}% - ${message}`);
        addLog("info", `[${clientInfo.name}] Loading: ${percent}% - ${message}`);
    });

    clientInstance.on("authenticated", () => {
        if (!clientInfo.isReady) {
            clientInfo.status = "authenticating";
        }
        console.log(`✅ [${clientInfo.name}] WhatsApp authenticated`);
        addLog("success", `[${clientInfo.name}] WhatsApp authenticated`);

        // Safety fallback: if ready event takes more than 15s after authenticated, poll client state
        setTimeout(async () => {
            if (!clientInfo.isReady && clientInstance.pupPage) {
                try {
                    const isSynced = await clientInstance.pupPage.evaluate(() => {
                        return window.require?.('WAWebSocketModel')?.Socket?.hasSynced === true;
                    }).catch(() => false);

                    if (isSynced && !clientInfo.isReady) {
                        console.log(`🔄 [${clientInfo.name}] Auto-sync verified! Transitioning to ready state.`);
                        clientInfo.status = "ready";
                        clientInfo.isReady = true;
                        processQueue();
                    }
                } catch (e) {}
            }
        }, 15000);
    });

    clientInstance.on("auth_failure", (msg) => {
        console.error(`❌ [${clientInfo.name}] Authentication failure:`, msg);
        clientInfo.status = "disconnected";
        clientInfo.qrCodeBase64 = null;
        clientInfo.qrCodeData = null;
        clientInfo.isReady = false;
        addLog("error", `[${clientInfo.name}] Authentication failure`, { message: msg });
    });

    clientInstance.on("ready", () => {
        console.log(`✅ [${clientInfo.name}] WhatsApp Client is ready!`);
        clientInfo.status = "ready";
        clientInfo.isReady = true;
        clientInfo.qrCodeBase64 = null;
        clientInfo.qrCodeData = null;
        clientInfo.pairingCode = null; // Clear pairing code when ready

        // Extract phone number from wid
        if (clientInstance.info && clientInstance.info.wid) {
            clientInfo.number = clientInstance.info.wid.user;
            console.log(`📞 Linked number for [${clientInfo.name}]: ${clientInfo.number}`);
            addLog("success", `WhatsApp Client [${clientInfo.name}] is ready (+${clientInfo.number})`);
        } else {
            addLog("success", `WhatsApp Client [${clientInfo.name}] is ready`);
        }

        // Trigger queue processing
        processQueue();
    });

    // Auto-Reply Handler for Incoming Party Commands (e.g., STOCK, STOCK SOAP, #STOCK)
    const processedMessageIds = new Set();

    const handleStockCommand = async (msg, targetChat) => {
        try {
            if (!msg) return;
            const rawBody = (msg.body || "").trim();
            if (!rawBody) return;

            const isGroup = (targetChat && targetChat.endsWith("@g.us")) || (msg.from && msg.from.endsWith("@g.us"));
            if (isGroup) return;
            if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast') return;

            console.log(`💬 WhatsApp Event: fromMe=${msg.fromMe}, from=${msg.from}, to=${msg.to}, body="${rawBody.substring(0, 30)}"`);

            const lowerMsg = rawBody.toLowerCase();

            // Ignore bot self-outputs to prevent infinite self-loops
            if (rawBody.includes("Stock Status Report") ||
                rawBody.includes("CLOSING STOCK STATUS") ||
                rawBody.includes("Stock Status Update") ||
                rawBody.includes("No active stock records") ||
                rawBody.includes("No items found matching") ||
                rawBody.includes("Stock Status service is currently unavailable")) {
                return;
            }

            // Deduplicate message triggers
            const msgId = (msg.id && typeof msg.id === 'object') ? (msg.id._serialized || msg.id.id) : String(msg.id || '');
            if (msgId) {
                if (processedMessageIds.has(msgId)) return;
                processedMessageIds.add(msgId);
                if (processedMessageIds.size > 500) {
                    const first = processedMessageIds.values().next().value;
                    processedMessageIds.delete(first);
                }
            }

            // Precise matching: triggers on explicit commands, prevents triggering on file names like "document.pdf"
            const isStockQuery = lowerMsg.includes("stock") ||
                lowerMsg.includes("catalog") ||
                lowerMsg === "items" ||
                lowerMsg === "report" ||
                lowerMsg === "pdf" ||
                lowerMsg === "batch stock";

            const isBatchQuery = isStockQuery && lowerMsg.includes("batch");

            if (!isStockQuery) return;


            // Determine recipient chat JID & sender phone number
            let recipientChat = targetChat || (msg.fromMe ? msg.to : msg.from);
            if (!recipientChat) return;

            let senderNumber = "";
            let contactObj = null;

            try {
                contactObj = await msg.getContact();
                if (contactObj) {
                    if (contactObj.number && !contactObj.number.startsWith("11") && contactObj.number.length <= 13) {
                        senderNumber = contactObj.number;
                    } else if (contactObj.id && contactObj.id._serialized && contactObj.id._serialized.endsWith("@c.us")) {
                        senderNumber = contactObj.id.user;
                    }
                }
            } catch (e) { }

            if (!senderNumber || senderNumber.length > 13 || senderNumber.startsWith("11")) {
                try {
                    const chat = await msg.getChat();
                    if (chat && chat.id && chat.id._serialized && chat.id._serialized.endsWith("@c.us")) {
                        senderNumber = chat.id.user;
                    }
                } catch (e) { }
            }

            if (!senderNumber || senderNumber.length > 13 || senderNumber.startsWith("11")) {
                if (msg._data) {
                    const candidate = msg._data.author || msg._data.from || msg._data.to || (msg._data.id && msg._data.id.remote);
                    if (candidate && candidate.endsWith("@c.us")) {
                        senderNumber = candidate.replace("@c.us", "").split(":")[0];
                    }
                }
            }

            if (!senderNumber) {
                senderNumber = recipientChat.replace("@c.us", "").replace("@s.whatsapp.net", "").replace("@lid", "").split(":")[0].split("@")[0];
            }

            console.log(`📩 Processing STOCK command for +${senderNumber} (${recipientChat}): "${rawBody}"`);
            addLog("info", `Received STOCK command from +${senderNumber} (${recipientChat}): "${rawBody}"`);

            const stopWords = new Set(["stock", "#stock", "status", "list", "stocklist", "send", "pls", "please", "give", "show", "me", "closing", "items", "catalog", "pdf", "report"]);
            
            // Clean message for matching
            const msgWords = lowerMsg.split(/[\s,]+/);

            const displayItems = [];

            // Execute logic
            for (let i = 0; i < msgWords.length; i++) {
                const word = msgWords[i];
                if (!word || stopWords.has(word)) continue;
                displayItems.push(word);
            }

            // if (displayItems.length === 0 && !isBatchQuery) return; // Ignore pure "STOCK" command with no item specified unless it's a batch request
            const words = rawBody.split(/\s+/).filter(w => !stopWords.has(w.toLowerCase()));
            const searchKeyword = words.join(" ");

            const config = BusyService.getConfig();
            const firms = config.firms || [];

            if (firms.length === 0) {
                addLog("warning", "No configured BUSY firms found for STOCK command.");
                await clientInstance.sendMessage(recipientChat, "⚠️ Stock Status service is currently unavailable. (No active BUSY firm configured)");
                return;
            }

            // 1. Verify Sender Customer Status in BUSY Database (by Phone Number)
            addLog("info", `Verifying customer phone number +${senderNumber} in BUSY database...`);
            let matchedFirms = [];
            for (const firm of firms) {
                try {
                    const info = await BusyService.getPartyByPhone(firm, senderNumber);
                    if (info && info.PartyName) {
                        matchedFirms.push({ firm: firm, partyInfo: info, partyName: info.PartyName });
                    }
                } catch (e) {
                    console.error("Error verifying customer by phone:", e.message);
                }
            }

            // Fallback: If phone lookup didn't match and sender has a contact name/pushname, try lookup by Name
            if (matchedFirms.length === 0 && contactObj) {
                const searchName = contactObj.name || contactObj.pushname;
                if (searchName) {
                    addLog("info", `Trying customer verification by contact name "${searchName}"...`);
                    for (const firm of firms) {
                        try {
                            const info = await BusyService.getPartyByName(firm, searchName);
                            if (info && info.PartyName) {
                                matchedFirms.push({ firm: firm, partyInfo: info, partyName: info.PartyName });
                            }
                        } catch (e) { }
                    }
                }
            }

            // Check if sender is Admin / Owner
            const ownerWidNumber = clientInstance.info?.wid?.user || "";
            const isOwner = msg.fromMe ||
                (ownerWidNumber && senderNumber.includes(ownerWidNumber)) ||
                firms.some(f => f.adminPhone && senderNumber.includes(f.adminPhone.replace(/\D/g, '')));

            if (isBatchQuery && !isOwner) {
                addLog("warning", `BATCH STOCK command rejected for +${senderNumber} (Not Admin)`);
                const unauthorizedMsg = `⚠️ *Admin Access Required*\n\nSorry, the batch-wise stock report is restricted to admin users only.`;
                await clientInstance.sendMessage(recipientChat, unauthorizedMsg);
                return;
            }

            // If number is not registered as a customer in BUSY (and not self/owner test):
            if (matchedFirms.length === 0) {
                if (isOwner) {
                    addLog("info", `Owner +${senderNumber} requesting stock without party match. Using all firms.`);
                    matchedFirms = firms.map(f => ({ firm: f, partyInfo: {}, partyName: "Admin / Owner" }));
                } else {
                    addLog("warning", `STOCK command rejected for +${senderNumber} (Number not registered as a customer in BUSY)`);
                    const unauthorizedMsg = `⚠️ *Access Restricted*\n\nSorry, your phone number (*+${senderNumber}*) is not registered as an authorized customer in our BUSY system.\n\nStock PDF reports are only provided to registered customer accounts. Please contact management to register your mobile number.`;
                    await clientInstance.sendMessage(recipientChat, unauthorizedMsg);
                    return;
                }
            }

            // Loop through all matched firms to send stock reports
            for (const match of matchedFirms) {
                const activeFirm = match.firm;
                const partyName = match.partyName;
                const partyInfo = match.partyInfo;

                // 2. Fetch Stock Status for Valid Customer
                let stockItems = [];
                addLog("info", `Authorized customer *${partyName}* (+${senderNumber}). Querying BUSY stock items for firm ${activeFirm.name}...`);
                try {
                    if (isBatchQuery) {
                        const cleanSearch = searchKeyword.replace(/batch/gi, "").trim();
                        stockItems = await BusyService.getBatchClosingStock(activeFirm, cleanSearch);
                    } else {
                        stockItems = await BusyService.getClosingStock(activeFirm, searchKeyword);
                    }
                } catch (e) {
                    console.error(`Error querying stock for firm ${activeFirm.name}:`, e.message);
                }

                if (!stockItems || stockItems.length === 0) {
                    addLog("warning", `No stock items found for +${senderNumber} in firm ${activeFirm.name}`);
                    const noStockMsg = searchKeyword
                        ? `📦 *Stock Status Update*\n🏢 *${activeFirm.companyName || activeFirm.name || 'BUSY Accounting'}*\n👤 Hello *${partyName}*,\n\n❌ No items found matching "${searchKeyword}".`
                        : `📦 *Stock Status Update*\n🏢 *${activeFirm.companyName || activeFirm.name || 'BUSY Accounting'}*\n👤 Hello *${partyName}*,\n\n❌ No active stock records found.`;
                    await clientInstance.sendMessage(recipientChat, noStockMsg);
                    continue; // Continue to the next firm
                }

                addLog("info", `Found ${stockItems.length} items. Generating Stock PDF report for firm ${activeFirm.name}...`);

                let companyProfile = null;
                try {
                    companyProfile = await BusyService.getCompanyProfile(activeFirm);
                } catch (e) { }

                let pdfPath = null;
                try {
                    if (isBatchQuery) {
                        pdfPath = await BusyService.generateBatchStockPdf(activeFirm, stockItems, companyProfile);
                    } else {
                        pdfPath = await BusyService.generateStockPdf(activeFirm, stockItems, companyProfile);
                    }
                } catch (e) {
                    console.error("Failed generating Stock PDF:", e.message);
                    addLog("warning", `PDF generation warning: ${e.message}. Falling back to text report.`);
                }

                let sentSuccessfully = false;
                if (pdfPath && fs.existsSync(pdfPath)) {
                    try {
                        addLog("info", `Sending PDF file to +${senderNumber}...`);
                        const media = MessageMedia.fromFilePath(pdfPath);
                        const pdfCaption = `📄 *Stock Status Report (PDF)*\n🏢 *${companyProfile?.Name || activeFirm.companyName || activeFirm.name}*\n👤 Hello *${partyName}*,\n📅 *As On:* ${new Date().toLocaleDateString('en-GB').replace(/\//g, '-')}`;

                        const targetSendChat = (recipientChat && !recipientChat.endsWith('@lid')) ? recipientChat : (senderNumber ? `${senderNumber}@c.us` : recipientChat);
                        try {
                            await clientInstance.sendMessage(targetSendChat, media, { caption: pdfCaption, sendMediaAsDocument: true });
                            sentSuccessfully = true;
                        } catch (primaryErr) {
                            if (recipientChat !== targetSendChat) {
                                await clientInstance.sendMessage(recipientChat, media, { caption: pdfCaption, sendMediaAsDocument: true });
                                sentSuccessfully = true;
                            } else {
                                throw primaryErr;
                            }
                        }
                        addLog("success", `Sent Closing Stock PDF report to +${senderNumber} (${stockItems.length} items)`);
                    } catch (sendErr) {
                        console.error("Failed sending Stock PDF media to recipient:", sendErr.message);
                        addLog("warning", `Failed sending PDF report to +${senderNumber}: ${sendErr.message}. Falling back to text report.`);
                    } finally {
                        setTimeout(() => {
                            try { if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath); } catch (e) { }
                        }, 60000);
                    }
                }

                if (!sentSuccessfully) {
                    addLog("info", `Sending text summary to +${senderNumber}...`);
                    const displayItems = stockItems.slice(0, 25);
                    let stockText = `📦 *CLOSING STOCK STATUS*\n🏢 *${companyProfile?.Name || activeFirm.companyName || activeFirm.name || 'BUSY Accounting'}*\n👤 Hello *${partyName}*,\n----------------------------------------\n`;

                    displayItems.forEach((item, index) => {
                        const qty = item.ClosingQty !== undefined ? Math.abs(item.ClosingQty) : Math.abs(item.RawQty || 0);
                        if (isBatchQuery && item.BatchNo) {
                            stockText += `${index + 1}. *${item.ItemName}* [Batch: ${item.BatchNo}]: ${qty}\n`;
                        } else {
                            stockText += `${index + 1}. *${item.ItemName}*: ${qty}\n`;
                        }
                    });

                    if (stockItems.length > 25) {
                        stockText += `\n_...and ${stockItems.length - 25} more items._\n`;
                    }

                    stockText += `----------------------------------------\n📅 *As of:* ${new Date().toLocaleString('en-IN')}\n_For orders, please reply directly to this chat._`;

                    await clientInstance.sendMessage(recipientChat, stockText);
                    addLog("success", `Sent Closing Stock status text reply to +${senderNumber} (${displayItems.length} items)`);
                }
            }
        } catch (err) {
            console.error("Error processing incoming WhatsApp stock command:", err);
            addLog("error", `Failed processing STOCK command: ${err.message}`);
        }
    };

    const processedPaymentIds = new Set();

    const handlePaymentCommand = async (msg) => {
        try {
            if (!msg) return;
            const rawBody = (msg.body || "").trim();
            if (!rawBody) return;

            const lowerMsg = rawBody.toLowerCase();
            if (lowerMsg !== "payment" && lowerMsg !== "bank" && lowerMsg !== "bank details" && lowerMsg !== "pay") return;

            // Deduplicate payment message triggers
            const msgId = (msg.id && typeof msg.id === 'object') ? (msg.id._serialized || msg.id.id) : String(msg.id || '');
            if (msgId) {
                if (processedPaymentIds.has(msgId)) return;
                processedPaymentIds.add(msgId);
                if (processedPaymentIds.size > 500) {
                    const first = processedPaymentIds.values().next().value;
                    processedPaymentIds.delete(first);
                }
            }

            // Load latest config
            const configPath = path.join(appDir, "busy_config.json");
            if (!fs.existsSync(configPath)) return;
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (!config.firms || config.firms.length === 0) return;
            
            // Determine recipient chat JID & sender phone number
            let recipientChat = msg.fromMe ? msg.to : msg.from;
            if (!recipientChat) return;
            
            const isGroup = recipientChat.endsWith("@g.us") || (msg.from && msg.from.endsWith("@g.us"));
            if (isGroup) return;
            if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast') return;
            
            let senderNumber = "";
            let contactObj = null;

            try {
                contactObj = await msg.getContact();
                if (contactObj) {
                    if (contactObj.number && !contactObj.number.startsWith("11") && contactObj.number.length <= 13) {
                        senderNumber = contactObj.number;
                    } else if (contactObj.id && contactObj.id._serialized && contactObj.id._serialized.endsWith("@c.us")) {
                        senderNumber = contactObj.id.user;
                    }
                }
            } catch (e) { }

            if (!senderNumber || senderNumber.length > 13 || senderNumber.startsWith("11")) {
                try {
                    const chat = await msg.getChat();
                    if (chat && chat.id && chat.id._serialized && chat.id._serialized.endsWith("@c.us")) {
                        senderNumber = chat.id.user;
                    }
                } catch (e) { }
            }

            if (!senderNumber || senderNumber.length > 13 || senderNumber.startsWith("11")) {
                if (msg._data) {
                    const candidate = msg._data.author || msg._data.from || msg._data.to || (msg._data.id && msg._data.id.remote);
                    if (candidate && candidate.endsWith("@c.us")) {
                        senderNumber = candidate.replace("@c.us", "").split(":")[0];
                    }
                }
            }

            if (!senderNumber) {
                senderNumber = recipientChat.replace("@c.us", "").replace("@s.whatsapp.net", "").replace("@lid", "").split(":")[0].split("@")[0];
            }

            let matchedFirms = [];
            for (const firm of config.firms) {
                try {
                    const info = await BusyService.getPartyByPhone(firm, senderNumber);
                    if (info && info.PartyName) {
                        matchedFirms.push({ firm: firm, partyName: info.PartyName });
                    }
                } catch (e) { }
            }

            // If sender is not found in any database AND it's not the admin themselves, ignore the message
            if (matchedFirms.length === 0 && !msg.fromMe) {
                return;
            }

            // If the admin sent the command for testing but they aren't in any DB, fallback to showing ALL firms
            if (matchedFirms.length === 0 && msg.fromMe) {
                matchedFirms = config.firms.map(f => ({ firm: f, partyName: "Admin" }));
            }

            let sentCount = 0;

            for (const match of matchedFirms) {
                const activeFirm = match.firm;
                const customerName = match.partyName;
                const p = activeFirm.paymentDetails;
                if (!p || (!p.bankName && !p.upiId)) continue; // No payment details configured for this firm

                let myCompanyName = activeFirm.name || 'our firm';
                try {
                    const compProfile = await BusyService.getCompanyProfile(activeFirm);
                    if (compProfile && compProfile.Name) {
                        myCompanyName = compProfile.Name;
                    }
                } catch (e) { }

                // Construct message
                let reply = `🏦 *Payment Details*\n`;
                if (customerName && customerName !== "Admin") {
                    reply += `Dear *${customerName}*,\nHere are the payment details for *${myCompanyName}*:\n\n`;
                } else {
                    reply += `Here are the payment details for *${myCompanyName}*:\n\n`;
                }
                if (p.bankName || p.accountNumber) {
                    reply += `*Bank Transfer (NEFT/RTGS):*\n`;
                    if (p.bankName) reply += `Bank: ${p.bankName}\n`;
                    if (p.accountName) reply += `Account Name: ${p.accountName}\n`;
                    if (p.accountNumber) reply += `A/C No: ${p.accountNumber}\n`;
                    if (p.ifscCode) reply += `IFSC: ${p.ifscCode}\n\n`;
                }
                if (p.upiId || p.phone) {
                    reply += `*UPI Payment:*\n`;
                    if (p.upiId) reply += `UPI ID: ${p.upiId}\n`;
                    if (p.phone) reply += `Phone: ${p.phone}\n\n`;
                }

                // Send message with QR if available
                if (p.qrCodePath && fs.existsSync(p.qrCodePath)) {
                    reply += `_(Or scan the attached QR Code to pay instantly!)_`;
                    const media = MessageMedia.fromFilePath(p.qrCodePath);
                    await msg.reply(media, null, { caption: reply });
                } else {
                    await msg.reply(reply);
                }
                sentCount++;
            }

            if (sentCount > 0) {
                console.log(`💬 Sent Payment Details to ${msg.from} for ${sentCount} firm(s)`);
            }
        } catch (err) {
            console.error("Error processing incoming payment command:", err);
        }
    };

    clientInstance.on("message", async (msg) => {
        try {
            await handleStockCommand(msg);
            await handlePaymentCommand(msg);
        } catch (err) {
            console.error("Error in message event handler:", err);
        }
    });

    clientInstance.on("message_create", async (msg) => {
        try {
            await handleStockCommand(msg);
            await handlePaymentCommand(msg);
        } catch (err) {
            console.error("Error in message_create event handler:", err);
        }
    });

    clientInstance.on("disconnected", async (reason) => {
        // If we are voluntarily clearing session, IGNORE this event
        if (clientsClearingSession.has(clientId)) {
            console.log(`ℹ️ [${clientInfo.name}] Client disconnected during session clear (intentional). Ignoring auto-reconnect.`);
            return;
        }

        console.log(`⚠️ [${clientInfo.name}] WhatsApp Client disconnected:`, reason);
        addLog("warning", `[${clientInfo.name}] Client disconnected, attempting to reconnect...`, { reason: reason });

        clientInfo.status = "authenticating";
        clientInfo.isReady = false;
        clientInfo.qrCodeBase64 = null;
        clientInfo.qrCodeData = null;
        clientInfo.pairingCode = null;

        try {
            await clientInstance.destroy();
        } catch (e) { }

        // Reinitialize with a fresh client instance via reconnectClient
        setTimeout(() => {
            if (!clientsClearingSession.has(clientId)) {
                reconnectClient(clientId);
            }
        }, 1500);
    });

    return clientInfo;
}

// ======================
// Per-Account Sub-Server
// ======================
const http = require('http');

function startClientSubServer(clientId) {
    if (clientId === 'default') return; // Default runs on main app port
    if (clientServers.has(clientId)) return; // Already running

    const assignedPort = clientPorts.get(clientId);
    if (!assignedPort) {
        console.warn(`⚠️ No port assigned for client ${clientId}. Skipping sub-server.`);
        return;
    }

    const subApp = express();
    subApp.use(express.json());
    subApp.use(express.urlencoded({ extended: true }));

    const clientInfo = clients.get(clientId);
    const accountName = clientInfo ? clientInfo.name : clientId;

    // GET /status
    subApp.get('/status', (req, res) => {
        const info = clients.get(clientId);
        if (!info) return res.json({ success: false, status: 'not_found' });
        res.json({
            success: true,
            status: info.status,
            ready: info.isReady,
            number: info.number,
            name: info.name,
            port: assignedPort
        });
    });

    // GET /qr
    subApp.get('/qr', (req, res) => {
        const info = clients.get(clientId);
        if (!info) return res.status(404).json({ success: false, error: 'Client not found' });
        if (!info.qrCodeBase64) {
            return res.json({ success: false, error: info.isReady ? 'Already connected' : 'QR not yet generated' });
        }
        res.json({ success: true, qr: info.qrCodeBase64 });
    });

    // POST /send  (supports JSON and form-encoded)
    // Unified send handler — supports both /send and /api/v1/send (GET + POST)
    // Supports: text-only, pdfPath query param, multipart file upload
    // Compatible with BUSY (pdfPath), Postman (multipart), and any integration

    const addJobToSubQueue = (mobile, message, filePath, res) => {
        const mobileNumber = formatMobileNumber(mobile);
        if (!mobileNumber) {
            return res.status(400).json({ success: false, error: 'Invalid mobile number' });
        }

        // Deduplicate: ignore duplicate requests within 10 seconds
        const dedupeKey = `${mobileNumber}:${message}`;
        const now = Date.now();
        if (recentRequests.has(dedupeKey)) {
            const lastTime = recentRequests.get(dedupeKey);
            if (now - lastTime < RECENT_REQUEST_WINDOW) {
                if (filePath && fs.existsSync(filePath)) {
                    try { fs.unlinkSync(filePath); } catch (e) { }
                }
                return res.json({ success: true, message: 'Duplicate request ignored', to: mobileNumber });
            }
        }
        recentRequests.set(dedupeKey, now);

        const jobId = `${mobileNumber}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        const job = {
            id: jobId,
            number: mobileNumber,
            message: message || '',
            filePath: filePath || null,
            status: 'pending',
            whatsappClientId: clientId,
            createdAt: new Date().toISOString(),
            retryCount: 0,
            isPriority: true
        };

        // Add to FRONT of queue for instant delivery
        messageQueue.unshift(job);
        saveQueue(messageQueue);
        processQueue();
        addLog('info', `[Port ${assignedPort}] Message queued for ${mobileNumber} via ${accountName}${filePath ? ' (with file)' : ''}`);
        res.json({ success: true, jobId, queued: true, to: mobileNumber, port: assignedPort });
    };

    const sendHandler = (req, res) => {
        // === CASE 1: Multipart file upload (POST with file attached) ===
        if (req.is('multipart/form-data')) {
            let busboy2;
            try {
                busboy2 = Busboy({ headers: req.headers });
            } catch (e) {
                return res.status(400).json({ success: false, error: 'Invalid multipart request' });
            }

            const fields = {};
            const files = [];

            busboy2.on('field', (name, val) => { fields[name] = val; });
            busboy2.on('file', (name, file, info) => {
                const filename = info?.filename || (typeof info === 'string' ? info : '');
                if (!filename) {
                    file.resume();
                    return;
                }
                const uploadsDir = path.join(appDir, 'uploads');
                if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
                let saveTo = path.join(uploadsDir, filename);
                let counter = 1;
                while (fs.existsSync(saveTo)) {
                    const p = path.parse(filename);
                    saveTo = path.join(uploadsDir, `${p.name}_${String(counter).padStart(2, '0')}${p.ext}`);
                    counter++;
                }
                file.pipe(fs.createWriteStream(saveTo));
                files.push({ path: saveTo });
            });
            busboy2.on('finish', () => {
                const findF = (names) => {
                    for (const n of names) {
                        const k = Object.keys(fields).find(k => k.toLowerCase() === n.toLowerCase());
                        if (k) return fields[k];
                    }
                    return null;
                };
                const mobile = findF(['Mobile', 'mobile', 'number', 'phone']);
                const message = findF(['Message', 'message', 'msg', 'text']) || '';
                const filePath = files.length > 0 ? files[0].path : null;
                addJobToSubQueue(mobile, message, filePath, res);
            });
            return req.pipe(busboy2);
        }

        // === CASE 2: GET / POST with pdfPath or filePath query param (BUSY style) ===
        const params = Object.assign({}, req.query || {}, req.body || {});
        const mobile = params.Mobile || params.mobile || params.number || params.phone;
        const message = params.Message || params.message || params.msg || params.text || '';

        // BUSY sends PDF path as a query param — accept all common names
        let filePath = params.pdfPath || params.filePath || params.attachment ||
            params.file || params.pdf || params.PDFPATH || null;

        // Ignore literal BUSY placeholder "<PDFPATH>"
        if (filePath && (filePath.trim() === '<PDFPATH>' || (filePath.includes('<') && filePath.includes('>')))) {
            filePath = null;
        }

        // Verify file exists if a path was provided
        if (filePath && !fs.existsSync(filePath)) {
            addLog('warning', `[Port ${assignedPort}] PDF path not found on disk: ${filePath}`);
            filePath = null;
        }

        if (!mobile) {
            return res.status(400).json({ success: false, error: 'Mobile number is required (param: Mobile)' });
        }

        addJobToSubQueue(mobile, message, filePath, res);
    };

    subApp.all('/send', sendHandler);           // localhost:5001/send
    subApp.all('/api/v1/send', sendHandler);    // localhost:5001/api/v1/send  ← BUSY default
    // Request pairing code directly for this sub-server's client
    const subPairingHandler = async (req, res) => {
        try {
            const params = Object.assign({}, req.query || {}, req.body || {});
            const phoneNumber = params.phoneNumber || params.number || params.phone;
            if (!phoneNumber) {
                return res.status(400).json({ success: false, error: 'Phone number is required (param: phoneNumber)' });
            }

            const info = clients.get(clientId);
            if (!info) return res.status(404).json({ success: false, error: 'Client not found' });
            if (info.isReady) return res.status(400).json({ success: false, error: 'Client is already connected' });

            const formatted = formatMobileNumber(phoneNumber);
            if (!formatted) {
                return res.status(400).json({ success: false, error: 'Invalid phone number format' });
            }

            console.log(`🔑 Requesting pairing code via port ${assignedPort} for +${formatted}...`);
            info.qrCodeBase64 = null;
            info.qrCodeData = null;
            info.status = "authenticating";

            const code = await info.client.requestPairingCode(formatted);
            info.pairingCode = code;

            addLog('success', `Pairing code generated via port ${assignedPort}: ${code}`);
            res.json({ success: true, code });
        } catch (e) {
            console.error('Error requesting sub-server pairing code:', e.message);
            res.status(500).json({ success: false, error: e.message });
        }
    };

    subApp.all('/pairing-code', subPairingHandler);
    subApp.all('/api/v1/pairing-code', subPairingHandler);

    // GET / — health check / info
    subApp.get('/', (req, res) => {
        const info = clients.get(clientId);
        res.json({
            account: info ? info.name : clientId,
            port: assignedPort,
            status: info ? info.status : 'unknown',
            ready: info ? info.isReady : false,
            number: info ? info.number : null,
            endpoints: [
                'GET /status',
                'GET /qr',
                'GET /send?Mobile=...&Message=...',
                'GET /api/v1/send?Mobile=...&Message=...',
                'POST /send',
                'POST /api/v1/send',
                'POST /pairing-code?phoneNumber=...',
                'POST /api/v1/pairing-code?phoneNumber=...'
            ]
        });
    });

    const server = http.createServer(subApp);
    server.listen(assignedPort, () => {
        console.log(`🌐 [${accountName}] Sub-server started on port ${assignedPort}`);
        addLog('success', `Account '${accountName}' is accessible on port ${assignedPort}`);
    });
    server.on('error', (err) => {
        console.error(`❌ Sub-server for ${accountName} on port ${assignedPort} failed:`, err.message);
        addLog('error', `Sub-server for '${accountName}' failed on port ${assignedPort}`, { error: err.message });
    });

    clientServers.set(clientId, server);
}

function stopClientSubServer(clientId) {
    const server = clientServers.get(clientId);
    if (!server) return;
    server.close(() => {
        console.log(`🔴 Sub-server for client ${clientId} stopped`);
    });
    clientServers.delete(clientId);
}

async function initializeAllClients() {
    addLog("info", "Initializing WhatsApp Clients...");

    // 1. Ensure default client is created (always on port 5000)
    getOrCreateClient("default", "Default Account");

    // 2. Scan auth directory for other sessions
    const authDir = path.join(appDir, ".wwebjs_auth");
    if (fs.existsSync(authDir)) {
        try {
            const files = fs.readdirSync(authDir);
            files.forEach(file => {
                const folderPath = path.join(authDir, file);
                if (fs.statSync(folderPath).isDirectory() && file.startsWith("session-")) {
                    const clientId = file.substring("session-".length);
                    if (clientId !== "default" && clientId !== "client-one") {
                        // Assign port if not already saved
                        if (!clientPorts.has(clientId)) {
                            clientPorts.set(clientId, getNextAvailablePort());
                            saveClientPorts();
                        }
                        getOrCreateClient(clientId);
                    } else if (clientId === "client-one") {
                        // Migrate legacy 'client-one' — assign port if needed
                        if (!clientPorts.has("client-one")) {
                            clientPorts.set("client-one", getNextAvailablePort());
                            saveClientPorts();
                        }
                        getOrCreateClient("client-one", "Primary Account");
                    }
                }
            });
        } catch (err) {
            console.error("Error scanning WhatsApp session folders:", err.message);
        }
    }

    // Ensure all clients with port assignments are registered
    for (const clientId of clientPorts.keys()) {
        if (!clients.has(clientId)) {
            const name = clientNames.get(clientId) || (clientId === "client-one" ? "Primary Account" : null);
            getOrCreateClient(clientId, name);
        }
    }

    // 3. Initialize all registered clients
    for (const [clientId, info] of clients.entries()) {
        try {
            console.log(`🔄 Initializing WhatsApp client connection for: ${info.name}`);
            info.client.initialize().catch(err => {
                console.error(`Error initializing client ${clientId}:`, err.message);
                info.status = "disconnected";
            });
        } catch (err) {
            console.error(`Failed to initialize client ${clientId}:`, err.message);
        }
    }

    // 4. Start per-account sub-servers for all non-default clients
    for (const [clientId] of clients.entries()) {
        if (clientId !== 'default') {
            startClientSubServer(clientId);
        }
    }
}



// ======================
// Delay helper
// ======================
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ======================
// Queue Helpers
// ======================
function loadQueue() {
    if (!fs.existsSync(queueFile)) return [];
    try {
        return JSON.parse(fs.readFileSync(queueFile, "utf8"));
    } catch {
        return [];
    }
}

function saveQueue(queue) {
    fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2));
}

let messageQueue = loadQueue();
let processing = false;
let queuePaused = false;

// STARTUP CLEANUP: Reset any 'processing' jobs to 'pending' in case server crashed
if (messageQueue.some(j => j.status === 'processing')) {
    console.log("🧹 Resetting stuck 'processing' jobs to 'pending'...");
    messageQueue.forEach(job => {
        if (job.status === 'processing') {
            job.status = 'pending';
        }
    });
    saveQueue(messageQueue);
}

// ==========================================
// Mode B: Smart Account Load-Balancer & Batch Rotation
// ==========================================
const ROTATION_CHUNK_SIZE = 25; // Send 25 messages per SIM before rotating
let rotationClientIndex = 0;
let currentChunkSentCount = 0;

async function processQueue() {
    if (processing || queuePaused) return;
    processing = true;

    const BATCH_SIZE = 10; // Send 10 messages at once
    const BATCH_DELAY = 20000; // 20 seconds gap between batches

    while (messageQueue.length > 0) {
        let batchCount = 0;

        // Process a batch of 10 messages
        while (batchCount < BATCH_SIZE && messageQueue.length > 0) {
            // Check pause status inside the loop
            if (queuePaused) {
                addLog("info", "Queue processing paused by user.");
                processing = false;
                return;
            }

            // Find first pending job (skip failed/processing jobs)
            const jobIndex = messageQueue.findIndex(job => job.status === 'pending' || !job.status);

            if (jobIndex === -1) {
                // No pending jobs, exit batch
                break;
            }

            const job = messageQueue[jobIndex];

            // SAFETY Standby Loop: Wait if there are absolutely no ready WhatsApp clients connected
            const readyClients = [...clients.values()].filter(c => c.isReady);
            if (readyClients.length === 0) {
                console.log("⚠️ No ready WhatsApp clients available. Standby mode active... waiting for connection.");
                addLog("warning", "Waiting for at least one WhatsApp client to connect...");

                while (true) {
                    if (queuePaused) {
                        processing = false;
                        return;
                    }
                    const currentReady = [...clients.values()].filter(c => c.isReady);
                    if (currentReady.length > 0) {
                        console.log("✅ WhatsApp client is ready! Resuming queue.");
                        addLog("success", "WhatsApp client connected. Resuming queue...");
                        break;
                    }
                    await delay(5000); // Check every 5 seconds
                }
            }

            // Mark as processing
            job.status = 'processing';
            saveQueue(messageQueue);

            try {
                await sendMessageJob(job);
                addLog("success", `Message sent successfully (Job: ${job.id.split('_').pop()})`, { number: job.number, id: job.id });

                // Refresh index in case queue shifted
                const currentJobIndex = messageQueue.indexOf(job);
                if (currentJobIndex !== -1) {
                    // Update status mostly for safety/logging
                    job.status = 'sent';
                    job.sentAt = new Date().toISOString();

                    // Remove from queue
                    messageQueue.splice(currentJobIndex, 1);
                    saveQueue(messageQueue);
                }

                batchCount++;
            } catch (err) {
                const errorMsg = err.message || "Unknown error";
                addLog("error", `Failed to send message (Job: ${job.id.split('_').pop()})`, { number: job.number, error: errorMsg, id: job.id });

                // Refresh index
                const currentJobIndex = messageQueue.indexOf(job);
                if (currentJobIndex !== -1) {
                    // Check for connection/internet issues OR if Client is not ready yet
                    const isConnectionError = errorMsg.toLowerCase().includes("connection") ||
                        errorMsg.toLowerCase().includes("disconnected") ||
                        errorMsg.toLowerCase().includes("network") ||
                        errorMsg.toLowerCase().includes("timeout") ||
                        errorMsg.toLowerCase().includes("closed") ||
                        errorMsg.toLowerCase().includes("navigation");

                    if (isConnectionError) {
                        console.log(`🌐 [Network/Client] Connection issue detected (${errorMsg}). Waiting for internet...`);
                        addLog("warning", "Waiting for internet connection...", { reason: errorMsg });

                        // Active Check Loop: Wait until internet is back
                        while (true) {
                            try {
                                // Try to ping Google DNS to check connectivity
                                await new Promise((resolve, reject) => {
                                    dns.lookup('google.com', (err) => {
                                        if (err && err.code === "ENOTFOUND") reject(err);
                                        else resolve();
                                    });
                                });
                                console.log("✅ Internet connection restored! Stabilizing...");
                                addLog("success", "Internet restored. Waiting 5s for client stabilization...");
                                // Wait 5 seconds for WhatsApp Client to flip from 'DISCONNECTED' to 'CONNECTED'
                                await new Promise(resolve => setTimeout(resolve, 5000));
                                console.log("🚀 Resuming queue now!");
                                break; // Exit loop and continue
                            } catch (e) {
                                // Still offline, wait 3 seconds and check again
                                await new Promise(resolve => setTimeout(resolve, 3000));
                            }
                        }
                    }

                    // Auto-retry logic
                    const retryCount = (job.retryCount || 0) + 1;

                    const isFatalError = errorMsg.includes("not registered") ||
                        errorMsg.includes("invalid number") ||
                        errorMsg.includes("unable to parse") ||
                        errorMsg.includes("Message or file required") ||
                        errorMsg.includes("File not found");

                    const isRecoverableError = !isFatalError;

                    if (isRecoverableError && retryCount <= 100) { // Increased to 100 retries (essentially infinite for network issues)
                        job.status = 'pending';
                        job.retryCount = retryCount;
                        job.error = undefined;
                        job.failedAt = undefined;
                        job.lastError = errorMsg;

                        // Move to end of queue to retry later
                        messageQueue.splice(currentJobIndex, 1);
                        messageQueue.push(job);
                        console.log(`🔄 [Job: ${job.id.split('_').pop()}] Auto-retrying message (Attempt ${retryCount}/100). Error: ${errorMsg}`);
                        addLog("warning", `Message queued for retry (attempt ${retryCount}/100)`, { number: job.number, error: errorMsg });
                    } else {
                        job.status = 'failed';
                        job.failedAt = new Date().toISOString();
                        job.error = errorMsg;
                        job.retryCount = retryCount;

                        // Move to end
                        messageQueue.splice(currentJobIndex, 1);
                        messageQueue.push(job);
                    }
                    saveQueue(messageQueue);
                }

                batchCount++;
            }

            // Small delay between messages in the same batch
            if (batchCount < BATCH_SIZE) {
                // Random Delay 8-10 seconds for safety
                const randomDelay = Math.floor(Math.random() * (10000 - 8000 + 1) + 8000);
                console.log(`⏳ Waiting ${randomDelay}ms before next message...`);
                await new Promise(resolve => setTimeout(resolve, randomDelay));
            }
        }

        // After sending a batch of 10, wait 20 seconds before next batch
        if (messageQueue.length > 0) {
            if (queuePaused) {
                processing = false;
                return;
            }

            // Only wait if there are actual pending messages left
            const pendingJobs = messageQueue.filter(job => job.status === 'pending' || !job.status);
            if (pendingJobs.length > 0) {
                addLog("info", `Batch of ${batchCount} messages sent. Waiting 20 seconds before next batch...`, {
                    batchSize: batchCount,
                    remaining: pendingJobs.length
                });
                await delay(BATCH_DELAY);
            } else {
                // If no pending jobs, break logic loop to re-evaluate or finish
                break;
            }
        }
    }

    processing = false;
}

// ======================
// Helper Functions
// ======================

// Helper to timeout a promise
const withTimeout = (promise, ms = 30000) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Operation timed out')), ms))
]);



// SAFETY: Function to inject invisible zero-width spaces to randomize message hash
function randomizeText(text) {
    if (!text) return "";
    const zeroWidthSpace = '\u200B';
    const splitText = text.split('');
    // Insert invisible space at a random position
    const randomPos = Math.floor(Math.random() * splitText.length);
    splitText.splice(randomPos, 0, zeroWidthSpace);
    return splitText.join('');
}

// ======================
// Send job handler
// ======================
async function sendMessageJob(job) {
    const { number, message, filePath, id: jobId } = job;

    // SAFETY: Randomize text hash (Invisible to user, unique to WhatsApp)
    const safeMessage = randomizeText(message);

    const assignedClientId = job.whatsappClientId || "default";
    let clientInfo = null;

    // Mode B: Smart Account Load-Balancer / Batch Rotation (Only when explicitly set to auto_rotate)
    if (assignedClientId === "auto_rotate" || assignedClientId === "rotate") {
        const readyClients = [...clients.values()].filter(c => c.isReady);
        if (readyClients.length === 0) {
            throw new Error("No ready WhatsApp accounts connected for auto-rotation");
        }

        // If current SIM has sent ROTATION_CHUNK_SIZE (25 msgs), switch to next SIM
        if (currentChunkSentCount >= ROTATION_CHUNK_SIZE) {
            const previousClient = readyClients[rotationClientIndex % readyClients.length];
            rotationClientIndex = (rotationClientIndex + 1) % readyClients.length;
            currentChunkSentCount = 0;
            const newClient = readyClients[rotationClientIndex % readyClients.length];
            console.log(`🔀 [Mode B: SIM Rotation] Chunk of ${ROTATION_CHUNK_SIZE} msgs completed on [${previousClient?.name || 'Account'}]. Rotating to [${newClient?.name || 'Account'}]!`);
            addLog("info", `[SIM Rotation] Rotated sending account from [${previousClient?.name || 'Account'}] to [${newClient?.name || 'Account'}].`);
        }

        clientInfo = readyClients[rotationClientIndex % readyClients.length];
        currentChunkSentCount++;
        console.log(`📡 [Mode B: Load Balancer] Routing job via [${clientInfo.name}] (Msg ${currentChunkSentCount}/${ROTATION_CHUNK_SIZE} in chunk)`);
    } else {
        clientInfo = clients.get(assignedClientId);
    }

    if (!clientInfo) {
        throw new Error(`WhatsApp connection '${assignedClientId}' not found`);
    }

    // FALLBACK: If assigned client is not ready, try any other ready client
    if (!clientInfo.isReady) {
        const fallback = [...clients.values()].find(c => c.isReady);
        if (fallback) {
            console.log(`⚠️ [Job: ${job.id}] Assigned client '${clientInfo.name}' not ready. Falling back to '${fallback.name}'.`);
            addLog('warning', `Client '${clientInfo.name}' not ready. Routing via '${fallback.name}' instead.`, { job: job.id });
            clientInfo = fallback;
        }
    }

    // If client is authenticating, wait up to 10 seconds for it to become ready
    if (clientInfo.status === "authenticating") {
        console.log(`⏳ Message for ${number} arrived while connection ${clientInfo.name} is authenticating. Waiting...`);
        let waitTime = 0;
        while (clientInfo.status === "authenticating" && waitTime < 10000) {
            await delay(1000);
            waitTime += 1000;
        }
    }

    if (!clientInfo.client.info || !clientInfo.isReady) {
        throw new Error(`WhatsApp connection '${clientInfo.name}' is not ready (status: ${clientInfo.status})`);
    }

    const clientInstance = clientInfo.client;
    const cleanNumber = String(number).replace(/\D/g, "");
    const standardChatId = (cleanNumber || number) + "@c.us";
    let targetChatId = standardChatId;

    // Self-Healing: Pre-fetch contact safely to resolve JID and warm up WhatsApp Web cache without corrupting LID
    try {
        console.log(`🔍 Pre-resolving contact mapping for ${number} on ${clientInfo.name}...`);
        const numberId = await clientInstance.getNumberId(cleanNumber || number).catch(() => null);
        if (numberId && numberId._serialized && !numberId._serialized.includes('@lid')) {
            targetChatId = numberId._serialized;
            if (targetChatId !== standardChatId) {
                console.log(`ℹ️ Resolved identifier for ${number}: ${standardChatId} -> ${targetChatId}`);
            }
        } else {
            const contact = await clientInstance.getContactById(standardChatId).catch(() => null);
            if (contact && contact.id && contact.id._serialized && !contact.id._serialized.includes('@lid')) {
                targetChatId = contact.id._serialized;
            }
        }
    } catch (contactError) {
        console.warn(`⚠️ Warning pre-resolving contact ${number}:`, contactError.message);
    }

    try {
        // Human Simulation: "Typing..." Indicator
        try {
            const chat = await clientInstance.getChatById(targetChatId).catch(() => null);
            if (chat && typeof chat.sendStateTyping === 'function') {
                const typingDuration = Math.floor(Math.random() * (4000 - 2000 + 1) + 2000); // 2s to 4s
                console.log(`✍️ [Human Sim] Typing for ${typingDuration}ms in chat ${number} using ${clientInfo.name}...`);
                await chat.sendStateTyping().catch(() => {});
                await delay(typingDuration);
                await chat.clearState().catch(() => {});
            }
        } catch (simError) {
            // Chat might not exist yet, normal for first-time recipients
        }

        // SELF-HEALING: If BUSY sends a literal placeholder like "<PDFPATH>", treat it as null (no file)
        let finalFilePath = filePath;
        if (filePath && (filePath.trim() === "<PDFPATH>" || filePath.includes("<") && filePath.includes(">"))) {
            console.log(`⚠️ [Job: ${jobId}] Ignoring literal placeholder filePath: ${filePath}`);
            finalFilePath = null;
        }

        if (finalFilePath) {
            if (!fs.existsSync(finalFilePath)) {
                throw new Error(`File not found: ${finalFilePath}`);
            }

            if (fs.lstatSync(finalFilePath).isDirectory()) {
                throw new Error(`The path provided is a directory, not a file: ${finalFilePath}. Please provide the full path to the PDF file.`);
            }

            const ext = path.extname(finalFilePath).toLowerCase();
            const isMediaImageOrVideo = ['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.3gp', '.mov', '.gif'].includes(ext);
            const sendAsDocument = !isMediaImageOrVideo || Boolean(job.sendMediaAsDocument);

            console.log(`📤 [Job: ${jobId}] Sending ${sendAsDocument ? 'document' : 'media'} to ${number} via ${clientInfo.name} (File: ${path.basename(finalFilePath)})`);
            const media = MessageMedia.fromFilePath(finalFilePath);
            
            const sendOptions = {
                caption: safeMessage || "",
                sendMediaAsDocument: sendAsDocument
            };

            // Prime contact and chat model in WhatsApp Web to ensure memoized getters have valid data
            if (clientInstance.pupPage && typeof clientInstance.pupPage.evaluate === 'function') {
                await clientInstance.pupPage.evaluate(async (jid) => {
                    try {
                        const wid = window.require('WAWebWidFactory').createWid(jid);
                        const contactColl = window.require('WAWebCollections').Contact;
                        if (contactColl && !contactColl.get(wid)) {
                            await contactColl.find(wid).catch(() => {});
                        }
                    } catch (e) { }
                }, targetChatId).catch(() => {});
            }

            let response;
            try {
                response = await withTimeout(clientInstance.sendMessage(targetChatId, media, sendOptions), 45000);
            } catch (mediaSendErr) {
                const errMsg = mediaSendErr?.message || "";
                if (errMsg.includes("id property") || errMsg.includes("memoize") || errMsg.includes("lid") || errMsg.includes("Evaluation failed")) {
                    console.warn(`⚠️ [Job: ${jobId}] Primary send encountered memoize/getter error (${errMsg}). Attempting safe retry for ${standardChatId}...`);
                    
                    // Warm up chat model in page context to ensure memoizer has initialized Wid/Chat
                    if (clientInstance.pupPage && typeof clientInstance.pupPage.evaluate === 'function') {
                        await clientInstance.pupPage.evaluate(async (jid) => {
                            try {
                                const wid = window.require('WAWebWidFactory').createWid(jid);
                                await window.require('WAWebQueryExistsJob').queryWidExists(wid).catch(() => {});
                                const contactColl = window.require('WAWebCollections').Contact;
                                if (contactColl && !contactColl.get(wid)) {
                                    await contactColl.find(wid).catch(() => {});
                                }
                                await window.require('WAWebFindChatAction').findOrCreateLatestChat(wid);
                            } catch (e) { }
                        }, standardChatId).catch(() => {});
                    }

                    await delay(1500);
                    response = await withTimeout(clientInstance.sendMessage(standardChatId, media, sendOptions), 45000);
                } else {
                    throw mediaSendErr;
                }
            }

            const responseId = response && response.id ? response.id._serialized : `unknown_${Date.now()}`;
            console.log(`✅ [Job: ${jobId}] Media sent successfully. Message ID: ${responseId}`);
            return;
        }

        if (message) {
            console.log(`📤 [Job: ${jobId}] Sending text message to ${number} via ${clientInfo.name}`);
            let response;
            try {
                response = await withTimeout(clientInstance.sendMessage(targetChatId, safeMessage), 30000);
            } catch (textSendErr) {
                const errMsg = textSendErr?.message || "";
                if (errMsg.includes("id property") || errMsg.includes("memoize") || errMsg.includes("lid") || errMsg.includes("Evaluation failed")) {
                    console.warn(`⚠️ [Job: ${jobId}] Primary text send encountered memoize error. Retrying with ${standardChatId}...`);
                    await delay(1000);
                    response = await withTimeout(clientInstance.sendMessage(standardChatId, safeMessage), 30000);
                } else {
                    throw textSendErr;
                }
            }
            const responseId = response && response.id ? response.id._serialized : `unknown_${Date.now()}`;
            console.log(`✅ [Job: ${jobId}] Text sent successfully. Message ID: ${responseId}`);
            return;
        }

        throw new Error("Message or file required");
    } catch (error) {
        console.error("❌ Raw Send Error:", error); // Added for debugging
        // Better error handling for common WhatsApp errors
        let errorMessage = error.message || "Unknown error";

        if (errorMessage.includes("Evaluation failed") || errorMessage.includes("Evaluation failed: t")) {
            if (errorMessage.includes("id property") || errorMessage.includes("memoize")) {
                errorMessage = `WhatsApp internal memoize/contact error sending to ${number}. Contact data could not be indexed by WhatsApp Web.`;
            } else {
                errorMessage = `Number ${number} may not be on WhatsApp or chat cannot be accessed. Please verify the number is correct and has WhatsApp installed.`;
            }
        } else if (errorMessage.includes("not registered") || errorMessage.includes("not found")) {
            errorMessage = `Number ${number} is not registered on WhatsApp.`;
        } else if (errorMessage.includes("timeout") || errorMessage.includes("TIMEOUT")) {
            errorMessage = `Request timeout for ${number}. Please try again later.`;
        } else if (errorMessage.includes("rate limit") || errorMessage.includes("RATE_LIMIT")) {
            errorMessage = `Rate limit exceeded. Please wait before sending more messages.`;
        } else if (errorMessage.includes("connection") || errorMessage.includes("disconnected")) {
            errorMessage = `WhatsApp connection issue. Please check your connection.`;
        }

        throw new Error(errorMessage);
    }
}

// ======================
// Express Middleware
// ======================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS Middleware to allow localhost/127.0.0.1 cross-requests
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
        return res.sendStatus(200);
    }
    next();
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, "public")));

// ======================
// API Endpoints
// ======================

// ======================
// In-App Auto-Updater Endpoints
// ======================
app.get("/api/update/status", (req, res) => {
    try {
        res.json(updater.getStatus());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/update/check", async (req, res) => {
    try {
        const result = await updater.checkForUpdates();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message, status: updater.getStatus() });
    }
});

app.post("/api/update/apply", async (req, res) => {
    try {
        addLog("warning", "System update initiated via Dashboard...");
        // Launch update process in background so we immediately return HTTP 200 to client
        updater.applyUpdate().catch(err => {
            console.error("[Updater] Background update failure:", err);
            addLog("error", `System update failed: ${err.message}`);
        });
        res.json({ success: true, message: "Update initiated. Follow live status.", status: updater.getStatus() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Download Sample Excel File
app.get("/api/v1/download-sample-excel", (req, res) => {
    try {
        // Create sample data
        const sampleData = [
            { Mobile: '9876543210' },
            { Mobile: '9876543211' },
            { Mobile: '9876543212' },
            { Mobile: '9876543213' },
            { Mobile: '9876543214' }
        ];

        // Create workbook
        const workbook = XLSX.utils.book_new();
        const worksheet = XLSX.utils.json_to_sheet(sampleData);

        // Set column widths
        worksheet['!cols'] = [
            { wch: 15 } // Mobile column width
        ];

        // Add worksheet to workbook
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Contacts');

        // Generate buffer
        const buffer = XLSX.write(workbook, {
            type: 'buffer',
            bookType: 'xlsx',
            compression: true
        });

        // Verify buffer was created
        if (!buffer || buffer.length === 0) {
            throw new Error('Failed to generate Excel file buffer');
        }

        // Set headers before sending
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="bulkuploade.xlsx"');
        res.setHeader('Content-Length', buffer.length);

        // Send file
        res.send(buffer);

        addLog("info", "Sample Excel file downloaded", { filename: "bulkuploade.xlsx" });
    } catch (error) {
        console.error("Error generating sample Excel file:", error);
        addLog("error", "Failed to generate sample Excel file", { error: error.message });

        // Make sure to send proper error response
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                error: "Failed to generate sample Excel file: " + error.message
            });
        }
    }
});

// Get connection status (clientId aware)
app.get("/api/v1/status", async (req, res) => {
    const clientId = req.query.clientId || "default";
    const clientInfo = clients.get(clientId);

    // Calculate license days from license key
    let licenseDays = null;
    let licenseValid = false;
    let licenseError = null;
    let licenseTier = 'basic';

    try {
        const validation = await checkLicense();
        if (validation.valid) {
            licenseDays = validation.daysRemaining;
            licenseValid = true;
            licenseTier = validation.tier || 'basic';
        } else {
            licenseError = validation.error;
            licenseDays = 0;
        }
    } catch (err) {
        licenseError = err.message;
    }

    if (!clientInfo) {
        return res.json({
            status: "disconnected",
            ready: false,
            licenseDays: licenseDays,
            licenseValid: licenseValid,
            licenseError: licenseError,
            licenseTier: licenseTier
        });
    }

    const isReady = clientInfo.isReady || clientInfo.status === 'ready';
    const resolvedNumber = isReady ? (clientInfo.number || (clientInfo.client && clientInfo.client.info && clientInfo.client.info.wid ? clientInfo.client.info.wid.user : null)) : null;
    const resolvedPort = clientPorts.get(clientId) || (clientId === 'default' ? port : null);

    res.json({
        status: isReady ? 'ready' : clientInfo.status,
        ready: isReady,
        number: resolvedNumber,
        name: clientInfo.name,
        port: resolvedPort,
        pairingCode: clientInfo.pairingCode,
        licenseDays: licenseDays,
        licenseValid: licenseValid,
        licenseError: licenseError,
        licenseTier: licenseTier
    });
});

// Get QR code as base64 image (clientId aware)
app.get("/api/v1/qr", (req, res) => {
    const clientId = req.query.clientId || "default";
    const clientInfo = clients.get(clientId);

    if (clientInfo && clientInfo.qrCodeBase64) {
        res.json({
            qr: clientInfo.qrCodeBase64,
            available: true
        });
    } else {
        res.json({
            qr: null,
            available: false
        });
    }
});

// Debug: Take screenshot of all client browsers
app.get("/api/v1/debug-screenshot", async (req, res) => {
    try {
        const results = [];
        for (const [clientId, info] of clients.entries()) {
            if (info.client && info.client.pupPage) {
                const imgPath = path.join(appDir, `screenshot-${clientId}.png`);
                await info.client.pupPage.screenshot({ path: imgPath });

                let wwebjsDefined = false;
                let pageUrl = "";
                let hasSyncedVal = null;
                let connSerialized = null;
                try {
                    wwebjsDefined = await info.client.pupPage.evaluate(() => typeof window.WWebJS !== 'undefined');
                    pageUrl = info.client.pupPage.url();
                    hasSyncedVal = await info.client.pupPage.evaluate(() => {
                        try {
                            return window.require('WAWebSocketModel').Socket.hasSynced;
                        } catch (e) {
                            return "Error: " + e.message;
                        }
                    });
                    connSerialized = await info.client.pupPage.evaluate(() => {
                        try {
                            return {
                                success: true,
                                data: {
                                    ...window.require('WAWebConnModel').Conn.serialize(),
                                    wid: window.require('WAWebUserPrefsMeUser').getMaybeMePnUser() ||
                                        window.require('WAWebUserPrefsMeUser').getMaybeMeLidUser()
                                }
                            };
                        } catch (e) {
                            return { success: false, error: e.message, stack: e.stack };
                        }
                    });
                } catch (err) {
                    wwebjsDefined = "Error: " + err.message;
                }

                results.push({
                    clientId,
                    path: imgPath,
                    url: pageUrl,
                    wwebjsDefined,
                    hasSynced: hasSyncedVal,
                    connSerialized
                });
            }
        }
        res.json({ success: true, results });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Get list of all WhatsApp clients/connections
app.get("/api/v1/clients", (req, res) => {
    const list = [];
    for (const [clientId, info] of clients.entries()) {
        const isReady = info.isReady || info.status === 'ready';
        const resolvedNumber = isReady ? (info.number || (info.client && info.client.info && info.client.info.wid ? info.client.info.wid.user : null)) : null;
        const resolvedPort = clientPorts.get(clientId) || (clientId === 'default' ? port : null);
        list.push({
            id: clientId,
            name: info.name,
            status: isReady ? 'ready' : info.status,
            number: resolvedNumber,
            ready: isReady,
            port: resolvedPort,
            pairingCode: info.pairingCode
        });
    }
    res.json({ success: true, clients: list });
});

// Add/Create a new WhatsApp client connection
app.post("/api/v1/clients/add", (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: "Connection name is required" });
        }

        const clientId = `client_${Date.now()}`;

        // Assign a dedicated port for this new account
        const assignedPort = getNextAvailablePort();
        clientPorts.set(clientId, assignedPort);
        saveClientPorts();

        const info = getOrCreateClient(clientId, name.trim());

        // Start initialization in background
        info.client.initialize().catch(err => {
            console.error(`Error initializing new client ${clientId}:`, err.message);
            info.status = "disconnected";
        });

        // Start the per-account sub-server immediately
        startClientSubServer(clientId);

        info.status = "authenticating";
        addLog("info", `New WhatsApp client '${info.name}' created on port ${assignedPort}`);

        res.json({
            success: true,
            client: {
                id: clientId,
                name: info.name,
                status: info.status,
                ready: info.isReady,
                port: assignedPort
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Request pairing code for a client
app.post("/api/v1/clients/pairing-code", async (req, res) => {
    try {
        const { clientId, phoneNumber } = req.body;
        if (!clientId) {
            return res.status(400).json({ success: false, error: "Client ID is required" });
        }
        if (!phoneNumber) {
            return res.status(400).json({ success: false, error: "Phone number is required" });
        }

        const info = clients.get(clientId);
        if (!info) {
            return res.status(404).json({ success: false, error: "Client not found" });
        }

        if (info.isReady) {
            return res.status(400).json({ success: false, error: "Client is already connected" });
        }

        // Format phone number
        const formatted = formatMobileNumber(phoneNumber);
        if (!formatted) {
            return res.status(400).json({ success: false, error: "Invalid phone number format. Must include country code, e.g. 919876543210" });
        }

        console.log(`🔑 Requesting pairing code for client [${info.name}] using number ${formatted}...`);
        addLog("info", `Requesting pairing code for client [${info.name}] using number +${formatted}`);

        // Clear QR code states
        info.qrCodeBase64 = null;
        info.qrCodeData = null;
        info.status = "authenticating";

        // requestPairingCode returns the code
        const code = await info.client.requestPairingCode(formatted);
        info.pairingCode = code;

        addLog("success", `Pairing code generated for client [${info.name}]: ${code}`);
        res.json({ success: true, code: code });
    } catch (e) {
        console.error("Error requesting pairing code:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Get queue status
app.get("/api/v1/queue", (req, res) => {
    res.json({
        length: messageQueue.length,
        processing: processing,
        paused: queuePaused,
        pending: messageQueue.filter(j => j.status === 'pending' || !j.status).length,
        failed: messageQueue.filter(j => j.status === 'failed').length,
        queue: messageQueue.map(job => ({
            id: job.id || `${job.number}_${job.createdAt || Date.now()}`,
            number: job.number,
            message: job.message ? (job.message.length > 50 ? job.message.substring(0, 50) + "..." : job.message) : "",
            hasFile: !!job.filePath,
            fileName: job.filePath ? path.basename(job.filePath) : null,
            status: job.status || 'pending',
            createdAt: job.createdAt,
            failedAt: job.failedAt,
            error: job.error,
            retryCount: job.retryCount || 0
        }))
    });
});

// ======================
// BUSY ADDON INTEGRATION
// ======================

// 1. Helper to add job to queue from Service
function addBusyJobToQueue(data) {
    const job = {
        id: `BUSY_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        number: data.number,
        message: data.message,
        filePath: data.filePath,
        status: 'pending',
        createdAt: new Date().toISOString(),
        retryCount: 0,
        isPriority: false
    };
    messageQueue.push(job);
    saveQueue(messageQueue);
    processQueue(); // Trigger processing
}

// 2. Scheduler
let busyCronJobs = {}; // Map of firmId -> cronJob

function initBusyScheduler() {
    console.log("🔄 Initializing Multi-Firm Scheduler...");

    // Stop all existing jobs
    Object.values(busyCronJobs).forEach(job => job.stop());
    busyCronJobs = {};

    try {
        const firms = BusyService.getFirms();
        firms.forEach(firm => {
            // General Reminders Schedule
            if (firm.scheduleEnabled !== false && firm.scheduleCron) {
                console.log(`⏰ [${firm.name}] Scheduler: Enabled at "${firm.scheduleCron}"`);
                const job = cron.schedule(firm.scheduleCron, () => {
                    addLog("info", `⏰ Scheduled Job: Triggering Reminders for [${firm.name}]`);
                    BusyService.runBulkReminders(firm, (type, msg, data) => {
                        if (type === 'queue_job') {
                            addBusyJobToQueue(data);
                        } else {
                            addLog(type, msg, data);
                        }
                    });
                });
                busyCronJobs[firm.id] = job;
            } else {
                console.log(`⏰ [${firm.name}] Scheduler: Disabled`);
            }

            // PDC Alerts Schedule
            if (firm.pdcEnabled === true && firm.pdcTime) {
                const [hh, mm] = firm.pdcTime.split(':').map(Number);
                const pdcCron = `0 ${mm} ${hh} * * *`;
                console.log(`🏦 [${firm.name}] PDC Scheduler: Enabled at "${pdcCron}"`);
                const pdcJob = cron.schedule(pdcCron, () => {
                    addLog("info", `🏦 Scheduled Job: Triggering PDC Alerts for [${firm.name}]`);
                    BusyService.runPdcReminders(firm, (type, msg, data) => {
                        if (type === 'queue_job') {
                            addBusyJobToQueue(data);
                        } else {
                            addLog(type, msg, data);
                        }
                    });
                });
                busyCronJobs[firm.id + "_pdc"] = pdcJob;
            }
        });
    } catch (e) {
        console.error("Failed to init Multi-Firm Scheduler:", e.message);
    }
}

// Initial call
initBusyScheduler();

// License Tier Check Middleware for Busy Routes
app.use("/api/busy", async (req, res, next) => {
    let licenseTier = 'basic';
    try {
        const validation = await checkLicense();
        if (validation.valid) {
            licenseTier = validation.tier || 'basic';
        }
    } catch (e) {
        console.error("Error checking license in busy middleware:", e);
    }

    if (licenseTier.toLowerCase() !== 'pro' && licenseTier.toLowerCase() !== 'premium') {
        return res.status(403).json({ error: "Access Denied: Pro license required for this feature." });
    }
    next();
});

// 3. Trigger Endpoint
app.post("/api/busy/trigger", (req, res) => {
    const firmId = req.body.firmId || req.query.firmId;
    const firm = BusyService.getFirms().find(f => f.id === firmId);
    if (!firm) return res.status(404).json({ error: "Firm not found" });

    addLog("info", `Manual Trigger: Busy Payment Reminders for [${firm.name}]`);

    // Run in background
    BusyService.runBulkReminders(firm, (type, msg, data) => {
        if (type === 'queue_job') {
            addBusyJobToQueue(data);
        } else {
            addLog(type, msg, data);
        }
    });

    res.json({ success: true, message: `Bulk process for [${firm.name}] started.` });
});

// PDC Trigger Endpoint
app.post("/api/busy/trigger-pdc", async (req, res) => {
    const firmId = req.body.firmId || req.query.firmId;
    const firm = BusyService.getFirms().find(f => f.id === firmId);
    if (!firm) return res.status(404).json({ error: "Firm not found" });

    addLog("info", `Manual Trigger: PDC Alerts for [${firm.name}]`);

    try {
        const result = await BusyService.runPdcReminders(firm, (type, msg, data) => {
            if (type === 'queue_job') {
                addBusyJobToQueue(data);
            } else {
                addLog(type, msg, data);
            }
        });
        res.json({ success: true, chequesFound: result.chequesFound, messagesSent: result.messagesSent });
    } catch (e) {
        addLog("error", `PDC Alert Trigger Failed for [${firm.name}]`, { error: e.message });
        res.status(500).json({ success: false, error: e.message });
    }
});

// 4. Scan Only Endpoint
app.get("/api/busy/scan", async (req, res) => {
    const firmId = req.query.firmId || req.body.firmId;
    const firm = BusyService.getFirms().find(f => f.id === firmId);
    if (!firm) return res.status(404).json({ error: "Firm not found" });

    try {
        addLog("info", `Starting Scan Request for [${firm.name}]...`);
        const results = await BusyService.scanAndPreview(firm);
        addLog("success", `Scan Complete for [${firm.name}]. Found ${results.length} debtors.`);
        res.json({ success: true, results: results });
    } catch (e) {
        addLog("error", `Scan Failed for [${firm.name}]`, { error: e.message });
        res.status(500).json({ success: false, error: e.message });
    }
});

// 5. Config Endpoints
app.get("/api/busy/config", (req, res) => {
    res.json(BusyService.getConfig());
});

app.post("/api/busy/config", (req, res) => {
    // This allows updating global settings or specific firms if needed
    // However, usually we update specific firms via specialized endpoints
    res.json({ success: true });
});

// ======================
// Helper: Get Config via Service
// ======================
app.get("/api/busy/firms", (req, res) => {
    try {
        const config = BusyService.getConfig();
        console.log(`📡 GET /api/busy/firms requested. Returning ${config.firms ? config.firms.length : 0} firms.`);
        res.json({ success: true, firms: config.firms || [] });
    } catch (e) {
        console.error("GET /firms Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/busy/hierarchy", async (req, res) => {
    try {
        const { firmId, parentGroup } = req.body; // parentGroup can be name "Sundry Debtors" or Code
        const config = BusyService.getConfig();
        const firm = config.firms.find(f => f.id === firmId);

        if (!firm) return res.status(404).json({ success: false, error: "Firm not found" });

        const data = await BusyService.getHierarchy(firm, parentGroup);
        res.json({ success: true, ...data });
    } catch (e) {
        console.error("Get Hierarchy Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Helper: Get Accounts for Selection (Bypassing specificParties filter)
app.post("/api/busy/accounts", async (req, res) => {
    try {
        const { firmId, targetGroup } = req.body;
        const config = BusyService.getConfig();
        const firm = config.firms.find(f => f.id === firmId);

        if (!firm) return res.status(404).json({ success: false, error: "Firm not found" });

        // Create a mock firm object that mimics the real one but overrides the group 
        // and clears specificParties so we get the FULL list.
        const mockFirm = {
            ...firm,
            targetGroup: targetGroup || firm.targetGroup,
            specificParties: null // FORCE NULL to get all accounts
        };

        const accounts = await BusyService.getTargetAccounts(mockFirm);
        res.json({ success: true, accounts });
    } catch (e) {
        console.error("Get Accounts Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Fetch Material Centers Endpoint
app.post("/api/busy/material-centers", async (req, res) => {
    try {
        const { firmId, dbPath, dbPassword, dbType } = req.body;
        const config = BusyService.getConfig();
        const firm = config.firms?.find(f => f.id === firmId) || { dbPath, dbPassword, dbType };
        const centers = await BusyService.getMaterialCenters(firm);
        res.json({ success: true, materialCenters: centers });
    } catch (e) {
        console.error("Get Material Centers Error:", e);
        res.json({ success: false, error: e.message, materialCenters: [] });
    }
});

// Create/Update/Delete Firms
app.post("/api/busy/firms/add", (req, res) => {
    const firm = BusyService.addFirm();
    res.json({ success: true, firm: firm });
});

app.post("/api/busy/firms/update", (req, res) => {
    const { id, data } = req.body;
    if (BusyService.updateFirm(id, data)) {
        initBusyScheduler(); // Restart schedules
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Firm not found" });
    }
});

app.post("/api/busy/firms/delete", (req, res) => {
    const { id } = req.body;
    if (BusyService.deleteFirm(id)) {
        initBusyScheduler();
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Firm not found" });
    }
});

// 6. Resolve Path Endpoint
app.get("/api/busy/resolve-path", async (req, res) => {
    const firmId = req.query.firmId || req.body.firmId;
    const firm = BusyService.getFirms().find(f => f.id === firmId);
    if (!firm) return res.status(404).json({ error: "Firm not found" });

    try {
        const path = await BusyService.resolvePath(firm);
        res.json({ path: path });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 7. Get Company Info Endpoint
app.get("/api/busy/company-info", async (req, res) => {
    const firmId = req.query.firmId || req.body.firmId;
    const firm = BusyService.getFirms().find(f => f.id === firmId);
    if (!firm) return res.status(404).json({ error: "Firm not found" });

    try {
        const info = await BusyService.getCompanyProfile(firm);
        res.json({ success: true, info: info });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 8. Get Closing Stock Endpoint
app.get("/api/busy/closing-stock", async (req, res) => {
    const firmId = req.query.firmId || req.body.firmId;
    const search = req.query.search || "";
    const config = BusyService.getConfig();
    const firm = config.firms.find(f => f.id === firmId) || config.firms[0];
    if (!firm) return res.status(404).json({ success: false, error: "No configured BUSY firm found" });

    try {
        const stockItems = await BusyService.getClosingStock(firm, search);
        res.json({ success: true, firmName: firm.name, count: stockItems.length, items: stockItems });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin Only: Batch-wise Closing Stock
app.get("/api/busy/batch-closing-stock", async (req, res) => {
    // 1. Check Admin Auth
    const authHeader = req.headers['authorization'];
    let isAdmin = false;
    if (authHeader) {
        try {
            const token = authHeader.replace('Bearer ', '').trim();
            const usersPath = path.join(appDir, "users.json");
            if (fs.existsSync(usersPath)) {
                const users = JSON.parse(fs.readFileSync(usersPath, "utf8"));
                if (users.admin && users.admin.salt && users.admin.hash) {
                    const hash = crypto.pbkdf2Sync(token, users.admin.salt, 1000, 64, 'sha512').toString('hex');
                    if (hash === users.admin.hash) isAdmin = true;
                }
            }
        } catch (e) {
            console.error("Auth error:", e);
        }
    }

    if (!isAdmin) {
        return res.status(401).json({ success: false, error: "Admin access required. Provide valid password in Authorization header." });
    }

    // 2. Process Request
    const firmId = req.query.firmId || req.body.firmId;
    const search = req.query.search || "";
    const config = BusyService.getConfig();
    const firm = config.firms.find(f => f.id === firmId) || config.firms[0];
    if (!firm) return res.status(404).json({ success: false, error: "No configured BUSY firm found" });

    try {
        const stockItems = await BusyService.getBatchClosingStock(firm, search);
        res.json({ success: true, firmName: firm.name, count: stockItems.length, items: stockItems });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});


// API for UI: Batch-wise Closing Stock
app.post("/api/busy/batch-stock-ui", async (req, res) => {
    try {
        const { firmId, mcFilters } = req.body;
        const config = BusyService.getConfig();
        const firm = config.firms.find(f => f.id === firmId);
        if (!firm) return res.status(404).json({ success: false, error: "Firm not found" });

        const stockItems = await BusyService.getBatchClosingStock(firm, mcFilters);
        res.json({ success: true, count: stockItems.length, items: stockItems });
    } catch (e) {
        console.error("batch-stock-ui Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// API for UI: Generate Batch Stock PDF
app.post("/api/busy/batch-stock-pdf", async (req, res) => {
    try {
        const { firmId, mcFilters } = req.body;
        const config = BusyService.getConfig();
        const firm = config.firms.find(f => f.id === firmId);
        if (!firm) return res.status(404).json({ success: false, error: "Firm not found" });

        const stockItems = await BusyService.getBatchClosingStock(firm, mcFilters);

        let companyProfile = null;
        try {
            companyProfile = await BusyService.getCompanyProfile(firm);
        } catch (e) { }

        const pdfPath = await BusyService.generateBatchStockPdf(firm, stockItems, companyProfile);
        if (pdfPath && require('fs').existsSync(pdfPath)) {
            res.download(pdfPath, 'Batch_Stock_Report.pdf');
        } else {
            res.status(500).json({ success: false, error: "PDF generation failed" });
        }
    } catch (e) {
        console.error("batch-stock-pdf Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});


// Fetch accounts for selection
app.post("/api/busy/accounts", async (req, res) => {
    try {
        const { firmId, targetGroup } = req.body;
        const config = BusyService.getConfig();
        const firm = config.firms.find(f => f.id === firmId);

        if (!firm) {
            return res.status(404).json({ success: false, error: "Firm not found" });
        }

        // Mock firm to bypass specificParties filtering and/or use overridden targetGroup
        const queryFirm = { ...firm, targetGroup: targetGroup || firm.targetGroup, specificParties: null };

        const accounts = await BusyService.getTargetAccounts(queryFirm);
        res.json({ success: true, accounts });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});


// Pause queue
app.post("/api/v1/queue/pause", (req, res) => {
    try {
        queuePaused = true;
        addLog("info", "Message queue paused");
        res.json({
            success: true,
            message: "Queue paused successfully",
            paused: true
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Resume/Restart queue
app.post("/api/v1/queue/resume", (req, res) => {
    try {
        queuePaused = false;
        addLog("info", "Message queue resumed");
        // Restart processing if there are pending messages
        processQueue();
        res.json({
            success: true,
            message: "Queue resumed successfully",
            paused: false
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Resend failed message
app.post("/api/v1/resend", async (req, res) => {
    try {
        const { id, number } = req.body;

        if (!id && !number) {
            return res.status(400).json({
                success: false,
                error: 'Message ID or number is required'
            });
        }

        // Find the job
        let jobIndex = -1;
        if (id) {
            jobIndex = messageQueue.findIndex(job => (job.id || job.number + '_' + (job.createdAt || Date.now())) === id);
        } else {
            // Find last failed job for this number
            for (let i = messageQueue.length - 1; i >= 0; i--) {
                if (messageQueue[i].number === number && messageQueue[i].status === 'failed') {
                    jobIndex = i;
                    break;
                }
            }
        }

        if (jobIndex === -1) {
            return res.status(404).json({
                success: false,
                error: 'Message not found in queue'
            });
        }

        const job = messageQueue[jobIndex];

        if (job.status !== 'failed') {
            return res.status(400).json({
                success: false,
                error: 'Message is not in failed state'
            });
        }

        // Reset job status to pending
        job.status = 'pending';
        job.error = undefined;
        job.failedAt = undefined;
        saveQueue(messageQueue);

        addLog("info", `Message queued for resend`, { number: job.number, retryCount: job.retryCount });

        // Process queue
        processQueue();

        res.json({
            success: true,
            message: 'Message queued for resend',
            retryCount: job.retryCount
        });
    } catch (error) {
        console.error("Error resending message:", error);
        addLog("error", "Failed to resend message", { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Clear queue endpoint
app.post("/api/v1/queue/clear", (req, res) => {
    try {
        const { clearFailed, clearSent, clearAll } = req.body;

        let clearedCount = 0;

        if (clearAll) {
            // Clear everything
            clearedCount = messageQueue.length;
            messageQueue = [];
        } else if (clearFailed) {
            // Clear only failed messages
            messageQueue = messageQueue.filter(job => {
                if (job.status === 'failed') {
                    clearedCount++;
                    return false;
                }
                return true;
            });
        } else if (clearSent) {
            // Clear only sent messages
            messageQueue = messageQueue.filter(job => {
                if (job.status === 'sent') {
                    clearedCount++;
                    return false;
                }
                return true;
            });
        } else {
            // Default: clear all
            clearedCount = messageQueue.length;
            messageQueue = [];
        }

        saveQueue(messageQueue);
        addLog("info", `Queue cleared: ${clearedCount} messages removed`, {
            cleared: clearedCount,
            remaining: messageQueue.length
        });

        res.json({
            success: true,
            message: `Cleared ${clearedCount} message(s) from queue`,
            cleared: clearedCount,
            remaining: messageQueue.length
        });
    } catch (error) {
        console.error("Error clearing queue:", error);
        addLog("error", "Failed to clear queue", { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Resend all failed messages
app.post("/api/v1/resend-all", async (req, res) => {
    try {
        const failedMessages = messageQueue.filter(job => job.status === 'failed');

        if (failedMessages.length === 0) {
            return res.json({
                success: false,
                message: "No failed messages to resend"
            });
        }

        let resentCount = 0;

        for (const job of failedMessages) {
            // Reset job status to pending
            job.status = 'pending';
            job.error = undefined;
            job.failedAt = undefined;
            resentCount++;
        }

        saveQueue(messageQueue);
        addLog("info", `Resent ${resentCount} failed messages`, { count: resentCount });

        // Process queue
        processQueue();

        res.json({
            success: true,
            message: `Resent ${resentCount} failed message(s)`,
            count: resentCount
        });
    } catch (error) {
        console.error("Error resending all failed messages:", error);
        addLog("error", "Failed to resend all failed messages", { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get logs history
app.get("/api/v1/logs", (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const type = req.query.type || null;
    const search = req.query.search || null;

    let filteredLogs = [...logsHistory];

    // Filter by type if provided
    if (type) {
        filteredLogs = filteredLogs.filter(log => log.type === type);
    }

    // Filter by search term if provided
    if (search) {
        const searchLower = search.toLowerCase();
        filteredLogs = filteredLogs.filter(log =>
            log.message.toLowerCase().includes(searchLower) ||
            (log.data && JSON.stringify(log.data).toLowerCase().includes(searchLower))
        );
    }

    // Return last N logs (most recent first)
    const logs = filteredLogs.slice(-limit).reverse();

    res.json({
        total: logsHistory.length,
        filtered: filteredLogs.length,
        logs: logs
    });
});

// Clear logs history
app.post("/api/v1/logs/clear", (req, res) => {
    try {
        const previousCount = logsHistory.length;
        logsHistory = [];
        saveLogs();
        addLog("info", "Logs history cleared", { previousCount: previousCount });
        res.json({
            success: true,
            message: `Cleared ${previousCount} log entries`,
            cleared: previousCount
        });
    } catch (error) {
        console.error("Error clearing logs:", error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ======================
// License Management Endpoints
// ======================


// ======================
// Remote Configuration
// ======================
app.get("/api/v1/config", (req, res) => {
    try {
        const safeConfig = {
            license_email: config.license_email || "",
            license_server_url: config.license_server_url || ""
        };
        res.json(safeConfig);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/v1/config", (req, res) => {
    try {
        const { license_email, license_server_url } = req.body;
        if (license_email !== undefined) config.license_email = license_email;
        if (license_server_url !== undefined) config.license_server_url = license_server_url;

        fs.writeFileSync(configFile, JSON.stringify(config, null, 4));

        // Trigger an immediate license check in the background to register with Google Sheet
        checkLicense(true);

        res.json({ success: true, message: "Configuration saved successfully. Auto-registering device..." });
        addLog("info", "Remote license configuration updated - Triggering registration");
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});


// Clear session endpoint (clientId aware)
app.post("/api/v1/clear-session", (req, res) => {
    const clientId = req.body.clientId || req.query.clientId || "default";
    const clientInfo = clients.get(clientId);

    if (!clientInfo) {
        return res.status(404).json({ success: false, error: "Client connection not found" });
    }

    res.json({
        success: true,
        message: `Session clearing initiated for ${clientInfo.name}. The process runs in the background.`
    });

    // Run cleanup in background
    setTimeout(async () => {
        clientsClearingSession.add(clientId);

        try {
            addLog("info", `Clearing WhatsApp session for ${clientInfo.name}...`);

            // Logout and destroy client with timeout
            try {
                if (clientInfo.client.info) {
                    await withTimeout(clientInfo.client.logout(), 5000).catch(e => console.log("Logout timeout/error:", e.message));
                }
            } catch (err) {
                console.log("Client already logged out or not connected:", err.message);
            }

            try {
                await withTimeout(clientInfo.client.destroy(), 5000).catch(e => console.log("Destroy timeout/error:", e.message));
            } catch (err) {
                console.log("Client destroy error (may already be destroyed):", err.message);
            }

            // Wait 2 seconds for Chrome processes to release file locks on Windows
            await delay(2000);

            // Rename session folder safely (Atomic operation) instead of deleting immediately
            const sessionPath = path.join(appDir, ".wwebjs_auth", `session-${clientId}`);
            if (fs.existsSync(sessionPath)) {
                try {
                    const trashPath = path.join(appDir, ".wwebjs_auth", `session-${clientId}_trash_${Date.now()}`);
                    fs.renameSync(sessionPath, trashPath);
                    addLog("success", `WhatsApp session folder for ${clientInfo.name} moved to trash`);

                    // Try to delete trash in background, ignore errors
                    setTimeout(() => {
                        try {
                            if (typeof fs.rmSync === 'function') {
                                fs.rmSync(trashPath, { recursive: true, force: true });
                            } else {
                                fs.rmdirSync(trashPath, { recursive: true });
                            }
                        } catch (e) {
                            console.error("Could not cleanup trash folder (ignored):", e.message);
                        }
                    }, 5000);

                } catch (err) {
                    console.error("Failed to move/delete session folder:", err.message);
                    addLog("warning", `Could not clear session folder for ${clientInfo.name}`, { error: err.message });
                }
            }

            clientInfo.status = "disconnected";
            clientInfo.qrCodeBase64 = null;
            clientInfo.qrCodeData = null;
            clientInfo.number = null;
            clientInfo.isReady = false;

            // Wait a moment before reinitializing
            await delay(1000);

            // Reinitialize client
            try {
                clientInfo.client.initialize().catch(err => {
                    console.error("Client initialization error:", err);
                    clientInfo.status = "disconnected";
                    addLog("error", `Failed to reinitialize client ${clientInfo.name} async`, { error: err.message });
                });

                clientInfo.status = "authenticating";
                addLog("info", `WhatsApp client ${clientInfo.name} reinitializing...`);
            } catch (err) {
                addLog("error", `Failed to trigger client ${clientInfo.name} reinitialization`, { error: err.message });
            }
        } catch (error) {
            console.error("Error clearing session in background:", error);
            addLog("error", `Failed to clear session for ${clientInfo.name} (background)`, { error: error.message });
        } finally {
            clientsClearingSession.delete(clientId);
        }
    }, 100);
});

// Rename a WhatsApp client connection
app.post("/api/v1/clients/rename", (req, res) => {
    try {
        const { id, name } = req.body;
        if (!id || !name || !name.trim()) {
            return res.status(400).json({ success: false, error: "ID and name are required" });
        }
        if (id === "default") {
            return res.status(400).json({ success: false, error: "Cannot rename default account" });
        }

        const info = clients.get(id);
        if (!info) {
            if (!clientPorts.has(id)) {
                return res.status(404).json({ success: false, error: "Client not found" });
            }
        }

        // Save name in map and persist
        clientNames.set(id, name.trim());
        saveClientNames();

        if (info) {
            info.name = name.trim();
        }

        addLog("info", `WhatsApp connection ${id} renamed to '${name.trim()}'`);
        res.json({ success: true, message: `Connection renamed to '${name.trim()}' successfully.` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Delete a WhatsApp client session and connection
app.post("/api/v1/clients/delete", async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) return res.status(400).json({ success: false, error: "Client ID is required" });
        if (id === "default") return res.status(400).json({ success: false, error: "Cannot delete the default account" });

        const info = clients.get(id);
        if (!info) return res.status(404).json({ success: false, error: "Client not found" });

        const freedPort = clientPorts.get(id);
        addLog("info", `Deleting WhatsApp connection: ${info.name} (port ${freedPort || 'N/A'})`);

        // Prevent reconnects
        clientsClearingSession.add(id);

        try {
            if (info.client.info) {
                await withTimeout(info.client.logout(), 5000).catch(e => console.log("Logout error during delete:", e.message));
            }
        } catch (e) { }

        try {
            await withTimeout(info.client.destroy(), 5000).catch(e => console.log("Destroy error during delete:", e.message));
        } catch (e) { }

        await delay(2000);

        // Stop the dedicated sub-server for this account
        stopClientSubServer(id);

        // Free the port assignment
        clientPorts.delete(id);
        saveClientPorts();

        // Free the name assignment
        clientNames.delete(id);
        saveClientNames();

        // Delete session folder
        const sessionPath = path.join(appDir, ".wwebjs_auth", `session-${id}`);
        if (fs.existsSync(sessionPath)) {
            try {
                if (typeof fs.rmSync === 'function') {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                } else {
                    fs.rmdirSync(sessionPath, { recursive: true });
                }
            } catch (err) {
                console.error("Failed to delete session directory:", err.message);
            }
        }

        clients.delete(id);
        clientsClearingSession.delete(id);

        addLog("success", `WhatsApp connection deleted: ${info.name}${freedPort ? ` (port ${freedPort} freed)` : ''}`);
        res.json({ success: true, message: `WhatsApp connection ${info.name} deleted successfully.${freedPort ? ` Port ${freedPort} is now free.` : ''}` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ======================
// Bulk Upload from Excel
// ======================
app.post("/api/v1/bulk-upload", (req, res) => {
    let busboy;
    try {
        busboy = Busboy({ headers: req.headers });
    } catch (e) {
        console.error("Busboy init error:", e.message);
        return res.status(400).json({ success: false, error: "Invalid request (Missing Content-Type?)" });
    }
    const fields = {};
    const files = [];
    const filePromises = [];

    busboy.on("field", (name, val) => (fields[name] = val));
    busboy.on("file", (name, file, info) => {
        const filename = info?.filename || (typeof info === 'string' ? info : '');
        if (!filename) {
            file.resume();
            return;
        }
        const uploadsDir = path.join(appDir, "uploads");
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }

        const saveTo = path.join(uploadsDir, `bulk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}_${path.basename(filename)}`);

        // Create a promise to ensure file is fully written before processing
        const filePromise = new Promise((resolve, reject) => {
            const writeStream = fs.createWriteStream(saveTo);

            file.pipe(writeStream);

            // Handle file stream end
            file.on('end', () => {
                // File stream ended, wait for write stream to close
            });

            // Wait for write stream to close (file fully written)
            writeStream.on('close', () => {
                // Small delay to ensure file system has written
                setTimeout(() => {
                    // Verify file exists and has content
                    if (fs.existsSync(saveTo)) {
                        const stats = fs.statSync(saveTo);
                        if (stats.size > 0) {
                            files.push({ path: saveTo, filename, fieldName: name });
                            resolve();
                        } else {
                            reject(new Error(`File ${filename} was saved but is empty`));
                        }
                    } else {
                        reject(new Error(`File ${filename} was not saved properly`));
                    }
                }, 200); // 200ms delay to ensure file is fully written to disk
            });

            writeStream.on('error', (err) => {
                reject(new Error(`Error saving file ${filename}: ${err.message}`));
            });

            file.on('error', (err) => {
                reject(new Error(`Error reading file ${filename}: ${err.message}`));
            });
        });

        filePromises.push(filePromise);
    });

    busboy.on("finish", async () => {
        // Wait for all files to be fully written
        try {
            await Promise.all(filePromises);
        } catch (error) {
            return res.status(400).json({
                success: false,
                error: `File upload error: ${error.message}`
            });
        }
        try {
            // Find Excel file and attachment file
            const excelFile = files.find(f => f.fieldName === 'excelFile');
            const attachmentFile = files.find(f => f.fieldName === 'attachment');

            if (!excelFile) {
                return res.status(400).json({
                    success: false,
                    error: "No Excel file uploaded"
                });
            }

            const filePath = excelFile.path;

            // Verify file exists before processing
            if (!fs.existsSync(filePath)) {
                return res.status(400).json({
                    success: false,
                    error: `Excel file not found at path: ${filePath}. The file may not have been uploaded correctly. Please try again.`
                });
            }

            // Verify file is not empty
            const stats = fs.statSync(filePath);
            if (stats.size === 0) {
                return res.status(400).json({
                    success: false,
                    error: "Uploaded Excel file is empty. Please check your file and try again."
                });
            }

            const message = fields.Message || "";
            const fileAttachment = attachmentFile && fs.existsSync(attachmentFile.path) ? attachmentFile.path : null;

            // Read and parse Excel file
            let workbook;
            try {
                workbook = XLSX.readFile(filePath);
            } catch (err) {
                return res.status(400).json({
                    success: false,
                    error: `Failed to read Excel file: ${err.message}. Please ensure the file is a valid Excel file (.xlsx or .xls).`
                });
            }

            if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: "Excel file has no sheets. Please ensure your Excel file contains at least one sheet with data."
                });
            }

            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];

            if (!worksheet || !worksheet['!ref']) {
                return res.status(400).json({
                    success: false,
                    error: "Excel sheet is empty or has no data."
                });
            }

            // Convert to JSON - use defval to handle empty cells and blankrows to skip empty rows
            const data = XLSX.utils.sheet_to_json(worksheet, {
                defval: '',
                blankrows: false,
                raw: false
            });

            // Check if we have any data rows (not just headers)
            if (!data || data.length === 0) {
                // Try to check if there are any rows in the sheet
                const range = XLSX.utils.decode_range(worksheet['!ref']);
                const rowCount = range.e.r - range.s.r;

                if (rowCount <= 0) {
                    return res.status(400).json({
                        success: false,
                        error: "Excel file is empty or has no data rows. Please ensure your Excel file has at least one row of data after the header row."
                    });
                }

                // If we have rows but no JSON data, the headers might be missing or wrong
                return res.status(400).json({
                    success: false,
                    error: "Excel file has rows but no valid data. Please check that your Excel file has proper column headers (Mobile, Phone, or Number) and at least one data row with values."
                });
            }

            // Helper function to format mobile number
            const formatMobileNumber = (mobile) => {
                if (!mobile) return null;
                const cleaned = String(mobile).replace(/\D/g, '');
                if (cleaned.length < 10) return null;
                if (cleaned.startsWith('91')) return cleaned;
                return '91' + cleaned;
            };

            // Extract phone numbers from Excel
            // Try common column names: Mobile, Phone, Number, PhoneNumber, etc.
            const phoneColumns = ['Mobile', 'Phone', 'Number', 'PhoneNumber', 'Contact', 'mobile', 'phone', 'number', 'Mob', 'mob'];
            let phoneColumn = null;

            // Check first row for column names
            if (!data[0] || Object.keys(data[0]).length === 0) {
                return res.status(400).json({
                    success: false,
                    error: "Excel file has no column headers. Please add column headers including 'Mobile', 'Phone', or 'Number'."
                });
            }

            // Try to find mobile column with various name variations (case-insensitive)
            const firstRowKeys = Object.keys(data[0]);
            for (const col of phoneColumns) {
                const foundKey = firstRowKeys.find(key =>
                    key.toLowerCase().trim() === col.toLowerCase().trim() ||
                    key.toLowerCase().trim().includes(col.toLowerCase().trim())
                );
                if (foundKey) {
                    phoneColumn = foundKey;
                    break;
                }
            }

            // If no standard column found, use first column as fallback
            if (!phoneColumn && firstRowKeys.length > 0) {
                phoneColumn = firstRowKeys[0];
                addLog("info", `Using first column '${phoneColumn}' as mobile number column`);
            }

            if (!phoneColumn) {
                const availableColumns = firstRowKeys.join(', ');
                return res.status(400).json({
                    success: false,
                    error: `Could not find phone number column in Excel file. Please ensure your Excel has a column named 'Mobile', 'Phone', or 'Number'. Available columns: ${availableColumns}`
                });
            }

            // Process each row
            const results = {
                total: data.length,
                success: 0,
                failed: 0,
                errors: []
            };

            for (let i = 0; i < data.length; i++) {
                const row = data[i];
                const rowNumber = i + 2; // +2 because Excel rows start at 1 and we have header

                // Get mobile number from the identified column
                const rawMobile = row[phoneColumn];

                // Skip empty rows
                if (rawMobile === undefined || rawMobile === null || rawMobile === '' || String(rawMobile).trim() === '') {
                    results.failed++;
                    results.errors.push({
                        row: rowNumber,
                        number: "N/A",
                        error: "Empty cell"
                    });
                    continue;
                }

                const mobileNumber = formatMobileNumber(rawMobile);

                if (!mobileNumber) {
                    results.failed++;
                    results.errors.push({
                        row: rowNumber,
                        number: String(rawMobile),
                        error: "Invalid mobile number format"
                    });
                    continue;
                }

                // Add job to queue
                const job = {
                    id: `${mobileNumber}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    number: mobileNumber,
                    message: message,
                    filePath: fileAttachment,
                    status: 'pending',
                    createdAt: new Date().toISOString(),
                    retryCount: 0,
                    bulkUpload: true,
                    rowNumber: i + 2
                };

                messageQueue.push(job);
                results.success++;
            }

            saveQueue(messageQueue);
            addLog("queue", `Bulk upload: ${results.success} messages queued from Excel`, {
                total: results.total,
                success: results.success,
                failed: results.failed
            });

            // Delete uploaded Excel file after processing
            try {
                fs.unlinkSync(filePath);
            } catch (err) {
                console.log("Could not delete Excel file:", err.message);
            }

            // Check if any messages were successfully queued
            if (results.success === 0) {
                return res.status(400).json({
                    success: false,
                    error: `No valid mobile numbers found in Excel file. ${results.failed} row(s) failed. ${results.errors.length > 0 ? 'First few errors: ' + results.errors.slice(0, 3).map(e => `Row ${e.row}: ${e.error}`).join(', ') : ''}`,
                    results: results
                });
            }

            // Start processing queue
            processQueue();

            res.json({
                success: true,
                message: `Bulk upload completed: ${results.success} messages queued, ${results.failed} failed`,
                results: results
            });

        } catch (error) {
            console.error("Error processing bulk upload:", error);
            addLog("error", "Bulk upload failed", { error: error.message });
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    busboy.on("error", (err) => {
        console.error("Busboy error:", err);
        addLog("error", "File upload error", { error: err.message });
        res.status(500).json({
            success: false,
            error: `File upload error: ${err.message}`
        });
    });

    req.pipe(busboy);
});

// Unified send endpoint
app.all("/api/v1/send", (req, res) => {
    // Debug log for troubleshooting external integrations (BUSY, etc.)
    const debugData = {
        method: req.method,
        url: req.originalUrl, // Crucial for seeing the raw query string
        query: req.query,
        body: req.body,
        contentType: req.headers['content-type']
    };
    console.log("📥 Incoming API request:", JSON.stringify(debugData));

    const addJobToQueue = (number, message, filePath, whatsappClientId = "default") => {
        // Deduplicate based on number and message content ONLY
        const dedupeKey = `${number}:${message}`;
        const now = Date.now();

        if (recentRequests.has(dedupeKey)) {
            const lastTime = recentRequests.get(dedupeKey);
            if (now - lastTime < RECENT_REQUEST_WINDOW) {
                console.log(`🛡️ [${new Date().toLocaleTimeString()}] Ignored duplicate request for: ${number}`);

                // CRITICAL FIX: If a file was uploaded for this duplicate request, DELETE IT immediately
                // to prevent "_01", "_02" copies from piling up in the uploads folder.
                if (filePath && fs.existsSync(filePath)) {
                    try {
                        fs.unlinkSync(filePath);
                        console.log(`🧹 Deleted duplicate file upload: ${path.basename(filePath)}`);
                    } catch (err) {
                        console.error("Failed to delete duplicate file:", err.message);
                    }
                }

                return res.json({ success: true, message: "Duplicate request ignored (Deduplicated)", to: number });
            }
        }
        recentRequests.set(dedupeKey, now);

        // Cleanup old cache entries
        if (recentRequests.size > 200) {
            for (let [key, time] of recentRequests) {
                if (now - time > RECENT_REQUEST_WINDOW) recentRequests.delete(key);
            }
        }

        const mobileNumber = formatMobileNumber(number);
        if (!mobileNumber) {
            return res.status(400).json({
                success: false,
                error: 'Invalid mobile number'
            });
        }

        const job = {
            id: `${mobileNumber}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            number: mobileNumber,
            message,
            filePath,
            whatsappClientId: whatsappClientId || "default",
            status: 'pending',
            createdAt: new Date().toISOString(),
            retryCount: 0,
            isPriority: true // Mark as priority
        };

        // Single messages: Add to FRONT of queue for instant sending
        messageQueue.unshift(job);
        saveQueue(messageQueue);

        console.log(`⚡ [INSTANT] Priority message added to start of queue: ${job.id}`);
        addLog("queue", `Priority message queued for ${mobileNumber} (Job: ${job.id.split('_').pop()})`, { number: mobileNumber, hasFile: !!filePath, id: job.id, priority: true });

        // Force trigger queue immediately
        processQueue();
        res.json({ success: true, queued: true, to: mobileNumber, id: job.id });
    };

    if (req.is("multipart/form-data")) {
        let busboy;
        try {
            busboy = Busboy({ headers: req.headers });
        } catch (e) {
            console.error("Busboy init error:", e.message);
            return res.status(400).json({ success: false, error: "Invalid request headers" });
        }
        const fields = {};
        const files = [];

        busboy.on("field", (name, val) => {
            if (name === 'undefined' || !name) return; // Skip junk fields
            fields[name] = val;
            console.log(`📝 Received Field: [${name}] = [${val}]`);
        });
        busboy.on("file", (name, file, info) => {
            const filename = info?.filename || (typeof info === 'string' ? info : '');
            if (!filename) {
                file.resume();
                return;
            }
            console.log(`📁 Received File: [${name}] (${filename})`);
            const uploadsDir = path.join(appDir, "uploads");
            if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

            // Unique naming logic to preserve original filename for recipient
            let baseName = path.parse(filename).name;
            let ext = path.parse(filename).ext;
            let saveTo = path.join(uploadsDir, filename);
            let counter = 1;

            while (fs.existsSync(saveTo)) {
                const newName = `${baseName}_${String(counter).padStart(2, "0")}${ext}`;
                saveTo = path.join(uploadsDir, newName);
                counter++;
            }

            file.pipe(fs.createWriteStream(saveTo));
            files.push({ path: saveTo });
        });

        busboy.on("finish", () => {
            const findField = (names) => {
                for (let n of names) {
                    const foundKey = Object.keys(fields).find(k => k.toLowerCase() === n.toLowerCase());
                    if (foundKey) return fields[foundKey];
                }
                return null;
            };

            const mobile = findField(['Mobile', 'mobile', 'number', 'phone']);
            const message = findField(['Message', 'message', 'msg', 'text']) || "";
            const whatsappClientId = findField(['whatsappClientId', 'clientId', 'whatsapp_client_id']) || "default";
            const filePath = files.length > 0 ? files[0].path : null;
            addJobToQueue(mobile, message, filePath, whatsappClientId);
        });

        req.pipe(busboy);
    } else {
        // Diagnostic logs for non-multipart requests
        console.log("🔍 [Non-Multipart] Query:", JSON.stringify(req.query));
        console.log("🔍 [Non-Multipart] Body:", JSON.stringify(req.body));

        // SMART DETECTION: If standard keys are missing, scan ALL keys and values
        let mobile = req.query.Mobile || req.query.mobile || req.query.number || req.query.phone || req.body.Mobile || req.body.mobile || req.body.number || req.body.phone;
        let message = req.query.Message || req.query.message || req.query.msg || req.query.text || req.body.Message || req.body.message || req.body.msg || req.body.text || "";
        const filePath = req.query.pdfPath || req.query.filePath || req.query.attachment || req.query.file || req.query.pdf ||
            req.body.pdfPath || req.body.filePath || req.body.attachment || req.body.file || req.body.pdf || null;
        const whatsappClientId = req.query.whatsappClientId || req.query.clientId || req.body.whatsappClientId || req.body.clientId || "default";

        if (!mobile || !message) {
            const allParams = { ...req.query, ...req.body };
            for (let [key, val] of Object.entries(allParams)) {
                // Ignore empty keys/vals
                if (!key || !val) continue;

                // 1. Detect Mobile Number (Look for 10+ digits in key or value)
                if (!mobile) {
                    const cleanKey = String(key).replace(/\D/g, '');
                    const cleanVal = String(val).replace(/\D/g, '');
                    if (cleanKey.length >= 10) mobile = cleanKey;
                    else if (cleanVal.length >= 10) mobile = cleanVal;
                }

                // 2. Detect Message Content (Look for spaces or typical "Dear" text)
                if (!message) {
                    const strKey = String(key);
                    const strVal = String(val);
                    if (strKey.includes(' ') || strKey.includes('Dear')) message = strKey;
                    else if (strVal.includes(' ') || strVal.includes('Dear')) message = strVal;
                }
            }
        }

        // "API is online" check: ONLY if it's literally just the URL with NO question mark
        if (req.method === "GET" && !req.originalUrl.includes("?") && !mobile) {
            return res.json({ success: true, message: "WhatsApp API is online" });
        }

        // Troubleshooting: If mobile is missing but there was a query string
        if (!mobile && (req.originalUrl.includes("?") || Object.keys(req.body).length > 0)) {
            console.warn(`⚠️ [Warning] API received a SEND request but no MOBILE number was found.`);
            console.warn(`👉 Please check your BUSY "Parameter Name" and "Parameter Value" settings.`);
            return res.status(400).json({
                success: false,
                error: "Mobile number parameter is missing in your request."
            });
        }

        addJobToQueue(mobile, message, filePath, whatsappClientId);
    }
});

// ======================
// Auto cleanup old uploads
// ======================
app.get("/api/payment-config", (req, res) => {
    try {
        const firmId = req.query.firmId;
        const configPath = path.join(appDir, "busy_config.json");
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const firm = (firmId ? config.firms.find(f => f.id === firmId) : null) || config.firms[0];
            const p = firm ? (firm.paymentDetails || {}) : {};
            res.json({ success: true, paymentDetails: p });
        } else {
            res.json({ success: false, error: "Config not found" });
        }
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post("/api/payment-config", (req, res) => {
    const busboy = require('busboy')({ headers: req.headers });
    let paymentData = {};
    let qrCodePath = null;

    busboy.on('field', (fieldname, val) => {
        paymentData[fieldname] = val;
    });

    busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
        const fname = typeof filename === 'object' && filename ? (filename.filename || '') : (filename || '');
        if (!fname) {
            file.resume();
            return;
        }
        const uploadsDir = path.join(appDir, 'uploads');
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }
        const saveTo = path.join(uploadsDir, `qr_${Date.now()}_${path.basename(fname)}`);
        file.pipe(fs.createWriteStream(saveTo));
        qrCodePath = saveTo;
    });

    busboy.on('finish', async () => {
        try {
            const configPath = path.join(appDir, "busy_config.json");
            if (fs.existsSync(configPath)) {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                const firmId = paymentData.firmId;
                const firm = (firmId ? config.firms.find(f => f.id === firmId) : null) || config.firms[0];
                
                if (!firm) {
                    return res.json({ success: false, error: "Firm not found" });
                }

                if (!firm.paymentDetails) firm.paymentDetails = {};
                
                Object.assign(firm.paymentDetails, paymentData);
                if (qrCodePath) {
                    firm.paymentDetails.qrCodePath = qrCodePath;
                } else if (paymentData.upiId) {
                    // Auto-generate QR code if UPI ID is present and no file was uploaded
                    const upiUri = `upi://pay?pa=${paymentData.upiId}&pn=${paymentData.accountName || 'Merchant'}`;
                    const generatedQrPath = path.join(appDir, 'uploads', `qr_gen_${Date.now()}.png`);
                    if (!fs.existsSync(path.join(appDir, 'uploads'))) {
                        fs.mkdirSync(path.join(appDir, 'uploads'));
                    }
                    await qrcode.toFile(generatedQrPath, upiUri, { width: 400 });
                    firm.paymentDetails.qrCodePath = generatedQrPath;
                }
                
                fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                res.json({ success: true });
            } else {
                res.json({ success: false, error: "Config not found" });
            }
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });

    req.pipe(busboy);
});

setInterval(() => {
    try {
        const uploadsDir = path.join(appDir, "uploads");
        if (!fs.existsSync(uploadsDir)) return;

        const files = fs.readdirSync(uploadsDir);
        files.forEach(file => {
            try {
                const filePath = path.join(uploadsDir, file);
                const stats = fs.statSync(filePath);
                const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
                if (ageHours > 24) {
                    fs.unlinkSync(filePath);
                    console.log(`🧹 Deleted old file: ${filePath}`);
                }
            } catch (fileErr) {
                // file may be locked by another process or already removed
            }
        });
    } catch (err) {
        console.error("Error during uploads directory cleanup:", err.message);
    }
}, 1000 * 60 * 60); // run every 1 hour

// ======================
// Start Server
// ======================
async function startServer() {
    // Check license but don't exit if invalid - allow server to start
    const licenseCheck = await checkLicense();

    if (!licenseCheck.valid && !licenseCheck.warning) {
        // Only warn if license is expired (not just missing)
        if (licenseCheck.expired) {
            console.log("❌ License expired. Please activate a new license key.");
            console.log("💡 You can activate a license via the web interface once the server starts.");
            // Don't exit - allow server to start so user can activate license
        }
    }

    addLog("info", "Server starting up");

    // License Info Endpoint (Remote Only)
    app.get("/api/v1/license/info", async (req, res) => {
        try {
            const validation = await checkLicense();

            res.json({
                success: true,
                hasLicense: validation.valid, // If valid, we have a license
                valid: validation.valid,
                error: validation.error,
                expirationDate: validation.expirationDate,
                daysRemaining: validation.daysRemaining,
                machineId: MACHINE_ID, // Return Machine ID to UI
                version: "REMOTE"
            });
        } catch (error) {
            console.error("Error getting license info:", error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    app.listen(port, () => {
        console.log(`🚀 WhatsApp Local Server running at http://localhost:${port}`);
        addLog("success", `Server started on port ${port}`);

        if (!licenseCheck.valid) {
            console.log("❌ NO LICENSE FOUND. Server running in CONFIGURATION MODE only.");
            console.log("⚠️  WhatsApp Client will NOT start until a valid license is configured.");
            console.log("💡 Go to http://localhost:5000 -> Settings to configure your Remote License.");
            addLog("error", "Server running in CONFIGURATION MODE (No License)");
            return; // EXIT setup, do not initialize client
        }

        // Initialize all WhatsApp clients after server starts
        initializeAllClients();
    });
}

// ======================
// Self-Healing Keep-Alive Monitor (24/7 Stability)
// ======================
async function reconnectClient(clientId) {
    const info = clients.get(clientId);
    if (!info) return;

    const clientName = info.name;
    const assignedPort = clientPorts.get(clientId);

    console.log(`🔄 [Self-Healing] Reconnect initiated for client '${clientName}' (${clientId})...`);
    addLog("warning", `Self-healing reconnect started for connection: ${clientName}`);

    info.status = "authenticating";
    info.isReady = false;

    try {
        await withTimeout(info.client.destroy(), 5000).catch(() => { });
    } catch (e) { }

    // Force kill orphaned Chrome processes for this session to release file locks on Windows
    try {
        const { spawn } = require('child_process');
        spawn('powershell', [
            '-Command',
            `Get-CimInstance Win32_Process -Filter "name = 'chrome.exe'" | Where-Object { $_.CommandLine -like "*session-${clientId}*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
        ], { windowsHide: true });
    } catch (e) {
        console.error("Failed to trigger force-kill for client", clientId, e.message);
    }

    setTimeout(() => {
        if (!clientsClearingSession.has(clientId)) {
            console.log(`🔄 Creating fresh WhatsApp client instance for '${clientName}' (${clientId})...`);
            clients.delete(clientId);
            const freshInfo = getOrCreateClient(clientId, clientName);
            freshInfo.status = "authenticating";
            freshInfo.client.initialize().catch(err => {
                console.error(`[Self-Healing] Re-initialization failed for ${clientId}:`, err.message);
                freshInfo.status = "disconnected";
            });
        }
    }, 2500);
}

// Check connection status of all accounts every 60 seconds
setInterval(async () => {
    // Wait if server initialization is not done yet
    if (clients.size === 0) return;

    for (const [clientId, info] of clients.entries()) {
        // Skip if client is being voluntarily logged out/deleted
        if (clientsClearingSession.has(clientId)) continue;

        if (info.status === 'ready') {
            try {
                // Ping client state to verify the Puppeteer instance is still alive and responsive
                const state = await withTimeout(info.client.getState(), 8000);
                if (state !== 'CONNECTED') {
                    console.log(`⚠️ [Self-Healing] Client '${info.name}' is in non-connected state: ${state}. Recovering...`);
                    addLog("warning", `Client '${info.name}' lost WhatsApp sync (state: ${state}). Auto-reconnecting...`);
                    reconnectClient(clientId);
                }
            } catch (err) {
                // Timeout or crash: Puppeteer browser is frozen or crashed
                console.error(`❌ [Self-Healing] Connection to client '${info.name}' is unresponsive:`, err.message);
                addLog("error", `Client '${info.name}' browser instance crashed or timed out. Force restarting session...`);
                reconnectClient(clientId);
            }
        } else if (info.status === 'disconnected') {
            // Re-initialize if disconnected unexpectedly
            console.log(`⚠️ [Self-Healing] Client '${info.name}' is disconnected. Reviving...`);
            addLog("info", `Reviving disconnected WhatsApp account: ${info.name}`);
            reconnectClient(clientId);
        }
    }
}, 60000);

startServer();
