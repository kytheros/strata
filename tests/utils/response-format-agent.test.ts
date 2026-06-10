import { describe, it, expect } from "vitest";
import { ResponseFormat, selectFormat } from "../../src/utils/response-format.js";

describe("ResponseFormat.AGENT", () => {
  it("exposes an AGENT value", () => {
    expect(ResponseFormat.AGENT).toBe("agent");
  });

  it("selectFormat resolves format:'agent' to AGENT", () => {
    expect(selectFormat({ format: "agent" })).toBe(ResponseFormat.AGENT);
  });

  it("selectFormat still defaults to STANDARD when unset", () => {
    expect(selectFormat({})).toBe(ResponseFormat.STANDARD);
  });
});
