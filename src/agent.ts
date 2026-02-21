/**
 * 通用 Agent 进程接口。
 * ClaudeProcess 和 CodexProcess 都实现此接口，
 * 让 Bridge 可以多态地管理不同后端。
 */

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

/** Agent 输出消息（统一格式） */
export interface AgentMessage {
    type: 'text' | 'tool_use' | 'result' | 'error' | 'system';
    text?: string;
    toolName?: string;
    isError?: boolean;
    sessionId?: string;
    raw?: unknown;
}

export type AgentBackend = 'claude' | 'codex';

export interface AgentProcess {
    readonly backend: AgentBackend;

    start(
        onMessage: (msg: AgentMessage) => void,
        onPermissionRequest?: (perm: PendingPermission) => void,
        onLoopDetected?: () => void,
        options?: { continue?: boolean; resume?: string },
    ): void;

    send(content: string | ContentBlock[]): void;

    approvePermission(requestId: string, updatedInput?: Record<string, unknown>): boolean;
    denyPermission(requestId: string, reason?: string): boolean;
    approveAll(): number;
    denyAll(reason?: string): number;
    getPendingPermissions(): PendingPermission[];

    isAlive(): boolean;
    getSessionId(): string | null;
    kill(): void;
}
