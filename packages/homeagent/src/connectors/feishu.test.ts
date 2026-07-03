import { expect, test } from "bun:test";
import { createFeishuConnector } from "./feishu";

async function* lines(items: string[]): AsyncIterable<string> {
  for (const item of items) yield item;
}

async function* failingLines(items: string[], error: Error): AsyncIterable<string> {
  for (const item of items) yield item;
  throw error;
}

test("Feishu connector：把 im.message.receive_v1 事件归一成 IncomingMessage", async () => {
  const rawEvent = {
    chat_id: "oc_family",
    sender_id: "ou_dad",
    sender_name: "Dad",
    message_type: "text",
    content: '<at user_id="ou_bot">HomeBrain</at> 老师电话是多少？',
    create_time: "1782288000123",
  };
  const connector = createFeishuConnector({
    eventKey: "im.message.receive_v1",
    botOpenId: "ou_bot",
    eventSource: lines([JSON.stringify(rawEvent)]),
  });

  const messages = [];
  for await (const msg of connector.receiveMessages()) messages.push(msg);

  expect(messages).toEqual([
    {
      channelId: "oc_family",
      senderId: "ou_dad",
      senderName: "Dad",
      text: "老师电话是多少？",
      mentionsBot: true,
      raw: rawEvent,
      ts: 1782288000123,
    },
  ]);
});

test("Feishu connector：兼容 content 为 JSON 字符串的普通文本事件", async () => {
  const rawEvent = {
    chat_id: "oc_family",
    sender_id: "ou_mom",
    message_type: "text",
    content: '{"text":"牛奶还有两盒"}',
    create_time: "1782288000456",
  };
  const connector = createFeishuConnector({
    eventKey: "im.message.receive_v1",
    botOpenId: "ou_bot",
    eventSource: lines(["", "not-json", JSON.stringify(rawEvent)]),
  });

  const messages = [];
  for await (const msg of connector.receiveMessages()) messages.push(msg);

  expect(messages).toEqual([
    {
      channelId: "oc_family",
      senderId: "ou_mom",
      text: "牛奶还有两盒",
      mentionsBot: false,
      raw: rawEvent,
      ts: 1782288000456,
    },
  ]);
});

test("Feishu connector：兼容 im.message.receive_v1 原始嵌套事件结构", async () => {
  const rawEvent = {
    schema: "2.0",
    header: {
      event_type: "im.message.receive_v1",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "ou_dad",
        },
        sender_type: "user",
      },
      message: {
        chat_id: "oc_family",
        message_type: "text",
        content: '{"text":"<at user_id=\\"ou_bot\\">HomeBrain</at> 老师电话是多少？"}',
        create_time: "1782288000789",
      },
    },
  };
  const connector = createFeishuConnector({
    eventKey: "im.message.receive_v1",
    botOpenId: "ou_bot",
    eventSource: lines([JSON.stringify(rawEvent)]),
  });

  const messages = [];
  for await (const msg of connector.receiveMessages()) messages.push(msg);

  expect(messages).toEqual([
    {
      channelId: "oc_family",
      senderId: "ou_dad",
      text: "老师电话是多少？",
      mentionsBot: true,
      raw: rawEvent,
      ts: 1782288000789,
    },
  ]);
});

test("Feishu connector：非文本事件保留附件 key 且不把 JSON 当文本", async () => {
  const imageEvent = {
    chat_id: "oc_family",
    sender_id: "ou_dad",
    message_type: "image",
    content: '{"image_key":"img_v3_abc"}',
    create_time: "1782288000901",
  };
  const fileEvent = {
    chat_id: "oc_family",
    sender_id: "ou_mom",
    message_type: "file",
    content: '{"file_key":"file_v3_def","file_name":"课表.pdf"}',
    create_time: "1782288000902",
  };
  const connector = createFeishuConnector({
    eventKey: "im.message.receive_v1",
    botOpenId: "ou_bot",
    eventSource: lines([JSON.stringify(imageEvent), JSON.stringify(fileEvent)]),
  });

  const messages = [];
  for await (const msg of connector.receiveMessages()) messages.push(msg);

  expect(messages).toEqual([
    {
      channelId: "oc_family",
      senderId: "ou_dad",
      text: "",
      attachments: [{ kind: "image", key: "img_v3_abc" }],
      mentionsBot: false,
      raw: imageEvent,
      ts: 1782288000901,
    },
    {
      channelId: "oc_family",
      senderId: "ou_mom",
      text: "",
      attachments: [{ kind: "file", key: "file_v3_def", name: "课表.pdf" }],
      mentionsBot: false,
      raw: fileEvent,
      ts: 1782288000902,
    },
  ]);
});

test("Feishu connector：可选下载附件到本地相对路径", async () => {
  const imageEvent = {
    chat_id: "oc_family",
    sender_id: "ou_dad",
    message_id: "om_homework",
    message_type: "image",
    content: '{"image_key":"img_v3_abc"}',
    create_time: "1782288000901",
  };
  const fileEvent = {
    chat_id: "oc_family",
    sender_id: "ou_mom",
    message_id: "om_schedule",
    message_type: "file",
    content: '{"file_key":"file_v3_def","file_name":"课表/周一.pdf"}',
    create_time: "1782288000902",
  };
  const calls: string[][] = [];
  const connector = createFeishuConnector({
    eventKey: "im.message.receive_v1",
    larkBin: "lark-dev",
    botOpenId: "ou_bot",
    attachmentDownloadDir: "downloads",
    eventSource: lines([JSON.stringify(imageEvent), JSON.stringify(fileEvent)]),
    runCommand: async (argv) => {
      calls.push(argv);
    },
  });

  const messages = [];
  for await (const msg of connector.receiveMessages()) messages.push(msg);

  expect(calls).toEqual([
    [
      "lark-dev",
      "im",
      "+messages-resources-download",
      "--message-id",
      "om_homework",
      "--file-key",
      "img_v3_abc",
      "--type",
      "image",
      "--output",
      "downloads/om_homework/img_v3_abc",
      "--as",
      "bot",
    ],
    [
      "lark-dev",
      "im",
      "+messages-resources-download",
      "--message-id",
      "om_schedule",
      "--file-key",
      "file_v3_def",
      "--type",
      "file",
      "--output",
      "downloads/om_schedule/课表_周一.pdf",
      "--as",
      "bot",
    ],
  ]);
  expect(messages.map((msg) => msg.attachments)).toEqual([
    [{ kind: "image", key: "img_v3_abc", localPath: "downloads/om_homework/img_v3_abc" }],
    [
      {
        kind: "file",
        key: "file_v3_def",
        name: "课表/周一.pdf",
        localPath: "downloads/om_schedule/课表_周一.pdf",
      },
    ],
  ]);
});

test("Feishu connector：富文本 post 事件提取正文并识别 @bot", async () => {
  const rawEvent = {
    chat_id: "oc_family",
    sender_id: "ou_dad",
    message_type: "post",
    content: JSON.stringify({
      title: "家庭问题",
      content: [
        [
          { tag: "at", user_id: "ou_bot", user_name: "HomeBrain" },
          { tag: "text", text: " 老师电话是多少？" },
        ],
        [{ tag: "text", text: "顺便看看下周校历。" }],
      ],
    }),
    create_time: "1782288000910",
  };
  const connector = createFeishuConnector({
    eventKey: "im.message.receive_v1",
    botOpenId: "ou_bot",
    eventSource: lines([JSON.stringify(rawEvent)]),
  });

  const messages = [];
  for await (const msg of connector.receiveMessages()) messages.push(msg);

  expect(messages).toEqual([
    {
      channelId: "oc_family",
      senderId: "ou_dad",
      text: "家庭问题\n老师电话是多少？\n顺便看看下周校历。",
      mentionsBot: true,
      raw: rawEvent,
      ts: 1782288000910,
    },
  ]);
});

test("Feishu connector：富文本 post 事件保留内嵌附件 key", async () => {
  const rawEvent = {
    chat_id: "oc_family",
    sender_id: "ou_dad",
    message_type: "post",
    content: JSON.stringify({
      title: "作业材料",
      content: [
        [
          { tag: "text", text: "今天的题目在图片里。" },
          { tag: "img", image_key: "img_v3_homework" },
        ],
        [
          {
            tag: "media",
            file_key: "file_v3_sheet",
            file_name: "本周练习.pdf",
            image_key: "img_v3_cover",
          },
        ],
      ],
    }),
    create_time: "1782288000911",
  };
  const connector = createFeishuConnector({
    eventKey: "im.message.receive_v1",
    botOpenId: "ou_bot",
    eventSource: lines([JSON.stringify(rawEvent)]),
  });

  const messages = [];
  for await (const msg of connector.receiveMessages()) messages.push(msg);

  expect(messages).toEqual([
    {
      channelId: "oc_family",
      senderId: "ou_dad",
      text: "作业材料\n今天的题目在图片里。",
      attachments: [
        { kind: "image", key: "img_v3_homework" },
        { kind: "file", key: "file_v3_sheet", name: "本周练习.pdf" },
        { kind: "image", key: "img_v3_cover" },
      ],
      mentionsBot: false,
      raw: rawEvent,
      ts: 1782288000911,
    },
  ]);
});

test("Feishu connector：sendMessage 调用 lark-cli 发送文本消息", async () => {
  const calls: string[][] = [];
  const connector = createFeishuConnector({
    eventKey: "im.message.receive_v1",
    larkBin: "lark-dev",
    eventSource: lines([]),
    runCommand: async (argv) => {
      calls.push(argv);
    },
  });

  await connector.sendMessage({
    channelId: "oc_family",
    text: "家庭早报（2026-06-24）\n今天记得带校服。",
  });

  expect(calls).toEqual([
    [
      "lark-dev",
      "im",
      "+messages-send",
      "--chat-id",
      "oc_family",
      "--text",
      "家庭早报（2026-06-24）\n今天记得带校服。",
      "--as",
      "bot",
    ],
  ]);
});

test("Feishu connector：event consume 异常退出后重启并继续收消息", async () => {
  const firstEvent = {
    chat_id: "oc_family",
    sender_id: "ou_dad",
    content: '{"text":"第一条"}',
    create_time: "1782288000001",
  };
  const secondEvent = {
    chat_id: "oc_family",
    sender_id: "ou_mom",
    content: '{"text":"第二条"}',
    create_time: "1782288000002",
  };
  let attempts = 0;
  const connector = createFeishuConnector({
    eventKey: "im.message.receive_v1",
    maxRestarts: 1,
    restartDelayMs: 0,
    eventSourceFactory() {
      attempts += 1;
      return attempts === 1
        ? failingLines([JSON.stringify(firstEvent)], new Error("consume crashed"))
        : lines([JSON.stringify(secondEvent)]);
    },
  });

  const messages = [];
  for await (const msg of connector.receiveMessages()) messages.push(msg);

  expect(attempts).toBe(2);
  expect(messages.map((msg) => msg.text)).toEqual(["第一条", "第二条"]);
});
