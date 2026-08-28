import { describe, expect, it } from "vitest";
import {
  assertCompleteCityPlanCacheIdentity,
  CompleteCityPlanCacheArtifactError,
  decodeCompleteCityPlan,
  encodeCompleteCityPlan
} from "./complete-city-plan-cache.js";
import type { CompleteCityPlan } from "./complete-city-plan.js";
import type { StructuralInputSignature } from "./district-plan.js";

const STRUCTURAL_INPUT: StructuralInputSignature = {
  terrain: "terrain-signature",
  roads: "roads-signature",
  districts: "districts-signature",
  generation: "generation-signature"
};

function smallPlan(): CompleteCityPlan {
  const structuralInput = { ...STRUCTURAL_INPUT };
  return {
    sourceRevision: 7,
    actionToken: "action-東京",
    buildToken: "build-token",
    epoch: 3,
    openSpaceProfile: "none",
    structuralInput,
    districtPlan: {
      revisionInputs: { ...structuralInput },
      blocks: [],
      developmentCells: [],
      openSpaceIntents: [],
      unzoned: [],
      wallCells: [],
      diagnostics: {
        faceCount: 0,
        blockCount: 0,
        fragmentCount: 0,
        developmentCellCount: 0,
        discardedFaceCount: 0,
        discardedCellCount: 0,
        warnings: []
      }
    },
    routeOccupancy: { vehicle: [], nonVehicle: [], all: [] },
    carriageway: [],
    paletteBanks: [],
    parcels: [],
    openSpaces: [],
    buildings: [],
    landmarks: [],
    diagnostics: {
      blockCount: 0,
      fragmentCount: 0,
      parcelCount: 0,
      openSpaceCount: 0,
      buildingCount: 0,
      massCount: 0,
      landmarkCount: 0,
      landmarkSkipped: [],
      warnings: []
    }
  };
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function expectArtifactError(action: () => unknown): void {
  expect(action).toThrow(CompleteCityPlanCacheArtifactError);
  expect(action).toThrow(/^Invalid complete-city plan cache artifact:/);
}

describe("complete city plan cache codec", () => {
  it("deterministically round-trips a valid plan as uncompressed UTF-8 JSON", () => {
    const plan = smallPlan();
    const encoded = encodeCompleteCityPlan(plan);

    expect(encoded).toEqual(new TextEncoder().encode(JSON.stringify(plan)));
    expect(encodeCompleteCityPlan(smallPlan())).toEqual(encoded);
    expect(decodeCompleteCityPlan(encoded)).toEqual(plan);
  });

  it.each([
    ["malformed UTF-8", new Uint8Array([0xc3, 0x28])],
    ["malformed JSON", new TextEncoder().encode("{")],
    ["a non-object plan", jsonBytes(null)],
    ["an incomplete plan", jsonBytes({ sourceRevision: 7 })],
    [
      "a dangerously malformed nested plan",
      jsonBytes({
        ...smallPlan(),
        districtPlan: { ...smallPlan().districtPlan, blocks: [null] }
      })
    ]
  ])("rejects %s with the cache-artifact error", (_description, bytes) => {
    expectArtifactError(() => decodeCompleteCityPlan(bytes));
  });

  it.each([
    ["actionToken", ""],
    ["buildToken", 42],
    ["epoch", -1]
  ] as const)("keeps the transient %s field under complete-plan validation", (field, value) => {
    const malformed = { ...smallPlan(), [field]: value };
    expectArtifactError(() => decodeCompleteCityPlan(jsonBytes(malformed)));
  });

  it("accepts an exact stable identity without comparing transient fields", () => {
    const decoded = decodeCompleteCityPlan(encodeCompleteCityPlan(smallPlan()));
    const expected = {
      sourceRevision: decoded.sourceRevision,
      structuralInput: { ...decoded.structuralInput }
    };

    expect(assertCompleteCityPlanCacheIdentity(decoded, expected)).toBe(decoded);
  });

  it("rejects a source-revision mismatch", () => {
    const decoded = decodeCompleteCityPlan(encodeCompleteCityPlan(smallPlan()));
    expectArtifactError(() => assertCompleteCityPlanCacheIdentity(decoded, {
      sourceRevision: decoded.sourceRevision + 1,
      structuralInput: { ...decoded.structuralInput }
    }));
  });

  it.each(["terrain", "roads", "districts", "generation"] as const)(
    "rejects a %s structural-signature mismatch",
    (field) => {
      const decoded = decodeCompleteCityPlan(encodeCompleteCityPlan(smallPlan()));
      const expectedStructuralInput = {
        ...decoded.structuralInput,
        [field]: `${decoded.structuralInput[field]}-other`
      };

      expectArtifactError(() => assertCompleteCityPlanCacheIdentity(decoded, {
        sourceRevision: decoded.sourceRevision,
        structuralInput: expectedStructuralInput
      }));
    }
  );
});
