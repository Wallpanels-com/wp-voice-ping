import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const output = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
);
const files = output.split("\0").filter(Boolean);
const findings = [];
const patterns = [
  { name: "Telegram bot token", regex: /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g },
  { name: "HighLevel private integration token", regex: /\bpit-[A-Za-z0-9-]{20,}\b/g },
  { name: "Private key block", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: "Credentialed PostgreSQL URL", regex: /postgres(?:ql)?:\/\/([^:\s]+):([^@\s]+)@/g },
];

for (const file of files) {
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (content.includes("\0")) continue;
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern.regex)) {
      if (pattern.name === "Credentialed PostgreSQL URL" && match[1] === "USER" && match[2] === "PASSWORD") continue;
      const line = content.slice(0, match.index).split("\n").length;
      findings.push(`${file}:${line} ${pattern.name}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`Potential secrets found:\n${findings.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Secret scan passed for ${files.length} non-ignored files.\n`);
