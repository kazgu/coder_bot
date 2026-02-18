import type { ClaudeConfig } from './config';
import type { FeishuClient } from './feishu/client';
import { ClaudeProcess, listSessions, type ClaudeMessage, type PendingPermission, type ContentBlock, type SessionInfo } from './claude';

interface ChatSession {
    claude: ClaudeProcess;
    chatId: string;
    cwd: string;
    /** debounce 缓冲区 */
    textBuffer: string[];
    flushTimer: ReturnType<typeof setTimeout> | null;
    /** 等待用户回答 AskUserQuestion 的请求 */
    pendingQuestion: {
        requestId: string;
        questions: Array<{
            question: string;
            header?: string;
            options?: Array<{ label: string; description?: string }>;
            multiSelect?: boolean;
        }>;
        originalInput: Record<string, unknown>;
    } | null;
    /** 等待用户选择要恢复的 session */
    pendingResume: SessionInfo[] | null;
}

const DEBOUNCE_MS = 1500;

/**
 * 桥接飞书聊天和 Claude Code 进程。
 * 每个飞书 chat 对应一个独立的 Claude 进程。
 * 支持权限审批：Claude 请求工具权限时推送飞书通知，
 * 用户通过 /allow 和 /deny 命令响应。
 */
export class Bridge {
    private readonly claudeConfig: ClaudeConfig;
    private readonly feishu: FeishuClient;
    private readonly sessions = new Map<string, ChatSession>();

    constructor(claudeConfig: ClaudeConfig, feishu: FeishuClient) {
        this.claudeConfig = claudeConfig;
        this.feishu = feishu;
    }

    /** 处理飞书消息 */
    async handleMessage(chatId: string, messageId: string, text: string): Promise<void> {
        // 处理命令
        if (text.startsWith('/')) {
            const reply = await this.handleCommand(chatId, text);
            if (reply) {
                await this.feishu.replyText(messageId, reply);
                return;
            }
        }

        // 获取或创建 Claude 会话
        let session = this.sessions.get(chatId);
        if (!session || !session.claude.isAlive()) {
            session = this.createSession(chatId);
            this.sessions.set(chatId, session);

            const welcome = [
                '🤖 Coder Bot 已就绪',
                `📂 工作目录: ${session.cwd}`,
                '',
                '发送 /help 查看可用命令',
            ].join('\n');
            void this.feishu.sendText(chatId, welcome);
        }

        // 如果有待回答的问题，将用户消息作为答案
        if (session.pendingQuestion && !text.startsWith('/')) {
            this.resolveQuestion(session, text);
            return;
        }

        // 如果有待选择的 resume session，将用户消息作为选择
        if (session.pendingResume && !text.startsWith('/')) {
            await this.resolveResume(session, chatId, text);
            return;
        }

        try {
            session.claude.send(text);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await this.feishu.replyText(messageId, `发送失败: ${msg}`);
        }
    }

    /** 处理飞书图片消息 */
    async handleImageMessage(chatId: string, messageId: string, imageKey: string, text?: string): Promise<void> {
        let session = this.sessions.get(chatId);
        if (!session || !session.claude.isAlive()) {
            session = this.createSession(chatId);
            this.sessions.set(chatId, session);

            const welcome = [
                '🤖 Coder Bot 已就绪',
                `📂 工作目录: ${session.cwd}`,
                '',
                '发送 /help 查看可用命令',
            ].join('\n');
            void this.feishu.sendText(chatId, welcome);
        }

        try {
            const base64 = await this.feishu.downloadImage(messageId, imageKey);
            const blocks: ContentBlock[] = [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
            ];
            if (text) {
                blocks.push({ type: 'text', text });
            }
            session.claude.send(blocks);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await this.feishu.replyText(messageId, `图片处理失败: ${msg}`);
        }
    }

    /** 创建新的 Claude 会话 */
    private createSession(chatId: string, options?: { cwd?: string; continue?: boolean; resume?: string }): ChatSession {
        // 关闭旧会话
        const old = this.sessions.get(chatId);
        if (old) {
            this.flushText(old);
            old.claude.kill();
        }

        const sessionCwd = options?.cwd || old?.cwd || this.claudeConfig.cwd;
        const config = { ...this.claudeConfig, cwd: sessionCwd };
        const claude = new ClaudeProcess(config);
        const session: ChatSession = {
            claude,
            chatId,
            cwd: sessionCwd,
            textBuffer: [],
            flushTimer: null,
            pendingQuestion: null,
            pendingResume: null,
        };

        const startOpts: { continue?: boolean; resume?: string } = {};
        if (options?.continue) startOpts.continue = true;
        if (options?.resume) startOpts.resume = options.resume;

        claude.start(
            (msg) => this.handleClaudeMessage(session, msg),
            (perm) => this.handlePermissionRequest(session, perm),
            () => {
                void this.feishu.sendText(session.chatId, '⚠️ 检测到工具调用死循环，已自动中断。发 /new 重建会话。');
            },
            Object.keys(startOpts).length > 0 ? startOpts : undefined,
        );

        return session;
    }

    /** 处理 Claude 输出消息 */
    private handleClaudeMessage(session: ChatSession, msg: ClaudeMessage): void {
        if (msg.type === 'assistant' && msg.message) {
            const content = msg.message.content;
            if (typeof content === 'string') {
                this.appendText(session, content);
            } else if (Array.isArray(content)) {
                for (const block of content) {
                    if (block.type === 'text' && block.text) {
                        this.appendText(session, block.text);
                    } else if (block.type === 'tool_use') {
                        this.flushText(session);
                        const name = block.name || 'unknown';
                        void this.feishu.sendText(session.chatId, `🔧 ${name}`);
                    }
                }
            }
        } else if (msg.type === 'result') {
            this.flushText(session);
            if (msg.is_error) {
                void this.feishu.sendText(session.chatId, `❌ ${msg.result || '执行出错'}`);
            }
        }
    }

    /** 处理权限请求 — 推送飞书通知 */
    private handlePermissionRequest(session: ChatSession, perm: PendingPermission): void {
        this.flushText(session);

        // AskUserQuestion 特殊处理：展示问题，等待用户回答
        if (perm.toolName === 'AskUserQuestion') {
            this.handleAskUserQuestion(session, perm);
            return;
        }

        const inputStr = formatPermissionInput(perm.toolName, perm.input);
        const text = [
            `⚠️ Claude 请求权限`,
            `工具: ${perm.toolName}`,
            inputStr,
            '',
            '回复 /allow 批准 · /deny 拒绝',
        ].join('\n');

        void this.feishu.sendText(session.chatId, text);
    }

    /** 处理 AskUserQuestion — 展示问题并等待用户回答 */
    private handleAskUserQuestion(session: ChatSession, perm: PendingPermission): void {
        const input = perm.input as Record<string, unknown>;
        const questions = (input?.questions || []) as NonNullable<ChatSession['pendingQuestion']>['questions'];

        if (questions.length === 0) {
            // 没有问题内容，直接批准
            session.claude.approvePermission(perm.requestId);
            return;
        }

        // 保存待回答状态
        session.pendingQuestion = {
            requestId: perm.requestId,
            questions,
            originalInput: input,
        };

        // 格式化问题发送到飞书
        const lines: string[] = ['❓ Claude 想问你:'];
        for (let i = 0; i < questions.length; i++) {
            const q = questions[i];
            lines.push('');
            lines.push(q.question);
            if (q.options && q.options.length > 0) {
                for (let j = 0; j < q.options.length; j++) {
                    const opt = q.options[j];
                    const desc = opt.description ? ` — ${opt.description}` : '';
                    lines.push(`  ${j + 1}. ${opt.label}${desc}`);
                }
                lines.push('');
                lines.push(q.multiSelect ? '可多选，用逗号分隔序号（如 1,3）' : '回复序号或直接输入你的答案');
            } else {
                lines.push('');
                lines.push('直接回复你的答案');
            }
        }

        void this.feishu.sendText(session.chatId, lines.join('\n'));
    }

    /** 将用户回复解析为 AskUserQuestion 的答案并批准 */
    private resolveQuestion(session: ChatSession, userText: string): void {
        const pq = session.pendingQuestion!;
        session.pendingQuestion = null;

        const answers: Record<string, string> = {};
        // 简单策略：如果只有一个问题，整条消息就是答案
        // 多个问题时按行分割
        const parts = pq.questions.length === 1
            ? [userText.trim()]
            : userText.split('\n').map(s => s.trim()).filter(Boolean);

        for (let i = 0; i < pq.questions.length; i++) {
            const raw = (parts[i] || parts[0] || '').trim();
            const q = pq.questions[i];

            if (q.options && q.options.length > 0) {
                // 尝试按序号匹配
                if (q.multiSelect) {
                    const indices = raw.split(/[,，\s]+/).map(s => parseInt(s, 10) - 1);
                    const labels = indices
                        .filter(idx => idx >= 0 && idx < q.options!.length)
                        .map(idx => q.options![idx].label);
                    answers[String(i)] = labels.length > 0 ? labels.join(',') : raw;
                } else {
                    const idx = parseInt(raw, 10) - 1;
                    if (idx >= 0 && idx < q.options.length) {
                        answers[String(i)] = q.options[idx].label;
                    } else {
                        answers[String(i)] = raw;
                    }
                }
            } else {
                answers[String(i)] = raw;
            }
        }

        const updatedInput = { ...pq.originalInput, answers };
        session.claude.approvePermission(pq.requestId, updatedInput);
    }

    /** 处理 /resume 命令 — 列出历史 session 或直接恢复指定 ID */
    private handleResume(chatId: string, sessionIdArg?: string): string {
        const session = this.sessions.get(chatId);
        const cwd = session?.cwd || this.claudeConfig.cwd;

        // 直接指定 session ID
        if (sessionIdArg) {
            const newSession = this.createSession(chatId, { resume: sessionIdArg });
            this.sessions.set(chatId, newSession);
            return `正在恢复 session ${sessionIdArg.slice(0, 8)}...\n工作目录: ${newSession.cwd}`;
        }

        // 列出可选 session
        const sessions = listSessions(cwd);
        if (sessions.length === 0) {
            return '没有找到历史 session。';
        }

        // 确保有一个 session 对象来存 pendingResume
        if (!session || !session.claude.isAlive()) {
            const newSession = this.createSession(chatId);
            this.sessions.set(chatId, newSession);
            newSession.pendingResume = sessions;
        } else {
            session.pendingResume = sessions;
        }

        const lines = ['📋 历史 Session（回复序号选择）:', ''];
        for (let i = 0; i < sessions.length; i++) {
            const s = sessions[i];
            const date = s.modifiedAt.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
            const preview = s.preview || '(空)';
            lines.push(`${i + 1}. [${date}] ${preview}`);
        }
        lines.push('', '回复序号恢复，或发其他消息取消');
        return lines.join('\n');
    }

    /** 用户选择了要恢复的 session */
    private async resolveResume(session: ChatSession, chatId: string, text: string): Promise<void> {
        const sessions = session.pendingResume!;
        session.pendingResume = null;

        const idx = parseInt(text.trim(), 10) - 1;
        if (idx < 0 || idx >= sessions.length) {
            void this.feishu.sendText(chatId, '已取消恢复。');
            return;
        }

        const target = sessions[idx];
        const newSession = this.createSession(chatId, { resume: target.sessionId });
        this.sessions.set(chatId, newSession);
        void this.feishu.sendText(chatId, `正在恢复 session ${target.sessionId.slice(0, 8)}...\n工作目录: ${newSession.cwd}`);
    }

    /** 追加文本到 debounce 缓冲区 */
    private appendText(session: ChatSession, text: string): void {
        session.textBuffer.push(text);
        if (session.flushTimer) {
            clearTimeout(session.flushTimer);
        }
        session.flushTimer = setTimeout(() => this.flushText(session), DEBOUNCE_MS);
    }

    /** 立即发送缓冲区 */
    private flushText(session: ChatSession): void {
        if (session.flushTimer) {
            clearTimeout(session.flushTimer);
            session.flushTimer = null;
        }
        if (session.textBuffer.length === 0) return;

        const text = session.textBuffer.join('');
        session.textBuffer = [];

        if (text.trim()) {
            void this.feishu.sendText(session.chatId, text);
        }
    }

    /** 处理斜杠命令 */
    private async handleCommand(chatId: string, text: string): Promise<string | null> {
        const trimmed = text.trim();
        const parts = trimmed.split(/\s+/);
        const cmd = parts[0].toLowerCase();

        if (cmd === '/help') {
            return [
                '可用命令:',
                '/new — 重新开始一个 Claude 会话',
                '/new continue — 继续上次的 Claude 会话',
                '/resume — 列出历史 session 并选择恢复',
                '/cd <path> — 设置工作目录并重建会话',
                '/cwd — 查看当前工作目录',
                '/status — 查看当前会话状态',
                '/allow — 批准最新的权限请求',
                '/allow all — 批准所有待处理的权限请求',
                '/deny — 拒绝最新的权限请求',
                '/deny all — 拒绝所有待处理的权限请求',
                '/pending — 查看待处理的权限请求',
                '/help — 显示帮助',
                '',
                '直接发文本即可与 Claude Code 对话。',
            ].join('\n');
        }

        if (cmd === '/new') {
            const arg = parts[1]?.toLowerCase();
            const isContinue = arg === 'continue' || arg === 'c';
            const session = this.createSession(chatId, isContinue ? { continue: true } : undefined);
            this.sessions.set(chatId, session);
            return isContinue
                ? `已继续上次 Claude 会话。\n工作目录: ${session.cwd}`
                : `已创建新的 Claude 会话。\n工作目录: ${session.cwd}`;
        }

        if (cmd === '/cd') {
            const path = trimmed.slice(3).trim();
            if (!path) return '用法: /cd <path>';
            const resolved = path.startsWith('/')
                ? path
                : `${this.sessions.get(chatId)?.cwd || this.claudeConfig.cwd}/${path}`;
            const session = this.createSession(chatId, { cwd: resolved });
            this.sessions.set(chatId, session);
            return `工作目录已切换到: ${resolved}\n已重建 Claude 会话。`;
        }

        if (cmd === '/cwd') {
            const session = this.sessions.get(chatId);
            const cwd = session?.cwd || this.claudeConfig.cwd;
            return `当前工作目录: ${cwd}`;
        }

        if (cmd === '/status') {
            const session = this.sessions.get(chatId);
            if (!session) return '当前没有活跃会话。发消息即可自动创建。';
            const alive = session.claude.isAlive() ? '运行中' : '已停止';
            const sid = session.claude.getSessionId() || '(未知)';
            const pending = session.claude.getPendingPermissions();
            const pendingStr = pending.length > 0
                ? `\n待审批权限: ${pending.length} 个`
                : '';
            return `状态: ${alive}\nSession: ${sid}\n工作目录: ${session.cwd}${pendingStr}`;
        }

        if (cmd === '/allow') {
            return this.handleAllow(chatId, parts[1]);
        }

        if (cmd === '/deny') {
            return this.handleDeny(chatId, parts[1]);
        }

        if (cmd === '/pending') {
            return this.handlePending(chatId);
        }

        if (cmd === '/resume') {
            return this.handleResume(chatId, parts[1]);
        }

        return null;
    }

    /** 处理 /allow 命令 */
    private handleAllow(chatId: string, arg?: string): string {
        const session = this.sessions.get(chatId);
        if (!session || !session.claude.isAlive()) {
            return '当前没有活跃会话。';
        }

        if (arg === 'all') {
            const count = session.claude.approveAll();
            return count > 0
                ? `已批准 ${count} 个权限请求，本轮后续请求将自动批准。`
                : '已开启本轮自动批准。';
        }

        // 批准最新的一个
        const pending = session.claude.getPendingPermissions();
        if (pending.length === 0) {
            return '没有待处理的权限请求。';
        }

        const latest = pending[pending.length - 1];
        session.claude.approvePermission(latest.requestId);
        return `已批准: ${latest.toolName}`;
    }

    /** 处理 /deny 命令 */
    private handleDeny(chatId: string, arg?: string): string {
        const session = this.sessions.get(chatId);
        if (!session || !session.claude.isAlive()) {
            return '当前没有活跃会话。';
        }

        if (arg === 'all') {
            const count = session.claude.denyAll();
            return count > 0
                ? `已拒绝 ${count} 个权限请求。`
                : '没有待处理的权限请求。';
        }

        const pending = session.claude.getPendingPermissions();
        if (pending.length === 0) {
            return '没有待处理的权限请求。';
        }

        const latest = pending[pending.length - 1];
        session.claude.denyPermission(latest.requestId);
        return `已拒绝: ${latest.toolName}`;
    }

    /** 处理 /pending 命令 */
    private handlePending(chatId: string): string {
        const session = this.sessions.get(chatId);
        if (!session || !session.claude.isAlive()) {
            return '当前没有活跃会话。';
        }

        const pending = session.claude.getPendingPermissions();
        if (pending.length === 0) {
            return '没有待处理的权限请求。';
        }

        const lines = pending.map((p, i) => {
            const inputStr = formatPermissionInput(p.toolName, p.input);
            return `${i + 1}. ${p.toolName}\n   ${inputStr}`;
        });

        return `待处理的权限请求 (${pending.length}):\n\n${lines.join('\n\n')}`;
    }

    /** 关闭所有会话 */
    close(): void {
        for (const session of this.sessions.values()) {
            this.flushText(session);
            session.claude.kill();
        }
        this.sessions.clear();
    }
}

/** 格式化权限请求的 input 为可读文本 */
function formatPermissionInput(toolName: string, input: unknown): string {
    if (!input || typeof input !== 'object') return '';

    const obj = input as Record<string, unknown>;

    // Bash 命令
    if (toolName === 'Bash' || toolName === 'bash') {
        if (obj.command) return `命令: ${obj.command}`;
    }

    // 文件编辑
    if (obj.file_path || obj.path) {
        const path = (obj.file_path || obj.path) as string;
        return `文件: ${path}`;
    }

    // 通用：截断显示
    const str = JSON.stringify(input);
    if (str.length > 200) {
        return str.slice(0, 200) + '...';
    }
    return str;
}
