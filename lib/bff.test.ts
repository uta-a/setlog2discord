import { describe, it, expect } from "vitest";
import { toErrorResponse } from "./bff";
import { SetlogAuthError, SetlogSchemaError, SetlogHttpError } from "@/lib/setlog/client";

describe("toErrorResponse", () => {
  it("SetlogAuthError → 401 token_invalid", async () => {
    const r = toErrorResponse(new SetlogAuthError());
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe("token_invalid");
  });

  it("SetlogSchemaError → 502 schema_changed", async () => {
    const r = toErrorResponse(new SetlogSchemaError("/collections", []));
    expect(r.status).toBe(502);
    expect((await r.json()).error).toBe("schema_changed");
  });

  it("SetlogHttpError → 502 upstream_error", async () => {
    const r = toErrorResponse(new SetlogHttpError(500, "/x", ""));
    expect(r.status).toBe(502);
    expect((await r.json()).error).toBe("upstream_error");
  });

  it("その他 → 500 internal", async () => {
    const r = toErrorResponse(new Error("boom"));
    expect(r.status).toBe(500);
    expect((await r.json()).error).toBe("internal");
  });
});
