import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Writable } from 'node:stream';
import type { ClaudeConfig } from './config';

// ─── Types ───────────────────────────────────────────────────────────

/** Claude 进程输出的 JSON 消息 */
export interface ClaudeMessage {
    type: string;
    subtype?: string;
    message?: {
        role: string;
        content: string | Array<{ type: string; text?: string; name?: string; input?: unknown; is_error?: boolean; [key: string]: unknown }>;
    };
    result?: string;
    session_id?: string;
    is_error?: boolean;
    request_id?: string;
    request?: {
        subtype: string;
        tool_name?: string;
        input?: unknown;
    };
    [key: string]: unknown;
}

/** 待审批的权限请求 */
export interface PendingPermission {
    requestId: string;
    toolName: string;
    input: unknown;
    createdAt: number;
}

/** 用户消息的 content block 类型 */
export type ContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** 权限审批结果 */
type PermissionResult = {
    behavior: 'allow';
    updatedInput: Record<string, unknown>;
} | {
    behavior: 'deny';
    message: string;
}

/** control_response 写入 stdin 的格式 */
interface ControlResponse {
    type: 'control_response';
    response: {
        request_id: string;
        subtype: 'success' | 'error';
        response?: PermissionResult;
        error?: string;
    };
}

/** control_request 写入 stdin 的格式 */
interface ControlRequest {
    type: 'control_request';
    request_id: string;
    request: { subtype: string };
}

/** 从 Claude stdout 收到的 control_response */
interface SDKControlResponse {
    type: 'control_response';
    response: {
        request_id: string;
        subtype: 'success' | 'error';
        error?: string;
    };
}

// ─── Stream (from happy-cli) ─────────────────────────────────────────

/**
 * 异步可迭代流，支持 push 模式。
 * 生产者通过 enqueue() 推入数据，消费者通过 for-await-of 消费。
 */
class Stream<T> implements AsyncIterableIterator<T> {
    private queue: T[] = [];
    private readResolve?: (value: IteratorResult<T>) => void;
    private readReject?: (error: Error) => void;
    private isDone = false;
    private hasError?: Error;
    private started = false;

    [Symbol.asyncIterator](): AsyncIterableIterator<T> {
        if (this.started) {
            throw new Error('Stream can only be iterated once');
        }
        this.started = true;
        return this;
    }

    async next(): Promise<IteratorResult<T>> {
        if (this.queue.length > 0) {
            return { done: false, value: this.queue.shift()! };
        }
        if (this.isDone) {
            return { done: true, value: undefined };
        }
        if (this.hasError) {
            throw this.hasError;
        }
        return new Promise((resolve, reject) => {
            this.readResolve = resolve;
            this.readReject = reject;
        });
    }

    enqueue(value: T): void {
        if (this.readResolve) {
            const resolve = this.readResolve;
            this.readResolve = undefined;
            this.readReject = undefined;
            resolve({ done: false, value });
        } else {
            this.queue.push(value);
        }
    }

    done(): void {
        this.isDone = true;
        if (this.readResolve) {
            const resolve = this.readResolve;
            this.readResolve = undefined;
            this.readReject = undefined;
            resolve({ done: true, value: undefined });
        }
    }

    error(error: Error): void {
        this.hasError = error;
        if (this.readReject) {
            const reject = this.readReject;
            this.readResolve = undefined;
            this.readReject = undefined;
            reject(error);
        }
    }

    async return(): Promise<IteratorResult<T>> {
        this.isDone = true;
        return { done: true, value: undefined };
    }
}

// ─── ClaudeProcess ───────────────────────────────────────────────────

type ControlResponseHandler = (response: SDKControlResponse['response']) => void;

/**
 * 管理一个 Claude Code 子进程，支持多轮对话和权限审批。
 *
 * 架构对齐 happy-cli SDK：
 * - 使用 async for-await readline 代替 rl.on('line') 事件回调
 * - 使用 Stream (PushableAsyncIterable) 做消息队列
 * - 权限处理异步化，每个请求有独立 AbortController
 * - 干净的进程退出处理
 */
export class ClaudeProcess {
    private child: ChildProcessWithoutNullStreams | null = null;
    private childStdin: Writable | null = null;
    private readonly config: ClaudeConfig;
    private readonly debug: boolean;

    private onMessage: ((msg: ClaudeMessage) => void) | null = null;
    private onPermissionRequest: ((perm: PendingPermission) => void) | null = null;
    private onLoopDetected: (() => void) | null = null;

    private sessionId: string | null = null;
    private alive = false;

    private readonly pendingPermissions = new Map<string, PendingPermission>();
    /** 我们发出的 control_request 的响应回调 (interrupt 等) */
    private readonly pendingControlResponses = new Map<string, ControlResponseHandler>();
    /** 每个权限请求的 AbortController，支持 control_cancel_request */
    private readonly cancelControllers = new Map<string, AbortController>();

    /** 连续工具错误计数 */
    private consecutiveToolErrors = 0;
    private static readonly MAX_TOOL_ERROR_RETRIES = 20;

    /** 临时全部自动批准（/allow all 触发，turn 结束重置） */
    private autoApproveAll = false;

    /** 消息流 */
    private inputStream = new Stream<ClaudeMessage>();

    constructor(config: ClaudeConfig) {
        this.config = config;
        this.debug = config.debug;
    }

    /** 启动 Claude 进程 */
    start(
        onMessage: (msg: ClaudeMessage) => void,
        onPermissionRequest?: (perm: PendingPermission) => void,
        onLoopDetected?: () => void,
        options?: { continue?: boolean; resume?: string },
    ): void {
        if (this.alive) return;

        this.onMessage = onMessage;
        this.onPermissionRequest = onPermissionRequest ?? null;
        this.onLoopDetected = onLoopDetected ?? null;

        const args = [
            '--input-format', 'stream-json',
            '--output-format', 'stream-json',
            '--verbose',
            '--permission-mode', this.config.permissionMode,
            '--permission-prompt-tool', 'stdio',
        ];

        if (options?.continue) {
            args.push('--continue');
        }
        if (options?.resume) {
            args.push('--resume', options.resume);
        }

        this.child = spawn(this.config.executable, args, {
            cwd: this.config.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        }) as ChildProcessWithoutNullStreams;

        this.childStdin = this.child.stdin;
        this.alive = true;

        // 进程退出 promise
        const processExitPromise = new Promise<void>((resolve) => {
            this.child!.on('close', (code) => {
                this.alive = false;
                this.pendingPermissions.clear();
                this.cleanupControllers();
                console.log(`[claude] Process exited with code ${code}`);
                resolve();
            });
        });

        this.child.on('error', (err) => {
            this.alive = false;
            this.inputStream.error(new Error(`Claude process error: ${err.message}`));
            console.error('[claude] Process error:', err.message);
        });

        this.child.stderr.on('data', (data: Buffer) => {
            console.error('[claude stderr]', data.toString().trim());
        });

        // 启动异步读取循环
        this.readMessages(processExitPromise);
        // 启动消息消费循环
        this.consumeMessages();
    }

    /**
     * 异步读取 stdout，解析 JSON，路由消息。
     * 使用 for-await readline 代替事件回调，天然支持背压。
     */
    private async readMessages(processExitPromise: Promise<void>): Promise<void> {
        const rl = createInterface({ input: this.child!.stdout });

        try {
            for await (const line of rl) {
                if (!line.trim()) continue;

                if (this.debug) {
                    console.log('[raw]', line);
                }

                try {
                    const msg = JSON.parse(line) as ClaudeMessage | SDKControlResponse;

                    // 路由：我们发出的 control_request 的响应
                    if (msg.type === 'control_response') {
                        const resp = msg as SDKControlResponse;
                        const handler = this.pendingControlResponses.get(resp.response.request_id);
                        if (handler) {
                            handler(resp.response);
                            this.pendingControlResponses.delete(resp.response.request_id);
                        }
                        continue;
                    }

                    // 路由：Claude 发来的权限请求
                    if (msg.type === 'control_request' && (msg as ClaudeMessage).request?.subtype === 'can_use_tool') {
                        await this.handleControlRequest(msg as ClaudeMessage);
                        continue;
                    }

                    // 路由：Claude 取消权限请求
                    if (msg.type === 'control_cancel_request' && (msg as ClaudeMessage).request_id) {
                        this.handleControlCancelRequest((msg as ClaudeMessage).request_id!);
                        continue;
                    }

                    // 常规消息入队
                    this.inputStream.enqueue(msg as ClaudeMessage);
                } catch {
                    // 非 JSON 行，忽略
                }
            }
            await processExitPromise;
        } catch (error) {
            this.inputStream.error(error as Error);
        } finally {
            this.inputStream.done();
            this.cleanupControllers();
            rl.close();
        }
    }

    /**
     * 消费消息流，处理业务逻辑（session_id、循环检测、回调）。
     */
    private async consumeMessages(): Promise<void> {
        try {
            for await (const msg of this.inputStream) {
                if (this.debug) {
                    this.logDebug(msg);
                }

                if (msg.type === 'system' && msg.session_id) {
                    this.sessionId = msg.session_id;
                }

                // 检测 tool error 死循环
                if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
                    const toolResults = msg.message!.content.filter(
                        (b) => b.type === 'tool_result',
                    );
                    const hasToolError = toolResults.length > 0 && toolResults.every(
                        (b) => b.is_error === true,
                    );
                    if (hasToolError) {
                        this.consecutiveToolErrors++;
                        if (this.consecutiveToolErrors >= ClaudeProcess.MAX_TOOL_ERROR_RETRIES) {
                            console.log(`[claude] Loop detected: ${this.consecutiveToolErrors} consecutive tool errors, sending interrupt`);
                            this.sendInterrupt();
                            this.consecutiveToolErrors = 0;
                            this.onLoopDetected?.();
                            continue;
                        }
                    } else {
                        this.consecutiveToolErrors = 0;
                    }
                }

                // turn 结束重置计数
                if (msg.type === 'result') {
                    this.consecutiveToolErrors = 0;
                    this.autoApproveAll = false;
                }

                this.onMessage?.(msg);
            }
        } catch (error) {
            console.error('[claude] Message consumer error:', (error as Error).message);
        }
    }

    /**
     * 处理 Claude 发来的权限请求（异步）。
     * 每个请求有独立 AbortController，支持取消。
     */
    private async handleControlRequest(msg: ClaudeMessage): Promise<void> {
        if (!this.childStdin) return;

        const requestId = msg.request_id!;
        const toolName = msg.request!.tool_name || 'unknown';
        const input = msg.request!.input;

        const controller = new AbortController();
        this.cancelControllers.set(requestId, controller);

        try {
            const result = await this.resolvePermission(requestId, toolName, input, controller.signal);
            const response: ControlResponse = {
                type: 'control_response',
                response: {
                    request_id: requestId,
                    subtype: 'success',
                    response: result,
                },
            };
            if (this.debug) {
                console.log('[claude →]', JSON.stringify(response));
            }
            this.childStdin.write(JSON.stringify(response) + '\n');
        } catch (error) {
            // 被取消或出错 → 发送 error 响应
            const errorResponse: ControlResponse = {
                type: 'control_response',
                response: {
                    request_id: requestId,
                    subtype: 'error',
                    error: error instanceof Error ? error.message : String(error),
                },
            };
            this.childStdin.write(JSON.stringify(errorResponse) + '\n');
        } finally {
            this.cancelControllers.delete(requestId);
        }
    }

    /**
     * 决定权限：自动批准 or 挂起等待用户操作。
     * 返回 Promise，用户通过 approvePermission/denyPermission 来 resolve。
     */
    private resolvePermission(
        requestId: string,
        toolName: string,
        input: unknown,
        signal: AbortSignal,
    ): Promise<PermissionResult> {
        // 自动批准安全工具
        if (shouldAutoApprove(toolName, input)) {
            if (this.debug) {
                console.log(`[auto-approve] ${toolName}`);
            }
            return Promise.resolve({
                behavior: 'allow' as const,
                updatedInput: (input as Record<string, unknown>) || {},
            });
        }

        // /allow all 临时全部批准（AskUserQuestion 除外，需要用户实际回答）
        if (this.autoApproveAll && toolName !== 'AskUserQuestion') {
            if (this.debug) {
                console.log(`[auto-approve-all] ${toolName}`);
            }
            return Promise.resolve({
                behavior: 'allow' as const,
                updatedInput: (input as Record<string, unknown>) || {},
            });
        }

        // 需要用户审批 → 挂起
        return new Promise<PermissionResult>((resolve, reject) => {
            const perm: PendingPermission & { resolve: (r: PermissionResult) => void } = {
                requestId,
                toolName,
                input,
                createdAt: Date.now(),
                resolve,
            };

            // 监听取消
            signal.addEventListener('abort', () => {
                this.pendingPermissions.delete(requestId);
                reject(new Error('Permission request cancelled'));
            });

            this.pendingPermissions.set(requestId, perm);
            this.onPermissionRequest?.(perm);
        });
    }

    /** 处理 control_cancel_request */
    private handleControlCancelRequest(requestId: string): void {
        const controller = this.cancelControllers.get(requestId);
        if (controller) {
            controller.abort();
            this.cancelControllers.delete(requestId);
        }
    }

    /** 清理所有 AbortController */
    private cleanupControllers(): void {
        for (const [id, controller] of this.cancelControllers.entries()) {
            controller.abort();
            this.cancelControllers.delete(id);
        }
    }

    // ─── Public API ──────────────────────────────────────────────────

    /** 发送用户消息（文本或包含图片的 content 数组） */
    send(content: string | ContentBlock[]): void {
        if (!this.childStdin || !this.alive) {
            throw new Error('Claude process not running');
        }

        const input = {
            type: 'user',
            message: {
                role: 'user',
                content,
            },
        };

        if (this.debug) {
            console.log('[claude →]', JSON.stringify(input));
        }
        this.childStdin.write(JSON.stringify(input) + '\n');
    }

    /** 批准权限请求 */
    approvePermission(requestId: string, updatedInput?: Record<string, unknown>): boolean {
        const perm = this.pendingPermissions.get(requestId) as (PendingPermission & { resolve?: (r: PermissionResult) => void }) | undefined;
        if (!perm?.resolve) return false;

        perm.resolve({
            behavior: 'allow',
            updatedInput: updatedInput || (perm.input as Record<string, unknown>) || {},
        });
        this.pendingPermissions.delete(requestId);
        return true;
    }

    /** 拒绝权限请求 */
    denyPermission(requestId: string, reason?: string): boolean {
        const perm = this.pendingPermissions.get(requestId) as (PendingPermission & { resolve?: (r: PermissionResult) => void }) | undefined;
        if (!perm?.resolve) return false;

        perm.resolve({
            behavior: 'deny',
            message: reason || '用户拒绝了此操作',
        });
        this.pendingPermissions.delete(requestId);
        return true;
    }

    /** 批准所有待处理的权限请求，并开启临时自动批准直到 turn 结束 */
    approveAll(): number {
        this.autoApproveAll = true;
        let count = 0;
        for (const requestId of [...this.pendingPermissions.keys()]) {
            if (this.approvePermission(requestId)) count++;
        }
        return count;
    }

    /** 拒绝所有待处理的权限请求 */
    denyAll(reason?: string): number {
        let count = 0;
        for (const requestId of [...this.pendingPermissions.keys()]) {
            if (this.denyPermission(requestId, reason)) count++;
        }
        return count;
    }

    /** 获取所有待处理的权限请求 */
    getPendingPermissions(): PendingPermission[] {
        return [...this.pendingPermissions.values()];
    }

    /** 进程是否存活 */
    isAlive(): boolean {
        return this.alive;
    }

    /** 获取 session ID */
    getSessionId(): string | null {
        return this.sessionId;
    }

    /** 终止进程 */
    kill(): void {
        if (this.child && !this.child.killed) {
            this.child.kill('SIGTERM');
        }
        this.alive = false;
        this.pendingPermissions.clear();
        this.cleanupControllers();
    }

    /** 发送中断请求 */
    sendInterrupt(): void {
        if (!this.childStdin || !this.alive) return;

        const requestId = `interrupt_${Date.now()}`;
        const request: ControlRequest = {
            type: 'control_request',
            request_id: requestId,
            request: { subtype: 'interrupt' },
        };

        this.pendingControlResponses.set(requestId, (response) => {
            if (this.debug) {
                console.log('[claude ←] interrupt response:', response.subtype);
            }
        });

        if (this.debug) {
            console.log('[claude →] interrupt');
        }
        this.childStdin.write(JSON.stringify(request) + '\n');
    }

    /** 格式化并打印调试日志 */
    private logDebug(msg: ClaudeMessage): void {
        const tag = `[claude ←][${msg.type}]`;

        if (msg.type === 'system') {
            console.log(tag, `subtype=${msg.subtype} session=${msg.session_id || '-'}`);
        } else if (msg.type === 'assistant' && msg.message) {
            const content = msg.message.content;
            if (typeof content === 'string') {
                console.log(tag, content.length > 300 ? content.slice(0, 300) + '...' : content);
            } else if (Array.isArray(content)) {
                for (const block of content) {
                    if (block.type === 'text') {
                        const text = block.text || '';
                        console.log(tag, `text: ${text.length > 300 ? text.slice(0, 300) + '...' : text}`);
                    } else if (block.type === 'tool_use') {
                        console.log(tag, `tool_use: ${block.name} input=${JSON.stringify(block.input).slice(0, 200)}`);
                    } else if (block.type === 'tool_result') {
                        console.log(tag, `tool_result: ${JSON.stringify(block).slice(0, 200)}`);
                    } else {
                        console.log(tag, `${block.type}: ${JSON.stringify(block).slice(0, 200)}`);
                    }
                }
            }
        } else if (msg.type === 'result') {
            console.log(tag, `subtype=${msg.subtype} error=${msg.is_error} result=${(msg.result || '').slice(0, 200)}`);
        } else if (msg.type === 'user' && msg.message) {
            const content = msg.message.content;
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (block.type === 'tool_result') {
                        const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                        const preview = text && text.length > 200 ? text.slice(0, 200) + '...' : text;
                        console.log(tag, `tool_result: error=${block.is_error} ${preview}`);
                    }
                }
            }
        } else {
            console.log(tag, JSON.stringify(msg).slice(0, 300));
        }
    }
}

// ─── Auto-approval strategy ─────────────────────────────────────────

/** 只读工具，始终自动批准 */
const SAFE_TOOLS = new Set([
    'Read', 'read',
    'Glob', 'glob',
    'Grep', 'grep',
    'Task', 'task',
    'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
    'WebSearch', 'WebFetch',
    'EnterPlanMode', 'ExitPlanMode',
    'mcp__ide__getDiagnostics',
    // 'mcp__ide__executeCode',
]);

/** Bash 命令中的危险前缀 */
const DANGEROUS_BASH_PATTERNS = [
    /^\s*rm\s/,
    /^\s*rm\s+-/,
    /^\s*sudo\s/,
    /^\s*chmod\s/,
    /^\s*chown\s/,
    /^\s*mkfs/,
    /^\s*dd\s/,
    /^\s*shutdown/,
    /^\s*reboot/,
    /^\s*kill\s/,
    /^\s*killall\s/,
    /^\s*pkill\s/,
    /^\s*mv\s.*\/\s*$/,
    />\s*\/dev\//,
    /\|\s*sh\b/,
    /\|\s*bash\b/,
    /curl.*\|\s*(sh|bash)\b/,
    /wget.*\|\s*(sh|bash)\b/,
    /git\s+push\s+.*--force/,
    /git\s+reset\s+--hard/,
    /npm\s+publish/,
    /yarn\s+publish/,
];

/**
 * 判断工具调用是否可以自动批准。
 * 空 input 一律不自动批准，防止死循环。
 */
function shouldAutoApprove(toolName: string, input: unknown): boolean {
    if (!input || (typeof input === 'object' && Object.keys(input as object).length === 0)) {
        return false;
    }

    if (SAFE_TOOLS.has(toolName)) return true;

    if (toolName === 'Bash' || toolName === 'bash') {
        const obj = input as Record<string, unknown> | null;
        const command = (obj?.command as string) || '';
        if (!command.trim()) return false;
        for (const pattern of DANGEROUS_BASH_PATTERNS) {
            if (pattern.test(command)) return false;
        }
        return true;
    }

    return false;
}

// ─── Session listing ────────────────────────────────────────────────

export interface SessionInfo {
    sessionId: string;
    modifiedAt: Date;
    preview: string;
}

/**
 * 列出指定工作目录下的 Claude 历史 session。
 * 扫描 ~/.claude/projects/<project-hash>/*.jsonl，
 * 读取第一条 user 消息作为预览。
 */
export function listSessions(cwd: string, limit = 10): SessionInfo[] {
    const projectDir = cwd.replace(/[/_]/g, '-');
    const sessionsPath = join(homedir(), '.claude', 'projects', projectDir);

    let files: string[];
    try {
        files = readdirSync(sessionsPath).filter(f => f.endsWith('.jsonl'));
    } catch {
        return [];
    }

    const sessions: SessionInfo[] = [];
    for (const file of files) {
        const fullPath = join(sessionsPath, file);
        const sessionId = file.replace('.jsonl', '');
        let modifiedAt: Date;
        try {
            modifiedAt = statSync(fullPath).mtime;
        } catch {
            continue;
        }

        // 读取前 8KB 提取第一条 user 消息作为预览
        let preview = '';
        try {
            const fd = openSync(fullPath, 'r');
            const readBuf = Buffer.alloc(8192);
            const bytesRead = readSync(fd, readBuf);
            closeSync(fd);

            const lines = readBuf.subarray(0, bytesRead).toString('utf-8').split('\n');
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const obj = JSON.parse(line);
                    if (obj.type === 'user' && obj.message?.content) {
                        const c = obj.message.content;
                        if (typeof c === 'string') {
                            preview = c.slice(0, 80);
                        } else if (Array.isArray(c)) {
                            for (const b of c) {
                                if (b.type === 'text' && b.text) {
                                    preview = b.text.slice(0, 80);
                                    break;
                                }
                            }
                        }
                        break;
                    }
                } catch {
                    // skip malformed line
                }
            }
        } catch {
            // ignore read errors
        }

        sessions.push({ sessionId, modifiedAt, preview });
    }

    sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
    return sessions.slice(0, limit);
}
