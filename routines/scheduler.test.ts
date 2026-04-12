import { describe, it, expect } from "bun:test";
import { interpolate } from "../src/routines/interpolate.ts";

describe("interpolate", () => {
  it("replaces known env vars", () => {
    process.env.USER_NAME = "Alice";
    expect(interpolate("Hello {{USER_NAME}}")).toBe("Hello Alice");
  });

  it("leaves unknown vars as literal", () => {
    expect(interpolate("Hello {{UNKNOWN_VAR_XYZ}}")).toBe(
      "Hello {{UNKNOWN_VAR_XYZ}}",
    );
  });

  it("handles multiple vars", () => {
    process.env.A = "foo";
    process.env.B = "bar";
    expect(interpolate("{{A}} and {{B}}")).toBe("foo and bar");
  });

  it("returns plain string unchanged", () => {
    expect(interpolate("no variables here")).toBe("no variables here");
  });
});
