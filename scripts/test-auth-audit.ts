import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { adminAuditActor, auditConfigured } from "../lib/auth";

process.env.ADMIN_TOKEN = "12345678";
process.env.AUDIT_HMAC_KEY = "independent-high-entropy-audit-key-for-tests";

const request = new Request("http://localhost/review", {
  headers: { "x-admin-token": process.env.ADMIN_TOKEN },
});
const first = adminAuditActor(request, "审核测试");
const second = adminAuditActor(request, "发布测试");

assert.equal(auditConfigured(), true);
assert.match(first.idHash, /^[0-9a-f]{64}$/);
assert.equal(first.idHash, second.idHash, "同一管理员凭证应产生稳定的伪匿名审计身份");
assert.notEqual(
  first.idHash,
  createHash("sha256").update(process.env.ADMIN_TOKEN).digest("hex"),
  "审计身份不得是可离线穷举的无盐管理员密码 SHA-256",
);
assert.notEqual(first.requestId, second.requestId, "每次审核操作必须由服务器产生独立 request ID");
assert.equal(first.reason, "审核测试");

process.env.AUDIT_HMAC_KEY = process.env.ADMIN_TOKEN.repeat(4);
process.env.ADMIN_TOKEN = process.env.AUDIT_HMAC_KEY;
assert.equal(auditConfigured(), false);
assert.throws(
  () => adminAuditActor(new Request("http://localhost/review", {
    headers: { "x-admin-token": process.env.ADMIN_TOKEN! },
  }), "复用密钥"),
  /independent value/,
  "审计 HMAC 密钥不得复用管理员凭证",
);

process.env.ADMIN_TOKEN = "12345678";
delete process.env.AUDIT_HMAC_KEY;
assert.throws(
  () => adminAuditActor(request, "缺少审计密钥"),
  /AUDIT_HMAC_KEY/,
  "缺少独立审计密钥时必须 fail closed",
);

console.log("admin audit HMAC and request identity tests passed");
