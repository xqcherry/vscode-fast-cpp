import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as https from 'https';
import * as sevenZip from '7zip-min';

const MINGW_URL = 'https://files.1f0.de/mingw/mingw-w64-gcc-14.3-stable-r43.7z';

export interface MinGWToolchain {
    binDir: string;
    gppPath: string;
    gdbPath: string;
}

export async function ensureMinGW(context: vscode.ExtensionContext): Promise<MinGWToolchain> {
    const targetDir = path.join(context.globalStorageUri.fsPath, 'mingw');
    const binDir = path.join(targetDir, 'bin');
    const gppPath = path.join(binDir, 'x86_64-w64-mingw32-g++.exe');
    const gdbPath = path.join(binDir, 'x86_64-w64-mingw32-gdb.exe');

    const ready = fs.existsSync(gppPath) && fs.existsSync(gdbPath);

    if (!ready) {
        vscode.window.showInformationMessage('首次使用：正在准备 MinGW 编译/调试环境...');
        fs.mkdirSync(targetDir, { recursive: true });

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'MinGW 安装进度',
                cancellable: false,
            },
            async (progress) => {
                progress.report({ message: '正在从网络下载 MinGW 包...' });
                const archiveBuffer = await downloadFileToBuffer(MINGW_URL, progress);

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

        if (!fs.existsSync(gppPath) || !fs.existsSync(gdbPath)) {
            throw new Error(`MinGW 安装不完整，未找到 g++ 或 gdb: ${binDir}`);
        }

        vscode.window.showInformationMessage('MinGW 已成功安装！');
    }

    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH || ''}`;

    return {
        binDir,
        gppPath,
        gdbPath,
    };
}

function downloadFileToBuffer(
    url: string,
    progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const buffers: Buffer[] = [];

        https
            .get(url, (res) => {
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
            })
            .on('error', (err) => {
                reject(new Error(`下载过程中发生错误: ${err.message}`));
            });
    });
}
