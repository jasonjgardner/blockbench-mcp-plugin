import { expect, test } from "bun:test";
import { tagBlocker } from "@/build/release-tag";

test("a clean checkout without the tag may be tagged", () => {
  expect(tagBlocker({ status: "", tagExists: false, version: "1.9.0" })).toBeNull();
  expect(tagBlocker({ status: "\n  \n", tagExists: false, version: "1.9.0" })).toBeNull();
});

test("uncommitted changes block tagging and are listed, because the evidence may describe other source", () => {
  const blocker = tagBlocker({ status: " M lib/frame-rate.ts\n?? notes.txt\n", tagExists: false, version: "1.9.0" });
  expect(blocker).toContain("uncommitted changes");
  expect(blocker).toContain(" M lib/frame-rate.ts");
  expect(blocker).toContain("?? notes.txt");
});

test("an existing tag blocks tagging and names the version", () => {
  expect(tagBlocker({ status: "", tagExists: true, version: "1.9.0" })).toBe("Tag v1.9.0 already exists. Bump package.json or delete the tag first.");
});

test("a dirty tree is reported before an existing tag", () => {
  expect(tagBlocker({ status: " M package.json", tagExists: true, version: "1.9.0" })).toContain("uncommitted changes");
});
