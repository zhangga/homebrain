import { describe, expect, test } from "bun:test";
import {
  personalSpace,
  teamSpace,
  spaceKind,
  spaceOwnerId,
  spaceToDir,
  isSpaceId,
} from "./space.ts";

describe("space helpers", () => {
  test("build personal and team space ids", () => {
    expect(personalSpace("ou_abc")).toBe("personal/ou_abc");
    expect(teamSpace("oc_xyz")).toBe("team/oc_xyz");
  });

  test("kind and owner id extraction", () => {
    expect(spaceKind("personal/ou_abc")).toBe("personal");
    expect(spaceKind("team/oc_xyz")).toBe("team");
    expect(spaceOwnerId("personal/ou_abc")).toBe("ou_abc");
    expect(spaceOwnerId("team/oc_xyz")).toBe("oc_xyz");
  });

  test("dir sanitizes unsafe characters but keeps kind prefix", () => {
    expect(spaceToDir("personal/ou_abc")).toBe("personal__ou_abc");
    expect(spaceToDir("team/oc.x/y+z")).toBe("team__oc_x_y_z");
  });

  test("isSpaceId validates the shape", () => {
    expect(isSpaceId("personal/ou_abc")).toBe(true);
    expect(isSpaceId("team/oc_xyz")).toBe(true);
    expect(isSpaceId("garbage")).toBe(false);
    expect(isSpaceId("personal/")).toBe(false);
  });
});
