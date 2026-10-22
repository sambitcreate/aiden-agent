import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { allocatedBytes, availableMemoryBytes, parseVmStat, requireResources } from "./resources.js";
import { BotComputerError } from "./types.js";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               80000.
Pages active:                            612345.
Pages inactive:                          400000.
Pages speculative:                        12000.
Pages throttled:                              0.
Pages wired down:                        210000.
Pages purgeable:                          44288.
"Translation faults":                1234567890.
Pages copy-on-write:                   12345678.
Pages zero filled:                    987654321.
Pages reactivated:                      1234567.
Pages purged:                            123456.
File-backed pages:                       300000.
Anonymous pages:                         700000.
Pages stored in compressor:              150000.
Pages occupied by compressor:             50000.
Decompressions:                          100000.
Compressions:                            200000.
Pageins:                                3000000.
Pageouts:                                  1000.
Swapins:                                      0.
Swapouts:                                     0.
`;

test("available memory is free plus inactive plus purgeable pages", () => {
  const pages = parseVmStat(VM_STAT);
  assert.deepEqual(pages, { pageSize: 16_384, free: 80_000, inactive: 400_000, purgeable: 44_288 });
  assert.equal(availableMemoryBytes(pages), (80_000 + 400_000 + 44_288) * 16_384);
  assert.throws(() => parseVmStat("Mach Virtual Memory Statistics:\nPages free: 1.\n"), /page size/u);
});

const probe = (freeDisk: number, memory: number | Error) => ({
  freeDiskBytes: async () => freeDisk,
  availableMemoryBytes: async () => {
    if (memory instanceof Error) throw memory;
    return memory;
  },
});

test("too little disk or memory is refused with a message the person can act on", async () => {
  await assert.rejects(
    requireResources(probe(10e9, 64e9), { dir: "/", diskBytes: 80e9 }),
    (error: unknown) => error instanceof BotComputerError && error.code === "low_disk" && /80\.0 GB/u.test(error.message),
  );
  await assert.rejects(
    requireResources(probe(500e9, 4e9), { dir: "/", memoryBytes: 8 * 1024 ** 3 }),
    (error: unknown) => error instanceof BotComputerError && error.code === "low_memory" && /stop another Bot's computer/u.test(error.message),
  );
  await assert.rejects(
    requireResources(probe(500e9, new Error("vm_stat missing")), { dir: "/", memoryBytes: 1 }),
    (error: unknown) => error instanceof BotComputerError && error.code === "low_memory",
  );
  await requireResources(probe(500e9, 64e9), { dir: "/", diskBytes: 80e9, memoryBytes: 8 * 1024 ** 3 });
});

test("disk use counts allocated blocks and never follows symlinks out of the tree", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "p8-du-"));
  const outside = mkdtempSync(path.join(tmpdir(), "p8-du-outside-"));
  writeFileSync(path.join(outside, "big"), Buffer.alloc(2 * 1024 * 1024, 1));
  mkdirSync(path.join(root, "vms", "aiden-base"), { recursive: true });
  writeFileSync(path.join(root, "vms", "aiden-base", "disk.img"), Buffer.alloc(256 * 1024, 1));
  symlinkSync(outside, path.join(root, "link"));
  const used = await allocatedBytes(root);
  assert.ok(used >= 256 * 1024, "the written file counts");
  assert.ok(used < 2 * 1024 * 1024, "the symlinked directory does not");
});
