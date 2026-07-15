import { describe, expect, test } from "bun:test";
import { brandedEnv } from "./brand.ts";

describe("branded environment compatibility", () => {
  test("reads the pre-rename prefix when no canonical value exists", () => {
    expect(brandedEnv({ HOMEBRAIN_DATA_DIR: "/legacy" }, "DATA_DIR")).toBe("/legacy");
  });

  test("prefers the canonical prefix, including an explicit empty value", () => {
    expect(brandedEnv({
      HOMEAGENT_DATA_DIR: "/current",
      HOMEBRAIN_DATA_DIR: "/legacy",
    }, "DATA_DIR")).toBe("/current");
    expect(brandedEnv({
      HOMEAGENT_DEFAULT_MODEL: "",
      HOMEBRAIN_DEFAULT_MODEL: "legacy-model",
    }, "DEFAULT_MODEL")).toBe("");
  });
});
