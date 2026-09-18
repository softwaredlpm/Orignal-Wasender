const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn, exec } = require('child_process');

class AppUpdater {
    constructor(appDir, config = {}) {
        this.appDir = appDir;
        this.config = config;
        this.repo = config.github_repo || 'softwaredlpm/Orignal-Wasender';
        this.branch = config.github_branch || 'main';
        this.githubToken = config.github_token || process.env.GITHUB_TOKEN || '';

        this.status = {
            state: 'idle', // 'idle', 'checking', 'available', 'downloading', 'extracting', 'applying', 'restarting', 'success', 'error'
            message: 'Ready',
            progress: 0,
            lastChecked: null,
            currentVersion: this.getLocalVersion(),
            latestVersion: null,
            commitMessage: null,
            commitHash: null,
            publishedAt: null,
            updateAvailable: false,
            error: null
        };

        this.protectedFiles = new Set([
            'busy_config.json',
            'config.json',
            'users.json',
            'client_ports.json',
            'client_names.json',
            'license.key',
            'logs.json',
            'queue.json',
            'uploads',
            '.wwebjs_auth',
            '.wwebjs_cache',
            'node_modules',
            'dist',
            'backup_previous_version',
            'temp_update',
            '.git'
        ]);
    }

    getLocalVersion() {
        try {
            const pkgPath = path.join(this.appDir, 'package.json');
            if (fs.existsSync(pkgPath)) {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                return pkg.version || '1.0.0';
            }
        } catch (e) {
            console.error('[Updater] Error reading local package.json version:', e.message);
        }
        return '1.0.0';
    }

    getStatus() {
        this.status.currentVersion = this.getLocalVersion();
        return this.status;
    }

    getHeaders() {
        const headers = {
            'User-Agent': 'WA-Sender-Updater/1.0',
            'Accept': 'application/vnd.github.v3+json'
        };
        if (this.githubToken) {
            headers['Authorization'] = `token ${this.githubToken}`;
        }
        return headers;
    }

    async request(url, customHeaders = {}) {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;
            const headers = { ...this.getHeaders(), ...customHeaders };

            const req = client.get(url, { headers }, (res) => {
                // Follow redirects
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return resolve(this.request(res.headers.location, customHeaders));
                }

                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ statusCode: res.statusCode, body: data, headers: res.headers });
                    } else {
                        reject(new Error(`GitHub request failed (${res.statusCode}): ${data || res.statusMessage}`));
                    }
                });
            });

            req.on('error', reject);
            req.setTimeout(15000, () => {
                req.destroy();
                reject(new Error('GitHub request timed out (15s)'));
            });
        });
    }

    async downloadFile(url, destPath, onProgress) {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;
            const headers = this.getHeaders();

            const req = client.get(url, { headers }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return resolve(this.downloadFile(res.headers.location, destPath, onProgress));
                }

                if (res.statusCode !== 200) {
                    return reject(new Error(`Download failed with status ${res.statusCode}: ${res.statusMessage}`));
                }

                const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
                let downloadedBytes = 0;
                const fileStream = fs.createWriteStream(destPath);

                res.on('data', (chunk) => {
                    downloadedBytes += chunk.length;
                    if (totalBytes > 0 && typeof onProgress === 'function') {
                        const pct = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
                        onProgress(pct, downloadedBytes, totalBytes);
                    }
                });

                res.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close(() => resolve(destPath));
                });

                fileStream.on('error', (err) => {
                    fs.unlink(destPath, () => { });
                    reject(err);
                });
            });

            req.on('error', reject);
            req.setTimeout(60000, () => {
                req.destroy();
                reject(new Error('Download timed out after 60 seconds'));
            });
        });
    }

    compareVersions(v1, v2) {
        const p1 = (v1 || '0.0.0').split('.').map(Number);
        const p2 = (v2 || '0.0.0').split('.').map(Number);
        for (let i = 0; i < 3; i++) {
            const a = p1[i] || 0;
            const b = p2[i] || 0;
            if (a > b) return 1;
            if (a < b) return -1;
        }
        return 0;
    }

    async checkForUpdates() {
        this.status.state = 'checking';
        this.status.message = 'Checking for updates...';
        this.status.error = null;

        try {
            const currentVersion = this.getLocalVersion();
            this.status.currentVersion = currentVersion;
            this.status.lastChecked = new Date().toISOString();

            // Try 1: Check GitHub Releases
            try {
                const releaseRes = await this.request(`https://api.github.com/repos/${this.repo}/releases/latest`);
                const release = JSON.parse(releaseRes.body);
                const tagVersion = (release.tag_name || '').replace(/^v/, '');

                if (tagVersion && this.compareVersions(tagVersion, currentVersion) > 0) {
                    this.status.state = 'available';
                    this.status.updateAvailable = true;
                    this.status.latestVersion = tagVersion;
                    this.status.commitMessage = release.name || release.body || 'New release available';
                    this.status.publishedAt = release.published_at;
                    this.status.message = `Update ${tagVersion} is available!`;
                    return this.status;
                }
            } catch (relErr) {
                // If no releases found, fall back to checking commits or package.json
            }

            // Try 2: Check latest commit on main branch
            try {
                const commitRes = await this.request(`https://api.github.com/repos/${this.repo}/commits/${this.branch}`);
                const commitData = JSON.parse(commitRes.body);
                const latestCommitHash = (commitData.sha || '').substring(0, 7);
                const commitMsg = commitData.commit && commitData.commit.message ? commitData.commit.message.split('\n')[0] : '';
                const commitDate = commitData.commit && commitData.commit.committer ? commitData.commit.committer.date : null;

                // Try fetching remote package.json to see if remote version is higher
                let remoteVersion = currentVersion;
                try {
                    const rawPkgRes = await this.request(`https://raw.githubusercontent.com/${this.repo}/${this.branch}/package.json`);
                    const remotePkg = JSON.parse(rawPkgRes.body);
                    if (remotePkg.version) {
                        remoteVersion = remotePkg.version;
                    }
                } catch (e) { }

                const isVersionNewer = this.compareVersions(remoteVersion, currentVersion) > 0;
                
                // Read last installed commit if stored
                const commitTrackerFile = path.join(this.appDir, '.installed_commit');
                let installedCommit = '';
                if (fs.existsSync(commitTrackerFile)) {
                    installedCommit = fs.readFileSync(commitTrackerFile, 'utf8').trim();
                }

                const isNewCommit = latestCommitHash && installedCommit && latestCommitHash !== installedCommit;
                const updateAvailable = isVersionNewer || (isNewCommit && !installedCommit.startsWith(latestCommitHash));

                this.status.latestVersion = remoteVersion;
                this.status.commitHash = latestCommitHash;
                this.status.commitMessage = commitMsg;
                this.status.publishedAt = commitDate;
                this.status.updateAvailable = updateAvailable;

                if (updateAvailable) {
                    this.status.state = 'available';
                    this.status.message = `Update available: ${remoteVersion} (${latestCommitHash})`;
                } else {
                    this.status.state = 'idle';
                    this.status.message = 'Your software is up to date!';
                }

                return this.status;
            } catch (commitErr) {
                throw new Error(`Could not fetch branch commits: ${commitErr.message}`);
            }
        } catch (err) {
            this.status.state = 'error';
            this.status.error = err.message;
            this.status.message = `Check failed: ${err.message}`;
            console.error('[Updater] Error during update check:', err.message);
            return this.status;
        }
    }

    async applyUpdate() {
        if (this.status.state === 'downloading' || this.status.state === 'applying') {
            throw new Error('Update is already in progress!');
        }

        const tempDir = path.join(this.appDir, 'temp_update');
        const zipFile = path.join(this.appDir, 'temp_update.zip');
        const backupDir = path.join(this.appDir, 'backup_previous_version');

        try {
            this.status.state = 'downloading';
            this.status.progress = 5;
            this.status.message = 'Downloading update archive from GitHub...';

            // Clean previous temp dirs if exist
            if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
            if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile);

            // 1. Download repository zip
            const zipUrl = `https://github.com/${this.repo}/archive/refs/heads/${this.branch}.zip`;
            console.log(`[Updater] Downloading zip from ${zipUrl}...`);

            await this.downloadFile(zipUrl, zipFile, (pct) => {
                this.status.progress = 5 + Math.round((pct * 0.45)); // 5% -> 50%
                this.status.message = `Downloading update... (${pct}%)`;
            });

            this.status.state = 'extracting';
            this.status.progress = 55;
            this.status.message = 'Extracting update package...';

            // 2. Extract using Windows PowerShell Expand-Archive (built into every Windows 10/11)
            await new Promise((resolve, reject) => {
                const psCmd = `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${tempDir}' -Force`;
                exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psCmd}"`, (err, stdout, stderr) => {
                    if (err) return reject(new Error(`Extraction failed: ${stderr || err.message}`));
                    resolve();
                });
            });

            this.status.state = 'applying';
            this.status.progress = 70;
            this.status.message = 'Backing up configuration and applying files...';

            // Find extracted inner directory (GitHub zips root as <RepoName>-<branch>)
            const extractedItems = fs.readdirSync(tempDir);
            let sourceRoot = tempDir;
            if (extractedItems.length === 1 && fs.statSync(path.join(tempDir, extractedItems[0])).isDirectory()) {
                sourceRoot = path.join(tempDir, extractedItems[0]);
            }

            // 3. Create Backup of critical code files
            if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
            const filesToBackup = ['server.js', 'busy_service.js', 'package.json'];
            for (const f of filesToBackup) {
                const srcPath = path.join(this.appDir, f);
                if (fs.existsSync(srcPath)) {
                    fs.copyFileSync(srcPath, path.join(backupDir, f));
                }
            }

            // 4. Copy updated files while strictly respecting Protected / Excluded list
            this.copyDirectorySafe(sourceRoot, this.appDir);

            // Save installed commit hash or timestamp
            if (this.status.commitHash) {
                fs.writeFileSync(path.join(this.appDir, '.installed_commit'), this.status.commitHash, 'utf8');
            }

            this.status.progress = 90;
            this.status.message = 'Cleaning temporary files...';

            // 5. Cleanup temp files
            try {
                if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile);
                if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (cleanErr) {
                console.warn('[Updater] Temp cleanup warning:', cleanErr.message);
            }

            this.status.state = 'restarting';
            this.status.progress = 100;
            this.status.message = 'Update installed successfully! Restarting server in 2 seconds...';

            // 6. Trigger Graceful Detached Restart
            this.scheduleServerRestart();

            return {
                success: true,
                message: 'Update applied successfully. Server is restarting.'
            };

        } catch (err) {
            this.status.state = 'error';
            this.status.error = err.message;
            this.status.message = `Update failed: ${err.message}`;
            console.error('[Updater] Update process failed:', err);
            throw err;
        }
    }

    copyDirectorySafe(src, dest) {
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
        }

        const entries = fs.readdirSync(src, { withFileTypes: true });

        for (const entry of entries) {
            const name = entry.name;
            const srcPath = path.join(src, name);
            const destPath = path.join(dest, name);

            // CRITICAL: NEVER overwrite protected/custom customer files
            if (this.protectedFiles.has(name)) {
                // If it's a file that already exists on customer PC, skip it!
                if (fs.existsSync(destPath)) {
                    console.log(`[Updater] Safeguarding existing customer config: ${name}`);
                    continue;
                }
            }

            if (entry.isDirectory()) {
                this.copyDirectorySafe(srcPath, destPath);
            } else {
                fs.copyFileSync(srcPath, destPath);
            }
        }
    }

    scheduleServerRestart() {
        console.log('[Updater] Scheduling detached server restart...');
        // Create an autonomous restart batch script that waits, releases port 5000, and restarts server
        const restartScriptPath = path.join(this.appDir, 'restart_after_update.bat');
        const scriptContent = `@echo off
timeout /t 2 /nobreak >nul
echo [Auto-Updater] Releasing port 5000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5000') do taskkill /PID %%a /F 2>nul
timeout /t 1 /nobreak >nul
echo [Auto-Updater] Starting updated WA Sender...
cd /d "%~dp0"
start "WA Sender Server" node server.js
exit
`;
        fs.writeFileSync(restartScriptPath, scriptContent, 'utf8');

        // Spawn detached process so it lives on after this node server exits
        const child = spawn('cmd.exe', ['/c', restartScriptPath], {
            cwd: this.appDir,
            detached: true,
            stdio: 'ignore'
        });
        child.unref();

        // Gracefully shut down node process after 1.5s to let the HTTP response complete
        setTimeout(() => {
            console.log('[Updater] Exiting current process for reload...');
            process.exit(0);
        }, 1500);
    }
}

module.exports = AppUpdater;
