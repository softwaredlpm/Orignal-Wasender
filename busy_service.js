const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const cron = require('node-cron');
const { spawn } = require('child_process');

const appDir = process.pkg ? path.dirname(process.execPath) : __dirname;

// Configuration Path
const CONFIG_FILE = path.join(appDir, 'busy_config.json');

// Default Firm Structure
const createNewFirm = () => ({
    id: `firm_${Date.now()}`,
    name: "New Firm",
    dbPath: "C:\\BusyWin\\DATA\\COMP0001",
    dbPassword: "ILoveMyINDIA",
    companyName: "",
    companyAddress: "",
    companyGst: "",
    targetGroup: "Sundry Debtors",
    scheduleCron: "0 10 * * *",
    scheduleEnabled: false,
    autoSend: true,
    reminderType: 'due',
    dueDayBasis: 'due', // 'due' or 'bill'
    whatsappClientId: "default"
});

// Load Config with Migration Support
let busyConfig = { firms: [] };
if (fs.existsSync(CONFIG_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        // Migrate from single firm if needed
        if (data.dbPath && !data.firms) {
            const legacyFirm = { ...createNewFirm(), ...data, id: 'firm_primary', name: data.companyName || "Primary Firm" };
            busyConfig.firms = [legacyFirm];
        } else {
            busyConfig = data;
        }
    } catch (e) {
        console.error("Error loading config", e);
    }
}

// Global helper to save config
function saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(busyConfig, null, 2));
}

// PowerShell Bridge Helper (Context Aware)
function runPsQuery(action, data = "", firm = null) {
    return new Promise((resolve, reject) => {
        const psPath = path.join(appDir, 'busy_db_bridge.ps1');
        const dbPath = firm ? firm.dbPath : (busyConfig.firms[0]?.dbPath || "");
        const dbPass = firm ? firm.dbPassword : (busyConfig.firms[0]?.dbPassword || "ILoveMyINDIA");

        const dbType = firm ? (firm.dbType || "Access") : (busyConfig.firms[0]?.dbType || "Access");
        const dbServer = firm ? (firm.dbServer || "") : (busyConfig.firms[0]?.dbServer || "");
        const dbUser = firm ? (firm.dbUser || "") : (busyConfig.firms[0]?.dbUser || "");

        if (!dbPath) {
            console.error(`Attempted PowerShell query [${action}] without DbPath!`);
            return reject(new Error("Database path is required for this operation. Please configure the plan database path."));
        }

        // Fix for MSSQL: Convert file path to Database Name if needed
        let finalDbPath = dbPath;

        // Priority 1: User specified DB Name
        if (dbType === "MSSQL" && firm && firm.dbName) {
            finalDbPath = firm.dbName;
        }
        // Priority 2: Auto-transform from Path
        else if (dbType === "MSSQL" && (dbPath.includes(":") || dbPath.includes("\\"))) {
            // Assume format: F:\BUSY DATA\COMP0018 -> BusyComp0018_db12025
            // Case sensitive fix: SQL DB likely named "BusyComp...", but folder is "COMP..."
            try {
                const parts = dbPath.split(/[\/\\]/).filter(p => p.trim() !== "");
                const folderName = parts[parts.length - 1]; // e.g. COMP0018

                // Try to unify casing if it matches COMPxxxx pattern
                const match = folderName.match(/^(comp)(\d+)$/i);
                if (match) {
                    // match[2] is the number part
                    finalDbPath = `BusyComp${match[2]}_db12025`;
                } else {
                    // Fallback for non-standard folder names
                    finalDbPath = `Busy${folderName}_db12025`;
                }

            } catch (e) {
                console.warn("[MSSQL] Failed to transform path to DB name, using original:", dbPath);
            }
        }

        const args = [
            '-ExecutionPolicy', 'Bypass',
            '-File', psPath,
            '-Action', action,
            '-Data', data,
            '-DbPath', finalDbPath,
            '-DbPassword', dbPass,
            '-DbType', dbType,
            '-DbServer', dbServer,
            '-DbUser', dbUser
        ];

        const ps = spawn('powershell', args, { windowsHide: true });

        let stdout = '';
        let stderr = '';

        ps.stdout.on('data', (chunk) => { stdout += chunk; });
        ps.stderr.on('data', (chunk) => { stderr += chunk; });

        ps.on('close', (code) => {
            if (code !== 0) return reject(new Error(`PowerShell Bridge [${action}] exited with code ${code}: ${stderr}`));
            try {
                const cleanOut = stdout.trim();
                if (!cleanOut) return resolve([]);
                let parsed = JSON.parse(cleanOut);

                // If the bridge returns a lone object or property (like RESOLVE_PATH), wrap it or handle it
                if (action === 'RESOLVE_PATH' && parsed && parsed.path) return resolve(parsed.path);

                // For list-returning actions, ensure PowerShell single-object flattening is normalized to an Array
                const listActions = new Set([
                    'GET_ACCOUNTS', 'GET_BALANCES_BULK', 'GET_CONTACT_BULK', 'GET_BILLS_BULK',
                    'GET_CLOSING_STOCK', 'GET_BATCH_CLOSING_STOCK', 'GET_MATERIAL_CENTERS',
                    'GET_PARTY_BY_PHONE', 'GET_PARTY_BY_NAME', 'GET_PDC_ALERTS'
                ]);
                if (listActions.has(action) && parsed && !Array.isArray(parsed)) {
                    parsed = [parsed];
                }

                resolve(parsed);
            } catch (e) {
                console.error(`Failed to parse DB output for [${action}]:`, stdout);
                reject(new Error(`Database output parsing failed for ${action}: ` + e.message));
            }
        });
    });
}

// Account Structure Cache to eliminate PowerShell spawn lag
const accountsCache = new Map();
const CACHE_TTL_MS = 30000; // 30 seconds

async function getCachedAccounts(firm) {
    const key = firm.id || firm.dbPath;
    const now = Date.now();
    if (accountsCache.has(key)) {
        const cached = accountsCache.get(key);
        if (now - cached.timestamp < CACHE_TTL_MS) {
            return cached.data;
        }
    }
    const data = await runPsQuery('GET_ACCOUNTS', "", firm);
    accountsCache.set(key, { data, timestamp: now });
    return data;
}

const BusyService = {
    // Accessor for the main config
    getConfig() { return busyConfig; },

    // Clear cache helper
    clearCache(firmId = null) {
        if (firmId) accountsCache.delete(firmId);
        else accountsCache.clear();
    },

    // 1. Get Group Structure
    async getTargetAccounts(firm) {
        try {
            console.log(`Scanning [${firm.name}] for group: ${firm.targetGroup}`);
            const allHelp = await getCachedAccounts(firm);
            const rootGroup = allHelp.find(h => h.NameAlias && h.NameAlias.toLowerCase() === firm.targetGroup.toLowerCase());
            if (!rootGroup) return [];

            const rootGroupId = rootGroup.Code;
            const childrenMap = {};
            const nameMap = {};

            allHelp.forEach(row => {
                const p = row.ParentGroup;
                if (!childrenMap[p]) childrenMap[p] = [];
                childrenMap[p].push(row.Code);
                nameMap[row.Code] = row.NameAlias;
            });

            const descendants = new Set();
            let queue = [rootGroupId];
            while (queue.length > 0) {
                const current = queue.shift();
                if (childrenMap[current]) {
                    childrenMap[current].forEach(k => {
                        descendants.add(k);
                        queue.push(k);
                    });
                }
            }

            const result = Array.from(descendants)
                .map(code => ({ Code: code, Name: nameMap[code] }))
                .sort((a, b) => (a.Name || "").localeCompare(b.Name || ""));

            if (firm.specificParties && Array.isArray(firm.specificParties) && firm.specificParties.length > 0) {
                const allowed = new Set(firm.specificParties.map(String));
                const filtered = result.filter(a => allowed.has(String(a.Code)));
                return filtered;
            }

            return result;
        } catch (error) {
            console.error("DB Error getting accounts:", error);
            throw error;
        }
    },

    // 1.5 Get Hierarchy (Direct Children)
    async getHierarchy(firm, parentNameOrCode) {
        try {
            console.log(`Getting hierarchy for [${firm.name}], parent: ${parentNameOrCode}`);
            const allHelp = await getCachedAccounts(firm);

            // 1. Find the Parent Node Code AND Name
            let parentCode = typeof parentNameOrCode === 'number' ? parentNameOrCode : null;
            let parentName = typeof parentNameOrCode === 'string' ? parentNameOrCode : null;

            // Try to find full node for accurate Code/Name pair
            const pNode = allHelp.find(h =>
                String(h.Code) === String(parentNameOrCode) ||
                (h.NameAlias && h.NameAlias.toLowerCase() === String(parentNameOrCode).toLowerCase())
            );

            if (pNode) {
                parentCode = pNode.Code;
                parentName = pNode.NameAlias;
            }
            // Fallback: If "Sundry Debtors" is passed but not found as explicit NameAlias (unlikely in Busy but possible), 
            // In Busy, standard root groups exist.

            if (!parentCode) return { subgroups: [], accounts: [] };

            // 2. Build Children Map to check who is a parent (is a Group)
            const childrenMap = {};
            allHelp.forEach(row => {
                const parent = String(row.ParentGroup);
                if (!childrenMap[parent]) childrenMap[parent] = [];
                childrenMap[parent].push(row);
            });

            // 3. Get Direct Subgroups (for navigation)
            const subgroups = [];
            const seenGroups = new Set();
            const direct = (childrenMap[String(parentCode)] || []).concat(childrenMap[parentName] || []);

            direct.forEach(child => {
                if (child.MasterType === 1 && !seenGroups.has(child.Code)) {
                    subgroups.push({ Code: child.Code, Name: child.NameAlias });
                    seenGroups.add(child.Code);
                }
            });

            // 4. Get ALL Descendant Accounts (for selection)
            const accounts = [];
            const seenAccounts = new Set();
            let queue = [parentCode];
            while (queue.length > 0) {
                const current = queue.shift();
                const children = childrenMap[String(current)] || [];
                children.forEach(child => {
                    if (child.MasterType === 2) {
                        if (!seenAccounts.has(child.Code)) {
                            accounts.push({ Code: child.Code, Name: child.NameAlias });
                            seenAccounts.add(child.Code);
                        }
                    } else if (child.MasterType === 1) {
                        queue.push(child.Code);
                    }
                });
            }
            subgroups.sort((a, b) => (a.Name || "").localeCompare(b.Name || ""));
            accounts.sort((a, b) => (a.Name || "").localeCompare(b.Name || ""));

            return { subgroups, accounts };

        } catch (error) {
            console.error("Error getting hierarchy:", error);
            return { subgroups: [], accounts: [] };
        }
    },

    // 2. Fetch Individual Balance
    async getLedgerBalance(code, firm) {
        try {
            const res = await runPsQuery('GET_BALANCE', String(code), firm);
            return res.Balance || 0;
        } catch (e) { return 0; }
    },

    // Helper to parse BUSY generated PDF report for 100% exact stock figures
    parseBusyStockPdf(pdfPath) {
        if (!fs.existsSync(pdfPath)) return [];
        try {
            const buffer = fs.readFileSync(pdfPath);
            const text = buffer.toString('latin1');
            const regex = /\(([^()]+)\)\s*TJ|\(([^()]+)\)\s*Tj/g;
            let match;
            const rawLines = [];
            while ((match = regex.exec(text)) !== null) {
                const rawStr = match[1] || match[2] || "";
                const cleanStr = rawStr.replace(/\x00/g, '').trim();
                if (cleanStr) rawLines.push(cleanStr);
            }

            const items = [];
            let i = 0;
            while (i < rawLines.length) {
                if (rawLines[i].toLowerCase() === "unit") {
                    i++;
                    break;
                }
                i++;
            }

            while (i < rawLines.length - 2) {
                const name = rawLines[i];
                if (name.toUpperCase() === "TOTAL") break;

                const qtyStr = rawLines[i + 1];
                const unitStr = rawLines[i + 2];
                const cleanQtyStr = qtyStr.replace(/,/g, '');

                if (!isNaN(parseFloat(cleanQtyStr))) {
                    const rawQtyNum = parseFloat(cleanQtyStr);
                    items.push({
                        ItemName: name,
                        ClosingQty: Math.abs(rawQtyNum),
                        RawQty: rawQtyNum,
                        Unit: unitStr
                    });
                    i += 3;
                } else {
                    i++;
                }
            }
            return items;
        } catch (e) {
            console.error("Error parsing BUSY Stock PDF:", e);
            return [];
        }
    },

    // Fetch Closing Stock live from BUSY Database
    async getClosingStock(firm, searchKeyword = "") {
        try {
            const queryObj = {
                search: searchKeyword || "",
                mcCode: firm.materialCenterCode || firm.materialCenter || "",
                mcName: firm.materialCenterName || ""
            };
            const res = await runPsQuery('GET_CLOSING_STOCK', JSON.stringify(queryObj), firm);
            return Array.isArray(res) ? res : (res ? [res] : []);
        } catch (e) {
            console.error("Error getting closing stock:", e);
            return [];
        }
    },

    // Fetch Batch-wise Closing Stock live from BUSY Database (Admin Only)
    async getBatchClosingStock(firm, searchKeyword = "") {
        try {
            const queryObj = {
                search: Array.isArray(searchKeyword) ? "" : searchKeyword || "",
                mcs: Array.isArray(searchKeyword) ? searchKeyword : [],
                mcCode: firm.materialCenterCode || firm.materialCenter || "",
                mcName: firm.materialCenterName || ""
            };
            const res = await runPsQuery('GET_BATCH_CLOSING_STOCK', JSON.stringify(queryObj), firm);
            return Array.isArray(res) ? res : (res ? [res] : []);
        } catch (e) {
            console.error("Error getting batch closing stock:", e);
            return [];
        }
    },


    // Fetch Material Centers from BUSY Database
    async getMaterialCenters(firm) {
        try {
            const res = await runPsQuery('GET_MATERIAL_CENTERS', '', firm);
            return Array.isArray(res) ? res : (res ? [res] : []);
        } catch (e) {
            console.error("Error getting material centers:", e);
            return [];
        }
    },

    // Fetch Party Info by Phone Number
    async getPartyByPhone(firm, phone) {
        try {
            const res = await runPsQuery('GET_PARTY_BY_PHONE', phone, firm);
            const list = Array.isArray(res) ? res : (res ? [res] : []);
            return list.length > 0 ? list[0] : null;
        } catch (e) {
            console.error("Error getting party by phone:", e);
            return null;
        }
    },

    // Fetch Party Info by Name
    async getPartyByName(firm, name) {
        try {
            const res = await runPsQuery('GET_PARTY_BY_NAME', name, firm);
            const list = Array.isArray(res) ? res : (res ? [res] : []);
            return list.length > 0 ? list[0] : null;
        } catch (e) {
            console.error("Error getting party by name:", e);
            return null;
        }
    },

    // Generate Stock Status PDF Report matching BUSY format
    async generateStockPdf(firm, stockItems, companyInfo = null) {
        let browser = null;
        try {
            const getChromePath = () => {
                const possiblePaths = [
                    path.join(appDir, 'chrome-win', 'chrome.exe'),
                    path.join(appDir, '..', 'chrome-win', 'chrome.exe'),
                    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
                    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
                    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
                    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
                ];
                for (const p of possiblePaths) {
                    if (fs.existsSync(p)) return p;
                }
                return null;
            };

            const execPath = getChromePath();
            browser = await puppeteer.launch({
                executablePath: execPath || undefined,
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
            });

            const page = await browser.newPage();

            const companyName = (companyInfo && companyInfo.Name) ? companyInfo.Name : (firm.companyName || firm.name || "MEENAKUMARI TEXTILES");
            const companyAddr = (companyInfo && companyInfo.Address) ? companyInfo.Address : (firm.companyAddress || "");
            const todayStr = new Date().toLocaleDateString('en-GB').replace(/\//g, '-');

            let totalQty = 0;
            let rowsHtml = "";

            // Sort items alphabetically by ItemName to match BUSY's official report order
            const sortedItems = [...stockItems].sort((a, b) => (a.ItemName || '').localeCompare(b.ItemName || ''));

            sortedItems.forEach(item => {
                const rawQty = (item.RawQty !== undefined) ? item.RawQty : 0;
                totalQty += rawQty;
                
                const numVal = Math.abs(rawQty);
                const prefix = rawQty < 0 ? "-" : "";
                const formattedNum = numVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const formattedQty = `${prefix}${formattedNum}`;
                const itemNameStr = String(item.ItemName || '');
                const unit = (item.Unit || (itemNameStr.toLowerCase().includes("popline") ? "Metre" : "Pcs.")).trim();

                const itemName = item.BatchNo ? `${item.ItemName || ''} (Batch: ${item.BatchNo})` : (item.ItemName || '');

                rowsHtml += `
                <tr>
                    <td class="item-name">${itemName}</td>
                    <td class="qty-col">${formattedQty}</td>
                    <td class="unit-col">${unit}</td>
                </tr>`;
            });

            const totalPrefix = totalQty < 0 ? "-" : "";
            const formattedTotal = `${totalPrefix}${Math.abs(totalQty).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

            const htmlContent = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <style>
                    body {
                        font-family: 'Segoe UI', Arial, sans-serif;
                        margin: 0px;
                        padding: 15px;
                        color: #000;
                        font-size: 13px;
                    }
                    .header-table {
                        width: 100%;
                        border-collapse: collapse;
                        text-align: center;
                        border: 2px solid #000;
                    }
                    .header-table td {
                        padding: 6px;
                        border: none;
                    }
                    .comp-name {
                        font-size: 18px;
                        font-weight: bold;
                        text-decoration: underline;
                        text-transform: uppercase;
                    }
                    .comp-addr {
                        font-size: 12px;
                        font-weight: bold;
                        margin-top: 3px;
                    }
                    .banner {
                        background-color: #000;
                        color: #fff;
                        font-weight: bold;
                        text-align: center;
                        padding: 4px;
                        font-size: 13px;
                        border: 1px solid #000;
                        margin-top: 4px;
                    }
                    .sub-bar {
                        border: 1px solid #000;
                        border-top: none;
                        padding: 4px 8px;
                        font-size: 12px;
                        font-weight: bold;
                        background-color: #f5f5f5;
                    }
                    .flex-bar {
                        display: flex;
                        justify-content: space-between;
                    }
                    table.data-table {
                        width: 100%;
                        border-collapse: collapse;
                        margin-top: 2px;
                    }
                    table.data-table th, table.data-table td {
                        border: 1px solid #000;
                        padding: 4px 6px;
                        font-size: 12px;
                    }
                    table.data-table th {
                        background-color: #e0e0e0;
                        font-weight: bold;
                    }
                    .item-name {
                        text-align: left;
                        font-weight: bold;
                    }
                    .qty-col {
                        text-align: right;
                        font-weight: bold;
                        white-space: nowrap;
                    }
                    .unit-col {
                        text-align: left;
                        font-weight: bold;
                        white-space: nowrap;
                    }
                    .total-row td {
                        font-weight: bold;
                        background-color: #eeeeee;
                    }
                </style>
            </head>
            <body>
                <table class="header-table">
                    <tr>
                        <td>
                            <div class="comp-name">${companyName}</div>
                            ${companyAddr ? `<div class="comp-addr">${companyAddr.replace(/\n/g, '<br>')}</div>` : ''}
                        </td>
                    </tr>
                </table>

                <div class="banner">Stock Status</div>
                <div class="sub-bar" style="text-align: center;">As On : ${todayStr}</div>
                <div class="sub-bar flex-bar">
                    <span>All Items</span>
                    <span>${firm.materialCenterName ? `MC : ${firm.materialCenterName}` : (firm.materialCenter ? `MC : ${firm.materialCenter}` : "All MC")}</span>
                </div>

                <table class="data-table">
                    <thead>
                        <tr>
                            <th style="text-align: left;">Item Details</th>
                            <th style="text-align: right; width: 110px;">Qty.</th>
                            <th style="text-align: left; width: 70px;">Unit</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowsHtml}
                        <tr class="total-row">
                            <td style="text-align: right; font-weight: bold;">Total</td>
                            <td style="text-align: right;">${formattedTotal}</td>
                            <td></td>
                        </tr>
                    </tbody>
                </table>
            </body>
            </html>`;

            await page.setContent(htmlContent, { waitUntil: 'load' });
            const uploadsDir = path.join(appDir, 'uploads');
            if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

            const safeName = (companyName || "Company").replace(/[^a-zA-Z0-9]/g, '_');
            const pdfFileName = `Stock_Status_${safeName}_${Date.now()}.pdf`;
            const pdfPath = path.join(uploadsDir, pdfFileName);

            await page.pdf({
                path: pdfPath,
                format: 'A4',
                margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
                printBackground: true
            });

            console.log(`✅ Generated Stock Status PDF: ${pdfPath}`);
            return pdfPath;
        } catch (err) {
            console.error("PDF Generation Error:", err);
            throw err;
        } finally {
            if (browser) await browser.close();
        }
    },

    generateBatchStockPdf: async function(firm, stockItems, companyInfo) {
        let browser = null;
        try {
            const puppeteer = require('puppeteer');
            const getChromePath = () => {
                const paths = [
                    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
                ];
                for (const p of paths) {
                    if (fs.existsSync(p)) return p;
                }
                return null;
            };

            const execPath = getChromePath();
            browser = await puppeteer.launch({
                executablePath: execPath || undefined,
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
            });

            const page = await browser.newPage();

            const companyName = (companyInfo && companyInfo.Name) ? companyInfo.Name : (firm.companyName || firm.name || "Company");
            const companyAddr = (companyInfo && companyInfo.Address) ? companyInfo.Address : (firm.companyAddress || "");
            const todayStr = new Date().toLocaleDateString('en-GB').replace(/\//g, '-');

            let grandTotalIn = 0;
            let grandTotalOut = 0;
            let grandTotalPending = 0;
            let contentHtml = "";

            const sortedItems = [...stockItems].sort((a, b) => {
                const mcCompare = (a.PartyName || '').localeCompare(b.PartyName || '');
                if (mcCompare !== 0) return mcCompare;
                return (a.ItemName || '').localeCompare(b.ItemName || '');
            });

            const groupedByMC = {};
            sortedItems.forEach(item => {
                const mc = item.PartyName || 'Unknown Centre';
                if (!groupedByMC[mc]) groupedByMC[mc] = [];
                groupedByMC[mc].push(item);
            });

            for (const [mcName, items] of Object.entries(groupedByMC)) {
                contentHtml += `<div style="font-size: 14px; font-weight: bold; text-align: center; margin-top: 15px; margin-bottom: 5px;">Material Centre : ${mcName}</div>`;
                
                contentHtml += `
                <table class="data-table">
                    <thead>
                        <tr>
                            <th style="width: 12%;">Date</th>
                            <th style="width: 32%;">Item Name</th>
                            <th style="width: 6%;">Unit</th>
                            <th style="width: 20%;">Batch No.</th>
                            <th style="text-align: right; width: 10%;">Total Qty. In</th>
                            <th style="text-align: right; width: 10%;">Total Qty. Out</th>
                            <th style="text-align: right; width: 10%;">PendingQty.</th>
                        </tr>
                    </thead>
                    <tbody>`;
                
                let subTotalIn = 0;
                let subTotalOut = 0;
                let subTotalPending = 0;

                items.forEach(item => {
                    const qtyIn = (item.QtyIn !== undefined) ? item.QtyIn : 0;
                    const qtyOut = (item.QtyOut !== undefined) ? item.QtyOut : 0;
                    const pendingQty = (item.ClosingQty !== undefined) ? item.ClosingQty : ((item.RawQty !== undefined) ? item.RawQty : 0);
                    
                    subTotalIn += qtyIn;
                    subTotalOut += qtyOut;
                    subTotalPending += pendingQty;
                    
                    grandTotalIn += qtyIn;
                    grandTotalOut += qtyOut;
                    grandTotalPending += pendingQty;
                    
                    const itemNameStr = String(item.ItemName || '');
                    const unit = (item.Unit || (itemNameStr.toLowerCase().includes("popline") ? "Metre" : "Pcs.")).trim();

                    contentHtml += `
                    <tr>
                        <td class="item-name" style="white-space: nowrap;">${item.VchDate || ''}</td>
                        <td class="item-name">${item.ItemName || ''}</td>
                        <td class="unit-col">${unit}</td>
                        <td class="item-name">${item.BatchNo || ''}</td>
                        <td class="qty-col">${qtyIn.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        <td class="qty-col">${qtyOut.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        <td class="qty-col">${pendingQty.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    </tr>`;
                });

                contentHtml += `
                        <tr class="total-row">
                            <td colspan="4" style="text-align: right;">Total</td>
                            <td style="text-align: right;">${subTotalIn.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            <td style="text-align: right;">${subTotalOut.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            <td style="text-align: right;">${subTotalPending.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        </tr>
                    </tbody>
                </table>`;
            }

            if (Object.keys(groupedByMC).length > 1) {
                contentHtml += `
                <div style="display: flex; justify-content: flex-end; margin-top: 15px;">
                    <table class="data-table" style="width: 50%;">
                        <tbody>
                            <tr class="total-row" style="font-size: 13px;">
                                <td style="text-align: right;">Grand Total</td>
                                <td class="qty-col" style="width: 20%;">${grandTotalIn.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                <td class="qty-col" style="width: 20%;">${grandTotalOut.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                <td class="qty-col" style="width: 20%;">${grandTotalPending.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>`;
            }

            const htmlContent = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <style>
                    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0px; padding: 15px; color: #000; font-size: 11px; }
                    .header-table { width: 100%; border-collapse: collapse; text-align: center; border: 2px solid #000; }
                    .header-table td { padding: 6px; border: none; }
                    .comp-name { font-size: 16px; font-weight: bold; text-decoration: underline; text-transform: uppercase; }
                    .comp-addr { font-size: 11px; font-weight: bold; margin-top: 3px; }
                    .banner { background-color: #000; color: #fff; font-weight: bold; text-align: center; padding: 4px; font-size: 12px; border: 1px solid #000; margin-top: 4px; }
                    .sub-bar { border: 1px solid #000; border-top: none; padding: 4px 8px; font-size: 11px; font-weight: bold; background-color: #f5f5f5; }
                    table.data-table { width: 100%; border-collapse: collapse; margin-top: 2px; }
                    table.data-table th, table.data-table td { border: 1px solid #000; padding: 4px; font-size: 11px; }
                    table.data-table th { background-color: #e0e0e0; font-weight: bold; text-align: left; }
                    .item-name { text-align: left; }
                    .qty-col { text-align: right; }
                    .unit-col { text-align: left; }
                    .total-row td { font-weight: bold; background-color: #eeeeee; }
                </style>
            </head>
            <body>
                <table class="header-table">
                    <tr>
                        <td>
                            <div class="comp-name">${companyName}</div>
                            ${companyAddr ? `<div class="comp-addr">${companyAddr.replace(/\n/g, '<br>')}</div>` : ''}
                        </td>
                    </tr>
                </table>
                <div class="banner">Batch-wise Stock</div>
                <div class="sub-bar" style="text-align: right;">Batches Status as on : ${todayStr}</div>
                ${contentHtml}
            </body>
            </html>`;

            await page.setContent(htmlContent, { waitUntil: 'load' });
            const uploadsDir = path.join(appDir, 'uploads');
            if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

            const safeName = (companyName || "Company").replace(/[^a-zA-Z0-9]/g, '_');
            const pdfFileName = "Batch_Stock_" + safeName + "_" + Date.now() + ".pdf";
            const pdfPath = path.join(uploadsDir, pdfFileName);

            await page.pdf({
                path: pdfPath,
                format: 'A4',
                margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
                printBackground: true
            });

            console.log("✅ Generated Batch Stock PDF: " + pdfPath);
            return pdfPath;
        } catch (err) {
            console.error("Batch PDF Generation Error:", err);
            throw err;
        } finally {
            if (browser) await browser.close();
        }
    },

    // 4. Formatting Helper
    _formatBills(rawBills, liveBalance = 0, firm, isCreditor = false) {
        const bills = Array.isArray(rawBills) ? rawBills : (rawBills ? [rawBills] : []);
        const billMap = {};

        bills.forEach(b => {
            const isBill = (b.Method == 1 || b.VchCode == 0);
            const isActivePDC = (b.IsActivePDC === 1);

            // 2. If it's an adjustment to a bill (Method 2), group by that bill number.
            // 3. Otherwise (On Account OR non-bill-adjustment), group as "On Account".
            let key = "On Account";
            if (isBill) {
                key = (b.RefNo || b.No || b.RefString || (b.VchCode == 0 ? "Opening Balance" : "Misc")).trim();
            } else if (b.Method == 2 && b.RefNo) {
                key = b.RefNo.trim();
            }

            if (!billMap[key]) {
                billMap[key] = { RefNo: key, OriginalAmt: 0, PendingAmt: 0, PDCAmt: 0, RefColumnAmt: 0, Date: b.Date, DueDate: b.DueDate, Items: [] };
            }

            if (isBill) {
                // RefColumnAmt: What is displayed in the "Ref. Amt." (Total Amt) column.
                // For OpBl, this is the amount brought forward (Value1).
                billMap[key].RefColumnAmt += Math.abs(b.Value1);

                // OriginalAmt: The true original amount of the bill.
                // Use NewRefAmount if available (e.g. 39000 for OpBl), otherwise Value3 or Value1.
                billMap[key].OriginalAmt += Math.abs(b.NewRefAmount || b.Value3 || b.Value1);
            }

            // Balancing & PDC Logic
            if (isActivePDC) {
                // ALL Active PDCs sum into PDCAmt
                billMap[key].PDCAmt += Math.abs(b.Value1 || 0);
                // Active PDCs DO NOT reduce the realized PendingAmt
            } else {
                // Regular transactions (OpBl, Bill, Rcpt, Adj)
                billMap[key].PendingAmt += b.Value1;
            }

            // Add item to group
            billMap[key].Items.push({ ...b, isActivePDC });
        });

        const formattedBills = [];
        const parsePsDate = (d) => {
            if (!d) return null;
            if (typeof d === 'string' && d.includes('/Date(')) {
                const m = d.match(/\/Date\((\d+)\)\//);
                if (m) return new Date(parseInt(m[1]));
            }
            return new Date(d);
        };

        let onAccountTotal = 0;
        Object.values(billMap).forEach(group => {
            // Check if any item in the group is an ACTIVE PDC
            const hasActivePDC = group.Items.some(i => i.isActivePDC);
            group.hasActivePDC = hasActivePDC;

            // Include row if it has a real pending amount OR an active PDC.
            if (Math.abs(group.PendingAmt) > 0.1 || Math.abs(group.PDCAmt) > 0.1) {
                const due = Math.abs(group.PendingAmt);
                const dateObj = parsePsDate(group.Date);
                const dueObj = parsePsDate(group.DueDate);
                const now = new Date(); now.setHours(0, 0, 0, 0);
                let days = 0;

                const basis = firm?.dueDayBasis || 'due';
                let compareDate;

                if (basis === 'bill') {
                    compareDate = dateObj;
                } else {
                    // Default to Due Date, fallback to Bill Date if Due Date invalid
                    compareDate = dueObj && !isNaN(dueObj.getTime()) ? dueObj : dateObj;
                }

                if (compareDate && !isNaN(compareDate.getTime())) {
                    days = Math.floor((now - compareDate) / (1000 * 60 * 60 * 24));
                }

                let type = "Ref";
                if (group.Items && group.Items.length > 0) {
                    const first = group.Items[0];
                    type = first.VchCode === 0 ? "OpBl" : (first.Method === 1 ? "SALES" : (first.Method >= 3 ? "Rcpt" : "Adj"));
                }

                // For "On Account" row, we keep it for the footer summary AND add it to the table.
                if (group.RefNo === "On Account") {
                    onAccountTotal = group.PendingAmt;
                }

                const isDue = (days > 0 && Math.abs(group.PendingAmt) > 0.1) ? "Y" : "N";
                const isPDC = group.hasActivePDC || Math.abs(group.PDCAmt) > 0.1;

                formattedBills.push({
                    Date: (dateObj && !isNaN(dateObj.getTime())) ? dateObj.toLocaleDateString('en-GB').replace(/\//g, '-') : group.Date,
                    Type: type,
                    No: isPDC ? `*${group.RefNo}` : group.RefNo,
                    RefAmt: group.RefColumnAmt || group.OriginalAmt,
                    BalAmt: group.PendingAmt,
                    DueStatus: isDue,
                    DueDate: (dueObj && !isNaN(dueObj.getTime())) ? dueObj.toLocaleDateString('en-GB').replace(/\//g, '-') : "",
                    Days: days,
                    isPDC: isPDC,
                    OrgAmt: group.OriginalAmt,
                    isOnAccount: group.RefNo === "On Account"
                });
            }
        });

        let finalTotalDue = 0;
        let finalTotalRef = 0;
        formattedBills.forEach(b => {
            finalTotalDue += (b.BalAmt || 0);
            finalTotalRef += (b.RefAmt || 0);
        });

        const absLiveBalance = Math.abs(liveBalance);
        const balanceSide = (liveBalance === 0) ? "" : (liveBalance < 0 ? "Dr" : "Cr");

        return {
            totalDue: finalTotalDue,
            totalRef: finalTotalRef,
            bills: formattedBills,
            liveBalance: absLiveBalance,
            balanceSide: balanceSide,
            onAccountTotal: onAccountTotal
        };
    },

    // 5. PDF Generation
    async generatePdf(accountName, address, bills, totalDue, totalRef, liveBalance, balanceSide, onAccountTotal = 0, firm, isCreditor = false) {
        // Use live profile but fallback to firm settings
        let profile = await this.getCompanyProfile(firm);
        const compName = profile?.Name || firm.companyName || "Your Company";
        const compAddr = profile?.Address || firm.companyAddress || "";
        const compGst = profile?.GSTNo || firm.companyGst || "";

        const reportDate = new Date().toLocaleDateString('en-GB'); // DD/MM/YYYY
        let docTitle = "PAYMENT REMINDER STATEMENT";
        const rType = firm.reminderType || 'due';

        if (rType === 'balance') docTitle = "PAYMENT SUMMARY STATEMENT";
        else if (rType === 'pending') docTitle = "DETAILED OUTSTANDING STATEMENT";
        else if (rType === 'due') docTitle = "OVERDUE PAYMENT REMINDER";

        // Pre-calculate running balance
        let runningBal = 0;
        const billsWithRun = bills.map(b => {
            runningBal += (b.BalAmt || 0);
            return { ...b, RunBal: runningBal };
        });

        const htmlContent = `
        <html>
        <head>
            <style>
                body { font-family: 'Inter', system-ui, sans-serif; padding: 40px; color: #111827; }
                .header { text-align: center; border-bottom: 2px solid #10b981; padding-bottom: 20px; margin-bottom: 30px; position: relative; }
                .company-name { font-size: 28px; font-weight: 800; color: #064e3b; text-transform: uppercase; }
                .doc-title { font-size: 18px; font-weight: 600; margin-top: 10px; color: #059669; text-transform: uppercase; }
                .report-date { font-size: 11px; color: #6b7280; margin-top: 5px; }
                .client-info { margin-bottom: 40px; }
                .client-name { font-size: 20px; font-weight: 700; color: #111827; text-transform: uppercase; }
                table { width: 100%; border-collapse: collapse; margin-top: 20px; table-layout: fixed; }
                th { background: #fff; padding: 12px 5px; text-align: left; border-top: 2px solid #111827; border-bottom: 2px solid #111827; font-size: 11px; font-weight: 700; color: #111827; }
                td { padding: 8px 5px; border-bottom: 1px solid #e5e7eb; font-size: 11px; color: #111827; vertical-align: top; }
                .text-right { text-align: right; }
                tr { page-break-inside: avoid; }
            </style>
        </head>
        <body>
            <div class="header">
                <div class="company-name">${compName}</div>
                <div style="font-size: 13px; color: #6b7280; margin-top: 5px;">${compAddr}</div>
                <div style="font-size: 13px; font-weight: 600;">GSTIN: ${compGst}</div>
                <div class="report-date">Report Date: ${reportDate}</div>
                <div class="doc-title">${docTitle}</div>
            </div>
            <div class="client-info">
                <div style="color: #6b7280; font-size: 12px; text-transform: uppercase;">Outstanding for:</div>
                <div class="client-name">${accountName}</div>
                <div style="font-size: 14px; color: #4b5563;">${address}</div>
            </div>
            <table>
                <thead>
                    <tr>
                        <th style="width: 11%;">Dated</th>
                        <th style="width: 7%;">Type</th>
                        <th style="width: 17%;">Ref. No.</th>
                        <th class="text-right" style="width: 13%;">Total Amt.</th>
                        <th class="text-right" style="width: 13%;">Pen. Amt.</th>
                        <th class="text-right" style="width: 13%;">Balance</th>
                        <th class="text-right" style="width: 5%;">Due</th>
                        <th class="text-right" style="width: 12%;">Due Date</th>
                        <th class="text-right" style="width: 9%;">Days</th>
                    </tr>
                </thead>
                <tbody>
                    ${billsWithRun.map(b => `
                        <tr>
                            <td>${b.Date}</td>
                            <td>${b.Type}</td>
                            <td>
                                ${b.No}
                                ${b.isPDC && Math.abs((b.OrgAmt || 0) - (b.BalAmt || 0)) > 1 ? `<br/><span style="font-size: 9px; color: #4b5563;">Org. Amt. ${Number(b.OrgAmt || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>` : ''}
                            </td>
                            <td class="text-right">${Number(b.RefAmt || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                            <td class="text-right" style="font-weight: 700;">${Math.abs(b.BalAmt || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                            <td class="text-right" style="font-weight: 700; color: #4b5563;">${Math.abs(b.RunBal || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                            <td class="text-right" style="font-weight: 700;">${b.DueStatus || ''}</td>
                            <td class="text-right">${b.DueDate || ''}</td>
                            <td class="text-right">${b.Days || 0}</td>
                        </tr>
                    `).join('')}
                    <tr style="font-weight: 700; border-top: 2px solid #374151; page-break-inside: avoid;">
                        <td colspan="3" class="text-right" style="padding-top: 15px;">Grand Total</td>
                        <td class="text-right" style="padding-top: 15px; border-bottom: 2px solid #374151;">${Number(totalRef || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                        <td class="text-right" style="padding-top: 15px; border-bottom: 2px solid #374151;">${Math.abs(totalDue || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                        <td colspan="4"></td>
                    </tr>
                </tbody>
            </table>
            
            <div style="margin-top: 40px; font-weight: 700; font-size: 14px; line-height: 1.8;">
                <div>( On Acc. : &nbsp;&nbsp;${Math.abs(onAccountTotal || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })} ${(onAccountTotal === 0) ? "" : ((onAccountTotal || 0) < 0 ? 'Dr' : 'Cr')} )</div>
                <div>( Ledger Bal. : &nbsp;&nbsp;${Math.abs(liveBalance || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })} ${balanceSide || ''} &nbsp;&nbsp;)</div>
            </div>
        </body>
        </html > `;

        const outputDir = path.join(appDir, 'uploads');
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        // Remove underscores from filename, replace with spaces
        let safeName = accountName.replace(/[^a-z0-9]/gi, ' ').replace(/\s+/g, ' ').trim();
        const outputPath = path.join(outputDir, `Stmt ${safeName}.pdf`);

        const launchOptions = {
            headless: "new",
            args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
        };

        // If running as EXE, try to find system Chrome if local one is missing
        if (process.pkg) {
            const commonPaths = [
                path.join(appDir, 'chrome-win', 'chrome.exe'),
                'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
            ];

            for (const p of commonPaths) {
                if (fs.existsSync(p)) {
                    launchOptions.executablePath = p;
                    break;
                }
            }
        }

        let browser = null;
        try {
            browser = await puppeteer.launch(launchOptions);
            const page = await browser.newPage();
            await page.setContent(htmlContent);
            await page.pdf({
                path: outputPath,
                format: 'A4',
                printBackground: true,
                displayHeaderFooter: true,
                headerTemplate: '<div></div>',
                footerTemplate: `
    <div style="font-family: 'Inter', system-ui, sans-serif; font-size: 9px; color: #9ca3af; width: 100%; padding: 0 40px; display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #f3f4f6;">
                    <div>This is a computer-generated statement and does not require a signature.</div>
                    <div>Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>
                </div>`,
                margin: { top: '40px', bottom: '60px', left: '40px', right: '40px' }
            });
            return outputPath;
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    },

    // 6. Bulk Send Job
    async runBulkReminders(firm, logCallback) {
        logCallback("info", `Starting Optimization for [${firm.name}]...`);
        try {
            const accounts = await this.getTargetAccounts(firm);
            if (accounts.length === 0) { logCallback("info", `No accounts found for [${firm.name}].`); return; }

            const codes = accounts.map(a => a.Code).join(',');
            const [balancesRaw, contactData, allBillsRaw] = await Promise.all([
                runPsQuery('GET_BALANCES_BULK', codes, firm),
                runPsQuery('GET_CONTACT_BULK', codes, firm),
                runPsQuery('GET_BILLS_BULK', codes, firm)
            ]);

            const balanceMap = {};
            if (balancesRaw) {
                (Array.isArray(balancesRaw) ? balancesRaw : [balancesRaw]).forEach(b => {
                    balanceMap[b.Code] = {
                        balance: b.Balance || 0,
                        pdcAmt: b.PDCAmt || 0
                    };
                });
            }

            const contactMap = {};
            const rawAddr = contactData.AddressInfo || [];
            const addrInfos = Array.isArray(rawAddr) ? rawAddr : [rawAddr];
            addrInfos.forEach(a => {
                const code = String(a.MasterCode || a.Code || "").trim();
                if (code) {
                    contactMap[code] = {
                        Mobile: a.Mobile || a.WhatsAppNo || a.WhatsAppno || "",
                        Address: [a.Address1, a.Address2, a.Station].filter(Boolean).join(', '),
                        ParentGroup: a.ParentGroup || ""
                    };
                }
            });

            const billsMap = {};
            (Array.isArray(allBillsRaw) ? allBillsRaw : [allBillsRaw]).forEach(b => {
                if (!billsMap[b.MasterCode1]) billsMap[b.MasterCode1] = [];
                billsMap[b.MasterCode1].push(b);
            });

            let sent = 0;
            for (const acc of accounts) {
                const bData = balanceMap[acc.Code];
                if (!bData) {
                    continue;
                }
                const totalBal = bData.balance || 0; // This is now Ledger Balance (Real + Realized PDC)
                const pdcBal = Math.abs(bData.pdcAmt || 0); // This is Active PDC Amount

                // Process if either ledger balance exists or there are active PDCs
                if (Math.abs(totalBal) <= 1 && pdcBal <= 1) {
                    continue;
                }



                // Total balance to show (Matching Busy Ledger Balance)
                // Determine Nature: Creditor vs Debtor
                const contact = contactMap[String(acc.Code)];
                const parentGroup = contact ? String(contact.ParentGroup || "").toLowerCase() : "";
                const targetGroup = firm.targetGroup ? firm.targetGroup.toLowerCase() : "";

                let isCreditor = false;
                if (parentGroup.includes("creditor")) isCreditor = true;
                else if (parentGroup.includes("debtor")) isCreditor = false;
                else isCreditor = targetGroup.includes("creditor");

                // Busy Logic with Signed Balance:
                // Negative (-) = Debit (Dr)
                // Positive (+) = Credit (Cr)
                const liveBalance = Math.abs(totalBal);
                let balanceSide = (totalBal === 0) ? "" : (totalBal < 0 ? 'Dr' : 'Cr');

                const { bills, totalDue, totalRef, onAccountTotal } = this._formatBills(billsMap[acc.Code] || [], totalBal, firm, isCreditor);                // Only send if there are actual due bills or a non-zero ledger balance
                if (totalDue !== 0 || liveBalance !== 0) {
                    const contact = contactMap[String(acc.Code)];
                    const rawMob = contact ? (contact.Mobile || contact.Phone) : null;
                    const validNumbers = this.parseMobileNumbers(rawMob);

                    if (validNumbers.length > 0) {
                        const accountName = `${acc.Name}${pdcBal > 1 ? '*' : ''} `;
                        const onAccountSide = (onAccountTotal === 0) ? "" : (onAccountTotal < 0 ? 'Dr' : 'Cr');
                        const message = `Dear ${acc.Name}, \n\nYour outstanding balance with ${firm.name} is ₹${Number(liveBalance || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })} ${balanceSide}.\n${Math.abs(onAccountTotal || 0) > 1 ? `(Including On Account: ₹${Math.abs(onAccountTotal || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })} ${onAccountSide})\n` : ""}Please find the detailed statement attached.`;

                        // Generate PDF once for the account
                        const pdfPath = await this.generatePdf(accountName, contact ? contact.Address : "", bills, totalDue, totalRef, liveBalance, balanceSide, onAccountTotal, firm, isCreditor);

                        // Send to ALL valid numbers
                        for (const mob of validNumbers) {
                            await logCallback("queue_job", "Queuing...", { 
                                number: mob, 
                                message: message, 
                                filePath: pdfPath,
                                whatsappClientId: firm.whatsappClientId || "default"
                            });
                            sent++;
                        }
                    }
                }
            }
            logCallback("success", `[${firm.name}] processed. Queued: ${sent}`);
        } catch (e) { logCallback("error", `[${firm.name}] bulk job failed: ` + e.message); }
    },

    // Helper: Parse Multiple Mobile Numbers
    parseMobileNumbers(rawInput) {
        if (!rawInput) return [];
        const input = String(rawInput || "").trim();
        const results = new Set();

        // 1. Split by non-digit delimiters (comma, semicolon, space, slash, pipe)
        // This handles "9876543210; 8877665544" or "9876543210/8877665544"
        const chunks = input.split(/[^0-9]+/);

        chunks.forEach(chunk => {
            if (!chunk) return;

            // 2. Handle Concatenated Numbers (e.g. 98463207639544883695 -> 20 digits)
            // If length is a multiple of 10 and >= 20, split it
            if (chunk.length >= 20 && chunk.length % 10 === 0) {
                for (let i = 0; i < chunk.length; i += 10) {
                    const sub = chunk.substring(i, i + 10);
                    // Validate
                    if (sub.length === 10) results.add('91' + sub);
                }
            }
            // 3. Handle Standard Numbers
            else {
                let clean = chunk;
                if (clean.length === 10) clean = '91' + clean;
                else if (clean.length === 12 && clean.startsWith('91')) { /* keep */ }
                else if (clean.length === 11 && clean.startsWith('0')) clean = '91' + clean.substring(1);

                // Final Check
                if (clean.length === 12 && clean.startsWith('91')) {
                    results.add(clean);
                }
            }
        });

        return Array.from(results);
    },

    // 7. Scan Preview
    async scanAndPreview(firm) {
        const accounts = await this.getTargetAccounts(firm);
        const codes = accounts.map(a => a.Code).join(',');
        const [balancesRaw, contactData] = await Promise.all([
            runPsQuery('GET_BALANCES_BULK', codes, firm),
            runPsQuery('GET_CONTACT_BULK', codes, firm)
        ]);

        const balanceMap = {};
        if (balancesRaw) {
            (Array.isArray(balancesRaw) ? balancesRaw : [balancesRaw]).forEach(b => {
                balanceMap[b.Code] = {
                    balance: b.Balance || 0,
                    pdcAmt: b.PDCAmt || 0
                };
            });
        }

        const contactMap = {};
        const rawAddr = contactData.AddressInfo || [];
        const addrInfos = Array.isArray(rawAddr) ? rawAddr : [rawAddr];
        addrInfos.forEach(a => {
            const code = String(a.MasterCode || a.Code || "").trim();
            if (code) {
                // Store RAW mobile for parsing later
                contactMap[code] = {
                    Mobile: a.Mobile || a.WhatsAppNo || a.WhatsAppno || "",
                    Address: a.Address1,
                    ParentGroup: a.ParentGroup || ""
                };
            }
        });

        return accounts.filter(a => {
            const b = balanceMap[a.Code];
            if (!b) return false;
            return Math.abs(b.balance) > 1 || Math.abs(b.pdcAmt) > 1;
        }).map(a => {
            const b = balanceMap[a.Code];
            const totalBal = b.balance;
            const bal = Math.abs(totalBal);
            const contact = contactMap[String(a.Code)];
            const parentGroup = contact ? String(contact.ParentGroup || "").toLowerCase() : "";
            const targetGroup = firm.targetGroup ? firm.targetGroup.toLowerCase() : "";

            let isCreditor = false;
            if (parentGroup.includes("creditor")) isCreditor = true;
            else if (parentGroup.includes("debtor")) isCreditor = false;
            else isCreditor = targetGroup.includes("creditor");

            const type = (totalBal === 0) ? "" : (totalBal < 0 ? 'Dr' : 'Cr');
            const hasPDC = Math.abs(b.pdcAmt) > 1;

            const rawMob = contact?.Mobile || "";
            // Parse for display
            const validNumbers = this.parseMobileNumbers(rawMob);

            // Display Logic: Show all valid numbers, or original if none valid
            const displayMob = validNumbers.length > 0 ? validNumbers.map(n => n.substring(2)).join(', ') : (rawMob || "N/A"); // Strip 91 for display

            return {
                code: a.Code,
                name: hasPDC ? `* ${a.Name} ` : a.Name,
                due: bal.toFixed(2),
                type: type,
                mobile: displayMob,
                originalMobile: rawMob, // Keep raw for debugging/editing if needed
                hasPDC: hasPDC
            };
        });
    },

    async getPdcAlerts(firm) {
        try {
            const results = await runPsQuery('GET_PDC_ALERTS', "", firm);
            // Result is likely an array or single object, normalize to array
            return Array.isArray(results) ? results : (results ? [results] : []);
        } catch (e) {
            console.error("Error fetching PDC alerts:", e);
            return [];
        }
    },

    async runPdcReminders(firm, logCallback = () => {}) {
        if (!firm.pdcEnabled) {
            logCallback('info', `PDC reminders disabled for [${firm.name}]`);
            return { chequesFound: 0, messagesSent: 0 };
        }

        logCallback('info', `Running PDC checks for [${firm.name}]...`);
        const alerts = await this.getPdcAlerts(firm);
        
        // Filter out bank accounts and deduplicate by VchCode
        const uniquePDCs = new Map();
        for (const pdc of alerts) {
            if (pdc.ParentGroupName === 'Bank Accounts' || pdc.ParentGroupCode === 112) continue;
            if (!uniquePDCs.has(pdc.VchCode)) {
                uniquePDCs.set(pdc.VchCode, pdc);
            }
        }
        
        const deduplicatedAlerts = Array.from(uniquePDCs.values());
        let chequesFound = deduplicatedAlerts.length;
        let messagesSent = 0;

        for (const pdc of deduplicatedAlerts) {
            const rawMob = (pdc.Mobile || pdc.WhatsAppNo || pdc.WhatsAppno || "").toString();
            const validNumbers = this.parseMobileNumbers(rawMob);
            
            if (validNumbers.length === 0) {
                logCallback('warning', `Skipped PDC reminder for ${pdc.AccountName || 'Unknown'} - No valid mobile.`);
                continue;
            }

            let message = "";
            const amt = pdc.Amount ? Math.abs(parseFloat(pdc.Amount)).toFixed(2) : "0.00";
            
            // Parse MS JSON Date like /Date(...) or standard string like 2026-08-16
            const pdcDateStr = pdc.PDCDate || "";
            let dateObj = new Date();
            if (pdcDateStr.includes('/Date(')) {
                dateObj = new Date(parseInt(pdcDateStr.replace(/[^0-9-]/g, '')));
            } else if (pdcDateStr.match(/^\d{4}-\d{2}-\d{2}/)) {
                // Parse YYYY-MM-DD reliably in local time
                const [y, m, d] = pdcDateStr.split(' ')[0].split('-');
                dateObj = new Date(y, parseInt(m)-1, d);
            }
            
            const d = dateObj.getDate().toString().padStart(2, '0');
            const m = (dateObj.getMonth() + 1).toString().padStart(2, '0');
            const y = dateObj.getFullYear();
            const dateStr = `${d}-${m}-${y}`;

            // Calculate days pending from today
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const checkDate = new Date(dateObj);
            checkDate.setHours(0, 0, 0, 0);
            const daysPending = Math.round((checkDate - today) / (1000 * 60 * 60 * 24));
            
            if (daysPending === 2) {
                message = `Hello ${pdc.AccountName},\n\nGentle reminder: Your Post-Dated Cheque of ₹${amt} is due for deposit in *2 days* on ${dateStr}.\nPlease ensure sufficient funds are available.\n\nThank you!`;
            } else if (daysPending === 1) {
                message = `Hello ${pdc.AccountName},\n\nImportant Reminder: Your Post-Dated Cheque of ₹${amt} will be deposited *tomorrow* (${dateStr}).\nPlease ensure your account has sufficient balance.\n\nThank you!`;
            } else if (daysPending === 0) {
                message = `Hello ${pdc.AccountName},\n\nThis is to inform you that your Post-Dated Cheque of ₹${amt} is being deposited *today* (${dateStr}).\n\nThank you!`;
            } else if (daysPending === -1) {
                message = `Hello ${pdc.AccountName},\n\nOverdue Reminder: Your Post-Dated Cheque of ₹${amt} dated ${dateStr} was scheduled for deposit *yesterday*.\nIf you haven't already, please ensure sufficient funds are maintained in your account.\n\nThank you!`;
            } else {
                continue; // Skip if it's not 2, 1, 0, or -1 days.
            }

            // Queue for each valid number
            for (const number of validNumbers) {
                logCallback('queue_job', `Queued PDC reminder for ${pdc.AccountName}`, {
                    number: number,
                    message: message,
                    filePath: null
                });
                messagesSent++;
            }
        }
        
        return { chequesFound, messagesSent };
    },

    // 8. Resolve Database Path
    async resolvePath(firm) {
        try {
            return await runPsQuery('RESOLVE_PATH', "", firm);
        } catch (e) {
            return null;
        }
    },

    // 9. Get Company Profile (Auto-pick)
    async getCompanyProfile(firm) {
        try {
            const data = await runPsQuery('GET_COMPANY_INFO', "", firm);
            return data && data.Name ? data : null;
        } catch (e) {
            return null;
        }
    },

    // 10. Firm Management
    getFirms() { return busyConfig.firms; },
    addFirm() {
        const f = createNewFirm();
        busyConfig.firms.push(f);
        saveConfig();
        return f;
    },
    updateFirm(id, data) {
        const idx = busyConfig.firms.findIndex(f => f.id === id);
        if (idx !== -1) {
            busyConfig.firms[idx] = { ...busyConfig.firms[idx], ...data };
            saveConfig();
            return true;
        }
        return false;
    },
    deleteFirm(id) {
        busyConfig.firms = busyConfig.firms.filter(f => f.id !== id);
        saveConfig();
        return true;
    }
};

module.exports = {
    ...BusyService,
    runPsQuery
};
