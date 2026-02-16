import * as Lark from '@larksuiteoapi/node-sdk';
import type { FeishuConfig } from '../config';

export class FeishuClient {
    readonly larkClient: Lark.Client;

    constructor(config: FeishuConfig) {
        this.larkClient = new Lark.Client({
            appId: config.appId,
            appSecret: config.appSecret,
            domain: Lark.Domain.Feishu,
        });
    }

    async replyText(messageId: string, text: string): Promise<void> {
        await this.larkClient.im.v1.message.reply({
            path: { message_id: messageId },
            data: {
                content: JSON.stringify({ text }),
                msg_type: 'text',
            },
        });
    }

    async sendText(chatId: string, text: string): Promise<void> {
        await this.larkClient.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
                receive_id: chatId,
                content: JSON.stringify({ text }),
                msg_type: 'text',
            },
        });
    }
}
