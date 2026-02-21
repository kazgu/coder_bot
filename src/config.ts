import type { AgentBackend } from './agent';

export interface FeishuConfig {
    appId: string;
    appSecret: string;
}

export interface ClaudeConfig {
    executable: string;
    cwd: string;
    permissionMode: string;
    debug: boolean;
}

export interface CodexConfig {
    executable: string;
    cwd: string;
    permissionMode: string;
    model: string;
    debug: boolean;
}

export interface AppConfig {
    feishu: FeishuConfig;
    claude: ClaudeConfig;
    codex: CodexConfig;
    defaultBackend: AgentBackend;
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

export function loadAppConfig(): AppConfig {
    const debug = process.env.DEBUG === 'true' || process.env.DEBUG === '1';
    const cwd = process.env.CLAUDE_CWD || process.cwd();
    const permissionMode = process.env.CLAUDE_PERMISSION_MODE || 'default';

    return {
        feishu: {
            appId: requireEnv('FEISHU_APP_ID'),
            appSecret: requireEnv('FEISHU_APP_SECRET'),
        },
        claude: {
            executable: process.env.CLAUDE_PATH || 'claude',
            cwd,
            permissionMode,
            debug,
        },
        codex: {
            executable: process.env.CODEX_PATH || 'codex',
            cwd,
            permissionMode: process.env.CODEX_PERMISSION_MODE || permissionMode,
            model: process.env.CODEX_MODEL || '',
            debug,
        },
        defaultBackend: (process.env.DEFAULT_BACKEND as AgentBackend) || 'claude',
    };
}
