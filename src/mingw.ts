import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as https from 'https';
import * as sevenZip from '7zip-min';

const WINLIBS_LATEST_RELEASE_API = 'https://api.github.com/repos/brechtsanders/winlibs_mingw/releases/latest';
const DEFAULT_PROXY_PREFIXES = [
    'https://ghfast.top/',
    'https://gh-proxy.com/',
    'https://mirror.ghproxy.com/',
];

export interface MinGWToolchain {
    binDir: string;
    gppPath: string;
    gdbPath: string;
}

export async function ensureMinGW(context: vscode.ExtensionContext): Promise<MinGWToolchain> {
    const targetDir = path.join(context.globalStorageUri.fsPath, 'mingw');

    let toolchain = findToolchainInDir(targetDir);

    if (!toolchain) {
        vscode.window.showInformationMessage('首次使用：正在准备 MinGW 编译/调试环境...');
        fs.mkdirSync(targetDir, { recursive: true });

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'MinGW 安装进度',
                cancellable: false,
            },
            async (progress) => {
                progress.report({ message: '正在获取最新 WinLibs 版本信息...' });
                const downloadUrl = await resolveLatestWinLibsAssetUrl();
                const candidateUrls = buildDownloadCandidates(downloadUrl);

                progress.report({ message: '正在从网络下载 WinLibs 包...' });
                const archiveBuffer = await downloadFileWithFallback(candidateUrls, progress);

                progress.report({ message: '下载完成，正在解压文件...' });
                const archivePath = path.join(targetDir, 'mingw.7z');
                fs.writeFileSync(archivePath, archiveBuffer);

                await new Promise<void>((resolve, reject) => {
                    sevenZip.unpack(archivePath, targetDir, (err) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        resolve();
                    });
                });

                progress.report({ message: 'MinGW 解压完成！' });
            }
        );

        toolchain = findToolchainInDir(targetDir);
        if (!toolchain) {
            throw new Error(`MinGW 安装不完整，未找到 g++ 或 gdb: ${targetDir}`);
        }

        vscode.window.showInformationMessage('MinGW 已成功安装！');
    }

    process.env.PATH = `${toolchain.binDir}${path.delimiter}${process.env.PATH || ''}`;

    return toolchain;
}

async function resolveLatestWinLibsAssetUrl(): Promise<string> {
    const body = await fetchTextWithRedirect(WINLIBS_LATEST_RELEASE_API, 8);

    try {
        const json = JSON.parse(body) as {
            assets?: Array<{ name?: string; browser_download_url?: string }>;
        };

        const assets = json.assets || [];
        const selected = pickWinLibsAsset(assets);
        if (!selected) {
            throw new Error('未找到合适的 WinLibs 下载资源（需要 x86_64 + 7z/zip）');
        }
        return selected;
    } catch (err: any) {
        throw new Error(`解析 WinLibs 版本信息失败: ${err?.message || String(err)}`);
    }
}

function buildDownloadCandidates(rawUrl: string): string[] {
    const config = vscode.workspace.getConfiguration('maomao');
    const useProxy = config.get<boolean>('downloadProxy.enabled', true);
    const configuredPrefixes = config.get<string[]>('downloadProxy.prefixes', DEFAULT_PROXY_PREFIXES);

    const normalizedPrefixes = (configuredPrefixes || [])
        .map((s) => (typeof s === 'string' ? s.trim() : ''))
        .filter((s) => s.length > 0)
        .map((s) => (s.endsWith('/') ? s : `${s}/`));

    const candidates: string[] = [];

    if (useProxy) {
        for (const prefix of normalizedPrefixes) {
            candidates.push(`${prefix}${rawUrl}`);
        }
    }

    candidates.push(rawUrl);

    return uniqueStrings(candidates);
}

async function downloadFileWithFallback(
    urls: string[],
    progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<Buffer> {
    const errors: string[] = [];

    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        const label = `${i + 1}/${urls.length}`;
        progress?.report({ message: `正在下载 MinGW (${label})` });

        try {
            return await downloadFileToBuffer(url, progress);
        } catch (err: any) {
            const msg = err?.message || String(err);
            errors.push(`[${label}] ${url} -> ${msg}`);
        }
    }

    throw new Error(`所有下载地址均失败:\n${errors.join('\n')}`);
}

function downloadFileToBuffer(
    url: string,
    progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const buffers: Buffer[] = [];

        https
            .get(
                url,
                {
                    headers: {
                        'User-Agent': 'vscode-fast-cpp',
                    },
                },
                (res) => {
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        resolve(downloadFileToBuffer(res.headers.location, progress));
                        return;
                    }

                    if (res.statusCode !== 200) {
                        reject(new Error(`下载失败，HTTP ${res.statusCode ?? 'unknown'}`));
                        return;
                    }

                    const totalSize = parseInt(res.headers['content-length'] || '0', 10);
                    let downloaded = 0;
                    let lastPercent = 0;

                    res.on('data', (chunk) => {
                        const piece = chunk as Buffer;
                        buffers.push(piece);
                        downloaded += piece.length;

                        if (totalSize > 0) {
                            const percent = Math.floor((downloaded / totalSize) * 100);
                            if (percent >= lastPercent + 5) {
                                progress?.report({ message: `正在下载 MinGW (${percent}%)` });
                                lastPercent = percent;
                            }
                        }
                    });

                    res.on('end', () => {
                        progress?.report({ message: '下载完成!' });
                        resolve(Buffer.concat(buffers));
                    });
                }
            )
            .on('error', (err) => {
                reject(new Error(`下载过程中发生错误: ${err.message}`));
            });
    });
}

function fetchTextWithRedirect(url: string, redirectsLeft: number): Promise<string> {
    return new Promise((resolve, reject) => {
        https
            .get(
                url,
                {
                    headers: {
                        'User-Agent': 'vscode-fast-cpp',
                        'Accept': 'application/vnd.github+json',
                    },
                },
                (res) => {
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        if (redirectsLeft <= 0) {
                            reject(new Error('请求重定向次数过多'));
                            return;
                        }
                        resolve(fetchTextWithRedirect(res.headers.location, redirectsLeft - 1));
                        return;
                    }

                    if (res.statusCode !== 200) {
                        reject(new Error(`请求失败，HTTP ${res.statusCode ?? 'unknown'}`));
                        return;
                    }

                    const chunks: Buffer[] = [];
                    res.on('data', (chunk) => chunks.push(chunk as Buffer));
                    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                }
            )
            .on('error', (err) => reject(new Error(err.message)));
    });
}

function pickWinLibsAsset(assets: Array<{ name?: string; browser_download_url?: string }>): string | null {
    const candidates = assets.filter((asset) => {
        if (!asset.name || !asset.browser_download_url) {
            return false;
        }
        const lower = asset.name.toLowerCase();
        if (!lower.includes('winlibs-') || !lower.includes('x86_64') || !lower.includes('posix')) {
            return false;
        }
        return lower.endsWith('.7z') || lower.endsWith('.zip');
    });

    const preferred = candidates.find((asset) => asset.name!.toLowerCase().endsWith('.7z'));
    return (preferred || candidates[0])?.browser_download_url || null;
}

function findToolchainInDir(rootDir: string): MinGWToolchain | null {
    const directBin = path.join(rootDir, 'bin');
    const direct = makeToolchainFromBinDir(directBin);
    if (direct) {
        return direct;
    }

    if (!fs.existsSync(rootDir)) {
        return null;
    }

    const queue: string[] = [rootDir];

    while (queue.length > 0) {
        const current = queue.shift()!;
        const entries = safeReadDir(current);

        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);

            if (entry.isDirectory()) {
                if (entry.name.toLowerCase() === 'bin') {
                    const found = makeToolchainFromBinDir(fullPath);
                    if (found) {
                        return found;
                    }
                } else {
                    queue.push(fullPath);
                }
            }
        }
    }

    return null;
}

function makeToolchainFromBinDir(binDir: string): MinGWToolchain | null {
    const gppPath = pickExistingPath(binDir, [
        'x86_64-w64-mingw32-g++.exe',
        'g++.exe',
    ]);
    const gdbPath = pickExistingPath(binDir, [
        'x86_64-w64-mingw32-gdb.exe',
        'gdb.exe',
    ]);

    if (!gppPath || !gdbPath) {
        return null;
    }

    return {
        binDir,
        gppPath,
        gdbPath,
    };
}

function pickExistingPath(baseDir: string, candidates: string[]): string | null {
    for (const name of candidates) {
        const fullPath = path.join(baseDir, name);
        if (fs.existsSync(fullPath)) {
            return fullPath;
        }
    }
    return null;
}

function safeReadDir(dir: string): fs.Dirent[] {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
}

function uniqueStrings(input: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();

    for (const item of input) {
        if (!seen.has(item)) {
            seen.add(item);
            out.push(item);
        }
    }

    return out;
}
