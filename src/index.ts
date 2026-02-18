import * as Lark from '@larksuiteoapi/node-sdk';
import { loadAppConfig } from './config';
import { FeishuClient } from './feishu/client';
import { Bridge } from './bridge';

async function main(): Promise<void> {
    const appConfig = loadAppConfig();

    // 飞书客户端
    const feishuClient = new FeishuClient(appConfig.feishu);

    // Bridge: 飞书 ↔ Claude Code
    const bridge = new Bridge(appConfig.claude, feishuClient);

    // 飞书事件分发
    const eventDispatcher = new Lark.EventDispatcher({});

    eventDispatcher.register({
        'im.message.receive_v1': async (data) => {
            const event = data as Record<string, unknown>;
            const message = event.message as Record<string, unknown>;

            const msgType = message.message_type as string;
            const chatId = message.chat_id as string;
            const messageId = message.message_id as string;

            if (msgType === 'text') {
                try {
                    const content = JSON.parse(message.content as string) as { text: string };
                    void bridge.handleMessage(chatId, messageId, content.text);
                } catch {
                    // 忽略
                }
            } else if (msgType === 'image') {
                try {
                    const content = JSON.parse(message.content as string) as { image_key: string };
                    void bridge.handleImageMessage(chatId, messageId, content.image_key);
                } catch {
                    // 忽略
                }
            }
        },
    });

    // WebSocket 长连接
    const wsClient = new Lark.WSClient({
        appId: appConfig.feishu.appId,
        appSecret: appConfig.feishu.appSecret,
        domain: Lark.Domain.Feishu,
        loggerLevel: Lark.LoggerLevel.info,
        autoReconnect: true,
    });

    wsClient.start({ eventDispatcher });
    console.log('[happy-feishu] Started, listening for messages...');

    // 优雅关闭
    const shutdown = (): void => {
        console.log('[happy-feishu] Shutting down...');
        bridge.close();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    console.error('[happy-feishu] Fatal error:', err);
    process.exit(1);
});
