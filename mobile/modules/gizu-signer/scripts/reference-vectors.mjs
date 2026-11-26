import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { privateKeyToAccount } from "viem/accounts";
import { bytesToHex, keccak256, serializeTransaction } from "viem";
const seed = mnemonicToSeedSync(entropyToMnemonic(new Uint8Array(32), wordlist));
const addresses = Array.from(
  { length: 16 },
  (_, i) =>
    privateKeyToAccount(
      bytesToHex(HDKey.fromMasterSeed(seed).derive(`m/44'/60'/0'/0/${i}`).privateKey),
    ).address,
);
const tx = {
  type: "eip1559",
  chainId: 10143,
  nonce: 0,
  gas: 21000n,
  maxFeePerGas: 200000000000n,
  maxPriorityFeePerGas: 0n,
  to: "0x" + "11".repeat(20),
  value: 1n,
};
console.log(addresses.join("\n"));
console.log(keccak256(serializeTransaction(tx)));
