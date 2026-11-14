// @ts-check
// Build-time values only. Wallet authority is enforced by the signed native binary.
const { isIP } = require("node:net");

/** @param {Record<string, string | undefined>} env */
function distributionConfig(env) {
  const release =
    ["development", "production", "adhoc", "preview", "testflight"].includes(
      env.EAS_BUILD_PROFILE ?? "",
    ) || ["production", "testflight"].includes(env.GIZU_BUILD_VARIANT ?? "");
  if (release && env.EXPO_PUBLIC_DEBUG_SCREEN) {
    throw new Error("Release builds cannot select diagnostic screens.");
  }
  if (release && env.EXPO_PUBLIC_API_URL) {
    const url = new URL(env.EXPO_PUBLIC_API_URL);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      isIP(host) ||
      !host.includes(".") ||
      /\.(localhost|local|internal|test)$/.test(host)
    ) {
      throw new Error(
        "Release builds require a public HTTPS backend URL without credentials, query or fragment.",
      );
    }
  }
  return { release };
}
module.exports = { distributionConfig };
