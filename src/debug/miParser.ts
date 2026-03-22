export interface MITuple {
    [key: string]: MIValue;
}

export interface MIList extends Array<MIValue> {}

export type MIValue = string | MITuple | MIList;

export interface MIResultRecord {
    type: 'result';
    token: number | null;
    clazz: string;
    results: MITuple;
    raw: string;
}

export interface MIAsyncRecord {
    type: 'async';
    token: number | null;
    asyncClass: 'exec' | 'status' | 'notify';
    clazz: string;
    results: MITuple;
    raw: string;
}

export interface MIStreamRecord {
    type: 'stream';
    token: null;
    streamClass: 'console' | 'target' | 'log';
    text: string;
    raw: string;
}

export interface MIUnknownRecord {
    type: 'unknown';
    token: number | null;
    raw: string;
}

export type MIRecord = MIResultRecord | MIAsyncRecord | MIStreamRecord | MIUnknownRecord;

function parseCString(input: string, start: number): { value: string; next: number } {
    let i = start;
    let out = '';
    if (input[i] !== '"') {
        throw new Error('invalid c-string start');
    }
    i++;

    while (i < input.length) {
        const ch = input[i];
        if (ch === '"') {
            return { value: out, next: i + 1 };
        }
        if (ch === '\\') {
            i++;
            if (i >= input.length) {
                break;
            }
            const esc = input[i];
            switch (esc) {
                case 'n':
                    out += '\n';
                    break;
                case 'r':
                    out += '\r';
                    break;
                case 't':
                    out += '\t';
                    break;
                case '"':
                    out += '"';
                    break;
                case '\\':
                    out += '\\';
                    break;
                default:
                    out += esc;
                    break;
            }
            i++;
            continue;
        }
        out += ch;
        i++;
    }

    throw new Error('unterminated c-string');
}

function skipComma(input: string, i: number): number {
    return input[i] === ',' ? i + 1 : i;
}

function parseIdentifier(input: string, start: number): { ident: string; next: number } {
    let i = start;
    let out = '';
    while (i < input.length) {
        const ch = input[i];
        if (/[_a-zA-Z0-9\-]/.test(ch)) {
            out += ch;
            i++;
        } else {
            break;
        }
    }
    return { ident: out, next: i };
}

function parseConst(input: string, start: number): { value: string; next: number } {
    let i = start;
    let out = '';
    while (i < input.length) {
        const ch = input[i];
        if (ch === ',' || ch === '}' || ch === ']') {
            break;
        }
        out += ch;
        i++;
    }
    return { value: out.trim(), next: i };
}

function parseValue(input: string, start: number): { value: MIValue; next: number } {
    const ch = input[start];
    if (ch === '"') {
        return parseCString(input, start);
    }
    if (ch === '{') {
        return parseTuple(input, start);
    }
    if (ch === '[') {
        return parseList(input, start);
    }
    return parseConst(input, start);
}

function parseTuple(input: string, start: number): { value: MITuple; next: number } {
    let i = start;
    const obj: MITuple = {};
    if (input[i] !== '{') {
        throw new Error('invalid tuple start');
    }
    i++;

    while (i < input.length) {
        if (input[i] === '}') {
            return { value: obj, next: i + 1 };
        }

        const key = parseIdentifier(input, i);
        i = key.next;

        if (!key.ident || input[i] !== '=') {
            const cv = parseConst(input, i);
            obj[`$${Object.keys(obj).length}`] = cv.value;
            i = cv.next;
        } else {
            i++;
            const parsed = parseValue(input, i);
            obj[key.ident] = parsed.value;
            i = parsed.next;
        }

        i = skipComma(input, i);
    }

    throw new Error('unterminated tuple');
}

function parseList(input: string, start: number): { value: MIValue[]; next: number } {
    let i = start;
    const arr: MIValue[] = [];
    if (input[i] !== '[') {
        throw new Error('invalid list start');
    }
    i++;

    while (i < input.length) {
        if (input[i] === ']') {
            return { value: arr, next: i + 1 };
        }

        const id = parseIdentifier(input, i);
        if (id.ident && input[id.next] === '=') {
            i = id.next + 1;
            const parsed = parseValue(input, i);
            arr.push({ [id.ident]: parsed.value } as MITuple);
            i = parsed.next;
        } else {
            const parsed = parseValue(input, i);
            arr.push(parsed.value);
            i = parsed.next;
        }

        i = skipComma(input, i);
    }

    throw new Error('unterminated list');
}

function parseRecordBody(rest: string): { clazz: string; results: MITuple } {
    const firstComma = rest.indexOf(',');
    if (firstComma === -1) {
        return { clazz: rest, results: {} };
    }

    const clazz = rest.slice(0, firstComma);
    const tail = rest.slice(firstComma + 1);
    const parsed = parseTuple(`{${tail}}`, 0);
    return { clazz, results: parsed.value };
}

export function parseMIOutputLine(line: string): MIRecord {
    const m = line.match(/^(\d+)?(\^|\*|=|~|&|@)(.*)$/s);
    if (!m) {
        return {
            type: 'unknown',
            token: null,
            raw: line,
        };
    }

    const token = m[1] ? parseInt(m[1], 10) : null;
    const prefix = m[2];
    const rest = m[3];

    if (prefix === '^') {
        const parsed = parseRecordBody(rest);
        return {
            type: 'result',
            token,
            clazz: parsed.clazz,
            results: parsed.results,
            raw: rest,
        };
    }

    if (prefix === '*' || prefix === '=') {
        const parsed = parseRecordBody(rest);
        return {
            type: 'async',
            token,
            asyncClass: prefix === '*' ? 'exec' : 'notify',
            clazz: parsed.clazz,
            results: parsed.results,
            raw: rest,
        };
    }

    if (prefix === '~' || prefix === '&' || prefix === '@') {
        let text = rest;
        if (text.startsWith('"')) {
            try {
                text = parseCString(text, 0).value;
            } catch {
                // keep raw
            }
        }

        return {
            type: 'stream',
            token: null,
            streamClass: prefix === '~' ? 'console' : prefix === '@' ? 'target' : 'log',
            text,
            raw: rest,
        };
    }

    return {
        type: 'unknown',
        token,
        raw: line,
    };
}

export function asTuple(v: MIValue | undefined): MITuple | undefined {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as MITuple) : undefined;
}

export function asArray(v: MIValue | undefined): MIValue[] | undefined {
    return Array.isArray(v) ? v : undefined;
}

export function asString(v: MIValue | undefined): string | undefined {
    return typeof v === 'string' ? v : undefined;
}
