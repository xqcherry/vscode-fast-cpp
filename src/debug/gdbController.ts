import * as child_process from 'child_process';
import * as fs from 'fs';
import {MIRecord, MIResultRecord, parseMIOutputLine, asString} from './miParser';


export class GDBController {
    private process?: child_process.ChildProcess;
    private buffer = '';
    private token = 1;
    private pending = new Map<number, {
        resolve: (r: MIResultRecord) => void;
        reject: (e: Error) => void;
        timeout: NodeJS.Timeout;
    }>();
    private onCallBack?: (record: MIRecord) => void;

    public constructor(private readonly gdbPath: string) {}

    private onData(chunk: string) {
        this.buffer += chunk;
        let idx: number;
        while ((idx = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (!line || line === '(gdb)') {
                continue;
            }
            this.handleLine(line);
        }
    }

    private handleLine(line: string) {
        const record = parseMIOutputLine(line);

        if (record.type === 'result') {
            const token = record.token;
            if (token !== null && this.pending.has(token)) {
                const p = this.pending.get(token)!;
                clearTimeout(p.timeout);
                this.pending.delete(token);

                if (record.clazz === 'error') {
                    const message = asString(record.results.msg) || record.raw;
                    p.reject(new Error(message));
                } else {
                    p.resolve(record);
                }
            } else {
                this.onCallBack?.(record);
            }
            return;
        }

        this.onCallBack?.(record);
    }

    start(cwd?: string) {
        if (this.process) {
            return;
        }
        if (!fs.existsSync(this.gdbPath)) {
            throw new Error(`未找到 gdb: ${this.gdbPath}`);
        }

        this.process = child_process.spawn(this.gdbPath, ['--interpreter=mi2'], { cwd, shell: false });
        this.process.stdout?.on('data', (d: Buffer) => this.onData(d.toString()));
        this.process.stderr?.on('data', (d: Buffer) => this.onData(`&"${d.toString().replace(/"/g, '\\"')}"`));
        this.process.on('exit', () => {
            for (const [, val] of this.pending) {
                clearTimeout(val.timeout);
                val.reject(new Error('GDB 已退出'));
            }
            this.pending.clear();
            this.process = undefined;
        });
    }

    stop() {
        if (!this.process) {
            return;
        }
        try {
            this.process.kill();
        } catch {
            // ignore
        }
        this.process = undefined;
    }

    isRunning() {
        return Boolean(this.process);
    }

    setCallBack(cb: (record: MIRecord) => void) {
        this.onCallBack = cb;
    }

    sendCommand(cmd: string, timeoutMs = 5000): Promise<MIResultRecord> {
        if (!this.process || !this.process.stdin) {
            return Promise.reject(new Error('GDB 停止运行'));
        }

        const token = this.token++;
        const full = `${token}${cmd}\n`;

        return new Promise((resolve, reject) => {
            const to = setTimeout(() => {
                this.pending.delete(token);
                reject(new Error(`GDB 命令超时: ${cmd}`));
            }, timeoutMs);

            this.pending.set(token, { resolve, reject, timeout: to });
            this.process!.stdin!.write(full);
        });
    }
}