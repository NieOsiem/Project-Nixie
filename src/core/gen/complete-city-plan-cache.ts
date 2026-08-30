import type { StructuralInputSignature } from "./district-plan.js";
import {
  validateCompleteCityPlan,
  type CompleteCityPlan
} from "./complete-city-plan.js";

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const ARTIFACT_ERROR_PREFIX = "Invalid complete-city plan cache artifact";

/** A corrupt, incompatible, or stale cached plan. Callers must treat this as a cache miss. */
export class CompleteCityPlanCacheArtifactError extends Error {
  constructor(detail: string) {
    super(`${ARTIFACT_ERROR_PREFIX}: ${detail}`);
    this.name = "CompleteCityPlanCacheArtifactError";
  }
}

export interface CompleteCityPlanCacheIdentity {
  sourceRevision: number;
  structuralInput: StructuralInputSignature;
}

/** Encode an uncompressed plan using JSON's deterministic property traversal order. */
export function encodeCompleteCityPlan(plan: CompleteCityPlan): Uint8Array {
  return UTF8_ENCODER.encode(JSON.stringify(plan));
}

/** Decode and fully validate an uncompressed cached plan artifact. */
export function decodeCompleteCityPlan(bytes: Uint8Array): CompleteCityPlan {
  let text: string;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    throw new CompleteCityPlanCacheArtifactError("content is not valid UTF-8");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    throw new CompleteCityPlanCacheArtifactError("content is not valid JSON");
  }

  let problems: string[];
  try {
    problems = validateCompleteCityPlan(decoded);
  } catch {
    throw new CompleteCityPlanCacheArtifactError("plan shape is invalid");
  }
  if (problems.length > 0) {
    throw new CompleteCityPlanCacheArtifactError(`plan failed validation: ${problems.join(" ")}`);
  }

  return decoded as CompleteCityPlan;
}

/**
 * Verify the stable identity used to decide whether a decoded plan belongs to a city.
 * Transient action/build tokens and the epoch are deliberately not identity fields;
 * they are still checked by decodeCompleteCityPlan through the complete-plan validator.
 */
export function assertCompleteCityPlanCacheIdentity(
  plan: CompleteCityPlan,
  expected: CompleteCityPlanCacheIdentity
): CompleteCityPlan {
  if (plan.sourceRevision !== expected.sourceRevision) {
    throw new CompleteCityPlanCacheArtifactError("source revision does not match the expected city revision");
  }

  const signatureKeys = ["terrain", "roads", "districts", "generation", "architecture", "schemaVersion", "generatorVersion"] as const;
  for (const key of signatureKeys) {
    if (plan.structuralInput[key] !== expected.structuralInput[key]) {
      throw new CompleteCityPlanCacheArtifactError(`structural-input ${key} signature does not match`);
    }
  }

  return plan;
}
