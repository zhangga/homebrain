import { describe, expect, test } from "bun:test";
import { safeLarkVerificationUrl } from "./verification-url.ts";

describe("safeLarkVerificationUrl", () => {
  test("allows official CLI and launcher confirmation pages", () => {
    expect(safeLarkVerificationUrl("https://open.feishu.cn/page/cli?user_code=A"))
      .toBe("https://open.feishu.cn/page/cli?user_code=A");
    expect(safeLarkVerificationUrl("https://open.feishu.cn/page/launcher?user_code=B"))
      .toBe("https://open.feishu.cn/page/launcher?user_code=B");
    expect(safeLarkVerificationUrl("https://open.larksuite.com/page/launcher?user_code=C"))
      .toBe("https://open.larksuite.com/page/launcher?user_code=C");
  });

  test("rejects URLs that could exfiltrate credentials or leave Feishu", () => {
    expect(safeLarkVerificationUrl("http://open.feishu.cn/page/launcher?user_code=A")).toBeUndefined();
    expect(safeLarkVerificationUrl("https://attacker.example/page/launcher?user_code=A")).toBeUndefined();
    expect(safeLarkVerificationUrl("https://open.feishu.cn.evil.example/page/launcher")).toBeUndefined();
    expect(safeLarkVerificationUrl("https://user:pass@open.feishu.cn/page/launcher")).toBeUndefined();
    expect(safeLarkVerificationUrl("https://open.feishu.cn:444/page/launcher")).toBeUndefined();
    expect(safeLarkVerificationUrl("https://open.feishu.cn/redirect?next=https://evil.example")).toBeUndefined();
    expect(safeLarkVerificationUrl("not a url")).toBeUndefined();
  });
});
