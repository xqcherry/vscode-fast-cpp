import * as fs from 'fs';
import * as path from 'path';

export class SourceResolver {
    private sourcePathByBasename = new Map<string, string>();
    private workspaceSourceIndexByBasename = new Map<string, string[]>();
    private recentBreakpointSources: string[] = [];
    private gdbSubstitutePathApplied = new Set<string>();

    public constructor(
        private readonly sendCommand: (cmd: string) => Promise<any>,
        private readonly emitOutput: (message: string) => void,
    ) {}

    public resetForLaunch(): void {
        this.sourcePathByBasename.clear();
        this.gdbSubstitutePathApplied.clear();
    }

    public indexWorkspaceSources(rootDir: string): void {
        this.workspaceSourceIndexByBasename.clear();

        const stack: string[] = [rootDir];
        while (stack.length > 0) {
            const current = stack.pop()!;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(current, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const entry of entries) {
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.vscode') {
                        continue;
                    }
                    stack.push(full);
                    continue;
                }

                if (!entry.isFile()) {
                    continue;
                }

                if (!/\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(entry.name)) {
                    continue;
                }

                const key = entry.name.toLowerCase();
                const arr = this.workspaceSourceIndexByBasename.get(key) || [];
                arr.push(path.resolve(full));
                this.workspaceSourceIndexByBasename.set(key, arr);
            }
        }
    }

    public registerSourcePath(sourcePath: string): void {
        const resolved = path.resolve(sourcePath);
        this.sourcePathByBasename.set(path.basename(resolved), resolved);
    }

    public rememberRecentBreakpointSource(sourcePath: string): void {
        const resolved = path.resolve(sourcePath);
        const normalized = this.normalizePath(resolved);
        this.recentBreakpointSources = [
            resolved,
            ...this.recentBreakpointSources.filter((p) => this.normalizePath(p) !== normalized),
        ].slice(0, 20);
    }

    public resolveSourcePathFromGdb(fileRaw?: string): string | undefined {
        if (!fileRaw) {
            return undefined;
        }

        const baseName = path.basename(fileRaw);
        const direct = this.sourcePathByBasename.get(baseName);
        if (direct) {
            return direct;
        }

        const candidates = this.workspaceSourceIndexByBasename.get(baseName.toLowerCase()) || [];
        if (candidates.length === 0) {
            return fileRaw;
        }

        const normalizedRaw = this.normalizePath(fileRaw);
        const exact = candidates.find((p) => normalizedRaw.endsWith(this.normalizePath(p)));
        if (exact) {
            this.sourcePathByBasename.set(baseName, exact);
            return exact;
        }

        const best = this.pickBestSourceCandidate(candidates, fileRaw);
        this.sourcePathByBasename.set(baseName, best);
        return best;
    }

    public async applySubstitutePathIfNeeded(fileRaw?: string, mappedFile?: string): Promise<void> {
        if (!fileRaw || !mappedFile) {
            return;
        }

        const rawDir = path.dirname(fileRaw).replace(/\\/g, '/');
        const mappedDir = path.dirname(mappedFile).replace(/\\/g, '/');

        if (!rawDir || !mappedDir || this.normalizePath(rawDir) === this.normalizePath(mappedDir)) {
            return;
        }

        const key = `${this.normalizePath(rawDir)}=>${this.normalizePath(mappedDir)}`;
        if (this.gdbSubstitutePathApplied.has(key)) {
            return;
        }

        try {
            await this.sendCommand(`-interpreter-exec console "set substitute-path ${rawDir} ${mappedDir}"`);
            this.gdbSubstitutePathApplied.add(key);
            this.emitOutput(`[SourceMap] substitute-path: ${rawDir} -> ${mappedDir}\n`);
        } catch (err: any) {
            this.emitOutput(`[SourceMap warn] set substitute-path 失败: ${err?.message || String(err)}\n`);
        }
    }

    public async preInjectSourceMapFromBreakpoints(sources: string[]): Promise<void> {
        const sourceDirs = Array.from(new Set(sources.map((s) => path.dirname(path.resolve(s)).replace(/\\/g, '/'))));

        for (const dir of sourceDirs) {
            const variants = Array.from(new Set([dir, dir.replace(/\//g, '\\')]));
            for (const rawDir of variants) {
                const mappedDir = dir;
                const key = `${this.normalizePath(rawDir)}=>${this.normalizePath(mappedDir)}`;
                if (this.gdbSubstitutePathApplied.has(key)) {
                    continue;
                }

                try {
                    await this.sendCommand(`-interpreter-exec console "set substitute-path ${rawDir} ${mappedDir}"`);
                    this.gdbSubstitutePathApplied.add(key);
                } catch (err: any) {
                    this.emitOutput(`[SourceMap warn] preinject 失败: ${err?.message || String(err)}\n`);
                }
            }
        }
    }

    private normalizePath(p: string): string {
        return p.replace(/\\/g, '/').toLowerCase();
    }

    private pickBestSourceCandidate(candidates: string[], fileRaw: string): string {
        if (candidates.length === 1) {
            return candidates[0];
        }

        const normalizedRaw = this.normalizePath(fileRaw);
        const bySuffix = candidates.find((p) => normalizedRaw.endsWith(path.basename(p).toLowerCase()));
        if (bySuffix) {
            return bySuffix;
        }

        for (const recent of this.recentBreakpointSources) {
            const recentDir = this.normalizePath(path.dirname(recent));
            const preferred = candidates.find((p) => this.normalizePath(path.dirname(p)).includes(recentDir));
            if (preferred) {
                return preferred;
            }
        }

        return candidates[0];
    }
}
