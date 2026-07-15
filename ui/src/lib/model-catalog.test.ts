import { describe, expect, it } from "vitest";
import {
  providerBrainEligible,
  providerLightEligible,
  providerSelectable,
  type CatalogProvider,
} from "./model-catalog";

describe("model-catalog role eligibility", () => {
  it("excludes cli-pipe providers from selectable chat role providers", () => {
    const cliProvider: CatalogProvider = {
      id: "claude-cli",
      name: "Claude CLI",
      apiMode: "cli-pipe",
      brainEligible: false,
      lightEligible: false,
      hasKey: true,
      models: [{ id: "_cli-default", name: "Claude CLI" }],
    };

    expect(providerSelectable(cliProvider)).toBe(false);
    expect(providerBrainEligible(cliProvider)).toBe(false);
    expect(providerLightEligible(cliProvider)).toBe(false);
  });

  it("keeps real chat providers eligible when they have runtime keys", () => {
    const chatProvider: CatalogProvider = {
      id: "openai",
      name: "OpenAI",
      apiMode: "openai-responses",
      brainEligible: true,
      lightEligible: true,
      hasKey: true,
      models: [{ id: "gpt-4.1", name: "GPT-4.1" }],
    };

    expect(providerSelectable(chatProvider)).toBe(true);
    expect(providerBrainEligible(chatProvider)).toBe(true);
    expect(providerLightEligible(chatProvider)).toBe(true);
  });
});
