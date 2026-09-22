import assert from "node:assert/strict";
import test from "node:test";

import {
  destinationArtifactPlistCommands,
  parseActivityProcessProofOptions,
  physicalDestination,
  validatePhysicalDeviceDetails,
} from "./ios-live-activity-process-proof.mjs";

const XCODE_DEVICE_ID = "00008110-00063CD91E98801E";
const CORE_DEVICE_ID = "826D57EC-4BCD-5BC0-9A31-AFB4147611F1";

test("physical ActivityKit proof requires exact physical-device identifiers", () => {
  assert.deepEqual(
    parseActivityProcessProofOptions([], {
      AIDEN_IOS_XCODE_DEVICE_ID: XCODE_DEVICE_ID,
      AIDEN_IOS_CORE_DEVICE_ID: CORE_DEVICE_ID,
    }),
    { xcodeDeviceId: XCODE_DEVICE_ID, coreDeviceId: CORE_DEVICE_ID },
  );
  assert.throws(() => parseActivityProcessProofOptions([], {}), /exact physical --xcode-device-id/u);
  assert.throws(
    () =>
      parseActivityProcessProofOptions([
        "--xcode-device-id",
        "SIMULATOR-UUID",
        "--core-device-id",
        CORE_DEVICE_ID,
      ]),
    /exact physical --xcode-device-id/u,
  );
  assert.throws(
    () =>
      parseActivityProcessProofOptions([
        "--xcode-device-id",
        XCODE_DEVICE_ID,
        "--core-device-id",
        CORE_DEVICE_ID,
        "--unknown",
        "value",
      ]),
    /unknown option/u,
  );
});

test("physical destination never selects an iOS Simulator", () => {
  assert.equal(physicalDestination(XCODE_DEVICE_ID), `platform=iOS,id=${XCODE_DEVICE_ID}`);
  assert.doesNotMatch(physicalDestination(XCODE_DEVICE_ID), /Simulator/u);
});

test("CoreDevice details must match the Xcode UDID and report physical iOS hardware", () => {
  const options = { xcodeDeviceId: XCODE_DEVICE_ID, coreDeviceId: CORE_DEVICE_ID };
  const payload = {
    info: { outcome: "success" },
    result: {
      hardwareProperties: {
        udid: XCODE_DEVICE_ID,
        platform: "iOS",
        reality: "physical",
        marketingName: "iPhone 13 Pro",
      },
    },
  };
  assert.deepEqual(validatePhysicalDeviceDetails(payload, options), {
    udid: XCODE_DEVICE_ID,
    platform: "iOS",
    reality: "physical",
    marketingName: "iPhone 13 Pro",
  });
  assert.throws(
    () =>
      validatePhysicalDeviceDetails(
        {
          ...payload,
          result: { hardwareProperties: { ...payload.result.hardwareProperties, reality: "simulated" } },
        },
        options,
      ),
    /physical iOS device/u,
  );
  assert.throws(
    () =>
      validatePhysicalDeviceDetails(
        {
          ...payload,
          result: { hardwareProperties: { ...payload.result.hardwareProperties, udid: "00008110-OTHER" } },
        },
        options,
      ),
    /do not identify the same device/u,
  );
});

test("relaunch phase reuses destination artifacts instead of reinstalling the app", () => {
  const commands = destinationArtifactPlistCommands();
  assert(commands.includes("Add :TestConfigurations:0:TestTargets:0:UseDestinationArtifacts bool true"));
  assert(commands.some((command) => command.includes("TestBundleDestinationRelativePath")));
  assert(commands.includes("Delete :TestConfigurations:0:TestTargets:0:TestBundlePath"));
  assert(commands.includes("Delete :TestConfigurations:0:TestTargets:0:TestHostPath"));
  assert(commands.includes("Delete :TestConfigurations:0:TestTargets:0:DependentProductPaths"));
});
