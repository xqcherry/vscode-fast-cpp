import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as https from 'https';
import * as sevenZip from '7zip-min';  // npm install --save-dev @types/7zip-min
// import * as JSZip from 'jszip'; // npm install jszip @types/jszip

const MINGW_URL = 'https://files.1f0.de/mingw/mingw-w64-gcc-14.3-stable-r43.7z';

export async function ensureMinGW(context: vscode.ExtensionContext): Promise<string> {  
    const targetDir = path.join(context.globalStorageUri.fsPath, 'mingw');
    const binDir = path.join(targetDir, 'bin');
    const gpp = path.join(binDir, 'g++.exe');
    
    console.log('[MinGW] 检查路径g++:', gpp);
    
    if (!fs.existsSync(gpp)) {
        vscode.window.showInformationMessage('首次使用：正在准备 MinGW 编译器环境...');
        fs.mkdirSync(targetDir, { recursive: true });
        
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'MinGW 安装进度',
            cancellable: false
        }, async (progress) => {
            progress.report({ message: '正在从网络下载 MinGW 包...' });
            const zipDataBuffer = await downloadFileToBuffer(MINGW_URL, progress);
            
            progress.report({ message: '下载完成，正在解压文件...' });
            const zipPath = path.join(targetDir, 'mingw.7z');
            fs.writeFileSync(zipPath, zipDataBuffer);

            await new Promise<void>((resolve, reject) => {
                sevenZip.unpack(zipPath, targetDir, (err) => {
                    if(err) return reject(err);
                    resolve();
                });
            });
            
            progress.report({ message: 'MinGW 解压完成！' });
        });
        
        vscode.window.showInformationMessage('MinGW 已成功安装！');
    }
    
    process.env.PATH += path.delimiter + binDir;
    return gpp;
}

function downloadFileToBuffer(
    url: string,
    progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const buffers: Buffer[] = [];
        
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error('下载失败-_-!'));}
            
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(downloadFileToBuffer(res.headers.location));}
            
            const totalSize = parseInt(res.headers['content-length'] || '0');
            let downloaded = 0;
            let lastPercent = 0;
            
            res.on('data', (chunk) => {
                buffers.push(chunk as Buffer);
                downloaded += chunk.length;
                
                if (totalSize > 0) {
                    const percent = Math.floor((downloaded / totalSize) * 100);
                    if (percent >= lastPercent + 5) {
                        // vscode.window.showInformationMessage(`正在从网络下载 MinGW 包... (${percent}%)`);
                        progress?.report({ message: `正在下载 MinGW (${percent}%)` });
                        lastPercent = percent;
                    }
                }
            });
            
            res.on('end', () => {
                progress?.report({ message: '下载完成!', increment: 100 - lastPercent });
                resolve(Buffer.concat(buffers));
            });
        }).on('error', (err) => {
            reject(new Error(`下载过程中发生错误: ${err.message}`));
        });
    });
}