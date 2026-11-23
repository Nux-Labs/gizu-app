import { getAddress, hexToBytes, keccak256, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { DomainError } from "./errors/domain-error.ts";
import { StatusDomainError } from "./errors/status-error.ts";
import { assertRegistrySignature, type StrategyRegistryChainId } from "./strategy.ts";

/**
 * Social sign-in rules shared with the native signer (social key m/44'/60'/147'/{chainId}'/0)
 * and the mobile app. The social key holds no funds and is never linked to a wallet in responses.
 */
export const SOCIAL_CHALLENGE_SECONDS = 5 * 60;
export const SOCIAL_SESSION_DAYS = 30;
export const COMMENT_MAX_LENGTH = 500;
export const COMMENT_REPORT_REASON_MAX_LENGTH = 200;
export const COMMENT_REPORTS_TO_HIDE = 3;
export const COMMENT_MAX_REPLIES = 50;
export const COMMENT_LIMIT_PER_MINUTE = 5;
export const COMMENT_LIMIT_PER_DAY = 100;

export function socialDomain(chainId: StrategyRegistryChainId) {
  return { name: "GizuSocial", version: "1", chainId } as const;
}

export const signInTypes = {
  SignIn: [
    { name: "account", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

export const ownerLinkTypes = {
  OwnerLink: [
    { name: "account", type: "address" },
    { name: "strategyId", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export function socialAuthRequired() {
  return new StatusDomainError(401, "SOCIAL_AUTH_REQUIRED", "Sign in to comment and like.");
}

export function socialSignatureInvalid(message = "The signature does not match the account.") {
  return new DomainError("SOCIAL_SIGNATURE_INVALID", message);
}

export async function signInSigner(input: {
  chainId: StrategyRegistryChainId;
  account: Address;
  nonce: Hex;
  issuedAt: number;
  signature: Hex;
}): Promise<Address> {
  assertSocialSignature(input.signature);
  return recoverTypedDataAddress({
    domain: socialDomain(input.chainId),
    types: signInTypes,
    primaryType: "SignIn",
    message: { account: input.account, nonce: input.nonce, issuedAt: BigInt(input.issuedAt) },
    signature: input.signature,
  });
}

export async function ownerLinkSigner(input: {
  chainId: StrategyRegistryChainId;
  account: Address;
  strategyId: number;
  nonce: Hex;
  signature: Hex;
}): Promise<Address> {
  assertSocialSignature(input.signature);
  return recoverTypedDataAddress({
    domain: socialDomain(input.chainId),
    types: ownerLinkTypes,
    primaryType: "OwnerLink",
    message: { account: input.account, strategyId: BigInt(input.strategyId), nonce: input.nonce },
    signature: input.signature,
  });
}

function assertSocialSignature(signature: Hex) {
  try {
    assertRegistrySignature(signature);
  } catch {
    throw socialSignatureInvalid("The signature is malformed.");
  }
}

// Exactly 64 words each, so one byte modulo the list length picks every word equally often.
const ADJECTIVES = [
  "Amber", "Brave", "Bright", "Calm", "Cheerful", "Clever", "Cosmic", "Curious",
  "Dapper", "Daring", "Dreamy", "Eager", "Earnest", "Fancy", "Fearless", "Festive",
  "Friendly", "Gentle", "Gleaming", "Golden", "Graceful", "Happy", "Hearty", "Honest",
  "Humble", "Jolly", "Joyful", "Kind", "Lively", "Lucky", "Lunar", "Merry",
  "Mighty", "Misty", "Modest", "Nimble", "Noble", "Patient", "Peppy", "Plucky",
  "Polite", "Proud", "Quick", "Quiet", "Radiant", "Rapid", "Rosy", "Serene",
  "Sharp", "Shiny", "Silver", "Sincere", "Snowy", "Solar", "Sparkly", "Spry",
  "Steady", "Sunny", "Swift", "Tidy", "Tranquil", "Vivid", "Witty", "Zesty",
] as const;
const ANIMALS = [
  "Albatross", "Alpaca", "Antelope", "Badger", "Beaver", "Bison", "Bluebird", "Capybara",
  "Cheetah", "Chipmunk", "Crane", "Dolphin", "Dove", "Eagle", "Elk", "Falcon",
  "Ferret", "Finch", "Flamingo", "Fox", "Gazelle", "Gecko", "Giraffe", "Hare",
  "Hedgehog", "Heron", "Hummingbird", "Ibis", "Jaguar", "Kangaroo", "Kingfisher", "Koala",
  "Lark", "Lemur", "Leopard", "Llama", "Lynx", "Manatee", "Meerkat", "Moose",
  "Narwhal", "Ocelot", "Otter", "Owl", "Panda", "Panther", "Parrot", "Pelican",
  "Penguin", "Puffin", "Quail", "Rabbit", "Raccoon", "Robin", "Seal", "Sparrow",
  "Squirrel", "Swan", "Tiger", "Toucan", "Turtle", "Walrus", "Wombat", "Zebra",
] as const;

/** `"<Adjective> <Animal> #<last 4 hex>"`, picked by the first two bytes of keccak256(account). */
export function socialNickname(account: Address): string {
  const normalized = getAddress(account.toLowerCase());
  const digest = hexToBytes(keccak256(hexToBytes(normalized)));
  const adjective = ADJECTIVES[digest[0]! % ADJECTIVES.length]!;
  const animal = ANIMALS[digest[1]! % ANIMALS.length]!;
  return `${adjective} ${animal} #${normalized.slice(-4).toLowerCase()}`;
}

export const socialWordLists = { adjectives: ADJECTIVES, animals: ANIMALS };
