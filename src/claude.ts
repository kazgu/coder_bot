import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ClaudeConfig } from './config';

/** Claude 进程输出的 JSON 消息 */
export interface ClaudeMessage {
    type: string;
    subtype?: string;
    message?: {
        role: string;
        content: string | Array<{ type: string; text?: string; name?: string; input?: unknown; [key: string]: unknown }>;
    };
    result?: string;
    session_id?: string;
    is_error?: boolean;
    /** control_request 字段 */
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

/** 权限审批结果 */
interface PermissionResponse {
    type: 'control_response';
    response: {
        request_id: string;
        subtype: 'success';
        response: {
            behavior: 'allow';
            updatedInput: Record<string, unknown>;
        } | {
            behavior: 'deny';
            message: string;
        };
    };
}

/**
 * 管理一个 Claude Code 子进程，支持多轮对话和权限审批。
 * 使用 --input-format stream-json 通过 stdin 持续发送消息，
 * 从 stdout 读取 stream-json 响应。
 *
 * 当 Claude 需要工具权限时，会输出 control_request 消息，
 * 通过 onPermissionRequest 回调通知调用方，调用方可以通过
 * approvePermission / denyPermission 来响应。
 */
export class ClaudeProcess {
    private child: ChildProcessWithoutNullStreams | null = null;
    private readonly config: ClaudeConfig;
    private onMessage: ((msg: ClaudeMessage) => void) | null = null;
    private onPermissionRequest: ((perm: PendingPermission) => void) | null = null;
    private sessionId: string | null = null;
    private alive = false;
    private readonly pendingPermissions = new Map<string, PendingPermission>();
    private readonly debug: boolean;

    constructor(config: ClaudeConfig) {
        this.config = config;
        this.debug = config.debug;
    }

    /** 启动 Claude 进程 */
    start(
        onMessage: (msg: ClaudeMessage) => void,
        onPermissionRequest?: (perm: PendingPermission) => void,
    ): void {
        if (this.alive) return;

        this.onMessage = onMessage;
        this.onPermissionRequest = onPermissionRequest ?? null;

        const args = [
            '--input-format', 'stream-json',
            '--output-format', 'stream-json',
            '--verbose',
            '--permission-mode', this.config.permissionMode,
            '--permission-prompt-tool', 'stdio',
        ];

        this.child = spawn(this.config.executable, args, {
            cwd: this.config.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        }) as ChildProcessWithoutNullStreams;

        this.alive = true;

        const rl = createInterface({ input: this.child.stdout });

        rl.on('line', (line) => {
            if (!line.trim()) return;
            try {
                const msg = JSON.parse(line) as ClaudeMessage;

                // 调试模式：打印所有原始消息
                if (this.debug) {
                    this.logDebug(msg);
                }

                if (msg.type === 'system' && msg.session_id) {
                    this.sessionId = msg.session_id;
                }

                // 拦截权限请求
                if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool') {
                    const perm: PendingPermission = {
                        requestId: msg.request_id!,
                        toolName: msg.request.tool_name || 'unknown',
                        input: msg.request.input,
                        createdAt: Date.now(),
                    };

                    // 自动审批安全工具，危险操作才拦截
                    if (shouldAutoApprove(perm.toolName, perm.input)) {
                        if (this.debug) {
                            console.log(`[auto-approve] ${perm.toolName}`);
                        }
                        this.sendAllow(perm.requestId, perm.input);
                    } else {
                        this.pendingPermissions.set(perm.requestId, perm);
                        this.onPermissionRequest?.(perm);
                    }
                    return;
                }

                // Claude 取消了权限请求（比如超时）
                if (msg.type === 'control_cancel_request' && msg.request_id) {
                    this.pendingPermissions.delete(msg.request_id);
                    return;
                }

                this.onMessage?.(msg);
            } catch {
                // 忽略非 JSON 行
            }
        });

        this.child.stderr.on('data', (data) => {
            console.error('[claude stderr]', data.toString().trim());
        });

        this.child.on('close', (code) => {
            this.alive = false;
            this.pendingPermissions.clear();
            console.log(`[claude] Process exited with code ${code}`);
        });

        this.child.on('error', (err) => {
            this.alive = false;
            console.error('[claude] Process error:', err.message);
        });
    }

    /** 发送用户消息 */
    send(text: string): void {
        if (!this.child || !this.alive) {
            throw new Error('Claude process not running');
        }

        const input = {
            type: 'user',
            message: {
                role: 'user',
                content: text,
            },
        };

        if (this.debug) {
            console.log('[claude →]', JSON.stringify(input));
        }
        this.child.stdin.write(JSON.stringify(input) + '\n');
    }

    /** 批准权限请求 */
    approvePermission(requestId: string): boolean {
        const perm = this.pendingPermissions.get(requestId);
        if (!perm || !this.child || !this.alive) return false;

        const response: PermissionResponse = {
            type: 'control_response',
            response: {
                request_id: requestId,
                subtype: 'success',
                response: {
                    behavior: 'allow',
                    updatedInput: (perm.input as Record<string, unknown>) || {},
                },
            },
        };

        if (this.debug) {
            console.log('[claude →]', JSON.stringify(response));
        }
        this.child.stdin.write(JSON.stringify(response) + '\n');
        this.pendingPermissions.delete(requestId);
        return true;
    }

    /** 拒绝权限请求 */
    denyPermission(requestId: string, reason?: string): boolean {
        const perm = this.pendingPermissions.get(requestId);
        if (!perm || !this.child || !this.alive) return false;

        const response: PermissionResponse = {
            type: 'control_response',
            response: {
                request_id: requestId,
                subtype: 'success',
                response: {
                    behavior: 'deny',
                    message: reason || '用户拒绝了此操作',
                },
            },
        };

        if (this.debug) {
            console.log('[claude →]', JSON.stringify(response));
        }
        this.child.stdin.write(JSON.stringify(response) + '\n');
        this.pendingPermissions.delete(requestId);
        return true;
    }

    /** 批准所有待处理的权限请求 */
    approveAll(): number {
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
    }

    /** 发送 allow 响应到 Claude stdin */
    private sendAllow(requestId: string, input: unknown): void {
        if (!this.child || !this.alive) return;

        const response: PermissionResponse = {
            type: 'control_response',
            response: {
                request_id: requestId,
                subtype: 'success',
                response: {
                    behavior: 'allow',
                    updatedInput: (input as Record<string, unknown>) || {},
                },
            },
        };

        if (this.debug) {
            console.log('[claude →]', JSON.stringify(response));
        }
        this.child.stdin.write(JSON.stringify(response) + '\n');
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
        } else if (msg.type === 'control_request') {
            console.log(tag, `id=${msg.request_id} subtype=${msg.request?.subtype} tool=${msg.request?.tool_name}`);
        } else if (msg.type === 'control_cancel_request') {
            console.log(tag, `cancel id=${msg.request_id}`);
        } else {
            console.log(tag, JSON.stringify(msg).slice(0, 300));
        }
    }
}

// --- 自动审批策略 ---

/** 只读工具，始终自动批准 */
const SAFE_TOOLS = new Set([
    'Read', 'read',
    'Glob', 'glob',
    'Grep', 'grep',
    'Task', 'task',
    'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
    'WebSearch', 'WebFetch',
    'AskUserQuestion',
    'EnterPlanMode', 'ExitPlanMode',
    'mcp__ide__getDiagnostics',
]);

/** 文件写入工具，自动批准（等同 acceptEdits） */
const EDIT_TOOLS = new Set([
    'Write', 'write',
    'Edit', 'edit',
    'NotebookEdit',
    'MultiEdit',
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
    /^\s*mv\s.*\/\s*$/,       // mv 到根目录
    />\s*\/dev\//,             // 写入设备
    /\|\s*sh\b/,              // 管道到 sh
    /\|\s*bash\b/,            // 管道到 bash
    /curl.*\|\s*(sh|bash)\b/, // curl | sh
    /wget.*\|\s*(sh|bash)\b/, // wget | sh
    /git\s+push\s+.*--force/, // force push
    /git\s+reset\s+--hard/,   // hard reset
    /npm\s+publish/,
    /yarn\s+publish/,
];

/**
 * 判断工具调用是否可以自动批准。
 * 只读工具和文件编辑自动通过，Bash 根据命令内容判断。
 */
function shouldAutoApprove(toolName: string, input: unknown): boolean {
    if (SAFE_TOOLS.has(toolName)) return true;
    if (EDIT_TOOLS.has(toolName)) return true;

    if (toolName === 'Bash' || toolName === 'bash') {
        const obj = input as Record<string, unknown> | null;
        const command = (obj?.command as string) || '';

        // 空命令不批准
        if (!command.trim()) return false;

        // 检查危险模式
        for (const pattern of DANGEROUS_BASH_PATTERNS) {
            if (pattern.test(command)) return false;
        }

        // 非危险 Bash 命令自动批准
        return true;
    }

    // 未知工具 → 拦截
    return false;
}
