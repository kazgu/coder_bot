/**
 * CodexProcess — 通过 MCP 协议管理 Codex CLI 子进程。
 * 实现 AgentProcess 接口，与 ClaudeProcess 可互换使用。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { execSync } from 'node:child_process';
import type { CodexConfig } from './config';
import type { AgentProcess, AgentMessage, PendingPermission, ContentBlock } from './agent';

// ─── Types ───────────────────────────────────────────────────────────

interface CodexSessionConfig {
    prompt: string;
    'approval-policy'?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    model?: string;
    cwd?: string;
}

// ─── Codex version detection ─────────────────────────────────────────

function getCodexMcpSubcommand(executable: string): string {
    try {
        const version = execSync(`${executable} --version`, { encoding: 'utf8' }).trim();
        const match = version.match(/codex-cli\s+(\d+\.\d+\.\d+(?:-alpha\.\d+)?)/);
        if (!match) return 'mcp-server'; // default to newer

        const versionStr = match[1];
        const [major, minor, patch] = versionStr.split(/[-.]/).map(Number);

        if (major > 0 || minor > 43) return 'mcp-server';
        if (minor === 43 && patch === 0) {
            if (versionStr.includes('-alpha.')) {
                const alphaNum = parseInt(versionStr.split('-alpha.')[1]);
                return alphaNum >= 5 ? 'mcp-server' : 'mcp';
            }
            return 'mcp-server';
        }
        return 'mcp';
    } catch {
        return 'mcp-server';
    }
}

// ─── Permission resolution helpers ──────────────────────────────────

function resolveApprovalPolicy(permissionMode: string): 'untrusted' | 'on-failure' | 'on-request' | 'never' {
    switch (permissionMode) {
        case 'default': return 'untrusted';
        case 'read-only': return 'never';
        case 'safe-yolo': return 'on-failure';
        case 'yolo': return 'on-failure';
        case 'bypassPermissions': return 'on-failure';
        case 'acceptEdits': return 'on-request';
        case 'plan': return 'untrusted';
        default: return 'untrusted';
    }
}

function resolveSandboxMode(permissionMode: string): 'read-only' | 'workspace-write' | 'danger-full-access' {
    switch (permissionMode) {
        case 'read-only': return 'read-only';
        case 'yolo': return 'danger-full-access';
        case 'bypassPermissions': return 'danger-full-access';
        default: return 'workspace-write';
    }
}

// ─── CodexProcess ───────────────────────────────────────────────────

const MCP_TIMEOUT = 14 * 24 * 60 * 60 * 1000; // 14 days

export class CodexProcess implements AgentProcess {
    readonly backend = 'codex' as const;

    private client: Client | null = null;
    private transport: StdioClientTransport | null = null;
    private connected = false;
    private alive = false;
    private sessionId: string | null = null;
    private conversationId: string | null = null;

    private readonly config: CodexConfig;
    private readonly debug: boolean;

    private onMessage: ((msg: AgentMessage) => void) | null = null;
    private onPermissionRequest: ((perm: PendingPermission) => void) | null = null;
    private onLoopDetected: (() => void) | null = null;

    private readonly pendingPermissions = new Map<string, PendingPermission & { resolve: (decision: 'approved' | 'denied') => void }>();

    /** 临时全部自动批准 */
    private autoApproveAll = false;

    /** 当前 turn 的 AbortController */
    private turnAbortController: AbortController | null = null;

    constructor(config: CodexConfig) {
        this.config = config;
        this.debug = config.debug;
    }

    // ─── AgentProcess implementation ────────────────────────────────

    start(
        onMessage: (msg: AgentMessage) => void,
        onPermissionRequest?: (perm: PendingPermission) => void,
        onLoopDetected?: () => void,
        _options?: { continue?: boolean; resume?: string },
    ): void {
        if (this.alive) return;

        this.onMessage = onMessage;
        this.onPermissionRequest = onPermissionRequest ?? null;
        this.onLoopDetected = onLoopDetected ?? null;
        this.alive = true;

        // 异步连接，不阻塞 start()
        this.connectAsync().catch((err) => {
            console.error('[codex] Failed to connect:', err.message);
            this.alive = false;
            this.onMessage?.({ type: 'error', text: `Codex 连接失败: ${err.message}`, isError: true });
        });
    }

    send(content: string | ContentBlock[]): void {
        if (!this.alive) {
            throw new Error('Codex process not running');
        }

        // 提取文本
        let text: string;
        if (typeof content === 'string') {
            text = content;
        } else {
            // Codex MCP 不支持图片，只提取文本
            const textParts = content.filter((b): b is { type: 'text'; text: string } => b.type === 'text');
            text = textParts.map(b => b.text).join('\n');
            if (!text) {
                this.onMessage?.({ type: 'error', text: 'Codex 不支持图片消息，请发送文本。', isError: true });
                return;
            }
        }

        // 异步发送
        this.sendAsync(text).catch((err) => {
            console.error('[codex] Send error:', err.message);
            this.onMessage?.({ type: 'error', text: `发送失败: ${err.message}`, isError: true });
        });
    }

    approvePermission(requestId: string, _updatedInput?: Record<string, unknown>): boolean {
        const perm = this.pendingPermissions.get(requestId);
        if (!perm) return false;

        perm.resolve('approved');
        this.pendingPermissions.delete(requestId);
        return true;
    }

    denyPermission(requestId: string, _reason?: string): boolean {
        const perm = this.pendingPermissions.get(requestId);
        if (!perm) return false;

        perm.resolve('denied');
        this.pendingPermissions.delete(requestId);
        return true;
    }

    approveAll(): number {
        this.autoApproveAll = true;
        let count = 0;
        for (const requestId of [...this.pendingPermissions.keys()]) {
            if (this.approvePermission(requestId)) count++;
        }
        return count;
    }

    denyAll(reason?: string): number {
        let count = 0;
        for (const requestId of [...this.pendingPermissions.keys()]) {
            if (this.denyPermission(requestId, reason)) count++;
        }
        return count;
    }

    getPendingPermissions(): PendingPermission[] {
        return [...this.pendingPermissions.values()].map(({ resolve: _, ...rest }) => rest);
    }

    isAlive(): boolean {
        return this.alive;
    }

    getSessionId(): string | null {
        return this.sessionId;
    }

    kill(): void {
        this.alive = false;
        this.turnAbortController?.abort();
        this.pendingPermissions.clear();

        // 异步断开
        this.disconnectAsync().catch((err) => {
            console.error('[codex] Disconnect error:', err.message);
        });
    }

    // ─── Internal async methods ─────────────────────────────────────

    private async connectAsync(): Promise<void> {
        const mcpSubcommand = getCodexMcpSubcommand(this.config.executable);

        if (this.debug) {
            console.log(`[codex] Connecting via: ${this.config.executable} ${mcpSubcommand}`);
        }

        this.client = new Client(
            { name: 'coder-bot-codex', version: '1.0.0' },
            { capabilities: { elicitation: {} } },
        );

        // 注册事件通知处理
        this.client.setNotificationHandler(
            z.object({
                method: z.literal('codex/event'),
                params: z.object({ msg: z.any() }),
            }).passthrough(),
            (data) => {
                const event = data.params.msg;
                this.updateIdentifiers(event);
                this.handleCodexEvent(event);
            },
        );

        // 注册权限审批处理（ElicitRequest）
        // Codex 使用自定义的 { decision: 'accepted' | 'denied' } 格式，
        // 而非 MCP 标准的 { action: 'accept' | 'decline' }
        this.client.setRequestHandler(
            ElicitRequestSchema,
            async (request) => {
                return this.handleElicitRequest(request.params as unknown as {
                    message: string;
                    codex_call_id: string;
                    codex_command?: string[];
                    codex_cwd?: string;
                }) as any;
            },
        );

        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
            if (typeof v === 'string') env[k] = v;
        }

        this.transport = new StdioClientTransport({
            command: this.config.executable,
            args: [mcpSubcommand],
            env,
        });

        await this.client.connect(this.transport);
        this.connected = true;

        if (this.debug) {
            console.log('[codex] Connected');
        }
    }

    private async sendAsync(text: string): Promise<void> {
        if (!this.client || !this.connected) {
            throw new Error('Not connected');
        }

        this.turnAbortController = new AbortController();
        const signal = this.turnAbortController.signal;

        try {
            if (!this.sessionId) {
                // 首次消息 → startSession
                const config: CodexSessionConfig = {
                    prompt: text,
                    'approval-policy': resolveApprovalPolicy(this.config.permissionMode),
                    sandbox: resolveSandboxMode(this.config.permissionMode),
                    cwd: this.config.cwd,
                };

                if (this.config.model) {
                    config.model = this.config.model;
                }

                if (this.debug) {
                    console.log('[codex →] startSession:', JSON.stringify(config));
                }

                const response = await this.client.callTool(
                    { name: 'codex', arguments: config as unknown as Record<string, unknown> },
                    undefined,
                    { signal, timeout: MCP_TIMEOUT },
                );

                this.extractIdentifiers(response);

                if (this.debug) {
                    console.log('[codex ←] startSession response:', JSON.stringify(response).slice(0, 300));
                }
            } else {
                // 后续消息 → continueSession
                const args = {
                    sessionId: this.sessionId,
                    conversationId: this.conversationId || this.sessionId,
                    prompt: text,
                };

                if (this.debug) {
                    console.log('[codex →] continueSession:', JSON.stringify(args));
                }

                const response = await this.client.callTool(
                    { name: 'codex-reply', arguments: args },
                    undefined,
                    { signal, timeout: MCP_TIMEOUT },
                );

                this.extractIdentifiers(response);

                if (this.debug) {
                    console.log('[codex ←] continueSession response:', JSON.stringify(response).slice(0, 300));
                }
            }

            // Turn 结束，重置自动批准
            this.autoApproveAll = false;
            this.onMessage?.({ type: 'result', text: undefined, isError: false });
        } catch (err) {
            if (signal.aborted) return; // 用户主动 kill
            throw err;
        } finally {
            this.turnAbortController = null;
        }
    }

    private async disconnectAsync(): Promise<void> {
        if (!this.connected) return;

        const pid = this.transport?.pid ?? null;

        try {
            await this.client?.close();
        } catch {
            try { await this.transport?.close?.(); } catch { /* ignore */ }
        }

        // 确保子进程退出
        if (pid) {
            try {
                process.kill(pid, 0);
                try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
            } catch { /* not running */ }
        }

        this.transport = null;
        this.connected = false;
        console.log('[codex] Disconnected');
    }

    // ─── Event handling ─────────────────────────────────────────────

    private handleCodexEvent(event: Record<string, unknown>): void {
        if (!event || typeof event !== 'object') return;

        const type = event.type as string;

        if (this.debug) {
            console.log(`[codex ←][${type}]`, JSON.stringify(event).slice(0, 300));
        }

        switch (type) {
            case 'agent_message': {
                const text = (event.content as string) || (event.message as string) || '';
                if (text) {
                    this.onMessage?.({ type: 'text', text, raw: event });
                }
                break;
            }

            case 'agent_reasoning':
            case 'agent_reasoning_delta': {
                // 推理过程，可选展示
                break;
            }

            case 'exec_command_begin': {
                const command = event.command as string[] | string | undefined;
                const cmdStr = Array.isArray(command) ? command.join(' ') : (command || 'unknown');
                this.onMessage?.({ type: 'tool_use', toolName: `Bash: ${cmdStr}`, raw: event });
                break;
            }

            case 'exec_command_end': {
                // 命令执行完成
                break;
            }

            case 'patch_apply_begin': {
                const path = (event.path as string) || (event.file as string) || '';
                this.onMessage?.({ type: 'tool_use', toolName: `Edit: ${path}`, raw: event });
                break;
            }

            case 'patch_apply_end': {
                break;
            }

            case 'task_started': {
                this.onMessage?.({ type: 'system', text: 'Codex 开始处理...', raw: event });
                break;
            }

            case 'task_complete': {
                this.autoApproveAll = false;
                break;
            }

            case 'turn_aborted': {
                this.autoApproveAll = false;
                this.onMessage?.({ type: 'error', text: 'Codex 任务被中断', isError: true, raw: event });
                break;
            }

            default:
                break;
        }
    }

    private async handleElicitRequest(params: {
        message: string;
        codex_call_id: string;
        codex_command?: string[];
        codex_cwd?: string;
    }): Promise<unknown> {
        const requestId = params.codex_call_id;
        const command = params.codex_command;
        const cmdStr = Array.isArray(command) ? command.join(' ') : (params.message || 'unknown');

        if (this.debug) {
            console.log(`[codex] Permission request: ${cmdStr}`);
        }

        // 自动批准模式
        if (this.autoApproveAll) {
            if (this.debug) console.log(`[codex auto-approve-all] ${cmdStr}`);
            return { action: 'accept', decision: 'approved' };
        }

        // 挂起等待用户审批
        return new Promise<unknown>((resolve) => {
            const perm = {
                requestId,
                toolName: 'CodexBash',
                input: { command: cmdStr, cwd: params.codex_cwd },
                createdAt: Date.now(),
                resolve: (decision: 'approved' | 'denied') => resolve({
                    action: decision === 'approved' ? 'accept' : 'decline',
                    decision,
                }),
            };

            this.pendingPermissions.set(requestId, perm);
            this.onPermissionRequest?.(perm);
        });
    }

    // ─── Identifier extraction ──────────────────────────────────────

    private updateIdentifiers(event: unknown): void {
        if (!event || typeof event !== 'object') return;
        const obj = event as Record<string, unknown>;

        const candidates = [obj];
        if (obj.data && typeof obj.data === 'object') {
            candidates.push(obj.data as Record<string, unknown>);
        }

        for (const c of candidates) {
            const sid = (c.session_id ?? c.sessionId) as string | undefined;
            if (sid) this.sessionId = sid;

            const cid = (c.conversation_id ?? c.conversationId) as string | undefined;
            if (cid) this.conversationId = cid;
        }
    }

    private extractIdentifiers(response: unknown): void {
        if (!response || typeof response !== 'object') return;
        const obj = response as Record<string, unknown>;

        const meta = (obj.meta || {}) as Record<string, unknown>;
        if (meta.sessionId) this.sessionId = meta.sessionId as string;
        else if (obj.sessionId) this.sessionId = obj.sessionId as string;

        if (meta.conversationId) this.conversationId = meta.conversationId as string;
        else if (obj.conversationId) this.conversationId = obj.conversationId as string;

        const content = obj.content;
        if (Array.isArray(content)) {
            for (const item of content) {
                if (!this.sessionId && item?.sessionId) this.sessionId = item.sessionId;
                if (!this.conversationId && item?.conversationId) this.conversationId = item.conversationId;
            }
        }
    }
}
