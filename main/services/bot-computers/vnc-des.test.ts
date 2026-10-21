import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import test from "node:test";

import { desEncryptBlock, vncAuthResponse, vncDesKey } from "./vnc-des.js";

/** Single DES through OpenSSL: Triple DES with K1 = K2 = K3 is single DES, and Node still offers it. */
function opensslDes(key: Buffer, block: Buffer): Buffer {
  const cipher = createCipheriv("des-ede3-ecb", Buffer.concat([key, key, key]), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}

test("the classic DES vector encrypts 'Now is t' under 0123456789abcdef to 3fa40e8a984d4815", () => {
  const out = desEncryptBlock(Buffer.from("0123456789abcdef", "hex"), Buffer.from("Now is t", "latin1"));
  assert.equal(out.toString("hex"), "3fa40e8a984d4815");
});

test("random keys and blocks match OpenSSL's DES", () => {
  for (let round = 0; round < 64; round += 1) {
    const key = randomBytes(8);
    const block = randomBytes(8);
    assert.equal(desEncryptBlock(key, block).toString("hex"), opensslDes(key, block).toString("hex"));
  }
});

test("the VNC key reverses each password byte's bits and keeps only the first eight bytes", () => {
  // "a" is 0x61 (0110 0001), reversed 1000 0110 = 0x86. Missing bytes are zero.
  assert.equal(vncDesKey("a").toString("hex"), "8600000000000000");
  assert.deepEqual(vncDesKey("Password1234"), vncDesKey("Password"));
});

test("a VNC challenge response is the challenge's two halves encrypted under the reversed key", () => {
  const challenge = randomBytes(16);
  const password = "Kq7Lm2Pz";
  const reversed = Buffer.from(
    [...Buffer.from(password)].map((byte) => parseInt(byte.toString(2).padStart(8, "0").split("").reverse().join(""), 2)),
  );
  const expected = Buffer.concat([opensslDes(reversed, challenge.subarray(0, 8)), opensslDes(reversed, challenge.subarray(8))]);
  assert.equal(vncAuthResponse(password, challenge).toString("hex"), expected.toString("hex"));
});

test("wrong sizes are refused instead of silently padded", () => {
  assert.throws(() => desEncryptBlock(Buffer.alloc(7), Buffer.alloc(8)), RangeError);
  assert.throws(() => desEncryptBlock(Buffer.alloc(8), Buffer.alloc(9)), RangeError);
  assert.throws(() => vncAuthResponse("secret", Buffer.alloc(15)), RangeError);
});
