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

    /** 下载消息中的图片，返回 base64 字符串 */
    async downloadImage(messageId: string, imageKey: string): Promise<string> {
        const resp = await this.larkClient.im.v1.messageResource.get({
            path: { message_id: messageId, file_key: imageKey },
            params: { type: 'image' },
        });

        const stream = resp.getReadableStream();
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
            chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks).toString('base64');
    }
}
