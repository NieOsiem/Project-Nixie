import { describe, expect, it } from "vitest";
import { rectRing } from "../geom/types.js";
import type { CitySourceV5 } from "./city.js";
import {
  assertCompleteCityPlanCacheIdentity,
  CompleteCityPlanCacheArtifactError,
  decodeCompleteCityPlan,
  encodeCompleteCityPlan
} from "./complete-city-plan-cache.js";
import type { CompleteCityPlan } from "./complete-city-plan.js";
import type { StructuralInputSignature } from "./district-plan.js";
import { districtStructuralInputSignature } from "./district-plan.js";
const STRUCTURAL_INPUT: StructuralInputSignature = {
  terrain: "terrain-signature",
  roads: "roads-signature",
  districts: "districts-signature",
  generation: "generation-signature",
  architecture: "architecture-signature",
  regeneration: "regeneration-signature",
  schemaVersion: 5,
  generatorVersion: 13
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
  it("rejects a pre-architecture plan artifact as a safe cache miss", () => {
    const legacy = structuredClone(smallPlan());
    const structuralInput = legacy.structuralInput as unknown as Record<string, unknown>;
    delete structuralInput.architecture;
    delete structuralInput.schemaVersion;
    delete structuralInput.generatorVersion;

    expectArtifactError(() => decodeCompleteCityPlan(jsonBytes(legacy)));
  });
  it("rejects a schema-4 plan artifact as a safe cache miss", () => {
    const schema4Artifact = structuredClone(smallPlan());
    const structuralInput = schema4Artifact.structuralInput as unknown as Record<string, unknown>;
    structuralInput.schemaVersion = 4;
    structuralInput.generatorVersion = 12;

    expectArtifactError(() => decodeCompleteCityPlan(jsonBytes(schema4Artifact)));
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

  it.each(["terrain", "roads", "districts", "generation", "architecture", "regeneration"] as const)(
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

  const SIGNATURE_SOURCE: CitySourceV5 = {
    origin: { x: 0, y: 0 },
    citySeed: "cache-signature-fixture",
    generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "grid", hubMode: "single-centre", districtPool: [], openSpaceProfile: "none" },
    terrain: { land: rectRing({ x: 0, y: 0, width: 10, height: 10 }), urbanFootprint: null },
    roads: { nodes: [], routes: [], edges: [] },
    districts: [],
    architecture: { buildings: [], places: [], overrides: [] },
    regeneration: { partialSeeds: [{ targetKind: "district", targetId: "district-a", seed: "seed-a", order: 1 }] }
  };

  it("changes the semantic signature when partial seeds change, so equal-revision stale artifacts miss", () => {
    const before = districtStructuralInputSignature(SIGNATURE_SOURCE);
    const after = districtStructuralInputSignature({
      ...SIGNATURE_SOURCE,
      regeneration: { partialSeeds: [{ targetKind: "district", targetId: "district-a", seed: "seed-b", order: 1 }] }
    });
    // A partial-seed edit changes exactly the regeneration component of the identity.
    expect(after.regeneration).not.toBe(before.regeneration);
    expect({ ...after, regeneration: before.regeneration }).toEqual(before);

    const decoded = decodeCompleteCityPlan(encodeCompleteCityPlan(smallPlan()));
    expectArtifactError(() => assertCompleteCityPlanCacheIdentity(decoded, {
      sourceRevision: decoded.sourceRevision,
      structuralInput: { ...decoded.structuralInput, regeneration: after.regeneration }
    }));
  });

  it.each([
    ["schemaVersion", (value: StructuralInputSignature): StructuralInputSignature => ({
      ...value,
      schemaVersion: (value.schemaVersion + 1) as unknown as StructuralInputSignature["schemaVersion"]
    })],
    ["generatorVersion", (value: StructuralInputSignature): StructuralInputSignature => ({
      ...value,
      generatorVersion: (value.generatorVersion + 1) as unknown as StructuralInputSignature["generatorVersion"]
    })]
  ] as const)("rejects a %s discriminator mismatch", (_field, mutate) => {
    const decoded = decodeCompleteCityPlan(encodeCompleteCityPlan(smallPlan()));
    expectArtifactError(() => assertCompleteCityPlanCacheIdentity(decoded, {
      sourceRevision: decoded.sourceRevision,
      structuralInput: mutate(decoded.structuralInput)
    }));
  });
});
