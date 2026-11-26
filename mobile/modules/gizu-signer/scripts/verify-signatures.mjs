// Synthetic public vectors only. Run outside the mobile dependency graph with viem 2.56.8.
import { readFileSync } from "node:fs";
import { recoverMessageAddress } from "viem";
const lines = readFileSync(process.argv[2], "utf8").trim().split("\n");
for (const line of lines) {
  const [address, message, signature] = line.split("\t");
  if ((await recoverMessageAddress({ message, signature })) !== address)
    throw new Error("Signature mismatch");
  if ((await recoverMessageAddress({ message: message + "changed", signature })) === address)
    throw new Error("Tampering accepted");
}
console.log(
  lines.length + " Rust signatures independently verified with viem; altered messages rejected.",
);
