const API_BASE = '/api/v1';

// ======================
// Robust Fetch (Networking Hardening)
// ======================
async function robustFetch(endpoint, options = {}) {
    try {
        // 1. Try standard relative path (localhost)
        const response = await fetch(API_BASE + endpoint, options);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // Handle void responses (like 204)
        const text = await response.text();
        return text ? JSON.parse(text) : {};
    } catch (err) {
        console.warn(`Primary fetch failed for ${endpoint}, trying fallback IP...`, err);

        // 2. Try 127.0.0.1 Fallback (bypassing localhost blockers)
        const fallbackUrl = `http://127.0.0.1:5000${API_BASE}${endpoint}`;
        try {
            const response = await fetch(fallbackUrl, options);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const text = await response.text();
            return text ? JSON.parse(text) : {};
        } catch (fallbackErr) {
            console.error(`Fallback fetch also failed for ${endpoint}`, fallbackErr);
            throw { message: err.message, fallbackError: fallbackErr.message };
        }
    }
}

// ======================
// Initialization
// ======================
document.addEventListener('DOMContentLoaded', () => {
    initializeStatusCheck();
    initializeQRCheck();
    setupClearSession();
    setupSendForm();
    setupBulkUpload();
    setupQueueActions();
    initializeLogs();
    setupSettings();
    setupTabs();
    setupLicenseManagement();
    initializeAccountsManager();
    setupMobileSidebar();

    // Initial checks
    checkQueue();
    setInterval(checkQueue, 2000); // Poll queue every 2 seconds

    // Silent background check for system updates
    setTimeout(() => {
        if (typeof checkSystemUpdate === 'function') {
            checkSystemUpdate(false);
        }
    }, 3000);
});

// ======================
// Status & QR
// ======================
function initializeStatusCheck() {
    checkStatus();
    setInterval(checkStatus, 5000);
}

async function checkStatus() {
    try {
        const [clientsData, statusData] = await Promise.all([
            robustFetch('/clients'),
            robustFetch('/status')
        ]);
        updateStatusDisplay(clientsData, statusData);
        updateLicenseDisplay(statusData);
    } catch (error) {
        document.getElementById('statusText').textContent = 'Server Offline';
        document.getElementById('statusDot').className = 'status-dot error';
        const serverStatus = document.getElementById('serverStatusText');
        if (serverStatus) {
            serverStatus.textContent = 'Disconnected';
            serverStatus.style.color = 'var(--error)';
        }
    }
}

function updateStatusDisplay(clientsData, statusData) {
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const serverStatus = document.getElementById('serverStatusText');
    const listContainer = document.getElementById('dashboardAccountsList');

    if (serverStatus) {
        serverStatus.textContent = 'Online & Protected';
        serverStatus.style.color = 'var(--success)';
    }

    if (!clientsData.success || !clientsData.clients || clientsData.clients.length === 0) {
        statusDot.className = 'status-dot error';
        statusText.textContent = 'No Accounts';
        if (listContainer) {
            listContainer.innerHTML = `
                <div style="text-align:center; padding:24px 0; color:var(--text-muted);">
                    <div style="font-size:32px; margin-bottom:12px;">⚠️</div>
                    <div style="font-weight:600; font-size:14px; color:var(--text-secondary);">No WhatsApp Accounts Connected</div>
                    <p style="font-size:12px; margin-top:4px;">Go to the WhatsApp Accounts tab to link your first number.</p>
                </div>
            `;
        }
        return;
    }

    // Compute status counts
    const readyClients = clientsData.clients.filter(c => c.ready);
    const totalClients = clientsData.clients.length;

    if (readyClients.length === totalClients) {
        statusDot.className = 'status-dot success';
        statusText.textContent = `All Active (${readyClients.length}/${totalClients})`;
        const overlay = document.getElementById('qrOverlay');
        if (overlay) overlay.style.display = 'none';
    } else if (readyClients.length > 0) {
        statusDot.className = 'status-dot warning';
        statusText.textContent = `Partial (${readyClients.length}/${totalClients})`;
    } else {
        statusDot.className = 'status-dot error';
        statusText.textContent = `Disconnected (0/${totalClients})`;
    }

    // Render accounts overview table
    if (listContainer) {
        listContainer.innerHTML = clientsData.clients.map(c => {
            const statusClass = c.ready ? 'success' : (c.status === 'authenticating' ? 'warning' : 'error');
            const displayStatus = c.ready ? 'Connected' : (c.status === 'authenticating' ? 'Connecting/Scan QR' : 'Disconnected');
            const displayNum = c.number ? ` (+${c.number})` : '';
            const portLabel = c.port ? `<span style="margin-left:8px; background:#f0f4ff; color:#4f46e5; font-size:10px; font-weight:700; padding:2px 7px; border-radius:20px; font-family:monospace; border:1px solid #c7d2fe;">:${c.port}</span>` : '';
            
            return `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 16px; background:rgba(255,255,255,0.4); border-radius:12px; margin-bottom:8px; border:1px solid rgba(0,0,0,0.03);">
                    <div>
                        <div style="font-weight:700; font-size:14px; display:flex; align-items:center; flex-wrap:wrap; gap:4px;">
                            ${c.name}${displayNum}${portLabel}
                        </div>
                        <div style="display:flex; align-items:center; gap:6px; font-size:12px; margin-top:4px; color:var(--text-muted);">
                            <span class="status-dot ${statusClass}" style="width:8px; height:8px;"></span>
                            ${displayStatus}
                        </div>
                    </div>
                    <div>
                        <button class="secondary btn-pill" style="padding:4px 12px; font-size:11px; font-weight:600;" onclick="document.querySelector('[data-tab=accounts]').click(); selectActiveAccount('${c.id}', '${c.name}');">
                            Manage
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }
}

function updateLicenseDisplay(data) {
    // Hide/Show pro features
    const busyTab = document.querySelector('[data-tab="busy"]');
    const batchStockTab = document.querySelector('[data-tab="batchstock"]');
    
    if (data.licenseValid && data.licenseTier && (data.licenseTier.toLowerCase() === 'pro' || data.licenseTier.toLowerCase() === 'premium')) {
        if (busyTab) busyTab.style.display = 'flex'; 
        if (batchStockTab) batchStockTab.style.display = 'flex';
    } else {
        if (busyTab) busyTab.style.display = 'none';
        if (batchStockTab) batchStockTab.style.display = 'none';
        
        // If the user is currently ON those tabs, kick them to dashboard
        const activeTab = document.querySelector('.nav-link.active');
        if (activeTab && (activeTab.getAttribute('data-tab') === 'busy' || activeTab.getAttribute('data-tab') === 'batchstock')) {
            const dashTab = document.querySelector('[data-tab="dashboard"]');
            if(dashTab) dashTab.click();
        }
    }

    const licenseDays = document.getElementById('licenseDays');
    if (!licenseDays) return;

    if (data.licenseValid) {
        const tierDisplay = (data.licenseTier || 'Basic').toUpperCase();
        if (data.licenseType === 'remote') {
            licenseDays.textContent = `${data.licenseDays} Days - ${tierDisplay}`;
            licenseDays.style.color = 'var(--primary)'; // Blue for cloud/remote
        } else {
            licenseDays.textContent = `${data.licenseDays} Days - ${tierDisplay}`;
            licenseDays.style.color = data.licenseDays < 7 ? 'var(--warning)' : 'var(--success)';
        }
    } else {
        licenseDays.textContent = data.licenseError || 'Inactive';
        licenseDays.style.color = 'var(--error)';
    }
}

// QR Code check is handled inside individual tabs now
function initializeQRCheck() {
    // No-op for main dashboard
}

async function checkQR() {
    // No-op for main dashboard
}

// QR Timer state
let qrTimerInterval = null;
let lastQRData = null;

function displayQRCode(base64) {
    const qrSection = document.getElementById('qrSection');
    const qrImage = document.getElementById('qrImage');
    const qrLoading = document.getElementById('qrLoading');
    const qrCountdown = document.getElementById('qrCountdown');

    qrSection.style.display = 'block';
    qrImage.src = base64;
    qrImage.style.display = 'block';
    qrLoading.style.display = 'none';

    // Check if it's a new QR code
    if (base64 !== lastQRData) {
        lastQRData = base64;
        startQRCodeTimer(30); // User requested 30s refresh
    }
}

function startQRCodeTimer(seconds) {
    const el = document.getElementById('qrCountdown');
    if (qrTimerInterval) clearInterval(qrTimerInterval);

    let left = seconds;
    const update = () => {
        if (el) el.textContent = `Refresh in: ${left}s`;
        left--;
        if (left < 0) {
            if (el) el.textContent = "Scan code above";
            clearInterval(qrTimerInterval);
        }
    };

    update();
    qrTimerInterval = setInterval(update, 1000);
}

// ======================
// Clear Session
// ======================
function setupClearSession() {
    const btn = document.getElementById('clearSessionBtn');
    if (!btn) return;

    btn.addEventListener('click', async () => {
        if (!await showConfirm('Clear Session?', 'Are you sure you want to disconnect? You will need to scan the QR code again.')) return;

        btn.disabled = true;
        btn.textContent = 'Clearing...';

        try {
            const res = await robustFetch('/clear-session', { method: 'POST' });
            if (res.success) {
                showToast('Session cleared. Please scan QR code again.', 'success');
                checkStatus();
                checkQR();
            } else {
                showToast('Error: ' + res.message, 'error');
            }
        } catch (e) {
            showToast('Failed to clear session: ' + e.message, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Logout / Clear Session';
        }
    });
}

// ======================
// Sending Messages
// ======================
function setupSendForm() {
    const form = document.getElementById('sendForm');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('sendButton');
        let mobile = document.getElementById('targetNumber').value.trim(); // Changed ID to match HTML
        const msg = document.getElementById('message').value;
        const file = document.getElementById('fileUpload').files[0];

        // Auto-add 91 if length is 10
        mobile = mobile.replace(/\D/g, ''); // Remove non-digits
        if (mobile.length === 10) {
            mobile = '91' + mobile;
        }

        if (!mobile) return showToast('Enter a mobile number', 'warning');

        btn.disabled = true;
        btn.innerHTML = 'Sending...';

        const formData = new FormData();
        formData.append('Mobile', mobile);
        formData.append('Message', msg);
        if (file) formData.append('file', file);
        const sendClientId = document.getElementById('sendClientId');
        if (sendClientId) formData.append('whatsappClientId', sendClientId.value || 'default');

        try {
            const res = await robustFetch('/send', {
                method: 'POST',
                body: formData
            });

            if (res.success) {
                showToast('Message Queued Successfully!', 'success');
                form.reset();
                checkQueue();
            } else {
                showToast(res.error || 'Failed to send', 'error');
            }
        } catch (err) {
            showToast('Error: ' + err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.innerText = 'Send Message';
        }
    });
}

// ======================
// Queue Management
// ======================
async function checkQueue() {
    try {
        const data = await robustFetch('/queue');
        updateQueueDisplay(data);
    } catch (e) {
        console.error('Queue check failed', e);
    }
}

function updateQueueDisplay(data) {
    const list = document.getElementById('queueList');
    const count = document.getElementById('queueCount');

    if (count) count.textContent = data.pending || 0;

    if (!list) return;

    if (!data.queue || data.queue.length === 0) {
        list.innerHTML = '<div class="empty-state">Queue is empty</div>';
        return;
    }

    list.innerHTML = data.queue.map(item => `
        <div class="queue-item ${item.status}">
            <div class="q-header" style="display:flex; justify-content:space-between; align-items:center;">
                <strong style="color: var(--text);">${item.number}</strong>
                <span class="status-badge" style="background: ${item.status === 'sent' ? 'var(--success)' : item.status === 'failed' ? 'var(--error)' : 'var(--warning)'}; color: white; padding: 4px 10px; border-radius: 8px; font-size: 11px; font-weight: 700; text-transform: uppercase;">${item.status}</span>
            </div>
            <div class="q-msg" style="margin: 10px 0; color: var(--text-secondary); font-size: 14px; line-height: 1.4;">${item.message}</div>
            <div class="q-meta" style="display:flex; justify-content:space-between; align-items:center; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 10px;">
                <span style="font-size: 12px; color: var(--text-muted);">Attempt: ${item.retryCount || 0}</span>
                ${item.status === 'failed' ? `<button class="secondary" style="padding: 6px 12px; font-size: 11px;" onclick="resendMessage('${item.id}', '${item.number}')">🔄 Resend</button>` : ''}
            </div>
        </div>
    `).join('');
}

function setupQueueActions() {
    document.getElementById('clearQueueBtn')?.addEventListener('click', async () => {
        if (!await showConfirm('Clear Queue?', 'Are you sure you want to clear the entire message queue? This action cannot be undone.')) return;
        try {
            await robustFetch('/queue/clear', { method: 'POST' });
            checkQueue();
            showToast('Queue Cleared', 'success');
        } catch (e) { showToast(e.message, 'error'); }
    });

    const toggleBtn = document.getElementById('toggleQueueBtn');
    let isPaused = false;

    if (toggleBtn) {
        toggleBtn.addEventListener('click', async () => {
            try {
                if (!isPaused) {
                    await robustFetch('/queue/pause', { method: 'POST' });
                    toggleBtn.innerHTML = '▶️ Resume Queue';
                    toggleBtn.classList.add('paused');
                    showToast('Queue Paused', 'info');
                    isPaused = true;
                } else {
                    await robustFetch('/queue/resume', { method: 'POST' });
                    toggleBtn.innerHTML = '⏸️ Pause Queue';
                    toggleBtn.classList.remove('paused');
                    showToast('Queue Resumed', 'success');
                    isPaused = false;
                }
            } catch (e) { showToast(e.message, 'error'); }
        });
    }

    const retryAllBtn = document.getElementById('retryAllBtn');
    if (retryAllBtn) {
        retryAllBtn.addEventListener('click', async () => {
            const originalText = retryAllBtn.innerText;
            retryAllBtn.disabled = true;
            retryAllBtn.innerText = '🔄 Retrying All...';

            try {
                const res = await robustFetch('/resend-all', { method: 'POST' });
                if (res.success) {
                    showToast(`Success: Retrying ${res.count} messages`, 'success');
                    checkQueue();
                } else {
                    showToast(res.message || 'No failed messages found', 'info');
                }
            } catch (e) {
                showToast('Retry All Failed: ' + e.message, 'error');
            } finally {
                setTimeout(() => {
                    retryAllBtn.disabled = false;
                    retryAllBtn.innerText = originalText;
                }, 1000);
            }
        });
    }
}

window.resendMessage = async (id, number) => {
    try {
        await robustFetch('/resend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, number })
        });
        checkQueue();
        showToast('Retrying...', 'info');
    } catch (e) { showToast(e.message, 'error'); }
};

// ======================
// Bulk Upload
// ======================
function setupBulkUpload() {
    const form = document.getElementById('bulkForm');

    // Setup Download Sample Button
    const downloadBtn = document.getElementById('downloadSampleBtn');
    if (downloadBtn) {
        downloadBtn.addEventListener('click', (e) => {
            e.preventDefault();
            window.location.href = '/api/v1/download-sample-excel';
        });
    }

    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('bulkSendButton');
        const file = document.getElementById('excelFile').files[0];
        const attachment = document.getElementById('bulkAttachment').files[0];
        const msg = document.getElementById('bulkMessage').value;

        if (!file) return showToast('Select Excel file', 'warning');

        btn.disabled = true;
        btn.innerText = 'Processing...';

        const formData = new FormData();
        formData.append('excelFile', file);
        if (attachment) {
            formData.append('attachment', attachment);
        }
        formData.append('Message', msg);
        const bulkClientId = document.getElementById('bulkClientId');
        if (bulkClientId) formData.append('whatsappClientId', bulkClientId.value || 'default');

        try {
            const res = await robustFetch('/bulk-upload', {
                method: 'POST',
                body: formData
            });

            if (res.success) {
                showToast(`Queued ${res.results.total} messages!`, 'success');
                form.reset();
                checkQueue();
            } else {
                showToast(res.error, 'error');
            }
        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.innerText = 'Start Bulk Sender';
        }
    });
}

// ======================
// Logs
// ======================
function initializeLogs() {
    setupLogsActions();
    setInterval(loadLogs, 5000);
    loadLogs();
}

function setupLogsActions() {
    document.getElementById('clearLogsBtn')?.addEventListener('click', async () => {
        if (!await showConfirm('Clear Logs?', 'Are you sure you want to clear all system logs?')) return;
        try {
            await robustFetch('/logs/clear', { method: 'POST' });
            loadLogs();
            showToast('Logs Cleared', 'success');
        } catch (e) { showToast(e.message, 'error'); }
    });
}
async function loadLogs() {
    try {
        const data = await robustFetch('/logs?limit=50');
        const container = document.getElementById('logsOutput');

        if (!data.logs || data.logs.length === 0) {
            if (container) container.innerHTML = '<div class="empty-state">No logs found</div>';
            return;
        }

        if (container) {
            container.innerHTML = data.logs.map(log => {
                const time = new Date(log.timestamp).toLocaleTimeString([], { hour12: true });
                let colorClass = 'var(--primary)'; // Default accent

                if (log.type === 'error') colorClass = 'var(--error)';
                if (log.type === 'success') colorClass = 'var(--success)';
                if (log.type === 'warning') colorClass = 'var(--warning)';

                return `
                    <div class="log-entry" style="border-left: 4px solid ${colorClass};">
                        <span class="log-time">${time}</span>
                        <span class="log-msg">${log.message}</span>
                    </div>
                `;
            }).join('');
        }
    } catch (e) {
        console.error('Logs error:', e);
    }
}

// ======================
// Settings
// ======================
function setupSettings() {
    // Remote Config Logic
    const remoteEmail = document.getElementById('remoteEmail');
    const saveRemoteBtn = document.getElementById('saveRemoteConfigBtn');

    // Load existing config and Machine ID
    if (remoteEmail) {
        robustFetch('/config').then(config => {
            if (config.license_email) remoteEmail.value = config.license_email;
        }).catch(() => { });

        // Fetch Machine ID from license/info endpoint
        robustFetch('/license/info').then(data => {
            const display = document.getElementById('machineIdDisplay');
            if (display && data.machineId) {
                display.textContent = data.machineId;
            }
        }).catch(err => {
            const display = document.getElementById('machineIdDisplay');
            if (display) display.textContent = "Error loading ID";
        });
    }

    if (saveRemoteBtn) {
        saveRemoteBtn.addEventListener('click', async () => {
            const email = remoteEmail.value.trim();

            if (!email) return showToast("Please enter Email", 'warning');

            saveRemoteBtn.disabled = true;
            saveRemoteBtn.innerText = "Saving...";

            try {
                const res = await robustFetch('/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ license_email: email })
                });

                if (res.success) {
                    showToast('Configuration saved!', 'success');
                    setTimeout(() => location.reload(), 1500);
                } else {
                    showToast('Error: ' + res.error, 'error');
                }
            } catch (e) {
                showToast(e.message, 'error');
            } finally {
                saveRemoteBtn.disabled = false;
                saveRemoteBtn.innerText = "Save Configuration";
            }
        });
    }
}
// ======================
// License & Tabs
// ======================
function setupLicenseManagement() {
    // simplified for brevity, similar to Send Form
}

function setupTabs() {
    const tabs = document.querySelectorAll('.nav-link');
    tabs.forEach(tab => {
        tab.addEventListener('click', (e) => {
            e.preventDefault();
            document.querySelectorAll('.nav-link').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

            tab.classList.add('active');
            const target = tab.getAttribute('data-tab');
            document.getElementById(target).classList.add('active');
        });
    });
}

// ======================
// UI Helpers
// ======================
function showToast(msg, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}


/**
 * Shows a custom confirmation modal.
 * @param {string} title 
 * @param {string} message 
 * @returns {Promise<boolean>}
 */
function showConfirm(title, message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirmModal');
        const titleEl = document.getElementById('confirmTitle');
        const msgEl = document.getElementById('confirmMessage');
        const okBtn = document.getElementById('confirmOk');
        const cancelBtn = document.getElementById('confirmCancel');

        if (!modal || !titleEl || !msgEl || !okBtn || !cancelBtn) {
            // Fallback if modal elements are missing
            return resolve(confirm(message));
        }

        titleEl.innerText = title;
        msgEl.innerText = message;
        modal.classList.add('active');

        const cleanup = () => {
            modal.classList.remove('active');
            okBtn.onclick = null;
            cancelBtn.onclick = null;
        };

        okBtn.onclick = () => {
            cleanup();
            resolve(true);
        };

        cancelBtn.onclick = () => {
            cleanup();
            resolve(false);
        };
    });
}
/**
 * Utility to copy Machine ID to clipboard
 */
window.copyMachineId = () => {
    const id = document.getElementById('machineIdDisplay').textContent;
    if (!id || id === 'Loading...' || id === 'Error loading ID') return;

    navigator.clipboard.writeText(id).then(() => {
        showToast('Machine ID copied to clipboard!', 'success');
    }).catch(err => {
        showToast('Failed to copy ID', 'error');
    });
};

// ======================
// WhatsApp Multi-Account Manager
// ======================
let activeClientId = null; // Currently selected client ID in the Accounts tab
let accountsPollingInterval = null;

function initializeAccountsManager() {
    const addForm = document.getElementById('addAccountForm');
    if (addForm) {
        addForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const nameInput = document.getElementById('newAccountName');
            const name = nameInput.value;
            try {
                const response = await robustFetch('/clients/add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name })
                });
                if (response.success) {
                    nameInput.value = '';
                    showToast(`Connection '${name}' created successfully!`, 'success');
                    await fetchAndRenderAccounts();
                    // Auto-select the newly created client
                    selectActiveAccount(response.client.id, response.client.name);
                } else {
                    showToast(response.error || 'Failed to create connection', 'error');
                }
            } catch (err) {
                showToast(err.message || 'Error creating connection', 'error');
            }
        });
    }

    // Tab click detection to trigger polling
    const tabs = document.querySelectorAll('.nav-link');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.getAttribute('data-tab');
            if (target === 'accounts') {
                fetchAndRenderAccounts();
                if (!accountsPollingInterval) {
                    accountsPollingInterval = setInterval(pollActiveAccountStatus, 3000);
                }
            } else {
                if (accountsPollingInterval) {
                    clearInterval(accountsPollingInterval);
                    accountsPollingInterval = null;
                }
            }

            // Hydrate dropdown in Busy Automator tab
            if (target === 'busy') {
                hydrateBusyClientDropdown();
            }

            // Hydrate dropdowns in Send tab
            if (target === 'send') {
                hydrateSendClientDropdowns();
            }
        });
    });

    // Initial load for dropdowns
    hydrateBusyClientDropdown();
}

async function fetchAndRenderAccounts() {
    try {
        const data = await robustFetch('/clients');
        if (!data.success) return;

        const listContainer = document.getElementById('accountsList');
        if (!listContainer) return;

        listContainer.innerHTML = '';
        
        data.clients.forEach(c => {
            const row = document.createElement('div');
            row.className = 'glass-card scan-row';
            row.style.padding = '12px 16px';
            row.style.display = 'flex';
            row.style.justifyContent = 'space-between';
            row.style.alignItems = 'center';
            row.style.cursor = 'pointer';
            row.style.marginBottom = '8px';
            if (activeClientId === c.id) {
                row.style.border = '1px solid var(--accent)';
                row.style.background = 'rgba(139, 92, 246, 0.05)';
            }

            row.addEventListener('click', (e) => {
                // If clicked a button inside, don't trigger select
                if (e.target.tagName === 'BUTTON') return;
                selectActiveAccount(c.id, c.name);
            });

            const statusClass = c.status === 'ready' ? 'success' : (c.status === 'authenticating' ? 'warning' : 'error');
            const displayStatus = c.status === 'ready' ? 'Connected' : (c.status === 'authenticating' ? 'Connecting/Scan QR' : 'Disconnected');
            const displayNum = c.number ? ` (+${c.number})` : '';
            const portBadge = c.port ? `<span style="margin-left:8px; background:#f0f4ff; color:#4f46e5; font-size:10px; font-weight:700; padding:2px 7px; border-radius:20px; font-family:monospace; border:1px solid #c7d2fe;">:${c.port}</span>` : '';

            row.innerHTML = `
                <div>
                    <div style="font-weight: 700; font-size: 14px; display:flex; align-items:center; flex-wrap:wrap; gap:4px;">${c.name}${displayNum}${portBadge}</div>
                    <div style="display: flex; align-items: center; gap: 6px; font-size: 12px; margin-top: 4px; color: var(--text-muted);">
                        <span class="status-dot ${statusClass}" style="width: 8px; height: 8px;"></span>
                        ${displayStatus}
                    </div>
                </div>
                <div style="display: flex; gap: 8px;">
                    <button class="secondary btn-pill" style="padding: 4px 10px; font-size: 11px;" onclick="selectActiveAccount('${c.id}', '${c.name}')">
                        Manage
                    </button>
                    ${c.status === 'ready' ? `
                        <button class="secondary btn-pill" style="padding: 4px 10px; font-size: 11px; color: var(--error);" onclick="clearAccountSession('${c.id}')">
                            Logout
                        </button>
                    ` : ''}
                    ${c.id !== 'default' ? `
                        <button class="btn-danger btn-pill" style="padding: 4px 10px; font-size: 11px;" onclick="deleteAccount('${c.id}', '${c.name}')">
                            Delete
                        </button>
                    ` : ''}
                </div>
            `;
            listContainer.appendChild(row);
        });

        // Auto select first account if none selected
        if (!activeClientId && data.clients.length > 0) {
            selectActiveAccount(data.clients[0].id, data.clients[0].name);
        }
    } catch (err) {
        console.error('Error fetching clients:', err);
    }
}

async function selectActiveAccount(id, name) {
    activeClientId = id;
    
    // Highlight in list
    document.querySelectorAll('#accountsList .scan-row').forEach(row => {
        row.style.border = 'none';
        row.style.background = 'none';
    });
    
    // Quick refresh of elements to avoid redraw flicker
    await fetchAndRenderAccounts();

    document.getElementById('activeAccountTitle').textContent = `Manage: ${name}`;
    document.getElementById('activeAccountSub').textContent = `Account ID: ${id}`;
    
    // Show/Hide rename connection interface
    document.getElementById('renameAccountContainer').style.display = id === 'default' ? 'none' : 'flex';
    document.getElementById('renameAccountInput').value = name;
    
    // Reset displays
    document.getElementById('accountQrContainer').style.display = 'none';
    document.getElementById('accountQrLinked').style.display = 'none';
    document.getElementById('accountQrLoading').style.display = 'none';
    document.getElementById('linkingMethodTabs').style.display = 'none';
    document.getElementById('accountPhoneLinkContainer').style.display = 'none';
    document.getElementById('phoneLinkCodeArea').style.display = 'none';
    document.getElementById('phoneLinkInputArea').style.display = 'block';
    document.getElementById('linkPhoneNumber').value = '';
    
    // Default linking method is QR
    window.currentLinkingMethod = 'qr';

    pollActiveAccountStatus();
}

async function pollActiveAccountStatus() {
    if (!activeClientId) return;

    try {
        const statusData = await robustFetch(`/status?clientId=${activeClientId}`);
        const qrContainer = document.getElementById('accountQrContainer');
        const qrLinked = document.getElementById('accountQrLinked');
        const qrLoading = document.getElementById('accountQrLoading');
        const methodTabs = document.getElementById('linkingMethodTabs');
        const phoneContainer = document.getElementById('accountPhoneLinkContainer');

        if (statusData.ready) {
            qrContainer.style.display = 'none';
            qrLoading.style.display = 'none';
            phoneContainer.style.display = 'none';
            methodTabs.style.display = 'none';
            qrLinked.style.display = 'block';
            document.getElementById('accountLinkedHeader').textContent = `${activeClientId === 'default' ? 'Default Account' : 'WhatsApp'} is Linked`;
        } else {
            qrLinked.style.display = 'none';
            methodTabs.style.display = 'flex';

            // Show active linking method
            if (window.currentLinkingMethod === 'phone' || statusData.pairingCode) {
                if (statusData.pairingCode) {
                    window.currentLinkingMethod = 'phone';
                    switchLinkingMethod('phone');
                    document.getElementById('phoneLinkInputArea').style.display = 'none';
                    document.getElementById('phoneLinkCodeArea').style.display = 'block';
                    document.getElementById('pairingCodeDisplay').textContent = formatPairingCode(statusData.pairingCode);
                } else {
                    switchLinkingMethod('phone');
                }
            } else {
                switchLinkingMethod('qr');
                // Fetch QR for this client
                const qrData = await robustFetch(`/qr?clientId=${activeClientId}`);
                if (qrData.qr) {
                    qrLoading.style.display = 'none';
                    qrContainer.style.display = 'block';
                    document.getElementById('accountQrImage').src = qrData.qr;
                } else {
                    qrContainer.style.display = 'none';
                    qrLoading.style.display = 'block';
                }
            }
        }
    } catch (err) {
        console.error('Error polling active account status:', err);
    }
}

async function clearAccountSession(id) {
    if (!confirm('Are you sure you want to logout from this WhatsApp session?')) return;
    try {
        const response = await robustFetch('/clear-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId: id })
        });
        if (response.success) {
            showToast('Session logout initiated. Please wait...', 'success');
            setTimeout(fetchAndRenderAccounts, 2000);
        }
    } catch (err) {
        showToast(err.message || 'Logout failed', 'error');
    }
}

async function deleteAccount(id, name) {
    if (!confirm(`Are you sure you want to completely delete the connection '${name}'? This will delete the session data.`)) return;
    try {
        const response = await robustFetch('/clients/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });
        if (response.success) {
            showToast(`Connection '${name}' deleted.`, 'success');
            activeClientId = null;
            await fetchAndRenderAccounts();
        } else {
            showToast(response.error || 'Failed to delete connection', 'error');
        }
    } catch (err) {
        showToast(err.message || 'Failed to delete connection', 'error');
    }
}

async function hydrateBusyClientDropdown() {
    try {
        const data = await robustFetch('/clients');
        if (!data.success) return;

        const dropdown = document.getElementById('confWhatsappClientId');
        if (!dropdown) return;

        const currentValue = dropdown.value;
        dropdown.innerHTML = '';

        data.clients.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id;
            const displayNum = c.number ? ` (+${c.number})` : ' (Not Linked)';
            opt.textContent = `${c.name}${displayNum}`;
            dropdown.appendChild(opt);
        });

        // Try to restore previous selection if it exists in the options
        if (Array.from(dropdown.options).some(o => o.value === currentValue)) {
            dropdown.value = currentValue;
        }
    } catch (err) {
        console.error('Error hydrating dropdown:', err);
    }
}

// Export functions to global window context so onclick attributes can find them
window.selectActiveAccount = selectActiveAccount;
window.clearAccountSession = clearAccountSession;
window.deleteAccount = deleteAccount;

async function hydrateSendClientDropdowns() {
    try {
        const data = await robustFetch('/clients');
        if (!data.success) return;

        const dropdowns = [
            document.getElementById('sendClientId'),
            document.getElementById('bulkClientId')
        ];

        dropdowns.forEach(dropdown => {
            if (!dropdown) return;
            const currentValue = dropdown.value;
            dropdown.innerHTML = '';

            data.clients.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.id;
                const statusBadge = c.ready ? ' ✅' : ' ⏳';
                const displayNum = c.number ? ` (+${c.number})` : '';
                const portLabel = c.port ? ` [:${c.port}]` : '';
                opt.textContent = `${c.name}${displayNum}${portLabel}${statusBadge}`;
                dropdown.appendChild(opt);
            });

            // Restore previous selection
            if (Array.from(dropdown.options).some(o => o.value === currentValue)) {
                dropdown.value = currentValue;
            }
        });
    } catch (err) {
        console.error('Error hydrating send dropdowns:', err);
    }
}

// Hydrate send dropdowns on initial page load too
window.addEventListener('load', () => setTimeout(hydrateSendClientDropdowns, 1000));

function switchLinkingMethod(method) {
    window.currentLinkingMethod = method;
    const tabQr = document.getElementById('tabQrLink');
    const tabPhone = document.getElementById('tabPhoneLink');
    const qrContainer = document.getElementById('accountQrContainer');
    const phoneContainer = document.getElementById('accountPhoneLinkContainer');

    if (method === 'qr') {
        tabQr.style.background = 'var(--primary)';
        tabQr.style.color = 'white';
        tabPhone.style.background = '#f1f5f9';
        tabPhone.style.color = 'var(--text)';
        qrContainer.style.display = 'block';
        phoneContainer.style.display = 'none';
    } else {
        tabPhone.style.background = 'var(--primary)';
        tabPhone.style.color = 'white';
        tabQr.style.background = '#f1f5f9';
        tabQr.style.color = 'var(--text)';
        qrContainer.style.display = 'none';
        phoneContainer.style.display = 'block';
    }
}

async function requestPhonePairingCode() {
    if (!activeClientId) return showToast('Please select an account first', 'warning');
    
    let phoneNumber = document.getElementById('linkPhoneNumber').value.trim();
    phoneNumber = phoneNumber.replace(/\D/g, ''); // Pure numbers

    if (!phoneNumber || phoneNumber.length < 10) {
        return showToast('Enter a valid phone number with country code (e.g. 919876543210)', 'warning');
    }

    const btn = document.getElementById('btnRequestPairingCode');
    btn.disabled = true;
    btn.textContent = 'Generating...';

    try {
        const response = await robustFetch('/clients/pairing-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clientId: activeClientId,
                phoneNumber: phoneNumber
            })
        });

        if (response.success && response.code) {
            showToast('Pairing code generated successfully!', 'success');
            document.getElementById('phoneLinkInputArea').style.display = 'none';
            document.getElementById('phoneLinkCodeArea').style.display = 'block';
            document.getElementById('pairingCodeDisplay').textContent = formatPairingCode(response.code);
        } else {
            showToast(response.error || 'Failed to generate code', 'error');
        }
    } catch (err) {
        showToast(err.message || 'Failed to generate code', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Get Code';
    }
}

function formatPairingCode(code) {
    if (!code) return '';
    // Format ABCDEFGH as ABCD-EFGH
    if (code.length === 8) {
        return code.substring(0, 4) + '-' + code.substring(4);
    }
    return code;
}

// Export to window
window.switchLinkingMethod = switchLinkingMethod;
window.requestPhonePairingCode = requestPhonePairingCode;
window.formatPairingCode = formatPairingCode;

function setupMobileSidebar() {
    const menuBtn = document.getElementById('mobileMenuBtn');
    const overlay = document.getElementById('sidebarOverlay');
    const sidebar = document.querySelector('.sidebar');
    const navLinks = document.querySelectorAll('.sidebar .nav-link');

    if (!menuBtn || !overlay || !sidebar) return;

    const openSidebar = () => {
        sidebar.classList.add('open');
        overlay.classList.add('active');
    };

    const closeSidebar = () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
    };

    menuBtn.addEventListener('click', openSidebar);
    overlay.addEventListener('click', closeSidebar);

    // Auto-close sidebar drawer when user selects a tab/link on mobile
    navLinks.forEach(link => {
        link.addEventListener('click', closeSidebar);
    });
}

async function renameActiveAccount() {
    if (!activeClientId) return;
    const newName = document.getElementById('renameAccountInput').value.trim();
    if (!newName) return showToast('Please enter a valid name', 'warning');

    try {
        const response = await fetch('/api/v1/clients/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: activeClientId, name: newName })
        });
        const result = await response.json();
        if (result.success) {
            showToast('Account renamed successfully', 'success');
            await fetchAndRenderAccounts();
            document.getElementById('activeAccountTitle').textContent = `Manage: ${newName}`;
        } else {
            showToast(result.error || 'Failed to rename account', 'error');
        }
    } catch (err) {
        console.error('Error renaming account:', err);
        showToast('Error connecting to server', 'error');
    }
}
window.renameActiveAccount = renameActiveAccount;


// ==========================================
// BATCH STOCK UI LOGIC (MULTI-SELECT)
// ==========================================

let batchStockMCs = [];
let selectedMcGroups = [];
let selectedMcs = [];

async function initBatchStockTab() {
    try {
        const configReq = await fetch(`${BUSY_API}/config`);
        const config = await configReq.json();
        const firmSelect = document.getElementById('bsFirmSelect');
        
        firmSelect.innerHTML = '';
        if (config.firms && config.firms.length > 0) {
            config.firms.forEach(f => {
                const opt = document.createElement('option');
                opt.value = f.id;
                opt.textContent = f.name || 'Unnamed Firm';
                firmSelect.appendChild(opt);
            });
            await loadBatchStockMcs(config.firms[0].id);
        } else {
            firmSelect.innerHTML = '<option value="">No firms available</option>';
        }
    } catch (err) {
        console.error("Error initializing batch stock:", err);
    }
}

async function loadBatchStockMcs(firmId) {
    if (!firmId) return;
    try {
        const mcReq = await fetch(`${BUSY_API}/material-centers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ firmId: firmId })
        });
        const mcData = await mcReq.json();
        
        if (mcData.success && mcData.materialCenters) {
            batchStockMCs = mcData.materialCenters;
            selectedMcGroups = [];
            selectedMcs = [];
            updateGroupButtonStatus();
            updateMcButtonStatus();
            renderGroupModalList();
            renderMcModalList();
        }
    } catch (err) {
        console.error("Error loading MCs for firm:", err);
    }
}

document.getElementById('bsFirmSelect')?.addEventListener('change', (e) => {
    loadBatchStockMcs(e.target.value);
});

// Group Modal Logic
function openGroupModal() {
    document.getElementById('bsGroupModal').classList.add('active');
    document.getElementById('bsGroupSearch').value = "";
    document.getElementById('bsGroupSearch').focus();
    renderGroupModalList();
}

function closeGroupModal() {
    document.getElementById('bsGroupModal').classList.remove('active');
    updateGroupButtonStatus();
    // Reset selected MCs when group filter changes
    selectedMcs = [];
    updateMcButtonStatus();
    renderMcModalList();
}

function renderGroupModalList(filter = "") {
    const list = document.getElementById('bsGroupList');
    const search = filter.toLowerCase();
    const groups = [...new Set(batchStockMCs.map(mc => mc.GroupName || 'Ungrouped'))].sort();
    
    const filtered = groups.filter(g => g.toLowerCase().includes(search));
    
    list.innerHTML = filtered.map(g => {
        const isChecked = selectedMcGroups.includes(g);
        return `
        <div style="display:flex; align-items:center; padding:8px; border-bottom:1px solid var(--border-color);">
            <input type="checkbox" id="chk_grp_${g}" value="${g}" ${isChecked ? 'checked' : ''} 
onchange="toggleMcGroup('${g}')" style="width:16px; height:16px; margin-right:10px;">
            <label for="chk_grp_${g}" style="font-size:13px; cursor:pointer; flex:1;">${g}</label>
        </div>
        `;
    }).join('');
    
    document.getElementById('bsGroupCountDisplay').innerText = `${filtered.length} visible`;
}

function toggleMcGroup(group) {
    if (selectedMcGroups.includes(group)) {
        selectedMcGroups = selectedMcGroups.filter(g => g !== group);
    } else {
        selectedMcGroups.push(group);
    }
}

function updateGroupButtonStatus() {
    const span = document.getElementById('groupSelectStatus');
    if (selectedMcGroups.length === 0) {
        span.textContent = 'Select Groups (All)';
        span.style.color = 'var(--text-secondary)';
    } else {
        span.textContent = `Select Groups (${selectedMcGroups.length} Selected)`;
        span.style.color = 'var(--primary)';
    }
    updateMcButtonStatus();
}

// MC Modal Logic
function openMcModal() {
    document.getElementById('bsMcModal').classList.add('active');
    document.getElementById('bsMcSearch').value = "";
    document.getElementById('bsMcSearch').focus();
    renderMcModalList();
}

function closeMcModal() {
    document.getElementById('bsMcModal').classList.remove('active');
    updateMcButtonStatus();
}

function renderMcModalList(filter = "") {
    const list = document.getElementById('bsMcList');
    const search = filter.toLowerCase();
    
    const availableMcs = selectedMcGroups.length > 0 
        ? batchStockMCs.filter(mc => selectedMcGroups.includes(mc.GroupName || 'Ungrouped'))
        : batchStockMCs;
        
    const filtered = availableMcs.filter(mc => (mc.Name || '').toLowerCase().includes(search)).sort((a,b) => (a.Name||'').localeCompare(b.Name||''));
    
    list.innerHTML = filtered.map(mc => {
        const isChecked = selectedMcs.includes(mc.Name);
        return `
        <div style="display:flex; align-items:center; padding:8px; border-bottom:1px solid var(--border-color);">
            <input type="checkbox" id="chk_mc_${mc.Code}" value="${mc.Name}" ${isChecked ? 'checked' : ''} 
onchange="toggleMc('${mc.Name}')" style="width:16px; height:16px; margin-right:10px;">
            <label for="chk_mc_${mc.Code}" style="font-size:13px; cursor:pointer; flex:1;">${mc.Name}</label>
        </div>
        `;
    }).join('');
    
    document.getElementById('bsMcCountDisplay').innerText = `${filtered.length} visible`;
}

function toggleMc(mcName) {
    if (selectedMcs.includes(mcName)) {
        selectedMcs = selectedMcs.filter(m => m !== mcName);
    } else {
        selectedMcs.push(mcName);
    }
}

function updateMcButtonStatus() {
    const span = document.getElementById('mcSelectStatus');
    if (selectedMcs.length === 0) {
        if (selectedMcGroups.length > 0) {
            span.textContent = 'Auto-Filtered by Group';
            span.style.color = 'var(--primary)';
        } else {
            span.textContent = 'Select Material Centres (All)';
            span.style.color = 'var(--text-secondary)';
        }
    } else {
        span.textContent = `Select Material Centres (${selectedMcs.length} Selected)`;
        span.style.color = 'var(--primary)';
    }
}

window.addEventListener('load', () => {
    document.getElementById('btnOpenGroupModal')?.addEventListener('click', openGroupModal);
    document.getElementById('bsGroupModalClose')?.addEventListener('click', closeGroupModal);
    document.getElementById('bsGroupModalSave')?.addEventListener('click', closeGroupModal);
    document.getElementById('bsGroupSearch')?.addEventListener('input', (e) => renderGroupModalList(e.target.value));
    document.getElementById('bsGroupSelectAll')?.addEventListener('click', (e) => {
        e.preventDefault();
        const groups = [...new Set(batchStockMCs.map(mc => mc.GroupName || 'Ungrouped'))];
        selectedMcGroups = groups;
        renderGroupModalList(document.getElementById('bsGroupSearch').value);
    });
    document.getElementById('bsGroupDeselectAll')?.addEventListener('click', (e) => {
        e.preventDefault();
        selectedMcGroups = [];
        renderGroupModalList(document.getElementById('bsGroupSearch').value);
    });

    document.getElementById('btnOpenMcModal')?.addEventListener('click', openMcModal);
    document.getElementById('bsMcModalClose')?.addEventListener('click', closeMcModal);
    document.getElementById('bsMcModalSave')?.addEventListener('click', closeMcModal);
    document.getElementById('bsMcSearch')?.addEventListener('input', (e) => renderMcModalList(e.target.value));
    document.getElementById('bsMcSelectAll')?.addEventListener('click', (e) => {
        e.preventDefault();
        const availableMcs = selectedMcGroups.length > 0 
            ? batchStockMCs.filter(mc => selectedMcGroups.includes(mc.GroupName || 'Ungrouped'))
            : batchStockMCs;
        selectedMcs = availableMcs.map(mc => mc.Name);
        renderMcModalList(document.getElementById('bsMcSearch').value);
    });
    document.getElementById('bsMcDeselectAll')?.addEventListener('click', (e) => {
        e.preventDefault();
        selectedMcs = [];
        renderMcModalList(document.getElementById('bsMcSearch').value);
    });

    // View and PDF Logic
    document.getElementById('btnViewBatchStock')?.addEventListener('click', async () => {
        const btn = document.getElementById('btnViewBatchStock');
        const feedback = document.getElementById('batchStockFeedback');
        const tbody = document.getElementById('batchStockTableBody');
        const activeFirmId = document.getElementById('bsFirmSelect').value;
        
        if (!activeFirmId) {
            feedback.textContent = 'Please select a firm first.';
            feedback.style.color = 'var(--error)';
            return;
        }

        let effectiveMcs = [...selectedMcs];
        if (effectiveMcs.length === 0 && selectedMcGroups.length > 0) {
            effectiveMcs = batchStockMCs
                .filter(mc => selectedMcGroups.includes(mc.GroupName || 'Ungrouped'))
                .map(mc => mc.Name);
        }

        btn.disabled = true;
        btn.innerHTML = '⏳ Loading...';
        feedback.textContent = '';
        
        try {
            const res = await fetch(`${BUSY_API}/batch-stock-ui`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ firmId: activeFirmId, mcFilters: effectiveMcs })
            });
            const data = await res.json();
            
            if (data.success) {
                tbody.innerHTML = '';
                if (data.items.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="8" style="padding: 24px; text-align: center; color: var(--text-secondary);">No batch stock found for the selected filters.</td></tr>';
                } else {
                    data.items.forEach(item => {
                        const tr = document.createElement('tr');
                        tr.style.borderBottom = '1px solid var(--border-color)';
                        
                        const itemName = item.ItemName || '';
                        const unit = (item.UnitName || item.Unit || (itemName.toLowerCase().includes("popline") ? "Metre" : "Pcs.")).trim();

                        const formatQty = (val) => {
                            if (val === undefined || val === null) return 0;
                            const num = parseFloat(val);
                            if (isNaN(num)) return 0;
                            // Round to 3 decimals then parse to float to drop trailing zeros (e.g. 5.68e-14 becomes 0)
                            return parseFloat(num.toFixed(3));
                        };

                        const qtyIn = formatQty(item.QtyIn);
                        const qtyOut = formatQty(item.QtyOut);
                        const closingQty = formatQty(item.ClosingQty);

                        tr.innerHTML = `
                            <td style="padding: 12px 16px; white-space: nowrap;">${item.VchDate || ''}</td>
                            <td style="padding: 12px 16px;">${itemName}</td>
                            <td style="padding: 12px 16px;">${unit}</td>
                            <td style="padding: 12px 16px;">${item.PartyName || ''}</td>
                            <td style="padding: 12px 16px;">${item.BatchNo || ''}</td>
                            <td style="padding: 12px 16px; text-align: right;">${qtyIn}</td>
                            <td style="padding: 12px 16px; text-align: right;">${qtyOut}</td>
                            <td style="padding: 12px 16px; text-align: right; font-weight: 600; color: ${closingQty > 0 ? 'var(--success)' : 'inherit'}">${closingQty}</td>
                        `;
                        tbody.appendChild(tr);
                    });
                }
                feedback.textContent = `Found ${data.items.length} records.`;
                feedback.style.color = 'var(--success)';
            } else {
                throw new Error(data.error || 'Failed to fetch data');
            }
        } catch (err) {
            console.error(err);
            feedback.textContent = `Error: ${err.message}`;
            feedback.style.color = 'var(--error)';
            tbody.innerHTML = '<tr><td colspan="8" style="padding: 24px; text-align: center; color: var(--error);">Error loading data.</td></tr>';
        } finally {
            btn.disabled = false;
            btn.innerHTML = '👁️ View Data';
        }
    });

    document.getElementById('btnGenerateBatchPdf')?.addEventListener('click', async () => {
        const btn = document.getElementById('btnGenerateBatchPdf');
        const feedback = document.getElementById('batchStockFeedback');
        const activeFirmId = document.getElementById('bsFirmSelect').value;
        
        if (!activeFirmId) {
            feedback.textContent = 'Please select a firm first.';
            feedback.style.color = 'var(--error)';
            return;
        }

        let effectiveMcs = [...selectedMcs];
        if (effectiveMcs.length === 0 && selectedMcGroups.length > 0) {
            effectiveMcs = batchStockMCs
                .filter(mc => selectedMcGroups.includes(mc.GroupName || 'Ungrouped'))
                .map(mc => mc.Name);
        }
        
        btn.disabled = true;
        btn.innerHTML = '⏳ Generating...';
        feedback.textContent = 'Generating PDF... Please wait.';
        feedback.style.color = 'var(--text-secondary)';
        
        try {
            const res = await fetch(`${BUSY_API}/batch-stock-pdf`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ firmId: activeFirmId, mcFilters: effectiveMcs })
            });
            
            if (res.ok) {
                const blob = await res.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `Batch_Stock_Report.pdf`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                window.URL.revokeObjectURL(url);
                
                feedback.textContent = 'PDF downloaded successfully!';
                feedback.style.color = 'var(--success)';
            } else {
                const data = await res.json();
                throw new Error(data.error || 'Failed to generate PDF');
            }
        } catch (err) {
            console.error(err);
            feedback.textContent = `Error: ${err.message}`;
            feedback.style.color = 'var(--error)';
        } finally {
            btn.disabled = false;
            btn.innerHTML = '📄 Generate PDF';
        }
    });

    document.querySelectorAll('.nav-link[data-tab="batchstock"]').forEach(el => {
        el.addEventListener('click', () => {
            if (batchStockMCs.length === 0) {
                initBatchStockTab();
            }
        });
    });

    // ==========================================
    // PAYMENT CONFIG LOGIC
    // ==========================================
    async function initPaymentConfigTab() {
        const select = document.getElementById('payFirmSelect');
        select.innerHTML = '<option value="">Select a Firm</option>';
        currentFirms.forEach(f => {
            select.innerHTML += `<option value="${f.id}">${f.name || 'Unnamed Firm'}</option>`;
        });
        
        if (activeFirmId) {
            select.value = activeFirmId;
        } else if (currentFirms.length > 0) {
            select.value = currentFirms[0].id;
        }
        
        // Remove old listeners to prevent duplicates
        const newSelect = select.cloneNode(true);
        select.parentNode.replaceChild(newSelect, select);
        
        newSelect.addEventListener('change', (e) => {
            loadPaymentConfig(e.target.value);
        });
        
        loadPaymentConfig(newSelect.value);
    }

    async function loadPaymentConfig(firmIdParam) {
        const firmId = firmIdParam || document.getElementById('payFirmSelect').value;
        if (!firmId) {
            showToast("Please select a firm.", 'warning');
            return;
        }
        try {
            const res = await fetch(`/api/payment-config?firmId=${firmId}`);
            const data = await res.json();
            if (data.success && data.paymentDetails) {
                const p = data.paymentDetails;
                document.getElementById('payBankName').value = p.bankName || "";
                document.getElementById('payAccountName').value = p.accountName || "";
                document.getElementById('payAccountNumber').value = p.accountNumber || "";
                document.getElementById('payIfscCode').value = p.ifscCode || "";
                document.getElementById('payUpiId').value = p.upiId || "";
                document.getElementById('payPhone').value = p.phone || "";
                if (p.qrCodePath) {
                    document.getElementById('payQrPreview').innerText = "QR Code Image Uploaded";
                }
            } else {
                // Clear fields if no data
                document.getElementById('payBankName').value = "";
                document.getElementById('payAccountName').value = "";
                document.getElementById('payAccountNumber').value = "";
                document.getElementById('payIfscCode').value = "";
                document.getElementById('payUpiId').value = "";
                document.getElementById('payPhone').value = "";
                document.getElementById('payQrPreview').innerText = "";
            }
        } catch (e) {
            console.error("Failed to load payment config", e);
        }
    }

    window.savePaymentConfig = async function() {
        const firmId = document.getElementById('payFirmSelect').value;
        if (!firmId) {
            showToast("Please select a firm.", 'warning');
            return;
        }
        try {
            const formData = new FormData();
            formData.append('firmId', firmId);
            formData.append('bankName', document.getElementById('payBankName').value);
            formData.append('accountName', document.getElementById('payAccountName').value);
            formData.append('accountNumber', document.getElementById('payAccountNumber').value);
            formData.append('ifscCode', document.getElementById('payIfscCode').value);
            formData.append('upiId', document.getElementById('payUpiId').value);
            formData.append('phone', document.getElementById('payPhone').value);

            const fileInput = document.getElementById('payQrImage');
            if (fileInput.files.length > 0) {
                formData.append('qrImage', fileInput.files[0]);
            }

            const btn = event.target;
            const originalText = btn.innerText;
            btn.disabled = true;
            btn.innerText = "Saving...";

            const res = await fetch('/api/payment-config', {
                method: 'POST',
                body: formData
            });
            const data = await res.json();

            btn.disabled = false;
            btn.innerText = originalText;

            if (data.success) {
                showToast("Payment Details Saved Successfully!", "success");
            } else {
                showToast("Failed to save: " + data.error, "error");
            }
        } catch (e) {
            console.error("Save payment config error", e);
            showToast("Failed to save: " + e.message, "error");
        }
    };

    document.querySelectorAll('.nav-link[data-tab="paymentconfig"]').forEach(el => {
        el.addEventListener('click', () => {
            initPaymentConfigTab();
        });
    });
});

// ==========================================
// In-App Auto-Updater Logic
// ==========================================
let updatePollingInterval = null;

async function checkSystemUpdate(isManual = false) {
    const btn = document.getElementById('btnCheckUpdate');
    const updateBadge = document.getElementById('updateBadgeStatus');
    const currentVerEl = document.getElementById('displayCurrentVersion');
    const latestVerEl = document.getElementById('displayLatestVersion');
    const lastCheckedEl = document.getElementById('displayLastChecked');
    const performBtn = document.getElementById('btnPerformUpdate');
    const commitRow = document.getElementById('displayCommitRow');
    const commitMsgEl = document.getElementById('displayCommitMsg');
    const banner = document.getElementById('updateBanner');
    const bannerTitle = document.getElementById('updateBannerTitle');
    const bannerDesc = document.getElementById('updateBannerDesc');

    if (btn && isManual) {
        btn.disabled = true;
        btn.innerText = 'Checking...';
    }

    try {
        const res = await fetch('/api/update/check');
        const data = await res.json();

        if (currentVerEl) currentVerEl.textContent = data.currentVersion || '1.0.0';
        if (latestVerEl) {
            if (data.latestVersion) {
                latestVerEl.textContent = 'v' + data.latestVersion + (data.commitHash ? ` (${data.commitHash})` : '');
            } else if (data.error || (data.message && data.message.includes('private'))) {
                latestVerEl.textContent = 'Notice (See Below)';
            } else {
                latestVerEl.textContent = 'v' + (data.currentVersion || '1.0.0');
            }
        }
        if (updateBadge) updateBadge.textContent = 'v' + (data.currentVersion || '1.0.0');
        if (lastCheckedEl) lastCheckedEl.textContent = new Date().toLocaleTimeString();

        if (data.commitMessage && commitRow && commitMsgEl) {
            commitRow.style.display = 'flex';
            commitMsgEl.textContent = data.commitMessage;
        }

        const feedbackEl = document.getElementById('updateCheckFeedback');
        if (data.updateAvailable) {
            if (performBtn) performBtn.style.display = 'inline-flex';
            if (feedbackEl) {
                feedbackEl.style.display = 'block';
                feedbackEl.style.background = '#eff6ff';
                feedbackEl.style.color = '#1d4ed8';
                feedbackEl.style.border = '1px solid #bfdbfe';
                feedbackEl.innerHTML = `🚀 <strong>Update Available: v${data.latestVersion || 'Latest'}</strong><br><span style="font-size: 11.5px; font-weight: 500;">${data.commitMessage || 'Click Update Now below to apply.'}</span>`;
            }
            if (banner) {
                banner.style.display = 'flex';
                if (bannerTitle) bannerTitle.textContent = `New Update Available: v${data.latestVersion || 'Latest'}`;
                if (bannerDesc) bannerDesc.textContent = data.commitMessage || 'A new version of WA Sender is ready to install.';
            }
        } else if (data.error || (data.message && data.message.includes('private'))) {
            if (performBtn) performBtn.style.display = 'none';
            if (feedbackEl && isManual) {
                feedbackEl.style.display = 'block';
                feedbackEl.style.background = '#fffbeb';
                feedbackEl.style.color = '#b45309';
                feedbackEl.style.border = '1px solid #fde68a';
                feedbackEl.innerHTML = `⚠️ <strong>Update Notice:</strong> ${data.message || data.error}`;
            }
        } else {
            if (performBtn) performBtn.style.display = 'none';
            if (feedbackEl) {
                feedbackEl.style.display = 'block';
                feedbackEl.style.background = '#ecfdf5';
                feedbackEl.style.color = '#059669';
                feedbackEl.style.border = '1px solid #a7f3d0';
                feedbackEl.innerHTML = `✅ <strong>Your system is fully up to date!</strong> (v${data.currentVersion || '1.0.0'})`;
            }
        }
    } catch (err) {
        console.error('Update check failed:', err);
        if (latestVerEl) latestVerEl.textContent = 'Check failed';
        const feedbackEl = document.getElementById('updateCheckFeedback');
        if (feedbackEl && isManual) {
            feedbackEl.style.display = 'block';
            feedbackEl.style.background = '#fef2f2';
            feedbackEl.style.color = '#dc2626';
            feedbackEl.style.border = '1px solid #fecaca';
            feedbackEl.innerHTML = `❌ <strong>Check failed:</strong> ${err.message || 'Unable to reach update server'}`;
        }
    } finally {
        if (btn && isManual) {
            btn.disabled = false;
            btn.innerText = '🔄 Check for Updates';
        }
    }
}

function dismissUpdateBanner() {
    const banner = document.getElementById('updateBanner');
    if (banner) banner.style.display = 'none';
}

async function triggerUpdateFlow() {
    if (!confirm('Are you sure you want to update WA Sender now?\n\n- Local configurations & WhatsApp sessions will be preserved.\n- The server will download files and automatically restart.')) {
        return;
    }

    const modal = document.getElementById('updateModal');
    const modalIcon = document.getElementById('updateModalIcon');
    const modalTitle = document.getElementById('updateModalTitle');
    const modalMsg = document.getElementById('updateModalMsg');
    const progressBar = document.getElementById('updateModalProgressBar');
    const stepEl = document.getElementById('updateModalStep');
    const pctEl = document.getElementById('updateModalPct');
    const actionsEl = document.getElementById('updateModalSuccessActions');

    if (modal) modal.classList.add('active');
    if (progressBar) progressBar.style.width = '10%';
    if (stepEl) stepEl.textContent = 'Initiating update...';
    if (pctEl) pctEl.textContent = '10%';

    try {
        const res = await fetch('/api/update/apply', { method: 'POST' });
        const data = await res.json();

        if (!data.success && data.error) {
            throw new Error(data.error);
        }

        // Start polling status
        pollUpdateProgress();

    } catch (err) {
        console.error('Failed to trigger update:', err);
        if (modalIcon) modalIcon.textContent = '❌';
        if (modalTitle) modalTitle.textContent = 'Update Failed';
        if (modalMsg) modalMsg.textContent = err.message || 'Could not start update process.';
        if (stepEl) stepEl.textContent = 'Failed';
        if (actionsEl) {
            actionsEl.style.display = 'block';
            actionsEl.querySelector('button').textContent = 'Close';
            actionsEl.querySelector('button').onclick = () => {
                modal.classList.remove('active');
            };
        }
    }
}

function pollUpdateProgress() {
    if (updatePollingInterval) clearInterval(updatePollingInterval);

    const progressBar = document.getElementById('updateModalProgressBar');
    const stepEl = document.getElementById('updateModalStep');
    const pctEl = document.getElementById('updateModalPct');
    const modalTitle = document.getElementById('updateModalTitle');
    const modalMsg = document.getElementById('updateModalMsg');
    const modalIcon = document.getElementById('updateModalIcon');
    const actionsEl = document.getElementById('updateModalSuccessActions');

    let serverRestarting = false;
    let attempts = 0;

    updatePollingInterval = setInterval(async () => {
        try {
            attempts++;
            const res = await fetch('/api/update/status', { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const status = await res.json();

            if (status.progress && progressBar) {
                progressBar.style.width = `${status.progress}%`;
            }
            if (pctEl && status.progress) {
                pctEl.textContent = `${status.progress}%`;
            }
            if (stepEl && status.message) {
                stepEl.textContent = status.message;
            }

            if (status.state === 'restarting') {
                serverRestarting = true;
                if (modalTitle) modalTitle.textContent = 'Restarting Server...';
                if (modalMsg) modalMsg.textContent = 'Applying updates and restarting background services. Reconnecting in a few seconds...';
                if (progressBar) progressBar.style.width = '100%';
                if (pctEl) pctEl.textContent = '100%';
            } else if (status.state === 'error') {
                clearInterval(updatePollingInterval);
                if (modalIcon) modalIcon.textContent = '❌';
                if (modalTitle) modalTitle.textContent = 'Update Error';
                if (modalMsg) modalMsg.textContent = status.error || status.message || 'An error occurred during update.';
                if (actionsEl) {
                    actionsEl.style.display = 'block';
                    actionsEl.querySelector('button').textContent = 'Close';
                    actionsEl.querySelector('button').onclick = () => {
                        document.getElementById('updateModal').classList.remove('active');
                    };
                }
            }
        } catch (netErr) {
            // Server has dropped offline during restart - this is EXPECTED
            if (serverRestarting || attempts > 4) {
                if (modalTitle) modalTitle.textContent = 'Restarting WA Sender...';
                if (stepEl) stepEl.textContent = 'Waiting for server to come back online...';

                // Poll for server revival
                setTimeout(async () => {
                    try {
                        const ping = await fetch('/api/update/status', { cache: 'no-store' });
                        if (ping.ok) {
                            clearInterval(updatePollingInterval);
                            if (modalIcon) modalIcon.textContent = '🎉';
                            if (modalTitle) modalTitle.textContent = 'Update Complete!';
                            if (modalMsg) modalMsg.textContent = 'WA Sender has been updated successfully! Reloading...';
                            setTimeout(() => {
                                window.location.reload();
                            }, 1500);
                        }
                    } catch (e) {
                        // Still restarting
                    }
                }, 1000);
            }
        }
    }, 1200);
}

// ==========================================
// BUSY WhatsApp Configuration Copy & Test Helpers
// ==========================================
function copyTextDirect(text, btnElement, successMsg = 'Copied!') {
    if (!text) return;
    const triggerVisualFeedback = () => {
        showToast(successMsg, 'success');
        if (btnElement) {
            const origHtml = btnElement.innerHTML;
            btnElement.innerHTML = '✅ Copied!';
            btnElement.style.borderColor = '#10b981';
            setTimeout(() => {
                btnElement.innerHTML = origHtml;
                btnElement.style.borderColor = '';
            }, 1800);
        }
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(triggerVisualFeedback).catch(() => {
            fallbackCopyText(text, triggerVisualFeedback);
        });
    } else {
        fallbackCopyText(text, triggerVisualFeedback);
    }
}

function fallbackCopyText(text, callback) {
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        if (typeof callback === 'function') callback();
    } catch (e) {
        showToast('Failed to copy. Please copy manually.', 'error');
    }
}

function copyBusyField(elementId, btnElement, successMsg = 'Copied!') {
    const el = document.getElementById(elementId);
    if (!el) return;
    const text = (el.value !== undefined ? el.value : (el.innerText || el.textContent || '')).trim();
    copyTextDirect(text, btnElement, successMsg);
}

function updateBusyApiUrlDisplay() {
    const selector = document.getElementById('busyHostSelector');
    let host = 'http://localhost:5000';
    if (selector) {
        if (selector.value === 'current') {
            host = window.location.origin;
        } else {
            host = selector.value;
        }
    }
    const fullApiUrl = `${host}/api/v1/send?`;

    const quickDisplay = document.getElementById('quickApiUrlDisplay');
    if (quickDisplay) quickDisplay.textContent = fullApiUrl;

    const replicaInput = document.getElementById('replicaApiInput');
    if (replicaInput) replicaInput.value = fullApiUrl;
}

async function testBusyApiEndpoint() {
    const mobileInput = document.getElementById('testBusyMobile');
    const msgInput = document.getElementById('testBusyMessage');
    const resultDiv = document.getElementById('testBusyApiResult');
    const btn = document.getElementById('btnTestBusyApi');

    const mobile = (mobileInput?.value || '').trim();
    const message = (msgInput?.value || '').trim();

    if (!mobile) {
        showToast('Please enter a recipient mobile number', 'warning');
        if (mobileInput) mobileInput.focus();
        return;
    }
    if (!message) {
        showToast('Please enter a test message', 'warning');
        if (msgInput) msgInput.focus();
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Sending test message...';
    }

    try {
        const testUrl = `/api/v1/send?Mobile=${encodeURIComponent(mobile)}&Message=${encodeURIComponent(message)}`;
        const res = await fetch(testUrl, { method: 'GET' });
        const data = await res.json();

        if (resultDiv) {
            resultDiv.style.display = 'block';
            if (res.ok && data.success) {
                resultDiv.style.background = '#ecfdf5';
                resultDiv.style.color = '#065f46';
                resultDiv.style.border = '1px solid #a7f3d0';
                resultDiv.innerHTML = `✅ <strong>Success! Message received by WA Sender:</strong><br><pre style="margin-top: 6px; font-size: 11.5px; background: rgba(0,0,0,0.04); padding: 8px; border-radius: 6px;">${JSON.stringify(data, null, 2)}</pre>`;
                showToast('Test message queued successfully!', 'success');
            } else {
                resultDiv.style.background = '#fef2f2';
                resultDiv.style.color = '#991b1b';
                resultDiv.style.border = '1px solid #fecaca';
                resultDiv.innerHTML = `❌ <strong>API Error:</strong> ${data.error || 'Failed to queue message'}`;
                showToast(data.error || 'Failed to send test message', 'error');
            }
        }
    } catch (err) {
        if (resultDiv) {
            resultDiv.style.display = 'block';
            resultDiv.style.background = '#fef2f2';
            resultDiv.style.color = '#991b1b';
            resultDiv.style.border = '1px solid #fecaca';
            resultDiv.innerHTML = `❌ <strong>Network request failed:</strong> ${err.message}`;
        }
        showToast('Network error while testing API', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<span>🚀</span> Test Send from BUSY API';
        }
    }
}
