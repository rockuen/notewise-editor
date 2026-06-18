const vscode = require('vscode');
const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const https = require('https');

// ── 날짜 유틸 ──

function extractDateFromFilename(filename) {
    const mISO = filename.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (mISO) {
        const mm = parseInt(mISO[2], 10);
        const dd = parseInt(mISO[3], 10);
        if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) return mISO[0];
    }
    const m8 = filename.match(/(?:^|[^0-9])(\d{4})(\d{2})(\d{2})(?=[^0-9]|$)/);
    if (m8) {
        const yyyy = parseInt(m8[1], 10);
        const mm = parseInt(m8[2], 10);
        const dd = parseInt(m8[3], 10);
        if (yyyy >= 1970 && yyyy <= 2099 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
            return `${m8[1]}-${m8[2]}-${m8[3]}`;
        }
    }
    const m6 = filename.match(/^(\d{6})(?=[^0-9])/);
    if (m6) {
        const yy = parseInt(m6[1].substring(0, 2), 10);
        const mm = parseInt(m6[1].substring(2, 4), 10);
        const dd = parseInt(m6[1].substring(4, 6), 10);
        if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
            const year = yy >= 70 ? 1900 + yy : 2000 + yy;
            return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
        }
    }
    return null;
}

function getFileGroup(ext) {
    ext = ext.toLowerCase().replace('.', '');
    if (['md', 'canvas', 'txt'].includes(ext)) return 'notes';
    if (['xlsx', 'xls', 'csv', 'json', 'tsv'].includes(ext)) return 'data';
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(ext)) return 'images';
    return 'others';
}

// ── 파일 인덱싱 ──

async function indexFiles() {
    const dateMap = {};
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return dateMap;

    const rootPath = workspaceFolders[0].uri.fsPath;
    const files = await vscode.workspace.findFiles(
        '**/*',
        '{**/node_modules/**,**/.git/**,**/.obsidian/**,**/dist/**,**/build/**,**/.smtcmp*}'
    );

    for (const fileUri of files) {
        const filename = path.basename(fileUri.fsPath);
        const ext = path.extname(filename);
        const date = extractDateFromFilename(filename);
        if (!date) continue;

        const group = getFileGroup(ext);
        const relativePath = path.relative(rootPath, fileUri.fsPath).replace(/\\/g, '/');

        if (!dateMap[date]) dateMap[date] = [];
        dateMap[date].push({ name: filename, path: fileUri.fsPath, relativePath, group });
    }

    const groupOrder = { notes: 0, data: 1, images: 2, others: 3 };
    for (const date of Object.keys(dateMap)) {
        dateMap[date].sort((a, b) => groupOrder[a.group] - groupOrder[b.group] || a.name.localeCompare(b.name));
    }
    return dateMap;
}

// ── Google Calendar 연동 ──

const KEEP_CALENDARS = [
    'porock8409@gmail.com',
    '0cb7aa8b4b38ec8c928a43c64e47e3f340da3b1d894604f81cff7cdc6b9faeb4@group.calendar.google.com',
    '162851ed8239957135c8f6434739992275e805d2b0cf4e25486f40ce8fea9e36@group.calendar.google.com',
    'fa80c623d67a6d1b2b4f12a709bb8a6b94e5ba1ba198fbe89ea1d6bc27f8c958@group.calendar.google.com',
];
// gogcli 바이너리 경로 해석: 설정(noteWise.calendar.gogPath) > 표준 후보 > 기본 설치 경로
let _resolvedGogPath = null;
function resolveGogPath() {
    if (_resolvedGogPath) return _resolvedGogPath;
    // 1) 사용자 설정 우선
    try {
        const configured = vscode.workspace.getConfiguration('noteWise.calendar').get('gogPath');
        if (configured && configured.trim()) {
            _resolvedGogPath = configured.trim();
            return _resolvedGogPath;
        }
    } catch {}
    const home = (process.env.HOME || process.env.USERPROFILE || os.homedir() || '').replace(/\\/g, '/');
    // 2) 플랫폼별 표준 후보 탐색 (사용자 PATH에 없는 ~/.gogcli/bin 포함)
    const candidates = process.platform === 'win32'
        ? [((process.env.LOCALAPPDATA || (home + '/AppData/Local')).replace(/\\/g, '/')) + '/gogcli/gog.exe']
        : ['/opt/homebrew/bin/gog', '/usr/local/bin/gog', home + '/.gogcli/bin/gog'];
    for (const p of candidates) {
        try { if (p && fs.existsSync(p)) { _resolvedGogPath = p; return _resolvedGogPath; } } catch {}
    }
    // 3) 기본 설치 경로 (자동 설치 시 배치되는 위치)
    _resolvedGogPath = gogInstallDest();
    return _resolvedGogPath;
}
function resetGogPathCache() { _resolvedGogPath = null; }

const GOG_ENV = { ...process.env, ZONEINFO: process.platform === 'win32' ? 'C:/Program Files/Git/mingw64/share/zoneinfo' : undefined };

// gogcli 상태 감지: { status: 'ready'|'notInstalled'|'noAccount', account?: string }
let _gogStatusCache = null;
function checkGogStatus() {
    if (_gogStatusCache) return Promise.resolve(_gogStatusCache);
    return new Promise((resolve) => {
        // 1) 바이너리 존재 확인
        const gogPath = resolveGogPath();
        try {
            if (!fs.existsSync(gogPath)) {
                _gogStatusCache = { status: 'notInstalled' };
                resolve(_gogStatusCache);
                return;
            }
        } catch {
            _gogStatusCache = { status: 'notInstalled' };
            resolve(_gogStatusCache);
            return;
        }
        // 2) gog auth list로 계정 확인
        execFile(gogPath, ['auth', 'list'], { timeout: 5000, env: GOG_ENV }, (err, stdout) => {
            if (err || !stdout || !stdout.trim()) {
                _gogStatusCache = { status: 'noAccount' };
                resolve(_gogStatusCache);
                return;
            }
            // 첫 번째 계정을 기본 사용 (탭 구분: email\tdefault\tscopes...)
            const lines = stdout.trim().split('\n').filter(l => l.trim());
            if (lines.length === 0) {
                _gogStatusCache = { status: 'noAccount' };
                resolve(_gogStatusCache);
                return;
            }
            const firstAccount = lines[0].split('\t')[0].trim();
            _gogStatusCache = { status: 'ready', account: firstAccount };
            resolve(_gogStatusCache);
        });
    });
}

// gogLogin 후 캐시 초기화
function resetGogStatusCache() {
    _gogStatusCache = null;
}

// ---- gogcli 자동 설치 / 경로 지정 (v1.4.4) ----

// 자동 설치 시 바이너리를 배치하는 표준 경로
function gogInstallDest() {
    const home = (process.env.HOME || process.env.USERPROFILE || os.homedir() || '').replace(/\\/g, '/');
    if (process.platform === 'win32') {
        const localAppData = (process.env.LOCALAPPDATA || (home + '/AppData/Local')).replace(/\\/g, '/');
        return path.join(localAppData, 'gogcli', 'gog.exe');
    }
    return path.join(home, '.gogcli', 'bin', 'gog');
}

// GitHub API JSON GET (302 redirect follow + User-Agent 필수, redirect 상한·timeout)
function ghGetJson(url, depth = 0) {
    return new Promise((resolve, reject) => {
        if (depth > 5) { reject(new Error('리다이렉트가 너무 많습니다.')); return; }
        const req = https.get(url, { headers: { 'User-Agent': 'oz-calendar-vscode', 'Accept': 'application/vnd.github+json' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                ghGetJson(res.headers.location, depth + 1).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error('GitHub API ' + res.statusCode));
                return;
            }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { data += c; });
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => req.destroy(new Error('네트워크 시간 초과')));
    });
}

// 현재 플랫폼/아키텍처에 맞는 릴리스 자산 선택
function pickGogAsset(assets) {
    const plat = process.platform;
    const arch = process.arch;
    const platKeys = plat === 'win32' ? ['windows', 'win'] : plat === 'darwin' ? ['darwin', 'macos', 'mac', 'apple'] : ['linux'];
    const archKeys = arch === 'arm64' ? ['arm64', 'aarch64'] : ['x86_64', 'amd64', 'x64'];
    const archives = (assets || []).filter(a => /\.(zip|tar\.gz|tgz)$/i.test(a.name || ''));
    const lc = (a) => (a.name || '').toLowerCase();
    let best = archives.find(a => platKeys.some(k => lc(a).includes(k)) && archKeys.some(k => lc(a).includes(k)));
    if (!best) best = archives.find(a => platKeys.some(k => lc(a).includes(k)));
    if (!best && archives.length === 1) best = archives[0];
    return best || null;
}

// 파일 다운로드 (302 redirect follow, redirect 상한·timeout)
function downloadFile(url, dest, depth = 0) {
    return new Promise((resolve, reject) => {
        if (depth > 5) { reject(new Error('리다이렉트가 너무 많습니다.')); return; }
        const file = fs.createWriteStream(dest);
        const req = https.get(url, { headers: { 'User-Agent': 'oz-calendar-vscode' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                file.close(() => { fs.unlink(dest, () => downloadFile(res.headers.location, dest, depth + 1).then(resolve, reject)); });
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                file.close(() => fs.unlink(dest, () => reject(new Error('다운로드 실패 ' + res.statusCode))));
                return;
            }
            res.pipe(file);
            file.on('finish', () => file.close(() => resolve()));
        });
        req.on('error', (e) => { try { file.close(); } catch {} fs.unlink(dest, () => reject(e)); });
        req.setTimeout(60000, () => req.destroy(new Error('다운로드 시간 초과')));
    });
}

// 압축 해제: .zip은 Windows=Expand-Archive / Unix=unzip, .tar.gz는 tar
function extractArchive(archivePath, destDir) {
    return new Promise((resolve, reject) => {
        let cmd, args;
        if (/\.zip$/i.test(archivePath)) {
            if (process.platform === 'win32') {
                cmd = 'powershell';
                args = ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`];
            } else {
                cmd = 'unzip';
                args = ['-o', archivePath, '-d', destDir];
            }
        } else if (/\.(tar\.gz|tgz)$/i.test(archivePath)) {
            cmd = 'tar';
            args = ['-xzf', archivePath, '-C', destDir];
        } else {
            reject(new Error('지원하지 않는 압축 형식: ' + path.basename(archivePath)));
            return;
        }
        execFile(cmd, args, { timeout: 60000 }, (err) => err ? reject(err) : resolve());
    });
}

// 압축 해제 트리에서 gog 바이너리 탐색 (gog/gogcli/gog.exe/gogcli.exe)
function findGogBinary(dir) {
    const names = process.platform === 'win32' ? ['gog.exe', 'gogcli.exe'] : ['gog', 'gogcli'];
    const stack = [dir];
    while (stack.length) {
        const cur = stack.pop();
        let entries;
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const ent of entries) {
            const full = path.join(cur, ent.name);
            if (ent.isDirectory()) stack.push(full);
            else if (names.includes(ent.name)) return full;
        }
    }
    return null;
}

// 자동 설치: 최신 릴리스 → 다운로드 → 해제 → 표준 경로 배치 → gog auth login
async function installGogcli() {
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'gogcli 설치', cancellable: false },
        async (progress) => {
            try {
                progress.report({ message: '최신 릴리스 조회 중...' });
                const release = await ghGetJson('https://api.github.com/repos/openclaw/gogcli/releases/latest');
                const asset = pickGogAsset(release.assets);
                if (!asset) throw new Error('현재 플랫폼에 맞는 릴리스 자산을 찾지 못했습니다.');
                if (!/^[\w.\-]+$/.test(asset.name)) throw new Error('릴리스 자산명이 안전하지 않습니다: ' + asset.name);
                progress.report({ message: `다운로드: ${asset.name}` });
                const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gogcli-'));
                const archivePath = path.join(tmpDir, asset.name);
                await downloadFile(asset.browser_download_url, archivePath);
                progress.report({ message: '압축 해제 중...' });
                const extractDir = path.join(tmpDir, 'extracted');
                fs.mkdirSync(extractDir, { recursive: true });
                await extractArchive(archivePath, extractDir);
                const binSrc = findGogBinary(extractDir);
                if (!binSrc) throw new Error('압축 해제된 파일에서 gog 바이너리를 찾지 못했습니다.');
                const destPath = gogInstallDest();
                fs.mkdirSync(path.dirname(destPath), { recursive: true });
                fs.copyFileSync(binSrc, destPath);
                if (process.platform !== 'win32') {
                    try { fs.chmodSync(destPath, 0o755); }
                    catch (e) { vscode.window.showWarningMessage(`실행 권한 설정 실패 — 수동으로 chmod +x 가 필요할 수 있습니다: ${destPath}`); }
                }
                // 설정에 절대경로 명시 저장 (PATH에 없을 수 있으므로)
                try { await vscode.workspace.getConfiguration('noteWise.calendar').update('gogPath', destPath, vscode.ConfigurationTarget.Global); } catch {}
                resetGogPathCache();
                resetGogStatusCache();
                try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
                vscode.window.showInformationMessage(`gogcli 설치 완료: ${destPath} — 터미널에서 Google 로그인을 진행하세요.`);
                const terminal = vscode.window.createTerminal('Google Login');
                terminal.show();
                terminal.sendText(`"${destPath}" auth login`);
                vscode.commands.executeCommand('noteWise.calendar.refresh');
            } catch (e) {
                vscode.window.showErrorMessage(`gogcli 설치 실패: ${e.message}. '경로 지정' 또는 수동 설치를 시도하세요.`);
            }
        }
    );
}

// 경로 직접 지정: 파일 다이얼로그 → Global 설정 저장 → 캐시 reset → refresh
async function setGogPathInteractive() {
    const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        title: 'gogcli 실행 파일 선택',
        openLabel: '선택',
    });
    if (!picked || !picked.length) return;
    const p = picked[0].fsPath;
    try {
        await vscode.workspace.getConfiguration('noteWise.calendar').update('gogPath', p, vscode.ConfigurationTarget.Global);
    } catch (e) {
        vscode.window.showErrorMessage(`설정 저장 실패: ${e.message}`);
        return;
    }
    resetGogPathCache();
    resetGogStatusCache();
    vscode.window.showInformationMessage(`gogcli 경로 설정 완료: ${p}`);
    vscode.commands.executeCommand('noteWise.calendar.refresh');
}

function fetchGoogleEvents(fromDate, toDate, account) {
    return new Promise((resolve) => {
        if (!account) { resolve({}); return; }
        const args = ['cal', 'list', '--from', fromDate, '--to', toDate, '--all', '--all-pages', '--max', '200', '--json', '--account', account];
        execFile(resolveGogPath(), args, {
            timeout: 15000,
            env: GOG_ENV,
        }, (err, stdout, stderr) => {
            if (err) {
                const msg = (stderr || '') + (err.message || '');
                if (msg.includes('invalid_grant') || msg.includes('expired') || msg.includes('revoked') || msg.includes('missing --account')) {
                    resolve({ __authError: true });
                } else {
                    resolve({});
                }
                return;
            }
            try {
                const data = JSON.parse(stdout);
                const eventMap = {};
                for (const e of data.events || []) {
                    const org = (e.organizer?.email) || '';
                    if (!KEEP_CALENDARS.includes(org)) continue;
                    const start = e.start?.dateTime || e.start?.date || '';
                    const dateKey = start.substring(0, 10);
                    if (!dateKey) continue;
                    let timeStr = '';
                    if (start.includes('T')) timeStr = start.substring(11, 16);
                    if (!eventMap[dateKey]) eventMap[dateKey] = [];
                    eventMap[dateKey].push({
                        summary: e.summary || '(제목 없음)',
                        time: timeStr,
                        allDay: !start.includes('T'),
                    });
                }
                for (const d of Object.keys(eventMap)) {
                    eventMap[d].sort((a, b) => {
                        if (a.allDay && !b.allDay) return -1;
                        if (!a.allDay && b.allDay) return 1;
                        return a.time.localeCompare(b.time);
                    });
                }
                resolve(eventMap);
            } catch { resolve({}); }
        });
    });
}

// ── 데일리노트 헬퍼 ──

function getTodayInfo() {
    const today = new Date();
    const yy = String(today.getFullYear()).substring(2);
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const yymmdd = yy + mm + dd;
    const now = `${String(today.getHours()).padStart(2, '0')}:${String(today.getMinutes()).padStart(2, '0')}`;
    return { yymmdd, now };
}

function getDailyNotePath(rootPath, yymmdd) {
    return path.join(rootPath, '40-personal', '41-daily', `${yymmdd}.md`);
}

async function ensureDailyNote(uri, yymmdd) {
    try {
        await vscode.workspace.fs.stat(uri);
        return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
    } catch {
        const content = `# ${yymmdd}\n\n## 오늘 할 일\n\n## 메모\n\n## 확인할 사항\n`;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
        return content;
    }
}

async function appendToSection(uri, yymmdd, sectionHeader, line) {
    let content = await ensureDailyNote(uri, yymmdd);
    const idx = content.indexOf(sectionHeader);
    if (idx !== -1) {
        const insertPos = idx + sectionHeader.length;
        const afterHeader = content.substring(insertPos);
        const nextLineEnd = afterHeader.indexOf('\n');
        const insertAt = insertPos + nextLineEnd + 1;
        content = content.substring(0, insertAt) + line + content.substring(insertAt);
    } else {
        content = content.trimEnd() + '\n\n' + sectionHeader + '\n' + line;
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
}

async function readMarkdownProperties(filePath) {
    if (path.extname(filePath).toLowerCase() !== '.md') return { path: filePath, entries: [] };
    try {
        const uri = vscode.Uri.file(filePath);
        const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
        return { path: filePath, entries: parseMarkdownProperties(content) };
    } catch {
        return { path: filePath, entries: [] };
    }
}

function parseMarkdownProperties(content) {
    const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    if (lines.length < 3 || lines[0].trim() !== '---') return [];

    const body = [];
    for (let i = 1; i < Math.min(lines.length, 200); i++) {
        if (lines[i].trim() === '---') return parseYamlPropertyLines(body);
        body.push(lines[i]);
    }
    return [];
}

function parseYamlPropertyLines(lines) {
    const entries = [];
    let current = null;

    for (const line of lines) {
        const keyMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
        if (keyMatch) {
            current = { key: keyMatch[1], values: [] };
            const inline = parseYamlInlineValue(keyMatch[2]);
            if (inline.length) current.values.push(...inline);
            entries.push(current);
            continue;
        }

        const listMatch = /^\s*-\s+(.+)$/.exec(line);
        if (listMatch && current) {
            current.values.push(...parseYamlInlineValue(listMatch[1]));
        }
    }

    return entries.filter((entry) => entry.key && entry.values.length);
}

function parseYamlInlineValue(value) {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        return trimmed
            .slice(1, -1)
            .split(',')
            .map((part) => cleanYamlValue(part))
            .filter(Boolean);
    }
    return [cleanYamlValue(trimmed)].filter(Boolean);
}

function cleanYamlValue(value) {
    const trimmed = String(value).trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function getActiveMarkdownPath() {
    const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    if (activeTab) return markdownPathFromTabInput(activeTab.input);

    return markdownPathFromUri(vscode.window.activeTextEditor?.document?.uri);
}

function markdownPathFromTabInput(input) {
    if (!input || typeof input !== 'object') return '';
    const direct = markdownPathFromUri(input.uri);
    if (direct) return direct;
    const modified = markdownPathFromUri(input.modified);
    if (modified) return modified;
    const original = markdownPathFromUri(input.original);
    if (original) return original;
    return '';
}

function markdownPathFromUri(uri) {
    if (!uri || uri.scheme !== 'file') return '';
    const filePath = uri.fsPath;
    return isMarkdownFilePath(filePath) ? filePath : '';
}

function isMarkdownFilePath(filePath) {
    return ['.md', '.markdown'].includes(path.extname(filePath).toLowerCase());
}

// ── CalendarViewProvider ──

class CalendarViewProvider {
    constructor(context) {
        this._context = context;
        this._extensionUri = context.extensionUri;
        this._view = null;
        this._dateMap = {};
        this._eventMap = {};
        this._lastActiveMarkdownPath = '';
        this._lastPostedMarkdownPath = '';
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            enableCommandUris: true,
        };

        this._refreshAll().then(() => {
            webviewView.webview.html = this._getHtml();
            this._syncActiveMarkdownFile();
        });

        const watcher = vscode.workspace.createFileSystemWatcher('**/*');
        const refreshFiles = (uri) => {
            this._updateIndex().then(() => {
                this._postMessage('updateIndex', this._dateMap);
                if (uri?.fsPath && uri.fsPath === this._lastActiveMarkdownPath) {
                    this._setActiveMarkdownFile(uri.fsPath, true);
                }
            });
        };
        watcher.onDidCreate(refreshFiles);
        watcher.onDidDelete(refreshFiles);
        watcher.onDidChange(refreshFiles);

        const syncActiveFile = () => this._scheduleActiveMarkdownSync();
        this._context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(syncActiveFile));
        this._context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(syncActiveFile));
        this._context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(syncActiveFile));
        this._context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabGroups(syncActiveFile));
        syncActiveFile();

        webviewView.webview.onDidReceiveMessage((msg) => {
            if (msg.type === 'openFile') {
                this._postMessage('openStatus', { state: 'received', path: msg.path });
                Promise.resolve(this._openFileWithSettings(msg.path)).catch((error) => {
                    this._postMessage('openStatus', {
                        state: 'failed',
                        path: msg.path,
                        message: error?.message || String(error),
                    });
                });
            } else if (msg.type === 'slashCommand') {
                this._handleSlashCommand(msg.command, msg.text);
            } else if (msg.type === 'findFiles') {
                this._handleFind(msg.query);
            } else if (msg.type === 'grepFiles') {
                this._handleGrep(msg.query);
            } else if (msg.type === 'openFileAtLine') {
                this._openFileWithSettings(msg.path, msg.line);
            } else if (msg.type === 'getProperties') {
                readMarkdownProperties(msg.path).then((result) => {
                    this._postMessage('properties', result);
                });
            } else if (msg.type === 'openSettings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'noteWise.calendar');
            } else if (msg.type === 'recentFiles') {
                this._handleRecent();
            } else if (msg.type === 'copyPath') {
                const absPath = msg.path.replace(/\\/g, '/');
                vscode.env.clipboard.writeText(absPath);
                this._postMessage('commandSaved', { time: '', label: 'copy', text: absPath });
            } else if (msg.type === 'fetchEvents') {
                checkGogStatus().then((gog) => {
                    if (gog.status !== 'ready') {
                        this._postMessage('gogStatus', gog.status);
                        return;
                    }
                    this._postMessage('gogStatus', 'ready');
                    fetchGoogleEvents(msg.from, msg.to, gog.account).then((result) => {
                        if (result.__authError) {
                            this._postMessage('authError', true);
                        } else {
                            this._eventMap = { ...this._eventMap, ...result };
                            this._postMessage('updateEvents', this._eventMap);
                            this._postMessage('authError', false);
                        }
                    });
                });
            } else if (msg.type === 'revealInFinder') {
                const dirPath = path.dirname(msg.path);
                this._openWithOS(dirPath);
            } else if (msg.type === 'deleteFile') {
                const fileName = path.basename(msg.path);
                vscode.window.showWarningMessage(
                    `Delete "${fileName}"?`,
                    { modal: true, detail: msg.path },
                    'Delete'
                ).then((choice) => {
                    if (choice === 'Delete') {
                        const fileUri = vscode.Uri.file(msg.path);
                        vscode.workspace.fs.delete(fileUri, { useTrash: true }).then(() => {
                            this._postMessage('commandSaved', { time: '', label: 'delete', text: fileName });
                        }, (err) => {
                            vscode.window.showErrorMessage(`Failed to delete: ${err.message}`);
                        });
                    }
                });
            } else if (msg.type === 'gogLogin') {
                resetGogStatusCache();
                const terminal = vscode.window.createTerminal('Google Login');
                terminal.show();
                terminal.sendText(`"${resolveGogPath()}" auth login`);
            } else if (msg.type === 'installGogcli') {
                installGogcli();
            } else if (msg.type === 'setGogPath') {
                setGogPathInteractive();
            }
        });
    }

    _openWithOS(targetPath) {
        const { exec } = require('child_process');
        if (process.platform === 'win32') {
            const escaped = targetPath.replace(/'/g, "''");
            exec(`powershell -NoProfile -Command "Start-Process '${escaped}'"`);
        } else if (process.platform === 'darwin') {
            exec(`open '${targetPath.replace(/'/g, "'\\''")}'`);
        } else {
            exec(`xdg-open '${targetPath.replace(/'/g, "'\\''")}'`);
        }
    }

    async _openFileWithSettings(filePath, line) {
        const config = vscode.workspace.getConfiguration('noteWise.calendar');
        const ext = path.extname(filePath).toLowerCase();
        const extNoDot = ext.replace('.', '');
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

        // Markdown always opens in NoteWise inside the integrated app.
        if (isMarkdownFilePath(filePath)) {
            const uri = vscode.Uri.file(filePath);
            await this._openWithNoteWiseEditor(uri, filePath);
            return;
        }

        // External extensions → OS default app
        const externalExts = (config.get('externalExtensions') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        if (externalExts.includes(extNoDot)) {
            this._openWithOS(filePath);
            return;
        }

        // Canvas keeps the existing setting because NoteWise does not provide a canvas editor.
        if (ext === '.canvas') {
            const openIn = config.get('openMarkdownIn') || 'obsidian';
            if (openIn === 'obsidian') {
                const vaultName = config.get('obsidianVault') || path.basename(rootPath);
                const relativePath = path.relative(rootPath, filePath).replace(/\\/g, '/');
                const obsidianUri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(relativePath)}`;
                this._openWithOS(obsidianUri);
            } else {
                const uri = vscode.Uri.file(filePath);
                const range = line ? new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0) : undefined;
                this._openWithDefaultEditor(uri, range, filePath);
            }
            return;
        }

        // Other files → VSCode 기본 에디터 연결을 따른다 (라인 점프는 텍스트 에디터일 때만 적용).
        const uri = vscode.Uri.file(filePath);
        const range = line ? new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0) : undefined;
        this._openWithDefaultEditor(uri, range, filePath);
    }

    // VSCode의 기본 에디터 연결을 존중해 파일을 연다.
    // vscode.open 명령은 workbench.editorAssociations / 등록된 커스텀 에디터를 따르므로,
    // 사용자가 지정한 에디터(또는 추후 개발할 확장)로 열린다. 실패 시 OS 기본 앱으로 폴백.
    _openWithDefaultEditor(uri, range, filePath) {
        return Promise.resolve(
            vscode.commands.executeCommand('vscode.open', uri, { preview: false, selection: range })
        ).then(undefined, () => this._openWithOS(filePath));
    }

    async _openWithNoteWiseEditor(uri, filePath) {
        try {
            await vscode.commands.executeCommand('vscode.openWith', uri, 'notewise.editor', {
                viewColumn: vscode.ViewColumn.Active,
                preview: false,
            });
            this._postMessage('openStatus', { state: 'opened', path: filePath });
            this._scheduleActiveMarkdownSync();
        } catch (error) {
            const message = error?.message || String(error);
            vscode.window.showErrorMessage(`NoteWise editor open failed: ${message}`);
            this._postMessage('openStatus', { state: 'failed', path: filePath, message });
            await this._openWithDefaultEditor(uri, undefined, filePath);
        }
    }

    _setActiveMarkdownFile(filePath, force = false) {
        if (!filePath || !isMarkdownFilePath(filePath)) {
            this._clearActiveMarkdownFile();
            return;
        }
        if (!force && filePath === this._lastActiveMarkdownPath && filePath === this._lastPostedMarkdownPath) return;
        this._lastActiveMarkdownPath = filePath;
        readMarkdownProperties(filePath).then((result) => {
            if (!this._view || this._lastActiveMarkdownPath !== filePath) return;
            this._lastPostedMarkdownPath = filePath;
            this._postMessage('activeFile', result);
        });
    }

    _clearActiveMarkdownFile() {
        if (!this._lastActiveMarkdownPath && !this._lastPostedMarkdownPath) return;
        this._lastActiveMarkdownPath = '';
        this._lastPostedMarkdownPath = '';
        this._postMessage('activeFile', null);
    }

    _scheduleActiveMarkdownSync() {
        this._syncActiveMarkdownFile();
        setTimeout(() => this._syncActiveMarkdownFile(), 80);
        setTimeout(() => this._syncActiveMarkdownFile(), 250);
    }

    _syncActiveMarkdownFile() {
        const filePath = getActiveMarkdownPath();
        if (!filePath) {
            this._clearActiveMarkdownFile();
            return;
        }
        this._setActiveMarkdownFile(filePath);
    }

    async _handleSlashCommand(command, text) {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const { yymmdd, now } = getTodayInfo();
        const filePath = getDailyNotePath(rootPath, yymmdd);
        const uri = vscode.Uri.file(filePath);
        let label = '';

        switch (command) {
            case 'memo': {
                await appendToSection(uri, yymmdd, '## 메모', `- ${now} ${text}\n`);
                label = 'memo';
                break;
            }
            case 'todo': {
                await appendToSection(uri, yymmdd, '## 오늘 할 일', `- [ ] ${text}\n`);
                label = 'todo';
                break;
            }
            case 'ask': {
                await appendToSection(uri, yymmdd, '## 확인할 사항', `- [ ] ${text}\n`);
                label = 'ask';
                break;
            }
            case 'idea': {
                const ideaDir = path.join(rootPath, '00-inbox');
                const ideaFile = path.join(ideaDir, `${yymmdd} idea.md`);
                const ideaUri = vscode.Uri.file(ideaFile);
                const line = `- ${now} ${text}\n`;
                try {
                    const existing = Buffer.from(await vscode.workspace.fs.readFile(ideaUri)).toString('utf-8');
                    await vscode.workspace.fs.writeFile(ideaUri, Buffer.from(existing.trimEnd() + '\n' + line, 'utf-8'));
                } catch {
                    await vscode.workspace.fs.writeFile(ideaUri, Buffer.from(`# Ideas - ${yymmdd}\n\n${line}`, 'utf-8'));
                }
                label = 'idea';
                break;
            }
            default:
                return;
        }

        this._postMessage('commandSaved', { time: now, label, text });
    }

    async _handleFind(query) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { this._postMessage('findResults', { query, items: [] }); return; }
        const rootPath = workspaceFolders[0].uri.fsPath;
        const files = await vscode.workspace.findFiles(
            '**/*',
            '{**/node_modules/**,**/.git/**,**/.obsidian/**,**/dist/**,**/build/**,**/.smtcmp*}',
            500
        );
        const keywords = query.toLowerCase().split(/\s+/);
        const results = [];
        for (const fileUri of files) {
            const filename = path.basename(fileUri.fsPath).toLowerCase();
            const relativePath = path.relative(rootPath, fileUri.fsPath).replace(/\\/g, '/').toLowerCase();
            if (keywords.every(kw => filename.includes(kw) || relativePath.includes(kw))) {
                const ext = path.extname(fileUri.fsPath);
                results.push({
                    name: path.basename(fileUri.fsPath),
                    path: fileUri.fsPath,
                    relativePath: path.relative(rootPath, fileUri.fsPath).replace(/\\/g, '/'),
                    group: getFileGroup(ext),
                });
            }
        }
        results.sort((a, b) => {
            const groupOrder = { notes: 0, data: 1, images: 2, others: 3 };
            return groupOrder[a.group] - groupOrder[b.group] || a.name.localeCompare(b.name);
        });
        this._postMessage('findResults', { query, items: results.slice(0, 50) });
    }

    async _handleRecent() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { this._postMessage('recentResults', { items: [] }); return; }
        const rootPath = workspaceFolders[0].uri.fsPath;
        const files = await vscode.workspace.findFiles(
            '**/*',
            '{**/node_modules/**,**/.git/**,**/.obsidian/**,**/dist/**,**/build/**,**/.smtcmp*}',
            5000
        );
        const items = [];
        for (const fileUri of files) {
            try {
                const stat = await vscode.workspace.fs.stat(fileUri);
                const ext = path.extname(fileUri.fsPath);
                items.push({
                    name: path.basename(fileUri.fsPath),
                    path: fileUri.fsPath,
                    relativePath: path.relative(rootPath, fileUri.fsPath).replace(/\\/g, '/'),
                    group: getFileGroup(ext),
                    mtime: stat.mtime,
                });
            } catch { /* skip */ }
        }
        items.sort((a, b) => b.mtime - a.mtime);
        this._postMessage('recentResults', { items: items.slice(0, 20) });
    }

    async _handleGrep(query) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { this._postMessage('grepResults', { query, items: [] }); return; }
        const rootPath = workspaceFolders[0].uri.fsPath;
        const textExts = ['.md', '.txt', '.csv', '.json', '.tsv', '.js', '.ts', '.py', '.html', '.css', '.yaml', '.yml', '.xml', '.sql', '.sh', '.bat', '.canvas', '.log'];
        const files = await vscode.workspace.findFiles(
            '**/*',
            '{**/node_modules/**,**/.git/**,**/.obsidian/**,**/dist/**,**/build/**,**/.smtcmp*}',
            2000
        );
        const queryLower = query.toLowerCase();
        const results = [];
        for (const fileUri of files) {
            const ext = path.extname(fileUri.fsPath).toLowerCase();
            if (!textExts.includes(ext)) continue;
            try {
                const bytes = await vscode.workspace.fs.readFile(fileUri);
                const content = Buffer.from(bytes).toString('utf-8');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].toLowerCase().includes(queryLower)) {
                        results.push({
                            name: path.basename(fileUri.fsPath),
                            path: fileUri.fsPath,
                            relativePath: path.relative(rootPath, fileUri.fsPath).replace(/\\/g, '/'),
                            line: i + 1,
                            preview: lines[i].trim().substring(0, 120),
                        });
                        if (results.length >= 50) break;
                    }
                }
            } catch { /* skip unreadable */ }
            if (results.length >= 50) break;
        }
        this._postMessage('grepResults', { query, items: results });
    }

    _postMessage(type, data) {
        if (this._view) {
            this._view.webview.postMessage({ type, data });
        }
    }

    async _refreshAll() {
        this._dateMap = await indexFiles();
        const gog = await checkGogStatus();
        this._gogStatus = gog.status;
        if (gog.status !== 'ready') {
            this._eventMap = {};
            this._postMessage('gogStatus', gog.status);
            return;
        }
        this._postMessage('gogStatus', 'ready');
        const today = new Date();
        const y = today.getFullYear();
        const m = today.getMonth();
        const from = `${y}-${String(m + 1).padStart(2, '0')}-01`;
        const lastDay = new Date(y, m + 1, 0).getDate();
        const to = `${y}-${String(m + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        const result = await fetchGoogleEvents(from, to, gog.account);
        if (result.__authError) {
            this._eventMap = {};
            this._postMessage('authError', true);
        } else {
            this._eventMap = result;
            this._postMessage('authError', false);
        }
    }

    async _updateIndex() {
        this._dateMap = await indexFiles();
    }

    _getHtml() {
        const dataJson = JSON.stringify(this._dateMap);
        const eventsJson = JSON.stringify(this._eventMap);
        const gogStatusJson = JSON.stringify(this._gogStatus || 'ready');
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root {
    --bg: var(--vscode-sideBar-background, #1e1e2e);
    --fg: var(--vscode-sideBar-foreground, #cdd6f4);
    --accent: var(--vscode-focusBorder, #89b4fa);
    --hover: var(--vscode-list-hoverBackground, #313244);
    --today-bg: var(--vscode-badge-background, #89b4fa);
    --today-fg: var(--vscode-badge-foreground, #1e1e2e);
    --muted: var(--vscode-descriptionForeground, #6c7086);
    --border: var(--vscode-panel-border, #45475a);
    --dot-notes: #89b4fa;
    --dot-data: #a6e3a1;
    --dot-images: #f9e2af;
    --dot-others: #9399b2;
    --dot-event: #f5c2e7;
    --sun: #f38ba8;
    --sat: #89b4fa;
}
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: 13px;
    color: var(--fg);
    background: var(--bg);
    user-select: none;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    height: 100vh;
}
#app { flex: 1; overflow-y: auto; }

.cal-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px 6px; }
.cal-header .title { font-size: 15px; font-weight: 600; cursor: pointer; }
.cal-header .nav-btn { background: none; border: none; color: var(--muted); font-size: 16px; cursor: pointer; padding: 2px 6px; border-radius: 4px; }
.cal-header .nav-btn:hover { color: var(--fg); background: var(--hover); }
/* --- Context Menu --- */
.ctx-menu {
    display: none;
    position: fixed;
    z-index: 9999;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    padding: 4px 0;
    min-width: 160px;
}
.ctx-menu.show { display: block; }
.ctx-menu-item {
    padding: 6px 12px;
    font-size: 12px;
    color: var(--fg);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
}
.ctx-menu-item:hover { background: var(--hover); }
.ctx-menu-sep { height: 1px; background: var(--border); margin: 4px 0; }
.ctx-menu-danger { color: #f38ba8; }
.ctx-menu-danger:hover { background: rgba(243,139,168,0.15); }

.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 0; padding: 0 8px; }
.cal-dow { text-align: center; font-size: 11px; font-weight: 600; color: var(--muted); padding: 4px 0; }
.cal-dow:first-child { color: var(--sun); }
.cal-dow:last-child { color: var(--sat); }

.cal-day { text-align: center; padding: 5px 0 2px; cursor: pointer; border-radius: 6px; position: relative; font-size: 12px; line-height: 1; }
.cal-day:hover { background: var(--hover); }
.cal-day.other-month { color: var(--muted); opacity: 0.4; }
.cal-day.today .day-num { background: var(--today-bg); color: var(--today-fg); border-radius: 50%; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; }
.cal-day.selected { background: var(--hover); }
.cal-day.sunday .day-num { color: var(--sun); }
.cal-day.saturday .day-num { color: var(--sat); }
.cal-day.today .day-num { color: var(--today-fg); }

.dots { display: flex; justify-content: center; gap: 1px; height: 6px; margin-top: 1px; }
.dot { width: 4px; height: 4px; border-radius: 50%; }
.dot.notes { background: var(--dot-notes); }
.dot.data { background: var(--dot-data); }
.dot.images { background: var(--dot-images); }
.dot.others { background: var(--dot-others); }
.dot.event { background: var(--dot-event); }

.divider { height: 1px; background: var(--border); margin: 8px 12px; }

.date-label { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 4px 12px 6px; font-size: 13px; color: var(--fg); }
.date-label .nav-sm { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 13px; padding: 0 4px; }
.date-label .nav-sm:hover { color: var(--fg); }
.auth-error { display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; font-size: 12px; color: var(--muted); border-radius: 4px; background: rgba(255,255,255,0.04); }
.auth-btn { background: none; border: 1px solid var(--muted); color: var(--fg); font-size: 11px; padding: 2px 10px; border-radius: 4px; cursor: pointer; text-decoration: none; display: inline-block; }
.auth-btn:hover { background: var(--hover); border-color: var(--fg); }
.gog-status-msg { padding: 8px; font-size: 12px; color: var(--muted); border-radius: 4px; background: rgba(255,255,255,0.04); display: flex; flex-direction: column; gap: 6px; }
.gog-status-msg span { font-size: 12px; }
.gog-hint { font-size: 11px; color: var(--muted); opacity: 0.8; }

.event-section { padding: 0 12px 4px; }
.event-section-header { display: flex; align-items: center; gap: 5px; padding: 4px 0; font-size: 12px; color: var(--muted); }
.event-section-header .badge { background: var(--hover); color: var(--muted); font-size: 10px; padding: 1px 5px; border-radius: 8px; margin-left: auto; }
.event-item { padding: 3px 8px; border-radius: 4px; font-size: 12px; color: var(--fg); display: flex; align-items: center; gap: 6px; }
.event-item .event-time { color: var(--dot-event); font-size: 11px; min-width: 38px; }
.event-item .event-allday { color: var(--dot-event); font-size: 10px; min-width: 38px; }

.file-section { padding: 0 12px 4px; }
.file-section-header { display: flex; align-items: center; gap: 5px; padding: 4px 0; font-size: 12px; color: var(--muted); cursor: pointer; }
.file-section-header .badge { background: var(--hover); color: var(--muted); font-size: 10px; padding: 1px 5px; border-radius: 8px; margin-left: auto; }
.file-item { display: block; padding: 3px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--fg); text-decoration: none; }
.file-item:hover { background: var(--hover); }
.file-item.active-file { background: var(--hover); color: var(--fg); }

.properties-section { margin: 8px 12px 10px; border-top: 1px solid var(--border); padding-top: 6px; }
.properties-table { display: grid; grid-template-columns: minmax(72px, 0.42fr) minmax(0, 1fr); border-top: 1px solid color-mix(in srgb, var(--border) 65%, transparent); }
.property-key, .property-value { min-width: 0; padding: 7px 6px; border-bottom: 1px solid color-mix(in srgb, var(--border) 65%, transparent); font-size: 12px; line-height: 1.35; }
.property-key { color: var(--muted); display: flex; align-items: center; gap: 6px; }
.property-key::before { content: '\\2630'; color: var(--muted); opacity: 0.8; font-size: 11px; }
.property-value { color: var(--fg); overflow-wrap: anywhere; }
.property-chip-list { display: flex; flex-wrap: wrap; gap: 4px; }
.property-chip { display: inline-flex; align-items: center; max-width: 100%; padding: 2px 7px; border-radius: 999px; background: var(--hover); color: var(--fg); }
.property-link { color: var(--vscode-textLink-foreground, var(--accent)); text-decoration: underline; text-underline-offset: 2px; }
.properties-empty { color: var(--muted); font-size: 12px; padding: 8px 2px; }

.empty-msg { padding: 16px 12px; color: var(--muted); font-size: 12px; text-align: center; }

/* --- Recent Results --- */
.recent-time { color: var(--muted); font-size: 10px; margin-left: auto; white-space: nowrap; }
.recent-item { display: flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; color: var(--fg); }
.recent-item:hover { background: var(--hover); }
.recent-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }

/* --- Grep Results --- */
.grep-item { padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; }
.grep-item:hover { background: var(--hover); }
.grep-file { color: var(--accent); font-size: 11px; }
.grep-line { color: var(--muted); font-size: 10px; margin-left: 4px; }
.grep-preview { color: var(--fg); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
.grep-highlight { color: var(--dot-images); font-weight: 600; }

/* --- Loading --- */
.loading-msg { padding: 24px 12px; color: var(--muted); font-size: 12px; text-align: center; }
.spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; vertical-align: middle; margin-right: 6px; }
@keyframes spin { to { transform: rotate(360deg); } }

/* --- Command Bar --- */
.cmd-bar {
    position: relative;
    background: var(--bg);
    border-top: 1px solid var(--border);
    padding: 8px 12px;
}
.cmd-input {
    width: 100%;
    background: var(--hover);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--fg);
    font-size: 12px;
    padding: 6px 8px;
    outline: none;
    font-family: inherit;
}
.cmd-input:focus { border-color: var(--accent); }
.cmd-input::placeholder { color: var(--muted); }
.cmd-toast {
    font-size: 11px;
    color: var(--dot-data);
    padding: 3px 0 0;
    opacity: 0;
    transition: opacity 0.3s;
}
.cmd-toast.show { opacity: 1; }

/* --- Autocomplete --- */
.cmd-suggestions {
    display: none;
    position: absolute;
    bottom: 100%;
    left: 12px;
    right: 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
    box-shadow: 0 -4px 12px rgba(0,0,0,0.3);
}
.cmd-suggestions.show { display: block; }
.cmd-suggestion {
    padding: 6px 10px;
    font-size: 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
}
.cmd-suggestion:hover, .cmd-suggestion.active {
    background: var(--hover);
}
.cmd-suggestion .cmd-name {
    color: var(--accent);
    font-weight: 600;
    min-width: 50px;
}
.cmd-suggestion .cmd-desc {
    color: var(--muted);
}
</style>
</head>
<body>

<div id="app"></div>
<div class="ctx-menu" id="ctxMenu">
    <div class="ctx-menu-item" data-action="open">\u{1F4C2} Open File</div>
    <div class="ctx-menu-item" data-action="reveal">\u{1F50D} Reveal in Finder</div>
    <div class="ctx-menu-sep"></div>
    <div class="ctx-menu-item" data-action="copy">\u{1F4CB} Copy Path</div>
    <div class="ctx-menu-sep"></div>
    <div class="ctx-menu-item ctx-menu-danger" data-action="delete">\u{1F5D1} Delete File</div>
</div>
<div class="cmd-bar">
    <div class="cmd-suggestions" id="cmdSuggestions"></div>
    <input class="cmd-input" id="cmdInput" type="text" placeholder="Type / for commands, or just memo..." />
    <div class="cmd-toast" id="cmdToast"></div>
</div>

<script>
const vscode = acquireVsCodeApi();
let dateIndex = ${dataJson};
let eventIndex = ${eventsJson};
let currentMonth = new Date();
let selectedDate = new Date();
let selectedDates = new Set();
let loadedMonths = new Set();
let activeSuggestion = -1;
let cmdHistory = [];
let cmdHistoryIdx = -1;
let cmdHistoryDraft = '';
let activeFilePath = '';
let activeProperties = null;
let pendingPropertiesPath = '';

const COMMANDS = [
    { name: '/memo',  desc: 'Add memo to daily note',      icon: '\\u{1F4DD}' },
    { name: '/todo',  desc: 'Add todo checkbox',            icon: '\\u2611' },
    { name: '/ask',   desc: 'Add question to verify',       icon: '\\u2753' },
    { name: '/idea',  desc: 'Save idea to inbox',           icon: '\\u{1F4A1}' },
    { name: '/find',  desc: 'Search files in workspace',    icon: '\\u{1F50D}' },
    { name: '/grep',  desc: 'Search inside file contents',  icon: '\\u{1F50E}' },
    { name: '/recent', desc: 'Recently modified files',     icon: '\\u{1F552}' },
];

const DOW = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const GROUP_LABELS = { notes: 'Notes', data: 'Data', images: 'Images', others: 'Others' };
const GROUP_ICONS = { notes: '\\u{1F4C4}', data: '\\u{1F4CA}', images: '\\u{1F5BC}', others: '\\u{1F4CE}' };
const GROUP_ORDER = ['notes','data','images','others'];

loadedMonths.add(currentMonth.getFullYear() + '-' + String(currentMonth.getMonth()+1).padStart(2,'0'));

let searchResults = null;
let gogAuthError = false;
let gogStatus = ${gogStatusJson};

window.addEventListener('message', (e) => {
    if (e.data.type === 'updateIndex') {
        dateIndex = e.data.data;
        if (!searchResults) render();
    } else if (e.data.type === 'updateEvents') {
        eventIndex = { ...eventIndex, ...e.data.data };
        if (!searchResults) render();
    } else if (e.data.type === 'commandSaved') {
        const d = e.data.data;
        if (d.label === 'copy') {
            showToast('\\u{1F4CB} Copied: ' + d.text);
        } else {
            showToast('\\u2713 /' + d.label + ' saved (' + d.time + ')');
        }
    } else if (e.data.type === 'findResults') {
        searchResults = { ...e.data.data, mode: 'find' };
        renderSearch();
    } else if (e.data.type === 'grepResults') {
        searchResults = { ...e.data.data, mode: 'grep' };
        renderGrep();
    } else if (e.data.type === 'recentResults') {
        searchResults = { ...e.data.data, mode: 'recent' };
        renderRecent();
    } else if (e.data.type === 'authError') {
        gogAuthError = e.data.data;
        if (!searchResults) render();
    } else if (e.data.type === 'gogStatus') {
        gogStatus = e.data.data;
        if (!searchResults) render();
    } else if (e.data.type === 'activeFile') {
        if (e.data.data && e.data.data.path) {
            activeFilePath = e.data.data.path;
            activeProperties = e.data.data;
            pendingPropertiesPath = '';
            if (!searchResults) render();
        } else {
            activeFilePath = '';
            activeProperties = null;
            pendingPropertiesPath = '';
            if (!searchResults) render();
        }
    } else if (e.data.type === 'properties') {
        if (e.data.data && e.data.data.path === activeFilePath) {
            activeProperties = e.data.data;
            pendingPropertiesPath = '';
            if (!searchResults) render();
        }
    } else if (e.data.type === 'openStatus') {
        const d = e.data.data || {};
        const name = d.path ? d.path.split(/[\\\\/]/).pop() : '';
        if (d.state === 'received') showToast('Host received: ' + name);
        else if (d.state === 'opened') showToast('Opened in NoteWise: ' + name);
        else if (d.state === 'failed') showToast('Open failed: ' + (d.message || name));
    }
});

function showToast(text) {
    const toast = document.getElementById('cmdToast');
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

// --- Command Bar Logic ---
const cmdInput = document.getElementById('cmdInput');
const cmdSuggestions = document.getElementById('cmdSuggestions');

function parseCommand(raw) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('/')) {
        const spaceIdx = trimmed.indexOf(' ');
        if (spaceIdx === -1) return { cmd: trimmed.toLowerCase(), text: '' };
        return { cmd: trimmed.substring(0, spaceIdx).toLowerCase(), text: trimmed.substring(spaceIdx + 1).trim() };
    }
    return { cmd: '/memo', text: trimmed };
}

function showSuggestions(filter) {
    const matches = COMMANDS.filter(c => c.name.startsWith(filter.toLowerCase()));
    if (matches.length === 0 || filter.includes(' ')) {
        cmdSuggestions.classList.remove('show');
        activeSuggestion = -1;
        return;
    }
    activeSuggestion = 0;
    cmdSuggestions.innerHTML = matches.map((c, i) =>
        '<div class="cmd-suggestion' + (i === 0 ? ' active' : '') + '" data-cmd="' + c.name + '">' +
        '<span>' + c.icon + '</span>' +
        '<span class="cmd-name">' + c.name + '</span>' +
        '<span class="cmd-desc">' + c.desc + '</span>' +
        '</div>'
    ).join('');
    cmdSuggestions.classList.add('show');
}

function hideSuggestions() {
    cmdSuggestions.classList.remove('show');
    activeSuggestion = -1;
}

cmdInput.addEventListener('input', (e) => {
    const val = e.target.value;
    if (val.startsWith('/') && !val.includes(' ')) {
        showSuggestions(val);
    } else {
        hideSuggestions();
    }
});

cmdInput.addEventListener('keydown', (e) => {
    const suggestions = cmdSuggestions.querySelectorAll('.cmd-suggestion');

    if (e.key === 'ArrowUp') {
        if (suggestions.length > 0) {
            e.preventDefault();
            activeSuggestion = Math.max(0, activeSuggestion - 1);
            suggestions.forEach((s, i) => s.classList.toggle('active', i === activeSuggestion));
        } else if (cmdHistory.length > 0) {
            e.preventDefault();
            if (cmdHistoryIdx === -1) { cmdHistoryDraft = cmdInput.value; cmdHistoryIdx = cmdHistory.length; }
            if (cmdHistoryIdx > 0) { cmdHistoryIdx--; cmdInput.value = cmdHistory[cmdHistoryIdx]; }
        }
        return;
    }
    if (e.key === 'ArrowDown') {
        if (suggestions.length > 0) {
            e.preventDefault();
            activeSuggestion = Math.min(suggestions.length - 1, activeSuggestion + 1);
            suggestions.forEach((s, i) => s.classList.toggle('active', i === activeSuggestion));
        } else if (cmdHistoryIdx !== -1) {
            e.preventDefault();
            cmdHistoryIdx++;
            if (cmdHistoryIdx >= cmdHistory.length) { cmdInput.value = cmdHistoryDraft; cmdHistoryIdx = -1; }
            else { cmdInput.value = cmdHistory[cmdHistoryIdx]; }
        }
        return;
    }
    if (e.key === 'Tab' && suggestions.length > 0) {
        e.preventDefault();
        const sel = suggestions[Math.max(0, activeSuggestion)];
        if (sel) {
            cmdInput.value = sel.dataset.cmd + ' ';
            hideSuggestions();
        }
        return;
    }
    if (e.key === 'Escape') {
        hideSuggestions();
        return;
    }

    if (e.key === 'Enter' && cmdInput.value.trim()) {
        const raw = cmdInput.value.trim();
        if (cmdHistory[cmdHistory.length - 1] !== raw) cmdHistory.push(raw);
        if (cmdHistory.length > 50) cmdHistory.shift();
        cmdHistoryIdx = -1;
        const jumped = tryDateJump(raw);
        if (jumped) {
            cmdInput.value = '';
            hideSuggestions();
            return;
        }
        const { cmd, text } = parseCommand(cmdInput.value);
        if (!text && cmd !== cmdInput.value.trim()) {
            return;
        }
        if (cmd === '/find') {
            const query = text || '';
            if (query) {
                vscode.postMessage({ type: 'findFiles', query });
                cmdInput.value = '';
            }
            hideSuggestions();
            return;
        }
        if (cmd === '/grep') {
            const query = text || '';
            if (query) {
                document.getElementById('app').innerHTML = '<div class="loading-msg"><span class="spinner"></span>Searching contents...</div>';
                vscode.postMessage({ type: 'grepFiles', query });
                cmdInput.value = '';
            }
            hideSuggestions();
            return;
        }
        if (cmd === '/recent') {
            vscode.postMessage({ type: 'recentFiles' });
            cmdInput.value = '';
            hideSuggestions();
            return;
        }
        const cmdMap = { '/memo': 'memo', '/todo': 'todo', '/ask': 'ask', '/idea': 'idea' };
        const command = cmdMap[cmd] || 'memo';
        const actualText = text || cmdInput.value.trim();
        vscode.postMessage({ type: 'slashCommand', command, text: actualText });
        cmdInput.value = '';
        hideSuggestions();
    }
});

cmdSuggestions.addEventListener('click', (e) => {
    const el = e.target.closest('.cmd-suggestion');
    if (el) {
        cmdInput.value = el.dataset.cmd + ' ';
        cmdInput.focus();
        hideSuggestions();
    }
});

// --- Calendar Logic ---
function pad2(n) { return String(n).padStart(2, '0'); }
function toISO(d) { return d.getFullYear() + '-' + pad2(d.getMonth()+1) + '-' + pad2(d.getDate()); }
function isToday(d) { return toISO(d) === toISO(new Date()); }

function getCalendarDays(year, month) {
    const firstDay = new Date(year, month, 1);
    const startDow = firstDay.getDay();
    const days = [];
    for (let i = startDow - 1; i >= 0; i--) days.push({ date: new Date(year, month, -i), otherMonth: true });
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let i = 1; i <= daysInMonth; i++) days.push({ date: new Date(year, month, i), otherMonth: false });
    while (days.length < 42) days.push({ date: new Date(year, month + 1, days.length - startDow - daysInMonth + 1), otherMonth: true });
    return days;
}

function getGroupsForDate(isoDate) {
    const items = dateIndex[isoDate] || [];
    const groups = {};
    for (const item of items) { if (!groups[item.group]) groups[item.group] = []; groups[item.group].push(item); }
    return groups;
}

function getDotsForDate(isoDate) {
    const items = dateIndex[isoDate] || [];
    const seen = new Set();
    for (const item of items) seen.add(item.group);
    const dots = GROUP_ORDER.filter(g => seen.has(g));
    if (eventIndex[isoDate] && eventIndex[isoDate].length > 0) dots.push('event');
    return dots;
}

function tryDateJump(input) {
    if (!/^\\d{4,8}$/.test(input)) return false;
    let year, month, day;
    if (input.length === 4) {
        month = parseInt(input.substring(0, 2), 10);
        day = parseInt(input.substring(2, 4), 10);
        year = new Date().getFullYear();
    } else if (input.length === 6) {
        const yy = parseInt(input.substring(0, 2), 10);
        year = yy >= 70 ? 1900 + yy : 2000 + yy;
        month = parseInt(input.substring(2, 4), 10);
        day = parseInt(input.substring(4, 6), 10);
    } else if (input.length === 8) {
        year = parseInt(input.substring(0, 4), 10);
        month = parseInt(input.substring(4, 6), 10);
        day = parseInt(input.substring(6, 8), 10);
    } else {
        return false;
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    selectDate(new Date(year, month - 1, day));
    return true;
}

function navigateMonth(delta) { currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + delta, 1); ensureEventsLoaded(currentMonth.getFullYear(), currentMonth.getMonth()); render(); }
function selectDate(d) { selectedDate = d; selectedDates.clear(); currentMonth = new Date(d.getFullYear(), d.getMonth(), 1); ensureEventsLoaded(d.getFullYear(), d.getMonth()); render(); }
function toggleDate(d) {
    const iso = toISO(d);
    if (selectedDates.has(iso)) { selectedDates.delete(iso); }
    else { selectedDates.add(iso); }
    selectedDate = d;
    ensureEventsLoaded(d.getFullYear(), d.getMonth());
    render();
}
function navigateDay(delta) { const d = new Date(selectedDate); d.setDate(d.getDate() + delta); selectDate(d); }
function openFile(filePath) {
    showToast('Opening: ' + filePath.split(/[\\\\/]/).pop());
    vscode.postMessage({ type: 'openFile', path: filePath });
}
function openSettings() { vscode.postMessage({ type: 'openSettings' }); }

function requestProperties(filePath) {
    if (!filePath || pendingPropertiesPath === filePath) return;
    pendingPropertiesPath = filePath;
    vscode.postMessage({ type: 'getProperties', path: filePath });
}

function syncPropertiesForActiveFile() {
    if (!activeFilePath) return;
    if (!activeProperties || activeProperties.path !== activeFilePath) requestProperties(activeFilePath);
}

function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function commandUri(command, args) {
    return 'command:' + command + '?' + encodeURIComponent(JSON.stringify(args));
}

function renderPropertyValue(value) {
    const safe = esc(value);
    if (/^https?:\\/\\//i.test(value)) {
        return '<a class="property-link" href="' + safe + '" title="' + safe + '">' + safe + '</a>';
    }
    return safe;
}

function renderPropertiesPanel() {
    if (!activeFilePath) return '';
    if (!activeProperties || activeProperties.path !== activeFilePath) {
        return '<div class="properties-section"><div class="properties-empty">Loading properties...</div></div>';
    }
    if (!activeProperties.entries || activeProperties.entries.length === 0) return '';

    let html = '<div class="properties-section">';
    html += '<div class="properties-table">';
    for (const entry of activeProperties.entries) {
        html += '<div class="property-key">' + esc(entry.key) + '</div>';
        html += '<div class="property-value">';
        if (entry.values.length > 1 || entry.key.toLowerCase() === 'tags') {
            html += '<div class="property-chip-list">';
            for (const value of entry.values) html += '<span class="property-chip">' + renderPropertyValue(value) + '</span>';
            html += '</div>';
        } else {
            html += renderPropertyValue(entry.values[0] || '');
        }
        html += '</div>';
    }
    html += '</div></div>';
    return html;
}

function ensureEventsLoaded(year, month) {
    const key = year + '-' + pad2(month + 1);
    if (loadedMonths.has(key)) return;
    loadedMonths.add(key);
    const lastDay = new Date(year, month + 1, 0).getDate();
    vscode.postMessage({ type: 'fetchEvents', from: key + '-01', to: key + '-' + pad2(lastDay) });
}

function render() {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const days = getCalendarDays(year, month);
    const selectedISO = toISO(selectedDate);
    const isMulti = selectedDates.size > 0;
    const allSelected = isMulti ? selectedDates : new Set([selectedISO]);
    let html = '';

    html += '<div class="cal-header">';
    html += '<button class="nav-btn" onclick="navigateMonth(-1)">&laquo;</button>';
    html += '<span class="title" onclick="selectDate(new Date())">' + MONTHS[month] + ' ' + year + '</span>';
    html += '<div style="display:flex;align-items:center;gap:2px;">';
    html += '<button class="nav-btn" onclick="navigateMonth(1)">&raquo;</button>';
    html += '</div>';
    html += '</div>';

    html += '<div class="cal-grid">';
    for (const dow of DOW) html += '<div class="cal-dow">' + dow + '</div>';
    for (const { date, otherMonth } of days) {
        const iso = toISO(date);
        const dow = date.getDay();
        let cls = 'cal-day';
        if (otherMonth) cls += ' other-month';
        if (isToday(date)) cls += ' today';
        if (allSelected.has(iso)) cls += ' selected';
        if (dow === 0) cls += ' sunday';
        if (dow === 6) cls += ' saturday';
        const dots = getDotsForDate(iso);
        let dotsHtml = '<div class="dots">';
        for (const g of dots) dotsHtml += '<div class="dot ' + g + '"></div>';
        dotsHtml += '</div>';
        html += '<div class="' + cls + '" data-y="' + date.getFullYear() + '" data-m="' + date.getMonth() + '" data-d="' + date.getDate() + '">';
        html += '<span class="day-num">' + date.getDate() + '</span>' + dotsHtml + '</div>';
    }
    html += '</div>';

    html += '<div class="divider"></div>';

    if (isMulti) {
        html += '<div class="date-label"><button class="nav-sm" onclick="selectedDates.clear(); render();">\\u2716</button><span>' + allSelected.size + ' dates selected</span></div>';
    } else {
        const selDate = selectedDate;
        const dateStr = MONTHS[selDate.getMonth()] + ' ' + selDate.getDate() + ', ' + selDate.getFullYear();
        html += '<div class="date-label"><button class="nav-sm" onclick="navigateDay(-1)">\\u2190</button><span>' + dateStr + '</span><button class="nav-sm" onclick="navigateDay(1)">\\u2192</button></div>';
    }

    let allEvents = [];
    let allFiles = [];
    for (const iso of allSelected) {
        const evts = eventIndex[iso] || [];
        for (const ev of evts) allEvents.push({ ...ev, date: iso });
        const items = dateIndex[iso] || [];
        for (const item of items) allFiles.push(item);
    }
    syncPropertiesForActiveFile();

    if (gogStatus === 'notInstalled') {
        html += '<div class="event-section"><div class="event-section-header">\\u{1F4C5} Schedule</div>';
        html += '<div class="gog-status-msg"><span>\\u{1F4E6} gogcli \\uBBF8\\uC124\\uCE58</span>';
        html += '<div class="gog-hint">Google Calendar \\uC5F0\\uB3D9\\uC744 \\uC704\\uD574 gogcli\\uB97C \\uC124\\uCE58\\uD558\\uC138\\uC694.</div>';
        html += '<button class="auth-btn" onclick="vscode.postMessage({type:\\u0027installGogcli\\u0027})">\\u{1F680} \\uC790\\uB3D9 \\uC124\\uCE58</button>';
        html += '<button class="auth-btn" onclick="vscode.postMessage({type:\\u0027setGogPath\\u0027})">\\u{1F4C1} \\uACBD\\uB85C \\uC9C0\\uC815</button>';
        html += '<a class="auth-btn" href="https://github.com/openclaw/gogcli" target="_blank">\\u{1F4D6} \\uAC00\\uC774\\uB4DC</a>';
        html += '</div></div>';
    } else if (gogStatus === 'noAccount') {
        html += '<div class="event-section"><div class="event-section-header">\\u{1F4C5} Schedule</div>';
        html += '<div class="gog-status-msg"><span>\\u{1F464} Google \\uACC4\\uC815 \\uBBF8\\uB4F1\\uB85D</span>';
        html += '<div class="gog-hint">\\uD130\\uBBF8\\uB110\\uC5D0\\uC11C Google \\uACC4\\uC815\\uC744 \\uB4F1\\uB85D\\uD558\\uC138\\uC694.</div>';
        html += '<button class="auth-btn" onclick="vscode.postMessage({type:\\u0027gogLogin\\u0027})">\\u{1F511} \\uB85C\\uADF8\\uC778</button>';
        html += '</div></div>';
    } else if (gogAuthError) {
        html += '<div class="event-section"><div class="event-section-header">\\u{1F4C5} Schedule</div>';
        html += '<div class="gog-status-msg"><span>\\u{1F512} \\uD1A0\\uD070 \\uB9CC\\uB8CC</span>';
        html += '<div class="gog-hint">Google \\uC778\\uC99D\\uC774 \\uB9CC\\uB8CC\\uB418\\uC5C8\\uC2B5\\uB2C8\\uB2E4. \\uC7AC\\uB85C\\uADF8\\uC778\\uD558\\uC138\\uC694.</div>';
        html += '<button class="auth-btn" onclick="vscode.postMessage({type:\\u0027gogLogin\\u0027})">\\u{1F511} \\uC7AC\\uB85C\\uADF8\\uC778</button>';
        html += '</div></div>';
    } else if (allEvents.length > 0) {
        html += '<div class="event-section"><div class="event-section-header">\\u{1F4C5} Schedule <span class="badge">' + allEvents.length + '</span></div>';
        for (const ev of allEvents) {
            html += '<div class="event-item">';
            html += ev.allDay ? '<span class="event-allday">ALL</span>' : '<span class="event-time">' + ev.time + '</span>';
            html += '<span>' + ev.summary.replace(/</g, '&lt;') + '</span></div>';
        }
        html += '</div>';
    }

    const mergedGroups = {};
    for (const item of allFiles) {
        if (!mergedGroups[item.group]) mergedGroups[item.group] = [];
        mergedGroups[item.group].push(item);
    }
    const hasAny = Object.keys(mergedGroups).length > 0;
    if (!hasAny && allEvents.length === 0) {
        html += '<div class="empty-msg">No files for ' + (isMulti ? 'selected dates' : 'this date') + '</div>';
    } else {
        for (const gKey of GROUP_ORDER) {
            const items = mergedGroups[gKey];
            if (!items || items.length === 0) continue;
            html += '<div class="file-section"><div class="file-section-header">' + GROUP_ICONS[gKey] + ' ' + GROUP_LABELS[gKey] + '<span class="badge">' + items.length + '</span></div>';
            for (const item of items) {
                const safeAttr = item.path.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
                const safeTitle = item.relativePath.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
                const href = commandUri('noteWise.calendar.openPath', [item.path]);
                const activeClass = item.path === activeFilePath ? ' active-file' : '';
                html += '<a class="file-item' + activeClass + '" href="' + href + '" data-path="' + safeAttr + '" title="' + safeTitle + '">' + esc(item.name) + '</a>';
            }
            html += '</div>';
        }
    }

    html += renderPropertiesPanel();

    document.getElementById('app').innerHTML = html;
}

function renderSearch() {
    const { query, items } = searchResults;
    let html = '';
    html += '<div class="date-label"><button class="nav-sm" id="searchClose">\\u2190</button><span>\\u{1F50D} &quot;' + query.replace(/</g,'&lt;') + '&quot; (' + items.length + ')</span></div>';
    if (items.length === 0) {
        html += '<div class="empty-msg">No files found</div>';
    } else {
        for (const gKey of GROUP_ORDER) {
            const gItems = items.filter(i => i.group === gKey);
            if (gItems.length === 0) continue;
            html += '<div class="file-section"><div class="file-section-header">' + GROUP_ICONS[gKey] + ' ' + GROUP_LABELS[gKey] + '<span class="badge">' + gItems.length + '</span></div>';
            for (const item of gItems) {
                const safeAttr = item.path.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
                const safeTitle = item.relativePath.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
                const href = commandUri('noteWise.calendar.openPath', [item.path]);
                html += '<a class="file-item" href="' + href + '" data-path="' + safeAttr + '" title="' + safeTitle + '">' + esc(item.name) + '</a>';
            }
            html += '</div>';
        }
    }
    document.getElementById('app').innerHTML = html;
    document.getElementById('searchClose')?.addEventListener('click', () => { searchResults = null; render(); });
}

function renderGrep() {
    const { query, items } = searchResults;
    const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    let html = '';
    html += '<div class="date-label"><button class="nav-sm" id="searchClose">\\u2190</button><span>\\u{1F50E} &quot;' + esc(query) + '&quot; (' + items.length + ' hits)</span></div>';
    if (items.length === 0) {
        html += '<div class="empty-msg">No matches found</div>';
    } else {
        function escRegex(s) { return s.replace(/[-\\/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&'); }
        const re = new RegExp('(' + escRegex(query) + ')', 'gi');
        for (const item of items) {
            const highlighted = esc(item.preview).replace(re, '<span class="grep-highlight">$1</span>');
            html += '<div class="grep-item" data-gpath="' + esc(item.path) + '" data-gline="' + item.line + '">';
            html += '<div><span class="grep-file">' + esc(item.name) + '</span><span class="grep-line">:' + item.line + '</span></div>';
            html += '<div class="grep-preview">' + highlighted + '</div>';
            html += '</div>';
        }
    }
    document.getElementById('app').innerHTML = html;
    document.getElementById('searchClose')?.addEventListener('click', () => { searchResults = null; render(); });
}

function renderRecent() {
    const { items } = searchResults;
    const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    function timeAgo(ms) {
        const sec = Math.floor((Date.now() - ms) / 1000);
        if (sec < 60) return sec + 's ago';
        const min = Math.floor(sec / 60);
        if (min < 60) return min + 'm ago';
        const hr = Math.floor(min / 60);
        if (hr < 24) return hr + 'h ago';
        const d = Math.floor(hr / 24);
        return d + 'd ago';
    }
    let html = '';
    html += '<div class="date-label"><button class="nav-sm" id="searchClose">\\u2190</button><span>\\u{1F552} Recent (' + items.length + ')</span></div>';
    if (items.length === 0) {
        html += '<div class="empty-msg">No recent files</div>';
    } else {
        for (const item of items) {
            const safeAttr = esc(item.path);
            const safeTitle = esc(item.relativePath);
            const href = commandUri('noteWise.calendar.openPath', [item.path]);
            html += '<a class="recent-item file-item" href="' + href + '" data-path="' + safeAttr + '" title="' + safeTitle + '">';
            html += '<span class="recent-name">' + esc(item.name) + '</span>';
            html += '<span class="recent-time">' + timeAgo(item.mtime) + '</span>';
            html += '</a>';
        }
    }
    document.getElementById('app').innerHTML = html;
    document.getElementById('searchClose')?.addEventListener('click', () => { searchResults = null; render(); });
}

document.getElementById('app').addEventListener('click', (e) => {
    const dayEl = e.target.closest('.cal-day');
    if (dayEl && dayEl.dataset.y) {
        const d = new Date(parseInt(dayEl.dataset.y), parseInt(dayEl.dataset.m), parseInt(dayEl.dataset.d));
        if (e.ctrlKey || e.metaKey) { toggleDate(d); }
        else { selectDate(d); }
        return;
    }
    const grepEl = e.target.closest('.grep-item');
    if (grepEl && grepEl.dataset.gpath) {
        vscode.postMessage({ type: 'openFileAtLine', path: grepEl.dataset.gpath, line: parseInt(grepEl.dataset.gline, 10) });
        return;
    }
    const el = e.target.closest('.file-item');
    if (el && el.dataset.path) {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
            vscode.postMessage({ type: 'copyPath', path: el.dataset.path });
        } else {
            openFile(el.dataset.path);
        }
    }
});

// --- Context Menu ---
const ctxMenu = document.getElementById('ctxMenu');
let ctxTargetPath = null;

document.getElementById('app').addEventListener('contextmenu', (e) => {
    const el = e.target.closest('.file-item');
    if (el && el.dataset.path) {
        e.preventDefault();
        ctxTargetPath = el.dataset.path;
        const x = Math.min(e.clientX, window.innerWidth - 170);
        const y = Math.min(e.clientY, window.innerHeight - 100);
        ctxMenu.style.left = x + 'px';
        ctxMenu.style.top = y + 'px';
        ctxMenu.classList.add('show');
    }
});

document.addEventListener('click', () => { ctxMenu.classList.remove('show'); });
document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.file-item')) ctxMenu.classList.remove('show');
});

ctxMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.ctx-menu-item');
    if (!item || !ctxTargetPath) return;
    const action = item.dataset.action;
    if (action === 'open') openFile(ctxTargetPath);
    else if (action === 'reveal') vscode.postMessage({ type: 'revealInFinder', path: ctxTargetPath });
    else if (action === 'copy') vscode.postMessage({ type: 'copyPath', path: ctxTargetPath });
    else if (action === 'delete') vscode.postMessage({ type: 'deleteFile', path: ctxTargetPath });
    ctxMenu.classList.remove('show');
    ctxTargetPath = null;
});

render();
</script>
</body>
</html>`;
    }
}

function activateDateWise(context) {
    const provider = new CalendarViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('noteWise.calendarView', provider, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('noteWise.calendar.focusCalendar', () => {
            if (provider._view && provider._view.visible) {
                vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
            } else {
                vscode.commands.executeCommand('noteWise.calendarView.focus');
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('noteWise.calendar.refresh', () => {
            if (provider._view) {
                provider._refreshAll().then(() => {
                    provider._postMessage('updateIndex', provider._dateMap);
                    provider._postMessage('updateEvents', provider._eventMap);
                });
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('noteWise.calendar.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'noteWise.calendar');
        })
    );

    // v1.4.3: VSCode keybindings are static (manifest-only) so we cannot accept
    // a keystroke from settings.json and rebind on the fly. The next best thing
    // is to send the user one click away from the standard Keyboard Shortcuts
    // editor, pre-filtered to this extension.
    context.subscriptions.push(
        vscode.commands.registerCommand('noteWise.calendar.changeShortcut', () => {
            vscode.commands.executeCommand(
                'workbench.action.openGlobalKeybindings',
                '@ext:local.notewise-editor'
            );
        })
    );

    // v1.4.4: gogcli 원클릭 설치 / 경로 직접 지정
    context.subscriptions.push(
        vscode.commands.registerCommand('noteWise.calendar.installGogcli', () => installGogcli())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('noteWise.calendar.setGogPath', () => setGogPathInteractive())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('noteWise.calendar.openPath', (filePath) => {
            if (typeof filePath === 'string') {
                provider._postMessage('openStatus', { state: 'received', path: filePath });
                provider._openFileWithSettings(filePath).catch((error) => {
                    provider._postMessage('openStatus', {
                        state: 'failed',
                        path: filePath,
                        message: error?.message || String(error),
                    });
                });
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('noteWise.calendar.setActiveFile', (filePath) => {
            if (typeof filePath === 'string') provider._setActiveMarkdownFile(filePath);
        })
    );

    // gogPath 설정 변경 시 경로/상태 캐시 무효화 후 새로고침
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('noteWise.calendar.gogPath')) {
                resetGogPathCache();
                resetGogStatusCache();
                vscode.commands.executeCommand('noteWise.calendar.refresh');
            }
        })
    );

    // Status Bar 달력 아이콘 (하단 우측, 클릭으로 토글)
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = '$(calendar) NoteWise';
    const shortcutLabel = process.platform === 'darwin' ? 'Cmd+Shift+B' : 'Ctrl+Shift+B';
    const tooltipMd = new vscode.MarkdownString(undefined, true);
    tooltipMd.isTrusted = true;
    tooltipMd.appendMarkdown(`**Calendar 사이드바 토글**  \`${shortcutLabel}\`\n\n`);
    tooltipMd.appendMarkdown('[$(keyboard) 단축키 변경하기](command:noteWise.calendar.changeShortcut)');
    tooltipMd.supportThemeIcons = true;
    statusBarItem.tooltip = tooltipMd;
    statusBarItem.command = 'noteWise.calendar.focusCalendar';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    setTimeout(() => {
        vscode.commands.executeCommand('noteWise.calendarView.focus');
    }, 3000);
}

function deactivateDateWise() {}

module.exports = { activateDateWise, deactivateDateWise };
