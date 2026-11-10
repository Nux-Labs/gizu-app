import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { identity } from "@/config/passkeys";
import { distributionConfig } from "@/config/distribution";

test("the production Android association authorizes every configured signing certificate", () => {
  const association = JSON.parse(
    readFileSync(
      resolve(__dirname, "../../../frontend/public/.well-known/assetlinks.json"),
      "utf8",
    ),
  );
  const statement = association.find(
    (entry: { target: { package_name: string } }) =>
      entry.target.package_name === identity.androidPackage,
  );
  expect(statement.relation).toContain("delegate_permission/common.get_login_creds");
  expect(statement.target.sha256_cert_fingerprints).toEqual(
    expect.arrayContaining(identity.androidSha256Fingerprints),
  );
});

test.each(["production", "preview", "testflight"])(
  "%s enables release configuration on both platforms",
  (profile) => {
    for (const platform of ["ios", "android"]) {
      expect(
        distributionConfig({ EAS_BUILD_PROFILE: profile, EAS_BUILD_PLATFORM: platform }),
      ).toEqual({ release: true });
    }
  },
);

test("local development remains available and production rejects diagnostics", () => {
  expect(distributionConfig({}).release).toBe(false);
  expect(distributionConfig({ GIZU_BUILD_VARIANT: "production" }).release).toBe(true);
  expect(() =>
    distributionConfig({ EAS_BUILD_PROFILE: "production", EXPO_PUBLIC_DEBUG_SCREEN: "ui" }),
  ).toThrow("diagnostic");
});

test("the frontend association includes the production identity", () => {
  const association = JSON.parse(
    readFileSync(
      resolve(__dirname, "../../../frontend/public/.well-known/apple-app-site-association"),
      "utf8",
    ),
  );
  expect(association.webcredentials.apps).toContain(`588X2UZY3L.${identity.iosBundleIdentifier}`);
});

test.each([
  "http://api.gizu.io",
  "https://localhost",
  "https://127.0.0.1",
  "https://192.168.1.2",
  "https://[::1]",
  "https://api.local",
  "https://user:password@api.gizu.io",
])("production rejects a local or unsafe catalog endpoint: %s", (url) => {
  expect(() =>
    distributionConfig({ EAS_BUILD_PROFILE: "production", EXPO_PUBLIC_API_URL: url }),
  ).toThrow();
});
test("production accepts a public HTTPS URL or an unconfigured catalog", () => {
  expect(
    distributionConfig({
      EAS_BUILD_PROFILE: "production",
      EXPO_PUBLIC_API_URL: "https://api.gizu.io",
    }).release,
  ).toBe(true);
  expect(distributionConfig({ EAS_BUILD_PROFILE: "production" }).release).toBe(true);
});

test("release profiles use the AWS API and production environment", () => {
  const config = JSON.parse(readFileSync(resolve(__dirname, "../../eas.json"), "utf8"));
  expect(config.build.production.env.EXPO_PUBLIC_API_URL).toBe("https://api.gizu.io");
  expect(config.build.production.environment).toBe("production");
  expect(config.build.preview.extends).toBe("production");
  expect(config.build.testflight.extends).toBe("production");
});
