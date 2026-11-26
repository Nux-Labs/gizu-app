const { defineConfig } = require("eslint/config");
const expo = require("eslint-config-expo/flat");
module.exports = defineConfig([
  expo,
  { files: ["scripts/*.cjs"], languageOptions: { globals: { __dirname: "readonly" } } },
  { ignores: ["coverage/**", "dist/**", "ios/**", "android/**", ".expo/**"] },
  {
    // Offline synthetic verifiers use crypto dependencies installed outside the app.
    files: [
      "modules/gizu-signer/scripts/{reference-vectors,verify-signatures,verify-transfer}.mjs",
    ],
    rules: {
      "import/no-unresolved": [
        "error",
        { ignore: ["^@scure/bip32$", "^@scure/bip39(?:/|$)", "^viem(?:/|$)"] },
      ],
    },
  },
  {
    files: ["src/{application,features,services,navigation}/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/development/legacySigner/*", "**/development/legacySigner/*"],
              message: "Legacy signer adapters belong only in explicit development harnesses.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/components/atoms/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "@/features/*",
            "@/navigation/*",
            "@/services/*",
            "@/components/molecules/*",
            "@/components/organisms/*",
          ],
        },
      ],
    },
  },
]);
