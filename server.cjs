process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// busy_service.js
var require_busy_service = __commonJS({
  "busy_service.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var puppeteer = require("puppeteer");
    var cron2 = require("node-cron");
    var { spawn } = require("child_process");
    var appDir2 = process.pkg ? path2.dirname(process.execPath) : __dirname;
    var CONFIG_FILE = path2.join(appDir2, "busy_config.json");
    var createNewFirm = () => ({
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
      reminderType: "due",
      dueDayBasis: "due",
      // 'due' or 'bill'
      whatsappClientId: "default"
    });
    var busyConfig = { firms: [] };
    if (fs2.existsSync(CONFIG_FILE)) {
      try {
        const data = JSON.parse(fs2.readFileSync(CONFIG_FILE, "utf8"));
        if (data.dbPath && !data.firms) {
          const legacyFirm = { ...createNewFirm(), ...data, id: "firm_primary", name: data.companyName || "Primary Firm" };
          busyConfig.firms = [legacyFirm];
        } else {
          busyConfig = data;
        }
      } catch (e) {
        console.error("Error loading config", e);
      }
    }
    function saveConfig() {
      fs2.writeFileSync(CONFIG_FILE, JSON.stringify(busyConfig, null, 2));
    }
    function runPsQuery(action, data = "", firm = null) {
      return new Promise((resolve, reject) => {
        const psPath = path2.join(appDir2, "busy_db_bridge.ps1");
        const dbPath = firm ? firm.dbPath : busyConfig.firms[0]?.dbPath || "";
        const dbPass = firm ? firm.dbPassword : busyConfig.firms[0]?.dbPassword || "ILoveMyINDIA";
        const dbType = firm ? firm.dbType || "Access" : busyConfig.firms[0]?.dbType || "Access";
        const dbServer = firm ? firm.dbServer || "" : busyConfig.firms[0]?.dbServer || "";
        const dbUser = firm ? firm.dbUser || "" : busyConfig.firms[0]?.dbUser || "";
        if (!dbPath) {
          console.error(`Attempted PowerShell query [${action}] without DbPath!`);
          return reject(new Error("Database path is required for this operation. Please configure the plan database path."));
        }
        let finalDbPath = dbPath;
        if (dbType === "MSSQL" && firm && firm.dbName) {
          finalDbPath = firm.dbName;
        } else if (dbType === "MSSQL" && (dbPath.includes(":") || dbPath.includes("\\"))) {
          try {
            const parts = dbPath.split(/[\/\\]/).filter((p) => p.trim() !== "");
            const folderName = parts[parts.length - 1];
            const match = folderName.match(/^(comp)(\d+)$/i);
            if (match) {
              finalDbPath = `BusyComp${match[2]}_db12025`;
            } else {
              finalDbPath = `Busy${folderName}_db12025`;
            }
          } catch (e) {
            console.warn("[MSSQL] Failed to transform path to DB name, using original:", dbPath);
          }
        }
        const args = [
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          psPath,
          "-Action",
          action,
          "-Data",
          data,
          "-DbPath",
          finalDbPath,
          "-DbPassword",
          dbPass,
          "-DbType",
          dbType,
          "-DbServer",
          dbServer,
          "-DbUser",
          dbUser
        ];
        const ps = spawn("powershell", args, { windowsHide: true });
        let stdout = "";
        let stderr = "";
        ps.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        ps.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        ps.on("close", (code) => {
          if (code !== 0) return reject(new Error(`PowerShell Bridge [${action}] exited with code ${code}: ${stderr}`));
          try {
            const cleanOut = stdout.trim();
            if (!cleanOut) return resolve([]);
            const parsed = JSON.parse(cleanOut);
            if (action === "RESOLVE_PATH" && parsed.path) return resolve(parsed.path);
            resolve(parsed);
          } catch (e) {
            console.error(`Failed to parse DB output for [${action}]:`, stdout);
            reject(new Error(`Database output parsing failed for ${action}: ` + e.message));
          }
        });
      });
    }
    var BusyService2 = {
      // Accessor for the main config
      getConfig() {
        return busyConfig;
      },
      // 1. Get Group Structure
      async getTargetAccounts(firm) {
        try {
          console.log(`Scanning [${firm.name}] for group: ${firm.targetGroup}`);
          const allHelp = await runPsQuery("GET_ACCOUNTS", "", firm);
          const rootGroup = allHelp.find((h) => h.NameAlias && h.NameAlias.toLowerCase() === firm.targetGroup.toLowerCase());
          if (!rootGroup) return [];
          const rootGroupId = rootGroup.Code;
          const childrenMap = {};
          const nameMap = {};
          allHelp.forEach((row) => {
            const p = row.ParentGroup;
            if (!childrenMap[p]) childrenMap[p] = [];
            childrenMap[p].push(row.Code);
            nameMap[row.Code] = row.NameAlias;
          });
          const descendants = /* @__PURE__ */ new Set();
          let queue = [rootGroupId];
          while (queue.length > 0) {
            const current = queue.shift();
            if (childrenMap[current]) {
              childrenMap[current].forEach((k) => {
                descendants.add(k);
                queue.push(k);
              });
            }
          }
          const result = Array.from(descendants).map((code) => ({ Code: code, Name: nameMap[code] })).sort((a, b) => (a.Name || "").localeCompare(b.Name || ""));
          if (firm.specificParties && Array.isArray(firm.specificParties) && firm.specificParties.length > 0) {
            const allowed = new Set(firm.specificParties.map(String));
            const filtered = result.filter((a) => allowed.has(String(a.Code)));
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
          const allHelp = await runPsQuery("GET_ACCOUNTS", "", firm);
          let parentCode = typeof parentNameOrCode === "number" ? parentNameOrCode : null;
          let parentName = typeof parentNameOrCode === "string" ? parentNameOrCode : null;
          const pNode = allHelp.find(
            (h) => String(h.Code) === String(parentNameOrCode) || h.NameAlias && h.NameAlias.toLowerCase() === String(parentNameOrCode).toLowerCase()
          );
          if (pNode) {
            parentCode = pNode.Code;
            parentName = pNode.NameAlias;
          }
          if (!parentCode) return { subgroups: [], accounts: [] };
          const childrenMap = {};
          allHelp.forEach((row) => {
            const parent = String(row.ParentGroup);
            if (!childrenMap[parent]) childrenMap[parent] = [];
            childrenMap[parent].push(row);
          });
          const subgroups = [];
          const seenGroups = /* @__PURE__ */ new Set();
          const direct = (childrenMap[String(parentCode)] || []).concat(childrenMap[parentName] || []);
          direct.forEach((child) => {
            if (child.MasterType === 1 && !seenGroups.has(child.Code)) {
              subgroups.push({ Code: child.Code, Name: child.NameAlias });
              seenGroups.add(child.Code);
            }
          });
          const accounts = [];
          const seenAccounts = /* @__PURE__ */ new Set();
          let queue = [parentCode];
          while (queue.length > 0) {
            const current = queue.shift();
            const children = childrenMap[String(current)] || [];
            children.forEach((child) => {
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
          const res = await runPsQuery("GET_BALANCE", String(code), firm);
          return res.Balance || 0;
        } catch (e) {
          return 0;
        }
      },
      // 4. Formatting Helper
      _formatBills(rawBills, liveBalance = 0, firm, isCreditor = false) {
        const bills = Array.isArray(rawBills) ? rawBills : rawBills ? [rawBills] : [];
        const billMap = {};
        bills.forEach((b) => {
          const isBill = b.Method == 1 || b.VchCode == 0;
          const isActivePDC = b.IsActivePDC === 1;
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
            billMap[key].RefColumnAmt += Math.abs(b.Value1);
            billMap[key].OriginalAmt += Math.abs(b.NewRefAmount || b.Value3 || b.Value1);
          }
          if (isActivePDC) {
            billMap[key].PDCAmt += Math.abs(b.Value1 || 0);
          } else {
            billMap[key].PendingAmt += b.Value1;
          }
          billMap[key].Items.push({ ...b, isActivePDC });
        });
        const formattedBills = [];
        const parsePsDate = (d) => {
          if (!d) return null;
          if (typeof d === "string" && d.includes("/Date(")) {
            const m = d.match(/\/Date\((\d+)\)\//);
            if (m) return new Date(parseInt(m[1]));
          }
          return new Date(d);
        };
        let onAccountTotal = 0;
        Object.values(billMap).forEach((group) => {
          const hasActivePDC = group.Items.some((i) => i.isActivePDC);
          group.hasActivePDC = hasActivePDC;
          if (Math.abs(group.PendingAmt) > 0.1 || Math.abs(group.PDCAmt) > 0.1) {
            const due = Math.abs(group.PendingAmt);
            const dateObj = parsePsDate(group.Date);
            const dueObj = parsePsDate(group.DueDate);
            const now = /* @__PURE__ */ new Date();
            now.setHours(0, 0, 0, 0);
            let days = 0;
            const basis = firm?.dueDayBasis || "due";
            let compareDate;
            if (basis === "bill") {
              compareDate = dateObj;
            } else {
              compareDate = dueObj && !isNaN(dueObj.getTime()) ? dueObj : dateObj;
            }
            if (compareDate && !isNaN(compareDate.getTime())) {
              days = Math.floor((now - compareDate) / (1e3 * 60 * 60 * 24));
            }
            let type = "Ref";
            if (group.Items && group.Items.length > 0) {
              const first = group.Items[0];
              type = first.VchCode === 0 ? "OpBl" : first.Method === 1 ? "SALES" : first.Method >= 3 ? "Rcpt" : "Adj";
            }
            if (group.RefNo === "On Account") {
              onAccountTotal = group.PendingAmt;
            }
            const isDue = days > 0 && Math.abs(group.PendingAmt) > 0.1 ? "Y" : "N";
            const isPDC = group.hasActivePDC || Math.abs(group.PDCAmt) > 0.1;
            formattedBills.push({
              Date: dateObj && !isNaN(dateObj.getTime()) ? dateObj.toLocaleDateString("en-GB").replace(/\//g, "-") : group.Date,
              Type: type,
              No: isPDC ? `*${group.RefNo}` : group.RefNo,
              RefAmt: group.RefColumnAmt || group.OriginalAmt,
              BalAmt: group.PendingAmt,
              DueStatus: isDue,
              DueDate: dueObj && !isNaN(dueObj.getTime()) ? dueObj.toLocaleDateString("en-GB").replace(/\//g, "-") : "",
              Days: days,
              isPDC,
              OrgAmt: group.OriginalAmt,
              isOnAccount: group.RefNo === "On Account"
            });
          }
        });
        let finalTotalDue = 0;
        let finalTotalRef = 0;
        formattedBills.forEach((b) => {
          finalTotalDue += b.BalAmt || 0;
          finalTotalRef += b.RefAmt || 0;
        });
        const absLiveBalance = Math.abs(liveBalance);
        const balanceSide = liveBalance === 0 ? "" : liveBalance < 0 ? "Dr" : "Cr";
        return {
          totalDue: finalTotalDue,
          totalRef: finalTotalRef,
          bills: formattedBills,
          liveBalance: absLiveBalance,
          balanceSide,
          onAccountTotal
        };
      },
      // 5. PDF Generation
      async generatePdf(accountName, address, bills, totalDue, totalRef, liveBalance, balanceSide, onAccountTotal = 0, firm, isCreditor = false) {
        let profile = await this.getCompanyProfile(firm);
        const compName = profile?.Name || firm.companyName || "Your Company";
        const compAddr = profile?.Address || firm.companyAddress || "";
        const compGst = profile?.GSTNo || firm.companyGst || "";
        const reportDate = (/* @__PURE__ */ new Date()).toLocaleDateString("en-GB");
        let docTitle = "PAYMENT REMINDER STATEMENT";
        const rType = firm.reminderType || "due";
        if (rType === "balance") docTitle = "PAYMENT SUMMARY STATEMENT";
        else if (rType === "pending") docTitle = "DETAILED OUTSTANDING STATEMENT";
        else if (rType === "due") docTitle = "OVERDUE PAYMENT REMINDER";
        let runningBal = 0;
        const billsWithRun = bills.map((b) => {
          runningBal += b.BalAmt || 0;
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
                    ${billsWithRun.map((b) => `
                        <tr>
                            <td>${b.Date}</td>
                            <td>${b.Type}</td>
                            <td>
                                ${b.No}
                                ${b.isPDC && Math.abs(b.OrgAmt - b.BalAmt) > 1 ? `<br/><span style="font-size: 9px; color: #4b5563;">Org. Amt. ${b.OrgAmt.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>` : ""}
                            </td>
                            <td class="text-right">${b.RefAmt.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
                            <td class="text-right" style="font-weight: 700;">${Math.abs(b.BalAmt).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
                            <td class="text-right" style="font-weight: 700; color: #4b5563;">${Math.abs(b.RunBal).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
                            <td class="text-right" style="font-weight: 700;">${b.DueStatus}</td>
                            <td class="text-right">${b.DueDate}</td>
                            <td class="text-right">${b.Days}</td>
                        </tr>
                    `).join("")}
                    <tr style="font-weight: 700; border-top: 2px solid #374151; page-break-inside: avoid;">
                        <td colspan="3" class="text-right" style="padding-top: 15px;">Grand Total</td>
                        <td class="text-right" style="padding-top: 15px; border-bottom: 2px solid #374151;">${totalRef.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
                        <td class="text-right" style="padding-top: 15px; border-bottom: 2px solid #374151;">${Math.abs(totalDue).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
                        <td colspan="4"></td>
                    </tr>
                </tbody>
            </table>
            
            <div style="margin-top: 40px; font-weight: 700; font-size: 14px; line-height: 1.8;">
                <div>( On Acc. : &nbsp;&nbsp;${Math.abs(onAccountTotal).toLocaleString("en-IN", { minimumFractionDigits: 2 })} ${onAccountTotal === 0 ? "" : onAccountTotal < 0 ? "Dr" : "Cr"} )</div>
                <div>( Ledger Bal. : &nbsp;&nbsp;${Math.abs(liveBalance).toLocaleString("en-IN", { minimumFractionDigits: 2 })} ${balanceSide} &nbsp;&nbsp;)</div>
            </div>
        </body>
        </html > `;
        const outputDir = path2.join(appDir2, "uploads");
        if (!fs2.existsSync(outputDir)) fs2.mkdirSync(outputDir, { recursive: true });
        let safeName = accountName.replace(/[^a-z0-9]/gi, " ").replace(/\s+/g, " ").trim();
        const outputPath = path2.join(outputDir, `Stmt ${safeName}.pdf`);
        const launchOptions = {
          headless: "new",
          args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
        };
        if (process.pkg) {
          const commonPaths = [
            path2.join(appDir2, "chrome-win", "chrome.exe"),
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
          ];
          for (const p of commonPaths) {
            if (fs2.existsSync(p)) {
              launchOptions.executablePath = p;
              break;
            }
          }
        }
        const browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();
        await page.setContent(htmlContent);
        await page.pdf({
          path: outputPath,
          format: "A4",
          printBackground: true,
          displayHeaderFooter: true,
          headerTemplate: "<div></div>",
          footerTemplate: `
    <div style="font-family: 'Inter', system-ui, sans-serif; font-size: 9px; color: #9ca3af; width: 100%; padding: 0 40px; display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #f3f4f6;">
                    <div>This is a computer-generated statement and does not require a signature.</div>
                    <div>Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>
                </div>`,
          margin: { top: "40px", bottom: "60px", left: "40px", right: "40px" }
        });
        await browser.close();
        return outputPath;
      },
      // 6. Bulk Send Job
      async runBulkReminders(firm, logCallback) {
        logCallback("info", `Starting Optimization for [${firm.name}]...`);
        try {
          const accounts = await this.getTargetAccounts(firm);
          if (accounts.length === 0) {
            logCallback("info", `No accounts found for [${firm.name}].`);
            return;
          }
          const codes = accounts.map((a) => a.Code).join(",");
          const [balancesRaw, contactData, allBillsRaw] = await Promise.all([
            runPsQuery("GET_BALANCES_BULK", codes, firm),
            runPsQuery("GET_CONTACT_BULK", codes, firm),
            runPsQuery("GET_BILLS_BULK", codes, firm)
          ]);
          const balanceMap = {};
          if (balancesRaw) {
            (Array.isArray(balancesRaw) ? balancesRaw : [balancesRaw]).forEach((b) => {
              balanceMap[b.Code] = {
                balance: b.Balance || 0,
                pdcAmt: b.PDCAmt || 0
              };
            });
          }
          const contactMap = {};
          const rawAddr = contactData.AddressInfo || [];
          const addrInfos = Array.isArray(rawAddr) ? rawAddr : [rawAddr];
          addrInfos.forEach((a) => {
            const code = String(a.MasterCode || a.Code || "").trim();
            if (code) {
              contactMap[code] = {
                Mobile: a.Mobile || a.WhatsAppNo || a.WhatsAppno || "",
                Address: [a.Address1, a.Address2, a.Station].filter(Boolean).join(", "),
                ParentGroup: a.ParentGroup || ""
              };
            }
          });
          const billsMap = {};
          (Array.isArray(allBillsRaw) ? allBillsRaw : [allBillsRaw]).forEach((b) => {
            if (!billsMap[b.MasterCode1]) billsMap[b.MasterCode1] = [];
            billsMap[b.MasterCode1].push(b);
          });
          let sent = 0;
          for (const acc of accounts) {
            const bData = balanceMap[acc.Code];
            if (!bData) {
              continue;
            }
            const totalBal = bData.balance || 0;
            const pdcBal = Math.abs(bData.pdcAmt || 0);
            if (Math.abs(totalBal) <= 1 && pdcBal <= 1) {
              continue;
            }
            const contact = contactMap[String(acc.Code)];
            const parentGroup = contact ? String(contact.ParentGroup || "").toLowerCase() : "";
            const targetGroup = firm.targetGroup ? firm.targetGroup.toLowerCase() : "";
            let isCreditor = false;
            if (parentGroup.includes("creditor")) isCreditor = true;
            else if (parentGroup.includes("debtor")) isCreditor = false;
            else isCreditor = targetGroup.includes("creditor");
            const liveBalance = Math.abs(totalBal);
            let balanceSide = totalBal === 0 ? "" : totalBal < 0 ? "Dr" : "Cr";
            const { bills, totalDue, totalRef, onAccountTotal } = this._formatBills(billsMap[acc.Code] || [], totalBal, firm, isCreditor);
            if (totalDue !== 0 || liveBalance !== 0) {
              if (totalDue !== 0 || liveBalance !== 0) {
                const contact2 = contactMap[String(acc.Code)];
                const rawMob = contact2 ? contact2.Mobile || contact2.Phone : null;
                const validNumbers = this.parseMobileNumbers(rawMob);
                if (validNumbers.length > 0) {
                  const accountName = `${acc.Name}${pdcBal > 1 ? "*" : ""} `;
                  const onAccountSide = onAccountTotal === 0 ? "" : onAccountTotal < 0 ? "Dr" : "Cr";
                  const message = `Dear ${acc.Name}, 

Your outstanding balance with ${firm.name} is \u20B9${liveBalance.toLocaleString("en-IN", { minimumFractionDigits: 2 })} ${balanceSide}.
${Math.abs(onAccountTotal) > 1 ? `(Including On Account: \u20B9${Math.abs(onAccountTotal).toLocaleString("en-IN", { minimumFractionDigits: 2 })} ${onAccountSide})
` : ""}Please find the detailed statement attached.`;
                  const pdfPath = await this.generatePdf(accountName, contact2 ? contact2.Address : "", bills, totalDue, totalRef, liveBalance, balanceSide, onAccountTotal, firm, isCreditor);
                  for (const mob of validNumbers) {
                    await logCallback("queue_job", "Queuing...", {
                      number: mob,
                      message,
                      filePath: pdfPath,
                      whatsappClientId: firm.whatsappClientId || "default"
                    });
                    sent++;
                  }
                }
              }
            }
          }
          logCallback("success", `[${firm.name}]processed.Queued: ${sent} `);
        } catch (e) {
          logCallback("error", `[${firm.name}] bulk job failed: ` + e.message);
        }
      },
      // Helper: Parse Multiple Mobile Numbers
      parseMobileNumbers(rawInput) {
        if (!rawInput) return [];
        const input = String(rawInput || "").trim();
        const results = /* @__PURE__ */ new Set();
        const chunks = input.split(/[^0-9]+/);
        chunks.forEach((chunk) => {
          if (!chunk) return;
          if (chunk.length >= 20 && chunk.length % 10 === 0) {
            for (let i = 0; i < chunk.length; i += 10) {
              const sub = chunk.substring(i, i + 10);
              if (sub.length === 10) results.add("91" + sub);
            }
          } else {
            let clean = chunk;
            if (clean.length === 10) clean = "91" + clean;
            else if (clean.length === 12 && clean.startsWith("91")) {
            } else if (clean.length === 11 && clean.startsWith("0")) clean = "91" + clean.substring(1);
            if (clean.length === 12 && clean.startsWith("91")) {
              results.add(clean);
            }
          }
        });
        return Array.from(results);
      },
      // 7. Scan Preview
      async scanAndPreview(firm) {
        const accounts = await this.getTargetAccounts(firm);
        const codes = accounts.map((a) => a.Code).join(",");
        const [balancesRaw, contactData] = await Promise.all([
          runPsQuery("GET_BALANCES_BULK", codes, firm),
          runPsQuery("GET_CONTACT_BULK", codes, firm)
        ]);
        const balanceMap = {};
        if (balancesRaw) {
          (Array.isArray(balancesRaw) ? balancesRaw : [balancesRaw]).forEach((b) => {
            balanceMap[b.Code] = {
              balance: b.Balance || 0,
              pdcAmt: b.PDCAmt || 0
            };
          });
        }
        const contactMap = {};
        const rawAddr = contactData.AddressInfo || [];
        const addrInfos = Array.isArray(rawAddr) ? rawAddr : [rawAddr];
        addrInfos.forEach((a) => {
          const code = String(a.MasterCode || a.Code || "").trim();
          if (code) {
            contactMap[code] = {
              Mobile: a.Mobile || a.WhatsAppNo || a.WhatsAppno || "",
              Address: a.Address1,
              ParentGroup: a.ParentGroup || ""
            };
          }
        });
        return accounts.filter((a) => {
          const b = balanceMap[a.Code];
          if (!b) return false;
          return Math.abs(b.balance) > 1 || Math.abs(b.pdcAmt) > 1;
        }).map((a) => {
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
          const type = totalBal === 0 ? "" : totalBal < 0 ? "Dr" : "Cr";
          const hasPDC = Math.abs(b.pdcAmt) > 1;
          const rawMob = contact?.Mobile || "";
          const validNumbers = this.parseMobileNumbers(rawMob);
          const displayMob = validNumbers.length > 0 ? validNumbers.map((n) => n.substring(2)).join(", ") : rawMob || "N/A";
          return {
            code: a.Code,
            name: hasPDC ? `* ${a.Name} ` : a.Name,
            due: bal.toFixed(2),
            type,
            mobile: displayMob,
            originalMobile: rawMob,
            // Keep raw for debugging/editing if needed
            hasPDC
          };
        });
      },
      // 8. Resolve Database Path
      async resolvePath(firm) {
        try {
          return await runPsQuery("RESOLVE_PATH", "", firm);
        } catch (e) {
          return null;
        }
      },
      // 9. Get Company Profile (Auto-pick)
      async getCompanyProfile(firm) {
        try {
          const data = await runPsQuery("GET_COMPANY_INFO", "", firm);
          return data && data.Name ? data : null;
        } catch (e) {
          return null;
        }
      },
      // 10. Firm Management
      getFirms() {
        return busyConfig.firms;
      },
      addFirm() {
        const f = createNewFirm();
        busyConfig.firms.push(f);
        saveConfig();
        return f;
      },
      updateFirm(id, data) {
        const idx = busyConfig.firms.findIndex((f) => f.id === id);
        if (idx !== -1) {
          busyConfig.firms[idx] = { ...busyConfig.firms[idx], ...data };
          saveConfig();
          return true;
        }
        return false;
      },
      deleteFirm(id) {
        busyConfig.firms = busyConfig.firms.filter((f) => f.id !== id);
        saveConfig();
        return true;
      }
    };
    module2.exports = {
      ...BusyService2,
      runPsQuery
    };
  }
});

// server.js
var express = require("express");
var axios = require("axios");
var { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
var qrcode = require("qrcode");
var fs = require("fs");
var path = require("path");
var Busboy = require("busboy");
var XLSX = require("xlsx");
var crypto = require("crypto");
var https = require("https");
var BusyService = require_busy_service();
var cron = require("node-cron");
var dns = require("dns");
var { machineIdSync } = require("node-machine-id");
var app = express();
var port = 5e3;
var appDir = process.pkg ? path.dirname(process.execPath) : __dirname;
var MACHINE_ID = machineIdSync();
console.log(`\u{1F4BB} Machine ID: ${MACHINE_ID}`);
var queueFile = path.join(appDir, "queue.json");
var logsFile = path.join(appDir, "logs.json");
var licenseFile = path.join(appDir, "license.key");
process.on("uncaughtException", (err) => {
  console.error("CRITICIAL ERROR (Uncaught Exception):", err);
  try {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const msg = `[${timestamp}] [ERROR] CRITICIAL ERROR (Uncaught Exception): ${err.message}
${err.stack}
`;
    fs.appendFileSync(path.join(appDir, "server_error.log"), msg);
    if (typeof addLog === "function") {
      addLog("error", "CRITICAL SERVER ERROR", { error: err.message, stack: err.stack });
    }
  } catch (e) {
    console.error("Failed to log critical error:", e);
  }
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  try {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const msg = `[${timestamp}] [ERROR] Unhandled Rejection: ${reason}
`;
    fs.appendFileSync(path.join(appDir, "server_error.log"), msg);
    if (typeof addLog === "function") {
      addLog("error", "Unhandled Rejection", { reason: reason ? reason.message || reason : "Unknown" });
    }
  } catch (e) {
    console.error("Failed to log unhandled rejection:", e);
  }
});
var logsHistory = [];
var MAX_LOGS = 1e3;
function addLog(type, message, data = null) {
  const logEntry = {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    type,
    // 'info', 'success', 'error', 'warning', 'send', 'queue'
    message,
    data
  };
  logsHistory.push(logEntry);
  const icon = type === "success" ? "\u2705" : type === "error" ? "\u274C" : type === "warning" ? "\u26A0\uFE0F" : type === "queue" ? "\u{1F4E4}" : "\u2139\uFE0F";
  console.log(`${icon} [${(/* @__PURE__ */ new Date()).toLocaleTimeString()}] ${message}`, data ? JSON.stringify(data) : "");
  if (logsHistory.length > MAX_LOGS) {
    logsHistory.shift();
  }
  saveLogs();
  return logEntry;
}
function loadLogs() {
  if (!fs.existsSync(logsFile)) return [];
  try {
    const data = fs.readFileSync(logsFile, "utf8");
    const parsed = JSON.parse(data);
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
logsHistory = loadLogs();
var config = {};
var configFile = path.join(appDir, "config.json");
try {
  if (fs.existsSync(configFile)) {
    config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  }
} catch (err) {
  console.error("Error loading config.json:", err.message);
}
var LICENSE_SERVER_URL = "https://script.google.com/macros/s/AKfycbxRG7SAHf3o1-gTygl08lWldvEmJ9aOsgMl40ZoGps5EhG6pxrnuo9TBjQFpg1JKh6JMg/exec";
var formatMobileNumber = (mobile) => {
  if (!mobile) return null;
  const cleaned = String(mobile).replace(/\D/g, "");
  if (cleaned.length < 10) return null;
  if (cleaned.startsWith("91")) return cleaned;
  return "91" + cleaned;
};
var RECENT_REQUEST_WINDOW = 1e4;
var recentRequests = /* @__PURE__ */ new Map();
async function validateRemoteLicense() {
  if (!config.license_email) {
    return {
      valid: false,
      error: "License email not configured. Please configure Email in Settings."
    };
  }
  try {
    console.log(`\u{1F30D} verifying license for ${config.license_email} via Google Sheet...`);
    const response = await axios.get(LICENSE_SERVER_URL, {
      params: {
        email: config.license_email,
        machineId: MACHINE_ID
      },
      timeout: 1e4,
      // 10s timeout
      httpsAgent: new https.Agent({
        rejectUnauthorized: false
        // ALLOW SELF-SIGNED CERTS / HTTP DEBUGGERS
      })
    });
    const data = response.data;
    if (data.valid) {
      return {
        valid: true,
        expirationDate: data.expirationDate,
        daysRemaining: data.daysRemaining,
        email: config.license_email,
        type: "remote"
      };
    } else {
      return {
        valid: false,
        error: data.error || "Remote validation failed",
        type: "remote"
      };
    }
  } catch (err) {
    console.error("\u274C Remote license check failed:", err.message);
    return {
      valid: false,
      error: "Connection to license server failed: " + err.message,
      networkError: true,
      type: "remote"
    };
  }
}
var cachedLicenseResult = null;
var lastLicenseCheckTime = 0;
var LICENSE_CACHE_DURATION = 1e3 * 60 * 60;
async function checkLicense(force = false) {
  const now = Date.now();
  if (!force && cachedLicenseResult && now - lastLicenseCheckTime < LICENSE_CACHE_DURATION) {
    return cachedLicenseResult;
  }
  const remoteValidation = await validateRemoteLicense();
  if (remoteValidation.valid) {
    console.log(`\u2705 Remote License Active for ${remoteValidation.email}. Days remaining: ${remoteValidation.daysRemaining}`);
    cachedLicenseResult = remoteValidation;
    lastLicenseCheckTime = now;
    return remoteValidation;
  } else {
    if (remoteValidation.networkError) {
      console.log(`\u26A0\uFE0F Network error checking license. Allowing temporary grace access.`);
      return {
        valid: true,
        // Allow access
        expirationDate: "Unknown (Offline Mode)",
        daysRemaining: 1,
        // Show 1 day remaining
        email: config.license_email,
        warning: "Offline Mode (License Check Failed)",
        type: "grace"
      };
    }
    console.log(`\u274C Remote License Valid failed: ${remoteValidation.error}`);
    cachedLicenseResult = remoteValidation;
    lastLicenseCheckTime = now;
    return remoteValidation;
  }
}
function getChromeExecutablePath() {
  const possiblePaths = [
    path.join(appDir, "chrome-win", "chrome.exe"),
    path.join(appDir, "..", "chrome-win", "chrome.exe"),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      console.log(`\u2705 Found browser at: ${p}`);
      return p;
    }
  }
  console.log("\u26A0\uFE0F Could not find a local browser (Chrome/Edge). Puppeteer might fail if not bundled.");
  return null;
}
var clients = /* @__PURE__ */ new Map();
var clientsClearingSession = /* @__PURE__ */ new Set();
var BASE_PORT = 5e3;
var clientPorts = /* @__PURE__ */ new Map();
var clientNames = /* @__PURE__ */ new Map();
var clientServers = /* @__PURE__ */ new Map();
var CLIENT_PORTS_FILE = path.join(appDir, "client_ports.json");
var CLIENT_NAMES_FILE = path.join(appDir, "client_names.json");
clientPorts.set("default", BASE_PORT);
function loadClientPorts() {
  try {
    if (fs.existsSync(CLIENT_PORTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CLIENT_PORTS_FILE, "utf8"));
      for (const [id, port2] of Object.entries(data)) {
        clientPorts.set(id, port2);
      }
      console.log("\u{1F4CB} Restored client port assignments:", Object.fromEntries(clientPorts));
    }
  } catch (err) {
    console.error("Error loading client ports:", err.message);
  }
}
function saveClientPorts() {
  try {
    const data = {};
    for (const [id, port2] of clientPorts.entries()) {
      data[id] = port2;
    }
    fs.writeFileSync(CLIENT_PORTS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Error saving client ports:", err.message);
  }
}
function loadClientNames() {
  try {
    if (fs.existsSync(CLIENT_NAMES_FILE)) {
      const data = JSON.parse(fs.readFileSync(CLIENT_NAMES_FILE, "utf8"));
      for (const [id, name2] of Object.entries(data)) {
        clientNames.set(id, name2);
      }
      console.log("\u{1F4CB} Restored client name assignments:", Object.fromEntries(clientNames));
    }
  } catch (err) {
    console.error("Error loading client names:", err.message);
  }
}
function saveClientNames() {
  try {
    const data = {};
    for (const [id, name2] of clientNames.entries()) {
      data[id] = name2;
    }
    fs.writeFileSync(CLIENT_NAMES_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Error saving client names:", err.message);
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
loadClientPorts();
loadClientNames();
function getOrCreateClient(clientId, name = null) {
  if (clients.has(clientId)) {
    return clients.get(clientId);
  }
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
  if (clientName && clientNames.get(clientId) !== clientName) {
    clientNames.set(clientId, clientName);
    saveClientNames();
  }
  console.log(`\u{1F916} Initializing WhatsApp client: ${clientId} (${clientName})`);
  const clientAuthPath = path.join(appDir, ".wwebjs_auth");
  const clientInstance = new Client({
    authStrategy: new LocalAuth({
      clientId,
      dataPath: clientAuthPath
    }),
    webVersionCache: {
      type: "local"
    },
    puppeteer: {
      executablePath: getChromeExecutablePath(),
      headless: true,
      dumpio: false,
      pipe: true,
      args: [
        "--no-proxy-server",
        "--proxy-server=direct://",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-software-rasterizer",
        "--ignore-certificate-errors",
        "--ignore-certificate-errors-spki-list",
        "--disable-features=IsolateOrigins,site-per-process",
        "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding"
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
    clientInfo.qrCodeBase64 = null;
    clientInfo.qrCodeData = null;
    console.log(`\u{1F511} Pairing Code received for [${clientInfo.name}]: ${code}`);
    addLog("info", `Pairing code received for client ${clientInfo.name}: ${code}`);
  });
  clientInstance.on("qr", async (qr) => {
    clientInfo.status = "authenticating";
    clientInfo.qrCodeData = qr;
    clientInfo.pairingCode = null;
    try {
      clientInfo.qrCodeBase64 = await qrcode.toDataURL(qr);
      addLog("info", `QR Code received for client ${clientInfo.name}`);
    } catch (err) {
      console.error(`Error generating QR code for ${clientId}:`, err.message);
    }
  });
  clientInstance.on("loading_screen", (percent, message) => {
    clientInfo.status = "authenticating";
    console.log(`\u23F3 [${clientInfo.name}] Loading: ${percent}% - ${message}`);
    addLog("info", `[${clientInfo.name}] Loading: ${percent}% - ${message}`);
  });
  clientInstance.on("authenticated", () => {
    clientInfo.status = "authenticating";
    console.log(`\u2705 [${clientInfo.name}] WhatsApp authenticated`);
    addLog("success", `[${clientInfo.name}] WhatsApp authenticated`);
  });
  clientInstance.on("auth_failure", (msg) => {
    console.error(`\u274C [${clientInfo.name}] Authentication failure:`, msg);
    clientInfo.status = "disconnected";
    clientInfo.qrCodeBase64 = null;
    clientInfo.qrCodeData = null;
    clientInfo.isReady = false;
    addLog("error", `[${clientInfo.name}] Authentication failure`, { message: msg });
  });
  clientInstance.on("ready", () => {
    console.log(`\u2705 [${clientInfo.name}] WhatsApp Client is ready!`);
    clientInfo.status = "ready";
    clientInfo.isReady = true;
    clientInfo.qrCodeBase64 = null;
    clientInfo.qrCodeData = null;
    clientInfo.pairingCode = null;
    if (clientInstance.info && clientInstance.info.wid) {
      clientInfo.number = clientInstance.info.wid.user;
      console.log(`\u{1F4DE} Linked number for [${clientInfo.name}]: ${clientInfo.number}`);
      addLog("success", `WhatsApp Client [${clientInfo.name}] is ready (+${clientInfo.number})`);
    } else {
      addLog("success", `WhatsApp Client [${clientInfo.name}] is ready`);
    }
    processQueue();
  });
  clientInstance.on("disconnected", async (reason) => {
    if (clientsClearingSession.has(clientId)) {
      console.log(`\u2139\uFE0F [${clientInfo.name}] Client disconnected during session clear (intentional). Ignoring auto-reconnect.`);
      return;
    }
    console.log(`\u26A0\uFE0F [${clientInfo.name}] WhatsApp Client disconnected:`, reason);
    addLog("warning", `[${clientInfo.name}] Client disconnected, attempting to reconnect...`, { reason });
    clientInfo.status = "authenticating";
    clientInfo.isReady = false;
    clientInfo.qrCodeBase64 = null;
    clientInfo.qrCodeData = null;
    clientInfo.pairingCode = null;
    try {
      await clientInstance.destroy();
    } catch (e) {
    }
    setTimeout(() => {
      if (clients.has(clientId)) {
        clientInstance.initialize().catch((err) => {
          console.error(`Failed to auto-reconnect client ${clientId}:`, err);
          clientInfo.status = "disconnected";
        });
      }
    }, 1e3);
  });
  return clientInfo;
}
var http = require("http");
function startClientSubServer(clientId) {
  if (clientId === "default") return;
  if (clientServers.has(clientId)) return;
  const assignedPort = clientPorts.get(clientId);
  if (!assignedPort) {
    console.warn(`\u26A0\uFE0F No port assigned for client ${clientId}. Skipping sub-server.`);
    return;
  }
  const subApp = express();
  subApp.use(express.json());
  subApp.use(express.urlencoded({ extended: true }));
  const clientInfo = clients.get(clientId);
  const accountName = clientInfo ? clientInfo.name : clientId;
  subApp.get("/status", (req, res) => {
    const info = clients.get(clientId);
    if (!info) return res.json({ success: false, status: "not_found" });
    res.json({
      success: true,
      status: info.status,
      ready: info.isReady,
      number: info.number,
      name: info.name,
      port: assignedPort
    });
  });
  subApp.get("/qr", (req, res) => {
    const info = clients.get(clientId);
    if (!info) return res.status(404).json({ success: false, error: "Client not found" });
    if (!info.qrCodeBase64) {
      return res.json({ success: false, error: info.isReady ? "Already connected" : "QR not yet generated" });
    }
    res.json({ success: true, qr: info.qrCodeBase64 });
  });
  const addJobToSubQueue = (mobile, message, filePath, res) => {
    const mobileNumber = formatMobileNumber(mobile);
    if (!mobileNumber) {
      return res.status(400).json({ success: false, error: "Invalid mobile number" });
    }
    const dedupeKey = `${mobileNumber}:${message}`;
    const now = Date.now();
    if (recentRequests.has(dedupeKey)) {
      const lastTime = recentRequests.get(dedupeKey);
      if (now - lastTime < RECENT_REQUEST_WINDOW) {
        if (filePath && fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch (e) {
          }
        }
        return res.json({ success: true, message: "Duplicate request ignored", to: mobileNumber });
      }
    }
    recentRequests.set(dedupeKey, now);
    const jobId = `${mobileNumber}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const job = {
      id: jobId,
      number: mobileNumber,
      message: message || "",
      filePath: filePath || null,
      status: "pending",
      whatsappClientId: clientId,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      retryCount: 0,
      isPriority: true
    };
    messageQueue.unshift(job);
    saveQueue(messageQueue);
    processQueue();
    addLog("info", `[Port ${assignedPort}] Message queued for ${mobileNumber} via ${accountName}${filePath ? " (with file)" : ""}`);
    res.json({ success: true, jobId, queued: true, to: mobileNumber, port: assignedPort });
  };
  const sendHandler = (req, res) => {
    if (req.is("multipart/form-data")) {
      let busboy2;
      try {
        busboy2 = Busboy({ headers: req.headers });
      } catch (e) {
        return res.status(400).json({ success: false, error: "Invalid multipart request" });
      }
      const fields = {};
      const files = [];
      busboy2.on("field", (name, val) => {
        fields[name] = val;
      });
      busboy2.on("file", (name, file, info) => {
        const { filename } = info;
        const uploadsDir = path.join(appDir, "uploads");
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
        let saveTo = path.join(uploadsDir, filename);
        let counter = 1;
        while (fs.existsSync(saveTo)) {
          const p = path.parse(filename);
          saveTo = path.join(uploadsDir, `${p.name}_${String(counter).padStart(2, "0")}${p.ext}`);
          counter++;
        }
        file.pipe(fs.createWriteStream(saveTo));
        files.push({ path: saveTo });
      });
      busboy2.on("finish", () => {
        const findF = (names) => {
          for (const n of names) {
            const k = Object.keys(fields).find((k2) => k2.toLowerCase() === n.toLowerCase());
            if (k) return fields[k];
          }
          return null;
        };
        const mobile2 = findF(["Mobile", "mobile", "number", "phone"]);
        const message2 = findF(["Message", "message", "msg", "text"]) || "";
        const filePath2 = files.length > 0 ? files[0].path : null;
        addJobToSubQueue(mobile2, message2, filePath2, res);
      });
      return req.pipe(busboy2);
    }
    const params = Object.assign({}, req.query || {}, req.body || {});
    const mobile = params.Mobile || params.mobile || params.number || params.phone;
    const message = params.Message || params.message || params.msg || params.text || "";
    let filePath = params.pdfPath || params.filePath || params.attachment || params.file || params.pdf || params.PDFPATH || null;
    if (filePath && (filePath.trim() === "<PDFPATH>" || filePath.includes("<") && filePath.includes(">"))) {
      filePath = null;
    }
    if (filePath && !fs.existsSync(filePath)) {
      addLog("warning", `[Port ${assignedPort}] PDF path not found on disk: ${filePath}`);
      filePath = null;
    }
    if (!mobile) {
      return res.status(400).json({ success: false, error: "Mobile number is required (param: Mobile)" });
    }
    addJobToSubQueue(mobile, message, filePath, res);
  };
  subApp.all("/send", sendHandler);
  subApp.all("/api/v1/send", sendHandler);
  const subPairingHandler = async (req, res) => {
    try {
      const params = Object.assign({}, req.query || {}, req.body || {});
      const phoneNumber = params.phoneNumber || params.number || params.phone;
      if (!phoneNumber) {
        return res.status(400).json({ success: false, error: "Phone number is required (param: phoneNumber)" });
      }
      const info = clients.get(clientId);
      if (!info) return res.status(404).json({ success: false, error: "Client not found" });
      if (info.isReady) return res.status(400).json({ success: false, error: "Client is already connected" });
      const formatted = formatMobileNumber(phoneNumber);
      if (!formatted) {
        return res.status(400).json({ success: false, error: "Invalid phone number format" });
      }
      console.log(`\u{1F511} Requesting pairing code via port ${assignedPort} for +${formatted}...`);
      info.qrCodeBase64 = null;
      info.qrCodeData = null;
      info.status = "authenticating";
      const code = await info.client.requestPairingCode(formatted);
      info.pairingCode = code;
      addLog("success", `Pairing code generated via port ${assignedPort}: ${code}`);
      res.json({ success: true, code });
    } catch (e) {
      console.error("Error requesting sub-server pairing code:", e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  };
  subApp.all("/pairing-code", subPairingHandler);
  subApp.all("/api/v1/pairing-code", subPairingHandler);
  subApp.get("/", (req, res) => {
    const info = clients.get(clientId);
    res.json({
      account: info ? info.name : clientId,
      port: assignedPort,
      status: info ? info.status : "unknown",
      ready: info ? info.isReady : false,
      number: info ? info.number : null,
      endpoints: [
        "GET /status",
        "GET /qr",
        "GET /send?Mobile=...&Message=...",
        "GET /api/v1/send?Mobile=...&Message=...",
        "POST /send",
        "POST /api/v1/send",
        "POST /pairing-code?phoneNumber=...",
        "POST /api/v1/pairing-code?phoneNumber=..."
      ]
    });
  });
  const server = http.createServer(subApp);
  server.listen(assignedPort, () => {
    console.log(`\u{1F310} [${accountName}] Sub-server started on port ${assignedPort}`);
    addLog("success", `Account '${accountName}' is accessible on port ${assignedPort}`);
  });
  server.on("error", (err) => {
    console.error(`\u274C Sub-server for ${accountName} on port ${assignedPort} failed:`, err.message);
    addLog("error", `Sub-server for '${accountName}' failed on port ${assignedPort}`, { error: err.message });
  });
  clientServers.set(clientId, server);
}
function stopClientSubServer(clientId) {
  const server = clientServers.get(clientId);
  if (!server) return;
  server.close(() => {
    console.log(`\u{1F534} Sub-server for client ${clientId} stopped`);
  });
  clientServers.delete(clientId);
}
async function initializeAllClients() {
  addLog("info", "Initializing WhatsApp Clients...");
  getOrCreateClient("default", "Default Account");
  const authDir = path.join(appDir, ".wwebjs_auth");
  if (fs.existsSync(authDir)) {
    try {
      const files = fs.readdirSync(authDir);
      files.forEach((file) => {
        const folderPath = path.join(authDir, file);
        if (fs.statSync(folderPath).isDirectory() && file.startsWith("session-")) {
          const clientId = file.substring("session-".length);
          if (clientId !== "default" && clientId !== "client-one") {
            if (!clientPorts.has(clientId)) {
              clientPorts.set(clientId, getNextAvailablePort());
              saveClientPorts();
            }
            getOrCreateClient(clientId);
          } else if (clientId === "client-one") {
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
  for (const clientId of clientPorts.keys()) {
    if (!clients.has(clientId)) {
      const name = clientNames.get(clientId) || (clientId === "client-one" ? "Primary Account" : null);
      getOrCreateClient(clientId, name);
    }
  }
  for (const [clientId, info] of clients.entries()) {
    try {
      console.log(`\u{1F504} Initializing WhatsApp client connection for: ${info.name}`);
      info.client.initialize().catch((err) => {
        console.error(`Error initializing client ${clientId}:`, err.message);
        info.status = "disconnected";
      });
    } catch (err) {
      console.error(`Failed to initialize client ${clientId}:`, err.message);
    }
  }
  for (const [clientId] of clients.entries()) {
    if (clientId !== "default") {
      startClientSubServer(clientId);
    }
  }
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
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
var messageQueue = loadQueue();
var processing = false;
var queuePaused = false;
if (messageQueue.some((j) => j.status === "processing")) {
  console.log("\u{1F9F9} Resetting stuck 'processing' jobs to 'pending'...");
  messageQueue.forEach((job) => {
    if (job.status === "processing") {
      job.status = "pending";
    }
  });
  saveQueue(messageQueue);
}
async function processQueue() {
  if (processing || queuePaused) return;
  processing = true;
  const BATCH_SIZE = 10;
  const BATCH_DELAY = 2e4;
  while (messageQueue.length > 0) {
    let batchCount = 0;
    while (batchCount < BATCH_SIZE && messageQueue.length > 0) {
      if (queuePaused) {
        addLog("info", "Queue processing paused by user.");
        processing = false;
        return;
      }
      const jobIndex = messageQueue.findIndex((job2) => job2.status === "pending" || !job2.status);
      if (jobIndex === -1) {
        break;
      }
      const job = messageQueue[jobIndex];
      const readyClients = [...clients.values()].filter((c) => c.isReady);
      if (readyClients.length === 0) {
        console.log("\u26A0\uFE0F No ready WhatsApp clients available. Standby mode active... waiting for connection.");
        addLog("warning", "Waiting for at least one WhatsApp client to connect...");
        while (true) {
          if (queuePaused) {
            processing = false;
            return;
          }
          const currentReady = [...clients.values()].filter((c) => c.isReady);
          if (currentReady.length > 0) {
            console.log("\u2705 WhatsApp client is ready! Resuming queue.");
            addLog("success", "WhatsApp client connected. Resuming queue...");
            break;
          }
          await delay(5e3);
        }
      }
      job.status = "processing";
      saveQueue(messageQueue);
      try {
        await sendMessageJob(job);
        addLog("success", `Message sent successfully (Job: ${job.id.split("_").pop()})`, { number: job.number, id: job.id });
        const currentJobIndex = messageQueue.indexOf(job);
        if (currentJobIndex !== -1) {
          job.status = "sent";
          job.sentAt = (/* @__PURE__ */ new Date()).toISOString();
          messageQueue.splice(currentJobIndex, 1);
          saveQueue(messageQueue);
        }
        batchCount++;
      } catch (err) {
        const errorMsg = err.message || "Unknown error";
        addLog("error", `Failed to send message (Job: ${job.id.split("_").pop()})`, { number: job.number, error: errorMsg, id: job.id });
        const currentJobIndex = messageQueue.indexOf(job);
        if (currentJobIndex !== -1) {
          const isConnectionError = errorMsg.toLowerCase().includes("connection") || errorMsg.toLowerCase().includes("disconnected") || errorMsg.toLowerCase().includes("network") || errorMsg.toLowerCase().includes("timeout") || errorMsg.toLowerCase().includes("closed") || errorMsg.toLowerCase().includes("navigation");
          if (isConnectionError) {
            console.log(`\u{1F310} [Network/Client] Connection issue detected (${errorMsg}). Waiting for internet...`);
            addLog("warning", "Waiting for internet connection...", { reason: errorMsg });
            while (true) {
              try {
                await new Promise((resolve, reject) => {
                  dns.lookup("google.com", (err2) => {
                    if (err2 && err2.code === "ENOTFOUND") reject(err2);
                    else resolve();
                  });
                });
                console.log("\u2705 Internet connection restored! Stabilizing...");
                addLog("success", "Internet restored. Waiting 5s for client stabilization...");
                await new Promise((resolve) => setTimeout(resolve, 5e3));
                console.log("\u{1F680} Resuming queue now!");
                break;
              } catch (e) {
                await new Promise((resolve) => setTimeout(resolve, 3e3));
              }
            }
          }
          const retryCount = (job.retryCount || 0) + 1;
          const isFatalError = errorMsg.includes("not registered") || errorMsg.includes("invalid number") || errorMsg.includes("unable to parse") || errorMsg.includes("Message or file required") || errorMsg.includes("File not found");
          const isRecoverableError = !isFatalError;
          if (isRecoverableError && retryCount <= 100) {
            job.status = "pending";
            job.retryCount = retryCount;
            job.error = void 0;
            job.failedAt = void 0;
            job.lastError = errorMsg;
            messageQueue.splice(currentJobIndex, 1);
            messageQueue.push(job);
            console.log(`\u{1F504} [Job: ${job.id.split("_").pop()}] Auto-retrying message (Attempt ${retryCount}/100). Error: ${errorMsg}`);
            addLog("warning", `Message queued for retry (attempt ${retryCount}/100)`, { number: job.number, error: errorMsg });
          } else {
            job.status = "failed";
            job.failedAt = (/* @__PURE__ */ new Date()).toISOString();
            job.error = errorMsg;
            job.retryCount = retryCount;
            messageQueue.splice(currentJobIndex, 1);
            messageQueue.push(job);
          }
          saveQueue(messageQueue);
        }
        batchCount++;
      }
      if (batchCount < BATCH_SIZE) {
        const randomDelay = Math.floor(Math.random() * (1e4 - 8e3 + 1) + 8e3);
        console.log(`\u23F3 Waiting ${randomDelay}ms before next message...`);
        await new Promise((resolve) => setTimeout(resolve, randomDelay));
      }
    }
    if (messageQueue.length > 0) {
      if (queuePaused) {
        processing = false;
        return;
      }
      const pendingJobs = messageQueue.filter((job) => job.status === "pending" || !job.status);
      if (pendingJobs.length > 0) {
        addLog("info", `Batch of ${batchCount} messages sent. Waiting 20 seconds before next batch...`, {
          batchSize: batchCount,
          remaining: pendingJobs.length
        });
        await delay(BATCH_DELAY);
      } else {
        break;
      }
    }
  }
  processing = false;
}
var withTimeout = (promise, ms = 3e4) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error("Operation timed out")), ms))
]);
function randomizeText(text) {
  if (!text) return "";
  const zeroWidthSpace = "\u200B";
  const splitText = text.split("");
  const randomPos = Math.floor(Math.random() * splitText.length);
  splitText.splice(randomPos, 0, zeroWidthSpace);
  return splitText.join("");
}
async function sendMessageJob(job) {
  const { number, message, filePath, id: jobId } = job;
  const safeMessage = randomizeText(message);
  const clientId = job.whatsappClientId || "default";
  let clientInfo = clients.get(clientId);
  if (!clientInfo) {
    throw new Error(`WhatsApp connection '${clientId}' not found`);
  }
  if (!clientInfo.isReady) {
    const fallback = [...clients.values()].find((c) => c.isReady);
    if (fallback) {
      console.log(`\u26A0\uFE0F [Job: ${job.id}] Assigned client '${clientInfo.name}' not ready. Falling back to '${fallback.name}'.`);
      addLog("warning", `Client '${clientInfo.name}' not ready. Routing via '${fallback.name}' instead.`, { job: job.id });
      clientInfo = fallback;
    }
  }
  if (clientInfo.status === "authenticating") {
    console.log(`\u23F3 Message for ${number} arrived while connection ${clientInfo.name} is authenticating. Waiting...`);
    let waitTime = 0;
    while (clientInfo.status === "authenticating" && waitTime < 1e4) {
      await delay(1e3);
      waitTime += 1e3;
    }
  }
  if (!clientInfo.client.info || !clientInfo.isReady) {
    throw new Error(`WhatsApp connection '${clientInfo.name}' is not ready (status: ${clientInfo.status})`);
  }
  const clientInstance = clientInfo.client;
  const chatId = number + "@c.us";
  let targetChatId = chatId;
  try {
    console.log(`\u{1F50D} Pre-resolving contact mapping for ${number} on ${clientInfo.name}...`);
    const contact = await clientInstance.getContactById(chatId);
    if (contact && contact.id && contact.id._serialized) {
      targetChatId = contact.id._serialized;
      if (targetChatId !== chatId) {
        console.log(`\u2139\uFE0F Resolved identifier for ${number}: ${chatId} -> ${targetChatId}`);
      }
    }
  } catch (contactError) {
    console.warn(`\u26A0\uFE0F Warning pre-resolving contact ${number}:`, contactError.message);
  }
  try {
    try {
      const chat = await clientInstance.getChatById(targetChatId);
      const typingDuration = Math.floor(Math.random() * (6e3 - 3e3 + 1) + 3e3);
      console.log(`\u270D\uFE0F [Human Sim] Typing for ${typingDuration}ms in chat ${number} using ${clientInfo.name}...`);
      await chat.sendStateTyping();
      await new Promise((resolve) => setTimeout(resolve, typingDuration));
      await chat.clearState();
    } catch (simError) {
      console.log("\u26A0\uFE0F Could not simulate typing (Chat might not exist yet), proceeding to send anyway.", simError.message);
    }
    let finalFilePath = filePath;
    if (filePath && (filePath.trim() === "<PDFPATH>" || filePath.includes("<") && filePath.includes(">"))) {
      console.log(`\u26A0\uFE0F [Job: ${jobId}] Ignoring literal placeholder filePath: ${filePath}`);
      finalFilePath = null;
    }
    if (finalFilePath) {
      if (!fs.existsSync(finalFilePath)) {
        throw new Error(`File not found: ${finalFilePath}`);
      }
      if (fs.lstatSync(finalFilePath).isDirectory()) {
        throw new Error(`The path provided is a directory, not a file: ${finalFilePath}. Please provide the full path to the PDF file.`);
      }
      console.log(`\u{1F4E4} [Job: ${jobId}] Sending media to ${number} via ${clientInfo.name} (File: ${path.basename(finalFilePath)})`);
      const media = MessageMedia.fromFilePath(finalFilePath);
      const response = await withTimeout(clientInstance.sendMessage(targetChatId, media, { caption: safeMessage || "" }), 45e3);
      const responseId = response && response.id ? response.id._serialized : `unknown_${Date.now()}`;
      console.log(`\u2705 [Job: ${jobId}] Media sent successfully. Message ID: ${responseId}`);
      return;
    }
    if (message) {
      console.log(`\u{1F4E4} [Job: ${jobId}] Sending text message to ${number} via ${clientInfo.name}`);
      const response = await withTimeout(clientInstance.sendMessage(targetChatId, safeMessage), 3e4);
      const responseId = response && response.id ? response.id._serialized : `unknown_${Date.now()}`;
      console.log(`\u2705 [Job: ${jobId}] Text sent successfully. Message ID: ${responseId}`);
      return;
    }
    throw new Error("Message or file required");
  } catch (error) {
    console.error("\u274C Raw Send Error:", error);
    let errorMessage = error.message || "Unknown error";
    if (errorMessage.includes("Evaluation failed") || errorMessage.includes("Evaluation failed: t")) {
      errorMessage = `Number ${number} may not be on WhatsApp or chat cannot be accessed. Please verify the number is correct and has WhatsApp installed.`;
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});
app.use(express.static(path.join(__dirname, "public")));
app.get("/api/v1/download-sample-excel", (req, res) => {
  try {
    const sampleData = [
      { Mobile: "9876543210" },
      { Mobile: "9876543211" },
      { Mobile: "9876543212" },
      { Mobile: "9876543213" },
      { Mobile: "9876543214" }
    ];
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(sampleData);
    worksheet["!cols"] = [
      { wch: 15 }
      // Mobile column width
    ];
    XLSX.utils.book_append_sheet(workbook, worksheet, "Contacts");
    const buffer = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
      compression: true
    });
    if (!buffer || buffer.length === 0) {
      throw new Error("Failed to generate Excel file buffer");
    }
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="bulkuploade.xlsx"');
    res.setHeader("Content-Length", buffer.length);
    res.send(buffer);
    addLog("info", "Sample Excel file downloaded", { filename: "bulkuploade.xlsx" });
  } catch (error) {
    console.error("Error generating sample Excel file:", error);
    addLog("error", "Failed to generate sample Excel file", { error: error.message });
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: "Failed to generate sample Excel file: " + error.message
      });
    }
  }
});
app.get("/api/v1/status", async (req, res) => {
  const clientId = req.query.clientId || "default";
  const clientInfo = clients.get(clientId);
  let licenseDays = null;
  let licenseValid = false;
  let licenseError = null;
  try {
    const validation = await checkLicense();
    if (validation.valid) {
      licenseDays = validation.daysRemaining;
      licenseValid = true;
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
      licenseDays,
      licenseValid,
      licenseError
    });
  }
  const resolvedNumber = clientInfo.number || (clientInfo.client && clientInfo.client.info && clientInfo.client.info.wid ? clientInfo.client.info.wid.user : null);
  const resolvedPort = clientPorts.get(clientId) || (clientId === 'default' ? port : null);

  const isReady = clientInfo.isReady || clientInfo.status === 'ready';

  res.json({
    status: isReady ? 'ready' : clientInfo.status,
    ready: isReady,
    number: resolvedNumber,
    name: clientInfo.name,
    port: resolvedPort,
    pairingCode: clientInfo.pairingCode,
    licenseDays,
    licenseValid,
    licenseError
  });
});
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
app.get("/api/v1/clients", (req, res) => {
  const list = [];
  for (const [clientId, info] of clients.entries()) {
    const resolvedNumber = info.number || (info.client && info.client.info && info.client.info.wid ? info.client.info.wid.user : null);
    const resolvedPort = clientPorts.get(clientId) || (clientId === 'default' ? port : null);
    const isReady = info.isReady || info.status === 'ready';
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
app.post("/api/v1/clients/add", (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: "Connection name is required" });
    }
    const clientId = `client_${Date.now()}`;
    const assignedPort = getNextAvailablePort();
    clientPorts.set(clientId, assignedPort);
    saveClientPorts();
    const info = getOrCreateClient(clientId, name.trim());
    info.client.initialize().catch((err) => {
      console.error(`Error initializing new client ${clientId}:`, err.message);
      info.status = "disconnected";
    });
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
    const formatted = formatMobileNumber(phoneNumber);
    if (!formatted) {
      return res.status(400).json({ success: false, error: "Invalid phone number format. Must include country code, e.g. 919876543210" });
    }
    console.log(`\u{1F511} Requesting pairing code for client [${info.name}] using number ${formatted}...`);
    addLog("info", `Requesting pairing code for client [${info.name}] using number +${formatted}`);
    info.qrCodeBase64 = null;
    info.qrCodeData = null;
    info.status = "authenticating";
    const code = await info.client.requestPairingCode(formatted);
    info.pairingCode = code;
    addLog("success", `Pairing code generated for client [${info.name}]: ${code}`);
    res.json({ success: true, code });
  } catch (e) {
    console.error("Error requesting pairing code:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});
app.get("/api/v1/queue", (req, res) => {
  res.json({
    length: messageQueue.length,
    processing,
    paused: queuePaused,
    pending: messageQueue.filter((j) => j.status === "pending" || !j.status).length,
    failed: messageQueue.filter((j) => j.status === "failed").length,
    queue: messageQueue.map((job) => ({
      id: job.id || `${job.number}_${job.createdAt || Date.now()}`,
      number: job.number,
      message: job.message ? job.message.length > 50 ? job.message.substring(0, 50) + "..." : job.message : "",
      hasFile: !!job.filePath,
      fileName: job.filePath ? path.basename(job.filePath) : null,
      status: job.status || "pending",
      createdAt: job.createdAt,
      failedAt: job.failedAt,
      error: job.error,
      retryCount: job.retryCount || 0
    }))
  });
});
function addBusyJobToQueue(data) {
  const job = {
    id: `BUSY_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    number: data.number,
    message: data.message,
    filePath: data.filePath,
    status: "pending",
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    retryCount: 0,
    isPriority: false
  };
  messageQueue.push(job);
  saveQueue(messageQueue);
  processQueue();
}
var busyCronJobs = {};
function initBusyScheduler() {
  console.log("\u{1F504} Initializing Multi-Firm Scheduler...");
  Object.values(busyCronJobs).forEach((job) => job.stop());
  busyCronJobs = {};
  try {
    const firms = BusyService.getFirms();
    firms.forEach((firm) => {
      if (firm.scheduleEnabled !== false && firm.scheduleCron) {
        console.log(`\u23F0 [${firm.name}] Scheduler: Enabled at "${firm.scheduleCron}"`);
        const job = cron.schedule(firm.scheduleCron, () => {
          addLog("info", `\u23F0 Scheduled Job: Triggering Reminders for [${firm.name}]`);
          BusyService.runBulkReminders(firm, (type, msg, data) => {
            if (type === "queue_job") {
              addBusyJobToQueue(data);
            } else {
              addLog(type, msg, data);
            }
          });
        });
        busyCronJobs[firm.id] = job;
      } else {
        console.log(`\u23F0 [${firm.name}] Scheduler: Disabled`);
      }
    });
  } catch (e) {
    console.error("Failed to init Multi-Firm Scheduler:", e.message);
  }
}
initBusyScheduler();
app.post("/api/busy/trigger", (req, res) => {
  const firmId = req.body.firmId || req.query.firmId;
  const firm = BusyService.getFirms().find((f) => f.id === firmId);
  if (!firm) return res.status(404).json({ error: "Firm not found" });
  addLog("info", `Manual Trigger: Busy Payment Reminders for [${firm.name}]`);
  BusyService.runBulkReminders(firm, (type, msg, data) => {
    if (type === "queue_job") {
      addBusyJobToQueue(data);
    } else {
      addLog(type, msg, data);
    }
  });
  res.json({ success: true, message: `Bulk process for [${firm.name}] started.` });
});
app.get("/api/busy/scan", async (req, res) => {
  const firmId = req.query.firmId || req.body.firmId;
  const firm = BusyService.getFirms().find((f) => f.id === firmId);
  if (!firm) return res.status(404).json({ error: "Firm not found" });
  try {
    addLog("info", `Starting Scan Request for [${firm.name}]...`);
    const results = await BusyService.scanAndPreview(firm);
    addLog("success", `Scan Complete for [${firm.name}]. Found ${results.length} debtors.`);
    res.json({ success: true, results });
  } catch (e) {
    addLog("error", `Scan Failed for [${firm.name}]`, { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});
app.get("/api/busy/config", (req, res) => {
  res.json(BusyService.getConfig());
});
app.post("/api/busy/config", (req, res) => {
  res.json({ success: true });
});
app.get("/api/busy/firms", (req, res) => {
  try {
    const config2 = BusyService.getConfig();
    console.log(`\u{1F4E1} GET /api/busy/firms requested. Returning ${config2.firms ? config2.firms.length : 0} firms.`);
    res.json({ success: true, firms: config2.firms || [] });
  } catch (e) {
    console.error("GET /firms Error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});
app.post("/api/busy/hierarchy", async (req, res) => {
  try {
    const { firmId, parentGroup } = req.body;
    const config2 = BusyService.getConfig();
    const firm = config2.firms.find((f) => f.id === firmId);
    if (!firm) return res.status(404).json({ success: false, error: "Firm not found" });
    const data = await BusyService.getHierarchy(firm, parentGroup);
    res.json({ success: true, ...data });
  } catch (e) {
    console.error("Get Hierarchy Error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});
app.post("/api/busy/accounts", async (req, res) => {
  try {
    const { firmId, targetGroup } = req.body;
    const config2 = BusyService.getConfig();
    const firm = config2.firms.find((f) => f.id === firmId);
    if (!firm) return res.status(404).json({ success: false, error: "Firm not found" });
    const mockFirm = {
      ...firm,
      targetGroup: targetGroup || firm.targetGroup,
      specificParties: null
      // FORCE NULL to get all accounts
    };
    const accounts = await BusyService.getTargetAccounts(mockFirm);
    res.json({ success: true, accounts });
  } catch (e) {
    console.error("Get Accounts Error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});
app.post("/api/busy/firms/add", (req, res) => {
  const firm = BusyService.addFirm();
  res.json({ success: true, firm });
});
app.post("/api/busy/firms/update", (req, res) => {
  const { id, data } = req.body;
  if (BusyService.updateFirm(id, data)) {
    initBusyScheduler();
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
app.get("/api/busy/resolve-path", async (req, res) => {
  const firmId = req.query.firmId || req.body.firmId;
  const firm = BusyService.getFirms().find((f) => f.id === firmId);
  if (!firm) return res.status(404).json({ error: "Firm not found" });
  try {
    const path2 = await BusyService.resolvePath(firm);
    res.json({ path: path2 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/busy/company-info", async (req, res) => {
  const firmId = req.query.firmId || req.body.firmId;
  const firm = BusyService.getFirms().find((f) => f.id === firmId);
  if (!firm) return res.status(404).json({ error: "Firm not found" });
  try {
    const info = await BusyService.getCompanyProfile(firm);
    res.json({ success: true, info });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
app.post("/api/busy/accounts", async (req, res) => {
  try {
    const { firmId, targetGroup } = req.body;
    const config2 = BusyService.getConfig();
    const firm = config2.firms.find((f) => f.id === firmId);
    if (!firm) {
      return res.status(404).json({ success: false, error: "Firm not found" });
    }
    const queryFirm = { ...firm, targetGroup: targetGroup || firm.targetGroup, specificParties: null };
    const accounts = await BusyService.getTargetAccounts(queryFirm);
    res.json({ success: true, accounts });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
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
app.post("/api/v1/queue/resume", (req, res) => {
  try {
    queuePaused = false;
    addLog("info", "Message queue resumed");
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
app.post("/api/v1/resend", async (req, res) => {
  try {
    const { id, number } = req.body;
    if (!id && !number) {
      return res.status(400).json({
        success: false,
        error: "Message ID or number is required"
      });
    }
    let jobIndex = -1;
    if (id) {
      jobIndex = messageQueue.findIndex((job2) => (job2.id || job2.number + "_" + (job2.createdAt || Date.now())) === id);
    } else {
      for (let i = messageQueue.length - 1; i >= 0; i--) {
        if (messageQueue[i].number === number && messageQueue[i].status === "failed") {
          jobIndex = i;
          break;
        }
      }
    }
    if (jobIndex === -1) {
      return res.status(404).json({
        success: false,
        error: "Message not found in queue"
      });
    }
    const job = messageQueue[jobIndex];
    if (job.status !== "failed") {
      return res.status(400).json({
        success: false,
        error: "Message is not in failed state"
      });
    }
    job.status = "pending";
    job.error = void 0;
    job.failedAt = void 0;
    saveQueue(messageQueue);
    addLog("info", `Message queued for resend`, { number: job.number, retryCount: job.retryCount });
    processQueue();
    res.json({
      success: true,
      message: "Message queued for resend",
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
app.post("/api/v1/queue/clear", (req, res) => {
  try {
    const { clearFailed, clearSent, clearAll } = req.body;
    let clearedCount = 0;
    if (clearAll) {
      clearedCount = messageQueue.length;
      messageQueue = [];
    } else if (clearFailed) {
      messageQueue = messageQueue.filter((job) => {
        if (job.status === "failed") {
          clearedCount++;
          return false;
        }
        return true;
      });
    } else if (clearSent) {
      messageQueue = messageQueue.filter((job) => {
        if (job.status === "sent") {
          clearedCount++;
          return false;
        }
        return true;
      });
    } else {
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
app.post("/api/v1/resend-all", async (req, res) => {
  try {
    const failedMessages = messageQueue.filter((job) => job.status === "failed");
    if (failedMessages.length === 0) {
      return res.json({
        success: false,
        message: "No failed messages to resend"
      });
    }
    let resentCount = 0;
    for (const job of failedMessages) {
      job.status = "pending";
      job.error = void 0;
      job.failedAt = void 0;
      resentCount++;
    }
    saveQueue(messageQueue);
    addLog("info", `Resent ${resentCount} failed messages`, { count: resentCount });
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
app.get("/api/v1/logs", (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const type = req.query.type || null;
  const search = req.query.search || null;
  let filteredLogs = [...logsHistory];
  if (type) {
    filteredLogs = filteredLogs.filter((log) => log.type === type);
  }
  if (search) {
    const searchLower = search.toLowerCase();
    filteredLogs = filteredLogs.filter(
      (log) => log.message.toLowerCase().includes(searchLower) || log.data && JSON.stringify(log.data).toLowerCase().includes(searchLower)
    );
  }
  const logs = filteredLogs.slice(-limit).reverse();
  res.json({
    total: logsHistory.length,
    filtered: filteredLogs.length,
    logs
  });
});
app.post("/api/v1/logs/clear", (req, res) => {
  try {
    const previousCount = logsHistory.length;
    logsHistory = [];
    saveLogs();
    addLog("info", "Logs history cleared", { previousCount });
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
    if (license_email !== void 0) config.license_email = license_email;
    if (license_server_url !== void 0) config.license_server_url = license_server_url;
    fs.writeFileSync(configFile, JSON.stringify(config, null, 4));
    checkLicense(true);
    res.json({ success: true, message: "Configuration saved successfully. Auto-registering device..." });
    addLog("info", "Remote license configuration updated - Triggering registration");
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
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
  setTimeout(async () => {
    clientsClearingSession.add(clientId);
    try {
      addLog("info", `Clearing WhatsApp session for ${clientInfo.name}...`);
      try {
        if (clientInfo.client.info) {
          await withTimeout(clientInfo.client.logout(), 5e3).catch((e) => console.log("Logout timeout/error:", e.message));
        }
      } catch (err) {
        console.log("Client already logged out or not connected:", err.message);
      }
      try {
        await withTimeout(clientInfo.client.destroy(), 5e3).catch((e) => console.log("Destroy timeout/error:", e.message));
      } catch (err) {
        console.log("Client destroy error (may already be destroyed):", err.message);
      }
      await delay(2e3);
      const sessionPath = path.join(appDir, ".wwebjs_auth", `session-${clientId}`);
      if (fs.existsSync(sessionPath)) {
        try {
          const trashPath = path.join(appDir, ".wwebjs_auth", `session-${clientId}_trash_${Date.now()}`);
          fs.renameSync(sessionPath, trashPath);
          addLog("success", `WhatsApp session folder for ${clientInfo.name} moved to trash`);
          setTimeout(() => {
            try {
              if (typeof fs.rmSync === "function") {
                fs.rmSync(trashPath, { recursive: true, force: true });
              } else {
                fs.rmdirSync(trashPath, { recursive: true });
              }
            } catch (e) {
              console.error("Could not cleanup trash folder (ignored):", e.message);
            }
          }, 5e3);
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
      await delay(1e3);
      try {
        clientInfo.client.initialize().catch((err) => {
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
app.post("/api/v1/clients/delete", async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, error: "Client ID is required" });
    if (id === "default") return res.status(400).json({ success: false, error: "Cannot delete the default account" });
    const info = clients.get(id);
    if (!info) return res.status(404).json({ success: false, error: "Client not found" });
    const freedPort = clientPorts.get(id);
    addLog("info", `Deleting WhatsApp connection: ${info.name} (port ${freedPort || "N/A"})`);
    clientsClearingSession.add(id);
    try {
      if (info.client.info) {
        await withTimeout(info.client.logout(), 5e3).catch((e) => console.log("Logout error during delete:", e.message));
      }
    } catch (e) {
    }
    try {
      await withTimeout(info.client.destroy(), 5e3).catch((e) => console.log("Destroy error during delete:", e.message));
    } catch (e) {
    }
    await delay(2e3);
    stopClientSubServer(id);
    clientPorts.delete(id);
    saveClientPorts();
    clientNames.delete(id);
    saveClientNames();
    const sessionPath = path.join(appDir, ".wwebjs_auth", `session-${id}`);
    if (fs.existsSync(sessionPath)) {
      try {
        if (typeof fs.rmSync === "function") {
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
    addLog("success", `WhatsApp connection deleted: ${info.name}${freedPort ? ` (port ${freedPort} freed)` : ""}`);
    res.json({ success: true, message: `WhatsApp connection ${info.name} deleted successfully.${freedPort ? ` Port ${freedPort} is now free.` : ""}` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
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
  busboy.on("field", (name, val) => fields[name] = val);
  busboy.on("file", (name, file, info) => {
    const { filename } = info;
    const uploadsDir = path.join(appDir, "uploads");
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    const saveTo = path.join(uploadsDir, `bulk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}_${filename}`);
    const filePromise = new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(saveTo);
      file.pipe(writeStream);
      file.on("end", () => {
      });
      writeStream.on("close", () => {
        setTimeout(() => {
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
        }, 200);
      });
      writeStream.on("error", (err) => {
        reject(new Error(`Error saving file ${filename}: ${err.message}`));
      });
      file.on("error", (err) => {
        reject(new Error(`Error reading file ${filename}: ${err.message}`));
      });
    });
    filePromises.push(filePromise);
  });
  busboy.on("finish", async () => {
    try {
      await Promise.all(filePromises);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: `File upload error: ${error.message}`
      });
    }
    try {
      const excelFile = files.find((f) => f.fieldName === "excelFile");
      const attachmentFile = files.find((f) => f.fieldName === "attachment");
      if (!excelFile) {
        return res.status(400).json({
          success: false,
          error: "No Excel file uploaded"
        });
      }
      const filePath = excelFile.path;
      if (!fs.existsSync(filePath)) {
        return res.status(400).json({
          success: false,
          error: `Excel file not found at path: ${filePath}. The file may not have been uploaded correctly. Please try again.`
        });
      }
      const stats = fs.statSync(filePath);
      if (stats.size === 0) {
        return res.status(400).json({
          success: false,
          error: "Uploaded Excel file is empty. Please check your file and try again."
        });
      }
      const message = fields.Message || "";
      const fileAttachment = attachmentFile && fs.existsSync(attachmentFile.path) ? attachmentFile.path : null;
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
      if (!worksheet || !worksheet["!ref"]) {
        return res.status(400).json({
          success: false,
          error: "Excel sheet is empty or has no data."
        });
      }
      const data = XLSX.utils.sheet_to_json(worksheet, {
        defval: "",
        blankrows: false,
        raw: false
      });
      if (!data || data.length === 0) {
        const range = XLSX.utils.decode_range(worksheet["!ref"]);
        const rowCount = range.e.r - range.s.r;
        if (rowCount <= 0) {
          return res.status(400).json({
            success: false,
            error: "Excel file is empty or has no data rows. Please ensure your Excel file has at least one row of data after the header row."
          });
        }
        return res.status(400).json({
          success: false,
          error: "Excel file has rows but no valid data. Please check that your Excel file has proper column headers (Mobile, Phone, or Number) and at least one data row with values."
        });
      }
      const formatMobileNumber2 = (mobile) => {
        if (!mobile) return null;
        const cleaned = String(mobile).replace(/\D/g, "");
        if (cleaned.length < 10) return null;
        if (cleaned.startsWith("91")) return cleaned;
        return "91" + cleaned;
      };
      const phoneColumns = ["Mobile", "Phone", "Number", "PhoneNumber", "Contact", "mobile", "phone", "number", "Mob", "mob"];
      let phoneColumn = null;
      if (!data[0] || Object.keys(data[0]).length === 0) {
        return res.status(400).json({
          success: false,
          error: "Excel file has no column headers. Please add column headers including 'Mobile', 'Phone', or 'Number'."
        });
      }
      const firstRowKeys = Object.keys(data[0]);
      for (const col of phoneColumns) {
        const foundKey = firstRowKeys.find(
          (key) => key.toLowerCase().trim() === col.toLowerCase().trim() || key.toLowerCase().trim().includes(col.toLowerCase().trim())
        );
        if (foundKey) {
          phoneColumn = foundKey;
          break;
        }
      }
      if (!phoneColumn && firstRowKeys.length > 0) {
        phoneColumn = firstRowKeys[0];
        addLog("info", `Using first column '${phoneColumn}' as mobile number column`);
      }
      if (!phoneColumn) {
        const availableColumns = firstRowKeys.join(", ");
        return res.status(400).json({
          success: false,
          error: `Could not find phone number column in Excel file. Please ensure your Excel has a column named 'Mobile', 'Phone', or 'Number'. Available columns: ${availableColumns}`
        });
      }
      const results = {
        total: data.length,
        success: 0,
        failed: 0,
        errors: []
      };
      for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const rowNumber = i + 2;
        const rawMobile = row[phoneColumn];
        if (rawMobile === void 0 || rawMobile === null || rawMobile === "" || String(rawMobile).trim() === "") {
          results.failed++;
          results.errors.push({
            row: rowNumber,
            number: "N/A",
            error: "Empty cell"
          });
          continue;
        }
        const mobileNumber = formatMobileNumber2(rawMobile);
        if (!mobileNumber) {
          results.failed++;
          results.errors.push({
            row: rowNumber,
            number: String(rawMobile),
            error: "Invalid mobile number format"
          });
          continue;
        }
        const job = {
          id: `${mobileNumber}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          number: mobileNumber,
          message,
          filePath: fileAttachment,
          status: "pending",
          createdAt: (/* @__PURE__ */ new Date()).toISOString(),
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
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.log("Could not delete Excel file:", err.message);
      }
      if (results.success === 0) {
        return res.status(400).json({
          success: false,
          error: `No valid mobile numbers found in Excel file. ${results.failed} row(s) failed. ${results.errors.length > 0 ? "First few errors: " + results.errors.slice(0, 3).map((e) => `Row ${e.row}: ${e.error}`).join(", ") : ""}`,
          results
        });
      }
      processQueue();
      res.json({
        success: true,
        message: `Bulk upload completed: ${results.success} messages queued, ${results.failed} failed`,
        results
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
app.all("/api/v1/send", (req, res) => {
  const debugData = {
    method: req.method,
    url: req.originalUrl,
    // Crucial for seeing the raw query string
    query: req.query,
    body: req.body,
    contentType: req.headers["content-type"]
  };
  console.log("\u{1F4E5} Incoming API request:", JSON.stringify(debugData));
  const addJobToQueue = (number, message, filePath, whatsappClientId = "default") => {
    const dedupeKey = `${number}:${message}`;
    const now = Date.now();
    if (recentRequests.has(dedupeKey)) {
      const lastTime = recentRequests.get(dedupeKey);
      if (now - lastTime < RECENT_REQUEST_WINDOW) {
        console.log(`\u{1F6E1}\uFE0F [${(/* @__PURE__ */ new Date()).toLocaleTimeString()}] Ignored duplicate request for: ${number}`);
        if (filePath && fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
            console.log(`\u{1F9F9} Deleted duplicate file upload: ${path.basename(filePath)}`);
          } catch (err) {
            console.error("Failed to delete duplicate file:", err.message);
          }
        }
        return res.json({ success: true, message: "Duplicate request ignored (Deduplicated)", to: number });
      }
    }
    recentRequests.set(dedupeKey, now);
    if (recentRequests.size > 200) {
      for (let [key, time] of recentRequests) {
        if (now - time > RECENT_REQUEST_WINDOW) recentRequests.delete(key);
      }
    }
    const mobileNumber = formatMobileNumber(number);
    if (!mobileNumber) {
      return res.status(400).json({
        success: false,
        error: "Invalid mobile number"
      });
    }
    const job = {
      id: `${mobileNumber}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      number: mobileNumber,
      message,
      filePath,
      whatsappClientId: whatsappClientId || "default",
      status: "pending",
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      retryCount: 0,
      isPriority: true
      // Mark as priority
    };
    messageQueue.unshift(job);
    saveQueue(messageQueue);
    console.log(`\u26A1 [INSTANT] Priority message added to start of queue: ${job.id}`);
    addLog("queue", `Priority message queued for ${mobileNumber} (Job: ${job.id.split("_").pop()})`, { number: mobileNumber, hasFile: !!filePath, id: job.id, priority: true });
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
      if (name === "undefined" || !name) return;
      fields[name] = val;
      console.log(`\u{1F4DD} Received Field: [${name}] = [${val}]`);
    });
    busboy.on("file", (name, file, info) => {
      const { filename } = info;
      console.log(`\u{1F4C1} Received File: [${name}] (${filename})`);
      const uploadsDir = path.join(appDir, "uploads");
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
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
          const foundKey = Object.keys(fields).find((k) => k.toLowerCase() === n.toLowerCase());
          if (foundKey) return fields[foundKey];
        }
        return null;
      };
      const mobile = findField(["Mobile", "mobile", "number", "phone"]);
      const message = findField(["Message", "message", "msg", "text"]) || "";
      const whatsappClientId = findField(["whatsappClientId", "clientId", "whatsapp_client_id"]) || "default";
      const filePath = files.length > 0 ? files[0].path : null;
      addJobToQueue(mobile, message, filePath, whatsappClientId);
    });
    req.pipe(busboy);
  } else {
    console.log("\u{1F50D} [Non-Multipart] Query:", JSON.stringify(req.query));
    console.log("\u{1F50D} [Non-Multipart] Body:", JSON.stringify(req.body));
    let mobile = req.query.Mobile || req.query.mobile || req.query.number || req.query.phone || req.body.Mobile || req.body.mobile || req.body.number || req.body.phone;
    let message = req.query.Message || req.query.message || req.query.msg || req.query.text || req.body.Message || req.body.message || req.body.msg || req.body.text || "";
    const filePath = req.query.pdfPath || req.query.filePath || req.query.attachment || req.query.file || req.query.pdf || req.body.pdfPath || req.body.filePath || req.body.attachment || req.body.file || req.body.pdf || null;
    const whatsappClientId = req.query.whatsappClientId || req.query.clientId || req.body.whatsappClientId || req.body.clientId || "default";
    if (!mobile || !message) {
      const allParams = { ...req.query, ...req.body };
      for (let [key, val] of Object.entries(allParams)) {
        if (!key || !val) continue;
        if (!mobile) {
          const cleanKey = String(key).replace(/\D/g, "");
          const cleanVal = String(val).replace(/\D/g, "");
          if (cleanKey.length >= 10) mobile = cleanKey;
          else if (cleanVal.length >= 10) mobile = cleanVal;
        }
        if (!message) {
          const strKey = String(key);
          const strVal = String(val);
          if (strKey.includes(" ") || strKey.includes("Dear")) message = strKey;
          else if (strVal.includes(" ") || strVal.includes("Dear")) message = strVal;
        }
      }
    }
    if (req.method === "GET" && !req.originalUrl.includes("?") && !mobile) {
      return res.json({ success: true, message: "WhatsApp API is online" });
    }
    if (!mobile && (req.originalUrl.includes("?") || Object.keys(req.body).length > 0)) {
      console.warn(`\u26A0\uFE0F [Warning] API received a SEND request but no MOBILE number was found.`);
      console.warn(`\u{1F449} Please check your BUSY "Parameter Name" and "Parameter Value" settings.`);
      return res.status(400).json({
        success: false,
        error: "Mobile number parameter is missing in your request."
      });
    }
    addJobToQueue(mobile, message, filePath, whatsappClientId);
  }
});
setInterval(() => {
  const uploadsDir = path.join(appDir, "uploads");
  if (!fs.existsSync(uploadsDir)) return;
  const files = fs.readdirSync(uploadsDir);
  files.forEach((file) => {
    const filePath = path.join(uploadsDir, file);
    const stats = fs.statSync(filePath);
    const ageHours = (Date.now() - stats.mtimeMs) / (1e3 * 60 * 60);
    if (ageHours > 24) {
      fs.unlinkSync(filePath);
      console.log(`\u{1F9F9} Deleted old file: ${filePath}`);
    }
  });
}, 1e3 * 60 * 60);
async function startServer() {
  const licenseCheck = await checkLicense();
  if (!licenseCheck.valid && !licenseCheck.warning) {
    if (licenseCheck.expired) {
      console.log("\u274C License expired. Please activate a new license key.");
      console.log("\u{1F4A1} You can activate a license via the web interface once the server starts.");
    }
  }
  addLog("info", "Server starting up");
  app.get("/api/v1/license/info", async (req, res) => {
    try {
      const validation = await checkLicense();
      res.json({
        success: true,
        hasLicense: validation.valid,
        // If valid, we have a license
        valid: validation.valid,
        error: validation.error,
        expirationDate: validation.expirationDate,
        daysRemaining: validation.daysRemaining,
        machineId: MACHINE_ID,
        // Return Machine ID to UI
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
    console.log(`\u{1F680} WhatsApp Local Server running at http://localhost:${port}`);
    addLog("success", `Server started on port ${port}`);
    if (!licenseCheck.valid) {
      console.log("\u274C NO LICENSE FOUND. Server running in CONFIGURATION MODE only.");
      console.log("\u26A0\uFE0F  WhatsApp Client will NOT start until a valid license is configured.");
      console.log("\u{1F4A1} Go to http://localhost:5000 -> Settings to configure your Remote License.");
      addLog("error", "Server running in CONFIGURATION MODE (No License)");
      return;
    }
    initializeAllClients();
  });
}
async function reconnectClient(clientId) {
  const info = clients.get(clientId);
  if (!info) return;
  console.log(`\u{1F504} [Self-Healing] Reconnect initiated for client '${info.name}' (${clientId})...`);
  addLog("warning", `Self-healing reconnect started for connection: ${info.name}`);
  info.status = "authenticating";
  info.isReady = false;
  try {
    await withTimeout(info.client.destroy(), 8e3).catch(() => {
    });
  } catch (e) {
  }
  try {
    const { spawn } = require("child_process");
    spawn("powershell", [
      "-Command",
      `Get-CimInstance Win32_Process -Filter "name = 'chrome.exe'" | Where-Object { $_.CommandLine -like "*session-${clientId}*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    ], { windowsHide: true });
  } catch (e) {
    console.error("Failed to trigger force-kill for client", clientId, e.message);
  }
  setTimeout(() => {
    if (clients.has(clientId)) {
      info.client.initialize().catch((err) => {
        console.error(`[Self-Healing] Re-initialization failed for ${clientId}:`, err.message);
        info.status = "disconnected";
      });
    }
  }, 2e3);
}
setInterval(async () => {
  if (clients.size === 0) return;
  for (const [clientId, info] of clients.entries()) {
    if (clientsClearingSession.has(clientId)) continue;
    if (info.status === "ready") {
      try {
        const state = await withTimeout(info.client.getState(), 8e3);
        if (state !== "CONNECTED") {
          console.log(`\u26A0\uFE0F [Self-Healing] Client '${info.name}' is in non-connected state: ${state}. Recovering...`);
          addLog("warning", `Client '${info.name}' lost WhatsApp sync (state: ${state}). Auto-reconnecting...`);
          reconnectClient(clientId);
        }
      } catch (err) {
        console.error(`\u274C [Self-Healing] Connection to client '${info.name}' is unresponsive:`, err.message);
        addLog("error", `Client '${info.name}' browser instance crashed or timed out. Force restarting session...`);
        reconnectClient(clientId);
      }
    } else if (info.status === "disconnected") {
      console.log(`\u26A0\uFE0F [Self-Healing] Client '${info.name}' is disconnected. Reviving...`);
      addLog("info", `Reviving disconnected WhatsApp account: ${info.name}`);
      reconnectClient(clientId);
    }
  }
}, 6e4);
startServer();
