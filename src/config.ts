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

export interface AppConfig {
    feishu: FeishuConfig;
    claude: ClaudeConfig;
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

export function loadAppConfig(): AppConfig {
    return {
        feishu: {
            appId: requireEnv('FEISHU_APP_ID'),
            appSecret: requireEnv('FEISHU_APP_SECRET'),
        },
        claude: {
            executable: process.env.CLAUDE_PATH || 'claude',
            cwd: process.env.CLAUDE_CWD || process.cwd(),
            permissionMode: process.env.CLAUDE_PERMISSION_MODE || 'default',
            debug: process.env.DEBUG === 'true' || process.env.DEBUG === '1',
        },
    };
}
