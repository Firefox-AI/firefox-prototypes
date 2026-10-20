/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { buildEngineForFeature } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/PromptLoader.sys.mjs"
);
const {
  MODEL_FEATURES,
  openAIEngine,
  _setRemoteClientForTesting,
  _clearRemoteClientForTesting,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const PREF_ENDPOINT = "browser.smartwindow.endpoint";
const PREF_MODEL_OVERRIDE = "browser.smartwindow.aitab.modelOverride";
const PREF_ENDPOINT_OVERRIDE = "browser.smartwindow.aitab.endpointOverride";
const PREF_APIKEY_OVERRIDE = "browser.smartwindow.aitab.apiKeyOverride";

const DEFAULT_ENDPOINT = "https://default.example/v1";
const STAGE_ENDPOINT = "https://stage.example/v1";

function paramsRecord(feature, model) {
  return {
    kind: "params",
    feature,
    model,
    version: "1.0",
    is_default: true,
    modules: [],
  };
}

const RECORDS = [
  paramsRecord("aitab", "gemini-3.1-flash-lite"),
  paramsRecord("title-generation", "gemini-3.1-flash-lite"),
];

let sb;
let buildStub;

add_setup(() => {
  Services.prefs.setStringPref(PREF_ENDPOINT, DEFAULT_ENDPOINT);
  _setRemoteClientForTesting({ get: async () => RECORDS });
  sb = sinon.createSandbox();
  buildStub = sb.stub(openAIEngine, "build").resolves({});
  registerCleanupFunction(() => {
    sb.restore();
    _clearRemoteClientForTesting();
    for (const pref of [
      PREF_ENDPOINT,
      PREF_MODEL_OVERRIDE,
      PREF_ENDPOINT_OVERRIDE,
      PREF_APIKEY_OVERRIDE,
    ]) {
      Services.prefs.clearUserPref(pref);
    }
  });
});

async function buildArgs(feature) {
  buildStub.resetHistory();
  await buildEngineForFeature(feature);
  return buildStub.firstCall.args[0];
}

add_task(async function test_no_override_uses_remote_settings_model() {
  Services.prefs.setStringPref(PREF_MODEL_OVERRIDE, "");
  const args = await buildArgs(MODEL_FEATURES.AITAB);
  Assert.equal(args.model, "gemini-3.1-flash-lite");
  Assert.equal(args.baseURL, DEFAULT_ENDPOINT);
  Assert.equal(args.apiKey, "");
});

add_task(async function test_model_override_with_endpoint_and_key() {
  Services.prefs.setStringPref(PREF_MODEL_OVERRIDE, "qwen38-flash-next");
  Services.prefs.setStringPref(PREF_ENDPOINT_OVERRIDE, STAGE_ENDPOINT);
  Services.prefs.setStringPref(PREF_APIKEY_OVERRIDE, "stage-key");
  const args = await buildArgs(MODEL_FEATURES.AITAB);
  Assert.equal(args.model, "qwen38-flash-next");
  Assert.equal(args.baseURL, STAGE_ENDPOINT);
  Assert.equal(args.apiKey, "stage-key");
});

add_task(async function test_model_override_keeps_endpoint_when_unset() {
  Services.prefs.setStringPref(PREF_MODEL_OVERRIDE, "qwen38-flash-next");
  Services.prefs.setStringPref(PREF_ENDPOINT_OVERRIDE, "");
  Services.prefs.setStringPref(PREF_APIKEY_OVERRIDE, "stage-key");
  const args = await buildArgs(MODEL_FEATURES.AITAB);
  Assert.equal(args.model, "qwen38-flash-next");
  Assert.equal(args.baseURL, DEFAULT_ENDPOINT);
  Assert.equal(args.apiKey, "", "Key override is ignored without an endpoint");
});

add_task(async function test_override_does_not_apply_to_other_features() {
  Services.prefs.setStringPref(PREF_MODEL_OVERRIDE, "qwen38-flash-next");
  Services.prefs.setStringPref(PREF_ENDPOINT_OVERRIDE, STAGE_ENDPOINT);
  const args = await buildArgs(MODEL_FEATURES.TITLE_GENERATION);
  Assert.equal(args.model, "gemini-3.1-flash-lite");
  Assert.equal(args.baseURL, DEFAULT_ENDPOINT);
});
